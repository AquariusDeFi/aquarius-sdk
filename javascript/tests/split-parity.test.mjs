import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  Address,
  Keypair,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import * as sdk from "../dist/index.js";
const read = (name) =>
  JSON.parse(readFileSync(new URL("../../testdata/" + name, import.meta.url)));
const cases = read("split-behavior.json"),
  api = read("split-api-response.json"),
  resource = read("split-resources.json");
const plan = () => {
  const r = api.request;
  return sdk.normalizeSellSwapPlan(
    api.response,
    r.token_in_address,
    r.token_out_address,
    r.amount,
  );
};
for (const c of cases.amounts)
  test("shared decimal: " + JSON.stringify(c), () => {
    const run = () => sdk.sellAmountToRaw(c.amount, c.decimals);
    if (c.error) assert.throws(run);
    else assert.equal(run(), c.expected);
  });
for (const c of cases.minimums)
  test("shared minimum: " + JSON.stringify(c), () => {
    const run = () => sdk.getSwapMinimum(c.output, c.slippage);
    if (c.error) assert.throws(run);
    else assert.equal(run(), c.expected);
  });
for (const c of cases.quotes)
  test("shared quote: " + c.name, () => {
    const q = structuredClone({ ...api.response, ...c.quote });
    for (const key of c.omit ?? []) delete q[key];
    if (c.plan) Object.assign(q.split_plan, c.plan);
    if (c.legs)
      q.split_plan.legs = c.legs.map(({ from, ...leg }) => ({
        ...api.response.split_plan.legs[from],
        ...leg,
      }));
    const r = api.request;
    const run = () =>
      sdk.normalizeSellSwapPlan(
        q,
        r.token_in_address,
        r.token_out_address,
        r.amount,
      );
    if (c.error) assert.throws(run, /Invalid swap quote/);
    else {
      const result = run();
      assert.equal(result.legs.length, c.expectedParts);
      assert.equal(result.amountOut, c.expectedOutput);
    }
  });
test("both public SDKs expose every split capability in shared contract", () => {
  for (const [name] of cases.capabilities)
    assert.equal(typeof sdk[name], "function", name);
});
const reader = (protocol = 29) => ({
  getNetwork: async () => ({
    passphrase: resource.networkPassphrase,
    protocolVersion: String(protocol),
  }),
  getLedgerEntries: async () => {
    const data = resource.configs[protocol >= 23 ? 29 : 22];
    return {
      ...data,
      entries: data.entries.map((e) => ({
        key: xdr.LedgerKey.fromXdr(e.key, "base64"),
        val: xdr.LedgerEntryData.fromXdr(e.xdr, "base64"),
      })),
    };
  },
});
const tx = () =>
  TransactionBuilder.fromXDR(
    resource.transactionXdr,
    resource.networkPassphrase,
  );
const invocation = () => ({
  events: resource.events.map((e) => xdr.DiagnosticEvent.fromXdr(e, "base64")),
  retval: xdr.ScVal.fromXdr(resource.retval, "base64"),
});
const generous = async () => ({
  ...(await sdk.loadSwapResourceLimits(reader(), resource.networkPassphrase)),
  ...Object.fromEntries(
    Object.keys(resource.meters).map((k) => [
      k,
      k === "instructions" ? 1000000n : 1000000,
    ]),
  ),
});
for (const c of resource.cases)
  test("shared resource: " + c.name, async () => {
    const limits = {
      ...(await generous()),
      [c.field]: c.field === "instructions" ? BigInt(c.limit) : c.limit,
    };
    const run = () => sdk.assertSwapResources(tx(), limits, invocation());
    if (c.ok) assert.doesNotThrow(run);
    else assert.throws(run);
  });
test("shared exact builder operation wire and fixed authorization", () => {
  const r = api.request,
    contract = (n) => Address.contract(Buffer.alloc(32, n)).toString();
  const operation = sdk.buildSellSwapOperation({
    source: resource.source,
    tokenIn: r.token_in_address,
    tokenOut: r.token_out_address,
    router: contract(8),
    splitRouter: contract(9),
    plan: plan(),
    minimum: "123",
  });
  assert.equal(operation.toXdr("base64"), resource.operationXdr);
  assert.doesNotThrow(() =>
    sdk.assertSwapAuthorization(tx(), resource.source, resource.operationXdr),
  );
  assert.throws(() =>
    sdk.assertSwapAuthorization(
      tx(),
      Keypair.random().publicKey(),
      resource.operationXdr,
    ),
  );
  const wire = tx().toEnvelope().toXdrObject();
  wire.v1.tx.operations[0].body.invokeHostFunctionOp.auth = [];
  assert.throws(() =>
    sdk.assertSwapAuthorization(
      new Transaction(
        xdr.TransactionEnvelope.fromXdrObject(wire),
        resource.networkPassphrase,
      ),
      resource.source,
      resource.operationXdr,
    ),
  );
});
for (const c of resource.configurationCases)
  test(`shared config protocol ${c.protocol}`, async () => {
    if (c.error) {
      await assert.rejects(
        sdk.loadSwapResourceLimits(
          reader(c.protocol),
          resource.networkPassphrase,
        ),
      );
      return;
    }
    const limits = await sdk.loadSwapResourceLimits(
      reader(c.protocol),
      resource.networkPassphrase,
    );
    assert.equal(limits.protocolVersion, c.protocol);
    assert.equal(limits.footprintEntries ?? null, c.footprint);
  });
for (const c of resource.footprintCases)
  test("shared footprint: " + c.name, async () => {
    const limits = {
      ...(await generous()),
      protocolVersion: c.protocol,
      diskReadEntries: c.limit,
    };
    const run = () =>
      sdk.assertSwapResources(
        TransactionBuilder.fromXDR(
          c.transactionXdr,
          resource.networkPassphrase,
        ),
        limits,
        invocation(),
      );
    if (c.ok) assert.doesNotThrow(run);
    else assert.throws(run);
  });
for (const c of resource.results)
  test("shared return: " + c.name, () => {
    const value = xdr.ScVal.fromXdr(c.xdr, "base64"),
      run = () =>
        sdk.getSellSwapResult(value, c.legCount, c.withTrustline).map(String);
    if (c.error) assert.throws(run);
    else assert.deepEqual(run(), c.expected);
    if (c.ordinary)
      assert.equal(
        sdk.getSwapResult(value, true).toXdr("base64"),
        value.vec[1].toXdr("base64"),
      );
  });
test("fixed auth rejects a changed aggregate minimum", () => {
  const wire = tx().toEnvelope().toXdrObject();
  wire.v1.tx.operations[0].body.invokeHostFunctionOp.auth[0].rootInvocation.function.contractFn.args[5].u128.lo =
    124n;
  const changed = new Transaction(
    xdr.TransactionEnvelope.fromXdrObject(wire),
    resource.networkPassphrase,
  );
  assert.throws(() =>
    sdk.assertSwapAuthorization(
      changed,
      resource.source,
      resource.operationXdr,
    ),
  );
});
for (const kind of resource.configurationErrors)
  test("shared malformed config: " + kind, async () => {
    const server = reader(),
      original = server.getLedgerEntries;
    server.getLedgerEntries = async () => {
      const response = await original();
      if (kind === "missing") response.entries = [];
      if (kind === "duplicate") response.entries.push(response.entries[0]);
      if (kind === "wrong_entry")
        response.entries[0].val = response.entries[1].val;
      if (kind === "invalid_ledger") response.latestLedger = 0;
      return response;
    };
    await assert.rejects(
      sdk.loadSwapResourceLimits(
        server,
        kind === "wrong_network" ? "other network" : resource.networkPassphrase,
      ),
    );
  });
