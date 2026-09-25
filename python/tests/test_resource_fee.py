"""Resource-fee and instruction headroom tests on a fake RPC server — no network."""
import math
from types import SimpleNamespace

import pytest
from stellar_sdk import (
    Account,
    Keypair,
    Network,
    SorobanDataBuilder,
    SorobanServer,
    StrKey,
    TransactionEnvelope,
    scval,
)
from stellar_sdk.soroban_rpc import (
    GetTransactionStatus,
    SendTransactionStatus,
    SimulateTransactionResponse,
)
from stellar_sdk.xdr import (
    ConfigSettingContractComputeV0,
    ConfigSettingEntry,
    ConfigSettingID,
    Int64,
    LedgerEntryData,
    LedgerEntryType,
    Uint32,
)

from aquarius import AquariusClient, AquariusError
from aquarius.submit import SubmitEngine, with_resource_fee_headroom

PASSPHRASE = Network.TESTNET_NETWORK_PASSPHRASE
KEYPAIR = Keypair.random()
CONTRACT = StrKey.encode_contract(bytes([1]) * 32)
BASE_FEE = 100
RESOURCE_FEE = 105_273  # a production swap's declared fee (with 15% headroom), 2026-09-25
# A production swap that failed on-chain with RESOURCE_LIMIT_EXCEEDED, 2026-09-25:
# 5_546_000 instructions declared from simulation, 5_546_342 used.
INSTRUCTIONS = 5_546_000
# Mainnet CONFIG_SETTING_CONTRACT_COMPUTE_V0, 2026-09-25.
TX_MAX_INSTRUCTIONS = 400_000_000
FEE_RATE_PER_INSTRUCTIONS_INCREMENT = 7


def transaction_data(resource_fee: int, instructions: int = 0) -> str:
    return (
        SorobanDataBuilder()
        .set_resource_fee(resource_fee)
        .set_resources(instructions, 0, 0)
        .build()
        .to_xdr()
    )


def compute_fee(instructions: int) -> int:
    """The network's non-refundable fee for declared instructions."""
    return -(-instructions * FEE_RATE_PER_INSTRUCTIONS_INCREMENT // 10_000)


def simulated_with(instructions: int, resource_fee: int = RESOURCE_FEE) -> dict:
    return {**SUCCESS, "transactionData": transaction_data(resource_fee, instructions)}


SUCCESS = {
    "latestLedger": 1,
    "transactionData": transaction_data(RESOURCE_FEE),
    "minResourceFee": RESOURCE_FEE,
    "results": [{"auth": [], "xdr": scval.to_void().to_xdr()}],
}


def restore_needed(restore_fee: int) -> dict:
    return {
        **SUCCESS,
        "restorePreamble": {
            "transactionData": transaction_data(1),  # differs: min_resource_fee must win
            "minResourceFee": restore_fee,
        },
    }


class FakeServer:
    """Scripted simulations; submissions are recorded and confirm at once.
    Assembly is the stellar-sdk's own prepare_transaction."""

    def __init__(self, simulations, tx_max_instructions=TX_MAX_INSTRUCTIONS):
        self.simulations = list(simulations)
        self.submitted = []
        self.tx_max_instructions = tx_max_instructions
        self.config_reads = 0

    def load_account(self, account_id: str) -> Account:
        return Account(account_id, 100)

    def simulate_transaction(self, tx, *, auth_mode=None):
        return SimulateTransactionResponse.model_validate(self.simulations.pop(0))

    def get_ledger_entries(self, keys):
        self.config_reads += 1
        compute = ConfigSettingContractComputeV0(
            ledger_max_instructions=Int64(580_000_000),
            tx_max_instructions=Int64(self.tx_max_instructions),
            fee_rate_per_instructions_increment=Int64(FEE_RATE_PER_INSTRUCTIONS_INCREMENT),
            tx_memory_limit=Uint32(41_943_040),
        )
        entry = LedgerEntryData(
            type=LedgerEntryType.CONFIG_SETTING,
            config_setting=ConfigSettingEntry(
                config_setting_id=ConfigSettingID.CONFIG_SETTING_CONTRACT_COMPUTE_V0,
                contract_compute=compute,
            ),
        )
        return SimpleNamespace(entries=[SimpleNamespace(xdr=entry.to_xdr())], latest_ledger=1)

    def prepare_transaction(self, tx, simulation):
        return SorobanServer.prepare_transaction(self, tx, simulation)

    def send_transaction(self, envelope):
        self.submitted.append(envelope)
        return SimpleNamespace(status=SendTransactionStatus.PENDING, hash="restored")

    def poll_transaction(self, tx_hash, max_attempts, sleep_strategy):
        return SimpleNamespace(
            status=GetTransactionStatus.SUCCESS, result_meta_xdr=None, ledger=None
        )


def invoke(builder):
    return builder.append_invoke_contract_function_op(CONTRACT, "swap", [])


def prepare_with(headroom=None, simulations=(SUCCESS,), server=None, **kwargs):
    server = server or FakeServer(simulations)
    if headroom is not None:
        kwargs["resource_fee_headroom"] = headroom
    engine = SubmitEngine(server, PASSPHRASE, base_fee=BASE_FEE, **kwargs)
    return engine.prepare(KEYPAIR.public_key, invoke, KEYPAIR), server


def resource_fee_of(tx) -> int:
    return tx.transaction.soroban_data.resource_fee.int64


def instructions_of(tx) -> int:
    return tx.transaction.soroban_data.resources.instructions.uint32


def test_default_headroom_raises_resource_and_total_fee_by_half():
    tx, _ = prepare_with()
    extra = math.ceil(RESOURCE_FEE * 0.5)  # 52_637
    assert resource_fee_of(tx) == RESOURCE_FEE + extra
    assert tx.transaction.fee == BASE_FEE + RESOURCE_FEE + extra  # inclusion fee unchanged


def test_custom_headroom_is_applied():
    tx, _ = prepare_with(0.3)
    extra = math.ceil(RESOURCE_FEE * 0.3)  # 31_582
    assert resource_fee_of(tx) == RESOURCE_FEE + extra
    assert tx.transaction.fee == BASE_FEE + RESOURCE_FEE + extra


def test_zero_headroom_keeps_the_simulated_resource_fee():
    tx, _ = prepare_with(0)
    assert resource_fee_of(tx) == RESOURCE_FEE
    assert tx.transaction.fee == BASE_FEE + RESOURCE_FEE


def test_client_passes_resource_fee_headroom_to_the_engine():
    client = AquariusClient(network="testnet", resource_fee_headroom=0.25)
    assert client.engine.resource_fee_headroom == 0.25
    assert AquariusClient(network="testnet").engine.resource_fee_headroom == 0.5
    none = AquariusClient(network="testnet", resource_fee_headroom=None)
    assert none.engine.resource_fee_headroom == 0.5
    assert SubmitEngine(FakeServer([]), PASSPHRASE, base_fee=100).resource_fee_headroom == 0.5


@pytest.mark.parametrize("invalid", [-0.1, math.nan, math.inf, 10**400, "0.5", True])
def test_invalid_headroom_is_rejected(invalid):
    with pytest.raises(AquariusError, match="resource_fee_headroom"):
        SubmitEngine(FakeServer([]), PASSPHRASE, base_fee=100, resource_fee_headroom=invalid)
    with pytest.raises(AquariusError, match="resource_fee_headroom"):
        AquariusClient(network="testnet", resource_fee_headroom=invalid)


def test_restore_transaction_gets_the_same_headroom_on_its_minimum_resource_fee():
    restore_fee = 20_001
    tx, server = prepare_with(simulations=(restore_needed(restore_fee), SUCCESS))

    assert len(server.submitted) == 1
    restore = server.submitted[0]
    assert restore.transaction.operations[0].__class__.__name__ == "RestoreFootprint"
    extra = math.ceil(restore_fee * 0.5)  # 10_001
    assert resource_fee_of(restore) == restore_fee + extra
    assert restore.transaction.fee == BASE_FEE + restore_fee + extra
    KEYPAIR.verify(restore.hash(), restore.signatures[0].signature)  # signed final fee

    assert resource_fee_of(tx) == RESOURCE_FEE + math.ceil(RESOURCE_FEE * 0.5)


def test_signed_envelope_carries_the_raised_fee():
    tx, _ = prepare_with()
    fee, resource_fee = tx.transaction.fee, resource_fee_of(tx)
    server = FakeServer([])
    SubmitEngine(server, PASSPHRASE, base_fee=BASE_FEE).sign_and_submit(tx, KEYPAIR)
    signed = server.submitted[0]
    assert signed.transaction.fee == fee
    assert resource_fee_of(signed) == resource_fee
    KEYPAIR.verify(signed.hash(), signed.signatures[0].signature)


def test_headroom_is_capped_so_the_total_fee_fits_in_uint32():
    bare, _ = prepare_with(0)
    raised = with_resource_fee_headroom(bare, 1e12)
    assert raised.transaction.fee == 4_294_967_295
    assert resource_fee_of(raised) == 4_294_967_295 - BASE_FEE
    raised.to_xdr()  # still encodes


def test_default_instruction_headroom_raises_instructions_by_a_quarter():
    tx, server = prepare_with(0, simulations=(simulated_with(INSTRUCTIONS),))
    declared = INSTRUCTIONS + math.ceil(INSTRUCTIONS * 0.25)  # 6_932_500
    extra_fee = compute_fee(declared) - compute_fee(INSTRUCTIONS)  # 970
    assert instructions_of(tx) == declared
    assert resource_fee_of(tx) == RESOURCE_FEE + extra_fee
    assert tx.transaction.fee == BASE_FEE + RESOURCE_FEE + extra_fee
    assert server.config_reads == 1


def test_custom_instruction_headroom_is_applied_before_the_fee_headroom():
    tx, _ = prepare_with(simulations=(simulated_with(INSTRUCTIONS),), instruction_headroom=0.1)
    declared = INSTRUCTIONS + math.ceil(INSTRUCTIONS * 0.1)
    raised_fee = RESOURCE_FEE + compute_fee(declared) - compute_fee(INSTRUCTIONS)
    assert instructions_of(tx) == declared
    assert resource_fee_of(tx) == raised_fee + math.ceil(raised_fee * 0.5)


def test_zero_instruction_headroom_keeps_the_simulated_instructions():
    tx, server = prepare_with(
        0, simulations=(simulated_with(INSTRUCTIONS),), instruction_headroom=0
    )
    assert instructions_of(tx) == INSTRUCTIONS
    assert resource_fee_of(tx) == RESOURCE_FEE
    assert server.config_reads == 0


def test_client_passes_instruction_headroom_to_the_engine():
    client = AquariusClient(network="testnet", instruction_headroom=0.5)
    assert client.engine.instruction_headroom == 0.5
    assert AquariusClient(network="testnet").engine.instruction_headroom == 0.25
    assert SubmitEngine(FakeServer([]), PASSPHRASE, base_fee=100).instruction_headroom == 0.25


@pytest.mark.parametrize("invalid", [-0.1, math.nan, math.inf, 10**400, "0.25", True])
def test_invalid_instruction_headroom_is_rejected(invalid):
    with pytest.raises(AquariusError, match="instruction_headroom"):
        SubmitEngine(FakeServer([]), PASSPHRASE, base_fee=100, instruction_headroom=invalid)
    with pytest.raises(AquariusError, match="instruction_headroom"):
        AquariusClient(network="testnet", instruction_headroom=invalid)


def test_instruction_headroom_is_capped_at_the_network_limit():
    simulated = 350_000_000
    tx, _ = prepare_with(0, simulations=(simulated_with(simulated),))
    assert instructions_of(tx) == TX_MAX_INSTRUCTIONS
    assert resource_fee_of(tx) == (
        RESOURCE_FEE + compute_fee(TX_MAX_INSTRUCTIONS) - compute_fee(simulated)
    )


def test_raised_resource_fee_covers_the_network_fee_for_the_raised_instructions():
    # The simulated fee is the non-refundable part (compute plus everything
    # else) plus the refundable part; only compute depends on instructions.
    other_non_refundable, refundable = 40_000, 60_000
    for simulated in (1, 9_999, INSTRUCTIONS, 123_456_789):
        simulated_fee = other_non_refundable + compute_fee(simulated) + refundable
        tx, _ = prepare_with(0, simulations=(simulated_with(simulated, simulated_fee),))
        network_fee = other_non_refundable + compute_fee(instructions_of(tx)) + refundable
        assert instructions_of(tx) > simulated
        assert resource_fee_of(tx) >= network_fee


def test_network_compute_is_read_once_per_engine():
    server = FakeServer([simulated_with(INSTRUCTIONS)] * 2)
    engine = SubmitEngine(server, PASSPHRASE, base_fee=BASE_FEE)
    engine.prepare(KEYPAIR.public_key, invoke, KEYPAIR)
    engine.prepare(KEYPAIR.public_key, invoke, KEYPAIR)
    assert server.config_reads == 1


def test_signed_envelopes_and_unsigned_xdr_carry_the_raised_instructions():
    tx, _ = prepare_with(simulations=(simulated_with(INSTRUCTIONS),))
    declared = instructions_of(tx)
    assert declared == INSTRUCTIONS + math.ceil(INSTRUCTIONS * 0.25)
    unsigned = TransactionEnvelope.from_xdr(tx.to_xdr(), PASSPHRASE)
    assert instructions_of(unsigned) == declared

    class Wallet:
        public_key = KEYPAIR.public_key

        def sign(self, tx_xdr):
            self.seen = TransactionEnvelope.from_xdr(tx_xdr, PASSPHRASE)
            self.seen.sign(KEYPAIR)
            return self.seen.to_xdr()

    wallet = Wallet()
    for signer in (KEYPAIR, wallet):
        server = FakeServer([])
        SubmitEngine(server, PASSPHRASE, base_fee=BASE_FEE).sign_and_submit(
            TransactionEnvelope.from_xdr(tx.to_xdr(), PASSPHRASE), signer
        )
        signed = server.submitted[0]
        assert instructions_of(signed) == declared
        assert resource_fee_of(signed) == resource_fee_of(tx)
        KEYPAIR.verify(signed.hash(), signed.signatures[0].signature)
    assert instructions_of(wallet.seen) == declared
