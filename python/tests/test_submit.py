"""SubmitEngine sequence-recovery tests on a fake RPC server — no network."""
from types import SimpleNamespace

import pytest
from stellar_sdk import Account, Keypair, Network, scval, xdr
from stellar_sdk.soroban_rpc import GetTransactionStatus, SendTransactionStatus
from stellar_sdk.xdr import (
    Int64,
    TransactionResult,
    TransactionResultCode,
    TransactionResultExt,
    TransactionResultResult,
)

from aquarius import AquariusClient, AquariusError, SlippageError, XLM
from aquarius import submit
from aquarius.submit import SubmitEngine

PASSPHRASE = Network.TESTNET_NETWORK_PASSPHRASE
KEYPAIR = Keypair.random()
STALE_SEQUENCE = 100  # what the lagging replica serves on the first load
CHAIN_SEQUENCE = 105  # where the chain actually is
CONFIRMED_LEDGER = 1000  # the ledger that applies every submitted transaction


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

    def __init__(self, send_responses, latest_ledgers=()):
        self.send_responses = list(send_responses)
        self.loads = 0
        self.submitted = []
        self.latest_ledgers = list(latest_ledgers)  # the last one repeats
        self.calls = []

    def load_account(self, account_id: str) -> Account:
        self.loads += 1
        return Account(account_id, STALE_SEQUENCE if self.loads == 1 else CHAIN_SEQUENCE)

    def send_transaction(self, envelope):
        self.submitted.append(envelope)
        return self.send_responses.pop(0)

    def poll_transaction(self, tx_hash, max_attempts, sleep_strategy):
        return SimpleNamespace(
            status=GetTransactionStatus.SUCCESS, result_meta_xdr=None, ledger=CONFIRMED_LEDGER
        )

    def get_health(self):
        self.calls.append("get_health")
        latest = self.latest_ledgers[0]
        if len(self.latest_ledgers) > 1:
            self.latest_ledgers.pop(0)
        return SimpleNamespace(latest_ledger=latest)

    def simulate_transaction(self, tx):
        self.calls.append("simulate")
        return SimpleNamespace(restore_preamble=None, error=None, results=[
            SimpleNamespace(xdr=scval.to_uint32(7).to_xdr())
        ])

    def prepare_transaction(self, tx, simulation):
        return tx


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


def diagnostic_event(contract_code=None):
    topics = [scval.to_symbol("error")]
    if contract_code is not None:
        topics.append(xdr.SCVal(
            xdr.SCValType.SCV_ERROR,
            error=xdr.SCError(xdr.SCErrorType.SCE_CONTRACT, contract_code=xdr.Uint32(contract_code)),
        ))
    return xdr.DiagnosticEvent(False, xdr.ContractEvent(
        ext=xdr.ExtensionPoint(0), contract_id=None,
        type=xdr.ContractEventType.DIAGNOSTIC,
        body=xdr.ContractEventBody(0, xdr.ContractEventV0(topics, scval.to_void())),
    )).to_xdr()


@pytest.mark.parametrize("events, error_type, attempts", [
    (None, AquariusError, 1),
    ([], AquariusError, 1),
    ([diagnostic_event()], AquariusError, 1),
    ([diagnostic_event(2006)], SlippageError, 3),
])
def test_swap_retries_failed_transactions_only_for_diagnosed_slippage(
    monkeypatch, events, error_type, attempts
):
    client = AquariusClient(network="testnet")
    monkeypatch.setattr(AquariusClient, "_requote_delays_s", (0, 0))
    server = FakeServer([])
    server.poll_transaction = lambda *a, **k: SimpleNamespace(
        status=GetTransactionStatus.FAILED, diagnostic_events_xdr=events, ledger=None,
    )
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100)
    quotes = []

    def quote(*args, **kwargs):
        quotes.append(1)
        return SimpleNamespace(execute=lambda: engine._poll("failed-hash"))

    monkeypatch.setattr(client, "quote", quote)
    with pytest.raises(error_type) as caught:
        client.swap(XLM, XLM, amount_in=1, retries=2)
    assert type(caught.value) is error_type
    assert caught.value.tx_hash == "failed-hash"
    assert len(quotes) == attempts
    if error_type is AquariusError:
        assert "without recognized diagnostics" in str(caught.value)


def test_read_with_no_result_raises_typed_error():
    server = FakeServer([])
    server.simulate_transaction = lambda tx: SimpleNamespace(
        restore_preamble=None, error=None, results=[]
    )
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100)
    with pytest.raises(AquariusError, match="no result"):
        engine.read(KEYPAIR.public_key, lambda b: b.append_manage_data_op("test", "1"))


def test_reads_share_one_account_fetch():
    server = FakeServer([])
    server.simulate_transaction = lambda tx: SimpleNamespace(
        restore_preamble=None, error=None,
        results=[SimpleNamespace(xdr=scval.to_uint32(7).to_xdr())],
    )
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100)
    for _ in range(3):
        value = engine.read(KEYPAIR.public_key, lambda b: b.append_manage_data_op("t", "1"))
    assert scval.from_uint32(value) == 7
    assert server.loads == 1  # sequence numbers are irrelevant to simulation


def test_write_builds_always_load_a_fresh_account():
    server = FakeServer([])
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100)
    engine.build_transaction(KEYPAIR.public_key, lambda b: b.append_manage_data_op("t", "1"))
    engine.build_transaction(KEYPAIR.public_key, lambda b: b.append_manage_data_op("t", "1"))
    assert server.loads == 2  # writes must never reuse a cached sequence


class FakeClock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


@pytest.fixture
def clock(monkeypatch):
    fake = FakeClock()
    monkeypatch.setattr(submit, "time", fake)
    return fake


def manage_data(builder):
    return builder.append_manage_data_op("t", "1")


def write(engine):
    tx = engine.prepare(KEYPAIR.public_key, manage_data, KEYPAIR)
    return engine.sign_and_submit(tx, KEYPAIR)


def test_simulation_after_a_transaction_waits_for_the_next_ledger(clock):
    server = FakeServer(
        [PENDING, PENDING], latest_ledgers=[CONFIRMED_LEDGER, CONFIRMED_LEDGER, CONFIRMED_LEDGER + 1]
    )
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100, instruction_headroom=0)
    write(engine)
    assert server.calls == ["simulate"]  # nothing remembered yet: no ledger poll

    write(engine)
    assert server.calls == ["simulate", "get_health", "get_health", "get_health", "simulate"]
    assert clock.sleeps == [1.0, 1.0]

    server.calls.clear()  # the second write confirmed in CONFIRMED_LEDGER too
    engine.read(KEYPAIR.public_key, manage_data)
    engine.read(KEYPAIR.public_key, manage_data)
    assert server.calls == ["get_health", "simulate", "simulate"]  # cleared once passed


def test_no_next_ledger_within_the_timeout_raises_before_simulating(clock):
    server = FakeServer([PENDING, PENDING], latest_ledgers=[CONFIRMED_LEDGER])
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100, instruction_headroom=0)
    write(engine)
    with pytest.raises(AquariusError, match=f"did not advance past ledger {CONFIRMED_LEDGER}"):
        write(engine)
    assert server.calls[1:] == ["get_health"] * 31  # at 0 s, 1 s, ..., 30 s
    assert len(server.submitted) == 1
