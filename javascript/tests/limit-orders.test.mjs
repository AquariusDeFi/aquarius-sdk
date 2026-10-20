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

async function readSetting(_contract, fn) {
  return fn === "get_executor_reward" ? nativeToScVal(5_000_000n, { type: "u128" })
    : nativeToScVal(0n, { type: "i128" });
}

function validate(payload = draft, context = {}) {
  return validateOnchainLimitOrderDraft(payload, {
    expectedNetworkPassphrase: Networks.TESTNET,
    expectedSettlement: draft.settlement_address,
    expectedMaker: draft.maker,
    expectedExecutorRewardXlm: 5_000_000n,
    expectedOrder: {
      sellToken: draft.sell_token,
      sellAmount: 1_000n,
      buyToken: draft.buy_token,
      minBuyAmount: 900n,
      validAfterLedger: 100,
      expiresAtLedger: 200,
    },
    allowanceExpirationLedger: 250,
    ...context,
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

for (const reward of [5_000_001n, (1n << 127n) - 1n]) {
  test(`draft rejects a substituted reward ${reward} with consistent XDR and hash`, async () => {
    const { hash, xdr } = await import("@stellar/stellar-sdk");
    const original = xdr.ScVal.fromXDR(draft.order_xdr, "base64");
    const canonical = xdr.ScVal.scvMap(original.map.map(entry => new xdr.ScMapEntry({
      key: entry.key, val: scValToNative(entry.key) === "executor_reward_xlm"
        ? nativeToScVal(reward, { type: "u128" }) : entry.val,
    })));
    const payload = { ...draft, executor_reward_xlm: reward.toString(),
      order_xdr: canonical.toXDR("base64"),
      order_id: Buffer.from(hash(canonical.toXDR())).toString("hex") };
    assert.throws(() => validate(payload), /executor reward/);
  });
}

for (const token of [draft.sell_token, xlmToken]) {
  test(`placement does not renew an unapproved large allowance for ${token}`, () => {
    assert.throws(() => buildOnchainPlacementArgs(
      validate(), new Map([[token, (1n << 127n) - 1n]]), xlmToken,
    ), /allowance limit/);
  });
}

for (const action of ["buildTransaction", "place"]) {
  test(`${action} rechecks the reward before preparing or signing`, async () => {
    const client = new AquariusClient({
      network: "testnet",
      signer: { publicKey: () => draft.maker, sign: () => assert.fail("must not sign") },
      limitOrders: { settlement: draft.settlement_address, batcher },
    });
    client.readContract = readSetting;
    client.api.createLimitOrderDraft = async () => draft;
    const order = await client.createOnchainLimitOrder({
      expectedExecutorRewardXlm: 5_000_000n,
      from: Asset.contract(draft.sell_token), to: Asset.contract(draft.buy_token),
      sellAmount: 1000n, minBuyAmount: 900n, validAfterLedger: 100, expiresAtLedger: 200,
      allowanceExpirationLedger: 250,
    });
    client.readContract = async (_contract, fn) => fn === "get_executor_reward"
      ? nativeToScVal(5_000_001n, { type: "u128" }) : nativeToScVal(0n, { type: "i128" });
    client.engine.prepare = async () => assert.fail("must not prepare");
    client.engine.signAndSubmit = async () => assert.fail("must not submit");
    await assert.rejects(order[action](), /executor reward/);
  });
}

for (const failure of ["rpc_error", "large_allowance"]) {
  for (const action of ["buildTransaction", "place"]) {
    test(`${action} fails closed for ${failure} before signing`, async () => {
      const client = new AquariusClient({
        network: "testnet",
        signer: { publicKey: () => draft.maker, sign: () => assert.fail("must not sign") },
        limitOrders: { settlement: draft.settlement_address, batcher },
      });
      client.readContract = readSetting;
      client.api.createLimitOrderDraft = async () => draft;
      const order = await client.createOnchainLimitOrder({
        from: Asset.contract(draft.sell_token), to: Asset.contract(draft.buy_token),
        sellAmount: 1000n, minBuyAmount: 900n, validAfterLedger: 100, expiresAtLedger: 200,
        allowanceExpirationLedger: 250, expectedExecutorRewardXlm: 5_000_000n,
      });
      client.readContract = async (_contract, fn) => {
        if (failure === "rpc_error") throw new AquariusError("fixture RPC unavailable");
        return fn === "get_executor_reward" ? nativeToScVal(5_000_000n, { type: "u128" })
          : nativeToScVal((1n << 127n) - 1n, { type: "i128" });
      };
      client.engine.prepare = async () => assert.fail("must not prepare");
      client.engine.signAndSubmit = async () => assert.fail("must not submit");
      await assert.rejects(order[action](), /RPC unavailable|allowance limit/);
    });
  }
}

test("client checks the approved reward before requesting a draft", async () => {
  const client = new AquariusClient({
    network: "testnet", signer: { publicKey: () => draft.maker, sign: value => value },
    limitOrders: { settlement: draft.settlement_address, batcher },
  });
  client.readContract = readSetting;
  client.api.createLimitOrderDraft = async () => assert.fail("must not request a draft");
  await assert.rejects(client.createOnchainLimitOrder({
    from: Asset.contract(draft.sell_token), to: Asset.contract(draft.buy_token),
    sellAmount: 1000n, minBuyAmount: 900n, validAfterLedger: 100, expiresAtLedger: 200,
    allowanceExpirationLedger: 250, expectedExecutorRewardXlm: 5_000_001n,
  }), /executor reward changed/);
});

for (const limit of [0n, -1n, true, 1.5, 1n << 127n, 999n]) {
  test(`placement rejects an invalid or insufficient allowance limit ${limit}`, () => {
    const order = validate(draft, { maxAllowances: new Map([[draft.sell_token, limit]]) });
    assert.throws(() => buildOnchainPlacementArgs(order, new Map(), xlmToken), /allowance limit/);
  });
}

test("allowance limits are copied before the caller mutates the input map", () => {
  const limits = new Map([[xlmToken, 5_000_000n]]);
  const order = validate(draft, { maxAllowances: limits });
  limits.set(xlmToken, (1n << 127n) - 1n);
  assert.throws(() => buildOnchainPlacementArgs(
    order, new Map([[xlmToken, 5_000_001n]]), xlmToken,
  ), /allowance limit/);
});

test("native sale rejects a combined amount overflow", () => {
  const order = validate();
  const overflowing = new OnchainLimitOrder(
    order.orderId, order.settlementAddress, order.maker, xlmToken, (1n << 127n) - 1n,
    order.buyToken, order.minBuyAmount, order.validAfterLedger, order.expiresAtLedger,
    order.allowanceExpirationLedger, order.executorRewardXlm, order.orderScVal,
  );
  assert.throws(() => buildOnchainPlacementArgs(overflowing, new Map(), xlmToken), /i128/);
});

function withReceiveAsset(order, buyAsset, networkPassphrase = Networks.TESTNET, buyToken = order.buyToken) {
  return new OnchainLimitOrder(
    order.orderId, order.settlementAddress, order.maker, order.sellToken, order.sellAmount,
    buyToken, order.minBuyAmount, order.validAfterLedger, order.expiresAtLedger,
    order.allowanceExpirationLedger, order.executorRewardXlm, order.orderScVal, undefined,
    buyAsset, networkPassphrase,
  );
}

test("on-chain auto-trust shares the existing placement transaction", () => {
  const order = validate();
  const asset = Asset.classic("USD", StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 6)));
  const buyToken = asset.contractId(Networks.TESTNET);
  const automatic = withReceiveAsset(order, asset, Networks.TESTNET, buyToken);
  const calls = scValToNative(buildOnchainPlacementArgs(automatic, new Map(), xlmToken)[1]);
  assert.deepEqual(calls[0], [buyToken, "trust", [draft.maker]]);
  assert.equal(calls.length, scValToNative(buildOnchainPlacementArgs(order, new Map(), xlmToken)[1]).length + 1);
  assert.equal(automatic.orderId, order.orderId);
});

for (const [name, asset] of [
  ["unknown", undefined],
  ["pure Soroban", Asset.contract(draft.buy_token)],
  ["native", Asset.native()],
]) {
  test(`on-chain auto-trust skips ${name} receive assets`, () => {
    const legacy = validate();
    const automatic = withReceiveAsset(legacy, asset);
    assert.deepEqual(
      buildOnchainPlacementArgs(automatic, new Map(), xlmToken).map(arg => arg.toXDR("base64")),
      buildOnchainPlacementArgs(legacy, new Map(), xlmToken).map(arg => arg.toXDR("base64")),
    );
  });
}

for (const [name, passphrase, useClassicToken] of [
  ["missing network", null, true],
  ["wrong network", Networks.PUBLIC, true],
  ["different token", Networks.TESTNET, false],
]) {
  test(`on-chain auto-trust rejects classic metadata with ${name}`, () => {
    const asset = Asset.classic("USD", StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 6)));
    const order = validate();
    const automatic = withReceiveAsset(order, asset, passphrase,
      useClassicToken ? asset.contractId(Networks.TESTNET) : order.buyToken);
    assert.throws(() => buildOnchainPlacementArgs(automatic, new Map(), xlmToken), /classic receive asset/);
  });
}

test("on-chain trust is not optional for a classic receive asset issuer", () => {
  const asset = Asset.classic("USD", draft.maker);
  const order = withReceiveAsset(validate(), asset, Networks.TESTNET, asset.contractId(Networks.TESTNET));
  const calls = scValToNative(buildOnchainPlacementArgs(order, new Map(), xlmToken)[1]);
  assert.deepEqual(calls[0], [order.buyToken, "trust", [order.maker]]);
});

test("client preserves classic receive metadata for the placement builder", async () => {
  const { hash, xdr } = await import("@stellar/stellar-sdk");
  const asset = Asset.classic("USD", StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 6)));
  const buyToken = asset.contractId(Networks.TESTNET);
  const orderScVal = xdr.ScVal.fromXDR(draft.order_xdr, "base64");
  const canonical = xdr.ScVal.scvMap(orderScVal.map.map(entry => new xdr.ScMapEntry({
    key: entry.key,
    val: scValToNative(entry.key) === "buy_token" ? new Address(buyToken).toScVal() : entry.val,
  })));
  const payload = { ...draft, buy_token: buyToken, order_xdr: canonical.toXDR("base64"),
    order_id: Buffer.from(hash(canonical.toXDR())).toString("hex") };
  const client = new AquariusClient({
    network: "testnet", signer: { publicKey: () => draft.maker, sign: value => value },
    limitOrders: { settlement: draft.settlement_address, batcher },
  });
  client.readContract = readSetting;
  client.api.createLimitOrderDraft = async () => payload;
  const order = await client.createOnchainLimitOrder({
    expectedExecutorRewardXlm: 5_000_000n,
    from: Asset.contract(draft.sell_token), to: asset, sellAmount: 1_000n,
    minBuyAmount: 900n, validAfterLedger: 100, expiresAtLedger: 200,
    allowanceExpirationLedger: 250,
  });
  const calls = scValToNative(buildOnchainPlacementArgs(order, new Map(), xlmToken)[1]);
  assert.deepEqual(calls[0], [buyToken, "trust", [draft.maker]]);
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
      expectedExecutorRewardXlm: 5_000_000n,
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
  const order = validate(draft, { maxAllowances: new Map([[draft.sell_token, 1_500n]]) });
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
    original.orderScVal, undefined, undefined, undefined,
    new Map([[xlmToken, 6_000_000n]]),
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
  client.readContract = readSetting;
  client.api.createLimitOrderDraft = async (url, request) => {
    draftRequest = { url, request };
    return draft;
  };
  client.server.getLatestLedger = async () => ({ sequence: 100 });
  assert.equal(await client.latestLedger(), 100);

  const order = await client.createOnchainLimitOrder({
    expectedExecutorRewardXlm: 5_000_000n,
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
      expectedExecutorRewardXlm: 5_000_000n,
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

  client.readContract = readSetting;
  const operations = [];
  client.engine.prepare = async (_source, buildOperation) => {
    operations.push(buildOperation());
    return { toXDR: () => "unsigned-xdr" };
  };
  assert.equal(await order.buildTransaction(), "unsigned-xdr");
  const placement = operations.at(-1).body.invokeHostFunctionOp.hostFunction.invokeContract;
  assert.equal(Address.fromScAddress(placement.contractAddress).toString(), batcher);
  assert.equal(placement.functionName.toString(), "batch");
  assert.deepEqual(
    scValToNative(placement.args[1]).map(call => call[1]),
    ["approve", "approve", "place_contract_order"],
  );
  const placementAuth = operations.at(-1).body.invokeHostFunctionOp.auth[0];
  assert.deepEqual(placementAuth.rootInvocation.subInvocations.at(-1).function.contractFn.args
    .map(scValToNative), [Buffer.from(order.orderId, "hex"), order.expiresAtLedger]);

  assert.equal(await order.buildCancelTransaction(), "unsigned-xdr");
  const cancel = operations.at(-1).body.invokeHostFunctionOp.hostFunction.invokeContract;
  assert.equal(
    Address.fromScAddress(cancel.contractAddress).toString(),
    draft.settlement_address,
  );
  assert.equal(cancel.functionName.toString(), "cancel");

  client.engine.signAndSubmit = async () => ({ txHash: "ab".repeat(32) });
  const placementReceipt = await order.place();
  assert.deepEqual(placementReceipt, {
    orderId: draft.order_id,
    txHash: "ab".repeat(32),
  });

  const receipt = await order.cancel();
  assert.deepEqual(receipt, { orderId: draft.order_id, txHash: "ab".repeat(32) });
});

test("unsigned placement and cancellation require restore without signing", async () => {
  const { Account, SorobanDataBuilder } = await import("@stellar/stellar-sdk");
  const { RestoreRequiredError } = await import("../dist/index.js");
  const client = new AquariusClient({
    network: "testnet",
    signer: { publicKey: () => draft.maker, sign: () => { throw new Error("unsigned builder must not sign"); } },
    limitOrders: { settlement: draft.settlement_address, batcher },
  });
  client.readContract = readSetting;
  client.api.createLimitOrderDraft = async () => draft;
  const order = await client.createOnchainLimitOrder({
    expectedExecutorRewardXlm: 5_000_000n,
    from: Asset.contract(draft.sell_token), to: Asset.contract(draft.buy_token),
    sellAmount: 1000n, minBuyAmount: 900n, validAfterLedger: 100,
    expiresAtLedger: 200, allowanceExpirationLedger: 250,
  });
  client.readContract = readSetting;
  client.server.getAccount = async source => new Account(source, "42");
  const data = new SorobanDataBuilder();
  client.server.simulateTransaction = async () => ({
    _parsed: true, latestLedger: 100, transactionData: data,
    minResourceFee: "17", events: [],
    restorePreamble: { transactionData: data, minResourceFee: "17" },
    result: { auth: [], retval: nativeToScVal(null) },
  });
  client.engine.signAndSubmit = async () => { throw new Error("unsigned builder must not submit"); };
  await assert.rejects(order.buildTransaction(), RestoreRequiredError);
  await assert.rejects(order.buildCancelTransaction(), RestoreRequiredError);
});

for (const [field, value, encoded, message] of [
  ["version", 2, nativeToScVal(2, { type: "u32" }), /version/],
  ["salt", "78", nativeToScVal(Buffer.from("x")), /salt/],
  ["executor_reward_xlm", "0", nativeToScVal(0n, { type: "u128" }), /amounts/],
  ["sell_amount", "1000", nativeToScVal(1000n, { type: "u64" }), /canonical OrderV1/],
]) {
  test(`draft rejects invalid ${field} even with matching JSON and XDR`, async () => {
    const { xdr, hash } = await import("@stellar/stellar-sdk");
    const order = xdr.ScVal.fromXDR(draft.order_xdr, "base64");
    const changed = xdr.ScVal.scvMap(order.map.map(entry => new xdr.ScMapEntry({
      key: entry.key, val: scValToNative(entry.key) === field ? encoded : entry.val,
    })));
    const payload = { ...draft, [field]: value,
      order_xdr: Buffer.from(changed.toXDR()).toString("base64"),
      order_id: Buffer.from(hash(changed.toXDR())).toString("hex"),
    };
    assert.throws(() => validate(payload), message);
  });
}

test("placement authorization matches the shared canonical wire vector", async () => {
  const { authorizedInvocation, sourceAccountEntry } = await import("../dist/index.js");
  const vectors = JSON.parse(readFileSync(new URL("../../testdata/limit_order_vectors.json", import.meta.url), "utf8"));
  const args = buildOnchainPlacementArgs(validate(), new Map(), xlmToken);
  const calls = args[1].vec.map(call => {
    const [target, name, parameters] = call.vec;
    const functionName = scValToNative(name);
    return authorizedInvocation(scValToNative(target), functionName,
      functionName === "place_contract_order" ? parameters.vec.slice(1) : parameters.vec);
  });
  const auth = sourceAccountEntry(authorizedInvocation(batcher, "batch", args, calls));
  assert.deepEqual(args.map(value => Buffer.from(value.toXDR()).toString("base64")), vectors.placement_args_xdr);
  assert.equal(Buffer.from(auth.toXDR()).toString("base64"), vectors.placement_auth_xdr);
});
