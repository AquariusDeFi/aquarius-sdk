import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, mock } from "node:test";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  hash,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import {
  ApiClient,
  Asset,
  AquariusClient,
  LimitOrderManager,
  LimitOrderRecord,
  LIMIT_ORDER_MAX_TTL_LEDGERS,
  LIMIT_ORDER_MAX_DURATION_SECONDS,
} from "../dist/index.js";
const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`../../testdata/limit_order_${name}.json`, import.meta.url), "utf8"),
  );
const detached = fixture("auto_trust");
const onchain = fixture("onchain_draft");
function onchainDraft(request) {
  const raw = { ...onchain, ...request };
  const order = xdr.ScVal.fromXDR(onchain.order_xdr, "base64");
  const fields = order.map.map((field) => {
    const name = field.key.sym.toString();
    if (!(name in request)) return field;
    const value = request[name];
    const val =
      name === "placement_mode"
        ? field.val
        : name.endsWith("_token") || name === "maker"
          ? new Address(value).toScVal()
          : name.endsWith("_amount")
            ? nativeToScVal(BigInt(value), { type: "u128" })
            : xdr.ScVal.scvU32(value);
    return new xdr.ScMapEntry({ key: field.key, val });
  });
  const canonical = xdr.ScVal.scvMap(fields);
  return {
    ...raw,
    order_xdr: canonical.toXDR("base64"),
    order_id: Buffer.from(hash(canonical.toXDR())).toString("hex"),
  };
}
function setup(mode = "authorization") {
  const vector = mode === "authorization" ? detached : onchain;
  const params = {
    from: Asset.contract(vector.sell_token),
    to:
      mode === "authorization"
        ? Asset.classic(detached.buy_code, detached.buy_issuer)
        : Asset.contract(vector.buy_token),
    sellAmount: 1000n,
    minBuyAmount: 900n,
    expiresIn: 500,
  };
  const wallet = {
    publicKey: () => vector.maker,
    sign: mock.fn(() => {
      throw new Error("unexpected transaction signature");
    }),
  };
  if (mode === "authorization")
    wallet.signAuthEntry = mock.fn(async () => vector.authorization_xdr);
  const account = {
    balances: [],
    signers: [{ key: vector.maker, type: "ed25519_public_key", weight: 1 }],
    thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 },
  };
  const api = {
    createLimitOrderDraft: mock.fn(async (_, request) =>
      request.placement_mode === "CONTRACT_ONCHAIN"
        ? onchainDraft(request)
        : { ...detached, status: "DRAFT", authorization_xdr: undefined },
    ),
    authorizeLimitOrder: mock.fn(async () => ({ ...detached, status: "OPEN" })),
    listLimitOrders: mock.fn(async () => ({ orders: [], next_cursor: null })),
  };
  const submit = mock.fn(async (raw) => ({
    status: "confirmed",
    transactionHash: Buffer.from(new Transaction(raw, Networks.TESTNET).hash()).toString("hex"),
    ledger: 105,
    createdAt: 1000,
  }));
  const cancel = mock.fn(async () => ({ orderId: vector.order_id, txHash: "ab".repeat(32) }));
  const context = {
    passphrase: Networks.TESTNET,
    settlement: vector.settlement_address,
    apiUrl: "https://registry.test/",
    api,
    signer: wallet,
    server: { getLatestLedger: mock.fn(async () => ({ sequence: 100 })) },
    loadAccount: mock.fn(async (maker) =>
      maker === vector.maker ? account : { ...account, flags: { auth_required: false } },
    ),
    createSubmitter: () => submit,
    recordActions: {
      cancelLimitOrder: cancel,
      buildLimitOrderCancel: mock.fn(async () => "cancel-xdr"),
    },
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
    executorRewardXlm: "5000000",
  }));
  manager.buildPlacementTransaction = mock.fn(async () =>
    new TransactionBuilder(new Account(vector.maker, "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.manageData({ name: "test", value: "order" }))
      .setTimeout(300)
      .build()
      .toXDR(),
  );
  return { manager, params, api, context, account, wallet, submit, cancel };
}
const record = (status) => ({
  ...onchain,
  status,
  placement_ledger: 101,
  placement_transaction_hash: "ab".repeat(32),
});

test("prepare resolves fee, ledger, wallet capability and missing receive trustline before signing", async () => {
  const { manager, params, api, wallet } = setup();
  const prepared = await manager.prepare(params);
  assert.equal(prepared.summary.signing, "authorization");
  assert.deepEqual(prepared.summary.trustline, { required: true, creation: "execution" });
  assert.equal(prepared.summary.executorRewardXlm, 5000000n);
  assert.equal(prepared.summary.expiresAtLedger, 200);
  assert.equal(wallet.signAuthEntry.mock.callCount(), 0);
  assert.equal(api.authorizeLimitOrder.mock.callCount(), 0);
  assert.equal(api.createLimitOrderDraft.mock.calls[0].arguments[1].placement_mode, "DETACHED");
});

test("prepare freezes caller intent, review summary and canonical draft", async () => {
  const { manager, params } = setup();
  const promise = manager.prepare(params);
  params.sellAmount = 1n;
  params.to.code = "FAKE";
  params.expiresIn = 1;
  const prepared = await promise;
  assert.equal(prepared.summary.sellAmount, 1000n);
  assert.equal(prepared.summary.expiresAtLedger, 200);
  assert.throws(() => {
    prepared.summary.trustline.required = false;
  });
  const raw = prepared.raw;
  raw.unsigned_authorization_xdr = "changed";
  assert.equal(prepared.authorizationEntryXdr, detached.unsigned_authorization_xdr);
});

test("place signs once, publishes a verified proof and returns the existing bound order type", async () => {
  const { manager, params, wallet, api, cancel } = setup();
  const prepared = await manager.prepare(params);
  const [first, second] = await Promise.all([prepared.place(), prepared.place()]);
  assert.ok(first instanceof LimitOrderRecord);
  assert.equal(first, second);
  assert.equal(first.order.sellAmount, 1000n);
  assert.equal(wallet.signAuthEntry.mock.callCount(), 1);
  assert.equal(api.authorizeLimitOrder.mock.callCount(), 1);
  await first.cancel();
  assert.equal(cancel.mock.callCount(), 1);
  assert.equal(await first.buildCancelTransaction(), "cancel-xdr");
  assert.equal(await prepared.place(), first);
});

test("lost registry response retries the same authorization without creating or signing another order", async () => {
  const { manager, params, wallet, api } = setup();
  const prepared = await manager.prepare(params);
  api.authorizeLimitOrder.mock.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  await assert.rejects(prepared.place(), /offline/);
  await prepared.place();
  assert.equal(api.createLimitOrderDraft.mock.callCount(), 1);
  assert.equal(wallet.signAuthEntry.mock.callCount(), 1);
  assert.deepEqual(
    api.authorizeLimitOrder.mock.calls[0].arguments,
    api.authorizeLimitOrder.mock.calls[1].arguments,
  );
});

test("wallet rejection never falls back to a paid transaction", async () => {
  const { manager, params, wallet, submit } = setup();
  wallet.signAuthEntry.mock.mockImplementation(async () => {
    throw new Error("rejected");
  });
  const prepared = await manager.prepare(params);
  await assert.rejects(prepared.place(), /rejected/);
  assert.equal(manager.buildPlacementTransaction.mock.callCount(), 0);
  assert.equal(submit.mock.callCount(), 0);
});

test("a transaction-only signer uses the same prepare/place API", async () => {
  const { manager, params, api, submit } = setup("transaction");
  const prepared = await manager.prepare(params);
  assert.equal(prepared.summary.signing, "transaction");
  const order = await prepared.place();
  assert.ok(order instanceof LimitOrderRecord);
  assert.equal(order.status, "OPEN");
  assert.equal(order.placementLedger, 105);
  assert.equal(api.authorizeLimitOrder.mock.callCount(), 0);
  assert.equal(submit.mock.callCount(), 1);
});

test("multisig automatically uses transaction placement even when the wallet can sign auth", async () => {
  const { manager, params, account, wallet } = setup("transaction");
  wallet.signAuthEntry = mock.fn();
  account.signers.push({
    key: Keypair.random().publicKey(),
    type: "ed25519_public_key",
    weight: 1,
  });
  account.thresholds.med_threshold = 2;
  const prepared = await manager.prepare(params);
  assert.equal(prepared.summary.signing, "transaction");
  await prepared.place();
  assert.equal(wallet.signAuthEntry.mock.callCount(), 0);
});

test("missing trustline is added at placement for transaction-only wallets", async () => {
  const { manager, params } = setup("transaction");
  params.to = Asset.classic(detached.buy_code, detached.buy_issuer);
  const prepared = await manager.prepare(params);
  assert.deepEqual(prepared.summary.trustline, { required: true, creation: "placement" });
  await prepared.place();
  assert.equal(manager.buildPlacementTransaction.mock.calls[0].arguments[2], true);
});

test("existing, native, issuer-owned and Soroban receive assets require no new trustline", async () => {
  for (const kind of ["existing", "native", "issuer", "soroban"]) {
    const { manager, params, account, context } = setup("transaction");
    if (kind === "existing") {
      params.to = Asset.classic(detached.buy_code, detached.buy_issuer);
      account.balances = [
        { asset_code: detached.buy_code, asset_issuer: detached.buy_issuer, is_authorized: true },
      ];
    }
    if (kind === "native") params.to = Asset.native();
    if (kind === "issuer") params.to = Asset.classic("OWN", context.signer.publicKey());
    const prepared = await manager.prepare(params);
    assert.equal(prepared.summary.trustline.required, false, kind);
  }
});

test("issuer restrictions are checked before drafting", async () => {
  const { manager, params, context, account, api } = setup();
  context.loadAccount.mock.mockImplementation(async (maker) =>
    maker === detached.maker ? account : { ...account, flags: { auth_required: true } },
  );
  await assert.rejects(manager.prepare(params), /issuer authorization/);
  assert.equal(api.createLimitOrderDraft.mock.callCount(), 0);
});

test("fee, account, signing policy and trustline changes after review stop before signing", async () => {
  for (const change of ["fee", "account", "signers", "expiry", "trustline"]) {
    const { manager, params, context, wallet, account } = setup();
    if (change === "trustline")
      account.balances = [{ asset_code: detached.buy_code, asset_issuer: detached.buy_issuer }];
    const prepared = await manager.prepare(params);
    if (change === "fee")
      manager.getSettlementConfig.mock.mockImplementation(async () => ({
        maxOrderTtl: 1000,
        executorRewardXlm: "6000000",
      }));
    if (change === "account") wallet.publicKey = () => Keypair.random().publicKey();
    if (change === "signers") account.thresholds.med_threshold = 2;
    if (change === "expiry")
      context.server.getLatestLedger.mock.mockImplementation(async () => ({ sequence: 201 }));
    if (change === "trustline") account.balances = [];
    await assert.rejects(prepared.place(), /changed|expiry/);
    assert.equal(wallet.signAuthEntry.mock.callCount(), 0, change);
  }
});

for (const mode of ["authorization", "transaction"]) {
  test(`${mode} rejects more than six months before network or wallet interaction`, async () => {
    const { manager, params, api, context, wallet, submit } = setup(mode);
    assert.equal(LIMIT_ORDER_MAX_DURATION_SECONDS, 180 * 86400);
    for (const expiresIn of [LIMIT_ORDER_MAX_DURATION_SECONDS + 1, 181 * 86400]) {
      await assert.rejects(manager.prepare({ ...params, expiresIn }), /cannot exceed 6 months/);
    }
    assert.equal(manager.getSettlementConfig.mock.callCount(), 0);
    assert.equal(context.server.getLatestLedger.mock.callCount(), 0);
    assert.equal(context.loadAccount.mock.callCount(), 0);
    assert.equal(api.createLimitOrderDraft.mock.callCount(), 0);
    assert.equal(wallet.sign.mock.callCount(), 0);
    assert.equal(wallet.signAuthEntry?.mock.callCount() ?? 0, 0);
    assert.equal(submit.mock.callCount(), 0);
  });
}

test("expiry supports six months but never exceeds the settlement or allowance cap", async () => {
  const { manager, params } = setup("transaction");
  manager.getSettlementConfig.mock.mockImplementation(async () => ({
    maxOrderTtl: 6307200,
    executorRewardXlm: "5000000",
  }));
  const prepared = await manager.prepare({ ...params, expiresIn: 180 * 86400 });
  assert.equal(
    prepared.summary.expiresAtLedger - prepared.summary.validAfterLedger,
    LIMIT_ORDER_MAX_TTL_LEDGERS,
  );
  for (const expiresIn of [0, -1, Infinity, 1.2, 181 * 86400])
    await assert.rejects(manager.prepare({ ...params, expiresIn }), /expiry/);
  manager.getSettlementConfig.mock.mockImplementation(async () => ({
    maxOrderTtl: 10,
    executorRewardXlm: "5000000",
  }));
  await assert.rejects(manager.prepare(params), /expiry/);
});

test("custom Vault transport reports pending and reuses the same prepared transaction on retry", async () => {
  const { manager, params, submit } = setup("transaction");
  const prepared = await manager.prepare(params);
  const transport = mock.fn(async (raw) => ({
    status: "pending",
    transactionHash: Buffer.from(new Transaction(raw, Networks.TESTNET).hash()).toString("hex"),
  }));
  const first = await prepared.place({ submitTransaction: transport });
  assert.equal(first.status, "PENDING_SIGNATURES");
  assert.equal(first.draft.order_id, prepared.orderId);
  const order = await prepared.place({ submitTransaction: submit });
  assert.equal(order.orderId, prepared.orderId);
  assert.equal(manager.buildPlacementTransaction.mock.callCount(), 1);
});

test("confirmed placement accepts numeric and RPC string timestamps without resubmitting", async () => {
  for (const createdAt of [1793782319, "1793782319"]) {
    const { manager, params, submit } = setup("transaction");
    const prepared = await manager.prepare(params);
    const transport = mock.fn(async (raw) => ({ ...(await submit(raw)), createdAt }));
    const order = await prepared.place({ submitTransaction: transport });
    assert.equal(order.status, "OPEN");
    assert.equal(order.placementLedger, 105);
    assert.equal(order.raw.updated_at, new Date(1793782319 * 1000).toISOString());
    assert.equal(await prepared.place({ submitTransaction: transport }), order);
    assert.equal(transport.mock.callCount(), 1);
  }
});

test("malformed confirmation timestamps cannot mark an order as placed", async () => {
  const invalid = [
    undefined, null, "", " ", true, "invalid", "NaN", NaN, Infinity,
    -1, "-1", 1.5, "1.5", "1e3", "0x11", 8640000000001,
  ];
  for (const createdAt of invalid) {
    const { manager, params, submit } = setup("transaction");
    const prepared = await manager.prepare(params);
    await assert.rejects(
      prepared.place({
        submitTransaction: async (raw) => ({ ...(await submit(raw)), createdAt }),
      }),
      /not confirmed/,
    );
  }
});

test("a failed transaction can be rebuilt for the same order; unrelated confirmations are rejected", async () => {
  const { manager, params, submit, api } = setup("transaction");
  const prepared = await manager.prepare(params);
  await assert.rejects(
    prepared.place({ submitTransaction: async () => ({ status: "failed" }) }),
    /transaction failed/,
  );
  await assert.rejects(
    prepared.place({
      submitTransaction: async () => ({
        status: "confirmed",
        transactionHash: "00".repeat(32),
        ledger: 10,
        createdAt: 1000,
      }),
    }),
    /another transaction/,
  );
  await prepared.place({ submitTransaction: submit });
  assert.equal(api.createLimitOrderDraft.mock.callCount(), 1);
  assert.equal(manager.buildPlacementTransaction.mock.callCount(), 2);
});

test("history forwards sorting and opaque cursors and returns bound order records", async () => {
  const { manager, api } = setup("transaction");
  api.listLimitOrders.mock.mockImplementation(async () => ({
    orders: [record("FILLED")],
    next_cursor: "next+/=",
  }));
  const page = await manager.history(undefined, "previous+/=");
  assert.ok(page.orders[0] instanceof LimitOrderRecord);
  assert.equal(page.nextCursor, "next+/=");
  assert.deepEqual(api.listLimitOrders.mock.calls[0].arguments[1], {
    maker: onchain.maker,
    status: "FILLED,CANCELLED,EXPIRED",
    sort: "-completed_at",
    cursor: "previous+/=",
    limit: "20",
  });
});

test("pages reject invalid records, status, duplicate IDs and cursor loops", async () => {
  for (const response of [
    {},
    { orders: [record("OPEN")] },
    { orders: [], next_cursor: "same" },
    { orders: [], next_cursor: 12 },
    { orders: [{ ...record("FILLED"), maker: detached.maker }] },
  ]) {
    const { manager, api } = setup("transaction");
    api.listLimitOrders.mock.mockImplementation(async () => response);
    await assert.rejects(manager.history(onchain.maker, "same"));
  }
  const { manager, api } = setup("transaction");
  api.listLimitOrders.mock.mockImplementation(async () => ({
    orders: [record("OPEN")],
    next_cursor: "next",
  }));
  await assert.rejects(manager.open(), /pagination cursor|repeated an order/);
});

test("read-only clients retain registry reads without a signer", async () => {
  const client = new AquariusClient({
    network: "testnet",
    limitOrders: { settlement: detached.settlement_address, apiUrl: "https://registry.test/" },
  });
  client.api.listLimitOrders = async () => ({ orders: [], next_cursor: null });
  assert.deepEqual(await client.limitOrders.history(detached.maker), {
    orders: [],
    nextCursor: null,
  });
  await assert.rejects(client.limitOrders.prepare({ ...setup().params }), /requires a signer/);
});

test("registry transport encodes opaque cursors and bounds signed-proof requests", async (t) => {
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ orders: [], next_cursor: null })),
  );
  const api = new ApiClient("https://unused.test/");
  await api.listLimitOrders("https://registry.test/", { cursor: "abc+/=" });
  assert.equal(new URL(fetch.mock.calls[0].arguments[0]).searchParams.get("cursor"), "abc+/=");
  await api.authorizeLimitOrder(
    "https://registry.test/",
    detached.order_id,
    detached.authorization_xdr,
  );
  const [url, options] = fetch.mock.calls[1].arguments;
  assert.equal(url, `https://registry.test/orders/${detached.order_id}/authorize/`);
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(options.body), { authorization_xdr: detached.authorization_xdr });
});

test("client transaction placement retries the identical signed envelope after a lost RPC response", async () => {
  const key = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
  const sign = mock.fn(async (raw) => {
    const transaction = new Transaction(raw, Networks.TESTNET);
    transaction.sign(key);
    return transaction.toXDR();
  });
  const client = new AquariusClient({
    network: "testnet",
    signer: { publicKey: () => key.publicKey(), sign },
    limitOrders: { settlement: onchain.settlement_address },
  });
  client.fetchHorizonAccount = async () => ({
    balances: [],
    signers: [{ key: key.publicKey(), type: "ed25519_public_key", weight: 1 }],
    thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 },
  });
  client.server.getLatestLedger = async () => ({ sequence: 100 });
  let confirmed = false;
  client.server.getTransaction = async () =>
    confirmed ? { status: "SUCCESS", ledger: 105, createdAt: "1793782319" } : { status: "NOT_FOUND" };
  client.api.createLimitOrderDraft = async (_, request) => onchainDraft(request);
  client.limitOrders.getSettlementConfig = async () => ({
    maxOrderTtl: 1000,
    executorRewardXlm: "5000000",
  });
  client.limitOrders.buildPlacementTransaction = async () =>
    new TransactionBuilder(new Account(key.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.manageData({ name: "test", value: "order" }))
      .setTimeout(300)
      .build()
      .toXDR();
  const envelopes = [];
  client.engine.submitSignedTransaction = async (transaction) => {
    envelopes.push(transaction.toXDR());
    if (envelopes.length === 1) throw new Error("RPC response lost");
    confirmed = true;
    return { txHash: Buffer.from(transaction.hash()).toString("hex") };
  };
  const prepared = await client.limitOrders.prepare(setup("transaction").params);
  await assert.rejects(prepared.place(), /RPC response lost/);
  const order = await prepared.place();
  assert.equal(order.status, "OPEN");
  assert.equal(sign.mock.callCount(), 1);
  assert.equal(envelopes[0], envelopes[1]);
  assert.equal(order.placementLedger, 105);
});

test("a local Keypair uses detached authorization without requiring a wallet adapter", async () => {
  const key = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8));
  const { manager, context, params, api, account } = setup();
  context.signer = key;
  account.signers[0].key = key.publicKey();
  context.loadAccount = async () => account;
  params.to = Asset.contract(onchain.buy_token);
  let unsigned;
  api.createLimitOrderDraft.mock.mockImplementation(async (_, request) => {
    const raw = onchainDraft({ ...request, placement_mode: "CONTRACT_ONCHAIN" });
    const wire = xdr.ScVal.fromXDR(raw.order_xdr, "base64");
    const canonical = xdr.ScVal.scvMap(
      wire.map.map((field) =>
        field.key.sym.toString() === "placement_mode"
          ? new xdr.ScMapEntry({
              key: field.key,
              val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Detached")]),
            })
          : field,
      ),
    );
    const invoke = (contract, fn, args, children = []) =>
      new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(contract).toScAddress(),
            functionName: fn,
            args,
          }),
        ),
        subInvocations: children,
      });
    const transfer = (token, amount) =>
      invoke(token, "transfer", [
        new Address(request.maker).toScVal(),
        new Address(raw.settlement_address).toScVal(),
        nativeToScVal(BigInt(amount), { type: "i128" }),
      ]);
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
        new xdr.SorobanAddressCredentials({
          address: new Address(request.maker).toScAddress(),
          nonce: 42n,
          signatureExpirationLedger: request.expires_at_ledger,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: invoke(
        raw.settlement_address,
        "fill",
        [canonical],
        [
          transfer(request.sell_token, request.sell_amount),
          transfer(Asset.native().contractId(Networks.TESTNET), raw.executor_reward_xlm),
        ],
      ),
    });
    unsigned = {
      ...raw,
      placement_mode: "DETACHED",
      status: "DRAFT",
      order_id: Buffer.from(hash(canonical.toXDR())).toString("hex"),
      order_xdr: canonical.toXDR("base64"),
      unsigned_authorization_xdr: entry.toXDR("base64"),
    };
    return unsigned;
  });
  api.authorizeLimitOrder.mock.mockImplementation(async (_, __, signature) => ({
    ...unsigned,
    status: "OPEN",
    authorization_xdr: signature,
  }));
  const prepared = await manager.prepare(params);
  assert.equal(prepared.summary.signing, "authorization");
  const order = await prepared.place();
  assert.equal(order.order.maker, key.publicKey());
  assert.equal(order.authorization.credentials.addressV2.signature.type, "scvVec");
});
