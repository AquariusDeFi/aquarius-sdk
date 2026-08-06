"""SubmitEngine sequence-recovery tests on a fake RPC server — no network."""
from types import SimpleNamespace

import pytest
from stellar_sdk import Account, Keypair, Network
from stellar_sdk.soroban_rpc import GetTransactionStatus, SendTransactionStatus
from stellar_sdk.xdr import (
    Int64,
    TransactionResult,
    TransactionResultCode,
    TransactionResultExt,
    TransactionResultResult,
)

from aquarius import AquariusError
from aquarius.submit import SubmitEngine

PASSPHRASE = Network.TESTNET_NETWORK_PASSPHRASE
KEYPAIR = Keypair.random()
STALE_SEQUENCE = 100  # what the lagging replica serves on the first load
CHAIN_SEQUENCE = 105  # where the chain actually is


def rejection_xdr(code: TransactionResultCode) -> str:
    return TransactionResult(
        fee_charged=Int64(0),
        result=TransactionResultResult(code=code, inner_result_pair=None, results=None),
        ext=TransactionResultExt(0),
    ).to_xdr()


def rejected(code: TransactionResultCode) -> SimpleNamespace:
    return SimpleNamespace(
        status=SendTransactionStatus.ERROR, error_result_xdr=rejection_xdr(code), hash="rejected"
    )


PENDING = SimpleNamespace(status=SendTransactionStatus.PENDING, hash="abc123")
BAD_SEQ = rejected(TransactionResultCode.txBAD_SEQ)


class FakeServer:
    """Scripted send_transaction responses; the first account load serves a
    stale sequence (lagging replica), later loads the converged one."""

    def __init__(self, send_responses):
        self.send_responses = list(send_responses)
        self.loads = 0
        self.submitted = []

    def load_account(self, account_id: str) -> Account:
        self.loads += 1
        return Account(account_id, STALE_SEQUENCE if self.loads == 1 else CHAIN_SEQUENCE)

    def send_transaction(self, envelope):
        self.submitted.append(envelope)
        return self.send_responses.pop(0)

    def poll_transaction(self, tx_hash, max_attempts, sleep_strategy):
        return SimpleNamespace(status=GetTransactionStatus.SUCCESS, result_meta_xdr=None)


@pytest.fixture(autouse=True)
def no_delays(monkeypatch):
    monkeypatch.setattr(SubmitEngine, "_bad_seq_delays_s", (0, 0))


def submit_through(server: FakeServer):
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100)
    tx = engine.build_transaction(
        KEYPAIR.public_key, lambda b: b.append_manage_data_op("test", "1")
    )
    assert tx.transaction.sequence == STALE_SEQUENCE + 1
    return engine.sign_and_submit(tx, KEYPAIR)


def test_bad_seq_is_resigned_with_fresh_sequence_and_resubmitted():
    server = FakeServer([BAD_SEQ, PENDING])
    confirmed = submit_through(server)

    assert confirmed.tx_hash == "abc123"
    assert len(server.submitted) == 2
    resubmitted = server.submitted[1]
    assert resubmitted.transaction.sequence == CHAIN_SEQUENCE + 1  # reloaded, not stale
    assert len(resubmitted.signatures) == 1  # stale signature dropped, re-signed
    KEYPAIR.verify(resubmitted.hash(), resubmitted.signatures[0].signature)


def test_bad_seq_gives_up_after_bounded_retries():
    server = FakeServer([BAD_SEQ, BAD_SEQ, BAD_SEQ])
    with pytest.raises(AquariusError, match="txBAD_SEQ"):
        submit_through(server)
    assert len(server.submitted) == 3  # initial + one per configured delay


def test_other_rejections_are_not_retried():
    server = FakeServer([rejected(TransactionResultCode.txINSUFFICIENT_BALANCE)])
    with pytest.raises(AquariusError, match="txINSUFFICIENT_BALANCE"):
        submit_through(server)
    assert len(server.submitted) == 1


def test_read_with_no_result_raises_typed_error():
    server = FakeServer([])
    server.simulate_transaction = lambda tx: SimpleNamespace(
        restore_preamble=None, error=None, results=[]
    )
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100)
    with pytest.raises(AquariusError, match="no result"):
        engine.read(KEYPAIR.public_key, lambda b: b.append_manage_data_op("test", "1"))
