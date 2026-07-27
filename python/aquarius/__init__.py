"""aquarius-sdk — the Python SDK for the Aquarius protocol on Stellar.

Swaps (quote/execute in both modes), pools, liquidity, and rewards,
with trustline and friendbot helpers, typed errors, and escape hatches.
"""

from .api import ApiClient, ParsedRoute, parse_find_path_response
from .assets import XLM, Asset
from .client import AquariusClient, Quote, Receipt
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
from .pool import ClaimResult, DepositResult, Pool, Position, WithdrawResult

__version__ = "0.2.0"

__all__ = [
    "ApiClient",
    "AquariusClient",
    "AquariusError",
    "Asset",
    "NETWORKS",
    "NetworkConfig",
    "ClaimResult",
    "DepositResult",
    "NoRouteError",
    "NoTrustlineError",
    "ParsedRoute",
    "Pool",
    "Position",
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
