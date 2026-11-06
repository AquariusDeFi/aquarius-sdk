from __future__ import annotations

import math
import time
from copy import deepcopy
from dataclasses import dataclass
from typing import Callable

from stellar_sdk import (
    Account,
    InvokeHostFunction,
    SorobanDataBuilder,
    SorobanServer,
    TransactionBuilder,
    TransactionEnvelope,
)
from stellar_sdk.soroban_rpc import AuthMode, GetTransactionStatus, SendTransactionStatus
from stellar_sdk.xdr import (
    ConfigSettingID,
    Int64,
    LedgerEntryData,
    LedgerEntryType,
    LedgerKey,
    LedgerKeyConfigSetting,
    SCVal,
    TransactionMeta,
    TransactionResult,
    Uint32,
)

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

# How often wait_for_next_ledger polls the RPC's latest ledger.
_NEXT_LEDGER_POLL_INTERVAL_S = 1.0

# Fraction of the simulated Soroban resource fee added on top of it. The
# declared resource fee is a cap: the network charges the non-refundable part
# plus the refundable part actually consumed (rent, events, return value) and
# refunds the rest, so headroom costs nothing unless it is used. The refundable
# part depends on ledger state at apply time, which can change between
# simulation and apply; without headroom such a transaction fails on-chain with
# INVOKE_HOST_FUNCTION_INSUFFICIENT_REFUNDABLE_FEE.
DEFAULT_RESOURCE_FEE_HEADROOM = 0.5

# Fraction of the simulated CPU instructions added on top of them. Simulation
# measures instructions against ledger state at simulation time, and the
# declared count is a hard limit: a transaction that needs even one more
# instruction at apply time fails on-chain with
# INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED. Swaps have been observed to use
# from ~0% to ~9% more instructions than simulated.
DEFAULT_INSTRUCTION_HEADROOM = 0.25

_UINT32_MAX = 4_294_967_295

# Soroban charges compute per this many instructions.
_INSTRUCTIONS_INCREMENT = 10_000

# How long the network's compute settings are reused. They change only through
# validator-voted network upgrades.
_NETWORK_COMPUTE_TTL_S = 60 * 60


@dataclass(frozen=True)
class NetworkCompute:
    """The network's CONFIG_SETTING_CONTRACT_COMPUTE_V0 values used here."""

    tx_max_instructions: int
    fee_rate_per_instructions_increment: int


def validate_headroom(headroom, option: str, default: float) -> float:
    """Return ``headroom``, or ``default`` for None; raise unless it is a
    non-negative finite number."""
    if headroom is None:
        return default
    invalid = AquariusError(f"{option} must be a non-negative finite number")
    if isinstance(headroom, bool) or not isinstance(headroom, (int, float)):
        raise invalid
    try:
        finite = math.isfinite(headroom)
    except OverflowError:  # ints beyond the float range
        finite = False
    if not finite or headroom < 0:
        raise invalid
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


def with_instruction_headroom(
    tx: TransactionEnvelope, headroom: float, compute: NetworkCompute
) -> TransactionEnvelope:
    """Raise the declared Soroban instructions by ceil(instructions * headroom),
    capped at the network's per-transaction limit, and raise the resource fee
    and the total fee by the compute fee of the added instructions — the same
    amount the network adds to the non-refundable fee for them.

    Returned as is when nothing can be added or the total fee would not fit in
    uint32. Mutates and returns ``tx``.
    """
    soroban_data = tx.transaction.soroban_data
    if headroom == 0 or soroban_data is None:
        return tx
    simulated = soroban_data.resources.instructions.uint32
    declared = min(simulated + math.ceil(simulated * headroom), compute.tx_max_instructions)
    if declared <= simulated:
        return tx

    def compute_fee(instructions: int) -> int:
        scaled = instructions * compute.fee_rate_per_instructions_increment
        return -(-scaled // _INSTRUCTIONS_INCREMENT)

    extra_fee = compute_fee(declared) - compute_fee(simulated)
    if tx.transaction.fee + extra_fee > _UINT32_MAX:
        return tx
    soroban_data.resources.instructions = Uint32(declared)
    soroban_data.resource_fee = Int64(soroban_data.resource_fee.int64 + extra_fee)
    tx.transaction.fee += extra_fee
    return tx


def _fetch_network_compute(server: SorobanServer) -> NetworkCompute:
    key = LedgerKey(
        type=LedgerEntryType.CONFIG_SETTING,
        config_setting=LedgerKeyConfigSetting(
            config_setting_id=ConfigSettingID.CONFIG_SETTING_CONTRACT_COMPUTE_V0
        ),
    )
    entries = server.get_ledger_entries([key]).entries
    if not entries:
        raise AquariusError("The RPC returned no CONTRACT_COMPUTE_V0 config setting")
    compute = LedgerEntryData.from_xdr(entries[0].xdr).config_setting.contract_compute
    return NetworkCompute(
        tx_max_instructions=compute.tx_max_instructions.int64,
        fee_rate_per_instructions_increment=compute.fee_rate_per_instructions_increment.int64,
    )


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
        resource_fee_headroom: float | None = None,
        instruction_headroom: float | None = None,
    ):
        self.server = server
        self.passphrase = passphrase
        self.base_fee = base_fee
        # Transaction time bound in seconds; None means no upper bound (the
        # right default when a human signs through a wallet, the wrong one for
        # bots, whose stale transactions should expire rather than execute).
        self.timeout = timeout
        # Fraction of the simulated resource fee added on top of it before
        # signing; 0 disables, None means DEFAULT_RESOURCE_FEE_HEADROOM.
        self.resource_fee_headroom = validate_headroom(
            resource_fee_headroom, "resource_fee_headroom", DEFAULT_RESOURCE_FEE_HEADROOM
        )
        # Fraction of the simulated CPU instructions added on top of them
        # before signing; 0 disables, None means DEFAULT_INSTRUCTION_HEADROOM.
        self.instruction_headroom = validate_headroom(
            instruction_headroom, "instruction_headroom", DEFAULT_INSTRUCTION_HEADROOM
        )
        self._simulation_accounts: dict[str, Account] = {}
        self._network_compute_cache: tuple[float, NetworkCompute] | None = None
        # Ledger of this engine's last transaction that made it on-chain
        # (confirmed or failed); the default for wait_for_next_ledger.
        self._last_tx_ledger: int | None = None

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

    def _network_compute(self) -> NetworkCompute:
        now = time.monotonic()
        cached = self._network_compute_cache
        if cached is not None and now - cached[0] < _NETWORK_COMPUTE_TTL_S:
            return cached[1]
        compute = _fetch_network_compute(self.server)
        self._network_compute_cache = (now, compute)
        return compute

    def _simulation_account(self, source: str) -> Account:
        # Simulation ignores sequence numbers, so one fetch per source serves
        # every read. Writes keep loading fresh accounts via build_transaction.
        account = self._simulation_accounts.get(source)
        if account is None:
            account = self.server.load_account(source)
            self._simulation_accounts[source] = account
        return account

    def wait_for_next_ledger(self, ledger: int | None = None, timeout: float = 30.0) -> int:
        """Wait until the RPC's latest ledger is greater than ``ledger`` and
        return the latest ledger observed.

        ``ledger`` defaults to the ledger of this engine's last on-chain
        transaction (confirmed or failed), or, if there is none, to the RPC's
        current latest ledger. Polls ``getHealth`` about once a second and
        raises ``AquariusError`` after ``timeout`` seconds.
        """
        if ledger is not None and (type(ledger) is not int or ledger < 0):
            raise AquariusError("ledger must be a non-negative integer")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
            raise AquariusError("timeout must be a positive finite number")
        try:
            finite = math.isfinite(timeout)
        except OverflowError:  # ints beyond the float range
            finite = False
        if not finite or timeout <= 0:
            raise AquariusError("timeout must be a positive finite number")

        deadline = time.monotonic() + timeout
        latest = self.server.get_health().latest_ledger
        if ledger is None:
            ledger = self._last_tx_ledger if self._last_tx_ledger is not None else latest
        while latest <= ledger:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AquariusError(
                    f"The RPC did not advance past ledger {ledger} within {timeout:g} s"
                )
            time.sleep(min(_NEXT_LEDGER_POLL_INTERVAL_S, remaining))
            latest = self.server.get_health().latest_ledger
        return latest

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
            raise classify_contract_error(
                simulation.error, events_xdr=getattr(simulation, "events", None)
            ) or AquariusError(simulation.error)
        if simulation.restore_preamble is not None:
            raise AquariusError("Ledger entries remain archived after restore")
        if not simulation.results and any(
            isinstance(op, InvokeHostFunction) for op in tx.transaction.operations
        ):
            raise AquariusError("Simulation returned no result")

        return self._assemble(tx, simulation, expected_operations)

    def _assemble(self, tx, simulation, expected_operations) -> TransactionEnvelope:
        """Fill only resources and apply configured headroom to a fixed call."""
        # stellar-sdk fills an empty op.auth from simulation.results[].auth.
        # Strip that input even for an explicitly empty client list: RPC auth
        # must never become part of an envelope prepared for signing.
        resources = deepcopy(simulation)
        for result in resources.results or []:
            result.auth = []
        prepared = self.server.prepare_transaction(tx, resources)
        if self._operation_xdr(prepared) != expected_operations:
            raise AquariusError("Transaction operation or authorization changed during preparation")
        # Instructions first: their compute fee is part of the resource fee that
        # the fee headroom then scales.
        if self.instruction_headroom != 0:
            prepared = with_instruction_headroom(
                prepared, self.instruction_headroom, self._network_compute()
            )
        return with_resource_fee_headroom(prepared, self.resource_fee_headroom)

    @staticmethod
    def _operation_xdr(tx: TransactionEnvelope) -> tuple[str, ...]:
        """Freeze operations, including empty auth and arguments, before RPC."""
        return tuple(op.to_xdr_object().to_xdr() for op in tx.transaction.operations)

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
            raise classify_contract_error(
                simulation.error, events_xdr=getattr(simulation, "events", None)
            ) or AquariusError(simulation.error)
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

        # A failed transaction also applied in its ledger (sequence number,
        # fee), and what usually follows it is a retry that should simulate on
        # the state after it, so its ledger is remembered as well.
        if (
            result.status in (GetTransactionStatus.SUCCESS, GetTransactionStatus.FAILED)
            and result.ledger is not None
        ):
            self._last_tx_ledger = result.ledger

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
