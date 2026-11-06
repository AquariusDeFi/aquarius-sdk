import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import { LimitOrderConfig, fillParameters, normalizeSwapSplitPlan } from "../dist/index.js";

const load = name => JSON.parse(readFileSync(new URL(`../../testdata/${name}.json`, import.meta.url), "utf8"));
const quotes = load("split-plans");
const expected = load("settlement-routes");
const request = quotes.request;
const record = { order: {
  sellToken: request.token_in_address, buyToken: request.token_out_address,
  sellAmount: BigInt(request.amount), orderScVal: xdr.ScVal.scvVoid(),
} };
const chain = quotes.plans.single.response.stages[0][0].swap_chain_xdr;
const plan = (name = "single") => normalizeSwapSplitPlan(quotes.plans[name].response,
  record.order.sellToken, record.order.buyToken, request.amount);

test("legacy default and typed chain match contract encoding", () => {
  assert.equal(new LimitOrderConfig({ settlement: quotes.router }).routeFormat, "legacy");
  assert.equal(fillParameters(record, quotes.source, chain)[2].toXdr("base64"), expected.legacy);
  assert.equal(fillParameters(record, quotes.source, chain, "typed")[2].toXdr("base64"), expected.chained);
  assert.throws(() => new LimitOrderConfig({ settlement: quotes.router, routeFormat: "typo" }), /route format/);
});

for (const name of Object.keys(quotes.plans)) {
  if (name.startsWith("five")) {
    test(`oversized plan is rejected: ${name}`, () => assert.throws(() => plan(name), /more than 4/));
    continue;
  }
  test(`split plan matches contract structs: ${name}`, () => {
    assert.equal(fillParameters(record, quotes.source, plan(name), "typed")[2].toXdr("base64"), expected.split[name]);
  });
}

test("split requires typed settlement and revalidates the plan", () => {
  assert.throws(() => fillParameters(record, quotes.source, plan()), /typed/);
  const badInput = plan();
  badInput.amountIn = String(record.order.sellAmount + 1n);
  assert.throws(() => fillParameters(record, quotes.source, badInput, "typed"), /order input/);
  const badShares = plan();
  badShares.stages[0][0].share -= 1;
  assert.throws(() => fillParameters(record, quotes.source, badShares, "typed"), /shares/);
  const wrongOrder = { order: { ...record.order, buyToken: quotes.router } };
  assert.throws(() => fillParameters(wrongOrder, quotes.source, plan(), "typed"), /token_out/);
});
