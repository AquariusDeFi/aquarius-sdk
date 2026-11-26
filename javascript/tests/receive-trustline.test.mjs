// Swaps that pay the signer a classic asset other than XLM, which the signer
// does not issue, authorize the asset's trust(signer) under the swap root,
// before the input is pulled. The contract opens a missing trustline with it.
// Mirrors python/tests/test_receive_trustline.py.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Address, Keypair, StrKey, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";

import { AquariusClient, Asset, XLM, sortTokenIds } from "../dist/index.js";

const PASSPHRASE = "Test SDF Network ; September 2015";
const ISSUER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER";
const AQUA = Asset.classic("AQUA", ISSUER);
const XLM_ID = XLM.contractId(PASSPHRASE);
const AQUA_ID = AQUA.contractId(PASSPHRASE);
const COLLECTOR_ID = StrKey.encodeContract(Buffer.alloc(32, 0x11));
const POOL_ID = StrKey.encodeContract(Buffer.alloc(32, 0x22));
const read = name => JSON.parse(readFileSync(new URL(`../../testdata/${name}`, import.meta.url), "utf8"));
const chain = read("find_path_testnet_xlm_aqua.json");
const split = read("split-plans.json");
const u128 = value => nativeToScVal(value, { type: "u128" });

/** A testnet client that captures every swap at preparation and confirms it with output 1. */
function makeClient(signer = Keypair.random()) {
  const client = new AquariusClient({ network: "testnet", signer });
  const operations = [];
  const roots = [];
  client.server.getLedgerEntries = async () => assert.fail("a swap does not look up the account's trustlines");
  client.api.findPath = async () => chain;
  client.api.findPathSplit = async () => split.plans.single.response;
  client.engine.prepare = async (_source, buildOperation) => {
    const operation = buildOperation();
    operations.push(operation);
    roots.push(operation.body.invokeHostFunctionOp.auth[0].rootInvocation);
    return { toXDR: () => "unsigned-xdr" };
  };
  client.engine.signAndSubmit = async () => ({ txHash: "hash", returnValue: u128(1n) });
  client.readRouter = async () => u128(1_000n);
  client.submitRouter = async (_fn, _args, auth) => {
    roots.push(auth[0].rootInvocation);
    return { txHash: "hash", returnValue: u128(1n) };
  };
  return { client, operations, roots };
}

const pool = client => client.newPool(POOL_ID, new Uint8Array(32), "volatile", 30, sortTokenIds([XLM_ID, AQUA_ID]), []);

// Each entry point swaps into `to` and leaves the root invocation in `roots`.
const PATHS = {
  "quote exact-in execute": async (client, from, to) => (await client.quote({ from, to, amountIn: 100_000_000n })).execute(),
  "quote exact-out build": async (client, from, to) => (await client.quote({ from, to, amountOut: 100_000_000n })).buildTransaction(),
  "swap split": (client, from, to) => client.swap({ from, to, amountIn: BigInt(split.request.amount) }),
  "pool swap": (client, from, to) => pool(client).swap({ from, to, amountIn: 500n }),
};
const FIRST_CALL = {
  "quote exact-in execute": [XLM_ID, "transfer"],
  "quote exact-out build": [XLM_ID, "transfer"],
  "swap split": [XLM_ID, "transfer"],
  "pool swap": [POOL_ID, "swap"],
};
// The split fixture only has plans from XLM to AQUA.
const NON_SPLIT = Object.keys(PATHS).filter(name => name !== "swap split");

const fnName = inv => inv.function.contractFn.functionName.toString();
const contractOf = inv => Address.fromScAddress(inv.function.contractFn.contractAddress).toString();
const calls = root => root.subInvocations.map(sub => [contractOf(sub), fnName(sub)]);

for (const name of Object.keys(PATHS)) {
  test(`${name}: a classic output authorizes trust before the input`, async () => {
    const signer = Keypair.random();
    const { client, roots } = makeClient(signer);
    await PATHS[name](client, XLM, AQUA);

    const [root] = roots;
    assert.deepEqual(calls(root), [[AQUA_ID, "trust"], FIRST_CALL[name]]);
    assert.deepEqual(root.subInvocations[0].function.contractFn.args.map(scValToNative), [signer.publicKey()]);
  });

  test(`${name}: the issuer gets no trust`, async () => {
    const issuer = { publicKey: () => ISSUER, sign: () => assert.fail("unexpected signature") };
    const { client, roots } = makeClient(issuer);
    await PATHS[name](client, XLM, AQUA);
    assert.deepEqual(calls(roots[0]), [FIRST_CALL[name]]);
  });

  test(`${name}: a token known by contract ID gets no trust`, async () => {
    const { client, roots } = makeClient();
    await PATHS[name](client, XLM, Asset.contract(AQUA_ID));
    if (name === "pool swap") await PATHS[name](client, XLM_ID, AQUA_ID);
    assert.ok(roots.length > 0);
    for (const root of roots) assert.deepEqual(calls(root), [FIRST_CALL[name]]);
  });
}

for (const name of NON_SPLIT) {
  test(`${name}: XLM output gets no trust`, async () => {
    const { client, roots } = makeClient();
    await PATHS[name](client, AQUA, XLM);
    assert.ok(!calls(roots[0]).some(([, fn]) => fn === "trust"));
  });
}

const providerQuote = (client, exactInput, recipient) => client.quote({
  from: XLM,
  to: AQUA,
  ...(exactInput ? { amountIn: 100_000_000n } : { amountOut: 100_000_000n }),
  providerFee: { contractId: COLLECTOR_ID, feeFraction: 30, feeDenominator: 10_000, recipient },
});

for (const exactInput of [true, false]) {
  const mode = `exact ${exactInput ? "input" : "output"}`;
  for (const toSignerExplicitly of [false, true]) {
    test(`a provider fee paying the signer authorizes trust (${mode}, recipient ${toSignerExplicitly ? "set" : "omitted"})`, async () => {
      const signer = Keypair.random();
      const { client, roots } = makeClient(signer);
      await (await providerQuote(client, exactInput, toSignerExplicitly ? signer.publicKey() : undefined)).execute();

      const [root] = roots;
      assert.equal(contractOf(root), COLLECTOR_ID);
      assert.deepEqual(calls(root), [[AQUA_ID, "trust"], [XLM_ID, "transfer"]]);
      assert.equal(scValToNative(root.subInvocations[1].function.contractFn.args[1]), COLLECTOR_ID);
    });
  }

  test(`a provider fee paying another recipient gets no trust (${mode})`, async () => {
    const { client, roots } = makeClient();
    await (await providerQuote(client, exactInput, Keypair.random().publicKey())).buildTransaction();
    assert.ok(fnName(roots[0]).endsWith("_to"));
    assert.deepEqual(calls(roots[0]), [[XLM_ID, "transfer"]]);
  });
}

test("addTrustline does not change the swap operation", async () => {
  for (const to of [AQUA, XLM]) {
    const { client, operations } = makeClient();
    const quote = await client.quote({ from: to === XLM ? AQUA : XLM, to, amountIn: 100_000_000n });
    for (const options of [undefined, { addTrustline: true }, { addTrustline: false }]) {
      await quote.buildTransaction(options);
      await quote.execute(options);
    }
    const encoded = operations.map(operation => operation.toXDR("base64"));
    assert.equal(encoded.length, 6);
    assert.equal(new Set(encoded).size, 1);
  }
});
