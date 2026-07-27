import { Buffer } from "buffer";

import {
  Address,
  hash,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { AquariusError } from "./errors.js";

const ORDER_FIELDS = [
  "buy_token",
  "executor_reward_xlm",
  "expires_at_ledger",
  "maker",
  "min_buy_amount",
  "placement_mode",
  "salt",
  "sell_amount",
  "sell_token",
  "valid_after_ledger",
  "version",
];

function contractAddress(value: string, name: string): string {
  try {
    new Address(value);
  } catch {
    throw new AquariusError(`limit-order ${name} must be a valid contract address`);
  }
  if (!value.startsWith("C")) {
    throw new AquariusError(`limit-order ${name} must be a contract address`);
  }
  return value;
}

export interface LimitOrderConfigInput {
  settlement: string;
  batcher: string;
  apiUrl?: string;
}

export class LimitOrderConfig {
  readonly settlement: string;
  readonly batcher: string;
  readonly apiUrl?: string;

  constructor(config: LimitOrderConfigInput) {
    this.settlement = contractAddress(config.settlement, "settlement");
    this.batcher = contractAddress(config.batcher, "batcher");
    if (config.apiUrl !== undefined && config.apiUrl.length === 0) {
      throw new AquariusError("limit-order apiUrl must be non-empty");
    }
    this.apiUrl = config.apiUrl;
  }
}

export interface OnchainLimitOrderReceipt {
  orderId: string;
  txHash: string;
}

export interface OnchainLimitOrderActions {
  buildPlacement(order: OnchainLimitOrder): Promise<string>;
  place(order: OnchainLimitOrder): Promise<OnchainLimitOrderReceipt>;
  buildCancel(order: OnchainLimitOrder): Promise<string>;
  cancel(order: OnchainLimitOrder): Promise<OnchainLimitOrderReceipt>;
}

export class OnchainLimitOrder {
  constructor(
    readonly orderId: string,
    readonly settlementAddress: string,
    readonly maker: string,
    readonly sellToken: string,
    readonly sellAmount: bigint,
    readonly buyToken: string,
    readonly minBuyAmount: bigint,
    readonly validAfterLedger: number,
    readonly expiresAtLedger: number,
    readonly allowanceExpirationLedger: number,
    readonly executorRewardXlm: bigint,
    readonly orderScVal: xdr.ScVal,
    private readonly actions?: OnchainLimitOrderActions,
  ) {}

  requiredAllowances(xlmToken: string): Map<string, bigint> {
    if (this.sellToken === xlmToken) {
      return new Map([[xlmToken, this.sellAmount + this.executorRewardXlm]]);
    }
    return new Map([
      [this.sellToken, this.sellAmount],
      [xlmToken, this.executorRewardXlm],
    ]);
  }

  buildTransaction(): Promise<string> {
    return this.boundActions().buildPlacement(this);
  }

  place(): Promise<OnchainLimitOrderReceipt> {
    return this.boundActions().place(this);
  }

  buildCancelTransaction(): Promise<string> {
    return this.boundActions().buildCancel(this);
  }

  cancel(): Promise<OnchainLimitOrderReceipt> {
    return this.boundActions().cancel(this);
  }

  private boundActions(): OnchainLimitOrderActions {
    if (!this.actions) {
      throw new AquariusError("limit order is not bound to an AquariusClient");
    }
    return this.actions;
  }
}

export interface OnchainLimitOrderDraftPayload {
  [key: string]: unknown;
  order_id: string;
  status: string;
  version: number;
  placement_mode: string;
  network_id: string;
  settlement_address: string;
  salt: string;
  maker: string;
  sell_token: string;
  sell_amount: string;
  buy_token: string;
  min_buy_amount: string;
  valid_after_ledger: number;
  expires_at_ledger: number;
  executor_reward_xlm: string;
  order_xdr: string;
}

export interface ValidateOnchainDraftContext {
  expectedNetworkPassphrase: string;
  expectedSettlement: string;
  expectedMaker: string;
  expectedOrder: {
    sellToken: string;
    sellAmount: bigint;
    buyToken: string;
    minBuyAmount: bigint;
    validAfterLedger: number;
    expiresAtLedger: number;
  };
  allowanceExpirationLedger: number;
  actions?: OnchainLimitOrderActions;
}

export function validateOnchainLimitOrderDraft(
  payload: OnchainLimitOrderDraftPayload,
  context: ValidateOnchainDraftContext,
): OnchainLimitOrder {
  let orderScVal: xdr.ScVal;
  try {
    orderScVal = xdr.ScVal.fromXDR(payload.order_xdr, "base64");
  } catch {
    throw new AquariusError("order registry returned invalid canonical order XDR");
  }
  const orderId = hash(orderScVal.toXDR()).toString("hex");
  if (orderId !== payload.order_id) {
    throw new AquariusError("order registry returned an order ID that does not match its XDR");
  }

  let projectionMatches = false;
  try {
    const nativeValue = scValToNative(orderScVal) as unknown;
    if (!nativeValue || typeof nativeValue !== "object" || Array.isArray(nativeValue)) {
      throw new AquariusError("order registry returned a non-canonical OrderV1");
    }
    const native = nativeValue as Record<string, unknown>;
    if (Object.keys(native).sort().join(",") !== ORDER_FIELDS.join(",")) {
      throw new AquariusError("order registry returned a non-canonical OrderV1");
    }
    const salt = native.salt;
    projectionMatches =
      native.version === payload.version &&
      Array.isArray(native.placement_mode) &&
      native.placement_mode.length === 1 &&
      native.placement_mode[0] === "ContractOnChain" &&
      salt instanceof Uint8Array &&
      Buffer.from(salt).toString("hex") === payload.salt &&
      native.maker === payload.maker &&
      native.sell_token === payload.sell_token &&
      String(native.sell_amount) === payload.sell_amount &&
      native.buy_token === payload.buy_token &&
      String(native.min_buy_amount) === payload.min_buy_amount &&
      native.valid_after_ledger === payload.valid_after_ledger &&
      native.expires_at_ledger === payload.expires_at_ledger &&
      String(native.executor_reward_xlm) === payload.executor_reward_xlm;
  } catch (error) {
    if (error instanceof AquariusError) throw error;
    throw new AquariusError("order registry JSON does not match its canonical order XDR");
  }
  if (!projectionMatches) {
    throw new AquariusError("order registry JSON does not match its canonical order XDR");
  }

  const networkId = hash(Buffer.from(context.expectedNetworkPassphrase)).toString("hex");
  if (
    payload.status !== "AWAITING_PLACEMENT" ||
    payload.placement_mode !== "CONTRACT_ONCHAIN" ||
    payload.network_id !== networkId ||
    payload.settlement_address !== context.expectedSettlement ||
    payload.maker !== context.expectedMaker ||
    "authorization_xdr" in payload ||
    "unsigned_authorization_xdr" in payload
  ) {
    throw new AquariusError("order registry returned a draft for another execution context");
  }
  const expected = context.expectedOrder;
  let expectedMatches = false;
  try {
    expectedMatches =
      payload.sell_token === expected.sellToken &&
      BigInt(payload.sell_amount) === expected.sellAmount &&
      payload.buy_token === expected.buyToken &&
      BigInt(payload.min_buy_amount) === expected.minBuyAmount &&
      payload.valid_after_ledger === expected.validAfterLedger &&
      payload.expires_at_ledger === expected.expiresAtLedger;
  } catch {
    throw new AquariusError("order registry changed the requested order");
  }
  if (!expectedMatches) {
    throw new AquariusError("order registry changed the requested order");
  }
  if (
    !Number.isInteger(context.allowanceExpirationLedger) ||
    context.allowanceExpirationLedger < payload.expires_at_ledger ||
    context.allowanceExpirationLedger > 0xffffffff
  ) {
    throw new AquariusError(
      "allowance expiration must be a u32 ledger at or after order expiration",
    );
  }

  return new OnchainLimitOrder(
    orderId,
    context.expectedSettlement,
    context.expectedMaker,
    payload.sell_token,
    BigInt(payload.sell_amount),
    payload.buy_token,
    BigInt(payload.min_buy_amount),
    payload.valid_after_ledger,
    payload.expires_at_ledger,
    context.allowanceExpirationLedger,
    BigInt(payload.executor_reward_xlm),
    orderScVal,
    context.actions,
  );
}

export function buildOnchainPlacementArgs(
  order: OnchainLimitOrder,
  currentAllowances: ReadonlyMap<string, bigint>,
  xlmToken: string,
): xdr.ScVal[] {
  const calls: xdr.ScVal[] = [];
  for (const [token, required] of order.requiredAllowances(xlmToken)) {
    const current = currentAllowances.get(token) ?? 0n;
    if (current < 0n) throw new AquariusError("token allowance cannot be negative");
    const amount = current > required ? current : required;
    if (amount > (1n << 127n) - 1n) {
      throw new AquariusError("required token allowance does not fit i128");
    }
    calls.push(xdr.ScVal.scvVec([
      new Address(token).toScVal(),
      nativeToScVal("approve", { type: "symbol" }),
      xdr.ScVal.scvVec([
        new Address(order.maker).toScVal(),
        new Address(order.settlementAddress).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
        nativeToScVal(order.allowanceExpirationLedger, { type: "u32" }),
      ]),
    ]));
  }
  calls.push(xdr.ScVal.scvVec([
    new Address(order.settlementAddress).toScVal(),
    nativeToScVal("place_contract_order", { type: "symbol" }),
    xdr.ScVal.scvVec([
      new Address(order.maker).toScVal(),
      xdr.ScVal.scvBytes(Buffer.from(order.orderId, "hex")),
      nativeToScVal(order.expiresAtLedger, { type: "u32" }),
    ]),
  ]));
  return [
    xdr.ScVal.scvVec([new Address(order.maker).toScVal()]),
    xdr.ScVal.scvVec(calls),
    xdr.ScVal.scvBool(false),
  ];
}
