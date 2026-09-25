// Resource-fee headroom tests on a fake RPC server — no network.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Account,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  StrKey,
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
const RESOURCE_FEE = 105_273; // simulated for a real swap on 2026-09-25

const transactionData = resourceFee =>
  new SorobanDataBuilder().setResourceFee(resourceFee).build().toXDR("base64");

const success = {
  id: "1",
  latestLedger: 1,
  transactionData: transactionData(RESOURCE_FEE),
  minResourceFee: String(RESOURCE_FEE),
  results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR("base64") }],
};

const restoreNeeded = restoreFee => ({
  ...success,
  restorePreamble: {
    transactionData: transactionData(restoreFee),
    minResourceFee: String(restoreFee),
  },
});

/** Scripted simulations; submissions are recorded and confirm at once. */
class FakeServer {
  constructor(simulations) {
    this.simulations = [...simulations];
    this.submitted = [];
  }

  async getAccount(accountId) {
    return new Account(accountId, "100");
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

async function prepareWith(headroom, simulations = [success]) {
  const server = new FakeServer(simulations);
  const engine = new SubmitEngine(server, PASSPHRASE, String(BASE_FEE), null, headroom);
  const tx = await engine.prepare(KEYPAIR.publicKey(), invoke, KEYPAIR);
  return { tx, server };
}

const resourceFeeOf = tx =>
  Number(tx.toEnvelope().v1().tx().ext().sorobanData().resourceFee().toBigInt());

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
  assert.ok(KEYPAIR.verify(restore.hash(), restore.signatures[0].signature())); // signed final fee

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
  assert.ok(KEYPAIR.verify(signed.hash(), signed.signatures[0].signature()));
});

test("headroom is capped so the total fee fits in uint32", async () => {
  const { tx: bare } = await prepareWith(0);
  const raised = withResourceFeeHeadroom(bare, 1e12, PASSPHRASE);
  assert.equal(Number(raised.fee), 4_294_967_295);
  assert.equal(resourceFeeOf(raised), 4_294_967_295 - BASE_FEE);
});
