// The lifecycle verifies balances after Horizon has ingested the confirmed swap.
import assert from "node:assert/strict";
import { test } from "node:test";

import { waitForHorizonAccount } from "../e2e/horizon.mjs";

const horizon = "https://horizon.example";
const accountId = "fixture-account";
const hash = "fixture-transaction";
const transaction = { successful: true, source_account: accountId, source_account_sequence: "105" };

function fixture(reply) {
  let time = 0;
  const requests = [];
  return {
    requests,
    now: () => time,
    sleep: async ms => { time += ms; },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const { status = 200, body } = reply(url);
      return new Response(JSON.stringify(body), { status });
    },
  };
}

test("final balances wait for transaction ingestion and a current account sequence", async () => {
  const replies = [
    { status: 404, body: {} },
    { body: transaction },
    { body: { sequence: "104", balances: [{ balance: "706.3337097" }] } },
    { body: { sequence: "105", balances: [{ balance: "0.0000000" }] } },
  ];
  const transport = fixture(() => replies.shift());
  const account = await waitForHorizonAccount(horizon, accountId, hash, transport);
  assert.equal(account.sequence, "105");
  assert.equal(account.balances[0].balance, "0.0000000");
  assert.ok(transport.requests.every(({ options }) => options.cache === "no-store"));
});

test("a Horizon account that remains behind fails within the 60 second budget", async () => {
  const transport = fixture(url => ({
    body: url.includes("/transactions/") ? transaction : { sequence: "104", balances: [] },
  }));
  await assert.rejects(
    waitForHorizonAccount(horizon, accountId, hash, transport),
    /Horizon did not ingest the final transaction within 60 seconds/,
  );
  assert.equal(transport.now(), 60_000);
});

test("confirmed nonzero balances are returned for the unchanged financial assertions", async () => {
  const dust = { sequence: "105", balances: [{ balance: "1.0000000" }] };
  const transport = fixture(url => ({ body: url.includes("/transactions/") ? transaction : dust }));
  assert.deepEqual(await waitForHorizonAccount(horizon, accountId, hash, transport), dust);
  assert.equal(transport.now(), 0);
});

test("a failed or unrelated transaction cannot satisfy the synchronization gate", async () => {
  for (const body of [{ ...transaction, successful: false }, { ...transaction, source_account: "other" }]) {
    await assert.rejects(
      waitForHorizonAccount(horizon, accountId, hash, fixture(() => ({ body }))),
      /Final transaction does not match the successful lifecycle swap/,
    );
  }
});
