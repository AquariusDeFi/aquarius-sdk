// Resource-fee and instruction headroom tests on a fake RPC server — no network.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Account,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

import { AquariusClient } from "../dist/index.js";
import { AquariusError } from "../dist/errors.js";
import { SubmitEngine, withResourceFeeHeadroom } from "../dist/submit.js";

const PASSPHRASE = Networks.TESTNET;
const KEYPAIR = Keypair.random();
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 1));
const BASE_FEE = 100;
const RESOURCE_FEE = 105_273; // a production swap's declared fee (with 15% headroom), 2026-09-25
// A production swap that failed on-chain with RESOURCE_LIMIT_EXCEEDED, 2026-09-25:
// 5_546_000 instructions declared from simulation, 5_546_342 used.
const INSTRUCTIONS = 5_546_000;
// Mainnet CONFIG_SETTING_CONTRACT_COMPUTE_V0, 2026-09-25.
const TX_MAX_INSTRUCTIONS = 400_000_000;
const FEE_RATE_PER_INSTRUCTIONS_INCREMENT = 7;

const transactionData = (resourceFee, instructions = 0) =>
  new SorobanDataBuilder()
    .setResourceFee(resourceFee)
    .setResources(instructions, 0, 0)
    .build()
    .toXDR("base64");

/** The network's non-refundable fee for declared instructions. */
const computeFee = instructions =>
  Math.ceil((instructions * FEE_RATE_PER_INSTRUCTIONS_INCREMENT) / 10_000);

const success = {
  id: "1",
  latestLedger: 1,
  transactionData: transactionData(RESOURCE_FEE),
  minResourceFee: String(RESOURCE_FEE),
  results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
};

const simulatedWith = (instructions, resourceFee = RESOURCE_FEE) => ({
  ...success,
  transactionData: transactionData(resourceFee, instructions),
});

const restoreNeeded = restoreFee => ({
  ...success,
  restorePreamble: {
    transactionData: transactionData(1), // differs: minResourceFee must win
    minResourceFee: String(restoreFee),
  },
});

/** Scripted simulations; submissions are recorded and confirm at once. */
class FakeServer {
  constructor(simulations, txMaxInstructions = TX_MAX_INSTRUCTIONS) {
    this.simulations = [...simulations];
    this.submitted = [];
    this.txMaxInstructions = txMaxInstructions;
    this.configReads = 0;
  }

  async getAccount(accountId) {
    return new Account(accountId, "100");
  }

  async getLedgerEntries() {
    this.configReads += 1;
    const compute = new xdr.ConfigSettingContractComputeV0({
      ledgerMaxInstructions: xdr.Int64.fromString("580000000"),
      txMaxInstructions: xdr.Int64.fromString(String(this.txMaxInstructions)),
      feeRatePerInstructionsIncrement: xdr.Int64.fromString(
        String(FEE_RATE_PER_INSTRUCTIONS_INCREMENT),
      ),
      txMemoryLimit: 41_943_040,
    });
    const val = xdr.LedgerEntryData.configSetting(
      xdr.ConfigSettingEntry.configSettingContractComputeV0(compute),
    );
    return { entries: [{ val }], latestLedger: 1 };
  }

  async simulateTransaction() {
    return rpc.parseRawSimulation(this.simulations.shift());
  }

  async sendTransaction(tx) {
    this.submitted.push(tx);
    return { status: "PENDING", hash: "restored" };
  }

  async pollTransaction() {
    return { status: rpc.Api.GetTransactionStatus.SUCCESS, returnValue: undefined };
  }
}

const invoke = () =>
  Operation.invokeContractFunction({ contract: CONTRACT, function: "swap", args: [] });

async function prepareWith(headroom, simulations = [success], instructionHeadroom = undefined) {
  const server = new FakeServer(simulations);
  const engine = new SubmitEngine(
    server,
    PASSPHRASE,
    String(BASE_FEE),
    null,
    headroom,
    instructionHeadroom,
  );
  const tx = await engine.prepare(KEYPAIR.publicKey(), invoke, KEYPAIR);
  return { tx, server };
}

const resourceFeeOf = tx =>
  Number(tx.toEnvelope().v1.tx.ext.sorobanData.resourceFee);

const instructionsOf = tx =>
  tx.toEnvelope().v1.tx.ext.sorobanData.resources.instructions;

test("default headroom raises the resource fee and the total fee by 50%", async () => {
  const { tx } = await prepareWith(undefined);
  const extra = Math.ceil(RESOURCE_FEE * 0.5); // 52_637
  assert.equal(resourceFeeOf(tx), RESOURCE_FEE + extra);
  assert.equal(Number(tx.fee), BASE_FEE + RESOURCE_FEE + extra); // inclusion fee unchanged
});

test("custom headroom is applied", async () => {
  const { tx } = await prepareWith(0.3);
  const extra = Math.ceil(RESOURCE_FEE * 0.3); // 31_582
  assert.equal(resourceFeeOf(tx), RESOURCE_FEE + extra);
  assert.equal(Number(tx.fee), BASE_FEE + RESOURCE_FEE + extra);
});

test("zero headroom keeps the simulated resource fee", async () => {
  const { tx } = await prepareWith(0);
  assert.equal(resourceFeeOf(tx), RESOURCE_FEE);
  assert.equal(Number(tx.fee), BASE_FEE + RESOURCE_FEE);
});

test("the client passes resourceFeeHeadroom to the engine", () => {
  const client = new AquariusClient({ network: "testnet", resourceFeeHeadroom: 0.25 });
  assert.equal(client.engine.resourceFeeHeadroom, 0.25);
  assert.equal(new AquariusClient({ network: "testnet" }).engine.resourceFeeHeadroom, 0.5);
  assert.equal(
    new AquariusClient({ network: "testnet", resourceFeeHeadroom: undefined }).engine.resourceFeeHeadroom,
    0.5,
  );
});

for (const invalid of [-0.1, Number.NaN, Number.POSITIVE_INFINITY, "0.5", null]) {
  test(`invalid headroom is rejected: ${String(invalid)}`, () => {
    const expected = error =>
      error instanceof AquariusError && /resourceFeeHeadroom/.test(error.message);
    assert.throws(() => new SubmitEngine(new FakeServer([]), PASSPHRASE, "100", null, invalid), expected);
    assert.throws(
      () => new AquariusClient({ network: "testnet", resourceFeeHeadroom: invalid }),
      expected,
    );
  });
}

test("the restore transaction gets the same headroom on its minimum resource fee", async () => {
  const restoreFee = 20_001;
  const { tx, server } = await prepareWith(undefined, [restoreNeeded(restoreFee), success]);

  assert.equal(server.submitted.length, 1);
  const restore = server.submitted[0];
  assert.equal(restore.operations[0].type, "restoreFootprint");
  const extra = Math.ceil(restoreFee * 0.5); // 10_001
  assert.equal(resourceFeeOf(restore), restoreFee + extra);
  assert.equal(Number(restore.fee), BASE_FEE + restoreFee + extra);
  assert.ok(KEYPAIR.verify(restore.hash(), restore.signatures[0].signature)); // signed final fee

  assert.equal(resourceFeeOf(tx), RESOURCE_FEE + Math.ceil(RESOURCE_FEE * 0.5));
});

test("the signed envelope carries the raised fee", async () => {
  const { tx } = await prepareWith(undefined);
  const server = new FakeServer([]);
  const engine = new SubmitEngine(server, PASSPHRASE, String(BASE_FEE));
  await engine.signAndSubmit(tx, KEYPAIR);
  const signed = server.submitted[0];
  assert.equal(signed.fee, tx.fee);
  assert.equal(resourceFeeOf(signed), resourceFeeOf(tx));
  assert.ok(KEYPAIR.verify(signed.hash(), signed.signatures[0].signature));
});

test("headroom is capped so the total fee fits in uint32", async () => {
  const { tx: bare } = await prepareWith(0);
  const raised = withResourceFeeHeadroom(bare, 1e12, PASSPHRASE);
  assert.equal(Number(raised.fee), 4_294_967_295);
  assert.equal(resourceFeeOf(raised), 4_294_967_295 - BASE_FEE);
});

test("default instruction headroom raises the instructions by 25%", async () => {
  const { tx, server } = await prepareWith(0, [simulatedWith(INSTRUCTIONS)]);
  const declared = INSTRUCTIONS + Math.ceil(INSTRUCTIONS * 0.25); // 6_932_500
  const extraFee = computeFee(declared) - computeFee(INSTRUCTIONS); // 970
  assert.equal(instructionsOf(tx), declared);
  assert.equal(resourceFeeOf(tx), RESOURCE_FEE + extraFee);
  assert.equal(Number(tx.fee), BASE_FEE + RESOURCE_FEE + extraFee);
  assert.equal(server.configReads, 1);
});

test("custom instruction headroom is applied before the fee headroom", async () => {
  const { tx } = await prepareWith(undefined, [simulatedWith(INSTRUCTIONS)], 0.1);
  const declared = INSTRUCTIONS + Math.ceil(INSTRUCTIONS * 0.1);
  const raisedFee = RESOURCE_FEE + computeFee(declared) - computeFee(INSTRUCTIONS);
  assert.equal(instructionsOf(tx), declared);
  assert.equal(resourceFeeOf(tx), raisedFee + Math.ceil(raisedFee * 0.5));
});

test("zero instruction headroom keeps the simulated instructions", async () => {
  const { tx, server } = await prepareWith(0, [simulatedWith(INSTRUCTIONS)], 0);
  assert.equal(instructionsOf(tx), INSTRUCTIONS);
  assert.equal(resourceFeeOf(tx), RESOURCE_FEE);
  assert.equal(server.configReads, 0);
});

test("the client passes instructionHeadroom to the engine", () => {
  const client = new AquariusClient({ network: "testnet", instructionHeadroom: 0.5 });
  assert.equal(client.engine.instructionHeadroom, 0.5);
  assert.equal(new AquariusClient({ network: "testnet" }).engine.instructionHeadroom, 0.25);
});

for (const invalid of [-0.1, Number.NaN, Number.POSITIVE_INFINITY, "0.25", null]) {
  test(`invalid instruction headroom is rejected: ${String(invalid)}`, () => {
    const expected = error =>
      error instanceof AquariusError && /instructionHeadroom/.test(error.message);
    assert.throws(
      () => new SubmitEngine(new FakeServer([]), PASSPHRASE, "100", null, undefined, invalid),
      expected,
    );
    assert.throws(
      () => new AquariusClient({ network: "testnet", instructionHeadroom: invalid }),
      expected,
    );
  });
}

test("instruction headroom is capped at the network limit", async () => {
  const simulated = 350_000_000;
  const { tx } = await prepareWith(0, [simulatedWith(simulated)]);
  assert.equal(instructionsOf(tx), TX_MAX_INSTRUCTIONS);
  assert.equal(
    resourceFeeOf(tx),
    RESOURCE_FEE + computeFee(TX_MAX_INSTRUCTIONS) - computeFee(simulated),
  );
});

test("the raised resource fee covers the network fee for the raised instructions", async () => {
  // The simulated fee is the non-refundable part (compute plus everything
  // else) plus the refundable part; only compute depends on instructions.
  const otherNonRefundable = 40_000;
  const refundable = 60_000;
  for (const simulated of [1, 9_999, INSTRUCTIONS, 123_456_789]) {
    const simulatedFee = otherNonRefundable + computeFee(simulated) + refundable;
    const { tx } = await prepareWith(0, [simulatedWith(simulated, simulatedFee)]);
    const networkFee = otherNonRefundable + computeFee(instructionsOf(tx)) + refundable;
    assert.ok(instructionsOf(tx) > simulated);
    assert.ok(resourceFeeOf(tx) >= networkFee);
  }
});

test("the network compute settings are read once per engine", async () => {
  const server = new FakeServer([simulatedWith(INSTRUCTIONS), simulatedWith(INSTRUCTIONS)]);
  const engine = new SubmitEngine(server, PASSPHRASE, String(BASE_FEE));
  await engine.prepare(KEYPAIR.publicKey(), invoke, KEYPAIR);
  await engine.prepare(KEYPAIR.publicKey(), invoke, KEYPAIR);
  assert.equal(server.configReads, 1);
});

test("signed envelopes and unsigned XDR carry the raised instructions", async () => {
  const { tx } = await prepareWith(undefined, [simulatedWith(INSTRUCTIONS)]);
  const declared = instructionsOf(tx);
  assert.equal(declared, INSTRUCTIONS + Math.ceil(INSTRUCTIONS * 0.25));
  assert.equal(instructionsOf(TransactionBuilder.fromXDR(tx.toXDR(), PASSPHRASE)), declared);

  let seen;
  const wallet = {
    publicKey: () => KEYPAIR.publicKey(),
    sign: txXdr => {
      seen = TransactionBuilder.fromXDR(txXdr, PASSPHRASE);
      seen.sign(KEYPAIR);
      return seen.toXDR();
    },
  };
  for (const signer of [KEYPAIR, wallet]) {
    const server = new FakeServer([]);
    const engine = new SubmitEngine(server, PASSPHRASE, String(BASE_FEE));
    await engine.signAndSubmit(TransactionBuilder.fromXDR(tx.toXDR(), PASSPHRASE), signer);
    const signed = server.submitted[0];
    assert.equal(instructionsOf(signed), declared);
    assert.equal(resourceFeeOf(signed), resourceFeeOf(tx));
    assert.ok(KEYPAIR.verify(signed.hash(), signed.signatures[0].signature));
  }
  assert.equal(instructionsOf(seen), declared);
});
