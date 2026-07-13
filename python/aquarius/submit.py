from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

from stellar_sdk import SorobanServer, TransactionBuilder, TransactionEnvelope
from stellar_sdk.soroban_rpc import GetTransactionStatus, SendTransactionStatus
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
# Resubmitting is safe: the network dedupes by transaction hash.
_RETRY_DELAYS_S = (1.5, 3.0, 5.0, 8.0)

_POLL_ATTEMPTS = 30
_POLL_INTERVAL_S = 2


@dataclass
class ConfirmedTx:
    tx_hash: str
    return_value: SCVal | None


class SubmitEngine:
    """Builds, simulates, signs, submits, and confirms transactions.

    Handles the production failure modes: archived ledger state (restore and
    retry), network congestion (bounded resubmission), and typed contract
    errors. Results are read from the confirmed transaction's Soroban return
    value — this is the single place in the SDK that touches transaction meta.
    """

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

    def build_transaction(
        self, source: str, append: Callable[[TransactionBuilder], TransactionBuilder]
    ) -> TransactionEnvelope:
        account = self.server.load_account(source)
        builder = TransactionBuilder(
            account, network_passphrase=self.passphrase, base_fee=self.base_fee
        )
        builder = append(builder)
        if self.timeout is None:
            return builder.add_time_bounds(0, 0).build()
        return builder.set_timeout(self.timeout).build()

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

        return self.server.prepare_transaction(tx, simulation)

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
    ) -> SCVal | None:
        """Execute a read through simulation — nothing is signed or submitted.

        If the entries are archived and a signer is available, restore them
        first (one signed transaction), then simulate again.
        """
        tx = self.build_transaction(source, append)
        simulation = self.server.simulate_transaction(tx)

        if simulation.restore_preamble is not None and signer is not None:
            self._restore(source, simulation.restore_preamble, signer)
            tx = self.build_transaction(source, append)
            simulation = self.server.simulate_transaction(tx)

        if simulation.error is not None:
            raise classify_contract_error(simulation.error) or AquariusError(simulation.error)
        if not simulation.results:
            return None
        return SCVal.from_xdr(simulation.results[0].xdr)

    def sign_and_submit(self, tx: TransactionEnvelope, signer) -> ConfirmedTx:
        """Sign, submit with congestion retries, and wait for confirmation."""
        signed = sign_transaction(signer, tx, self.passphrase)
        return self._submit(signed)

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
        raise AquariusError(f"Transaction rejected on submission: {name}", response.hash)

    def _poll(self, tx_hash: str) -> ConfirmedTx:
        result = self.server.poll_transaction(
            tx_hash, max_attempts=_POLL_ATTEMPTS, sleep_strategy=lambda _i: _POLL_INTERVAL_S
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
