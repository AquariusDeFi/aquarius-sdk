"""SubmitEngine sequence-recovery tests on a fake RPC server — no network."""
from types import SimpleNamespace

import pytest
from stellar_sdk import Account, Keypair, Network, SorobanDataBuilder, SorobanServer, scval, xdr
from stellar_sdk.soroban_rpc import AuthMode, GetTransactionStatus, SendTransactionStatus
from stellar_sdk.xdr import (
    Int64,
    TransactionResult,
    TransactionResultCode,
    TransactionResultExt,
    TransactionResultResult,
)

from aquarius import AquariusClient, AquariusError, SlippageError, XLM
from aquarius.authorization import authorized_invocation, source_account_entry
from aquarius.submit import SubmitEngine

PASSPHRASE = Network.TESTNET_NETWORK_PASSPHRASE
KEYPAIR = Keypair.random()
STALE_SEQUENCE = 100  # what the lagging replica serves on the first load
CHAIN_SEQUENCE = 105  # where the chain actually is
CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"


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
        status=GetTransactionStatus.FAILED, diagnostic_events_xdr=events,
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


class PreparingServer(FakeServer):
    """Use stellar-sdk's real assembly, including its empty-auth fallback.

    It serves no network config, so engines on it disable instruction headroom.
    """

    def __init__(self, *, restore=False, error=None):
        super().__init__([BAD_SEQ, PENDING])
        self.restore = restore
        self.error = error
        self.simulations = []
        self.operations = []
        self.assembled = []
        self.rpc_auth = source_account_entry(authorized_invocation(
            CONTRACT, "unexpected_transfer", [scval.to_int128(999)]
        )).to_xdr()

    def simulate_transaction(self, tx, *, auth_mode=None):
        self.simulations.append((auth_mode, [e.to_xdr() for e in tx.transaction.operations[0].auth]))
        self.operations.append(tx.transaction.operations[0].to_xdr_object().to_xdr())
        return SimpleNamespace(
            restore_preamble=object() if self.restore and len(self.simulations) == 1 else None,
            error=self.error,
            min_resource_fee=17,
            transaction_data=SorobanDataBuilder().build().to_xdr(),
            results=[SimpleNamespace(auth=[self.rpc_auth], xdr=scval.to_uint32(7).to_xdr())],
        )

    def prepare_transaction(self, tx, simulation):
        self.assembled.append(simulation)
        return SorobanServer.prepare_transaction(self, tx, simulation)


def contract_append(auth):
    return lambda b: b.append_invoke_contract_function_op(
        CONTRACT, "fixed", [scval.to_uint32(5)], auth=auth
    )


@pytest.mark.parametrize("empty", [False, True])
def test_prepare_enforces_and_preserves_auth_despite_rpc_auth(empty):
    server = PreparingServer()
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100, instruction_headroom=0)
    auth = [] if empty else [source_account_entry(authorized_invocation(
        CONTRACT, "fixed", [scval.to_uint32(5)]
    ))]
    expected = [entry.to_xdr() for entry in auth]

    tx = engine.prepare(KEYPAIR.public_key, contract_append(auth))

    assert server.simulations == [(AuthMode.ENFORCE, expected)]
    assert [entry.to_xdr() for entry in tx.transaction.operations[0].auth] == expected
    assert tx.transaction.fee == 117  # resource assembly still runs


def test_prepare_restores_then_enforces_the_same_auth(monkeypatch):
    server = PreparingServer(restore=True)
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100, instruction_headroom=0)
    auth = [source_account_entry(authorized_invocation(CONTRACT, "fixed", [scval.to_uint32(5)]))]
    expected = [entry.to_xdr() for entry in auth]
    restores = []
    monkeypatch.setattr(engine, "_restore", lambda *args: restores.append(args))

    tx = engine.prepare(KEYPAIR.public_key, contract_append(auth), signer=object())

    assert len(restores) == 1
    assert server.simulations == [(AuthMode.ENFORCE, expected)] * 2
    assert [entry.to_xdr() for entry in tx.transaction.operations[0].auth] == expected


def test_restore_reuses_the_original_operation_without_rebuilding_auth(monkeypatch):
    server = PreparingServer(restore=True)
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100, instruction_headroom=0)
    builds = []

    def append(builder):
        builds.append(True)
        return builder.append_invoke_contract_function_op(
            CONTRACT, "fixed", [scval.to_uint32(len(builds))], auth=[]
        )

    monkeypatch.setattr(engine, "_restore", lambda *args: None)
    tx = engine.prepare(KEYPAIR.public_key, append, signer=object())

    assert len(builds) == 1
    assert server.operations[0] == server.operations[1]
    assert tx.transaction.operations[0].to_xdr_object().to_xdr() == server.operations[0]


def test_second_restore_preamble_stops_before_assembly(monkeypatch):
    server = PreparingServer()
    simulate = server.simulate_transaction

    def archived(tx, *, auth_mode):
        result = simulate(tx, auth_mode=auth_mode)
        result.restore_preamble = object()
        return result

    server.simulate_transaction = archived
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100, instruction_headroom=0)
    monkeypatch.setattr(engine, "_restore", lambda *args: None)
    with pytest.raises(AquariusError, match="archived"):
        engine.prepare(KEYPAIR.public_key, contract_append([]), signer=object())
    assert server.assembled == []


def test_prepare_with_no_result_stops_before_assembly():
    server = PreparingServer()
    simulate = server.simulate_transaction

    def no_result(tx, *, auth_mode):
        result = simulate(tx, auth_mode=auth_mode)
        result.results = []
        return result

    server.simulate_transaction = no_result
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100, instruction_headroom=0)
    with pytest.raises(AquariusError, match="no result"):
        engine.prepare(KEYPAIR.public_key, contract_append([]))
    assert server.assembled == []


def test_prepare_fails_closed_if_assembly_changes_auth():
    server = PreparingServer()
    original_prepare = server.prepare_transaction

    def changed_auth(tx, simulation):
        assembled = original_prepare(tx, simulation)
        assembled.transaction.operations[0].auth = [source_account_entry(
            authorized_invocation(CONTRACT, "unexpected_transfer", [])
        )]
        return assembled

    server.prepare_transaction = changed_auth
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100, instruction_headroom=0)
    with pytest.raises(AquariusError, match="authorization"):
        engine.prepare(KEYPAIR.public_key, contract_append([]))


def test_enforcement_error_stops_before_assembly():
    server = PreparingServer(error="Error(Auth, InvalidAction)")
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100, instruction_headroom=0)
    with pytest.raises(AquariusError, match="Auth"):
        engine.prepare(KEYPAIR.public_key, contract_append([]))
    assert server.assembled == []


def test_sequence_retry_keeps_prepared_auth(monkeypatch):
    server = PreparingServer()
    engine = SubmitEngine(server, PASSPHRASE, base_fee=100, instruction_headroom=0)
    auth = [source_account_entry(authorized_invocation(CONTRACT, "fixed", [scval.to_uint32(5)]))]
    expected = [entry.to_xdr() for entry in auth]
    tx = engine.prepare(KEYPAIR.public_key, contract_append(auth))
    # No real signing: exercise only the sequence-refresh and resubmit wiring.
    monkeypatch.setattr("aquarius.submit.sign_transaction", lambda signer, tx, passphrase: tx)

    engine.sign_and_submit(tx, object())

    assert len(server.submitted) == 2
    assert all([e.to_xdr() for e in tx.transaction.operations[0].auth] == expected
               for tx in server.submitted)
    assert len(server.simulations) == 1
