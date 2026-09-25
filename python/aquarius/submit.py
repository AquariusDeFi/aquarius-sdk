from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Callable

from stellar_sdk import (
    Account,
    SorobanDataBuilder,
    SorobanServer,
    TransactionBuilder,
    TransactionEnvelope,
)
from stellar_sdk.soroban_rpc import GetTransactionStatus, SendTransactionStatus
from stellar_sdk.xdr import Int64, SCVal, TransactionMeta, TransactionResult

from .errors import (
    AquariusError,
    TxTimeoutError,
    classify_contract_error,
    error_from_diagnostics,
)
from .signer import sign_transaction, signer_public_key

# Congestion backoff between resubmissions of the same signed transaction.
# Resubmitting is safe: the network dedupes by transaction hash. Starts fast —
# transient congestion often clears within a ledger — and escalates.
_RETRY_DELAYS_S = (0.5, 1.0, 2.0, 4.0, 8.0)


class _BadSeqRejection(AquariusError):
    """txBAD_SEQ on submission — retried internally with a fresh sequence."""

_POLL_ATTEMPTS = 30
_POLL_INTERVAL_S = 2

# Fraction of the simulated Soroban resource fee added on top of it. The
# declared resource fee is a cap: the network charges the non-refundable part
# plus the refundable part actually consumed (rent, events, return value) and
# refunds the rest, so headroom costs nothing unless it is used. The refundable
# part depends on ledger state at apply time, which can change between
# simulation and apply; without headroom such a transaction fails on-chain with
# INVOKE_HOST_FUNCTION_INSUFFICIENT_REFUNDABLE_FEE.
DEFAULT_RESOURCE_FEE_HEADROOM = 0.5

_UINT32_MAX = 4_294_967_295


def validate_resource_fee_headroom(headroom) -> float:
    """Raise unless ``headroom`` is a non-negative finite number."""
    if (
        isinstance(headroom, bool)
        or not isinstance(headroom, (int, float))
        or not math.isfinite(headroom)
        or headroom < 0
    ):
        raise AquariusError("resource_fee_headroom must be a non-negative finite number")
    return headroom


def with_resource_fee_headroom(tx: TransactionEnvelope, headroom: float) -> TransactionEnvelope:
    """Raise the declared Soroban resource fee by ceil(resource_fee * headroom)
    and the total fee by the same amount, so the inclusion fee is unchanged.

    The increase is capped so the total fee stays within uint32. Transactions
    without Soroban data are returned as is. Mutates and returns ``tx``.
    """
    soroban_data = tx.transaction.soroban_data
    if headroom == 0 or soroban_data is None:
        return tx
    resource_fee = soroban_data.resource_fee.int64
    room = _UINT32_MAX - tx.transaction.fee
    wanted = resource_fee * headroom
    extra = room if wanted >= room else math.ceil(wanted)
    soroban_data.resource_fee = Int64(resource_fee + extra)
    tx.transaction.fee += extra
    return tx


@dataclass
class ConfirmedTx:
    tx_hash: str
    return_value: SCVal | None


class SubmitEngine:
    """Builds, simulates, signs, submits, and confirms transactions.

    Handles the production failure modes: archived ledger state (restore and
    retry), network congestion (bounded resubmission), stale sequence numbers
    from load-balanced RPC (re-sign and resubmit), and typed contract errors.
    Results are read from the confirmed transaction's Soroban return value —
    this is the single place in the SDK that touches transaction meta.
    """

    # Delays before re-signing after a txBAD_SEQ rejection. Behind a
    # load-balanced RPC, the replica that served the sequence number may lag
    # the one that confirmed the previous transaction. The reload usually
    # lands on a converged replica, so retry fast first and escalate.
    # Class attribute so tests can shrink the delays.
    _bad_seq_delays_s: tuple = (0.5, 1.0, 2.0)

    def __init__(
        self,
        server: SorobanServer,
        passphrase: str,
        base_fee: int,
        timeout: int | None = None,
        resource_fee_headroom: float = DEFAULT_RESOURCE_FEE_HEADROOM,
    ):
        self.server = server
        self.passphrase = passphrase
        self.base_fee = base_fee
        # Transaction time bound in seconds; None means no upper bound (the
        # right default when a human signs through a wallet, the wrong one for
        # bots, whose stale transactions should expire rather than execute).
        self.timeout = timeout
        # Fraction of the simulated resource fee added on top of it before
        # signing; 0 disables. See DEFAULT_RESOURCE_FEE_HEADROOM.
        self.resource_fee_headroom = validate_resource_fee_headroom(resource_fee_headroom)
        self._simulation_accounts: dict[str, Account] = {}

    def build_transaction(
        self, source: str, append: Callable[[TransactionBuilder], TransactionBuilder]
    ) -> TransactionEnvelope:
        return self._build(self.server.load_account(source), append)

    def _build(
        self, account: Account, append: Callable[[TransactionBuilder], TransactionBuilder]
    ) -> TransactionEnvelope:
        builder = TransactionBuilder(
            account, network_passphrase=self.passphrase, base_fee=self.base_fee
        )
        builder = append(builder)
        if self.timeout is None:
            return builder.add_time_bounds(0, 0).build()
        return builder.set_timeout(self.timeout).build()

    def _simulation_account(self, source: str) -> Account:
        # Simulation ignores sequence numbers, so one fetch per source serves
        # every read. Writes keep loading fresh accounts via build_transaction.
        account = self._simulation_accounts.get(source)
        if account is None:
            account = self.server.load_account(source)
            self._simulation_accounts[source] = account
        return account

    def prepare(
        self,
        source: str,
        append: Callable[[TransactionBuilder], TransactionBuilder],
        signer=None,
    ) -> TransactionEnvelope:
        """Simulate and assemble a contract transaction.

        If simulation reports archived ledger entries, restore them first (one
        extra signed transaction), then rebuild and simulate again.
        """
        tx = self.build_transaction(source, append)
        simulation = self.server.simulate_transaction(tx)

        if simulation.restore_preamble is not None:
            if signer is None:
                raise AquariusError(
                    "Ledger entries for this call are archived and need a restore, "
                    "which requires a signer"
                )
            self._restore(source, simulation.restore_preamble, signer)
            tx = self.build_transaction(source, append)
            simulation = self.server.simulate_transaction(tx)

        if simulation.error is not None:
            raise classify_contract_error(simulation.error) or AquariusError(simulation.error)

        return with_resource_fee_headroom(
            self.server.prepare_transaction(tx, simulation), self.resource_fee_headroom
        )

    def _restore(self, source: str, preamble, signer) -> None:
        account = self.server.load_account(source)
        # The builder adds the Soroban resource fee to the inclusion fee.
        soroban_data = (
            SorobanDataBuilder.from_xdr(preamble.transaction_data)
            .set_resource_fee(int(preamble.min_resource_fee))
            .build()
        )
        restore_tx = with_resource_fee_headroom(
            TransactionBuilder(account, network_passphrase=self.passphrase, base_fee=self.base_fee)
            .append_restore_footprint_op()
            .set_soroban_data(soroban_data)
            .add_time_bounds(0, 0)
            .build(),
            self.resource_fee_headroom,
        )
        signed = sign_transaction(signer, restore_tx, self.passphrase)
        self._submit(signed)

    def read(
        self,
        source: str,
        append: Callable[[TransactionBuilder], TransactionBuilder],
        signer=None,
    ) -> SCVal:
        """Execute a read through simulation — nothing is signed or submitted.

        If the entries are archived and a signer is available, restore them
        first (one signed transaction), then simulate again.
        """
        tx = self._build(self._simulation_account(source), append)
        simulation = self.server.simulate_transaction(tx)

        if simulation.restore_preamble is not None and signer is not None:
            self._restore(source, simulation.restore_preamble, signer)
            tx = self._build(self._simulation_account(source), append)
            simulation = self.server.simulate_transaction(tx)

        if simulation.error is not None:
            raise classify_contract_error(simulation.error) or AquariusError(simulation.error)
        if not simulation.results:
            raise AquariusError("Simulation returned no result")
        return SCVal.from_xdr(simulation.results[0].xdr)

    def sign_and_submit(self, tx: TransactionEnvelope, signer) -> ConfirmedTx:
        """Sign, submit with congestion retries, and wait for confirmation.

        A txBAD_SEQ rejection never touched the chain, so it is safe to retry:
        the transaction is re-signed with a freshly loaded sequence number and
        resubmitted — same operations, same guards.
        """
        signed = sign_transaction(signer, tx, self.passphrase)
        for delay in self._bad_seq_delays_s:
            try:
                return self._submit(signed)
            except _BadSeqRejection:
                time.sleep(delay)
                signed = self._resign_with_fresh_sequence(signed, signer)
        return self._submit(signed)

    def _resign_with_fresh_sequence(
        self, signed: TransactionEnvelope, signer
    ) -> TransactionEnvelope:
        source = self.server.load_account(signed.transaction.source.account_id)
        signed.transaction.sequence = source.sequence + 1
        signed.signatures = []
        return sign_transaction(signer, signed, self.passphrase)

    def _submit(self, signed: TransactionEnvelope) -> ConfirmedTx:
        attempt = 0
        while True:
            try:
                return self._send_and_poll(signed)
            except TxTimeoutError:
                if attempt >= len(_RETRY_DELAYS_S):
                    raise
                time.sleep(_RETRY_DELAYS_S[attempt])
                attempt += 1

    def _send_and_poll(self, signed: TransactionEnvelope) -> ConfirmedTx:
        response = self.server.send_transaction(signed)

        if response.status == SendTransactionStatus.TRY_AGAIN_LATER:
            raise TxTimeoutError("The network is congested — submission deferred", response.hash)
        if response.status in (SendTransactionStatus.PENDING, SendTransactionStatus.DUPLICATE):
            return self._poll(response.hash)
        name = "unknown"
        if response.error_result_xdr:
            try:
                result = TransactionResult.from_xdr(response.error_result_xdr)
                name = result.result.code.name
            except Exception:  # noqa: BLE001 — best-effort decode for the message
                pass
        message = f"Transaction rejected on submission: {name}"
        if name == "txBAD_SEQ":
            raise _BadSeqRejection(message, response.hash)
        raise AquariusError(message, response.hash)

    def _poll(self, tx_hash: str) -> ConfirmedTx:
        # Poll fast at first — inclusion often lands within a ledger — then
        # settle into the steady interval.
        result = self.server.poll_transaction(
            tx_hash,
            max_attempts=_POLL_ATTEMPTS,
            sleep_strategy=lambda attempt: min(0.5 * max(attempt, 1), _POLL_INTERVAL_S),
        )

        if result.status == GetTransactionStatus.SUCCESS:
            return ConfirmedTx(tx_hash=tx_hash, return_value=self._return_value(result))
        if result.status == GetTransactionStatus.FAILED:
            diagnosed = error_from_diagnostics(result.diagnostic_events_xdr, tx_hash)
            if diagnosed is not None:
                raise diagnosed
            raise AquariusError(
                "The transaction failed on-chain without recognized diagnostics. "
                "Inspect the transaction hash before retrying.",
                tx_hash,
            )
        raise TxTimeoutError("Transaction was not confirmed in time", tx_hash)

    @staticmethod
    def _return_value(result) -> SCVal | None:
        if not result.result_meta_xdr:
            return None
        meta = TransactionMeta.from_xdr(result.result_meta_xdr)
        soroban_meta = meta.v4.soroban_meta if meta.v == 4 else meta.v3.soroban_meta
        return soroban_meta.return_value if soroban_meta else None


__all__ = ["ConfirmedTx", "SubmitEngine", "signer_public_key"]
