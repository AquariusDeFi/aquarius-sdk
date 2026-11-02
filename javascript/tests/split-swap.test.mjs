import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Address, Keypair, scValToNative } from "@stellar/stellar-sdk";
import * as split from "../dist/split-swap.js";
const { request, response } = JSON.parse(
  readFileSync(
    new URL("../../testdata/split-api-response.json", import.meta.url),
  ),
);
const normalized = () =>
  split.normalizeSellSwapPlan(
    response,
    request.token_in_address,
    request.token_out_address,
    request.amount,
  );
const contract = (n) => Address.contract(Buffer.alloc(32, n)).toString();
test("API split plan conserves allocation and an invalid plan fails closed", () => {
  assert.equal(normalized().legs.length, 2);
  assert.equal(
    normalized().legs.reduce((s, l) => s + BigInt(l.amountIn), 0n),
    BigInt(request.amount),
  );
  const bad = structuredClone(response);
  bad.split_plan.legs[0].amount_in = "1";
  assert.throws(
    () =>
      split.normalizeSellSwapPlan(
        bad,
        request.token_in_address,
        request.token_out_address,
        request.amount,
      ),
    /Invalid swap quote/,
  );
});
test("minimum and decimal conversion retain precision", () => {
  assert.equal(
    split.sellAmountToRaw("9007199254740993.0000001", 7),
    "90071992547409930000001",
  );
  assert.equal(split.getSwapMinimum("10001", "0.005"), "10000");
  assert.throws(() => split.sellAmountToRaw("0.00000001", 7));
});
test("fixed auth binds exact ordered input transfers and aggregate minimum", () => {
  const source = Keypair.random().publicKey(),
    router = contract(8),
    splitRouter = contract(9),
    plan = normalized();
  const op = split.buildSellSwapOperation({
    source,
    router,
    splitRouter,
    tokenIn: request.token_in_address,
    tokenOut: request.token_out_address,
    plan,
    minimum: "123",
  });
  const root = op.body.invokeHostFunctionOp.auth[0].rootInvocation;
  assert.equal(
    Address.fromScAddress(root.function.contractFn.contractAddress).toString(),
    splitRouter,
  );
  assert.equal(scValToNative(root.function.contractFn.args[5]), 123n);
  assert.equal(root.subInvocations.length, 2);
  root.subInvocations.forEach((child, i) => {
    assert.equal(scValToNative(child.function.contractFn.args[4]), 0n);
    assert.equal(
      scValToNative(child.subInvocations[0].function.contractFn.args[2]),
      BigInt(plan.legs[i].amountIn),
    );
  });
  assert.throws(() =>
    split.buildSellSwapOperation({
      source,
      router,
      splitRouter,
      tokenIn: request.token_in_address,
      tokenOut: request.token_out_address,
      plan: { ...plan, amountIn: "1" },
      minimum: "123",
    }),
  );
  assert.throws(() =>
    split.buildSellSwapOperation({
      source,
      router,
      splitRouter,
      batch: contract(10),
      tokenIn: request.token_in_address,
      tokenOut: request.token_out_address,
      plan,
      minimum: "123",
      trustline: {},
    }),
  );
});
for (const amount of ["0", "-1", "1.5", "1e2", (1n << 127n).toString()])
  test(`reject invalid raw input ${amount}`, () => {
    assert.throws(() =>
      split.normalizeSellSwapPlan(
        response,
        request.token_in_address,
        request.token_out_address,
        amount,
      ),
    );
  });
test("malformed split XDR, excess input and reversed route tokens fail closed", () => {
  for (const corrupt of [
    (q) => (q.split_plan.legs[0].swap_chain_xdr = "invalid"),
    (q) => (q.split_plan.amount_in = "1"),
    (q) => q.split_plan.legs[0].tokens_addresses.reverse(),
  ]) {
    const q = structuredClone(response);
    corrupt(q);
    assert.throws(
      () =>
        split.normalizeSellSwapPlan(
          q,
          request.token_in_address,
          request.token_out_address,
          request.amount,
        ),
      /Invalid swap quote/,
    );
  }
});
