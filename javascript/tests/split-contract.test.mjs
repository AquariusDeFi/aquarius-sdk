import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import {
  Account,
  Address,
  Networks,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  AquariusClient,
  buildSwapSplitOperation,
  getSwapMinimum,
  normalizeSwapSplitPlan,
} from "../dist/index.js";
import { swapResourceConfig } from "./split-resource-fixture.mjs";

const fixture = JSON.parse(
  fs.readFileSync(new URL("../../testdata/split-plans.json", import.meta.url)),
);
const entry = fixture.plans.single;
const plan = normalizeSwapSplitPlan(
  entry.response,
  fixture.request.token_in_address,
  fixture.request.token_out_address,
  fixture.request.amount,
);
const options = {
  source: fixture.source,
  router: fixture.router,
  tokenIn: fixture.request.token_in_address,
  tokenOut: fixture.request.token_out_address,
  plan,
  minimum: "1",
};
const providerFee = {
  contractId: fixture.batch,
  feeFraction: 100,
  feeDenominator: 10000,
};

test("split contract trust stays under the swap root without a batch", () => {
  const op = buildSwapSplitOperation({
    ...options,
    trustline: fixture.trustline,
  });
  const root = op.body.invokeHostFunctionOp.auth[0].rootInvocation;
  assert.equal(root.function.contractFn.functionName.toString(), "swap_split");
  assert.deepEqual(
    root.subInvocations.map((c) =>
      c.function.contractFn.functionName.toString(),
    ),
    ["trust", "transfer"],
  );
  assert.equal(
    Address.fromScAddress(
      root.subInvocations[0].function.contractFn.contractAddress,
    ).toString(),
    options.tokenOut,
  );
});

test("provider split authorizes only the collector and checks the net minimum", () => {
  const op = buildSwapSplitOperation({
    ...options,
    providerFee,
    trustline: fixture.trustline,
  });
  const invoke = op.body.invokeHostFunctionOp;
  const root = invoke.auth[0].rootInvocation;
  assert.equal(
    Address.fromScAddress(root.function.contractFn.contractAddress).toString(),
    providerFee.contractId,
  );
  assert.equal(root.function.contractFn.args.at(-1).u32, 100);
  const transfer = root.subInvocations[1].function.contractFn;
  assert.equal(
    Address.fromScVal(transfer.args[1]).toString(),
    providerFee.contractId,
  );
  assert.equal(getSwapMinimum("101", "1", providerFee), "98");
});

test("provider split to another recipient binds it and cannot open its line as the source", () => {
  const recipient = fixture.router;
  const op = buildSwapSplitOperation({
    ...options,
    providerFee: { ...providerFee, recipient },
  });
  const fn = op.body.invokeHostFunctionOp.hostFunction.invokeContract;
  assert.equal(fn.functionName.toString(), "swap_split_to");
  assert.equal(Address.fromScVal(fn.args[1]).toString(), recipient);
  assert.throws(
    () =>
      buildSwapSplitOperation({
        ...options,
        providerFee: { ...providerFee, recipient },
        trustline: fixture.trustline,
      }),
    /recipient/,
  );
});

test("assembling a fixed swap preserves SDK CPU and fee headroom without another simulation", async () => {
  const client = new AquariusClient({ network: "testnet" });
  client.server.getLedgerEntries = async () => swapResourceConfig();
  client.server.simulateTransaction = async () => {
    throw new Error("must not resimulate");
  };
  const op = buildSwapSplitOperation(options);
  const tx = new TransactionBuilder(new Account(fixture.source, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(0)
    .build();
  const simulation = {
    _parsed: true,
    latestLedger: 1,
    events: [],
    minResourceFee: "500",
    transactionData: new SorobanDataBuilder()
      .setResources(400, 0, 0)
      .setResourceFee("500"),
    result: { auth: [], retval: xdr.ScVal.scvU128({ hi: 0n, lo: 1n }) },
  };
  const prepared = await client.assembleTransaction(tx, op, simulation);
  const data = prepared.toEnvelope().v1.tx.ext.sorobanData;
  assert.equal(data.resources.instructions, 500);
  assert.equal(data.resourceFee, 750n);
  assert.equal(prepared.fee, "850");
  assert.equal(
    prepared.toEnvelope().v1.tx.operations[0].toXdr("base64"),
    op.toXdr("base64"),
  );
});

for (const [name, p] of Object.entries(fixture.plans).filter(
  ([, p]) => p.operationXdr,
)) {
  test(`contract trust fixture: ${name}`, () => {
    const plan = normalizeSwapSplitPlan(
      p.response,
      options.tokenIn,
      options.tokenOut,
      fixture.request.amount,
    );
    const op = buildSwapSplitOperation({
      ...options,
      plan,
      minimum: p.response.amount_out_min,
      trustline: fixture.trustline,
    });
    assert.equal(op.toXdr("base64"), p.contractTrustOperationXdr);
  });
}
