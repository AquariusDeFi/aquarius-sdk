from __future__ import annotations

import re


class AquariusError(Exception):
    """Base class for every error this SDK raises."""

    def __init__(self, message: str, tx_hash: str | None = None):
        super().__init__(message)
        self.tx_hash = tx_hash


class NoRouteError(AquariusError):
    """The find-path API found no route for the requested pair and amount."""


class SlippageError(AquariusError):
    """The pool moved past your guard (contract errors 2006 / 2020). Re-quote and retry."""

    _requote_thunk = None

    def requote(self):
        """A fresh quote for the same parameters."""
        if self._requote_thunk is None:
            raise AquariusError("requote() is only available on errors raised by execute()")
        return self._requote_thunk()

    def attach_requote(self, thunk) -> "SlippageError":
        self._requote_thunk = thunk
        return self


class PausedError(AquariusError):
    """Operations paused by an emergency kill switch (contract errors 205-207). Not your bug."""


class UserRejectedError(AquariusError):
    """The signer (wallet) rejected the transaction."""


class TxTimeoutError(AquariusError):
    """The transaction was not confirmed within the polling window. Safe to retry."""


# Wallet-rejection messages across signers: Freighter, WalletConnect, Ledger.
_USER_REJECTED_MESSAGES = (
    "the user rejected this request.",
    "cancelled_by_user",
    "transaction cancelled by the user",
)

_CONTRACT_ERROR_RE = re.compile(r"Error\(Contract, #(\d+)\)")
_PAUSED_CODES = {205, 206, 207, 2139}
_SLIPPAGE_CODES = {2005, 2006, 2020}


def is_user_rejection(error: object) -> bool:
    message = str(error).lower()
    return any(m in message for m in _USER_REJECTED_MESSAGES)


def classify_contract_error(message: str, tx_hash: str | None = None) -> AquariusError | None:
    """Map a simulation/prepare failure string to a typed error.

    Contract failures surface as substrings like ``Error(Contract, #2006)``.
    """
    match = _CONTRACT_ERROR_RE.search(message)
    if match:
        code = int(match.group(1))
        if code in _SLIPPAGE_CODES:
            return SlippageError(
                f"Price moved past your guard (contract error #{code}) — re-quote and retry",
                tx_hash,
            )
        if code in _PAUSED_CODES:
            return PausedError(
                f"Operations are paused for this pool (contract error #{code}) — not an integration bug",
                tx_hash,
            )
        return AquariusError(f"Contract error #{code}", tx_hash)
    if "Error(Budget, ExceededLimit)" in message:
        return AquariusError(
            "The call exceeded Soroban resource limits — for swaps this usually means too many hops",
            tx_hash,
        )
    return None
