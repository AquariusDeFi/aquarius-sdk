import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { ApiClient, AquariusClient, Asset, SlippageError, buildSwapSplitOperation, normalizeSwapSplitPlan } from "../dist/index.js";
const fixture = JSON.parse(
  readFileSync(new URL("../../testdata/split-plans.json", import.meta.url)),
);

const recordFetch = async (body, run) => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
};

test("findPathSplit posts the quote request", async () => {
  const { request } = fixture;
  const { result, calls } = await recordFetch(
    fixture.plans.diamond.response,
    () => new ApiClient("https://api.invalid/v2").findPathSplit(request),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.invalid/v2/find-path-split/");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, {
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), request);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  const plan = normalizeSwapSplitPlan(
    result,
    request.token_in_address,
    request.token_out_address,
    request.amount,
  );
  assert.deepEqual(
    plan.stages.map((stage) => stage.map((part) => part.share)),
    [[10000], [3500, 6500]],
  );
});

test("findPath keeps its endpoints and request", async () => {
  const request = {
    token_in_address: "a",
    token_out_address: "b",
    amount: "1",
  };
  const { calls } = await recordFetch({}, async () => {
    const api = new ApiClient("https://api.invalid/v2");
    await api.findPath(request, true);
    await api.findPath(request, false);
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://api.invalid/v2/find-path/",
      "https://api.invalid/v2/find-path-strict-receive/",
    ],
  );
  assert.deepEqual(
    calls.map((call) => JSON.parse(call.init.body)),
    [request, request],
  );
});

test("swap retries an exact-input sale with the newly quoted plan and returns the confirmed output", async () => {
  const signer = Keypair.random();
  const client = new AquariusClient({ network: "testnet", signer });
  const { token_in_address: tokenIn, token_out_address: tokenOut, amount } = fixture.request;
  const plans = [fixture.plans.single.response, fixture.plans.parallel.response];
  let requests = 0;
  client.api.findPath = () => assert.fail("unexpected chained quote");
  client.api.findPathSplit = async (request) => {
    assert.deepEqual(request, { token_in_address: tokenIn, token_out_address: tokenOut, amount });
    return plans[requests++];
  };
  client.engine.prepare = async (source, build) => {
    const response = plans[requests - 1];
    const expected = buildSwapSplitOperation({
      source, router: client.network.router, tokenIn, tokenOut,
      plan: normalizeSwapSplitPlan(response, tokenIn, tokenOut, amount),
      minimum: (BigInt(response.amount_out) * 99n / 100n).toString(),
    });
    assert.equal(build().toXdr("base64"), expected.toXdr("base64"));
    if (requests === 1) throw new SlippageError("guard breached");
    return "prepared";
  };
  const received = BigInt(plans[1].amount_out) + 1n;
  client.engine.signAndSubmit = async (tx) => {
    assert.equal(tx, "prepared");
    return { txHash: "confirmed", returnValue: nativeToScVal(received, { type: "u128" }) };
  };
  const receipt = await client.swap({
    from: Asset.contract(tokenIn), to: Asset.contract(tokenOut), amountIn: BigInt(amount), retries: 1,
  });
  assert.deepEqual(receipt, { txHash: "confirmed", amountIn: BigInt(amount), amountOut: received });
  assert.equal(requests, 2);
});

test("swap uses a chained quote only when the split endpoint is unavailable", async t => {
  const client = new AquariusClient({ network: "testnet" });
  const { token_in_address, token_out_address, amount } = fixture.request;
  const params = { from: Asset.contract(token_in_address), to: Asset.contract(token_out_address), amountIn: BigInt(amount) };
  const quote = t.mock.method(client, "quote", async () => ({ execute: async () => "legacy receipt" }));
  const fetch = t.mock.method(globalThis, "fetch");
  for (const status of [404, 405]) {
    fetch.mock.mockImplementation(async () => ({ ok: false, status }));
    assert.equal(await client.swap(params), "legacy receipt");
  }
  fetch.mock.mockImplementation(async () => ({ ok: false, status: 503 }));
  await assert.rejects(client.swap(params), /HTTP 503/);
  fetch.mock.mockImplementation(async () => ({ ok: true, json: async () => ({ success: true }) }));
  await assert.rejects(client.swap(params), /Invalid swap quote/);
  assert.equal(quote.mock.callCount(), 2);
});

test("swap with a provider fee quotes through the chained collector", async t => {
  const client = new AquariusClient({ network: "testnet" });
  const providerFee = { contractId: fixture.collector, feeFraction: 3, feeDenominator: 1000 };
  const params = {
    from: Asset.contract(fixture.request.token_in_address), to: Asset.contract(fixture.request.token_out_address),
    amountIn: 100n, providerFee,
  };
  t.mock.method(client.api, "findPathSplit", () => assert.fail("unexpected split quote"));
  const quote = t.mock.method(client, "quote", async () => ({ execute: async () => "collector receipt" }));
  assert.equal(await client.swap(params), "collector receipt");
  assert.deepEqual(quote.mock.calls[0].arguments, [params]);
});
