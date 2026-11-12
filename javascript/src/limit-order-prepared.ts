import { Buffer } from "buffer";
import { Transaction } from "@stellar/stellar-sdk";
import { AquariusError } from "./errors.js";
import type { LimitOrderRecord } from "./limit-orders.js";
import type {
  LimitOrderDraftPayload,
  ContractLimitOrderDraftPayload,
  LimitOrderRecordPayload,
} from "./limit-order-types.js";

export interface LimitOrderSummary {
  readonly maker: string;
  readonly sellToken: string;
  readonly buyToken: string;
  readonly sellAmount: bigint;
  readonly minBuyAmount: bigint;
  readonly executorRewardXlm: bigint;
  readonly validAfterLedger: number;
  readonly expiresAtLedger: number;
  /** Approximate duration in seconds; actual expiration is ledger-based. */
  readonly expiresIn: number;
  readonly signing: "authorization" | "transaction";
  readonly trustline: Readonly<{ required: boolean; creation: "execution" | "placement" | null }>;
}

export type LimitOrderTransactionResult =
  | { status: "confirmed"; transactionHash: string; ledger: number; createdAt: number | string }
  | { status: "pending"; transactionHash: string }
  | { status: "failed" };

export interface PendingLimitOrder {
  status: "PENDING_SIGNATURES";
  draft: ContractLimitOrderDraftPayload;
  transactionHash: string;
}

/** Optional adapters for an application's existing Vault/external-signature flow. */
export interface LimitOrderPlaceOptions {
  submitTransaction: (transactionXdr: string) => Promise<LimitOrderTransactionResult>;
  prepareTransaction?: (build: () => Promise<string>) => Promise<string>;
}

/** @internal */
export interface PreparedLimitOrderActions {
  passphrase: string;
  check(): Promise<void>;
  signAuthorization(entry: string): Promise<string>;
  authorize(signature: string): Promise<LimitOrderRecord>;
  buildTransaction(): Promise<string>;
  submitTransaction(transactionXdr: string): Promise<LimitOrderTransactionResult>;
  record(payload: LimitOrderRecordPayload): LimitOrderRecord;
}

/** Review summary, then place. Reuse this object on retry to retain the same order and proof. */
export class PreparedLimitOrder {
  readonly summary: Readonly<LimitOrderSummary>;
  private readonly payload: LimitOrderDraftPayload;
  private signature?: string;
  private transaction?: string;
  private placed?: LimitOrderRecord;
  private inFlight?: Promise<LimitOrderRecord | PendingLimitOrder>;

  constructor(
    payload: LimitOrderDraftPayload,
    summary: LimitOrderSummary,
    private readonly actions: PreparedLimitOrderActions,
  ) {
    this.payload = structuredClone(payload);
    this.summary = Object.freeze({
      ...summary,
      trustline: Object.freeze({ ...summary.trustline }),
    });
  }
  get orderId(): string {
    return this.payload.order_id;
  }
  get raw(): LimitOrderDraftPayload {
    return structuredClone(this.payload);
  }
  /** Escape hatch for external authorization signers. */
  get authorizationEntryXdr(): string {
    if (this.payload.placement_mode !== "DETACHED")
      throw new AquariusError("On-chain orders have no detached authorization.");
    return this.payload.unsigned_authorization_xdr;
  }
  /** Escape hatch: returns unsigned XDR, without signing or submitting. */
  async buildTransaction(): Promise<string> {
    await this.actions.check();
    return this.actions.buildTransaction();
  }
  /** Escape hatch: verifies and publishes an externally signed entry. */
  async authorize(signature: string): Promise<LimitOrderRecord> {
    await this.actions.check();
    return this.actions.authorize(signature);
  }

  place(): Promise<LimitOrderRecord>;
  place(options: LimitOrderPlaceOptions): Promise<LimitOrderRecord | PendingLimitOrder>;
  place(options?: LimitOrderPlaceOptions): Promise<LimitOrderRecord | PendingLimitOrder> {
    if (this.placed) return Promise.resolve(this.placed);
    if (!this.inFlight)
      this.inFlight = this.execute(options).finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async execute(
    options?: LimitOrderPlaceOptions,
  ): Promise<LimitOrderRecord | PendingLimitOrder> {
    await this.actions.check();
    if (this.payload.placement_mode === "DETACHED") {
      this.signature ??= await this.actions.signAuthorization(this.authorizationEntryXdr);
      await this.actions.check();
      this.placed = await this.actions.authorize(this.signature);
      return this.placed;
    }
    this.transaction ??= await (options?.prepareTransaction
      ? options.prepareTransaction(() => this.actions.buildTransaction())
      : this.actions.buildTransaction());
    const expectedHash = Buffer.from(
      new Transaction(this.transaction, this.actions.passphrase).hash(),
    ).toString("hex");
    const result = await (options?.submitTransaction ?? this.actions.submitTransaction)(
      this.transaction,
    );
    if (result.status === "failed") {
      this.transaction = undefined;
      throw new AquariusError("The placement transaction failed. Retry to sign a new transaction.");
    }
    if (result.transactionHash !== expectedHash)
      throw new AquariusError("The placement receipt belongs to another transaction.");
    if (result.status === "pending")
      return {
        status: "PENDING_SIGNATURES",
        draft: structuredClone(this.payload),
        transactionHash: expectedHash,
      };
    // RPC returns Unix seconds as a string, even though Stellar SDK types it as number.
    const createdAt =
      typeof result.createdAt === "number"
        ? result.createdAt
        : typeof result.createdAt === "string" && /^\d+$/.test(result.createdAt)
          ? Number(result.createdAt)
          : NaN;
    if (
      result.status !== "confirmed" ||
      !Number.isInteger(result.ledger) ||
      result.ledger <= 0 ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < 0 ||
      !Number.isFinite(new Date(createdAt * 1000).getTime())
    ) {
      throw new AquariusError("The placement transaction is not confirmed yet.");
    }
    this.placed = this.actions.record({
      ...this.payload,
      status: "OPEN",
      placement_ledger: result.ledger,
      placement_transaction_hash: expectedHash,
      updated_at: new Date(createdAt * 1000).toISOString(),
    });
    return this.placed;
  }
}
