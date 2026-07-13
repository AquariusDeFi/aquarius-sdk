"""aquarius-sdk — the Python SDK for the Aquarius protocol on Stellar.

Interface preview. The swap surface works end-to-end on testnet and mainnet;
pools, liquidity, and rewards are not implemented yet.
"""

from .assets import XLM, Asset
from .client import AquariusClient, Quote, Receipt
from .errors import AquariusError, NoRouteError, SlippageError

__version__ = "0.0.1"

__all__ = [
    "AquariusClient",
    "Asset",
    "XLM",
    "Quote",
    "Receipt",
    "AquariusError",
    "NoRouteError",
    "SlippageError",
]
