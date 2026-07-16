from __future__ import annotations

import base64
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


class NoTrustlineError(AquariusError):
    """The receiving account holds no trustline for the output asset."""


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


# The token contract reports a missing trustline in its diagnostic output.
# Checked before contract codes: the same situation surfaces under different
# codes depending on where in the chain the payout fails.
_TRUSTLINE_MARKER = "trustline entry is missing"
_NO_TRUSTLINE_MESSAGE = (
    "The output recipient holds no trustline for the output asset — "
    "create the trustline on that recipient before retrying"
)


def classify_contract_code(code: int, tx_hash: str | None = None) -> AquariusError:
    """Map a numeric contract error code to a typed error."""
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


def classify_contract_error(message: str, tx_hash: str | None = None) -> AquariusError | None:
    """Map a simulation/prepare failure string to a typed error.

    Contract failures surface as substrings like ``Error(Contract, #2006)``.
    """
    if _TRUSTLINE_MARKER in message:
        return NoTrustlineError(_NO_TRUSTLINE_MESSAGE, tx_hash)
    match = _CONTRACT_ERROR_RE.search(message)
    if match:
        return classify_contract_code(int(match.group(1)), tx_hash)
    if "Error(Budget, ExceededLimit)" in message:
        return AquariusError(
            "The call exceeded Soroban resource limits — for swaps this usually means too many hops",
            tx_hash,
        )
    return None


def error_from_diagnostics(
    events_xdr: list[str] | None, tx_hash: str | None = None
) -> AquariusError | None:
    """Typed error from a failed transaction's diagnostic events, if determinable.

    The trustline marker is checked on the raw event bytes; contract error
    codes are read from ``error`` topics. Returns None when the events carry
    no recognizable cause.
    """
    from stellar_sdk.xdr import DiagnosticEvent, SCErrorType, SCValType

    code: int | None = None
    for raw in events_xdr or []:
        try:
            if _TRUSTLINE_MARKER.encode() in base64.b64decode(raw):
                return NoTrustlineError(_NO_TRUSTLINE_MESSAGE, tx_hash)
            event = DiagnosticEvent.from_xdr(raw)
            for topic in event.event.body.v0.topics:
                if (
                    code is None
                    and topic.type == SCValType.SCV_ERROR
                    and topic.error.type == SCErrorType.SCE_CONTRACT
                ):
                    code = topic.error.contract_code.uint32
        except Exception:  # noqa: BLE001 — a single undecodable event never masks the rest
            continue
    if code is not None:
        return classify_contract_code(code, tx_hash)
    return None
