"""aquarius-sdk — the Python SDK for the Aquarius protocol on Stellar.

0.1.x scope: the swap surface — quote() and execute() in both modes,
trustline and friendbot helpers, typed errors, and escape hatches.
Pools, liquidity, and rewards arrive in 0.2.
"""

from .api import ApiClient, ParsedRoute, parse_find_path_response
from .assets import XLM, Asset
from .client import AquariusClient, Quote, Receipt
from .errors import (
    AquariusError,
    NoRouteError,
    PausedError,
    SlippageError,
    TxTimeoutError,
    UserRejectedError,
)
from .networks import NETWORKS, NetworkConfig

__version__ = "0.1.0"

__all__ = [
    "ApiClient",
    "AquariusClient",
    "AquariusError",
    "Asset",
    "NETWORKS",
    "NetworkConfig",
    "NoRouteError",
    "ParsedRoute",
    "PausedError",
    "Quote",
    "Receipt",
    "SlippageError",
    "TxTimeoutError",
    "UserRejectedError",
    "XLM",
    "parse_find_path_response",
]
