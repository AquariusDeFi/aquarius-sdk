import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, mock } from "node:test";
import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { ApiClient, Asset, AquariusClient, LimitOrderManager } from "../dist/index.js";

const vector = JSON.parse(
  readFileSync(new URL("../../testdata/limit_order_auto_trust.json", import.meta.url), "utf8"),
);
const onchain = JSON.parse(
  readFileSync(new URL("../../testdata/limit_order_onchain_draft.json", import.meta.url), "utf8"),
);
const draft = () => {
  const result = { ...vector, status: "DRAFT" };
  delete result.authorization_xdr;
  return result;
};
const params = () => ({
  maker: vector.maker,
  placementMode: "DETACHED",
  from: Asset.contract(vector.sell_token),
  to: Asset.classic(vector.buy_code, vector.buy_issuer),
  sellAmount: BigInt(vector.sell_amount),
  minBuyAmount: BigInt(vector.min_buy_amount),
  validAfterLedger: vector.valid_after_ledger,
  expiresAtLedger: vector.expires_at_ledger,
  expectedExecutorRewardXlm: BigInt(vector.executor_reward_xlm),
  requireTrustline: true,
});
const record = (status = "OPEN") => ({
  ...onchain,
  status,
  placement_ledger: 101,
  placement_transaction_hash: "ab".repeat(32),
});
function setup() {
  const api = {
    createLimitOrderDraft: mock.fn(async () => draft()),
    authorizeLimitOrder: mock.fn(async () => ({ ...vector, status: "OPEN" })),
    listLimitOrders: mock.fn(async () => ({ orders: [], next_cursor: null })),
  };
  const context = {
    passphrase: Networks.TESTNET,
    settlement: vector.settlement_address,
    apiUrl: "https://registry.test/",
    api,
    server: { getLatestLedger: mock.fn(async () => ({ sequence: 100 })) },
    prepare: mock.fn(async (maker, op) =>
      new TransactionBuilder(new Account(maker, "1"), {
        fee: "100",
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(op)
        .setTimeout(300)
        .build(),
    ),
  };
  const manager = new LimitOrderManager(context);
  manager.getSettlementConfig = mock.fn(async () => ({
    maxOrderTtl: 1000,
    executorRewardXlm: vector.executor_reward_xlm,
  }));
  return { manager, context, api };
}

test("wallet draft pins approved assets and values across asynchronous reads", async () => {
  const { manager, api } = setup();
  const intent = params();
  const promise = manager.create(intent);
  intent.sellAmount = 1n;
  intent.to.code = "FAKE";
  intent.to.issuer = Keypair.random().publicKey();
  const prepared = await promise;
  assert.equal(prepared.orderId, vector.order_id);
  assert.equal(api.createLimitOrderDraft.mock.calls[0].arguments[1].buy_token, vector.buy_token);
  const raw = prepared.raw;
  raw.unsigned_authorization_xdr = "changed";
  raw.sell_amount = "1";
  assert.equal(prepared.authorizationEntryXdr, vector.unsigned_authorization_xdr);
  assert.equal(prepared.raw.sell_amount, vector.sell_amount);
});

test("detached authorization publishes the exact verified signature and retries the same order", async () => {
  const { manager, api } = setup();
  const prepared = await manager.create(params());
  api.authorizeLimitOrder.mock.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  await assert.rejects(prepared.authorize(vector.authorization_xdr), /offline/);
  assert.equal((await prepared.authorize(vector.authorization_xdr)).order_id, vector.order_id);
  assert.equal(api.createLimitOrderDraft.mock.callCount(), 1);
  assert.deepEqual(
    api.authorizeLimitOrder.mock.calls[0].arguments,
    api.authorizeLimitOrder.mock.calls[1].arguments,
  );
  assert.equal(api.authorizeLimitOrder.mock.calls[1].arguments[1], vector.order_id);
  await assert.rejects(prepared.authorize(vector.unsigned_authorization_xdr));
  assert.equal(api.authorizeLimitOrder.mock.callCount(), 2);
  await assert.rejects(prepared.buildTransaction(), /Detached orders/);
});

test("draft preparation rejects changed rewards, expiry and invalid intent before registry requests", async () => {
  for (const mutate of [
    (p) => {
      p.expectedExecutorRewardXlm += 1n;
    },
    (p) => {
      p.expiresAtLedger = 1101;
    },
    (p) => {
      p.validAfterLedger = 1;
      p.expiresAtLedger = 99;
    },
    (p) => {
      p.sellAmount = 0n;
    },
    (p) => {
      p.to = p.from;
    },
    (p) => {
      p.to = Asset.native();
    },
  ]) {
    const { manager, api } = setup();
    const intent = params();
    mutate(intent);
    await assert.rejects(manager.create(intent));
    assert.equal(api.createLimitOrderDraft.mock.callCount(), 0);
  }
});

test("a substituted registry draft is never exposed for wallet signing", async () => {
  const { manager, api } = setup();
  api.createLimitOrderDraft.mock.mockImplementation(async () => ({
    ...draft(),
    min_buy_amount: "1",
  }));
  await assert.rejects(manager.create(params()), /canonical order XDR/);
  assert.equal(api.authorizeLimitOrder.mock.callCount(), 0);
});

test("history forwards completion sorting and opaque cursors without fetching later pages", async () => {
  const { manager, api } = setup();
  api.listLimitOrders.mock.mockImplementation(async () => ({
    orders: [record("FILLED")],
    next_cursor: "next+/=",
  }));
  const page = await manager.history(onchain.maker, "previous+/=");
  assert.equal(page.orders.length, 1);
  assert.equal(api.listLimitOrders.mock.callCount(), 1);
  assert.deepEqual(api.listLimitOrders.mock.calls[0].arguments, [
    "https://registry.test/",
    {
      maker: onchain.maker,
      status: "FILLED,CANCELLED,EXPIRED",
      sort: "-completed_at",
      cursor: "previous+/=",
      limit: "20",
    },
  ]);
});

test("registry pages reject wrong makers, open history, malformed data and cursor loops", async () => {
  for (const response of [
    {},
    { orders: [record()] },
    { orders: [], next_cursor: "same" },
    { orders: [], next_cursor: 12 },
    { orders: [{ ...record("FILLED"), maker: Keypair.random().publicKey() }] },
  ]) {
    const { manager, api } = setup();
    api.listLimitOrders.mock.mockImplementation(async () => response);
    await assert.rejects(manager.history(onchain.maker, "same"));
  }
});

test("open-order pagination follows all pages and rejects duplicate IDs", async () => {
  const { manager, api } = setup();
  api.listLimitOrders.mock.mockImplementationOnce(async () => ({
    orders: [record()],
    next_cursor: "next",
  }));
  assert.equal((await manager.open(onchain.maker)).orders.length, 1);
  assert.equal(api.listLimitOrders.mock.callCount(), 2);
  api.listLimitOrders.mock.mockImplementation(async () => ({
    orders: [record()],
    next_cursor: "next",
  }));
  await assert.rejects(manager.open(onchain.maker), /pagination cursor|repeated an order/);
});

test("cancel builds an unsigned maker-authorized transaction and rejects substitutions", async () => {
  const { manager, context } = setup();
  const prepared = await manager.buildCancelTransaction(onchain.maker, record());
  assert.ok(prepared);
  const op = context.prepare.mock.calls[0].arguments[1];
  assert.equal(
    op.body.invokeHostFunctionOp.auth[0].credentials.type,
    "sorobanCredentialsSourceAccount",
  );
  await assert.rejects(manager.buildCancelTransaction(Keypair.random().publicKey(), record()));
  assert.equal(context.prepare.mock.callCount(), 1);
});

test("read-only client exposes order history without a signer", async () => {
  const client = new AquariusClient({
    network: "testnet",
    limitOrders: { settlement: vector.settlement_address, apiUrl: "https://registry.test/" },
  });
  client.api.listLimitOrders = async () => ({ orders: [], next_cursor: null });
  assert.equal(client.limitOrders, client.limitOrders);
  assert.deepEqual(await client.limitOrders.history(vector.maker), {
    orders: [],
    next_cursor: null,
  });
});

test("registry transport encodes opaque cursors and posts the signed entry with a timeout", async (t) => {
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ orders: [], next_cursor: null })),
  );
  const api = new ApiClient("https://unused.test/");
  await api.listLimitOrders("https://registry.test/", { cursor: "abc+/=", sort: "-completed_at" });
  assert.equal(new URL(fetch.mock.calls[0].arguments[0]).searchParams.get("cursor"), "abc+/=");
  await api.authorizeLimitOrder(
    "https://registry.test/",
    vector.order_id,
    vector.authorization_xdr,
  );
  const [url, options] = fetch.mock.calls[1].arguments;
  assert.equal(url, `https://registry.test/orders/${vector.order_id}/authorize/`);
  assert.equal(options.method, "POST");
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(options.body), { authorization_xdr: vector.authorization_xdr });
});
