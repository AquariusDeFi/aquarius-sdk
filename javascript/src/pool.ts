import { Buffer } from "buffer";

import { Address, StrKey, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

import { Asset } from "./assets.js";
import { AquariusError } from "./errors.js";
import { ConfirmedTx } from "./submit.js";

/** On-chain pool_type symbols -> the names the documentation uses. */
const POOL_TYPES: Record<string, PoolType> = {
  constant_product: "volatile",
  stable: "stable",
  concentrated: "concentrated",
};

export type PoolType = "volatile" | "stable" | "concentrated";

/** Amounts for a deposit: entries of [asset, amount], or a bigint list in sorted-token order. */
export type DepositAmounts = Array<[Asset | string, bigint]> | bigint[];

export interface DepositResult {
  txHash: string;
  /** Base units actually deposited, in sorted-token order. */
  amounts: bigint[];
  /** Pool share tokens minted. */
  shares: bigint;
}

export interface WithdrawResult {
  txHash: string;
  /** Base units returned, in sorted-token order. */
  amounts: bigint[];
}

export interface ClaimResult {
  txHash: string;
  /** AQUA claimed, in stroops. */
  amount: bigint;
}

export interface Position {
  pool: Pool;
  shares: bigint;
}

/** @internal What Pool needs from the client. */
export interface PoolContext {
  passphrase: string;
  readSource(requireSigner?: boolean): string;
  readRouter(fn: string, args: xdr.ScVal[]): Promise<xdr.ScVal>;
  readContract(contractId: string, fn: string, args: xdr.ScVal[]): Promise<xdr.ScVal>;
  submitRouter(fn: string, args: xdr.ScVal[], withUser: boolean): Promise<ConfirmedTx>;
}

// --- helpers shared with the client ------------------------------------------------

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** Order token contract IDs the way the contracts require (by contract ID bytes). */
export function sortTokenIds(contractIds: string[]): string[] {
  return [...contractIds].sort((a, b) =>
    compareBytes(StrKey.decodeContract(a), StrKey.decodeContract(b)),
  );
}

/** @internal Resolve deposit amounts into the sorted-token order the contract expects. */
export function resolveAmounts(
  amounts: DepositAmounts,
  tokens: string[],
  passphrase: string,
): bigint[] {
  if (amounts.length > 0 && !Array.isArray(amounts[0])) {
    if (amounts.length !== tokens.length) {
      throw new AquariusError(
        `Expected ${tokens.length} amounts in sorted-token order, got ${amounts.length}`,
      );
    }
    return (amounts as bigint[]).map(BigInt);
  }
  const resolved = new Map(tokens.map(t => [t, 0n]));
  for (const [key, value] of amounts as Array<[Asset | string, bigint]>) {
    const contractId = key instanceof Asset ? key.contractId(passphrase) : key;
    if (!resolved.has(contractId)) {
      throw new AquariusError(`Token ${contractId} is not part of this pool`);
    }
    resolved.set(contractId, BigInt(value));
  }
  return tokens.map(t => resolved.get(t)!);
}

/** @internal Map a /pools API entry to pool attributes. */
export function parsePoolMeta(meta: { pool_type: string; fee: string; tokens_str?: string[] }): {
  type: PoolType;
  feeBps: number;
  labels: string[];
} {
  return {
    type: POOL_TYPES[meta.pool_type] ?? (meta.pool_type as PoolType),
    feeBps: Math.round(parseFloat(meta.fee) * 10_000),
    labels: meta.tokens_str ?? [],
  };
}

/** @internal get_pools result: Map<BytesN<32>, Address> -> [pool hash, pool address]. */
export function parsePoolsMap(value: xdr.ScVal): Array<[Uint8Array, string]> {
  const entries: Array<[Uint8Array, string]> = [];
  for (const entry of value.map() ?? []) {
    entries.push([
      entry.key().bytes(),
      Address.fromScAddress(entry.val().address()).toString(),
    ]);
  }
  return entries;
}

const u128 = (value: bigint) => nativeToScVal(value, { type: "u128" });

// --- the pool object -----------------------------------------------------------------

/** One liquidity pool: reads need no signer, writes go through the router. */
export class Pool {
  private shareToken_?: string;

  constructor(
    readonly address: string,
    readonly poolHash: Uint8Array,
    readonly type: PoolType,
    /** Fee in basis points. */
    readonly feeBps: number,
    /** Token contract IDs in the contract's sorted order. */
    readonly tokens: string[],
    readonly tokenLabels: string[],
    private readonly ctx: PoolContext,
  ) {}

  // -- reads (no signer required) --------------------------------------------

  /** Pool reserves in base units, in sorted-token order. */
  async reserves(): Promise<bigint[]> {
    return scValToNative(await this.readRouter("get_reserves")) as bigint[];
  }

  async totalShares(): Promise<bigint> {
    return scValToNative(await this.readRouter("get_total_shares")) as bigint;
  }

  /** The pool's share token contract ID. */
  async shareToken(): Promise<string> {
    if (!this.shareToken_) {
      const value = await this.readRouter("share_id");
      this.shareToken_ = Address.fromScAddress(value.address()).toString();
    }
    return this.shareToken_;
  }

  /** Pool shares held by the address (default: the signer's account). */
  async shareBalance(address?: string): Promise<bigint> {
    const holder = address ?? this.ctx.readSource(true);
    const value = await this.ctx.readContract(await this.shareToken(), "balance", [
      new Address(holder).toScVal(),
    ]);
    return scValToNative(value) as bigint;
  }

  /** Accrued, unclaimed AQUA rewards in stroops (default: the signer's account). */
  async pendingRewards(address?: string): Promise<bigint> {
    const holder = address ?? this.ctx.readSource(true);
    const value = await this.ctx.readRouter("get_user_reward", [
      new Address(holder).toScVal(),
      ...this.baseArgs(),
    ]);
    return scValToNative(value) as bigint;
  }

  // -- writes ------------------------------------------------------------------

  /**
   * Deposit liquidity. The minted-shares guard comes from a simulation of this
   * exact deposit, reduced by `slippage` (default 1%).
   */
  async deposit(params: { amounts: DepositAmounts; slippage?: number }): Promise<DepositResult> {
    if (this.type === "concentrated") {
      throw new AquariusError(
        "Depositing into a concentrated pool through the router opens a full-range " +
          "position. Manage concentrated positions through the pool contract — see " +
          "the concentrated liquidity documentation.",
      );
    }
    const desired = resolveAmounts(params.amounts, this.tokens, this.ctx.passphrase);
    const factor = BigInt(Math.round((1 - (params.slippage ?? 0.01)) * 10_000));

    const estimated = scValToNative(
      await this.simulateWrite("deposit", this.depositArgs(desired, 0n)),
    ) as [bigint[], bigint];
    const minShares = (estimated[1] * factor) / 10_000n;

    const confirmed = await this.ctx.submitRouter(
      "deposit",
      this.depositArgs(desired, minShares),
      true,
    );
    const [amounts, shares] = scValToNative(confirmed.returnValue!) as [bigint[], bigint];
    return { txHash: confirmed.txHash, amounts, shares };
  }

  /**
   * Burn pool shares for the underlying tokens. The per-token minimums come
   * from a simulation of this exact withdrawal, reduced by `slippage` (default 1%).
   */
  async withdraw(params: { shares: bigint; slippage?: number }): Promise<WithdrawResult> {
    const factor = BigInt(Math.round((1 - (params.slippage ?? 0.01)) * 10_000));
    const zeros = this.tokens.map(() => 0n);

    const estimated = scValToNative(
      await this.simulateWrite("withdraw", this.withdrawArgs(params.shares, zeros)),
    ) as bigint[];
    const minimums = estimated.map(amount => (amount * factor) / 10_000n);

    const confirmed = await this.ctx.submitRouter(
      "withdraw",
      this.withdrawArgs(params.shares, minimums),
      true,
    );
    return {
      txHash: confirmed.txHash,
      amounts: scValToNative(confirmed.returnValue!) as bigint[],
    };
  }

  /** Claim accrued AQUA rewards for the signer. */
  async claimRewards(): Promise<ClaimResult> {
    const confirmed = await this.ctx.submitRouter("claim", this.baseArgs(), true);
    return {
      txHash: confirmed.txHash,
      amount: scValToNative(confirmed.returnValue!) as bigint,
    };
  }

  // -- internals ---------------------------------------------------------------------

  private baseArgs(): xdr.ScVal[] {
    return [
      xdr.ScVal.scvVec(this.tokens.map(t => new Address(t).toScVal())),
      xdr.ScVal.scvBytes(Buffer.from(this.poolHash)),
    ];
  }

  private depositArgs(desired: bigint[], minShares: bigint): xdr.ScVal[] {
    return [...this.baseArgs(), xdr.ScVal.scvVec(desired.map(u128)), u128(minShares)];
  }

  private withdrawArgs(shares: bigint, minimums: bigint[]): xdr.ScVal[] {
    return [...this.baseArgs(), u128(shares), xdr.ScVal.scvVec(minimums.map(u128))];
  }

  private readRouter(fn: string): Promise<xdr.ScVal> {
    return this.ctx.readRouter(fn, this.baseArgs());
  }

  private simulateWrite(fn: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    const user = new Address(this.ctx.readSource(true)).toScVal();
    return this.ctx.readRouter(fn, [user, ...args]);
  }
}
