import { Buffer } from "buffer";

import { Address, StrKey, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

import { Asset } from "./assets.js";
import { authorizedInvocation, sourceAccountEntry } from "./authorization.js";
import {
  ClaimFeesResult,
  ConcentratedDepositResult,
  ConcentratedPosition,
  ConcentratedWithdrawResult,
  MAX_TICK,
  MIN_TICK,
  PositionRangeStatus,
  PositionValue,
  Slot0,
  rangeStatus,
  snapTick,
  tickFromPrice,
} from "./concentrated.js";
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
  submitContract(
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
    auth?: xdr.SorobanAuthorizationEntry[],
  ): Promise<ConfirmedTx>;
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

  // -- concentrated positions (beta; direct pool-contract calls) ----------------------
  //
  // Range positions live on the pool contract itself, not the router: a
  // position is the key (owner, tickLower, tickUpper), merged on re-deposit,
  // max 20 ranges per account. Amounts are always quoted via the contract's
  // own estimate_* functions; withdrawal auto-claims that position's fees.
  // The concentrated surface is beta: the contracts are under an ongoing
  // external audit.

  private tickSpacing_?: number;

  private requireConcentrated(): void {
    if (this.type !== "concentrated") {
      throw new AquariusError(
        `This operation needs a concentrated pool; this pool is ${this.type}`,
      );
    }
  }

  private async readPool(fn: string, args: xdr.ScVal[]): Promise<unknown> {
    this.requireConcentrated();
    return scValToNative(await this.ctx.readContract(this.address, fn, args));
  }

  /** The pool's tick spacing (set by its fee tier). */
  async tickSpacing(): Promise<number> {
    if (this.tickSpacing_ === undefined) {
      this.tickSpacing_ = Number(await this.readPool("get_tick_spacing", []));
    }
    return this.tickSpacing_;
  }

  /** Current price state: sqrt price (Q64.96) and current tick. */
  async slot0(): Promise<Slot0> {
    const data = (await this.readPool("get_slot0", [])) as {
      sqrt_price_x96: bigint;
      tick: number | bigint;
    };
    return { sqrtPriceX96: BigInt(data.sqrt_price_x96), tick: Number(data.tick) };
  }

  async currentTick(): Promise<number> {
    return (await this.slot0()).tick;
  }

  /**
   * Where the current price sits relative to the range. The contract's
   * range is half-open `[tickLower, tickUpper)`: at `tickUpper` the
   * position is already "above" and earns no fees.
   */
  async positionRangeStatus(tickLower: number, tickUpper: number): Promise<PositionRangeStatus> {
    const tick = await this.currentTick();
    const status = rangeStatus(tick, tickLower, tickUpper);
    return {
      status,
      inRange: status === "in_range",
      currentTick: tick,
      tickLower,
      tickUpper,
      ticksFromLower: tick - tickLower,
      ticksToUpper: tickUpper - tick,
    };
  }

  /** All [tickLower, tickUpper] ranges the address holds (default: signer). */
  async positionRanges(address?: string): Promise<Array<[number, number]>> {
    const holder = address ?? this.ctx.readSource(true);
    const snapshot = (await this.readPool("get_user_position_snapshot", [
      new Address(holder).toScVal(),
    ])) as { ranges?: Array<{ tick_lower: number | bigint; tick_upper: number | bigint }> };
    return (snapshot.ranges ?? []).map(r => [Number(r.tick_lower), Number(r.tick_upper)]);
  }

  async position(
    tickLower: number,
    tickUpper: number,
    address?: string,
  ): Promise<ConcentratedPosition> {
    const holder = address ?? this.ctx.readSource(true);
    const data = (await this.readPool("get_position", [
      new Address(holder).toScVal(),
      xdr.ScVal.scvI32(tickLower),
      xdr.ScVal.scvI32(tickUpper),
    ])) as { liquidity?: bigint; L?: bigint };
    return { tickLower, tickUpper, liquidity: BigInt(data.liquidity ?? data.L ?? 0n) };
  }

  /** Accrued, unclaimed swap fees for one position, in sorted-token order. */
  async positionFees(tickLower: number, tickUpper: number, address?: string): Promise<bigint[]> {
    const holder = address ?? this.ctx.readSource(true);
    return (await this.readPool("get_position_fees", [
      new Address(holder).toScVal(),
      xdr.ScVal.scvI32(tickLower),
      xdr.ScVal.scvI32(tickUpper),
    ])) as bigint[];
  }

  /** Accrued fees across all of the address's positions in this pool. */
  async allPositionFees(address?: string): Promise<bigint[]> {
    const holder = address ?? this.ctx.readSource(true);
    return (await this.readPool("get_all_position_fees", [
      new Address(holder).toScVal(),
    ])) as bigint[];
  }

  /**
   * The position's worth, split into principal / fees / total. `total` is
   * what a full withdrawal returns right now (withdrawal auto-claims fees),
   * `fees` is the unclaimed accrual, `principal` the difference floored at zero.
   */
  async positionValue(
    tickLower: number,
    tickUpper: number,
    address?: string,
  ): Promise<PositionValue> {
    const holder = address ?? this.ctx.readSource(true);
    const pos = await this.position(tickLower, tickUpper, holder);
    const total = (await this.readPool("estimate_withdraw_position", [
      new Address(holder).toScVal(),
      xdr.ScVal.scvI32(tickLower),
      xdr.ScVal.scvI32(tickUpper),
      u128(pos.liquidity),
    ])) as bigint[];
    const fees = await this.positionFees(tickLower, tickUpper, holder);
    const principal = total.map((t, i) => (t - (fees[i] ?? 0n) > 0n ? t - (fees[i] ?? 0n) : 0n));
    return { total, fees, principal };
  }

  // -- concentrated writes ------------------------------------------------------------

  /**
   * Quote a range deposit. Pass tickRange: [lower, upper] or priceRange:
   * [low, high] in raw token1/token0 prices — prices snap to the pool's tick
   * spacing (lower floors, upper ceils). The returned estimate's
   * execute({slippage}) performs the deposit with min-liquidity derived from
   * this quote.
   */
  async estimatePositionDeposit(params: {
    amounts: DepositAmounts;
    tickRange?: [number, number];
    priceRange?: [number | string, number | string];
  }): Promise<ConcentratedDepositEstimate> {
    this.requireConcentrated();
    if ((params.tickRange === undefined) === (params.priceRange === undefined)) {
      throw new AquariusError("Pass exactly one of tickRange / priceRange");
    }
    const spacing = await this.tickSpacing();
    let lower: number;
    let upper: number;
    if (params.priceRange) {
      lower = snapTick(tickFromPrice(params.priceRange[0]), spacing);
      upper = snapTick(tickFromPrice(params.priceRange[1]), spacing, { up: true });
    } else {
      [lower, upper] = params.tickRange!;
      if (lower % spacing !== 0 || upper % spacing !== 0) {
        throw new AquariusError(
          `ticks must be multiples of the pool's tick spacing (${spacing})`,
        );
      }
    }
    if (!(MIN_TICK <= lower && lower < upper && upper <= MAX_TICK)) {
      throw new AquariusError("tickLower must be below tickUpper, both within tick bounds");
    }
    const desired = resolveAmounts(params.amounts, this.tokens, this.ctx.passphrase);
    const [amounts, liquidity] = (await this.readPool("estimate_deposit_position", [
      xdr.ScVal.scvI32(lower),
      xdr.ScVal.scvI32(upper),
      xdr.ScVal.scvVec(desired.map(u128)),
    ])) as [bigint[], bigint];
    return new ConcentratedDepositEstimate(this, this.ctx, lower, upper, desired, amounts, liquidity);
  }

  /**
   * Remove liquidity from a range (default: the whole position). Withdrawal
   * auto-claims the position's fees; per-token minimums come from a
   * simulation of this exact withdrawal, reduced by `slippage` (default 1%).
   */
  async withdrawPosition(params: {
    tickLower: number;
    tickUpper: number;
    liquidity?: bigint;
    slippage?: number;
  }): Promise<ConcentratedWithdrawResult> {
    this.requireConcentrated();
    const owner = this.ctx.readSource(true);
    const liquidity =
      params.liquidity ??
      (await this.position(params.tickLower, params.tickUpper, owner)).liquidity;
    const estimated = (await this.readPool("estimate_withdraw_position", [
      new Address(owner).toScVal(),
      xdr.ScVal.scvI32(params.tickLower),
      xdr.ScVal.scvI32(params.tickUpper),
      u128(liquidity),
    ])) as bigint[];
    const factor = BigInt(Math.round((1 - (params.slippage ?? 0.01)) * 10_000));
    const minimums = estimated.map(a => (a * factor) / 10_000n);
    const args = [
      new Address(owner).toScVal(),
      xdr.ScVal.scvI32(params.tickLower),
      xdr.ScVal.scvI32(params.tickUpper),
      u128(liquidity),
      xdr.ScVal.scvVec(minimums.map(u128)),
    ];
    const confirmed = await this.ctx.submitContract(this.address, "withdraw_position", args, [
      sourceAccountEntry(authorizedInvocation(this.address, "withdraw_position", args)),
    ]);
    return {
      txHash: confirmed.txHash,
      amounts: scValToNative(confirmed.returnValue!) as bigint[],
    };
  }

  /** Collect one position's accrued swap fees. */
  async claimPositionFees(tickLower: number, tickUpper: number): Promise<ClaimFeesResult> {
    this.requireConcentrated();
    const owner = this.ctx.readSource(true);
    const args = [
      new Address(owner).toScVal(),
      xdr.ScVal.scvI32(tickLower),
      xdr.ScVal.scvI32(tickUpper),
    ];
    const confirmed = await this.ctx.submitContract(this.address, "claim_position_fees", args, [
      sourceAccountEntry(authorizedInvocation(this.address, "claim_position_fees", args)),
    ]);
    return {
      txHash: confirmed.txHash,
      amounts: scValToNative(confirmed.returnValue!) as bigint[],
    };
  }

  /** Collect accrued swap fees across all of the signer's positions. */
  async claimAllPositionFees(): Promise<ClaimFeesResult> {
    this.requireConcentrated();
    const owner = this.ctx.readSource(true);
    const args = [new Address(owner).toScVal()];
    const confirmed = await this.ctx.submitContract(
      this.address,
      "claim_all_position_fees",
      args,
      [sourceAccountEntry(authorizedInvocation(this.address, "claim_all_position_fees", args))],
    );
    return {
      txHash: confirmed.txHash,
      amounts: scValToNative(confirmed.returnValue!) as bigint[],
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

/** A quoted range deposit: execute() performs it with a min-liquidity guard. */
export class ConcentratedDepositEstimate {
  constructor(
    private readonly pool: Pool,
    private readonly ctx: PoolContext,
    readonly tickLower: number,
    readonly tickUpper: number,
    /** What will be authorized for transfer, in sorted-token order. */
    readonly desired: bigint[],
    /** Estimated base units the pool will actually use. */
    readonly amounts: bigint[],
    /** Estimated raw liquidity to be minted. */
    readonly liquidity: bigint,
  ) {}

  async execute(options?: { slippage?: number }): Promise<ConcentratedDepositResult> {
    const owner = this.ctx.readSource(true);
    const factor = BigInt(Math.round((1 - (options?.slippage ?? 0.01)) * 10_000));
    const minLiquidity = (this.liquidity * factor) / 10_000n;
    const args = [
      new Address(owner).toScVal(),
      xdr.ScVal.scvI32(this.tickLower),
      xdr.ScVal.scvI32(this.tickUpper),
      xdr.ScVal.scvVec(this.desired.map(u128)),
      u128(minLiquidity),
    ];
    // Mirror the web app's transaction shape: authorize a transfer of the
    // full desired amount per token — the contract pulls exactly those
    // amounts and refunds whatever the range doesn't need.
    const transfers = this.pool.tokens.map((token, i) =>
      authorizedInvocation(token, "transfer", [
        new Address(owner).toScVal(),
        new Address(this.pool.address).toScVal(),
        nativeToScVal(this.desired[i], { type: "i128" }),
      ]),
    );
    const confirmed = await this.ctx.submitContract(this.pool.address, "deposit_position", args, [
      sourceAccountEntry(
        authorizedInvocation(this.pool.address, "deposit_position", args, transfers),
      ),
    ]);
    const [used, minted] = scValToNative(confirmed.returnValue!) as [bigint[], bigint];
    return { txHash: confirmed.txHash, amounts: used, liquidity: minted };
  }
}
