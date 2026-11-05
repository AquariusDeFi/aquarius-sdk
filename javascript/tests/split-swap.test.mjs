import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { ApiClient, normalizeSwapSplitPlan } from "../dist/index.js";
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
