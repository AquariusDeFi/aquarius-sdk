"""Concentrated-liquidity tick math and position types (beta surface).

Integer-only tick math, bit-for-bit identical to the JS package (pinned by
the shared golden fixture): a given price string maps to the same tick in
both languages, deterministically. Amounts and liquidity for positions are
always quoted through the pool contract's own ``estimate_*`` functions —
client math converts prices to ticks, it never decides amounts.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from math import isqrt

from .errors import AquariusError

MIN_TICK = -887_272
MAX_TICK = 887_272

# floor(2^128 / sqrt(1.0001)^(2^i)) for i in 0..19, generated from exact
# integer arithmetic (the accuracy test re-derives spot values from first
# principles). Entry 0 matches the canonical reference constant.
_INV_SQRT_Q128 = (
    0xFFFCB933BD6FAD37AA2D162D1A594001,
    0xFFF97272373D413259A46990580E2139,
    0xFFF2E50F5F656932EF12357CF3C7FDCB,
    0xFFE5CACA7E10E4E61C3624EAA0941CCF,
    0xFFCB9843D60F6159C9DB58835C926643,
    0xFF973B41FA98C081472E6896DFB254BF,
    0xFF2EA16466C96A3843EC78B326B52860,
    0xFE5DEE046A99A2A811C461F1969C3052,
    0xFCBE86C7900A88AEDCFFC83B479AA3A3,
    0xF987A7253AC413176F2B074CF7815E53,
    0xF3392B0822B70005940C7A398E4B70F2,
    0xE7159475A2C29B7443B29C7FA6E889D8,
    0xD097F3BDFD2022B8845AD8F792AA5825,
    0xA9F746462D870FDF8A65DC1F90E061E4,
    0x70D869A156D2A1B890BB3DF62BAF32F6,
    0x31BE135F97D08FD981231505542FCFA5,
    0x09AA508B5B7A84E1C677DE54F3E99BC8,
    0x005D6AF8DEDB81196699C329225EE604,
    0x00002216E584F5FA1EA926041BEDFE97,
    0x00000000048A170391F7DC42444E8FA2,
)


def sqrt_ratio_x96(tick: int) -> int:
    """sqrt(1.0001^tick) in Q64.96 fixed point (floored)."""
    if not MIN_TICK <= tick <= MAX_TICK:
        raise AquariusError(f"tick {tick} is outside [{MIN_TICK}, {MAX_TICK}]")
    t = abs(tick)
    ratio = 1 << 128
    for i, constant in enumerate(_INV_SQRT_Q128):
        if t >> i & 1:
            ratio = (ratio * constant) >> 128
    if tick > 0:
        ratio = (1 << 256) // ratio
    return ratio >> 32


def _price_fraction(price, decimals: tuple[int, int] | None) -> tuple[int, int]:
    try:
        d = Decimal(str(price))
    except Exception as error:
        raise AquariusError(f"Not a decimal price: {price!r}") from error
    if not d.is_finite() or d <= 0:
        raise AquariusError("price must be a positive finite number")
    num, den = d.as_integer_ratio()
    if decimals is not None:
        # Convert a human display price into the raw base-unit ratio the
        # ticks are denominated in: raw = display * 10^(d1 - d0).
        d0, d1 = decimals
        shift = d1 - d0
        if shift >= 0:
            num *= 10**shift
        else:
            den *= 10**-shift
    return num, den


def tick_from_price(price, *, decimals: tuple[int, int] | None = None) -> int:
    """The largest tick whose price is <= the given price (token1 per token0,
    both in base units). ``decimals=(d0, d1)`` converts a display price first.
    """
    num, den = _price_fraction(price, decimals)
    x96 = isqrt((num << 192) // den)
    if x96 < sqrt_ratio_x96(MIN_TICK):
        raise AquariusError("price is below the minimum representable tick")
    lo, hi = MIN_TICK, MAX_TICK
    while lo < hi:
        mid = (lo + hi + 1) >> 1  # arithmetic shift floors, keeping the search exact
        if sqrt_ratio_x96(mid) <= x96:
            lo = mid
        else:
            hi = mid - 1
    return lo


def price_at_tick(tick: int, *, decimals: tuple[int, int] | None = None) -> float:
    """Display price for a tick (float — for labels, not for guard math)."""
    price = 1.0001**tick
    if decimals is not None:
        price *= 10.0 ** (decimals[0] - decimals[1])
    return price


def range_status(tick: int, tick_lower: int, tick_upper: int) -> str:
    """Where a tick sits relative to a range: "in_range", "below", or "above".

    Matches the contract's active-liquidity semantics exactly: the range is
    half-open ``[tick_lower, tick_upper)``, so at ``tick_upper`` a position
    is already out of range and earns no fees.
    """
    if tick_lower >= tick_upper:
        raise AquariusError("tick_lower must be below tick_upper")
    if tick < tick_lower:
        return "below"
    if tick >= tick_upper:
        return "above"
    return "in_range"


def snap_tick(tick: int, spacing: int, *, up: bool = False) -> int:
    """Align a tick to the pool's spacing (floor by default, ceil with up=True),
    clamped to the spacing-aligned representable bounds."""
    if spacing <= 0:
        raise AquariusError("tick spacing must be positive")
    quotient = -(-tick // spacing) if up else tick // spacing
    snapped = quotient * spacing
    bound = (MAX_TICK // spacing) * spacing
    return min(max(snapped, -bound), bound)


# --- position types ---------------------------------------------------------------


@dataclass
class Slot0:
    sqrt_price_x96: int
    tick: int


@dataclass
class ConcentratedPosition:
    tick_lower: int
    tick_upper: int
    liquidity: int


@dataclass
class PositionRangeStatus:
    """Where the current price sits relative to a position's range.

    "below" means the price is under the range — the position sits entirely
    in the first sorted token; "above" means over it — entirely in the
    second. Fees accrue only while "in_range".
    """

    status: str            # "in_range" | "below" | "above"
    current_tick: int
    tick_lower: int
    tick_upper: int
    ticks_from_lower: int  # current_tick - tick_lower (negative: below the range)
    ticks_to_upper: int    # tick_upper - current_tick (zero or negative: above)

    @property
    def in_range(self) -> bool:
        return self.status == "in_range"


@dataclass
class PositionValue:
    """A position's worth, split honestly: total = principal + fees."""

    total: list[int]      # what a full withdrawal returns now (fees auto-claimed)
    fees: list[int]       # accrued, unclaimed fees
    principal: list[int]  # total minus fees, floored at zero


@dataclass
class ConcentratedDepositResult:
    tx_hash: str
    amounts: list[int]  # base units actually used, in sorted-token order
    liquidity: int      # raw liquidity units minted


@dataclass
class ConcentratedWithdrawResult:
    tx_hash: str
    amounts: list[int]  # base units returned (incl. auto-claimed fees)


@dataclass
class ClaimFeesResult:
    tx_hash: str
    amounts: list[int]  # fees paid out, in sorted-token order
