from __future__ import annotations

import time
from copy import deepcopy
from dataclasses import dataclass
from typing import Callable

from stellar_sdk import Account, InvokeHostFunction, SorobanServer, TransactionBuilder, TransactionEnvelope
from stellar_sdk.soroban_rpc import AuthMode, GetTransactionStatus, SendTransactionStatus
from stellar_sdk.xdr import SCVal, TransactionMeta, TransactionResult

from .errors import (
    AquariusError,
    SlippageError,
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
    ):
        self.server = server
        self.passphrase = passphrase
        self.base_fee = base_fee
        # Transaction time bound in seconds; None means no upper bound (the
        # right default when a human signs through a wallet, the wrong one for
        # bots, whose stale transactions should expire rather than execute).
        self.timeout = timeout
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
        """Enforce client-built authorization and assemble transaction resources.

        If simulation reports archived ledger entries, restore them first (one
        extra signed transaction), then rebuild and simulate again.
        """
        tx = self.build_transaction(source, append)
        fixed_operations = deepcopy(tx.transaction.operations)
        expected_operations = self._operation_xdr(tx)
        simulation = self.server.simulate_transaction(tx, auth_mode=AuthMode.ENFORCE)

        if simulation.restore_preamble is not None:
            if signer is None:
                raise AquariusError(
                    "Ledger entries for this call are archived and need a restore, "
                    "which requires a signer"
                )
            self._restore(source, simulation.restore_preamble, signer)

            def append_fixed(builder):
                for op in fixed_operations:
                    builder.append_operation(deepcopy(op))
                return builder

            tx = self.build_transaction(source, append_fixed)
            simulation = self.server.simulate_transaction(tx, auth_mode=AuthMode.ENFORCE)

        if simulation.error is not None:
            raise classify_contract_error(simulation.error) or AquariusError(simulation.error)
        if simulation.restore_preamble is not None:
            raise AquariusError("Ledger entries remain archived after restore")
        if not simulation.results and any(
            isinstance(op, InvokeHostFunction) for op in tx.transaction.operations
        ):
            raise AquariusError("Simulation returned no result")

        # stellar-sdk fills an empty op.auth from simulation.results[].auth.
        # Strip that input even for an explicitly empty client list: RPC auth
        # must never become part of an envelope prepared for signing.
        resources = deepcopy(simulation)
        for result in resources.results or []:
            result.auth = []
        prepared = self.server.prepare_transaction(tx, resources)
        if self._operation_xdr(prepared) != expected_operations:
            raise AquariusError("Transaction operation or authorization changed during preparation")
        return prepared

    @staticmethod
    def _operation_xdr(tx: TransactionEnvelope) -> tuple[str, ...]:
        """Freeze operations, including empty auth and arguments, before RPC."""
        return tuple(op.to_xdr_object().to_xdr() for op in tx.transaction.operations)

    def _restore(self, source: str, preamble, signer) -> None:
        account = self.server.load_account(source)
        fee = self.base_fee + int(preamble.min_resource_fee)
        restore_tx = (
            TransactionBuilder(account, network_passphrase=self.passphrase, base_fee=fee)
            .append_restore_footprint_op()
            .set_soroban_data(preamble.transaction_data)
            .add_time_bounds(0, 0)
            .build()
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
            # No recognizable cause in the diagnostics: simulation already
            # passed, so pool state most likely moved past the guard between
            # simulation and inclusion.
            raise SlippageError(
                "The transaction failed on-chain — pool state likely moved past your "
                "guard between simulation and inclusion. Re-quote and retry.",
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
