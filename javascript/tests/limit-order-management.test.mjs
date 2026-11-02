import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  Address,
  Keypair,
  Networks,
  StrKey,
  hash,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import {
  AquariusClient,
  AquariusError,
  LimitOrderConfig,
  parseLimitOrderRecord,
  routeScValFromSwapChain,
  validateFillReceipt,
} from "../dist/index.js";

const draft = JSON.parse(
  readFileSync(
    new URL("../../testdata/limit_order_onchain_draft.json", import.meta.url),
    "utf8",
  ),
);
const xlmToken = StrKey.encodeContract(Buffer.alloc(32, 4));

function struct(entries) {
  return xdr.ScVal.scvMap(
    Object.entries(entries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => new xdr.ScMapEntry({
        key: nativeToScVal(key, { type: "symbol" }),
        val: value,
      })),
  );
}

function contractCall(contract, functionName, args, subInvocations = []) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName,
        args,
      }),
    ),
    subInvocations,
  });
}

function detachedPayload(rewardToken = xlmToken) {
  const order = struct({
    version: nativeToScVal(1, { type: "u32" }),
    placement_mode: xdr.ScVal.scvVec([
      nativeToScVal("Detached", { type: "symbol" }),
    ]),
    salt: xdr.ScVal.scvBytes(Buffer.from(draft.salt, "hex")),
    maker: new Address(draft.maker).toScVal(),
    sell_token: new Address(draft.sell_token).toScVal(),
    sell_amount: nativeToScVal(1_000n, { type: "u128" }),
    buy_token: new Address(draft.buy_token).toScVal(),
    min_buy_amount: nativeToScVal(900n, { type: "u128" }),
    valid_after_ledger: nativeToScVal(100, { type: "u32" }),
    expires_at_ledger: nativeToScVal(200, { type: "u32" }),
    executor_reward_xlm: nativeToScVal(5_000_000n, { type: "u128" }),
  });
  const maker = new Address(draft.maker).toScVal();
  const settlement = new Address(draft.settlement_address).toScVal();
  const rootInvocation = contractCall(
    draft.settlement_address,
    "fill",
    [order],
    [
      contractCall(draft.sell_token, "transfer", [
        maker,
        settlement,
        nativeToScVal(1_000n, { type: "i128" }),
      ]),
      contractCall(rewardToken, "transfer", [
        maker,
        settlement,
        nativeToScVal(5_000_000n, { type: "i128" }),
      ]),
    ],
  );
  const credentials = new xdr.SorobanAddressCredentials({
    address: new Address(draft.maker).toScAddress(),
    nonce: xdr.Int64.fromString("42"),
    signatureExpirationLedger: 200,
    signature: nativeToScVal("signed"),
  });
  const authorization = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials),
    rootInvocation,
  });
  return {
    ...draft,
    order_id: Buffer.from(hash(order.toXDR())).toString("hex"),
    status: "OPEN",
    placement_mode: "DETACHED",
    order_xdr: Buffer.from(order.toXDR()).toString("base64"),
    authorization_xdr: Buffer.from(authorization.toXDR()).toString("base64"),
    placement_ledger: null,
    placement_transaction_hash: "",
  };
}

function openPayload() {
  return {
    ...draft,
    status: "OPEN",
    placement_ledger: 101,
    placement_transaction_hash: "ab".repeat(32),
  };
}

test("detached trust permits only the exact receive token and maker", () => {
  for (const mutation of [null, "recipient", "token", "duplicate", "nested"]) {
    const payload = detachedPayload();
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(payload.authorization_xdr, "base64");
    const root = entry.rootInvocation;
    const trust = contractCall(
      mutation === "token" ? draft.sell_token : draft.buy_token,
      "trust", [new Address(mutation === "recipient" ? Keypair.random().publicKey() : draft.maker).toScVal()],
      mutation === "nested" ? [root.subInvocations[0]] : [],
    );
    root.subInvocations = [trust, ...root.subInvocations];
    if (mutation === "duplicate") root.subInvocations = [trust, ...root.subInvocations];
    payload.authorization_xdr = entry.toXDR("base64");
    const parse = () => parseLimitOrderRecord(payload, {
      networkPassphrase: Networks.TESTNET, settlementAddress: draft.settlement_address, xlmToken,
    });
    if (mutation === null) assert.equal(parse().orderId, payload.order_id);
    else assert.throws(parse, /invocation tree/);
  }
});

function routeXdr() {
  return Buffer.from(xdr.ScVal.scvVec([
    xdr.ScVal.scvVec([
      xdr.ScVal.scvVec([
        new Address(draft.sell_token).toScVal(),
        new Address(draft.buy_token).toScVal(),
      ]),
      xdr.ScVal.scvBytes(Buffer.alloc(32, 5)),
      new Address(draft.buy_token).toScVal(),
    ]),
  ]).toXDR()).toString("base64");
}

function receipt(orderId, rewardTo, makerDelta = 950n) {
  return nativeToScVal({
    order_id: Buffer.from(orderId, "hex"),
    router_output: 950n,
    maker_buy_delta_before_reward: makerDelta,
    reward_xlm: 5_000_000n,
    reward_to: new Address(rewardTo),
  }, { type: "struct" });
}

test("read and fill configuration does not require a batcher", () => {
  const config = new LimitOrderConfig({ settlement: draft.settlement_address });
  assert.equal(config.settlement, draft.settlement_address);
  assert.equal(config.batcher, undefined);
});

test("registry record validates canonical on-chain placement", () => {
  const record = parseLimitOrderRecord(openPayload(), {
    networkPassphrase: Networks.TESTNET,
    settlementAddress: draft.settlement_address,
    xlmToken,
  });
  assert.equal(record.orderId, draft.order_id);
  assert.equal(record.order.requiredRouterMin(xlmToken), 900n);
  assert.equal(record.authorization, undefined);

  assert.throws(
    () => parseLimitOrderRecord(
      { ...openPayload(), sell_amount: "1001" },
      {
        networkPassphrase: Networks.TESTNET,
        settlementAddress: draft.settlement_address,
        xlmToken,
      },
    ),
    /canonical order XDR/,
  );
});

test("detached record requires the exact signed ADDRESS_V2 invocation tree", () => {
  const payload = detachedPayload();
  const record = parseLimitOrderRecord(payload, {
    networkPassphrase: Networks.TESTNET,
    settlementAddress: draft.settlement_address,
    xlmToken,
  });
  assert.ok(record.authorization);

  const authorization = xdr.SorobanAuthorizationEntry.fromXDR(
    payload.authorization_xdr,
    "base64",
  );
  authorization.rootInvocation.subInvocations = [];
  assert.throws(
    () => parseLimitOrderRecord(
      { ...payload, authorization_xdr: Buffer.from(authorization.toXDR()).toString("base64") },
      {
        networkPassphrase: Networks.TESTNET,
        settlementAddress: draft.settlement_address,
        xlmToken,
      },
    ),
    /invocation tree/,
  );
});

test("route conversion and fill receipt preserve the settlement ABI", () => {
  const record = parseLimitOrderRecord(openPayload(), {
    networkPassphrase: Networks.TESTNET,
    settlementAddress: draft.settlement_address,
    xlmToken,
  });
  const route = scValToNative(routeScValFromSwapChain(routeXdr()));
  assert.equal(Buffer.from(route[0].pool_index).toString("hex"), "05".repeat(32));
  assert.deepEqual(route[0].pool_tokens, [draft.sell_token, draft.buy_token]);

  const rewardTo = Keypair.random().publicKey();
  const parsed = validateFillReceipt(
    record,
    rewardTo,
    receipt(record.orderId, rewardTo),
  );
  assert.equal(parsed.makerBuyDeltaBeforeReward, 950n);
  assert.throws(
    () => validateFillReceipt(
      record,
      rewardTo,
      receipt(record.orderId, rewardTo, 899n),
    ),
    /maker payout/,
  );
});

test("client follows cursor pages and rejects duplicate orders", async () => {
  const client = new AquariusClient({
    network: "testnet",
    limitOrders: { settlement: draft.settlement_address },
  });
  const pages = [
    { orders: [openPayload()], next_cursor: "next" },
    { orders: [openPayload()], next_cursor: null },
  ];
  client.api.listLimitOrders = async () => pages.shift();

  await assert.rejects(client.openLimitOrders(), /repeated an order/);
});

test("prepared fill checks receipt and fee before SDK submission", async () => {
  const filler = Keypair.random();
  const client = new AquariusClient({
    network: "testnet",
    signer: filler,
    limitOrders: { settlement: draft.settlement_address },
    baseFee: "1000",
  });
  client.api.getLimitOrder = async () => openPayload();
  const record = await client.getLimitOrder(draft.order_id);
  let operation;
  client.engine.buildTransaction = async (_source, built) => {
    operation = built;
    return { toXDR: () => "raw" };
  };
  client.server.simulateTransaction = async () => ({
    id: "simulation",
    latestLedger: 100,
    transactionData: { build: () => ({}) },
    minResourceFee: "1",
    cost: {},
    result: { retval: receipt(record.orderId, filler.publicKey()) },
    events: [],
  });
  const preparedTx = {
    fee: "4999999",
    toXDR: () => "prepared",
  };
  client.assembleLimitOrderFill = () => preparedTx;
  client.engine.signAndSubmit = async () => ({ txHash: "cd".repeat(32), returnValue: receipt(record.orderId, filler.publicKey()) });

  const prepared = await record.prepareFill(routeXdr());
  assert.equal(prepared.maximumFee, 4_999_999n);
  const invocation = operation.body.invokeHostFunctionOp.hostFunction.invokeContract;
  assert.equal(
    Address.fromScAddress(invocation.contractAddress).toString(),
    draft.settlement_address,
  );
  assert.equal(invocation.functionName.toString(), "fill");
  assert.deepEqual(await prepared.execute(), {
    txHash: "cd".repeat(32),
    order: record,
    receipt: prepared.receipt,
  });

  client.assembleLimitOrderFill = () => ({ ...preparedTx, fee: "5000000" });
  await assert.rejects(record.prepareFill(routeXdr()), /below execution fee/);
});

test("record cancellation uses the canonical order body", async () => {
  const maker = Keypair.fromPublicKey(draft.maker);
  const client = new AquariusClient({
    network: "testnet",
    signer: { publicKey: () => maker.publicKey(), sign: value => value },
    limitOrders: { settlement: draft.settlement_address },
  });
  client.api.getLimitOrder = async () => openPayload();
  const record = await client.getLimitOrder(draft.order_id);
  let operation;
  client.engine.prepare = async (_source, buildOperation) => {
    operation = buildOperation();
    return {};
  };
  client.engine.signAndSubmit = async () => ({ txHash: "ef".repeat(32) });

  assert.equal((await record.cancel()).txHash, "ef".repeat(32));
  const invocation = operation.body.invokeHostFunctionOp.hostFunction.invokeContract;
  assert.equal(invocation.functionName.toString(), "cancel");
  assert.equal(Buffer.from(invocation.args[0].toXDR()).toString("base64"), Buffer.from(record.order.orderScVal.toXDR()).toString("base64"));
});

async function preparedClient({ resourceFee = 17, resourceHeadroom = 0, instructionHeadroom = 0, detached = false } = {}) {
  const { Account, SorobanDataBuilder } = await import("@stellar/stellar-sdk");
  const filler = Keypair.random();
  const client = new AquariusClient({
    network: "testnet", signer: filler,
    limitOrders: { settlement: draft.settlement_address }, baseFee: "100",
    resourceFeeHeadroom: resourceHeadroom, instructionHeadroom,
  });
  const { Asset } = await import("../dist/index.js");
  const payload = detached ? detachedPayload(Asset.native().contractId(Networks.TESTNET)) : openPayload();
  client.api.getLimitOrder = async () => payload;
  const record = await client.getLimitOrder(payload.order_id);
  client.server.getAccount = async source => new Account(source, "42");
  client.engine.networkCompute = async () => ({ txMaxInstructions: 1_000_000, feeRatePerInstructionsIncrement: 1_000_000n });
  const simulation = {
    _parsed: true, latestLedger: 100, events: [],
    minResourceFee: String(resourceFee),
    transactionData: new SorobanDataBuilder().setResources(10_000, 0, 0).setResourceFee(resourceFee),
    result: { auth: [], retval: receipt(record.orderId, filler.publicKey()) },
  };
  const modes = [];
  client.server.simulateTransaction = async (_tx, resources, mode) => {
    assert.equal(resources, undefined);
    modes.push(mode);
    return simulation;
  };
  client.engine.signAndSubmit = async () => { throw new Error("preparation must not submit"); };
  return { client, record, filler, simulation, modes };
}

test("fill enforces fixed auth and checks fees after instruction and resource headroom", async () => {
  const { Transaction } = await import("@stellar/stellar-sdk");
  const { record, modes } = await preparedClient({ resourceHeadroom: 0.5, instructionHeadroom: 0.25 });
  const prepared = await record.prepareFill(routeXdr());
  const tx = new Transaction(prepared.transactionXdr, Networks.TESTNET);
  assert.deepEqual(modes, ["enforce"]);
  assert.deepEqual(tx.operations[0].auth, []);
  assert.equal(tx.toEnvelope().v1.tx.ext.sorobanData.resources.instructions, 12_500);
  assert.equal(prepared.maximumFee, 375_126n);
  const expensive = await preparedClient({ resourceFee: 4_000_000, resourceHeadroom: 0.5 });
  await assert.rejects(expensive.record.prepareFill(routeXdr()), /below execution fee/);
});

test("fill rejects injected RPC auth and restoration without submitting", async () => {
  const { authorizedInvocation, sourceAccountEntry } = await import("../dist/index.js");
  const { record, simulation } = await preparedClient();
  simulation.result.auth = [sourceAccountEntry(authorizedInvocation(draft.settlement_address, "unexpected", []))];
  await assert.rejects(record.prepareFill(routeXdr()), /authorization/);
  simulation.result.auth = [];
  simulation.restorePreamble = { transactionData: simulation.transactionData, minResourceFee: "17" };
  await assert.rejects(record.prepareFill(routeXdr()), /restoration/);
});

test("execute returns the confirmed receipt and rejects a missing return", async () => {
  const { client, record, filler } = await preparedClient();
  const prepared = await record.prepareFill(routeXdr());
  client.engine.signAndSubmit = async () => ({ txHash: "cd".repeat(32), returnValue: receipt(record.orderId, filler.publicKey(), 975n) });
  assert.equal((await prepared.execute()).receipt.makerBuyDeltaBeforeReward, 975n);
  assert.equal(prepared.receipt.makerBuyDeltaBeforeReward, 950n);
  client.engine.signAndSubmit = async () => ({ txHash: "cd".repeat(32) });
  await assert.rejects(prepared.execute(), /receipt/);
});


test("detached fill preserves the signed maker authorization byte for byte", async () => {
  const { Transaction } = await import("@stellar/stellar-sdk");
  const { record, simulation } = await preparedClient({ detached: true });
  const expected = Buffer.from(record.authorization.toXDR());
  simulation.result.auth = [record.authorization];
  const prepared = await record.prepareFill(routeXdr());
  const tx = new Transaction(prepared.transactionXdr, Networks.TESTNET);
  assert.deepEqual(Buffer.from(tx.operations[0].auth[0].toXDR()), expected);
});

test("detached auth and route match the shared canonical wire vectors", async () => {
  const { Asset } = await import("../dist/index.js");
  const vectors = JSON.parse(readFileSync(new URL("../../testdata/limit_order_vectors.json", import.meta.url), "utf8"));
  const payload = detachedPayload(Asset.native().contractId(Networks.TESTNET));
  assert.equal(payload.order_xdr, vectors.detached_order_xdr);
  assert.equal(payload.order_id, vectors.detached_order_id);
  assert.equal(payload.authorization_xdr, vectors.detached_auth_xdr);
  assert.equal(Buffer.from(routeScValFromSwapChain(vectors.route_xdr).toXDR()).toString("base64"), vectors.route_scval_xdr);
});

test("shared auto-trust and legacy vectors preserve the same order", () => {
  const vector = JSON.parse(readFileSync(new URL("../../testdata/limit_order_auto_trust.json", import.meta.url), "utf8"));
  for (const proof of ["authorization_xdr", "legacy_authorization_xdr"]) {
    const record = parseLimitOrderRecord({ ...vector, authorization_xdr: vector[proof] }, {
      networkPassphrase: Networks.TESTNET, settlementAddress: vector.settlement_address,
      xlmToken: vector.sell_token,
    });
    assert.equal(record.orderId, "deb93819e99e5863c9d179da91d395699b01dccf0e88869c0d6353e76c9f1f28");
  }
});
