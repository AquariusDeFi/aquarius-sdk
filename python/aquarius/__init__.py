"""aquarius-sdk — the Python SDK for the Aquarius protocol on Stellar.

Swaps (quote/execute in both modes), pools, liquidity, and rewards,
with trustline and friendbot helpers, typed errors, and escape hatches.
"""

from .api import ApiClient, ParsedRoute, parse_find_path_response
from .assets import XLM, Asset
from .client import AquariusClient, ProviderFeeConfig, Quote, Receipt
from .collector import ClaimedFees, FeeCollector
from .concentrated import (
    MAX_TICK,
    MIN_TICK,
    ClaimFeesResult,
    ConcentratedDepositResult,
    ConcentratedPosition,
    ConcentratedWithdrawResult,
    PositionRangeStatus,
    PositionValue,
    Slot0,
    price_at_tick,
    range_status,
    snap_tick,
    tick_from_price,
)
from .errors import (
    AquariusError,
    NoRouteError,
    NoTrustlineError,
    PausedError,
    SlippageError,
    StaleSimulationError,
    TxTimeoutError,
    UserRejectedError,
)
from .networks import NETWORKS, NetworkConfig
from .pool import ClaimResult, DepositResult, Pool, PoolQuote, Position, WithdrawResult

__version__ = "0.6.0a2"

__all__ = [
    "ApiClient",
    "AquariusClient",
    "AquariusError",
    "Asset",
    "NETWORKS",
    "NetworkConfig",
    "ClaimFeesResult",
    "ClaimedFees",
    "ClaimResult",
    "ConcentratedDepositResult",
    "ConcentratedPosition",
    "ConcentratedWithdrawResult",
    "DepositResult",
    "FeeCollector",
    "MAX_TICK",
    "MIN_TICK",
    "PositionRangeStatus",
    "PositionValue",
    "Slot0",
    "price_at_tick",
    "range_status",
    "snap_tick",
    "tick_from_price",
    "NoRouteError",
    "NoTrustlineError",
    "ParsedRoute",
    "Pool",
    "PoolQuote",
    "Position",
    "ProviderFeeConfig",
    "WithdrawResult",
    "PausedError",
    "Quote",
    "Receipt",
    "SlippageError",
    "StaleSimulationError",
    "TxTimeoutError",
    "UserRejectedError",
    "XLM",
    "parse_find_path_response",
]
