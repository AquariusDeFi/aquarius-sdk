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
const plans = () =>
  split.normalizeSellSwapPlans(
    response,
    request.token_in_address,
    request.token_out_address,
    request.amount,
  );
const contract = (n) => Address.contract(Buffer.alloc(32, n)).toString();
test("API plans conserve allocation and invalid optional plans preserve fallback", () => {
  assert.deepEqual(
    plans().map((p) => p.legs.length),
    [1, 4, 2],
  );
  assert.ok(
    plans().every(
      (p) =>
        p.legs.reduce((s, l) => s + BigInt(l.amountIn), 0n) ===
        BigInt(request.amount),
    ),
  );
  const bad = structuredClone(response);
  bad.split_plans[0].legs[0].amount_in = "1";
  assert.deepEqual(
    split
      .normalizeSellSwapPlans(
        bad,
        request.token_in_address,
        request.token_out_address,
        request.amount,
      )
      .map((p) => p.legs.length),
    [1, 2],
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
    plan = plans()[2];
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
});
test("rejected split preserves executable bounded baseline", async () => {
  const best = await split.prepareSellSwapPlans(
    plans(),
    "1",
    async (p, min) => {
      if (p.legs.length > 1) throw Error("budget");
      return { tx: min, outputs: [100n] };
    },
  );
  assert.equal(best.tx, "99");
  assert.equal(best.plan.legs.length, 1);
});
for (const amount of ["0", "-1", "1.5", "1e2", (1n << 127n).toString()])
  test(`reject invalid raw input ${amount}`, () => {
    assert.throws(() =>
      split.normalizeSellSwapPlans(
        response,
        request.token_in_address,
        request.token_out_address,
        amount,
      ),
    );
  });
test("malformed optional XDR, excess input and repeated route pools cannot expand authorization", () => {
  for (const corrupt of [
    (q) => (q.split_plans[0].legs[0].swap_chain_xdr = "invalid"),
    (q) => (q.split_plans[0].amount_in = "1"),
    (q) => q.split_plans[0].legs[0].tokens_addresses.reverse(),
  ]) {
    const q = structuredClone(response);
    corrupt(q);
    assert.deepEqual(
      split
        .normalizeSellSwapPlans(
          q,
          request.token_in_address,
          request.token_out_address,
          request.amount,
        )
        .map((p) => p.legs.length),
      [1, 2],
    );
  }
});
test("probe output is never exposed until bounded simulation is stable", async () => {
  const seen = [];
  const best = await split.prepareSellSwapPlans(
    [plans()[0]],
    "1",
    async (p, min) => {
      seen.push(min);
      return { tx: min, outputs: [min === "0" ? 100n : 110n] };
    },
  );
  assert.deepEqual(seen, ["0", "99", "108"]);
  assert.equal(best.outputAmount, "110");
  assert.equal(best.minimumOutput, "108");
});
test("malformed result and continuously changing outputs fail closed", async () => {
  await assert.rejects(
    split.prepareSellSwapPlans([plans()[0]], "1", async () => ({
      tx: "x",
      outputs: [],
    })),
  );
  let n = 0n;
  await assert.rejects(
    split.prepareSellSwapPlans([plans()[0]], "1", async () => ({
      tx: "x",
      outputs: [++n],
    })),
  );
});
