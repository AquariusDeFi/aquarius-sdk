import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, rpc } from "@stellar/stellar-sdk";

import { AquariusClient } from "../dist/index.js";

function funding(t) {
  const signer = Keypair.random();
  const client = new AquariusClient({
    network: "testnet", signer,
    horizonUrl: "https://horizon.example", rpcUrl: "https://rpc.example",
  });
  const state = {
    now: 0, horizonReadyAt: 0, rpcReadyAt: 0,
    horizonStatus: 200, rpcError: null, friendbotCalls: 0,
    horizonCalls: 0, rpcCalls: 0, slowHorizon: 0, slowRpc: 0,
  };
  t.mock.method(performance, "now", () => state.now);
  t.mock.method(globalThis, "setTimeout", (callback, ms) => {
    state.now += ms;
    callback();
  });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(init.signal instanceof AbortSignal);
    if (url === `https://friendbot.stellar.org?addr=${signer.publicKey()}`) {
      state.friendbotCalls += 1;
      return { ok: true };
    }
    assert.equal(url, `https://horizon.example/accounts/${signer.publicKey()}`);
    state.horizonCalls += 1;
    state.now += state.slowHorizon;
    const status = state.now < state.horizonReadyAt ? 404 : state.horizonStatus;
    return { ok: status === 200, status };
  });
  t.mock.method(rpc.Server.prototype, "getLedgerEntries", async function (key) {
    assert.equal(this.serverURL.toString(), "https://rpc.example/");
    assert.equal(Keypair.fromPublicKey(signer.publicKey()).xdrPublicKey().toXdr("base64"),
      key.account.accountId.toXdr("base64"));
    assert.ok(this.httpClient.defaults.timeout > 0);
    assert.ok(this.httpClient.defaults.timeout <= 30_000 - state.now);
    state.rpcCalls += 1;
    state.now += state.slowRpc;
    if (state.rpcError) throw state.rpcError;
    return { entries: state.now < state.rpcReadyAt ? [] : [{}] };
  });
  return { client, state };
}

test("Friendbot waits for Horizon and RPC after funding once", async t => {
  const { client, state } = funding(t);
  state.horizonReadyAt = 1_000;
  state.rpcReadyAt = 3_000;
  assert.equal(await client.fundWithFriendbot(), undefined);
  assert.equal(state.now, 3_000);
  assert.equal(state.rpcCalls, 3);
  assert.equal(state.friendbotCalls, 1);
});

test("Friendbot returns immediately when both backends are ready", async t => {
  const { client, state } = funding(t);
  assert.equal(await client.fundWithFriendbot(), undefined);
  assert.deepEqual([state.horizonCalls, state.rpcCalls, state.now], [1, 1, 0]);
});

for (const backend of ["horizon", "rpc"]) {
  test(`Friendbot ${backend} absence times out without refunding`, async t => {
    const { client, state } = funding(t);
    state[`${backend}ReadyAt`] = Infinity;
    await assert.rejects(client.fundWithFriendbot(), /Timed out.*Horizon.*RPC/);
    assert.equal(state.now, 30_000);
    assert.equal(state.friendbotCalls, 1);
  });

  test(`Friendbot counts ${backend} request time toward deadline`, async t => {
    const { client, state } = funding(t);
    state[`${backend}ReadyAt`] = Infinity;
    state[backend === "horizon" ? "slowHorizon" : "slowRpc"] = 29_750;
    await assert.rejects(client.fundWithFriendbot(), /Timed out/);
    assert.equal(state.now, 30_000);
    assert.equal(state[`${backend}Calls`], 1);
  });
}

for (const status of [403, 429, 503]) {
  test(`Friendbot does not retry Horizon HTTP ${status}`, async t => {
    const { client, state } = funding(t);
    state.horizonStatus = status;
    await assert.rejects(client.fundWithFriendbot(), new RegExp(`HTTP ${status}`));
    assert.deepEqual([state.horizonCalls, state.now], [1, 0]);
  });
}

for (const error of [{ code: -32603, message: "internal error" }, new Error("RPC timed out")]) {
  test(`Friendbot propagates RPC ${error.message} without retry`, async t => {
    const { client, state } = funding(t);
    state.rpcError = error;
    await assert.rejects(client.fundWithFriendbot(), caught => caught === error);
    assert.deepEqual([state.rpcCalls, state.now], [1, 0]);
  });
}
