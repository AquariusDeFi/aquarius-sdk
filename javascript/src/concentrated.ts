/**
 * Concentrated-liquidity tick math and position types (beta surface).
 *
 * Integer-only tick math, bit-for-bit identical to the Python package
 * (pinned by the shared golden fixture): a given price string maps to the
 * same tick in both languages, deterministically. Amounts and liquidity are
 * always quoted through the pool contract's own `estimate_*` functions —
 * client math converts prices to ticks, it never decides amounts.
 */

import { AquariusError } from "./errors.js";

export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;

// floor(2^128 / sqrt(1.0001)^(2^i)) for i in 0..19, generated from exact
// integer arithmetic (the accuracy test re-derives spot values from first
// principles). Entry 0 matches the canonical reference constant.
const INV_SQRT_Q128: bigint[] = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e2139n,
  0xfff2e50f5f656932ef12357cf3c7fdcbn,
  0xffe5caca7e10e4e61c3624eaa0941ccfn,
  0xffcb9843d60f6159c9db58835c926643n,
  0xff973b41fa98c081472e6896dfb254bfn,
  0xff2ea16466c96a3843ec78b326b52860n,
  0xfe5dee046a99a2a811c461f1969c3052n,
  0xfcbe86c7900a88aedcffc83b479aa3a3n,
  0xf987a7253ac413176f2b074cf7815e53n,
  0xf3392b0822b70005940c7a398e4b70f2n,
  0xe7159475a2c29b7443b29c7fa6e889d8n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e4n,
  0x70d869a156d2a1b890bb3df62baf32f6n,
  0x31be135f97d08fd981231505542fcfa5n,
  0x09aa508b5b7a84e1c677de54f3e99bc8n,
  0x005d6af8dedb81196699c329225ee604n,
  0x00002216e584f5fa1ea926041bedfe97n,
  0x00000000048a170391f7dc42444e8fa2n,
];

/** sqrt(1.0001^tick) in Q64.96 fixed point (floored). */
export function sqrtRatioX96(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new AquariusError(`tick ${tick} is outside [${MIN_TICK}, ${MAX_TICK}]`);
  }
  const t = Math.abs(tick);
  let ratio = 1n << 128n;
  for (let i = 0; i < INV_SQRT_Q128.length; i++) {
    if ((t >> i) & 1) ratio = (ratio * INV_SQRT_Q128[i]) >> 128n;
  }
  if (tick > 0) ratio = (1n << 256n) / ratio;
  return ratio >> 32n;
}

function bigintSqrt(n: bigint): bigint {
  if (n < 0n) throw new AquariusError("sqrt of a negative number");
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const next = (x + n / x) >> 1n;
    if (next >= x) return x;
    x = next;
  }
}

function priceFraction(
  price: number | string,
  decimals?: [number, number],
): [bigint, bigint] {
  const s = (typeof price === "number" ? price.toString() : String(price)).trim();
  const match = /^\+?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!match) throw new AquariusError(`Not a decimal price: ${s}`);
  const [, whole, frac = "", exp = "0"] = match;
  let num = BigInt(whole + frac);
  let den = 10n ** BigInt(frac.length);
  const exponent = parseInt(exp, 10);
  if (exponent >= 0) num *= 10n ** BigInt(exponent);
  else den *= 10n ** BigInt(-exponent);
  if (decimals) {
    // Convert a human display price into the raw base-unit ratio the ticks
    // are denominated in: raw = display * 10^(d1 - d0).
    const shift = decimals[1] - decimals[0];
    if (shift >= 0) num *= 10n ** BigInt(shift);
    else den *= 10n ** BigInt(-shift);
  }
  if (num <= 0n) throw new AquariusError("price must be a positive finite number");
  return [num, den];
}

/**
 * The largest tick whose price is <= the given price (token1 per token0,
 * both in base units). `decimals: [d0, d1]` converts a display price first.
 */
export function tickFromPrice(
  price: number | string,
  options?: { decimals?: [number, number] },
): number {
  const [num, den] = priceFraction(price, options?.decimals);
  const x96 = bigintSqrt((num << 192n) / den);
  if (x96 < sqrtRatioX96(MIN_TICK)) {
    throw new AquariusError("price is below the minimum representable tick");
  }
  let lo = MIN_TICK;
  let hi = MAX_TICK;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (sqrtRatioX96(mid) <= x96) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Display price for a tick (float — for labels, not for guard math). */
export function priceAtTick(tick: number, options?: { decimals?: [number, number] }): number {
  let price = 1.0001 ** tick;
  if (options?.decimals) price *= 10 ** (options.decimals[0] - options.decimals[1]);
  return price;
}

/** Tick spacing per fee tier, as the factory assigns it (basis points -> ticks). */
const TICK_SPACING_BY_FEE: Record<number, number> = { 10: 20, 30: 60, 100: 200 };

/** The tick spacing a concentrated pool of this fee tier is created with. */
export function tickSpacingForFee(feeBps: number): number {
  const spacing = TICK_SPACING_BY_FEE[feeBps];
  if (spacing === undefined) {
    throw new AquariusError(
      `No concentrated fee tier of ${feeBps} bps; supported: ${Object.keys(TICK_SPACING_BY_FEE).join(", ")}`,
    );
  }
  return spacing;
}

export type RangeStatus = "in_range" | "below" | "above";

/**
 * Where a tick sits relative to a range: "in_range", "below", or "above".
 *
 * Matches the contract's active-liquidity semantics exactly: the range is
 * half-open `[tickLower, tickUpper)`, so at `tickUpper` a position is
 * already out of range and earns no fees.
 */
export function rangeStatus(tick: number, tickLower: number, tickUpper: number): RangeStatus {
  if (tickLower >= tickUpper) {
    throw new AquariusError("tickLower must be below tickUpper");
  }
  if (tick < tickLower) return "below";
  if (tick >= tickUpper) return "above";
  return "in_range";
}

/**
 * Align a tick to the pool's spacing (floor by default, ceil with up=true),
 * clamped to the spacing-aligned representable bounds.
 */
export function snapTick(tick: number, spacing: number, options?: { up?: boolean }): number {
  if (!Number.isInteger(spacing) || spacing <= 0) {
    throw new AquariusError("tick spacing must be positive");
  }
  const quotient = options?.up ? Math.ceil(tick / spacing) : Math.floor(tick / spacing);
  const snapped = quotient * spacing;
  const bound = Math.floor(MAX_TICK / spacing) * spacing;
  return Math.min(Math.max(snapped, -bound), bound);
}

// --- position types ---------------------------------------------------------------

export interface Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
}

export interface ConcentratedPosition {
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

/**
 * Where the current price sits relative to a position's range.
 *
 * "below" means the price is under the range — the position sits entirely
 * in the first sorted token; "above" means over it — entirely in the
 * second. Fees accrue only while "in_range".
 */
export interface PositionRangeStatus {
  status: RangeStatus;
  inRange: boolean;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  /** currentTick - tickLower (negative: below the range). */
  ticksFromLower: number;
  /** tickUpper - currentTick (zero or negative: above the range). */
  ticksToUpper: number;
}

/** A position's worth, split honestly: total = principal + fees. */
export interface PositionValue {
  /** What a full withdrawal returns now (fees auto-claimed). */
  total: bigint[];
  /** Accrued, unclaimed fees. */
  fees: bigint[];
  /** Total minus fees, floored at zero. */
  principal: bigint[];
}

export interface ConcentratedDepositResult {
  txHash: string;
  /** Base units actually used, in sorted-token order. */
  amounts: bigint[];
  /** Raw liquidity units minted. */
  liquidity: bigint;
}

export interface ConcentratedWithdrawResult {
  txHash: string;
  /** Base units returned (incl. auto-claimed fees). */
  amounts: bigint[];
}

export interface ClaimFeesResult {
  txHash: string;
  /** Fees paid out, in sorted-token order. */
  amounts: bigint[];
}
