import { Buffer } from "buffer";
import {
  Address,
  nativeToScVal,
  Operation,
  rpc,
  scValToNative,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import { Asset } from "./assets.js";
import { normalizeSignedAuthEntry } from "./limit-order-auth.js";
import { ApiClient } from "./api.js";
import { authorizedInvocation, sourceAccountEntry } from "./authorization.js";
import { batchOperation, type BatchCall } from "./batch.js";
import { AquariusError } from "./errors.js";
import { readTokenAllowances } from "./limit-order-allowance.js";
import { assertLimitOrderAuthorization } from "./limit-order-transaction.js";
import { validateLimitOrderDraft, validateLimitOrderRecord } from "./limit-order-validation.js";
import {
  LIMIT_ORDER_MAX_TTL_LEDGERS,
  type ContractLimitOrderDraftPayload,
  type LimitOrderDraftRequest,
  type LimitOrderRecordPayload,
  type LimitOrderDraftPayload,
  type LimitOrderListPayload,
} from "./limit-order-types.js";

/** @internal Uses the same transports and unsigned prepare flow as pools and swaps. */
export interface LimitOrderContext {
  passphrase: string;
  settlement: string;
  batcher?: string;
  guard?: string;
  apiUrl: string;
  api: ApiClient;
  server: Pick<rpc.Server, "getLedgerEntries" | "getLatestLedger">;
  readBatch(calls: BatchCall[]): Promise<xdr.ScVal[]>;
  readContract(contract: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal>;
  prepare(maker: string, operation: xdr.Operation): Promise<Transaction>;
}
const batchCall = (contractId: string, fn: string, args: xdr.ScVal[]): BatchCall => ({
  contractId,
  fn,
  args,
});
const LIMIT_ORDER_METHOD = {
  cancel: "cancel",
  getMaxOrderTtl: "get_max_order_ttl",
  getExecutorReward: "get_executor_reward",
} as const;

export type LimitOrderSettlementConfig = {
  maxOrderTtl: number;
  // stroops, as a base-10 string (u128 on-chain)
  executorRewardXlm: string;
};

export class LimitOrderManager {
  constructor(private readonly context: LimitOrderContext) {}
  private get contractId() {
    return this.context.settlement;
  }

  /** Read a bounded page. History is sorted by completion, not creation ID. */
  async list(
    params: {
      maker?: string;
      status?: string;
      sort?: "-completed_at";
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<LimitOrderListPayload> {
    const limit = params.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AquariusError("limit-order page size must be between 1 and 100");
    const query: Record<string, string> = { limit: String(limit) };
    for (const name of ["maker", "status", "sort", "cursor"] as const) {
      if (params[name] !== undefined) query[name] = params[name]!;
    }
    const data = await this.context.api.listLimitOrders(this.context.apiUrl, query);
    if (!Array.isArray(data.orders))
      throw new AquariusError("The order registry returned an invalid orders page.");
    const nextCursor = data.next_cursor ?? null;
    if (
      nextCursor !== null &&
      (typeof nextCursor !== "string" || !nextCursor || nextCursor === params.cursor)
    ) {
      throw new AquariusError("The order registry returned an invalid pagination cursor.");
    }
    const statuses = params.status?.toUpperCase().split(",") ?? [
      "OPEN",
      "FILLED",
      "CANCELLED",
      "EXPIRED",
    ];
    for (const item of data.orders as LimitOrderRecordPayload[]) {
      this.validateRecord(item, params.maker ?? item.maker);
      if (!statuses.includes(item.status))
        throw new AquariusError("The order registry returned an unexpected order status.");
    }
    return {
      orders: data.orders as LimitOrderRecordPayload[],
      next_cursor: nextCursor as string | null,
    };
  }

  async open(maker?: string): Promise<LimitOrderListPayload> {
    const orders: LimitOrderRecordPayload[] = [];
    const seenCursors = new Set<string>();
    const seenIds = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10_000; page++) {
      const data = await this.list({ maker, status: "OPEN", cursor });
      for (const order of data.orders) {
        if (seenIds.has(order.order_id))
          throw new AquariusError("The order registry repeated an order across pages.");
        seenIds.add(order.order_id);
        orders.push(order);
      }
      if (data.next_cursor == null) return { orders, next_cursor: null };
      if (seenCursors.has(data.next_cursor))
        throw new AquariusError("The order registry returned an invalid pagination cursor.");
      seenCursors.add(data.next_cursor);
      cursor = data.next_cursor;
    }
    throw new AquariusError("The order registry pagination exceeded the safety limit.");
  }

  history(maker: string, cursor?: string, limit = 20): Promise<LimitOrderListPayload> {
    return this.list({
      maker,
      cursor,
      limit,
      status: "FILLED,CANCELLED,EXPIRED",
      sort: "-completed_at",
    });
  }

  validateRecord(record: LimitOrderRecordPayload, maker: string): xdr.ScVal {
    return validateLimitOrderRecord(record, this.contractId, maker, this.context.passphrase, [
      "OPEN",
      "FILLED",
      "CANCELLED",
      "EXPIRED",
    ]);
  }

  /** Draft first, sign later. All values are copied before the first network request. */
  async create(params: CreateLimitOrderParams): Promise<PreparedLimitOrder> {
    const approved = snapshotParams(params, this.context.passphrase);
    const request = this.request(approved);
    const [settings, latest] = await Promise.all([
      this.getSettlementConfig(),
      this.context.server.getLatestLedger(),
    ]);
    if (settings.executorRewardXlm !== approved.expectedExecutorRewardXlm.toString())
      throw new AquariusError("The execution fee changed. Review your order again.");
    if (
      !Number.isInteger(latest.sequence) ||
      latest.sequence < 0 ||
      approved.expiresAtLedger < latest.sequence ||
      approved.expiresAtLedger >
        latest.sequence + Math.min(settings.maxOrderTtl, LIMIT_ORDER_MAX_TTL_LEDGERS)
    ) {
      throw new AquariusError("The order expiry is no longer valid. Review your order again.");
    }
    const payload = await this.context.api.createLimitOrderDraft(this.context.apiUrl, request);
    return this.fromDraft(payload as LimitOrderDraftPayload, approved);
  }

  /** Reuse a saved draft after a lost response; never silently create another order. */
  fromDraft(payload: LimitOrderDraftPayload, params: CreateLimitOrderParams): PreparedLimitOrder {
    const approved = snapshotParams(params, this.context.passphrase);
    const request = this.request(approved);
    const raw = structuredClone(payload);
    const xlm = Asset.native().contractId(this.context.passphrase);
    const allowTrust =
      approved.to.issuer !== undefined &&
      approved.to.issuer !== approved.maker &&
      request.buy_token !== xlm;
    validateLimitOrderDraft(
      raw,
      request,
      this.contractId,
      xlm,
      approved.expectedExecutorRewardXlm.toString(),
      this.context.passphrase,
      allowTrust,
      Boolean(approved.requireTrustline),
    );
    return new PreparedLimitOrder(raw, {
      buildTransaction: async () => {
        if (raw.placement_mode !== "CONTRACT_ONCHAIN")
          throw new AquariusError(
            "Detached orders use an authorization entry, not a placement transaction.",
          );
        return this.buildPlacementTransaction(
          raw,
          xlm,
          allowTrust && Boolean(approved.requireTrustline),
          { request, executorRewardXlm: approved.expectedExecutorRewardXlm.toString() },
        );
      },
      authorize: async (signed) => {
        if (raw.placement_mode !== "DETACHED")
          throw new AquariusError("On-chain orders require a placement transaction.");
        const signature = await normalizeSignedAuthEntry(
          raw.unsigned_authorization_xdr,
          signed,
          request.maker,
          this.context.passphrase,
        );
        const result = (await this.context.api.authorizeLimitOrder(
          this.context.apiUrl,
          raw.order_id,
          signature,
        )) as LimitOrderRecordPayload;
        this.validateRecord(result, request.maker);
        if (result.order_id !== raw.order_id)
          throw new AquariusError(
            "The registry returned a different order. Refresh your orders before trying again.",
          );
        return result;
      },
    });
  }

  private request(params: CreateLimitOrderParams): LimitOrderDraftRequest {
    return {
      placement_mode: params.placementMode,
      maker: params.maker,
      sell_token: params.from.contractId(this.context.passphrase),
      sell_amount: params.sellAmount.toString(),
      buy_token: params.to.contractId(this.context.passphrase),
      min_buy_amount: params.minBuyAmount.toString(),
      valid_after_ledger: params.validAfterLedger,
      expires_at_ledger: params.expiresAtLedger,
    };
  }

  async buildPlacementTransaction(
    draft: ContractLimitOrderDraftPayload,
    xlmToken: string,
    addTrustline: boolean,
    approval: { request: LimitOrderDraftRequest; executorRewardXlm: string },
  ) {
    const request = { ...approval.request };
    const { executorRewardXlm } = approval;
    if (xlmToken !== Asset.native().contractId(this.context.passphrase))
      throw new AquariusError(
        "The execution reward token must be native XLM on the configured network.",
      );
    validateLimitOrderDraft(
      draft,
      request,
      this.contractId,
      xlmToken,
      executorRewardXlm,
      this.context.passphrase,
    );
    const { batcher, guard } = this.context;
    if (!batcher || !guard)
      throw new AquariusError(
        "On-chain placement requires trusted batcher and guard configuration.",
      );
    const makerAddress = request.maker;
    const orderId = draft.order_id;
    const expiration = request.expires_at_ledger;
    const maker = new Address(makerAddress).toScVal();
    const spender = new Address(this.contractId).toScVal();
    const required = new Map([[request.sell_token, BigInt(request.sell_amount)]]);
    required.set(xlmToken, (required.get(xlmToken) ?? 0n) + BigInt(executorRewardXlm));
    if ([...required.values()].some((amount) => amount > (1n << 127n) - 1n))
      throw new AquariusError("The token allowance exceeds the supported amount.");
    const tokens = [...required.keys()];
    const [allowances, snapshot, settings] = await Promise.all([
      this.context.readBatch(
        tokens.map((token) => batchCall(token, "allowance", [maker, spender])),
      ),
      readTokenAllowances(this.context.server, tokens, makerAddress, this.contractId),
      this.getSettlementConfig(),
    ]);
    if (settings.executorRewardXlm !== executorRewardXlm)
      throw new AquariusError("The execution fee changed. Review your order again.");
    if (
      expiration < snapshot.latestLedger ||
      expiration >
        snapshot.latestLedger + Math.min(settings.maxOrderTtl, LIMIT_ORDER_MAX_TTL_LEDGERS)
    )
      throw new AquariusError("The order expiry is no longer valid. Review your order again.");
    if (allowances.length !== tokens.length)
      throw new AquariusError("Could not read the current token allowance.");
    const calls: BatchCall[] = [];
    const authorizations: xdr.SorobanAuthorizedInvocation[] = [];
    const assertResult = (
      contract: string,
      method: string,
      args: xdr.ScVal[],
      expected: xdr.ScVal,
    ) => {
      // These read-only guards need no maker auth. The batch's signed
      // arguments pin them, and a mismatch rolls back the whole batch.
      calls.push(
        batchCall(guard, "assert_result", [
          xdr.ScVal.scvVec([]),
          new Address(contract).toScVal(),
          xdr.ScVal.scvSymbol(method),
          xdr.ScVal.scvVec(args),
          expected,
        ]),
      );
    };
    assertResult(
      this.contractId,
      LIMIT_ORDER_METHOD.getExecutorReward,
      [],
      nativeToScVal(BigInt(executorRewardXlm), { type: "u128" }),
    );
    // Placement itself is idempotent; a repeated draft must not add its
    // allowance budget again in a different transaction.
    assertResult(
      this.contractId,
      "get_order_state",
      [maker, xdr.ScVal.scvBytes(Buffer.from(orderId, "hex"))],
      xdr.ScVal.scvVoid(),
    );
    tokens.forEach((token, index) => {
      const current = allowances[index];
      if (
        current?.type !== "scvI128" ||
        scValToNative(current) !== snapshot.allowances[index].amount
      )
        throw new AquariusError("The token allowance changed or could not be verified.");
      // Prevent a stale or forged read from overwriting another order's
      // approval (or restoring a budget already spent by a fill).
      assertResult(token, "allowance", [maker, spender], current);
    });
    const addCall = (contract: string, method: string, args: xdr.ScVal[], authArgs = args) => {
      calls.push(batchCall(contract, method, args));
      authorizations.push(authorizedInvocation(contract, method, authArgs));
    };
    if (addTrustline) addCall(request.buy_token, "trust", [maker]);
    tokens.forEach((token, index) => {
      const current = snapshot.allowances[index];
      const amount = current.amount + required.get(token)!;
      if (amount > (1n << 127n) - 1n)
        throw new AquariusError("The token allowance exceeds the supported amount.");
      addCall(token, "approve", [
        maker,
        spender,
        nativeToScVal(amount, { type: "i128" }),
        xdr.ScVal.scvU32(Math.max(current.expiration, expiration)),
      ]);
    });
    const placementArgs = [
      xdr.ScVal.scvBytes(Buffer.from(orderId, "hex")),
      xdr.ScVal.scvU32(expiration),
    ];
    // place_contract_order uses require_auth_for_args(order_id, expiry):
    // its authorization deliberately omits the maker parameter.
    addCall(this.contractId, "place_contract_order", [maker, ...placementArgs], placementArgs);
    const operation = batchOperation(batcher, makerAddress, calls, authorizations, true);
    const expectedOperation = operation.toXDR("base64");
    const prepared = await this.context.prepare(makerAddress, operation);
    assertLimitOrderAuthorization(prepared, makerAddress, expectedOperation);
    const refreshed = await readTokenAllowances(
      this.context.server,
      tokens,
      makerAddress,
      this.contractId,
    );
    if (
      refreshed.latestLedger < snapshot.latestLedger ||
      refreshed.allowances.some(
        (value, index) =>
          value.amount !== snapshot.allowances[index].amount ||
          value.expiration !== snapshot.allowances[index].expiration,
      )
    )
      throw new AquariusError("The token allowance changed. Review your order again.");
    return prepared.toXDR();
  }

  async buildCancelTransaction(accountId: string, order: LimitOrderRecordPayload): Promise<string> {
    const orderValue = validateLimitOrderRecord(
      order,
      this.contractId,
      accountId,
      this.context.passphrase,
    );
    const args = [orderValue];
    const operation = Operation.invokeContractFunction({
      contract: this.contractId,
      function: "cancel",
      args,
      auth: [sourceAccountEntry(authorizedInvocation(this.contractId, "cancel", args))],
    });
    const expectedOperation = operation.toXDR("base64");
    const prepared = await this.context.prepare(accountId, operation);
    assertLimitOrderAuthorization(prepared, accountId, expectedOperation);
    return prepared.toXDR();
  }

  async getSettlementConfig(): Promise<LimitOrderSettlementConfig> {
    const [maxOrderTtl, executorReward] = await Promise.all([
      this.readView(LIMIT_ORDER_METHOD.getMaxOrderTtl),
      this.readView(LIMIT_ORDER_METHOD.getExecutorReward),
    ]);
    const config = {
      maxOrderTtl: Number(scValToNative(maxOrderTtl)),
      executorRewardXlm: String(scValToNative(executorReward)),
    };
    if (
      !Number.isInteger(config.maxOrderTtl) ||
      config.maxOrderTtl <= 0 ||
      !/^\d+$/.test(config.executorRewardXlm) ||
      BigInt(config.executorRewardXlm) <= 0n
    ) {
      throw new AquariusError("The settlement returned an invalid expiry or execution fee.");
    }
    return config;
  }

  private readView(method: string): Promise<xdr.ScVal> {
    return this.context.readContract(this.contractId, method, []);
  }
}

export interface CreateLimitOrderParams {
  maker: string;
  placementMode: "DETACHED" | "CONTRACT_ONCHAIN";
  from: Asset;
  to: Asset;
  sellAmount: bigint;
  minBuyAmount: bigint;
  validAfterLedger: number;
  expiresAtLedger: number;
  expectedExecutorRewardXlm: bigint;
  /** A missing classic receive trustline. Detached auth grants trust at fill; on-chain placement adds it now. */
  requireTrustline?: boolean;
}

function snapshotParams(
  params: CreateLimitOrderParams,
  passphrase: string,
): CreateLimitOrderParams {
  const amounts = [params.sellAmount, params.minBuyAmount, params.expectedExecutorRewardXlm];
  if (
    amounts.some(
      (value) => typeof value !== "bigint" || value <= 0n || value > (1n << 127n) - 1n,
    ) ||
    !["DETACHED", "CONTRACT_ONCHAIN"].includes(params.placementMode) ||
    !Number.isInteger(params.validAfterLedger) ||
    !Number.isInteger(params.expiresAtLedger) ||
    params.validAfterLedger < 0 ||
    params.validAfterLedger > params.expiresAtLedger ||
    params.expiresAtLedger > 0xffffffff
  ) {
    throw new AquariusError("Invalid limit-order amounts or ledger window.");
  }
  const maker = new Address(params.maker);
  if (maker.toString()[0] !== "G")
    throw new AquariusError("Wallet limit-order preparation requires a G-account maker.");
  const copyAsset = (asset: Asset) =>
    asset.isNative
      ? Asset.native()
      : asset.issuer
        ? Asset.classic(asset.code!, asset.issuer)
        : Asset.contract(asset.contractId(passphrase));
  const from = copyAsset(params.from);
  const to = copyAsset(params.to);
  const sell = from.contractId(passphrase);
  const buy = to.contractId(passphrase);
  if (sell === buy || !sell.startsWith("C") || !buy.startsWith("C"))
    throw new AquariusError("A limit order requires two different token contracts.");
  new Address(sell);
  new Address(buy);
  if (params.requireTrustline && (!to.issuer || to.issuer === params.maker))
    throw new AquariusError(
      "A trustline requires a classic receive asset issued by another account.",
    );
  return Object.freeze({ ...params, from: Object.freeze(from), to: Object.freeze(to) });
}

export class PreparedLimitOrder {
  private readonly payload: LimitOrderDraftPayload;
  constructor(
    payload: LimitOrderDraftPayload,
    private readonly actions: {
      buildTransaction(): Promise<string>;
      authorize(signature: string): Promise<LimitOrderRecordPayload>;
    },
  ) {
    this.payload = structuredClone(payload);
  }
  get raw(): LimitOrderDraftPayload {
    return structuredClone(this.payload);
  }
  get orderId(): string {
    return this.payload.order_id;
  }
  get authorizationEntryXdr(): string {
    if (this.payload.placement_mode !== "DETACHED")
      throw new AquariusError("On-chain orders have no detached authorization.");
    return this.payload.unsigned_authorization_xdr;
  }
  buildTransaction(): Promise<string> {
    return this.actions.buildTransaction();
  }
  authorize(signature: string): Promise<LimitOrderRecordPayload> {
    return this.actions.authorize(signature);
  }
}
