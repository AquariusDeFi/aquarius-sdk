import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  Address,
  Keypair,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import * as sdk from "../dist/index.js";
const read = (name) =>
  JSON.parse(readFileSync(new URL("../../testdata/" + name, import.meta.url)));
const cases = read("split-behavior.json"),
  fixture = read("split-plans.json"),
  resource = read("split-resources.json");
const { request } = fixture;

// Fixture changes: set or delete the value at a path of keys and indices;
// an empty path replaces the whole value.
const patched = (value, changes = []) => {
  let copy = structuredClone(value);
  for (const change of changes) {
    if (!change.path.length) {
      copy = structuredClone(change.value);
      continue;
    }
    const key = change.path[change.path.length - 1];
    const parent = change.path
      .slice(0, -1)
      .reduce((node, step) => node[step], copy);
    if (change.delete) delete parent[key];
    else parent[key] = change.value;
  }
  return copy;
};
const base = (name) =>
  name === "noRoute" ? fixture.noRoute : fixture.plans[name];
const normalize = (response, overrides = {}) => {
  const r = { ...request, ...overrides };
  return sdk.normalizeSwapSplitPlan(
    response,
    r.token_in_address,
    r.token_out_address,
    r.amount,
  );
};
// The response's plan without validation, for building from changed plans.
const planOf = (response) => ({
  amountIn: response.amount_in,
  amountOut: response.amount_out,
  stages: response.stages.map((stage) =>
    stage.map((part) => ({
      share: part.share,
      amountIn: part.amount_in,
      amountOut: part.amount_out,
      swapChainXdr: part.swap_chain_xdr,
      pools: part.pools,
      tokensAddresses: part.tokens_addresses,
      tokens: part.tokens ?? [],
    })),
  ),
});
const buildOptions = (plan, minimum, extra = {}) => ({
  source: fixture.source,
  router: fixture.router,
  tokenIn: request.token_in_address,
  tokenOut: request.token_out_address,
  plan,
  minimum,
  ...extra,
});
// The SDK's message for a rejection: its family and the failed check.
const rejection = (family, reason) => ({
  message:
    family === "swap"
      ? `Invalid swap: ${reason}.`
      : `Invalid swap quote: ${reason}. Please request a new quote.`,
});

for (const c of cases.amounts)
  test("shared decimal: " + JSON.stringify(c), () => {
    const run = () => sdk.sellAmountToRaw(c.amount, c.decimals);
    if (c.error) assert.throws(run, rejection(c.error, c.reason));
    else assert.equal(run(), c.expected);
  });
for (const c of cases.minimums)
  test("shared minimum: " + JSON.stringify(c), () => {
    const run = () => sdk.getSwapMinimum(c.output, c.slippage);
    if (c.error) assert.throws(run, rejection(c.error, c.reason));
    else assert.equal(run(), c.expected);
  });
for (const c of cases.quotes)
  test("shared quote: " + c.name, () => {
    const response = patched(base(c.base).response, c.patch);
    const run = () => normalize(response, c.request);
    if (c.error === "noRoute") assert.throws(run, sdk.NoRouteError);
    else if (c.error) assert.throws(run, rejection(c.error, c.reason));
    else {
      const plan = run();
      assert.deepEqual(plan, planOf(response));
      assert.equal(plan.amountOut, c.expected.amountOut);
      assert.deepEqual(
        plan.stages.map((stage) => stage.map((part) => part.share)),
        c.expected.shares,
      );
    }
  });
for (const c of cases.builds)
  test("shared build: " + c.name, () => {
    const { response } = base(c.base);
    const trust = c.trust
      ? { batch: fixture.batch, trustline: fixture.trustline }
      : {};
    const run = () =>
      sdk.buildSwapSplitOperation(
        buildOptions(
          planOf(patched(response, c.patch)),
          response.amount_out_min,
          { ...trust, ...c.options },
        ),
      );
    if (c.error) assert.throws(run, rejection(c.error, c.reason));
    else assert.doesNotThrow(run);
  });

const address = (value) => Address.fromScVal(value).toString();
const contractCall = (fn) => ({
  contract: Address.fromScAddress(fn.contractAddress).toString(),
  name: String(fn.functionName),
  args: fn.args,
});
const encoded = (values) => values.map((value) => value.toXdr("base64"));
// The swap_split call and the user's whole authorization of it: the call
// with the same arguments and the one input transfer.
const assertSwapSplit = (call, root, response, minimum) => {
  assert.equal(call.contract, fixture.router);
  assert.equal(call.name, "swap_split");
  assert.equal(call.args.length, 6);
  assert.equal(address(call.args[0]), fixture.source);
  assert.equal(call.args[1].toXdr("base64"), response.stages_xdr);
  assert.equal(address(call.args[2]), request.token_in_address);
  assert.equal(address(call.args[3]), request.token_out_address);
  assert.equal(call.args[4].type, "scvU128");
  assert.equal(scValToNative(call.args[4]), BigInt(response.amount_in));
  assert.equal(call.args[5].type, "scvU128");
  assert.equal(scValToNative(call.args[5]), BigInt(minimum));
  const signed = contractCall(root.function.contractFn);
  assert.equal(signed.contract, call.contract);
  assert.equal(signed.name, call.name);
  assert.deepEqual(encoded(signed.args), encoded(call.args));
  assert.equal(root.subInvocations.length, 1);
  const [transfer] = root.subInvocations;
  const moved = contractCall(transfer.function.contractFn);
  assert.equal(moved.contract, request.token_in_address);
  assert.equal(moved.name, "transfer");
  assert.equal(moved.args.length, 3);
  assert.deepEqual(
    [address(moved.args[0]), address(moved.args[1])],
    [fixture.source, fixture.router],
  );
  assert.equal(moved.args[2].type, "scvI128");
  assert.equal(scValToNative(moved.args[2]), BigInt(response.amount_in));
  assert.equal(transfer.subInvocations.length, 0);
};
for (const [name, entry] of Object.entries(fixture.plans).filter(
  ([, entry]) => entry.operationXdr,
))
  test("shared swap_split operation and authorization: " + name, () => {
    const { response } = entry;
    const plan = normalize(response);
    const minimum = sdk.getSwapMinimum(plan.amountOut, "0.5");
    assert.equal(minimum, response.amount_out_min);
    const operation = sdk.buildSwapSplitOperation(buildOptions(plan, minimum));
    assert.equal(operation.toXdr("base64"), entry.operationXdr);
    assert.equal(operation.sourceAccount, null);
    const invoke = operation.body.invokeHostFunctionOp;
    assert.equal(invoke.auth.length, 1);
    assert.equal(
      invoke.auth[0].credentials.type,
      "sorobanCredentialsSourceAccount",
    );
    assertSwapSplit(
      contractCall(invoke.hostFunction.invokeContract),
      invoke.auth[0].rootInvocation,
      response,
      minimum,
    );
  });
for (const [name, entry] of Object.entries(fixture.plans).filter(
  ([, entry]) => entry.trustOperationXdr,
))
  test("shared trust and swap_split batch: " + name, () => {
    const { response } = entry;
    const minimum = response.amount_out_min;
    const operation = sdk.buildSwapSplitOperation(
      buildOptions(normalize(response), minimum, {
        batch: fixture.batch,
        trustline: fixture.trustline,
      }),
    );
    assert.equal(operation.toXdr("base64"), entry.trustOperationXdr);
    const invoke = operation.body.invokeHostFunctionOp;
    const call = contractCall(invoke.hostFunction.invokeContract);
    assert.equal(call.contract, fixture.batch);
    assert.equal(call.name, "batch");
    const [authorizers, calls, returnResults] = call.args;
    assert.deepEqual(authorizers.vec.map(address), [fixture.source]);
    assert.equal(returnResults.b, true);
    assert.equal(calls.vec.length, 2);
    const [trust, swap] = calls.vec.map((value) => value.vec);
    assert.deepEqual(
      [address(trust[0]), String(trust[1].sym), trust[2].vec.map(address)],
      [request.token_out_address, "trust", [fixture.source]],
    );
    assert.equal(invoke.auth.length, 1);
    const root = invoke.auth[0].rootInvocation;
    const signed = contractCall(root.function.contractFn);
    assert.deepEqual([signed.contract, signed.name], [fixture.batch, "batch"]);
    assert.deepEqual(encoded(signed.args), encoded(call.args));
    assert.equal(root.subInvocations.length, 2);
    const [trustAuth, swapAuth] = root.subInvocations;
    const trusted = contractCall(trustAuth.function.contractFn);
    assert.deepEqual(
      [trusted.contract, trusted.name, trusted.args.map(address)],
      [request.token_out_address, "trust", [fixture.source]],
    );
    assert.equal(trustAuth.subInvocations.length, 0);
    assertSwapSplit(
      {
        contract: address(swap[0]),
        name: String(swap[1].sym),
        args: swap[2].vec,
      },
      swapAuth,
      response,
      minimum,
    );
  });
test("an over-long route XDR is rejected before decoding", () => {
  const response = patched(fixture.plans.single.response, [
    { path: ["stages", 0, 0, "swap_chain_xdr"], value: "A".repeat(32_772) },
  ]);
  const tooLong = rejection("quote", "swap_chain_xdr is too long");
  assert.throws(() => normalize(response), tooLong);
  assert.throws(
    () => sdk.buildSwapSplitOperation(buildOptions(planOf(response), "1")),
    tooLong,
  );
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
test("shared transaction carries the built swap_split with fixed authorization", () => {
  const { response } = fixture.plans.diamond;
  const operation = sdk.buildSwapSplitOperation(
    buildOptions(normalize(response), response.amount_out_min),
  );
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
      run = () => sdk.getSwapSplitResult(value, c.withTrustline).toString();
    if (c.error) assert.throws(run, /Unexpected swap result/);
    else assert.equal(run(), c.expected);
  });
test("fixed auth rejects a changed minimum", () => {
  const wire = tx().toEnvelope().toXdrObject();
  wire.v1.tx.operations[0].body.invokeHostFunctionOp.auth[0].rootInvocation.function.contractFn.args[5].u128.lo +=
    1n;
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
