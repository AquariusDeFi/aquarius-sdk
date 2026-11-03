import { Buffer } from "buffer";
import {
  Address,
  authorizeEntry,
  Keypair,
  nativeToScVal,
  Operation,
  rpc,
  scValToNative,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";
import {
  PreparedLimitOrder,
  type LimitOrderSummary,
  type LimitOrderTransactionResult,
} from "./limit-order-prepared.js";
import {
  parseLimitOrderRecord,
  validateExecutorReward,
  type LimitOrderRecord,
  type LimitOrderPage,
  type LimitOrderRecordActions,
} from "./limit-orders.js";
import type { Signer } from "./signer.js";
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
  signer?: Signer;
  loadAccount(maker: string): Promise<LimitOrderAccount>;
  recordActions?: LimitOrderRecordActions;
  createSubmitter(): (transactionXdr: string) => Promise<LimitOrderTransactionResult>;
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
  ): Promise<LimitOrderPage> {
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
      orders: (data.orders as LimitOrderRecordPayload[]).map((item) => this.fromRecord(item)),
      nextCursor: nextCursor as string | null,
    };
  }

  async open(maker = this.context.signer?.publicKey()): Promise<LimitOrderRecord[]> {
    const orders: LimitOrderRecord[] = [];
    const seenCursors = new Set<string>();
    const seenIds = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10_000; page++) {
      const data = await this.list({ maker, status: "OPEN", cursor });
      for (const order of data.orders) {
        if (seenIds.has(order.orderId))
          throw new AquariusError("The order registry repeated an order across pages.");
        seenIds.add(order.orderId);
        orders.push(order);
      }
      if (data.nextCursor == null) return orders;
      if (seenCursors.has(data.nextCursor))
        throw new AquariusError("The order registry returned an invalid pagination cursor.");
      seenCursors.add(data.nextCursor);
      cursor = data.nextCursor;
    }
    throw new AquariusError("The order registry pagination exceeded the safety limit.");
  }

  history(maker = this.signer().publicKey(), cursor?: string, limit = 20): Promise<LimitOrderPage> {
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

  /** One bound record, with the same cancel/fill methods as registry results. */
  async get(orderId: string): Promise<LimitOrderRecord> {
    const payload = await this.context.api.getLimitOrder(this.context.apiUrl, orderId);
    const record = this.fromRecord(payload as LimitOrderRecordPayload);
    if (record.orderId !== orderId)
      throw new AquariusError("The registry returned a different order.");
    return record;
  }

  fromRecord(payload: LimitOrderRecordPayload): LimitOrderRecord {
    const raw = structuredClone(payload);
    this.validateRecord(raw, raw.maker);
    return parseLimitOrderRecord(raw, {
      networkPassphrase: this.context.passphrase,
      settlementAddress: this.contractId,
      xlmToken: Asset.native().contractId(this.context.passphrase),
      actions: this.context.recordActions,
    });
  }

  /** Resolve account capabilities, receive trustline, fee and ledger window before review. */
  async prepare(params: PrepareLimitOrderParams): Promise<PreparedLimitOrder> {
    const maker = this.signer().publicKey();
    if (new Address(maker).toString()[0] !== "G")
      throw new AquariusError("Wallet limit-order preparation requires a G-account maker.");
    const intent = snapshotIntent(params, this.context.passphrase);
    const { expiresIn } = intent;
    const [settings, latest, account] = await Promise.all([
      this.getSettlementConfig(),
      this.context.server.getLatestLedger(),
      this.context.loadAccount(maker),
    ]);
    if (this.signer().publicKey() !== maker)
      throw new AquariusError("The connected account changed. Review the order again.");
    const maxTtl = Math.min(settings.maxOrderTtl, LIMIT_ORDER_MAX_TTL_LEDGERS);
    // Expiration is approximate. The last ledger of the six-month allowance window is exclusive.
    if (expiresIn > (maxTtl + 1) * 5)
      throw new AquariusError("The order expiry exceeds the supported lifetime.");
    const duration = Math.min(Math.ceil(expiresIn / 5), maxTtl);
    if (!Number.isSafeInteger(latest.sequence) || latest.sequence < 0)
      throw new AquariusError("Invalid latest ledger.");
    const detached = this.canAuthorize(account, maker);
    const requireTrustline = this.needsTrustline(account, intent.to, maker);
    if (
      requireTrustline &&
      (await this.context.loadAccount(intent.to.issuer!)).flags?.auth_required
    ) {
      throw new AquariusError(
        "The receive asset requires issuer authorization before it can be received.",
      );
    }
    const expiresAtLedger = latest.sequence + duration;
    if (expiresAtLedger > 0xffffffff)
      throw new AquariusError("The order expiry exceeds the ledger range.");
    const approved: ResolvedLimitOrderParams = Object.freeze({
      ...intent,
      maker,
      placementMode: detached ? "DETACHED" : "CONTRACT_ONCHAIN",
      expectedExecutorRewardXlm: validateExecutorReward(BigInt(settings.executorRewardXlm)),
      validAfterLedger: latest.sequence,
      expiresAtLedger,
    });
    const request = this.request(approved);
    const raw = structuredClone(
      await this.context.api.createLimitOrderDraft(this.context.apiUrl, request),
    ) as LimitOrderDraftPayload;
    const xlm = Asset.native().contractId(this.context.passphrase);
    const allowTrust = Boolean(approved.to.issuer && approved.to.issuer !== maker);
    validateLimitOrderDraft(
      raw,
      request,
      this.contractId,
      xlm,
      settings.executorRewardXlm,
      this.context.passphrase,
      allowTrust,
      requireTrustline,
    );
    const summary: LimitOrderSummary = {
      maker,
      sellToken: request.sell_token,
      buyToken: request.buy_token,
      sellAmount: approved.sellAmount,
      minBuyAmount: approved.minBuyAmount,
      executorRewardXlm: approved.expectedExecutorRewardXlm,
      validAfterLedger: approved.validAfterLedger,
      expiresAtLedger: approved.expiresAtLedger,
      expiresIn: duration * 5,
      signing: detached ? "authorization" : "transaction",
      trustline: {
        required: requireTrustline,
        creation: requireTrustline ? (detached ? "execution" : "placement") : null,
      },
    };
    return new PreparedLimitOrder(raw, summary, {
      passphrase: this.context.passphrase,
      check: async () => {
        if (this.signer().publicKey() !== maker)
          throw new AquariusError("The connected account changed. Review the order again.");
        const [current, ledger, currentAccount] = await Promise.all([
          this.getSettlementConfig(),
          this.context.server.getLatestLedger(),
          this.context.loadAccount(maker),
        ]);
        if (current.executorRewardXlm !== settings.executorRewardXlm)
          throw new AquariusError("The execution fee changed. Review your order again.");
        if (
          ledger.sequence > approved.expiresAtLedger ||
          approved.expiresAtLedger >
            ledger.sequence + Math.min(current.maxOrderTtl, LIMIT_ORDER_MAX_TTL_LEDGERS)
        )
          throw new AquariusError("The order expiry is no longer valid. Review your order again.");
        if (detached && !this.canAuthorize(currentAccount, maker))
          throw new AquariusError("The account authorization changed. Review your order again.");
        if (!requireTrustline && this.needsTrustline(currentAccount, approved.to, maker))
          throw new AquariusError("The receive trustline changed. Review your order again.");
        if (this.signer().publicKey() !== maker)
          throw new AquariusError("The connected account changed. Review the order again.");
      },
      signAuthorization: async (entry) => {
        const signer = this.signer();
        if (signer.signAuthEntry) return signer.signAuthEntry(entry);
        if ("secret" in signer)
          return (
            await authorizeEntry(
              xdr.SorobanAuthorizationEntry.fromXDR(entry, "base64"),
              Keypair.fromSecret(signer.secret()),
              approved.expiresAtLedger,
              this.context.passphrase,
            )
          ).toXDR("base64");
        throw new AquariusError("The signer no longer supports detached authorization.");
      },
      authorize: async (signed) => {
        if (raw.placement_mode !== "DETACHED")
          throw new AquariusError("On-chain orders require a placement transaction.");
        const signature = await normalizeSignedAuthEntry(
          raw.unsigned_authorization_xdr,
          signed,
          maker,
          this.context.passphrase,
        );
        const result = (await this.context.api.authorizeLimitOrder(
          this.context.apiUrl,
          raw.order_id,
          signature,
        )) as LimitOrderRecordPayload;
        this.validateRecord(result, maker);
        if (result.order_id !== raw.order_id)
          throw new AquariusError(
            "The registry returned a different order. Refresh your orders before trying again.",
          );
        return this.fromRecord(result);
      },
      buildTransaction: () => {
        if (raw.placement_mode !== "CONTRACT_ONCHAIN")
          throw new AquariusError(
            "Detached orders use an authorization entry, not a placement transaction.",
          );
        return this.buildPlacementTransaction(raw, xlm, requireTrustline, {
          request,
          executorRewardXlm: settings.executorRewardXlm,
        });
      },
      submitTransaction: this.context.createSubmitter(),
      record: (payload) => this.fromRecord(payload),
    });
  }

  private signer(): Signer {
    if (!this.context.signer)
      throw new AquariusError("This operation requires a signer — pass one in the client config");
    return this.context.signer;
  }

  private canAuthorize(account: LimitOrderAccount, maker: string): boolean {
    const signer = this.signer();
    if (!signer.signAuthEntry && !("secret" in signer)) return false;
    if (!Array.isArray(account.signers) || !account.thresholds)
      throw new AquariusError("Could not verify account signing requirements.");
    const active = account.signers.filter((item) => item.weight > 0);
    return (
      active.length === 1 &&
      active[0].key === maker &&
      active[0].type === "ed25519_public_key" &&
      active[0].weight >=
        Math.max(
          1,
          account.thresholds.low_threshold,
          account.thresholds.med_threshold,
          account.thresholds.high_threshold,
        )
    );
  }

  private needsTrustline(account: LimitOrderAccount, asset: Asset, maker: string): boolean {
    if (!Array.isArray(account.balances))
      throw new AquariusError("Could not verify account balances.");
    if (!asset.issuer || asset.issuer === maker) return false;
    const balance = account.balances.find(
      (item) => item.asset_code === asset.code && item.asset_issuer === asset.issuer,
    );
    if (balance?.is_authorized === false)
      throw new AquariusError("The receive trustline requires issuer authorization.");
    return !balance;
  }

  private request(params: ResolvedLimitOrderParams): LimitOrderDraftRequest {
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

interface ResolvedLimitOrderParams extends PrepareLimitOrderParams {
  maker: string;
  placementMode: "DETACHED" | "CONTRACT_ONCHAIN";
  validAfterLedger: number;
  expiresAtLedger: number;
  expectedExecutorRewardXlm: bigint;
}

function snapshotIntent(
  params: PrepareLimitOrderParams,
  passphrase: string,
): PrepareLimitOrderParams {
  if (
    [params.sellAmount, params.minBuyAmount].some(
      (value) => typeof value !== "bigint" || value <= 0n || value > (1n << 127n) - 1n,
    )
  )
    throw new AquariusError("Limit-order amounts must fit positive i128 values.");
  if (!Number.isSafeInteger(params.expiresIn) || params.expiresIn <= 0)
    throw new AquariusError("Order expiry must be a positive number of seconds.");
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
  return Object.freeze({
    from: Object.freeze(from),
    to: Object.freeze(to),
    sellAmount: params.sellAmount,
    minBuyAmount: params.minBuyAmount,
    expiresIn: params.expiresIn,
  });
}

export interface PrepareLimitOrderParams {
  from: Asset;
  to: Asset;
  sellAmount: bigint;
  minBuyAmount: bigint;
  /** Approximate duration in seconds, bounded by the settlement's maximum allowance lifetime. */
  expiresIn: number;
}

/** @internal Horizon account data shared by capability and trustline detection. */
export interface LimitOrderAccount {
  balances: { asset_code?: string; asset_issuer?: string; is_authorized?: boolean }[];
  signers: { key: string; type: string; weight: number }[];
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
  flags?: { auth_required?: boolean };
}
