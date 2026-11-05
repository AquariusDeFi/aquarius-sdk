// ICE delegation builders: encodings, client-built auth trees, input
// validation, proxy errors, enforce-mode preparation with headroom, and
// restore handling, on a fake RPC — no network.
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

import { classifyContractError } from "../dist/errors.js";
import {
  AquariusClient,
  AquariusError,
  DELEGATION_FRACTION_DENOMINATOR,
  NETWORKS,
  RestoreRequiredError,
} from "../dist/index.js";

const PASSPHRASE = Networks.TESTNET;
const UPVOTE = "CAACTYVX4DRXV7HDZ4XGIVMBUQV5VVAWEFNL5YBH7QRUAVGIG4SDOB3K";
const GOVERN = "CAV4FLWRQ4I4Q2LBY4QIPL6HNJFFNLLQNBYSKA5FAILZYG4K3FDFNN7D";
const BATCH = "CCNMIX72UQIM44MB4T3LIKIMADPFBNIBVHTX27QTFLB6IACJLRWM6PA4";
const OWNER = "GD6PLWCIV2Y7C6DYRB57DOTA72G3C32LQHGYZWLWTFY7QMPPECAQRID5";
const D1 = "GANCGG3D7DEAADOOFUPKJXVZ6A6MZAIM5QROJGIAQG65BEYFLO7MOV5L";
const D2 = "GAT5YA7ICWMBWBKDZB66CLHBWATKBJSRGT4QGHX3VHMOLGDCIAGEV57J";
const CONTRACT_DELEGATE = "CA7RQDMMV6E53P5EDZA5GPWBZ33AMW2ZNO42XLI2RGRIAP4QXIARUOJQ";

// The testnet transaction 966e7325…f9261e that revoked one delegation on
// both proxies in one batch: its host function and its auth entry.
const UNDELEGATE_BOTH_HOST_FN =
  "AAAAAAAAAAGaxF/6pBDOcYHk9rQpDADeULUBqed9fhMqw+QASVxszwAAAAViYXRjaAAAAAAAAAMAAAAQAAAAAQAAAAEAAAASAAAAAAAAAAD89dhIrrHxeHiIe/G6YP6NsW9Lgc2M2XaZcfgx7yCBCAAAABAAAAABAAAAAgAAABAAAAABAAAAAwAAABIAAAABK8Ku0YcRyGlhxyCHr8dqSlatcGhxJQOlAhecG4rZRlYAAAAPAAAACnVuZGVsZWdhdGUAAAAAABAAAAABAAAAAgAAABIAAAAAAAAAAPz12EiusfF4eIh78bpg/o2xb0uBzYzZdplx+DHvIIEIAAAAEgAAAAAAAAAAJ9wD6BWYGwVDyH3hLOGwJqCmUTT5Ax77qdjlmGJADEoAAAAQAAAAAQAAAAMAAAASAAAAAQAp4rfg43r8488uZFWBpCva1BYhWr7gJ/wjQFTINyQ3AAAADwAAAAp1bmRlbGVnYXRlAAAAAAAQAAAAAQAAAAIAAAASAAAAAAAAAAD89dhIrrHxeHiIe/G6YP6NsW9Lgc2M2XaZcfgx7yCBCAAAABIAAAAAAAAAACfcA+gVmBsFQ8h94SzhsCagplE0+QMe+6nY5ZhiQAxKAAAAAAAAAAA=";
const UNDELEGATE_BOTH_AUTH =
  "AAAAAAAAAAAAAAABmsRf+qQQznGB5Pa0KQwA3lC1AannfX4TKsPkAElcbM8AAAAFYmF0Y2gAAAAAAAADAAAAEAAAAAEAAAABAAAAEgAAAAAAAAAA/PXYSK6x8Xh4iHvxumD+jbFvS4HNjNl2mXH4Me8ggQgAAAAQAAAAAQAAAAIAAAAQAAAAAQAAAAMAAAASAAAAASvCrtGHEchpYccgh6/HakpWrXBocSUDpQIXnBuK2UZWAAAADwAAAAp1bmRlbGVnYXRlAAAAAAAQAAAAAQAAAAIAAAASAAAAAAAAAAD89dhIrrHxeHiIe/G6YP6NsW9Lgc2M2XaZcfgx7yCBCAAAABIAAAAAAAAAACfcA+gVmBsFQ8h94SzhsCagplE0+QMe+6nY5ZhiQAxKAAAAEAAAAAEAAAADAAAAEgAAAAEAKeK34ON6/OPPLmRVgaQr2tQWIVq+4Cf8I0BUyDckNwAAAA8AAAAKdW5kZWxlZ2F0ZQAAAAAAEAAAAAEAAAACAAAAEgAAAAAAAAAA/PXYSK6x8Xh4iHvxumD+jbFvS4HNjNl2mXH4Me8ggQgAAAASAAAAAAAAAAAn3APoFZgbBUPIfeEs4bAmoKZRNPkDHvup2OWYYkAMSgAAAAAAAAAAAAAAAgAAAAAAAAABK8Ku0YcRyGlhxyCHr8dqSlatcGhxJQOlAhecG4rZRlYAAAAKdW5kZWxlZ2F0ZQAAAAAAAgAAABIAAAAAAAAAAPz12EiusfF4eIh78bpg/o2xb0uBzYzZdplx+DHvIIEIAAAAEgAAAAAAAAAAJ9wD6BWYGwVDyH3hLOGwJqCmUTT5Ax77qdjlmGJADEoAAAAAAAAAAAAAAAEAKeK34ON6/OPPLmRVgaQr2tQWIVq+4Cf8I0BUyDckNwAAAAp1bmRlbGVnYXRlAAAAAAACAAAAEgAAAAAAAAAA/PXYSK6x8Xh4iHvxumD+jbFvS4HNjNl2mXH4Me8ggQgAAAASAAAAAAAAAAAn3APoFZgbBUPIfeEs4bAmoKZRNPkDHvup2OWYYkAMSgAAAAA=";
// Hand-built from stellar-sdk primitives in the shapes testnet accepted in
// enforce mode: upvote delegate(owner, D1, u32 1_000_000), authorized alone…
const DELEGATE_UPVOTE_HOST_FN =
  "AAAAAAAAAAEAKeK34ON6/OPPLmRVgaQr2tQWIVq+4Cf8I0BUyDckNwAAAAhkZWxlZ2F0ZQAAAAMAAAASAAAAAAAAAAD89dhIrrHxeHiIe/G6YP6NsW9Lgc2M2XaZcfgx7yCBCAAAABIAAAAAAAAAABojG2P4yAANzi0epN658DzMgQzsIuSZAIG90JMFW77HAAAAAwAPQkA=";
const DELEGATE_UPVOTE_AUTH =
  "AAAAAAAAAAAAAAABACnit+Djevzjzy5kVYGkK9rUFiFavuAn/CNAVMg3JDcAAAAIZGVsZWdhdGUAAAADAAAAEgAAAAAAAAAA/PXYSK6x8Xh4iHvxumD+jbFvS4HNjNl2mXH4Me8ggQgAAAASAAAAAAAAAAAaIxtj+MgADc4tHqTeufA8zIEM7CLkmQCBvdCTBVu+xwAAAAMAD0JAAAAAAA==";
// …and both proxies in one batch: govern 2_000_000 then upvote 1_000_000.
const DELEGATE_BOTH_HOST_FN =
  "AAAAAAAAAAGaxF/6pBDOcYHk9rQpDADeULUBqed9fhMqw+QASVxszwAAAAViYXRjaAAAAAAAAAMAAAAQAAAAAQAAAAEAAAASAAAAAAAAAAD89dhIrrHxeHiIe/G6YP6NsW9Lgc2M2XaZcfgx7yCBCAAAABAAAAABAAAAAgAAABAAAAABAAAAAwAAABIAAAABK8Ku0YcRyGlhxyCHr8dqSlatcGhxJQOlAhecG4rZRlYAAAAPAAAACGRlbGVnYXRlAAAAEAAAAAEAAAADAAAAEgAAAAAAAAAA/PXYSK6x8Xh4iHvxumD+jbFvS4HNjNl2mXH4Me8ggQgAAAASAAAAAAAAAAAaIxtj+MgADc4tHqTeufA8zIEM7CLkmQCBvdCTBVu+xwAAAAMAHoSAAAAAEAAAAAEAAAADAAAAEgAAAAEAKeK34ON6/OPPLmRVgaQr2tQWIVq+4Cf8I0BUyDckNwAAAA8AAAAIZGVsZWdhdGUAAAAQAAAAAQAAAAMAAAASAAAAAAAAAAD89dhIrrHxeHiIe/G6YP6NsW9Lgc2M2XaZcfgx7yCBCAAAABIAAAAAAAAAABojG2P4yAANzi0epN658DzMgQzsIuSZAIG90JMFW77HAAAAAwAPQkAAAAAAAAAAAA==";
const DELEGATE_BOTH_AUTH =
  "AAAAAAAAAAAAAAABmsRf+qQQznGB5Pa0KQwA3lC1AannfX4TKsPkAElcbM8AAAAFYmF0Y2gAAAAAAAADAAAAEAAAAAEAAAABAAAAEgAAAAAAAAAA/PXYSK6x8Xh4iHvxumD+jbFvS4HNjNl2mXH4Me8ggQgAAAAQAAAAAQAAAAIAAAAQAAAAAQAAAAMAAAASAAAAASvCrtGHEchpYccgh6/HakpWrXBocSUDpQIXnBuK2UZWAAAADwAAAAhkZWxlZ2F0ZQAAABAAAAABAAAAAwAAABIAAAAAAAAAAPz12EiusfF4eIh78bpg/o2xb0uBzYzZdplx+DHvIIEIAAAAEgAAAAAAAAAAGiMbY/jIAA3OLR6k3rnwPMyBDOwi5JkAgb3QkwVbvscAAAADAB6EgAAAABAAAAABAAAAAwAAABIAAAABACnit+Djevzjzy5kVYGkK9rUFiFavuAn/CNAVMg3JDcAAAAPAAAACGRlbGVnYXRlAAAAEAAAAAEAAAADAAAAEgAAAAAAAAAA/PXYSK6x8Xh4iHvxumD+jbFvS4HNjNl2mXH4Me8ggQgAAAASAAAAAAAAAAAaIxtj+MgADc4tHqTeufA8zIEM7CLkmQCBvdCTBVu+xwAAAAMAD0JAAAAAAAAAAAAAAAACAAAAAAAAAAErwq7RhxHIaWHHIIevx2pKVq1waHElA6UCF5wbitlGVgAAAAhkZWxlZ2F0ZQAAAAMAAAASAAAAAAAAAAD89dhIrrHxeHiIe/G6YP6NsW9Lgc2M2XaZcfgx7yCBCAAAABIAAAAAAAAAABojG2P4yAANzi0epN658DzMgQzsIuSZAIG90JMFW77HAAAAAwAehIAAAAAAAAAAAAAAAAEAKeK34ON6/OPPLmRVgaQr2tQWIVq+4Cf8I0BUyDckNwAAAAhkZWxlZ2F0ZQAAAAMAAAASAAAAAAAAAAD89dhIrrHxeHiIe/G6YP6NsW9Lgc2M2XaZcfgx7yCBCAAAABIAAAAAAAAAABojG2P4yAANzi0epN658DzMgQzsIuSZAIG90JMFW77HAAAAAwAPQkAAAAAA";

const SIMULATED_INSTRUCTIONS = 1_000_000;
const SIMULATED_RESOURCE_FEE = 1_000;

const b64 = value => Buffer.from(value.toXDR()).toString("base64");
const fnName = inv => inv.function.contractFn.functionName.toString();
const contractOf = inv => Address.fromScAddress(inv.function.contractFn.contractAddress).toString();

function simulation(retval = xdr.ScVal.scvVoid()) {
  return {
    id: "1",
    latestLedger: 1,
    transactionData: new SorobanDataBuilder()
      .setResources(SIMULATED_INSTRUCTIONS, 0, 0)
      .setResourceFee(SIMULATED_RESOURCE_FEE)
      .build()
      .toXDR("base64"),
    minResourceFee: String(SIMULATED_RESOURCE_FEE),
    results: [{ auth: [], xdr: retval.toXDR("base64") }],
  };
}

/**
 * A testnet client on a fake RPC whose enforce-mode simulations answer with
 * `prepared`. The builders read nothing first; they never sign or send.
 */
function fakeClient({ prepared = simulation(), config = {} } = {}) {
  const signer = {
    publicKey: () => OWNER,
    sign: () => { throw new Error("builds must not sign"); },
  };
  const client = new AquariusClient({ network: "testnet", signer, baseFee: "100", ...config });
  const seen = { modes: [], sent: 0 };
  client.server.getAccount = async id => new Account(id, "100");
  client.server.simulateTransaction = async (tx, resources, mode) => {
    assert.equal(resources, undefined);
    seen.modes.push(mode);
    return rpc.parseRawSimulation(prepared);
  };
  client.server.sendTransaction = async () => {
    seen.sent += 1;
    throw new Error("builds must not send");
  };
  client.engine.networkCompute = async () => ({
    txMaxInstructions: 400_000_000n,
    feeRatePerInstructionsIncrement: 7n,
  });
  return { client, seen };
}

function parse(envelope) {
  const tx = TransactionBuilder.fromXDR(envelope, PASSPHRASE);
  const op = tx.toEnvelope().v1.tx.operations[0].body.invokeHostFunctionOp;
  return { tx, op, data: tx.toEnvelope().v1.tx.ext.sorobanData };
}

// --- network config -------------------------------------------------------------

test("testnet knows both proxies; mainnet has none and contracts overrides apply", async () => {
  assert.equal(NETWORKS.testnet.upvoteIceProxy, UPVOTE);
  assert.equal(NETWORKS.testnet.governIceProxy, GOVERN);
  assert.equal(NETWORKS.mainnet.upvoteIceProxy, undefined);
  assert.equal(NETWORKS.mainnet.governIceProxy, undefined);
  assert.equal(DELEGATION_FRACTION_DENOMINATOR, 10_000_000);

  const signer = { publicKey: () => OWNER, sign: () => "" };
  const mainnet = new AquariusClient({ network: "mainnet", signer });
  await assert.rejects(
    mainnet.delegation.buildDelegate({ delegate: D1, fractions: { upvote: 1 } }),
    /contracts\.upvoteIceProxy/,
  );
  await assert.rejects(
    mainnet.delegation.buildUndelegate({ delegate: D1, proxies: ["govern"] }),
    /contracts\.governIceProxy/,
  );

  const other = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
  const { client } = fakeClient({ config: { contracts: { governIceProxy: other } } });
  assert.equal(client.network.upvoteIceProxy, UPVOTE);
  const { op } = parse(await client.delegation.buildUndelegate({ delegate: D1, proxies: ["govern"] }));
  assert.equal(contractOf(op.auth[0].rootInvocation), other);
});

test("the delegation builders require a signer", async () => {
  const client = new AquariusClient({ network: "testnet" });
  await assert.rejects(client.delegation.buildDelegate({ delegate: D1, fractions: { upvote: 1 } }), /signer/);
  await assert.rejects(client.delegation.buildUndelegate({ delegate: D1, proxies: ["upvote"] }), /signer/);
});

// --- delegate ------------------------------------------------------------------------

test("buildDelegate on one proxy calls it directly, authorized alone", async () => {
  const { client, seen } = fakeClient();
  const { tx, op } = parse(await client.delegation.buildDelegate({ delegate: D1, fractions: { upvote: 1_000_000 } }));
  assert.equal(tx.source, OWNER);
  assert.equal(tx.signatures.length, 0);
  assert.equal(b64(op.hostFunction), DELEGATE_UPVOTE_HOST_FN);
  assert.deepEqual(op.auth.map(b64), [DELEGATE_UPVOTE_AUTH]);
  assert.equal(op.auth[0].credentials.type, "sorobanCredentialsSourceAccount");
  assert.equal(op.auth[0].rootInvocation.subInvocations.length, 0);
  // one enforce-mode simulation, no state read first
  assert.deepEqual(seen.modes, ["enforce"]);
  assert.equal(seen.sent, 0);
});

test("buildDelegate on both proxies is one batch: govern, then upvote, each beneath batch", async () => {
  const { client, seen } = fakeClient();
  const envelope = await client.delegation.buildDelegate({
    delegate: D1,
    fractions: { upvote: 1_000_000, govern: 2_000_000 },
  });
  const { op } = parse(envelope);
  assert.equal(b64(op.hostFunction), DELEGATE_BOTH_HOST_FN);
  assert.deepEqual(op.auth.map(b64), [DELEGATE_BOTH_AUTH]);

  const root = op.auth[0].rootInvocation;
  assert.deepEqual([contractOf(root), fnName(root)], [BATCH, "batch"]);
  assert.deepEqual(root.subInvocations.map(inv => [contractOf(inv), fnName(inv)]),
    [[GOVERN, "delegate"], [UPVOTE, "delegate"]]);
  assert.ok(root.subInvocations.every(inv => inv.subInvocations.length === 0));
  const fractions = root.subInvocations.map(inv => inv.function.contractFn.args[2]);
  assert.ok(fractions.every(f => f.type === "scvU32"));
  assert.deepEqual(fractions.map(f => f.u32), [2_000_000, 1_000_000]);
  assert.equal(scValToNative(op.hostFunction.invokeContract.args[2]), false);
  assert.deepEqual(seen.modes, ["enforce"]);
});

test("buildDelegate accepts the full share", async () => {
  const { client } = fakeClient();
  const { op } = parse(await client.delegation.buildDelegate({
    delegate: D1,
    fractions: { govern: DELEGATION_FRACTION_DENOMINATOR },
  }));
  assert.equal(op.auth[0].rootInvocation.function.contractFn.args[2].u32, 10_000_000);
});

for (const [label, params, pattern] of [
  ["a contract delegate", { delegate: CONTRACT_DELEGATE, fractions: { upvote: 1 } }, /account address/],
  ["a malformed delegate", { delegate: "GABC", fractions: { upvote: 1 } }, /account address/],
  ["self-delegation", { delegate: OWNER, fractions: { upvote: 1 } }, /yourself/],
  ["no proxy", { delegate: D1, fractions: {} }, /Select/],
  ["an unknown proxy", { delegate: D1, fractions: { ice: 1 } }, /Select/],
  ["a zero fraction", { delegate: D1, fractions: { upvote: 0 } }, /fraction/],
  ["a negative fraction", { delegate: D1, fractions: { govern: -1 } }, /fraction/],
  ["a fraction above 100%", { delegate: D1, fractions: { upvote: 10_000_001 } }, /fraction/],
  ["a fractional fraction", { delegate: D1, fractions: { upvote: 0.5 } }, /fraction/],
  ["a bigint fraction", { delegate: D1, fractions: { upvote: 1n } }, /fraction/],
  ["an undefined fraction", { delegate: D1, fractions: { upvote: undefined } }, /fraction/],
]) {
  test(`buildDelegate rejects ${label} before simulating`, async () => {
    const { client, seen } = fakeClient();
    await assert.rejects(
      client.delegation.buildDelegate(params),
      error => error instanceof AquariusError && pattern.test(error.message),
    );
    assert.equal(seen.modes.length, 0);
  });
}

// --- undelegate ----------------------------------------------------------------------

test("buildUndelegate on both proxies reproduces the testnet revocation byte for byte", async () => {
  const { client, seen } = fakeClient();
  const { op } = parse(await client.delegation.buildUndelegate({ delegate: D2, proxies: ["upvote", "govern"] }));
  assert.equal(b64(op.hostFunction), UNDELEGATE_BOTH_HOST_FN);
  assert.deepEqual(op.auth.map(b64), [UNDELEGATE_BOTH_AUTH]);
  // selection order does not matter
  const again = parse(await client.delegation.buildUndelegate({ delegate: D2, proxies: ["govern", "upvote"] }));
  assert.equal(b64(again.op.hostFunction), UNDELEGATE_BOTH_HOST_FN);
  assert.deepEqual(seen.modes, ["enforce", "enforce"]);
});

test("buildUndelegate on one proxy calls it directly, authorized alone", async () => {
  const { client } = fakeClient();
  const { op } = parse(await client.delegation.buildUndelegate({ delegate: D2, proxies: ["upvote"] }));
  const root = op.auth[0].rootInvocation;
  assert.deepEqual([contractOf(root), fnName(root)], [UPVOTE, "undelegate"]);
  assert.equal(root.subInvocations.length, 0);
  assert.deepEqual(scValToNative(xdr.ScVal.scvVec(root.function.contractFn.args)), [OWNER, D2]);
  assert.equal(b64(op.hostFunction.invokeContract.args[1]), b64(new Address(D2).toScVal()));
});

test("buildUndelegate accepts a contract delegate", async () => {
  const { client } = fakeClient();
  const { op } = parse(await client.delegation.buildUndelegate({ delegate: CONTRACT_DELEGATE, proxies: ["govern"] }));
  assert.equal(Address.fromScVal(op.hostFunction.invokeContract.args[1]).toString(), CONTRACT_DELEGATE);
});

for (const [label, params, pattern] of [
  ["a malformed delegate", { delegate: "nope", proxies: ["upvote"] }, /Stellar address/],
  ["the owner", { delegate: OWNER, proxies: ["upvote"] }, /differ from the owner/],
  ["no proxy", { delegate: D1, proxies: [] }, /Select/],
  ["a duplicate proxy", { delegate: D1, proxies: ["upvote", "upvote"] }, /Select/],
  ["an unknown proxy", { delegate: D1, proxies: ["ice"] }, /Select/],
  ["three proxies", { delegate: D1, proxies: ["upvote", "govern", "ice"] }, /Select/],
  ["a non-array", { delegate: D1, proxies: "upvote" }, /Select/],
]) {
  test(`buildUndelegate rejects ${label} before simulating`, async () => {
    const { client, seen } = fakeClient();
    await assert.rejects(
      client.delegation.buildUndelegate(params),
      error => error instanceof AquariusError && pattern.test(error.message),
    );
    assert.equal(seen.modes.length, 0);
  });
}

// --- preparation ---------------------------------------------------------------------

test("delegation builds apply the instruction and resource-fee headroom", async () => {
  const extraCompute = Math.ceil(1_250_000 * 7 / 10_000) - Math.ceil(1_000_000 * 7 / 10_000);
  const resourceFee = SIMULATED_RESOURCE_FEE + extraCompute;
  const declared = resourceFee + Math.ceil(resourceFee * 0.5);
  for (const build of [
    client => client.delegation.buildDelegate({ delegate: D1, fractions: { upvote: 1 } }),
    client => client.delegation.buildDelegate({ delegate: D1, fractions: { upvote: 1, govern: 1 } }),
    client => client.delegation.buildUndelegate({ delegate: D1, proxies: ["govern"] }),
    client => client.delegation.buildUndelegate({ delegate: D1, proxies: ["govern", "upvote"] }),
  ]) {
    const { client } = fakeClient();
    const { tx, data } = parse(await build(client));
    assert.equal(data.resources.instructions, 1_250_000);
    assert.equal(data.resourceFee, BigInt(declared));
    assert.equal(tx.fee, String(100 + declared));
  }
});

test("a restore preamble surfaces as RestoreRequiredError for delegation builds", async () => {
  const prepared = {
    ...simulation(),
    restorePreamble: {
      transactionData: new SorobanDataBuilder().build().toXDR("base64"),
      minResourceFee: "500",
    },
  };
  for (const build of [
    client => client.delegation.buildDelegate({ delegate: D1, fractions: { upvote: 1, govern: 1 } }),
    client => client.delegation.buildUndelegate({ delegate: D1, proxies: ["upvote"] }),
  ]) {
    const { client, seen } = fakeClient({ prepared });
    await assert.rejects(build(client), error => {
      assert.ok(error instanceof RestoreRequiredError, error.stack);
      const restoreTx = TransactionBuilder.fromXDR(error.restoreTransactionXdr, PASSPHRASE);
      assert.equal(restoreTx.operations[0].type, "restoreFootprint");
      assert.equal(restoreTx.signatures.length, 0);
      return true;
    });
    assert.equal(seen.modes.at(-1), "enforce");
    assert.equal(seen.sent, 0);
  }
});

// --- proxy errors --------------------------------------------------------------------

const failed = code => ({
  id: "1",
  latestLedger: 1,
  events: [],
  error: `HostError: Error(Contract, #${code})\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:${UPVOTE}, topics:[error, Error(Contract, #${code})]`,
});

for (const [code, pattern] of [
  [2, /cannot be delegated/],
  [3, /cannot delegate to itself/],
  [5, /exceed 100% in total/],
  [8, /most delegates this proxy allows/],
  [9, /fraction exceeds 100%/],
  [10, /fraction must be greater than zero/],
  [19, /ICE Locker holds no state for the owner/],
]) {
  test(`proxy error #${code} states what it means in the delegation builders`, async () => {
    for (const build of [
      client => client.delegation.buildDelegate({ delegate: D1, fractions: { upvote: 1 } }),
      client => client.delegation.buildDelegate({ delegate: D1, fractions: { upvote: 1, govern: 1 } }),
      client => client.delegation.buildUndelegate({ delegate: D1, proxies: ["upvote"] }),
      client => client.delegation.buildUndelegate({ delegate: D1, proxies: ["upvote", "govern"] }),
    ]) {
      const { client } = fakeClient({ prepared: failed(code) });
      await assert.rejects(build(client), error =>
        error instanceof AquariusError &&
        error.message.startsWith(`Contract error #${code}: `) &&
        pattern.test(error.message));
    }
  });
}

test("proxy error meanings stay out of other paths", async () => {
  for (const code of [3, 5, 8, 10, 19]) {
    assert.equal(classifyContractError(`HostError: Error(Contract, #${code})`).message, `Contract error #${code}`);
  }
  const signer = { publicKey: () => OWNER, sign: () => "" };
  const client = new AquariusClient({ network: "testnet", signer });
  client.server.getAccount = async id => new Account(id, "100");
  client.server.simulateTransaction = async () => rpc.parseRawSimulation(failed(10));
  await assert.rejects(client.locker.buildWithdraw([4]), error => error.message === "Contract error #10");
});

test("other contract errors pass through the delegation builders unchanged", async () => {
  for (const [code, message] of [
    [4, "Contract error #4"],
    [2447, "Contract error #2447: lock position not found"],
  ]) {
    const { client } = fakeClient({ prepared: failed(code) });
    await assert.rejects(
      client.delegation.buildUndelegate({ delegate: D1, proxies: ["govern"] }),
      error => error.message === message,
    );
  }
});
