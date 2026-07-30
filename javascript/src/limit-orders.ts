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
  batcher?: string;
  apiUrl?: string;
}

export class LimitOrderConfig {
  readonly settlement: string;
  readonly batcher?: string;
  readonly apiUrl?: string;

  constructor(config: LimitOrderConfigInput) {
    this.settlement = contractAddress(config.settlement, "settlement");
    this.batcher = config.batcher === undefined
      ? undefined
      : contractAddress(config.batcher, "batcher");
    if (config.apiUrl !== undefined && config.apiUrl.length === 0) {
      throw new AquariusError("limit-order apiUrl must be non-empty");
    }
    this.apiUrl = config.apiUrl;
  }
}

export type LimitOrderStatus = "OPEN" | "FILLED" | "CANCELLED" | "EXPIRED";

export class LimitOrder {
  constructor(
    readonly version: number,
    readonly placementMode: "DETACHED" | "CONTRACT_ONCHAIN",
    readonly salt: Uint8Array,
    readonly maker: string,
    readonly sellToken: string,
    readonly sellAmount: bigint,
    readonly buyToken: string,
    readonly minBuyAmount: bigint,
    readonly validAfterLedger: number,
    readonly expiresAtLedger: number,
    readonly executorRewardXlm: bigint,
    readonly orderScVal: xdr.ScVal,
  ) {}

  requiredRouterMin(xlmToken: string): bigint {
    return this.buyToken === xlmToken
      ? this.minBuyAmount + this.executorRewardXlm
      : this.minBuyAmount;
  }
}

export interface LimitOrderFillReceipt {
  orderId: string;
  routerOutput: bigint;
  makerBuyDeltaBeforeReward: bigint;
  rewardXlm: bigint;
  rewardTo: string;
}

export interface LimitOrderFillResult {
  txHash: string;
  order: LimitOrderRecord;
  receipt: LimitOrderFillReceipt;
}

export interface LimitOrderRecordActions {
  prepareLimitOrderFill(
    record: LimitOrderRecord,
    swapChainXdr: string,
    rewardTo?: string,
  ): Promise<PreparedLimitOrderFill>;
  buildLimitOrderCancel(record: LimitOrderRecord): Promise<string>;
  cancelLimitOrder(record: LimitOrderRecord): Promise<OnchainLimitOrderReceipt>;
}

export class PreparedLimitOrderFill {
  constructor(
    readonly order: LimitOrderRecord,
    readonly receipt: LimitOrderFillReceipt,
    readonly maximumFee: bigint,
    readonly transactionXdr: string,
    private readonly executeAction: () => Promise<LimitOrderFillResult>,
  ) {}

  execute(): Promise<LimitOrderFillResult> {
    return this.executeAction();
  }
}

export class LimitOrderRecord {
  constructor(
    readonly orderId: string,
    readonly status: LimitOrderStatus,
    readonly order: LimitOrder,
    readonly authorization: xdr.SorobanAuthorizationEntry | undefined,
    readonly settlementAddress: string,
    readonly networkId: string,
    readonly placementLedger: number | null,
    readonly placementTransactionHash: string | null,
    readonly raw: Record<string, unknown>,
    private readonly actions?: LimitOrderRecordActions,
  ) {}

  prepareFill(swapChainXdr: string, rewardTo?: string): Promise<PreparedLimitOrderFill> {
    return this.boundActions().prepareLimitOrderFill(this, swapChainXdr, rewardTo);
  }

  buildCancelTransaction(): Promise<string> {
    return this.boundActions().buildLimitOrderCancel(this);
  }

  cancel(): Promise<OnchainLimitOrderReceipt> {
    return this.boundActions().cancelLimitOrder(this);
  }

  private boundActions(): LimitOrderRecordActions {
    if (!this.actions) {
      throw new AquariusError("limit-order record is not bound to an AquariusClient");
    }
    return this.actions;
  }
}

export interface LimitOrderPage {
  orders: LimitOrderRecord[];
  nextCursor: string | null;
}

export interface ParseLimitOrderContext {
  networkPassphrase: string;
  settlementAddress: string;
  xlmToken: string;
  actions?: LimitOrderRecordActions;
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

export function parseLimitOrderRecord(
  payload: Record<string, unknown>,
  context: ParseLimitOrderContext,
): LimitOrderRecord {
  const status = String(payload.status) as LimitOrderStatus;
  if (!["OPEN", "FILLED", "CANCELLED", "EXPIRED"].includes(status)) {
    throw new AquariusError("limit-order registry returned a non-public status");
  }
  if (payload.settlement_address !== context.settlementAddress) {
    throw new AquariusError("limit order targets another settlement contract");
  }
  const expectedNetworkId = hash(Buffer.from(context.networkPassphrase)).toString("hex");
  if (payload.network_id !== expectedNetworkId) {
    throw new AquariusError("limit order targets another network");
  }

  let orderScVal: xdr.ScVal;
  let order: LimitOrder;
  try {
    orderScVal = xdr.ScVal.fromXDR(String(payload.order_xdr), "base64");
    order = limitOrderFromScVal(orderScVal);
  } catch (error) {
    if (error instanceof AquariusError) throw error;
    throw new AquariusError("limit-order registry returned invalid canonical order XDR");
  }
  const projectionMatches =
    Number(payload.version) === order.version &&
    String(payload.placement_mode) === order.placementMode &&
    String(payload.salt) === Buffer.from(order.salt).toString("hex") &&
    String(payload.maker) === order.maker &&
    String(payload.sell_token) === order.sellToken &&
    String(payload.sell_amount) === order.sellAmount.toString() &&
    String(payload.buy_token) === order.buyToken &&
    String(payload.min_buy_amount) === order.minBuyAmount.toString() &&
    Number(payload.valid_after_ledger) === order.validAfterLedger &&
    Number(payload.expires_at_ledger) === order.expiresAtLedger &&
    String(payload.executor_reward_xlm) === order.executorRewardXlm.toString();
  if (!projectionMatches) {
    throw new AquariusError(
      "limit-order registry JSON does not match canonical order XDR",
    );
  }
  const orderId = hash(orderScVal.toXDR()).toString("hex");
  if (payload.order_id !== orderId) {
    throw new AquariusError("limit-order ID does not match canonical order XDR");
  }

  let authorization: xdr.SorobanAuthorizationEntry | undefined;
  const authorizationXdr = payload.authorization_xdr;
  const placementLedger = payload.placement_ledger === null ||
    payload.placement_ledger === undefined
    ? null
    : Number(payload.placement_ledger);
  const placementHash = payload.placement_transaction_hash === null ||
    payload.placement_transaction_hash === undefined
    ? null
    : String(payload.placement_transaction_hash);
  if (order.placementMode === "DETACHED") {
    if (status === "OPEN" && !authorizationXdr) {
      throw new AquariusError("open detached limit order has no authorization");
    }
    if (authorizationXdr) {
      try {
        authorization = xdr.SorobanAuthorizationEntry.fromXDR(
          String(authorizationXdr),
          "base64",
        );
      } catch {
        throw new AquariusError("detached limit order has invalid authorization XDR");
      }
      validateAuthorizationTree(
        authorization,
        order,
        context.settlementAddress,
        context.xlmToken,
      );
    }
  } else if (authorizationXdr !== undefined && authorizationXdr !== null && authorizationXdr !== "") {
    throw new AquariusError("contract-on-chain order includes detached authorization");
  } else if (
    !Number.isInteger(placementLedger) ||
    placementLedger! <= 0 ||
    placementHash === null ||
    !/^[0-9a-f]{64}$/i.test(placementHash)
  ) {
    throw new AquariusError(
      "contract-on-chain order has no confirmed placement reference",
    );
  }

  return new LimitOrderRecord(
    orderId,
    status,
    order,
    authorization,
    context.settlementAddress,
    expectedNetworkId,
    placementLedger,
    placementHash,
    { ...payload },
    context.actions,
  );
}

function limitOrderFromScVal(value: xdr.ScVal): LimitOrder {
  const nativeValue = scValToNative(value) as unknown;
  if (!nativeValue || typeof nativeValue !== "object" || Array.isArray(nativeValue)) {
    throw new AquariusError("limit order is not a canonical OrderV1");
  }
  const native = nativeValue as Record<string, unknown>;
  if (Object.keys(native).sort().join(",") !== ORDER_FIELDS.join(",")) {
    throw new AquariusError("limit order is not a canonical OrderV1");
  }
  const placement = native.placement_mode;
  let placementMode: "DETACHED" | "CONTRACT_ONCHAIN";
  if (Array.isArray(placement) && placement.length === 1 && placement[0] === "Detached") {
    placementMode = "DETACHED";
  } else if (
    Array.isArray(placement) &&
    placement.length === 1 &&
    placement[0] === "ContractOnChain"
  ) {
    placementMode = "CONTRACT_ONCHAIN";
  } else {
    throw new AquariusError("limit order has an unsupported placement mode");
  }
  const salt = native.salt;
  if (!(salt instanceof Uint8Array)) {
    throw new AquariusError("limit-order salt must be bytes");
  }
  const order = new LimitOrder(
    Number(native.version),
    placementMode,
    salt,
    String(native.maker),
    String(native.sell_token),
    BigInt(String(native.sell_amount)),
    String(native.buy_token),
    BigInt(String(native.min_buy_amount)),
    Number(native.valid_after_ledger),
    Number(native.expires_at_ledger),
    BigInt(String(native.executor_reward_xlm)),
    value,
  );
  validateLimitOrder(order);
  return order;
}

function validateLimitOrder(order: LimitOrder): void {
  if (order.version !== 1) {
    throw new AquariusError("unsupported limit-order version");
  }
  if (order.placementMode === "DETACHED" && !order.maker.startsWith("G")) {
    throw new AquariusError("detached orders require a G-account maker");
  }
  if (order.salt.length !== 32) {
    throw new AquariusError("limit-order salt must be 32 bytes");
  }
  if (order.sellToken === order.buyToken) {
    throw new AquariusError("limit-order sell and buy tokens must differ");
  }
  const amounts = [order.sellAmount, order.minBuyAmount, order.executorRewardXlm];
  if (amounts.some(amount => amount <= 0n || amount > (1n << 127n) - 1n)) {
    throw new AquariusError("limit-order amounts must fit positive i128 values");
  }
  if (
    !Number.isInteger(order.validAfterLedger) ||
    !Number.isInteger(order.expiresAtLedger) ||
    order.validAfterLedger < 0 ||
    order.validAfterLedger > order.expiresAtLedger ||
    order.expiresAtLedger > 0xffffffff
  ) {
    throw new AquariusError("limit order has an invalid ledger window");
  }
}

export function validateAuthorizationTree(
  entry: xdr.SorobanAuthorizationEntry,
  order: LimitOrder,
  settlementAddress: string,
  xlmToken: string,
): void {
  if (
    entry.credentials().switch() !==
    xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()
  ) {
    throw new AquariusError("limit-order authorization must use ADDRESS_V2");
  }
  const credentials = entry.credentials().addressV2();
  if (Address.fromScAddress(credentials.address()).toString() !== order.maker) {
    throw new AquariusError("limit-order authorization maker does not match the order");
  }
  if (credentials.signatureExpirationLedger() !== order.expiresAtLedger) {
    throw new AquariusError(
      "limit-order authorization expiration does not match the order",
    );
  }
  if (credentials.signature().switch() === xdr.ScValType.scvVoid()) {
    throw new AquariusError("limit-order authorization is not signed");
  }
  const expected = authorizationInvocation(order, settlementAddress, xlmToken);
  if (!entry.rootInvocation().toXDR().equals(expected.toXDR())) {
    throw new AquariusError(
      "limit-order authorization invocation tree does not match the order",
    );
  }
}

function authorizationInvocation(
  order: LimitOrder,
  settlementAddress: string,
  xlmToken: string,
): xdr.SorobanAuthorizedInvocation {
  const maker = new Address(order.maker).toScVal();
  const settlement = new Address(settlementAddress).toScVal();
  const contractCall = (
    contract: string,
    functionName: string,
    args: xdr.ScVal[],
    subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
  ) =>
    new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contract).toScAddress(),
          functionName,
          args,
        }),
      ),
      subInvocations,
    });
  return contractCall(
    settlementAddress,
    "fill",
    [order.orderScVal],
    [
      contractCall(order.sellToken, "transfer", [
        maker,
        settlement,
        nativeToScVal(order.sellAmount, { type: "i128" }),
      ]),
      contractCall(xlmToken, "transfer", [
        maker,
        settlement,
        nativeToScVal(order.executorRewardXlm, { type: "i128" }),
      ]),
    ],
  );
}

export function routeScValFromSwapChain(swapChainXdr: string): xdr.ScVal {
  let chain: xdr.ScVal;
  try {
    chain = xdr.ScVal.fromXDR(swapChainXdr, "base64");
  } catch {
    throw new AquariusError("swap chain is not valid XDR");
  }
  if (
    chain.switch() !== xdr.ScValType.scvVec() ||
    !chain.vec() ||
    chain.vec()!.length === 0
  ) {
    throw new AquariusError("swap chain must be a non-empty vec");
  }
  return xdr.ScVal.scvVec(chain.vec()!.map(rawHop => {
    if (
      rawHop.switch() !== xdr.ScValType.scvVec() ||
      !rawHop.vec() ||
      rawHop.vec()!.length !== 3
    ) {
      throw new AquariusError("swap-chain hop must contain three fields");
    }
    const [poolTokens, poolIndex, tokenOut] = rawHop.vec()!;
    return xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: nativeToScVal("pool_index", { type: "symbol" }),
        val: poolIndex,
      }),
      new xdr.ScMapEntry({
        key: nativeToScVal("pool_tokens", { type: "symbol" }),
        val: poolTokens,
      }),
      new xdr.ScMapEntry({
        key: nativeToScVal("token_out", { type: "symbol" }),
        val: tokenOut,
      }),
    ]);
  }));
}

export function fillParameters(
  record: LimitOrderRecord,
  rewardTo: string,
  swapChainXdr: string,
): xdr.ScVal[] {
  return [
    record.order.orderScVal,
    new Address(rewardTo).toScVal(),
    routeScValFromSwapChain(swapChainXdr),
  ];
}

export function validateFillReceipt(
  record: LimitOrderRecord,
  rewardTo: string,
  value: xdr.ScVal,
): LimitOrderFillReceipt {
  let receipt: Record<string, unknown>;
  try {
    receipt = scValToNative(value) as Record<string, unknown>;
  } catch {
    throw new AquariusError("limit-order fill simulation returned an invalid receipt");
  }
  const orderId = receipt.order_id;
  if (
    !(orderId instanceof Uint8Array) ||
    Buffer.from(orderId).toString("hex") !== record.orderId ||
    typeof receipt.router_output !== "bigint" ||
    receipt.router_output < 0n ||
    typeof receipt.maker_buy_delta_before_reward !== "bigint" ||
    receipt.maker_buy_delta_before_reward < record.order.minBuyAmount ||
    receipt.reward_xlm !== record.order.executorRewardXlm ||
    receipt.reward_to !== rewardTo
  ) {
    throw new AquariusError(
      "limit-order fill receipt does not preserve maker payout and execution fee",
    );
  }
  return {
    orderId: record.orderId,
    routerOutput: receipt.router_output,
    makerBuyDeltaBeforeReward: receipt.maker_buy_delta_before_reward,
    rewardXlm: record.order.executorRewardXlm,
    rewardTo,
  };
}
