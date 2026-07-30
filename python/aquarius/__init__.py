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
from .limit_orders import (
    LimitOrder,
    LimitOrderConfig,
    LimitOrderFillReceipt,
    LimitOrderFillResult,
    LimitOrderPage,
    LimitOrderRecord,
    OnchainLimitOrder,
    OnchainLimitOrderReceipt,
    PreparedLimitOrderFill,
    build_onchain_placement_args,
    fill_parameters,
    parse_limit_order_record,
    route_scval_from_swap_chain,
    validate_authorization_tree,
    validate_fill_receipt,
    validate_onchain_limit_order_draft,
)
from .pool import ClaimResult, DepositResult, Pool, Position, WithdrawResult

__version__ = "0.2.0"

__all__ = [
    "ApiClient",
    "AquariusClient",
    "AquariusError",
    "Asset",
    "NETWORKS",
    "NetworkConfig",
    "LimitOrder",
    "LimitOrderConfig",
    "LimitOrderFillReceipt",
    "LimitOrderFillResult",
    "LimitOrderPage",
    "LimitOrderRecord",
    "OnchainLimitOrder",
    "OnchainLimitOrderReceipt",
    "PreparedLimitOrderFill",
    "build_onchain_placement_args",
    "fill_parameters",
    "parse_limit_order_record",
    "route_scval_from_swap_chain",
    "validate_authorization_tree",
    "validate_fill_receipt",
    "validate_onchain_limit_order_draft",
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
