import { Buffer } from "buffer";

import { Address, StrKey, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

import { Asset } from "./assets.js";
import {
  addressSalt,
  authorizedInvocation,
  deployedContractId,
  sourceAccountEntry,
} from "./authorization.js";
import { BatchCall } from "./batch.js";
import type { Receipt } from "./client.js";
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
import { AquariusError, SlippageError } from "./errors.js";
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

/** The pool's reward accounting for one account — `get_rewards_info`, values in base units. */
export interface RewardsInfo {
  /** Unclaimed AQUA. */
  toClaim: bigint;
  /** AQUA emitted per second to the whole pool. */
  tps: bigint;
  /** Unix time the current reward schedule ends. */
  expiresAt: bigint;
  /** Boost accounting: the account's working balance and the pool's working supply. */
  workingBalance: bigint;
  workingSupply: bigint;
  /** Boost accounting after the pending update. */
  newWorkingBalance: bigint;
  newWorkingSupply: bigint;
  /** Share supply as the reward logic sees it. */
  supply: bigint;
  /** Locked-AQUA boost inputs. */
  boostBalance: bigint;
  boostSupply: bigint;
  /** Unix time of the last reward checkpoint. */
  lastTime: bigint;
  /** Every field the contract returned, by its own name. */
  raw: Record<string, bigint>;
}

/** One gauge incentive on a pool, for one account. */
export interface Incentive {
  /** Reward token contract ID. */
  token: string;
  /** Reward emitted per second, in the token's base units. */
  tps: bigint;
  /** Unix time the schedule ends. */
  expiresAt: bigint;
  /** Accrued, unclaimed reward for the account. */
  userReward: bigint;
}

export interface ScheduleIncentiveParams {
  token: Asset | string;
  /** Reward per second, in the token's base units. */
  tps: bigint;
  /** Unix seconds. */
  startAt: bigint | number;
  durationSeconds: bigint | number;
  /** find-path `swap_chain_xdr` for a non-AQUA reward token; omit for AQUA. */
  swapChainXdr?: string;
}

export interface WorkingBalance {
  workingBalance: bigint;
  workingSupply: bigint;
}

/** Claims to bundle with a withdrawal — one signature for all of it. */
export interface WithdrawClaims {
  claimRewards?: boolean;
  claimIncentives?: boolean;
}

/** @internal What Pool needs from the client. */
export interface PoolContext {
  passphrase: string;
  router: string;
  /** The protocol reward token's contract ID (AQUA). */
  rewardToken: string;
  readSource(requireSigner?: boolean): string;
  readRouter(fn: string, args: xdr.ScVal[]): Promise<xdr.ScVal>;
  readContract(contractId: string, fn: string, args: xdr.ScVal[]): Promise<xdr.ScVal>;
  readBatch(calls: BatchCall[]): Promise<xdr.ScVal[]>;
  submitRouter(fn: string, args: xdr.ScVal[], withUser: boolean): Promise<ConfirmedTx>;
  submitContract(
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
    auth?: xdr.SorobanAuthorizationEntry[],
  ): Promise<ConfirmedTx>;
  buildRouter(fn: string, args: xdr.ScVal[], withUser: boolean): Promise<string>;
  buildContract(
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
    auth?: xdr.SorobanAuthorizationEntry[],
  ): Promise<string>;
  submitBatch(
    calls: BatchCall[],
    auth: xdr.SorobanAuthorizedInvocation[],
    returnResults: boolean,
  ): Promise<ConfirmedTx>;
  buildBatch(
    calls: BatchCall[],
    auth: xdr.SorobanAuthorizedInvocation[],
    returnResults: boolean,
  ): Promise<string>;
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
  if (value.type !== "scvMap") return entries;
  for (const entry of value.map ?? []) {
    if (entry.key.type !== "scvBytes" || entry.val.type !== "scvAddress") continue;
    entries.push([
      entry.key.bytes.toBytes(),
      Address.fromScAddress(entry.val.address).toString(),
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
      this.shareToken_ = scValToNative(value) as string;
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
    const args = await this.guardedDepositArgs(params);
    const confirmed = await this.ctx.submitRouter("deposit", args, true);
    const [amounts, shares] = scValToNative(confirmed.returnValue!) as [bigint[], bigint];
    return { txHash: confirmed.txHash, amounts, shares };
  }

  /**
   * The same deposit, prepared but not signed: the simulated, unsigned
   * envelope XDR, guards already derived. For flows that own signing and
   * submission themselves (wallet adapters, multisig, hardware).
   */
  async buildDeposit(params: { amounts: DepositAmounts; slippage?: number }): Promise<string> {
    const args = await this.guardedDepositArgs(params);
    return this.ctx.buildRouter("deposit", args, true);
  }

  private async guardedDepositArgs(params: {
    amounts: DepositAmounts;
    slippage?: number;
  }): Promise<xdr.ScVal[]> {
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
    return this.depositArgs(desired, minShares);
  }

  /**
   * Burn pool shares for the underlying tokens. The per-token minimums come
   * from a simulation of this exact withdrawal, reduced by `slippage` (default 1%).
   */
  async withdraw(params: { shares: bigint; slippage?: number }): Promise<WithdrawResult> {
    const args = await this.guardedWithdrawArgs(params);
    const confirmed = await this.ctx.submitRouter("withdraw", args, true);
    return {
      txHash: confirmed.txHash,
      amounts: scValToNative(confirmed.returnValue!) as bigint[],
    };
  }

  /** The same withdrawal, prepared but not signed. See `buildDeposit`. */
  async buildWithdraw(params: { shares: bigint; slippage?: number }): Promise<string> {
    const args = await this.guardedWithdrawArgs(params);
    return this.ctx.buildRouter("withdraw", args, true);
  }

  private async guardedWithdrawArgs(params: {
    shares: bigint;
    slippage?: number;
  }): Promise<xdr.ScVal[]> {
    const minimums = this.applySlippage(await this.estimateWithdraw(params.shares), params.slippage);
    return this.withdrawArgs(params.shares, minimums);
  }

  /** Claim accrued AQUA rewards for the signer. */
  async claimRewards(): Promise<ClaimResult> {
    const confirmed = await this.ctx.submitRouter("claim", this.baseArgs(), true);
    return {
      txHash: confirmed.txHash,
      amount: scValToNative(confirmed.returnValue!) as bigint,
    };
  }

  /** The same reward claim, prepared but not signed. See `buildDeposit`. */
  buildClaimRewards(): Promise<string> {
    return this.ctx.buildRouter("claim", this.baseArgs(), true);
  }

  // -- rewards accounting & boost --------------------------------------------------------

  /** The pool's AQUA reward accounting for the address (default: the signer). */
  async rewardsInfo(address?: string): Promise<RewardsInfo> {
    const raw = scValToNative(
      await this.ctx.readContract(this.address, "get_rewards_info", [this.userArg(address)]),
    ) as Record<string, bigint>;
    const get = (key: string) => BigInt(raw[key] ?? 0n);
    return {
      toClaim: get("to_claim"),
      tps: get("tps"),
      expiresAt: get("exp_at"),
      lastTime: get("last_time"),
      workingBalance: get("working_balance"),
      workingSupply: get("working_supply"),
      newWorkingBalance: get("new_working_balance"),
      newWorkingSupply: get("new_working_supply"),
      supply: get("supply"),
      boostBalance: get("boost_balance"),
      boostSupply: get("boost_supply"),
      raw,
    };
  }

  /** Whether the address (default: the signer) has AQUA rewards enabled on this pool. */
  async rewardsEnabled(address?: string): Promise<boolean> {
    return scValToNative(
      await this.ctx.readContract(this.address, "get_rewards_state", [this.userArg(address)]),
    ) as boolean;
  }

  /** Opt the signer in or out of AQUA rewards on this pool. */
  async setRewardsEnabled(enabled: boolean): Promise<{ txHash: string }> {
    const args = [this.userArg(), xdr.ScVal.scvBool(enabled)];
    const confirmed = await this.ctx.submitContract(
      this.address,
      "set_rewards_state",
      args,
      this.selfAuth("set_rewards_state", args),
    );
    return { txHash: confirmed.txHash };
  }

  /** The same opt-in/out, prepared but not signed. See `buildDeposit`. */
  buildSetRewardsEnabled(enabled: boolean): Promise<string> {
    const args = [this.userArg(), xdr.ScVal.scvBool(enabled)];
    return this.ctx.buildContract(
      this.address,
      "set_rewards_state",
      args,
      this.selfAuth("set_rewards_state", args),
    );
  }

  /**
   * The boosted (working) balance the address would have with `shares` in
   * this pool, and the pool's working supply — the inputs of its reward share.
   */
  async estimateWorkingBalance(shares: bigint, address?: string): Promise<WorkingBalance> {
    return this.parseWorkingBalance(
      await this.ctx.readContract(this.address, "estimate_working_balance", [
        this.userArg(address),
        u128(shares),
      ]),
    );
  }

  /** The concentrated-pool form: working balance for a range position's liquidity. */
  async estimatePositionWorkingBalance(
    tickLower: number,
    tickUpper: number,
    liquidity: bigint,
    address?: string,
  ): Promise<WorkingBalance> {
    this.requireConcentrated();
    return this.parseWorkingBalance(
      await this.ctx.readContract(this.address, "estimate_working_balance", [
        this.userArg(address),
        xdr.ScVal.scvI32(tickLower),
        xdr.ScVal.scvI32(tickUpper),
        u128(liquidity),
      ]),
    );
  }

  private parseWorkingBalance(value: xdr.ScVal): WorkingBalance {
    const [workingBalance, workingSupply] = scValToNative(value) as [bigint, bigint];
    return { workingBalance: BigInt(workingBalance), workingSupply: BigInt(workingSupply) };
  }

  // -- gauge incentives -----------------------------------------------------------------

  /** Every gauge incentive on this pool, with the address's accrued share (default: the signer). */
  async incentives(address?: string): Promise<Incentive[]> {
    const raw = scValToNative(
      await this.ctx.readContract(this.address, "gauges_get_reward_info", [this.userArg(address)]),
    ) as Record<string, Record<string, bigint>>;
    return Object.entries(raw).map(([token, info]) => ({
      token,
      tps: BigInt(info.tps ?? 0n),
      expiresAt: BigInt(info.expired_at ?? 0n),
      userReward: BigInt(info.user_reward ?? 0n),
    }));
  }

  /** The gauge contract behind each incentive token on this pool. */
  async gauges(): Promise<Array<{ token: string; gauge: string }>> {
    const raw = scValToNative(await this.ctx.readContract(this.address, "get_gauges", [])) as
      | Record<string, string>
      | null;
    return Object.entries(raw ?? {}).map(([token, gauge]) => ({ token, gauge }));
  }

  /** Claim the signer's accrued gauge incentives on this pool. */
  async claimIncentives(): Promise<{ txHash: string }> {
    const args = [this.userArg()];
    const confirmed = await this.ctx.submitContract(
      this.address,
      "gauges_claim",
      args,
      this.selfAuth("gauges_claim", args),
    );
    return { txHash: confirmed.txHash };
  }

  /** The same incentive claim, prepared but not signed. See `buildDeposit`. */
  buildClaimIncentives(): Promise<string> {
    const args = [this.userArg()];
    return this.ctx.buildContract(
      this.address,
      "gauges_claim",
      args,
      this.selfAuth("gauges_claim", args),
    );
  }

  /**
   * Schedule a gauge incentive: `tps` of `token` per second, from `startAt`
   * (unix seconds) for `durationSeconds`, funded upfront by the signer —
   * `tps * duration` of the token moves in this transaction. `swapChainXdr` is
   * the find-path route the router values a non-AQUA reward with against the
   * daily minimum; omit for AQUA. Limits: `client.incentives.config()`.
   *
   * The authorization is built client-side down to the funding transfer, so
   * the wallet shows exactly what is spent and to whom: on a volatile or
   * stable pool the money goes to the token's reward gauge (created by this
   * call if the token is new — its address is derived the way the router
   * derives it); on a concentrated pool, to the pool's incentives vault. One
   * argument of that tree is the pool's current working supply, so a deposit
   * or withdrawal landing between build and submit invalidates the
   * authorization — the call then fails without spending, and can be rebuilt.
   */
  async scheduleIncentive(params: ScheduleIncentiveParams): Promise<{ txHash: string }> {
    const { args, auth } = await this.scheduleIncentivePlan(params);
    const confirmed = await this.ctx.submitContract(
      this.ctx.router,
      "pool_gauge_schedule_reward",
      args,
      auth,
    );
    return { txHash: confirmed.txHash };
  }

  /** The same scheduling, prepared but not signed. See `buildDeposit`. */
  async buildScheduleIncentive(params: ScheduleIncentiveParams): Promise<string> {
    const { args, auth } = await this.scheduleIncentivePlan(params);
    return this.ctx.buildContract(this.ctx.router, "pool_gauge_schedule_reward", args, auth);
  }

  /**
   * The reward gauge for `token` on this pool: the one attached, or the
   * address the router will deploy it at (salt: the pool and token addresses).
   */
  async gaugeFor(token: Asset | string): Promise<string> {
    const tokenId = this.asTokenId(token);
    const attached = (await this.gauges()).find(g => g.token === tokenId);
    return attached?.gauge ?? deployedContractId(
      this.ctx.router,
      addressSalt([this.address, tokenId]),
      this.ctx.passphrase,
    );
  }

  /**
   * The concentrated pool's incentives vault (custody for every non-native
   * reward): the one deployed, or the address the pool will deploy it at.
   */
  async incentivesVault(): Promise<string> {
    this.requireConcentrated();
    const existing = scValToNative(
      await this.ctx.readContract(this.address, "get_incentives_vault_addr", []),
    ) as string | null | undefined;
    return existing ?? deployedContractId(
      this.address,
      addressSalt([this.address, this.ctx.rewardToken], "incentives"),
      this.ctx.passphrase,
    );
  }

  private async scheduleIncentivePlan(params: ScheduleIncentiveParams): Promise<{
    args: xdr.ScVal[];
    auth: xdr.SorobanAuthorizationEntry[];
  }> {
    const user = this.userArg();
    const token = this.asTokenId(params.token);
    const args = [user, ...this.scheduleIncentiveArgs(params)];
    const total = params.tps * BigInt(params.durationSeconds);
    const u64 = (v: bigint | number) => nativeToScVal(BigInt(v), { type: "u64" });
    const schedule = [u64(params.startAt), u64(params.durationSeconds), u128(params.tps)];
    const routerVal = new Address(this.ctx.router).toScVal();
    const funding = (to: string) =>
      authorizedInvocation(token, "transfer", [
        user,
        new Address(to).toScVal(),
        nativeToScVal(total, { type: "i128" }),
      ]);

    let inner: xdr.SorobanAuthorizedInvocation;
    if (this.type === "concentrated") {
      // router -> pool.tick_schedule_reward -> token.transfer(user, incentives vault)
      inner = authorizedInvocation(
        this.address,
        "tick_schedule_reward",
        [routerVal, user, new Address(token).toScVal(), ...schedule],
        [funding(await this.incentivesVault())],
      );
    } else {
      // router -> pool.gauge_schedule_reward -> gauge.schedule_rewards_config -> token.transfer(user, gauge)
      const [gauge, { workingSupply }] = await Promise.all([
        this.gaugeFor(token),
        this.rewardsInfo(this.ctx.readSource(true)),
      ]);
      inner = authorizedInvocation(
        this.address,
        "gauge_schedule_reward",
        [routerVal, user, new Address(gauge).toScVal(), ...schedule],
        [
          authorizedInvocation(
            gauge,
            "schedule_rewards_config",
            [new Address(this.address).toScVal(), user, ...schedule, u128(workingSupply)],
            [funding(gauge)],
          ),
        ],
      );
    }
    return {
      args,
      auth: [
        sourceAccountEntry(
          authorizedInvocation(this.ctx.router, "pool_gauge_schedule_reward", args, [inner]),
        ),
      ],
    };
  }

  private scheduleIncentiveArgs(params: ScheduleIncentiveParams): xdr.ScVal[] {
    if (params.tps <= 0n) throw new AquariusError("tps must be positive");
    if (BigInt(params.durationSeconds) <= 0n) throw new AquariusError("duration must be positive");
    return [
      ...this.baseArgs(),
      new Address(this.asTokenId(params.token)).toScVal(),
      u128(params.tps),
      nativeToScVal(BigInt(params.startAt), { type: "u64" }),
      nativeToScVal(BigInt(params.durationSeconds), { type: "u64" }),
      params.swapChainXdr
        ? xdr.ScVal.fromXDR(params.swapChainXdr, "base64")
        : xdr.ScVal.scvVec([]),
    ];
  }

  // -- withdrawals through the pool contract, optionally with claims ----------------------

  /**
   * Burn shares for the underlying tokens and, in the same transaction, claim
   * AQUA rewards and/or gauge incentives. Goes to the pool contract directly
   * with a bounded share burn, under one signature via the batch contract.
   */
  async withdrawAndClaim(
    params: { shares: bigint; slippage?: number } & WithdrawClaims,
  ): Promise<WithdrawResult> {
    const plan = await this.withdrawAndClaimPlan(params);
    const confirmed = await this.ctx.submitBatch(plan.calls, plan.auth, true);
    const [amounts] = this.batchValues(confirmed.returnValue, plan.calls.length);
    return { txHash: confirmed.txHash, amounts: scValToNative(amounts) as bigint[] };
  }

  /** The same withdrawal + claims, prepared but not signed. See `buildDeposit`. */
  async buildWithdrawAndClaim(
    params: { shares: bigint; slippage?: number } & WithdrawClaims,
  ): Promise<string> {
    const plan = await this.withdrawAndClaimPlan(params);
    return this.ctx.buildBatch(plan.calls, plan.auth, true);
  }

  private async withdrawAndClaimPlan(params: { shares: bigint; slippage?: number } & WithdrawClaims) {
    const minimums = this.applySlippage(await this.estimateWithdraw(params.shares), params.slippage);
    const args = [this.userArg(), u128(params.shares), xdr.ScVal.scvVec(minimums.map(u128))];
    return this.poolWithdrawPlan("withdraw", args, params.shares, params);
  }

  /** What burning `shares` returns per token, in sorted-token order. */
  async estimateWithdraw(shares: bigint): Promise<bigint[]> {
    const zeros = this.tokens.map(() => 0n);
    return scValToNative(
      await this.simulateWrite("withdraw", this.withdrawArgs(shares, zeros)),
    ) as bigint[];
  }

  /**
   * What burning `shares` would return if taken entirely in one token —
   * one entry per token, in sorted-token order (`calc_withdraw_one_coin`).
   */
  async estimateWithdrawOneCoin(shares: bigint): Promise<bigint[]> {
    this.requireStable();
    const values = await this.ctx.readBatch(
      this.tokens.map((_, i) => ({
        contractId: this.address,
        fn: "calc_withdraw_one_coin",
        args: [u128(shares), nativeToScVal(i, { type: "u32" })],
      })),
    );
    return values.map(v => BigInt(scValToNative(v) as bigint));
  }

  /**
   * Burn shares and take the whole proceeds in one token. The minimum comes
   * from `calc_withdraw_one_coin`, reduced by `slippage` (default 1%).
   */
  async withdrawOneCoin(
    params: { shares: bigint; token: Asset | string; slippage?: number; minimumAmount?: bigint } & WithdrawClaims,
  ): Promise<{ txHash: string; amount: bigint }> {
    const plan = await this.withdrawOneCoinPlan(params);
    const confirmed = await this.ctx.submitBatch(plan.calls, plan.auth, true);
    const [value] = this.batchValues(confirmed.returnValue, plan.calls.length, confirmed.txHash);
    const amounts = scValToNative(value) as unknown;
    if (
      !Array.isArray(amounts) || amounts.length !== this.tokens.length ||
      amounts.some(a => typeof a !== "bigint" || a < 0n)
    ) {
      throw new AquariusError(
        "Unexpected withdrawal result. Inspect the confirmed transaction before retrying.",
        confirmed.txHash,
      );
    }
    return { txHash: confirmed.txHash, amount: amounts[this.tokenIndex(params.token)] };
  }

  /** The same single-token withdrawal, prepared but not signed. See `buildDeposit`. */
  async buildWithdrawOneCoin(
    params: { shares: bigint; token: Asset | string; slippage?: number; minimumAmount?: bigint } & WithdrawClaims,
  ): Promise<string> {
    const plan = await this.withdrawOneCoinPlan(params);
    return this.ctx.buildBatch(plan.calls, plan.auth, true);
  }

  private async withdrawOneCoinPlan(
    params: { shares: bigint; token: Asset | string; slippage?: number; minimumAmount?: bigint } & WithdrawClaims,
  ) {
    this.requireStable();
    const index = this.tokenIndex(params.token);
    const estimated = BigInt(
      scValToNative(
        await this.ctx.readContract(this.address, "calc_withdraw_one_coin", [
          u128(params.shares),
          nativeToScVal(index, { type: "u32" }),
        ]),
      ) as bigint,
    );
    const [estimatedMinimum] = this.applySlippage([estimated], params.slippage);
    const minimum = params.minimumAmount !== undefined && params.minimumAmount > estimatedMinimum
      ? params.minimumAmount : estimatedMinimum;
    const args = [
      this.userArg(),
      u128(params.shares),
      nativeToScVal(index, { type: "u32" }),
      u128(minimum),
    ];
    return this.poolWithdrawPlan("withdraw_one_coin", args, params.shares, params);
  }

  /** The shares it would take to withdraw exactly these amounts (`remove_liquidity_imbalance`). */
  async estimateWithdrawImbalanced(amounts: DepositAmounts, address?: string): Promise<bigint> {
    this.requireStable();
    const desired = resolveAmounts(amounts, this.tokens, this.ctx.passphrase);
    const balance = await this.shareBalance(address);
    return BigInt(
      scValToNative(
        await this.ctx.readContract(this.address, "remove_liquidity_imbalance", [
          this.userArg(address),
          xdr.ScVal.scvVec(desired.map(u128)),
          u128(balance),
        ]),
      ) as bigint,
    );
  }

  /**
   * Withdraw exact token amounts, burning whatever shares that takes. The
   * share cap comes from a simulation, raised by `slippage` (default 1%).
   */
  async withdrawImbalanced(
    params: { amounts: DepositAmounts; slippage?: number; maximumShares?: bigint } & WithdrawClaims,
  ): Promise<{ txHash: string; shares: bigint }> {
    const plan = await this.withdrawImbalancedPlan(params);
    const confirmed = await this.ctx.submitBatch(plan.calls, plan.auth, true);
    const [shares] = this.batchValues(confirmed.returnValue, plan.calls.length);
    return { txHash: confirmed.txHash, shares: BigInt(scValToNative(shares) as bigint) };
  }

  /** The same imbalanced withdrawal, prepared but not signed. See `buildDeposit`. */
  async buildWithdrawImbalanced(
    params: { amounts: DepositAmounts; slippage?: number; maximumShares?: bigint } & WithdrawClaims,
  ): Promise<string> {
    const plan = await this.withdrawImbalancedPlan(params);
    return this.ctx.buildBatch(plan.calls, plan.auth, true);
  }

  private async withdrawImbalancedPlan(
    params: { amounts: DepositAmounts; slippage?: number; maximumShares?: bigint } & WithdrawClaims,
  ) {
    this.requireStable();
    const desired = resolveAmounts(params.amounts, this.tokens, this.ctx.passphrase);
    const estimated = await this.estimateWithdrawImbalanced(desired);
    // the cap is a maximum: raise it, rounding up, never in the caller's favor
    const bps = BigInt(Math.round((params.slippage ?? 0.01) * 10_000));
    const estimatedMaximum = (estimated * (10_000n + bps) + 9_999n) / 10_000n;
    const balance = await this.shareBalance();
    const cap = params.maximumShares === undefined || params.maximumShares > balance
      ? balance : params.maximumShares;
    const maxShares = estimatedMaximum < cap ? estimatedMaximum : cap;
    const args = [this.userArg(), xdr.ScVal.scvVec(desired.map(u128)), u128(maxShares)];
    return this.poolWithdrawPlan("remove_liquidity_imbalance", args, maxShares, params);
  }

  /**
   * A pool-contract withdrawal as one batch: the withdraw call authorizing a
   * burn of `sharesBurned` on the share token, then the requested claims.
   */
  private async poolWithdrawPlan(
    fn: string,
    args: xdr.ScVal[],
    sharesBurned: bigint,
    claims: WithdrawClaims,
  ): Promise<{ calls: BatchCall[]; auth: xdr.SorobanAuthorizedInvocation[] }> {
    const user = this.userArg();
    const burn = authorizedInvocation(await this.shareToken(), "burn", [
      user,
      nativeToScVal(sharesBurned, { type: "i128" }),
    ]);
    const calls: BatchCall[] = [{ contractId: this.address, fn, args }];
    const auth = [authorizedInvocation(this.address, fn, args, [burn])];
    for (const claim of [
      claims.claimRewards ? "claim" : null,
      claims.claimIncentives ? "gauges_claim" : null,
    ]) {
      if (!claim) continue;
      calls.push({ contractId: this.address, fn: claim, args: [user] });
      auth.push(authorizedInvocation(this.address, claim, [user]));
    }
    return { calls, auth };
  }

  private batchValues(retval: xdr.ScVal | undefined, expected: number, txHash?: string): xdr.ScVal[] {
    if (!retval || retval.type !== "scvVec" || (retval.vec ?? []).length !== expected) {
      throw new AquariusError("Unexpected batch result. Inspect the transaction before retrying.", txHash);
    }
    return retval.vec!;
  }

  private applySlippage(amounts: bigint[], slippage?: number): bigint[] {
    const factor = BigInt(Math.round((1 - (slippage ?? 0.01)) * 10_000));
    return amounts.map(a => (a * factor) / 10_000n);
  }

  private userArg(address?: string): xdr.ScVal {
    return new Address(address ?? this.ctx.readSource(true)).toScVal();
  }

  private requireStable(): void {
    if (this.type !== "stable") {
      throw new AquariusError("Single-token and imbalanced withdrawals are only available for stable pools");
    }
  }

  private asTokenId(token: Asset | string): string {
    return token instanceof Asset ? token.contractId(this.ctx.passphrase) : token;
  }

  private tokenIndex(token: Asset | string): number {
    const index = this.tokens.indexOf(this.asTokenId(token));
    if (index < 0) throw new AquariusError(`${String(token)} is not one of this pool's tokens`);
    return index;
  }

  // -- single-pool swaps ---------------------------------------------------------

  /**
   * Quote a swap against this pool only — the router's own on-chain
   * estimator, no path-finding API involved. Exact input only: the router
   * has no single-pool strict-receive; for exact output use
   * `client.quote({ amountOut })`.
   */
  async quote(params: {
    from: Asset | string;
    to: Asset | string;
    amountIn?: bigint;
    amountOut?: bigint;
    slippage?: number;
  }): Promise<PoolQuote> {
    if (params.amountOut !== undefined) {
      throw new AquariusError(
        "The router has no single-pool strict-receive — use client.quote({ amountOut }) for exact-output swaps",
      );
    }
    if (params.amountIn === undefined || params.amountIn <= 0n) {
      throw new AquariusError("Pass a positive amountIn");
    }
    const [tokenIn, tokenOut] = this.swapPair(params.from, params.to);
    const estimated = scValToNative(
      await this.ctx.readRouter("estimate_swap", [
        xdr.ScVal.scvVec(this.tokens.map(t => new Address(t).toScVal())),
        new Address(tokenIn).toScVal(),
        new Address(tokenOut).toScVal(),
        xdr.ScVal.scvBytes(Buffer.from(this.poolHash)),
        u128(params.amountIn),
      ]),
    ) as bigint;
    const factor = BigInt(Math.round((1 - (params.slippage ?? 0.01)) * 10_000));
    return new PoolQuote(
      this,
      this.ctx,
      params.amountIn,
      estimated,
      (estimated * factor) / 10_000n,
      tokenIn,
      tokenOut,
      params.slippage ?? 0.01,
    );
  }

  /**
   * quote() + execute() pinned to this pool, for bots. `retries`: how many
   * times to re-quote and retry after a SlippageError — the estimate reads
   * the chain directly (no pricing indexer to wait for), so retries are
   * immediate. Default 0: fail on the first guard breach.
   */
  async swap(params: {
    from: Asset | string;
    to: Asset | string;
    amountIn?: bigint;
    slippage?: number;
    retries?: number;
  }): Promise<Receipt> {
    const retries = params.retries ?? 0;
    if (retries < 0) throw new AquariusError("retries must be >= 0");
    for (let attempt = 0; ; attempt++) {
      try {
        return await (await this.quote(params)).execute();
      } catch (error) {
        if (!(error instanceof SlippageError) || attempt === retries) throw error;
      }
    }
  }

  private swapPair(from: Asset | string, to: Asset | string): [string, string] {
    const tokenIn = from instanceof Asset ? from.contractId(this.ctx.passphrase) : from;
    const tokenOut = to instanceof Asset ? to.contractId(this.ctx.passphrase) : to;
    for (const token of [tokenIn, tokenOut]) {
      if (!this.tokens.includes(token)) {
        throw new AquariusError(`Token ${token} is not part of this pool`);
      }
    }
    if (tokenIn === tokenOut) throw new AquariusError("from and to must be different tokens");
    return [tokenIn, tokenOut];
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
    minimumAmounts?: DepositAmounts;
  }): Promise<ConcentratedWithdrawResult> {
    const args = await this.guardedWithdrawPositionArgs(params);
    const confirmed = await this.ctx.submitContract(
      this.address,
      "withdraw_position",
      args,
      this.selfAuth("withdraw_position", args),
    );
    return {
      txHash: confirmed.txHash,
      amounts: scValToNative(confirmed.returnValue!) as bigint[],
    };
  }

  /** The same range withdrawal, prepared but not signed. See `buildDeposit`. */
  async buildWithdrawPosition(params: {
    tickLower: number;
    tickUpper: number;
    liquidity?: bigint;
    slippage?: number;
    minimumAmounts?: DepositAmounts;
  }): Promise<string> {
    const args = await this.guardedWithdrawPositionArgs(params);
    return this.ctx.buildContract(
      this.address,
      "withdraw_position",
      args,
      this.selfAuth("withdraw_position", args),
    );
  }

  private async guardedWithdrawPositionArgs(params: {
    tickLower: number;
    tickUpper: number;
    liquidity?: bigint;
    slippage?: number;
    minimumAmounts?: DepositAmounts;
  }): Promise<xdr.ScVal[]> {
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
    const reviewed = params.minimumAmounts === undefined
      ? this.tokens.map(() => 0n)
      : resolveAmounts(params.minimumAmounts, this.tokens, this.ctx.passphrase);
    const minimums = estimated.map((a, i) => {
      const minimum = (a * factor) / 10_000n;
      return reviewed[i] > minimum ? reviewed[i] : minimum;
    });
    return [
      new Address(owner).toScVal(),
      xdr.ScVal.scvI32(params.tickLower),
      xdr.ScVal.scvI32(params.tickUpper),
      u128(liquidity),
      xdr.ScVal.scvVec(minimums.map(u128)),
    ];
  }

  /** Collect one position's accrued swap fees. */
  async claimPositionFees(tickLower: number, tickUpper: number): Promise<ClaimFeesResult> {
    const args = this.rangeArgs(tickLower, tickUpper);
    const confirmed = await this.ctx.submitContract(
      this.address,
      "claim_position_fees",
      args,
      this.selfAuth("claim_position_fees", args),
    );
    return {
      txHash: confirmed.txHash,
      amounts: scValToNative(confirmed.returnValue!) as bigint[],
    };
  }

  /** The same fee claim, prepared but not signed. See `buildDeposit`. */
  buildClaimPositionFees(tickLower: number, tickUpper: number): Promise<string> {
    const args = this.rangeArgs(tickLower, tickUpper);
    return this.ctx.buildContract(
      this.address,
      "claim_position_fees",
      args,
      this.selfAuth("claim_position_fees", args),
    );
  }

  /** Collect accrued swap fees across all of the signer's positions. */
  async claimAllPositionFees(): Promise<ClaimFeesResult> {
    const args = this.ownerArgs();
    const confirmed = await this.ctx.submitContract(
      this.address,
      "claim_all_position_fees",
      args,
      this.selfAuth("claim_all_position_fees", args),
    );
    return {
      txHash: confirmed.txHash,
      amounts: scValToNative(confirmed.returnValue!) as bigint[],
    };
  }

  /** The same fee claim, prepared but not signed. See `buildDeposit`. */
  buildClaimAllPositionFees(): Promise<string> {
    const args = this.ownerArgs();
    return this.ctx.buildContract(
      this.address,
      "claim_all_position_fees",
      args,
      this.selfAuth("claim_all_position_fees", args),
    );
  }

  // -- internals ---------------------------------------------------------------------

  /** Source-account auth for a call the signer makes on this pool directly. */
  private selfAuth(fn: string, args: xdr.ScVal[]): xdr.SorobanAuthorizationEntry[] {
    return [sourceAccountEntry(authorizedInvocation(this.address, fn, args))];
  }

  private ownerArgs(): xdr.ScVal[] {
    this.requireConcentrated();
    return [new Address(this.ctx.readSource(true)).toScVal()];
  }

  private rangeArgs(tickLower: number, tickUpper: number): xdr.ScVal[] {
    return [
      ...this.ownerArgs(),
      xdr.ScVal.scvI32(tickLower),
      xdr.ScVal.scvI32(tickUpper),
    ];
  }

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

/** A swap quoted against one specific pool: execute() pins the swap there. */
export class PoolQuote {
  constructor(
    private readonly pool: Pool,
    private readonly ctx: PoolContext,
    /** Base units in. */
    readonly amountIn: bigint,
    /** The router's estimate_swap for this pool. */
    readonly amountOut: bigint,
    /** Minimum acceptable output: the estimate reduced by slippage. */
    readonly guard: bigint,
    private readonly tokenIn: string,
    private readonly tokenOut: string,
    private readonly slippage: number,
  ) {}

  /** Build, sign, submit, confirm, and parse the pinned-pool swap. */
  async execute(): Promise<Receipt> {
    const user = this.ctx.readSource(true);
    const args = [
      new Address(user).toScVal(),
      xdr.ScVal.scvVec(this.pool.tokens.map(t => new Address(t).toScVal())),
      new Address(this.tokenIn).toScVal(),
      new Address(this.tokenOut).toScVal(),
      xdr.ScVal.scvBytes(Buffer.from(this.pool.poolHash)),
      u128(this.amountIn),
      u128(this.guard),
    ];
    // Unlike the chained path (where the router pulls the tokens), the
    // single-pool flow nests: the pool's own swap calls user.require_auth()
    // and then pulls transfer(user -> pool) itself. The auth tree mirrors
    // that exactly: router.swap -> pool.swap -> token.transfer(user, pool).
    const entry = sourceAccountEntry(
      authorizedInvocation(this.ctx.router, "swap", args, [
        authorizedInvocation(
          this.pool.address,
          "swap",
          [
            new Address(user).toScVal(),
            xdr.ScVal.scvU32(this.pool.tokens.indexOf(this.tokenIn)),
            xdr.ScVal.scvU32(this.pool.tokens.indexOf(this.tokenOut)),
            u128(this.amountIn),
            u128(this.guard),
          ],
          [
            authorizedInvocation(this.tokenIn, "transfer", [
              new Address(user).toScVal(),
              new Address(this.pool.address).toScVal(),
              nativeToScVal(this.amountIn, { type: "i128" }),
            ]),
          ],
        ),
      ]),
    );
    try {
      const confirmed = await this.ctx.submitContract(this.ctx.router, "swap", args, [entry]);
      return {
        txHash: confirmed.txHash,
        amountIn: this.amountIn,
        amountOut: scValToNative(confirmed.returnValue!) as bigint,
      };
    } catch (error) {
      if (error instanceof SlippageError) {
        error.attachRequote(() =>
          this.pool.quote({
            from: this.tokenIn,
            to: this.tokenOut,
            amountIn: this.amountIn,
            slippage: this.slippage,
          }),
        );
      }
      throw error;
    }
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

  async execute(options?: { slippage?: number; minimumLiquidity?: bigint }): Promise<ConcentratedDepositResult> {
    const { args, auth } = this.plan(options);
    const confirmed = await this.ctx.submitContract(
      this.pool.address,
      "deposit_position",
      args,
      auth,
    );
    const [used, minted] = scValToNative(confirmed.returnValue!) as [bigint[], bigint];
    return { txHash: confirmed.txHash, amounts: used, liquidity: minted };
  }

  /** The same range deposit, prepared but not signed. See `Pool.buildDeposit`. */
  buildTransaction(options?: { slippage?: number; minimumLiquidity?: bigint }): Promise<string> {
    const { args, auth } = this.plan(options);
    return this.ctx.buildContract(this.pool.address, "deposit_position", args, auth);
  }

  private plan(options?: { slippage?: number; minimumLiquidity?: bigint }): {
    args: xdr.ScVal[];
    auth: xdr.SorobanAuthorizationEntry[];
  } {
    const owner = this.ctx.readSource(true);
    const factor = BigInt(Math.round((1 - (options?.slippage ?? 0.01)) * 10_000));
    const estimatedMinimum = (this.liquidity * factor) / 10_000n;
    const minLiquidity = options?.minimumLiquidity !== undefined && options.minimumLiquidity > estimatedMinimum
      ? options.minimumLiquidity : estimatedMinimum;
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
    return {
      args,
      auth: [
        sourceAccountEntry(
          authorizedInvocation(this.pool.address, "deposit_position", args, transfers),
        ),
      ],
    };
  }
}
