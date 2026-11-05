// ICE Locker builders: encodings, client-built auth trees, enforce-mode
// preparation with headroom, and restore handling, on a fake RPC — no network.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Account,
  Address,
  Networks,
  SorobanDataBuilder,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import {
  AquariusClient,
  AquariusError,
  NETWORKS,
  RestoreRequiredError,
  authorizedInvocation,
  sourceAccountEntry,
} from "../dist/index.js";
import { classifyContractError } from "../dist/errors.js";

const PASSPHRASE = Networks.TESTNET;
const LOCKER = "CAU5JTZ5D3TUK53WOTT5UO75U6IYAFXSGCEWJJYVIAEJJ4N5AVM72DZV";
const AQUA_SAC = "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE";
const BATCH = "CCNMIX72UQIM44MB4T3LIKIMADPFBNIBVHTX27QTFLB6IACJLRWM6PA4";
const OWNER = "GD6PLWCIV2Y7C6DYRB57DOTA72G3C32LQHGYZWLWTFY7QMPPECAQRID5";
const AMOUNT = 100_000_000n;
const UNLOCK = 1_799_020_800n; // Monday 2027-01-04 00:00 UTC

// Hand-built from stellar-sdk primitives in the shapes testnet accepted in
// enforce mode: create_lock(owner, u64, u64) -> AQUA transfer(owner, locker, i128).
const CREATE_LOCK_HOST_FN =
  "AAAAAAAAAAEp1M89HudFd3Z059o7/aeRgBbyMIlkpxVACJTxvQVZ/QAAAAtjcmVhdGVfbG9jawAAAAADAAAAEgAAAAAAAAAA/PXYSK6x8Xh4iHvxumD+jbFvS4HNjNl2mXH4Me8ggQgAAAAFAAAAAAX14QAAAAAFAAAAAGs64QA=";
const CREATE_LOCK_AUTH =
  "AAAAAAAAAAAAAAABKdTPPR7nRXd2dOfaO/2nkYAW8jCJZKcVQAiU8b0FWf0AAAALY3JlYXRlX2xvY2sAAAAAAwAAABIAAAAAAAAAAPz12EiusfF4eIh78bpg/o2xb0uBzYzZdplx+DHvIIEIAAAABQAAAAAF9eEAAAAABQAAAABrOuEAAAAAAQAAAAAAAAAB21hbnBbOBeG1hyTg3x0lsTNXF7+S8knLgMAUo6UXVzgAAAAIdHJhbnNmZXIAAAADAAAAEgAAAAAAAAAA/PXYSK6x8Xh4iHvxumD+jbFvS4HNjNl2mXH4Me8ggQgAAAASAAAAASnUzz0e50V3dnTn2jv9p5GAFvIwiWSnFUAIlPG9BVn9AAAACgAAAAAAAAAAAAAAAAX14QAAAAAA";
// withdraw(owner, u32 4), authorized alone.
const WITHDRAW_HOST_FN =
  "AAAAAAAAAAEp1M89HudFd3Z059o7/aeRgBbyMIlkpxVACJTxvQVZ/QAAAAh3aXRoZHJhdwAAAAIAAAASAAAAAAAAAAD89dhIrrHxeHiIe/G6YP6NsW9Lgc2M2XaZcfgx7yCBCAAAAAMAAAAE";
const WITHDRAW_AUTH =
  "AAAAAAAAAAAAAAABKdTPPR7nRXd2dOfaO/2nkYAW8jCJZKcVQAiU8b0FWf0AAAAId2l0aGRyYXcAAAACAAAAEgAAAAAAAAAA/PXYSK6x8Xh4iHvxumD+jbFvS4HNjNl2mXH4Me8ggQgAAAADAAAABAAAAAA=";
// batch([owner], [(locker, withdraw, [owner, 4]), (locker, withdraw, [owner, 3])], false)
// -> batch authorizing withdraw(4) and withdraw(3) beneath it.
const WITHDRAW_BATCH_HOST_FN =
  "AAAAAAAAAAGaxF/6pBDOcYHk9rQpDADeULUBqed9fhMqw+QASVxszwAAAAViYXRjaAAAAAAAAAMAAAAQAAAAAQAAAAEAAAASAAAAAAAAAAD89dhIrrHxeHiIe/G6YP6NsW9Lgc2M2XaZcfgx7yCBCAAAABAAAAABAAAAAgAAABAAAAABAAAAAwAAABIAAAABKdTPPR7nRXd2dOfaO/2nkYAW8jCJZKcVQAiU8b0FWf0AAAAPAAAACHdpdGhkcmF3AAAAEAAAAAEAAAACAAAAEgAAAAAAAAAA/PXYSK6x8Xh4iHvxumD+jbFvS4HNjNl2mXH4Me8ggQgAAAADAAAABAAAABAAAAABAAAAAwAAABIAAAABKdTPPR7nRXd2dOfaO/2nkYAW8jCJZKcVQAiU8b0FWf0AAAAPAAAACHdpdGhkcmF3AAAAEAAAAAEAAAACAAAAEgAAAAAAAAAA/PXYSK6x8Xh4iHvxumD+jbFvS4HNjNl2mXH4Me8ggQgAAAADAAAAAwAAAAAAAAAA";
const WITHDRAW_BATCH_AUTH =
  "AAAAAAAAAAAAAAABmsRf+qQQznGB5Pa0KQwA3lC1AannfX4TKsPkAElcbM8AAAAFYmF0Y2gAAAAAAAADAAAAEAAAAAEAAAABAAAAEgAAAAAAAAAA/PXYSK6x8Xh4iHvxumD+jbFvS4HNjNl2mXH4Me8ggQgAAAAQAAAAAQAAAAIAAAAQAAAAAQAAAAMAAAASAAAAASnUzz0e50V3dnTn2jv9p5GAFvIwiWSnFUAIlPG9BVn9AAAADwAAAAh3aXRoZHJhdwAAABAAAAABAAAAAgAAABIAAAAAAAAAAPz12EiusfF4eIh78bpg/o2xb0uBzYzZdplx+DHvIIEIAAAAAwAAAAQAAAAQAAAAAQAAAAMAAAASAAAAASnUzz0e50V3dnTn2jv9p5GAFvIwiWSnFUAIlPG9BVn9AAAADwAAAAh3aXRoZHJhdwAAABAAAAABAAAAAgAAABIAAAAAAAAAAPz12EiusfF4eIh78bpg/o2xb0uBzYzZdplx+DHvIIEIAAAAAwAAAAMAAAAAAAAAAAAAAAIAAAAAAAAAASnUzz0e50V3dnTn2jv9p5GAFvIwiWSnFUAIlPG9BVn9AAAACHdpdGhkcmF3AAAAAgAAABIAAAAAAAAAAPz12EiusfF4eIh78bpg/o2xb0uBzYzZdplx+DHvIIEIAAAAAwAAAAQAAAAAAAAAAAAAAAEp1M89HudFd3Z059o7/aeRgBbyMIlkpxVACJTxvQVZ/QAAAAh3aXRoZHJhdwAAAAIAAAASAAAAAAAAAAD89dhIrrHxeHiIe/G6YP6NsW9Lgc2M2XaZcfgx7yCBCAAAAAMAAAADAAAAAA==";

const TX_MAX_INSTRUCTIONS = 400_000_000n;
const FEE_RATE_PER_INSTRUCTIONS_INCREMENT = 7n;
const SIMULATED_INSTRUCTIONS = 1_000_000;
const SIMULATED_RESOURCE_FEE = 1_000;

const b64 = value => Buffer.from(value.toXDR()).toString("base64");
const fnName = inv => inv.function.contractFn.functionName.toString();
const contractOf = inv => Address.fromScAddress(inv.function.contractFn.contractAddress).toString();

function success({ transactionData, retval = xdr.ScVal.scvVoid(), auth = [] } = {}) {
  return {
    id: "1",
    latestLedger: 1,
    transactionData: transactionData ?? new SorobanDataBuilder()
      .setResources(SIMULATED_INSTRUCTIONS, 0, 0)
      .setResourceFee(SIMULATED_RESOURCE_FEE)
      .build()
      .toXDR("base64"),
    minResourceFee: String(SIMULATED_RESOURCE_FEE),
    results: [{ auth: auth.map(entry => entry.toXDR("base64")), xdr: retval.toXDR("base64") }],
  };
}

/** A testnet client whose RPC returns `simulations` in order; it never signs or sends. */
function fakeClient(simulations = [success()], config = {}) {
  const signer = {
    publicKey: () => OWNER,
    sign: () => { throw new Error("builds must not sign"); },
  };
  const client = new AquariusClient({ network: "testnet", signer, baseFee: "100", ...config });
  const seen = { modes: [], txs: [], sent: 0 };
  const queue = [...simulations];
  client.server.getAccount = async id => new Account(id, "100");
  client.server.simulateTransaction = async (tx, resources, mode) => {
    assert.equal(resources, undefined);
    seen.modes.push(mode);
    seen.txs.push(tx);
    return rpc.parseRawSimulation(queue.shift());
  };
  client.server.sendTransaction = async () => {
    seen.sent += 1;
    throw new Error("builds must not send");
  };
  client.engine.networkCompute = async () => ({
    txMaxInstructions: TX_MAX_INSTRUCTIONS,
    feeRatePerInstructionsIncrement: FEE_RATE_PER_INSTRUCTIONS_INCREMENT,
  });
  return { client, seen };
}

function parse(envelope) {
  const tx = TransactionBuilder.fromXDR(envelope, PASSPHRASE);
  const op = tx.toEnvelope().v1.tx.operations[0].body.invokeHostFunctionOp;
  return { tx, op, data: tx.toEnvelope().v1.tx.ext.sorobanData };
}

// --- network config -------------------------------------------------------------

test("testnet knows the Locker; mainnet has none and contracts.locker overrides", async () => {
  assert.equal(NETWORKS.testnet.locker, LOCKER);
  assert.equal(NETWORKS.testnet.batch, BATCH);
  assert.equal(NETWORKS.mainnet.locker, undefined);

  const signer = { publicKey: () => OWNER, sign: () => "" };
  const mainnet = new AquariusClient({ network: "mainnet", signer });
  await assert.rejects(
    mainnet.locker.buildCreateLock({ amount: AMOUNT, unlockTime: UNLOCK }),
    error => error instanceof AquariusError && /contracts\.locker/.test(error.message),
  );
  await assert.rejects(mainnet.locker.buildWithdraw([1]), /contracts\.locker/);

  const other = "CA7RQDMMV6E53P5EDZA5GPWBZ33AMW2ZNO42XLI2RGRIAP4QXIARUOJQ";
  const { client, seen } = fakeClient([success()], { contracts: { locker: other } });
  assert.equal(client.network.locker, other);
  const { op } = parse(await client.locker.buildWithdraw([4]));
  assert.equal(Address.fromScAddress(op.hostFunction.invokeContract.contractAddress).toString(), other);
  assert.equal(seen.modes.length, 1);
});

test("the Locker builders require a signer", async () => {
  const client = new AquariusClient({ network: "testnet" });
  await assert.rejects(client.locker.buildCreateLock({ amount: AMOUNT, unlockTime: UNLOCK }), /signer/);
  await assert.rejects(client.locker.buildWithdraw([4]), /signer/);
});

// --- create_lock --------------------------------------------------------------------

test("buildCreateLock encodes create_lock(owner, u64, u64) under the AQUA transfer it authorizes", async () => {
  const { client, seen } = fakeClient();
  const { tx, op } = parse(await client.locker.buildCreateLock({ amount: AMOUNT, unlockTime: UNLOCK }));

  assert.equal(tx.source, OWNER);
  assert.equal(tx.signatures.length, 0);
  assert.equal(b64(op.hostFunction), CREATE_LOCK_HOST_FN);
  assert.equal(op.auth.length, 1);
  assert.equal(b64(op.auth[0]), CREATE_LOCK_AUTH);

  const root = op.auth[0].rootInvocation;
  assert.equal(op.auth[0].credentials.type, "sorobanCredentialsSourceAccount");
  assert.deepEqual([contractOf(root), fnName(root)], [LOCKER, "create_lock"]);
  const [transfer] = root.subInvocations;
  assert.equal(root.subInvocations.length, 1);
  assert.deepEqual([contractOf(transfer), fnName(transfer)], [AQUA_SAC, "transfer"]);
  const [from, to, amount] = transfer.function.contractFn.args;
  assert.deepEqual([Address.fromScVal(from).toString(), Address.fromScVal(to).toString()], [OWNER, LOCKER]);
  assert.equal(amount.type, "scvI128");
  assert.equal(scValToNative(amount), AMOUNT);

  assert.deepEqual(seen.modes, ["enforce"]);
  assert.equal(seen.sent, 0);
});

test("buildCreateLock takes the unlock time as a number of seconds too", async () => {
  const { client } = fakeClient();
  const { op } = parse(await client.locker.buildCreateLock({ amount: AMOUNT, unlockTime: Number(UNLOCK) }));
  assert.equal(b64(op.hostFunction), CREATE_LOCK_HOST_FN);
});

test("buildCreateLock locks the network's AQUA asset contract", async () => {
  const { client } = fakeClient();
  const { op } = parse(await client.locker.buildCreateLock({ amount: AMOUNT, unlockTime: UNLOCK }));
  assert.equal(contractOf(op.auth[0].rootInvocation.subInvocations[0]), AQUA_SAC);
});

for (const [label, params, pattern] of [
  ["zero amount", { amount: 0n, unlockTime: UNLOCK }, /amount/],
  ["negative amount", { amount: -1n, unlockTime: UNLOCK }, /amount/],
  ["amount above u64", { amount: 1n << 64n, unlockTime: UNLOCK }, /amount/],
  ["amount as a number", { amount: 10, unlockTime: UNLOCK }, /amount/],
  ["fractional unlock time", { amount: AMOUNT, unlockTime: 1.5 }, /unlockTime/],
  ["negative unlock time", { amount: AMOUNT, unlockTime: -1n }, /unlockTime/],
  ["unlock time above u64", { amount: AMOUNT, unlockTime: 1n << 64n }, /unlockTime/],
  ["unlock time as a string", { amount: AMOUNT, unlockTime: "1799020800" }, /unlockTime/],
]) {
  test(`buildCreateLock rejects ${label} before simulating`, async () => {
    const { client, seen } = fakeClient();
    await assert.rejects(
      client.locker.buildCreateLock(params),
      error => error instanceof AquariusError && pattern.test(error.message),
    );
    assert.equal(seen.modes.length, 0);
  });
}

// --- withdraw ------------------------------------------------------------------------

test("buildWithdraw with one position calls the Locker directly, authorized alone", async () => {
  const { client, seen } = fakeClient();
  const { op } = parse(await client.locker.buildWithdraw([4]));
  assert.equal(b64(op.hostFunction), WITHDRAW_HOST_FN);
  assert.equal(b64(op.auth[0]), WITHDRAW_AUTH);
  assert.equal(op.auth[0].rootInvocation.subInvocations.length, 0);
  assert.deepEqual(seen.modes, ["enforce"]);
});

test("buildWithdraw with several positions batches them, each withdraw beneath batch", async () => {
  const { client, seen } = fakeClient();
  const { op } = parse(await client.locker.buildWithdraw([4, 3]));
  assert.equal(b64(op.hostFunction), WITHDRAW_BATCH_HOST_FN);
  assert.equal(b64(op.auth[0]), WITHDRAW_BATCH_AUTH);

  const root = op.auth[0].rootInvocation;
  assert.deepEqual([contractOf(root), fnName(root)], [BATCH, "batch"]);
  assert.deepEqual(root.subInvocations.map(fnName), ["withdraw", "withdraw"]);
  assert.ok(root.subInvocations.every(inv => contractOf(inv) === LOCKER && inv.subInvocations.length === 0));
  const [, , returnResults] = op.hostFunction.invokeContract.args;
  assert.equal(scValToNative(returnResults), false);
  assert.deepEqual(seen.modes, ["enforce"]);
});

test("buildWithdraw has no cap on the number of positions", async () => {
  for (const count of [9, 40]) {
    const ids = Array.from({ length: count }, (_, i) => i * 3 + 1);
    const { client } = fakeClient();
    const { op } = parse(await client.locker.buildWithdraw(ids));
    const calls = scValToNative(op.hostFunction.invokeContract.args[1]);
    assert.equal(calls.length, count);
    assert.deepEqual(calls.map(([contract, fn, [owner, id]]) => [contract, fn, owner, id]),
      ids.map(id => [LOCKER, "withdraw", OWNER, id]));
    const subs = op.auth[0].rootInvocation.subInvocations;
    assert.deepEqual(subs.map(inv => inv.function.contractFn.args[1].u32), ids);
  }
});

test("buildWithdraw keeps the caller's order and encodes ids as u32", async () => {
  const { client } = fakeClient();
  const { op } = parse(await client.locker.buildWithdraw([7, 0, 4_294_967_295]));
  const ids = op.auth[0].rootInvocation.subInvocations.map(inv => inv.function.contractFn.args[1]);
  assert.ok(ids.every(id => id.type === "scvU32"));
  assert.deepEqual(ids.map(id => id.u32), [7, 0, 4_294_967_295]);
});

for (const [label, ids, pattern] of [
  ["no positions", [], /at least one/],
  ["a duplicate position", [4, 3, 4], /only once/],
  ["a negative id", [-1], /position id/],
  ["an id above u32", [4_294_967_296], /position id/],
  ["a fractional id", [1.5], /position id/],
  ["a bigint id", [1n], /position id/],
  ["a non-array", "4", /at least one/],
]) {
  test(`buildWithdraw rejects ${label} before simulating`, async () => {
    const { client, seen } = fakeClient();
    await assert.rejects(
      client.locker.buildWithdraw(ids),
      error => error instanceof AquariusError && pattern.test(error.message),
    );
    assert.equal(seen.modes.length, 0);
  });
}

// --- preparation ---------------------------------------------------------------------

test("simulation auth never replaces the client-built tree", async () => {
  const injected = sourceAccountEntry(authorizedInvocation(LOCKER, "create_lock", []));
  const { client } = fakeClient([success({ auth: [injected] })]);
  const { op } = parse(await client.locker.buildCreateLock({ amount: AMOUNT, unlockTime: UNLOCK }));
  assert.deepEqual(op.auth.map(b64), [CREATE_LOCK_AUTH]);
});

test("Locker builds apply the instruction and resource-fee headroom", async () => {
  // +25% instructions; their compute fee joins the resource fee, then +50%.
  const extraCompute = Math.ceil(1_250_000 * 7 / 10_000) - Math.ceil(1_000_000 * 7 / 10_000);
  const resourceFee = SIMULATED_RESOURCE_FEE + extraCompute;
  const declared = resourceFee + Math.ceil(resourceFee * 0.5);
  for (const build of [
    client => client.locker.buildCreateLock({ amount: AMOUNT, unlockTime: UNLOCK }),
    client => client.locker.buildWithdraw([4]),
    client => client.locker.buildWithdraw([4, 3]),
  ]) {
    const { client } = fakeClient();
    const { tx, data } = parse(await build(client));
    assert.equal(data.resources.instructions, 1_250_000);
    assert.equal(data.resourceFee, BigInt(declared));
    assert.equal(tx.fee, String(100 + declared));
  }

  const { client } = fakeClient([success()], { instructionHeadroom: 0, resourceFeeHeadroom: 0 });
  const { tx, data } = parse(await client.locker.buildWithdraw([4]));
  assert.equal(data.resources.instructions, SIMULATED_INSTRUCTIONS);
  assert.equal(tx.fee, String(100 + SIMULATED_RESOURCE_FEE));
});

test("a restore preamble surfaces as RestoreRequiredError with an unsigned restore", async () => {
  const restore = {
    ...success(),
    restorePreamble: {
      transactionData: new SorobanDataBuilder().build().toXDR("base64"),
      minResourceFee: "500",
    },
  };
  for (const build of [
    client => client.locker.buildCreateLock({ amount: AMOUNT, unlockTime: UNLOCK }),
    client => client.locker.buildWithdraw([4]),
    client => client.locker.buildWithdraw([4, 3]),
  ]) {
    const { client, seen } = fakeClient([restore]);
    await assert.rejects(build(client), error => {
      assert.ok(error instanceof RestoreRequiredError, error.stack);
      const restoreTx = TransactionBuilder.fromXDR(error.restoreTransactionXdr, PASSPHRASE);
      assert.equal(restoreTx.source, OWNER);
      assert.equal(restoreTx.operations[0].type, "restoreFootprint");
      assert.equal(restoreTx.signatures.length, 0);
      return true;
    });
    assert.deepEqual(seen.modes, ["enforce"]);
    assert.equal(seen.sent, 0);
  }
});

test("archived entries restored inside the transaction need no separate restore", async () => {
  const archived = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
    contract: new Address(LOCKER).toScAddress(),
    key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("OwnerState"), new Address(OWNER).toScVal()]),
    durability: xdr.ContractDataDurability.persistent,
  }));
  const transactionData = xdr.SorobanTransactionData.fromXdrObject({
    ext: { v: 1, resourceExt: { archivedSorobanEntries: [0] } },
    resources: {
      footprint: { readOnly: [], readWrite: [archived.toXdrObject()] },
      instructions: SIMULATED_INSTRUCTIONS,
      diskReadBytes: 0,
      writeBytes: 0,
    },
    resourceFee: BigInt(SIMULATED_RESOURCE_FEE),
  }).toXDR("base64");
  const { client, seen } = fakeClient([success({ transactionData })]);
  const { data } = parse(await client.locker.buildWithdraw([4]));
  assert.equal(data.ext.type, "resourceExt");
  assert.deepEqual(data.ext.resourceExt.archivedSorobanEntries, [0]);
  assert.equal(b64(data.resources.footprint.readWrite[0]), b64(archived));
  assert.deepEqual(seen.modes, ["enforce"]);
  assert.equal(seen.sent, 0);
});

test("Locker contract errors carry what they mean", () => {
  for (const [code, pattern] of [
    [2400, /greater than zero/],
    [2445, /Monday 00:00 UTC/],
    [2446, /24 hours/],
    [2447, /not found/],
    [2448, /already withdrawn/],
    [2450, /not unlocked yet/],
  ]) {
    const error = classifyContractError(`HostError: Error(Contract, #${code})`);
    assert.ok(error instanceof AquariusError);
    assert.match(error.message, new RegExp(`#${code}`));
    assert.match(error.message, pattern);
  }
});
