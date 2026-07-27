import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  Address,
  Networks,
  StrKey,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";

import {
  AquariusClient,
  AquariusError,
  Asset,
  LimitOrderConfig,
  OnchainLimitOrder,
  buildOnchainPlacementArgs,
  validateOnchainLimitOrderDraft,
} from "../dist/index.js";

const draft = JSON.parse(
  readFileSync(
    new URL("../../testdata/limit_order_onchain_draft.json", import.meta.url),
    "utf8",
  ),
);
const batcher = StrKey.encodeContract(Buffer.alloc(32, 5));
const xlmToken = StrKey.encodeContract(Buffer.alloc(32, 4));

function validate(payload = draft) {
  return validateOnchainLimitOrderDraft(payload, {
    expectedNetworkPassphrase: Networks.TESTNET,
    expectedSettlement: draft.settlement_address,
    expectedMaker: draft.maker,
    expectedOrder: {
      sellToken: draft.sell_token,
      sellAmount: 1_000n,
      buyToken: draft.buy_token,
      minBuyAmount: 900n,
      validAfterLedger: 100,
      expiresAtLedger: 200,
    },
    allowanceExpirationLedger: 250,
  });
}

test("limit-order config requires contract addresses", () => {
  const config = new LimitOrderConfig({
    settlement: draft.settlement_address,
    batcher,
  });
  assert.equal(config.settlement, draft.settlement_address);
  assert.throws(
    () => new LimitOrderConfig({ settlement: draft.settlement_address, batcher: draft.maker }),
    AquariusError,
  );
});

test("on-chain draft validates canonical XDR and JSON projection", () => {
  const order = validate();
  assert.equal(order.orderId, draft.order_id);
  assert.equal(order.orderScVal.toXDR("base64"), draft.order_xdr);
  assert.equal(order.allowanceExpirationLedger, 250);
  assert.deepEqual(order.requiredAllowances(xlmToken), new Map([
    [draft.sell_token, 1_000n],
    [xlmToken, 5_000_000n],
  ]));

  assert.throws(
    () => validate({ ...draft, sell_amount: "1001" }),
    /canonical order XDR/,
  );
  assert.throws(
    () => validate({ ...draft, order_id: "00".repeat(32) }),
    /order ID/,
  );
  assert.throws(
    () => validate({ ...draft, sell_amount: "not-an-integer" }),
    /canonical order XDR/,
  );
  assert.throws(
    () => validateOnchainLimitOrderDraft(draft, {
      expectedNetworkPassphrase: Networks.TESTNET,
      expectedSettlement: draft.settlement_address,
      expectedMaker: draft.maker,
      expectedOrder: {
        sellToken: draft.sell_token,
        sellAmount: 1_000n,
        buyToken: draft.buy_token,
        minBuyAmount: 900n,
        validAfterLedger: 100,
        expiresAtLedger: 200,
      },
      allowanceExpirationLedger: 199,
    }),
    /allowance expiration/,
  );
});

test("placement uses idempotent absolute approvals and exact marker", () => {
  const order = validate();
  const args = buildOnchainPlacementArgs(order, new Map([
    [draft.sell_token, 1_500n],
    [xlmToken, 4_000_000n],
  ]), xlmToken);

  assert.deepEqual(scValToNative(args[0]), [draft.maker]);
  assert.deepEqual(scValToNative(args[1]), [
    [
      draft.sell_token,
      "approve",
      [draft.maker, draft.settlement_address, 1_500n, 250],
    ],
    [
      xlmToken,
      "approve",
      [draft.maker, draft.settlement_address, 5_000_000n, 250],
    ],
    [
      draft.settlement_address,
      "place_contract_order",
      [draft.maker, Buffer.from(draft.order_id, "hex"), 200],
    ],
  ]);
  assert.equal(scValToNative(args[2]), false);
});

test("XLM sale uses one combined allowance", () => {
  const original = validate();
  const order = new OnchainLimitOrder(
    original.orderId,
    original.settlementAddress,
    original.maker,
    xlmToken,
    original.sellAmount,
    original.buyToken,
    original.minBuyAmount,
    original.validAfterLedger,
    original.expiresAtLedger,
    original.allowanceExpirationLedger,
    original.executorRewardXlm,
    original.orderScVal,
  );

  assert.deepEqual(order.requiredAllowances(xlmToken), new Map([[xlmToken, 5_001_000n]]));
  const calls = scValToNative(buildOnchainPlacementArgs(
    order,
    new Map([[xlmToken, 6_000_000n]]),
    xlmToken,
  )[1]);
  assert.deepEqual(calls.map(call => call[1]), ["approve", "place_contract_order"]);
  assert.equal(calls[0][2][2], 6_000_000n);
});

test("client creates a validated draft and builds batcher and cancel transactions", async () => {
  const signer = { publicKey: () => draft.maker, sign: value => value };
  const client = new AquariusClient({
    network: "testnet",
    signer,
    limitOrders: {
      settlement: draft.settlement_address,
      batcher,
    },
  });
  let draftRequest;
  client.api.createLimitOrderDraft = async (url, request) => {
    draftRequest = { url, request };
    return draft;
  };
  client.server.getLatestLedger = async () => ({ sequence: 100 });
  assert.equal(await client.latestLedger(), 100);

  const order = await client.createOnchainLimitOrder({
    from: Asset.contract(draft.sell_token),
    to: Asset.contract(draft.buy_token),
    sellAmount: 1_000n,
    minBuyAmount: 900n,
    validAfterLedger: 100,
    expiresAtLedger: 200,
    allowanceExpirationLedger: 250,
  });
  assert.equal(
    draftRequest.url,
    "https://amm-api-testnet.aqua.network/api/external/v1/limit-orders",
  );
  assert.deepEqual(draftRequest.request, {
    placement_mode: "CONTRACT_ONCHAIN",
    maker: draft.maker,
    sell_token: draft.sell_token,
    sell_amount: "1000",
    buy_token: draft.buy_token,
    min_buy_amount: "900",
    valid_after_ledger: 100,
    expires_at_ledger: 200,
  });

  await assert.rejects(
    client.createOnchainLimitOrder({
      from: Asset.contract(draft.sell_token),
      to: Asset.contract(draft.buy_token),
      sellAmount: 1n << 127n,
      minBuyAmount: 900n,
      validAfterLedger: 100,
      expiresAtLedger: 200,
      allowanceExpirationLedger: 250,
    }),
    /i128/,
  );

  client.readContract = async () => nativeToScVal(0n, { type: "i128" });
  const operations = [];
  client.engine.prepare = async (_source, buildOperation) => {
    operations.push(buildOperation());
    return { toXDR: () => "unsigned-xdr" };
  };
  assert.equal(await order.buildTransaction(), "unsigned-xdr");
  const placement = operations.at(-1).body().invokeHostFunctionOp().hostFunction().invokeContract();
  assert.equal(Address.fromScAddress(placement.contractAddress()).toString(), batcher);
  assert.equal(placement.functionName().toString(), "batch");
  assert.deepEqual(
    scValToNative(placement.args()[1]).map(call => call[1]),
    ["approve", "approve", "place_contract_order"],
  );

  assert.equal(await order.buildCancelTransaction(), "unsigned-xdr");
  const cancel = operations.at(-1).body().invokeHostFunctionOp().hostFunction().invokeContract();
  assert.equal(
    Address.fromScAddress(cancel.contractAddress()).toString(),
    draft.settlement_address,
  );
  assert.equal(cancel.functionName().toString(), "cancel");

  client.engine.signAndSubmit = async () => ({ txHash: "ab".repeat(32) });
  const placementReceipt = await order.place();
  assert.deepEqual(placementReceipt, {
    orderId: draft.order_id,
    txHash: "ab".repeat(32),
  });

  const receipt = await order.cancel();
  assert.deepEqual(receipt, { orderId: draft.order_id, txHash: "ab".repeat(32) });
});
