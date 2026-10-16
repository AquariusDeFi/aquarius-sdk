import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  Address,
  Networks,
  StrKey,
  nativeToScVal,
  scValToNative,
  xdr,
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
// Mainnet's maxEntryTtl: a network max TTL of 3,110,399 ledgers.
const MAX_ENTRY_TTL = 3_110_400;

function archivalSettings(maxEntryTtl) {
  const settings = new xdr.StateArchivalSettings({
    maxEntryTtl,
    minTemporaryTtl: 17_280,
    minPersistentTtl: 2_073_600,
    persistentRentRateDenominator: xdr.Int64.fromString("1215"),
    tempRentRateDenominator: xdr.Int64.fromString("2430"),
    maxEntriesToArchive: 1_000,
    liveSorobanStateSizeWindowSampleSize: 30,
    liveSorobanStateSizeWindowSamplePeriod: 64,
    evictionScanSize: 100_000,
    startingEvictionScanLevel: 7,
  });
  const val = xdr.LedgerEntryData.configSetting(
    xdr.ConfigSettingEntry.configSettingStateArchival(settings),
  );
  return { entries: [{ val }], latestLedger: 100 };
}

function onNetwork(client, { currentLedger = 100, maxEntryTtl = MAX_ENTRY_TTL } = {}) {
  client.ledgerEntryReads = [];
  client.server.getHealth = async () => ({ latestLedger: currentLedger });
  client.server.getLedgerEntries = async (...keys) => {
    client.ledgerEntryReads.push(keys);
    return archivalSettings(maxEntryTtl);
  };
  client.networkMaxTtlCache = undefined;
  return client;
}

// Answers get_executor_reward from the configured settlement with
// `client.settlementReward` (tests change it as the Admin would); other reads
// return `allowance`, or go through the RPC when it is undefined.
function settlementReads(client, { executorReward = 5_000_000n, allowance } = {}) {
  const read = client.readContract.bind(client);
  client.rewardReads = 0;
  client.settlementReward = executorReward;
  client.readContract = async (contractId, fn, args) => {
    if (fn === "get_executor_reward") {
      assert.equal(contractId, draft.settlement_address);
      client.rewardReads += 1;
      return nativeToScVal(client.settlementReward, { type: "u128" });
    }
    return allowance === undefined
      ? read(contractId, fn, args)
      : nativeToScVal(allowance, { type: "i128" });
  };
  client.executorRewardCache = undefined;
  return client;
}

function onchainClient() {
  return settlementReads(new AquariusClient({
    network: "testnet",
    signer: { publicKey: () => draft.maker, sign: value => value },
    limitOrders: { settlement: draft.settlement_address, batcher },
  }), { allowance: 0n });
}

function create(client, overrides = {}) {
  return client.createOnchainLimitOrder({
    from: Asset.contract(draft.sell_token),
    to: Asset.contract(draft.buy_token),
    sellAmount: 1_000n,
    minBuyAmount: 900n,
    validAfterLedger: 100,
    expiresAtLedger: 200,
    allowanceExpirationLedger: 250,
    ...overrides,
  });
}

function validate(payload = draft, maxLiveUntilLedger = 250, executorReward = 5_000_000n) {
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
    maxLiveUntilLedger,
    expectedExecutorRewardXlm: executorReward,
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
      maxLiveUntilLedger: 250,
      expectedExecutorRewardXlm: 5_000_000n,
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
  settlementReads(onNetwork(client), { allowance: 0n });
  client.server.getLatestLedger = async () => assert.fail("getLatestLedger");
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

  settlementReads(client, { allowance: 0n });
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

test("network max TTL is maxEntryTtl minus one and cached", async () => {
  const client = onNetwork(onchainClient());
  assert.equal(await client.networkMaxTtl(), 3_110_399);
  assert.equal(await client.networkMaxTtl(), 3_110_399);
  assert.equal(client.ledgerEntryReads.length, 1);
  const [[key]] = client.ledgerEntryReads;
  assert.equal(key.configSetting.configSettingId.name, "configSettingStateArchival");
});

test("draft lifetime is capped at current ledger plus network max TTL", async () => {
  // current ledger 100 and max TTL 150: nothing may expire after ledger 250
  const client = onNetwork(onchainClient(), { currentLedger: 100, maxEntryTtl: 151 });
  let draftRequests = 0;
  client.api.createLimitOrderDraft = async () => {
    draftRequests += 1;
    return draft;
  };
  assert.equal((await create(client)).orderId, draft.order_id);

  await assert.rejects(
    create(client, { expiresAtLedger: 251, allowanceExpirationLedger: 251 }),
    /limit-order expiration ledger 251 is beyond the network limit 250/,
  );
  await assert.rejects(
    create(client, { validAfterLedger: 200, expiresAtLedger: 251, allowanceExpirationLedger: 251 }),
    /limit-order expiration ledger 251/,
  );
  await assert.rejects(
    create(client, { allowanceExpirationLedger: 251 }),
    /allowance expiration ledger 251 is beyond the network limit 250/,
  );
  assert.equal(draftRequests, 1);
});

test("draft validation rejects lifetimes beyond the given network limit", () => {
  assert.equal(validate(draft, 250).allowanceExpirationLedger, 250);
  assert.throws(() => validate(draft, 249), /allowance expiration ledger 250/);
  assert.throws(() => validate(draft, 199), /limit-order expiration ledger 200/);
  assert.throws(() => validate(draft, null), /maxLiveUntilLedger/);
});

test("placement rechecks the network limit before building", async () => {
  const client = onNetwork(onchainClient(), { currentLedger: 100, maxEntryTtl: 151 });
  client.api.createLimitOrderDraft = async () => draft;
  const order = await create(client);
  onNetwork(client, { currentLedger: 100, maxEntryTtl: 150 });
  client.readContract = async () => assert.fail("must not read allowances");
  client.engine.prepare = async () => assert.fail("must not build");
  client.engine.signAndSubmit = async () => assert.fail("must not submit");
  for (const build of [() => order.buildTransaction(), () => order.place()]) {
    await assert.rejects(
      build(),
      /allowance expiration ledger 250 is beyond the network limit 249/,
    );
  }
});

for (const [name, read] of [
  ["no config entry", async () => ({ entries: [], latestLedger: 100 })],
  ["an RPC error", async () => { throw new Error("rpc unavailable"); }],
]) {
  test(`network limit read failure fails closed on ${name}`, async () => {
    const client = onNetwork(onchainClient());
    client.server.getLedgerEntries = read;
    client.api.createLimitOrderDraft = async () => assert.fail("must not request a draft");
    await assert.rejects(create(client), /STATE_ARCHIVAL|rpc unavailable/);
  });
}

test("draft executor reward must match the settlement contract", async () => {
  const client = onNetwork(onchainClient());
  client.api.createLimitOrderDraft = async () => draft;
  assert.equal((await create(client)).executorRewardXlm, 5_000_000n);
  assert.equal((await create(client)).executorRewardXlm, 5_000_000n);
  assert.equal(client.rewardReads, 1);

  settlementReads(client, { executorReward: 4_000_000n });
  await assert.rejects(
    create(client),
    /executor reward 5000000 does not match the settlement contract's 4000000/,
  );

  assert.throws(() => validate(draft, 250, 4_999_999n), /executor reward 5000000 does not match/);
  assert.throws(() => validate(draft, 250, null), /expectedExecutorRewardXlm/);
});

test("placement rejects an inflated reward and approves the verified one", async () => {
  const client = onNetwork(onchainClient());
  client.api.createLimitOrderDraft = async () => draft;
  const verified = await create(client);
  const inflated = new OnchainLimitOrder(
    verified.orderId, verified.settlementAddress, verified.maker,
    verified.sellToken, verified.sellAmount, verified.buyToken, verified.minBuyAmount,
    verified.validAfterLedger, verified.expiresAtLedger, verified.allowanceExpirationLedger,
    50_000_000n, verified.orderScVal, client.onchainLimitOrderActions(),
  );
  client.engine.prepare = async () => assert.fail("must not build");
  client.engine.signAndSubmit = async () => assert.fail("must not submit");
  for (const build of [() => inflated.buildTransaction(), () => inflated.place()]) {
    await assert.rejects(
      build(),
      /executor reward 50000000 does not match the settlement contract's 5000000/,
    );
  }

  const operations = [];
  client.engine.prepare = async (_source, buildOperation) => {
    operations.push(buildOperation());
    return { toXDR: () => "unsigned-xdr" };
  };
  assert.equal(await verified.buildTransaction(), "unsigned-xdr");
  const placement = operations.at(-1).body.invokeHostFunctionOp.hostFunction.invokeContract;
  assert.deepEqual(scValToNative(placement.args[1])[1], [
    Asset.native().contractId(Networks.TESTNET),
    "approve",
    [draft.maker, draft.settlement_address, 5_000_000n, 250],
  ]);
});

test("executor reward cache expires after ten minutes", async t => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const client = onchainClient();
  assert.equal(await client.limitOrderExecutorReward(), 5_000_000n);
  client.settlementReward = 4_000_000n;
  now += 599_999;
  assert.equal(await client.limitOrderExecutorReward(), 5_000_000n);
  now += 1;
  assert.equal(await client.limitOrderExecutorReward(), 4_000_000n);
});

test("placement reads the executor reward fresh", async () => {
  const client = onNetwork(onchainClient());
  client.api.createLimitOrderDraft = async () => draft;
  const order = await create(client);
  client.settlementReward = 4_000_000n;
  client.engine.prepare = async () => assert.fail("must not build");
  await assert.rejects(order.buildTransaction(), /settlement contract's 4000000/);
});

test("draft mismatch re-reads a stale cached reward", async () => {
  const client = onNetwork(onchainClient());
  client.settlementReward = 4_000_000n;
  assert.equal(await client.limitOrderExecutorReward(), 4_000_000n);
  client.settlementReward = 5_000_000n;
  client.api.createLimitOrderDraft = async () => draft;
  assert.equal((await create(client)).executorRewardXlm, 5_000_000n);
  assert.equal(client.rewardReads, 2);
});

for (const [name, read, message] of [
  ["a failed read", async () => { throw new AquariusError("simulation failed"); }, /simulation failed/],
  ["a non-u128 value", async () => nativeToScVal(5_000_000n, { type: "i128" }), /invalid value/],
]) {
  test(`executor reward read fails closed on ${name}`, async () => {
    const client = onNetwork(onchainClient());
    client.readContract = read;
    client.api.createLimitOrderDraft = async () => assert.fail("must not request a draft");
    await assert.rejects(create(client), message);
  });
}

test("unsigned placement and cancellation require restore without signing", async () => {
  const { Account, SorobanDataBuilder } = await import("@stellar/stellar-sdk");
  const { RestoreRequiredError } = await import("../dist/index.js");
  const client = new AquariusClient({
    network: "testnet",
    signer: { publicKey: () => draft.maker, sign: () => { throw new Error("unsigned builder must not sign"); } },
    limitOrders: { settlement: draft.settlement_address, batcher },
  });
  settlementReads(onNetwork(client));
  client.api.createLimitOrderDraft = async () => draft;
  const order = await client.createOnchainLimitOrder({
    from: Asset.contract(draft.sell_token), to: Asset.contract(draft.buy_token),
    sellAmount: 1000n, minBuyAmount: 900n, validAfterLedger: 100,
    expiresAtLedger: 200, allowanceExpirationLedger: 250,
  });
  settlementReads(client, { allowance: 0n });
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
    return authorizedInvocation(scValToNative(target), scValToNative(name), parameters.vec);
  });
  const auth = sourceAccountEntry(authorizedInvocation(batcher, "batch", args, calls));
  assert.deepEqual(args.map(value => Buffer.from(value.toXDR()).toString("base64")), vectors.placement_args_xdr);
  assert.equal(Buffer.from(auth.toXDR()).toString("base64"), vectors.placement_auth_xdr);
});
