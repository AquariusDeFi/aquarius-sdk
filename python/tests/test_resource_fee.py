"""Resource-fee headroom tests on a fake RPC server — no network."""
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
    scval,
)
from stellar_sdk.soroban_rpc import (
    GetTransactionStatus,
    SendTransactionStatus,
    SimulateTransactionResponse,
)

from aquarius import AquariusClient, AquariusError
from aquarius.submit import SubmitEngine, with_resource_fee_headroom

PASSPHRASE = Network.TESTNET_NETWORK_PASSPHRASE
KEYPAIR = Keypair.random()
CONTRACT = StrKey.encode_contract(bytes([1]) * 32)
BASE_FEE = 100
RESOURCE_FEE = 105_273  # a production swap's declared fee (with 15% headroom), 2026-09-25


def transaction_data(resource_fee: int) -> str:
    return SorobanDataBuilder().set_resource_fee(resource_fee).build().to_xdr()


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

    def __init__(self, simulations):
        self.simulations = list(simulations)
        self.submitted = []

    def load_account(self, account_id: str) -> Account:
        return Account(account_id, 100)

    def simulate_transaction(self, tx):
        return SimulateTransactionResponse.model_validate(self.simulations.pop(0))

    def prepare_transaction(self, tx, simulation):
        return SorobanServer.prepare_transaction(self, tx, simulation)

    def send_transaction(self, envelope):
        self.submitted.append(envelope)
        return SimpleNamespace(status=SendTransactionStatus.PENDING, hash="restored")

    def poll_transaction(self, tx_hash, max_attempts, sleep_strategy):
        return SimpleNamespace(status=GetTransactionStatus.SUCCESS, result_meta_xdr=None)


def invoke(builder):
    return builder.append_invoke_contract_function_op(CONTRACT, "swap", [])


def prepare_with(headroom=None, simulations=(SUCCESS,)):
    server = FakeServer(simulations)
    kwargs = {} if headroom is None else {"resource_fee_headroom": headroom}
    engine = SubmitEngine(server, PASSPHRASE, base_fee=BASE_FEE, **kwargs)
    return engine.prepare(KEYPAIR.public_key, invoke, KEYPAIR), server


def resource_fee_of(tx) -> int:
    return tx.transaction.soroban_data.resource_fee.int64


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
