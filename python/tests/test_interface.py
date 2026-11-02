"""No-network tests mirroring the JavaScript suite, on the shared golden fixtures."""
import json
import pathlib

import pytest

import aquarius
from aquarius import (
    XLM,
    AquariusClient,
    AquariusError,
    Asset,
    NoRouteError,
    PausedError,
    SlippageError,
    parse_find_path_response,
)
from aquarius import NoTrustlineError, StaleSimulationError
from aquarius.errors import classify_contract_error, error_from_diagnostics, is_user_rejection

TESTDATA = pathlib.Path(__file__).resolve().parents[2] / "testdata"
TESTNET_PASSPHRASE = "Test SDF Network ; September 2015"
AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER")

FIXTURE = json.loads((TESTDATA / "find_path_testnet_xlm_aqua.json").read_text())


def test_public_surface():
    for name in aquarius.__all__:
        assert getattr(aquarius, name)


def test_asset_forms_resolve_to_known_contract_ids():
    assert XLM.contract_id(TESTNET_PASSPHRASE) == "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
    assert AQUA.contract_id(TESTNET_PASSPHRASE) == "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE"
    assert Asset.contract("CABC").contract_id(TESTNET_PASSPHRASE) == "CABC"


def test_to_classic_covers_native_and_issued_but_rejects_contract_only():
    assert XLM.to_classic().is_native()
    assert AQUA.to_classic().code == "AQUA"
    with pytest.raises(AquariusError, match="contract ID"):
        Asset.contract("CABC").to_classic()


def test_golden_fixture_parses_into_exact_input_quote():
    parsed = parse_find_path_response(
        FIXTURE, amount_in=100_000_000, slippage_bps=100, pair_label="XLM -> AQUA"
    )
    assert parsed.amount_in == 100_000_000
    assert parsed.amount_out == int(FIXTURE["amount"])
    assert parsed.guard == int(FIXTURE["amount"]) * 9_900 // 10_000
    assert parsed.route == FIXTURE["pools"]
    assert parsed.swap_chain_xdr == FIXTURE["swap_chain_xdr"]


def test_exact_output_guard_rounds_up():
    parsed = parse_find_path_response(
        {**FIXTURE, "amount": "999"}, amount_out=5_000, slippage_bps=100, pair_label="XLM -> AQUA"
    )
    assert parsed.amount_in == 999
    assert parsed.amount_out == 5_000
    assert parsed.guard == 1_009  # ceil(999 * 1.01)


def test_no_route_raises_typed_error():
    with pytest.raises(NoRouteError):
        parse_find_path_response(
            {"success": False}, amount_in=1, slippage_bps=100, pair_label="XLM -> AQUA"
        )


def test_quote_requires_exactly_one_amount():
    client = AquariusClient(network="testnet")
    with pytest.raises(AquariusError):
        client.quote(XLM, AQUA)
    with pytest.raises(AquariusError):
        client.quote(XLM, AQUA, amount_in=1, amount_out=1)


def test_contract_errors_classify_into_typed_errors():
    assert isinstance(classify_contract_error("HostError: Error(Contract, #2006)"), SlippageError)
    assert isinstance(classify_contract_error("HostError: Error(Contract, #2020)"), SlippageError)
    assert isinstance(classify_contract_error("HostError: Error(Contract, #206)"), PausedError)
    assert isinstance(classify_contract_error("Error(Budget, ExceededLimit)"), AquariusError)
    assert classify_contract_error("something unrelated") is None
    assert str(classify_contract_error("Error(Contract, #301)")) == "Contract error #301"


def test_wallet_rejections_are_recognized():
    assert is_user_rejection(Exception("The user rejected this request."))
    assert is_user_rejection(Exception("cancelled_by_user"))
    assert not is_user_rejection(Exception("tx_bad_seq"))


DIAG_FIXTURE = json.loads((TESTDATA / "diagnostic_events_missing_trustline.json").read_text())


def test_diagnostics_detect_missing_trustline():
    error = error_from_diagnostics(DIAG_FIXTURE["events_xdr"])
    assert isinstance(error, NoTrustlineError)
    assert "output recipient" in str(error)
    assert "ensure_trustline" not in str(error)


def test_diagnostics_fall_back_to_contract_code():
    import base64

    without_trustline_events = [
        e for e in DIAG_FIXTURE["events_xdr"]
        if b"trustline entry is missing" not in base64.b64decode(e)
    ]
    error = error_from_diagnostics(without_trustline_events)
    assert error is not None
    assert "#13" in str(error)


def test_trustline_marker_wins_over_contract_code():
    message = "HostError: Error(Contract, #2006)\n... trustline entry is missing for account ..."
    assert isinstance(classify_contract_error(message), NoTrustlineError)


def test_timeout_resolution():
    from stellar_sdk import Keypair

    keypair_client = AquariusClient(network="testnet", signer=Keypair.random())
    assert keypair_client.engine.timeout == 300
    read_only = AquariusClient(network="testnet")
    assert read_only.engine.timeout is None
    explicit = AquariusClient(network="testnet", timeout=120)
    assert explicit.engine.timeout == 120
    infinite = AquariusClient(network="testnet", signer=Keypair.random(), timeout="infinite")
    assert infinite.engine.timeout is None


def test_contract_call_decodes_the_result(monkeypatch):
    from stellar_sdk import Keypair, scval

    from aquarius.submit import ConfirmedTx

    client = AquariusClient(network="testnet", signer=Keypair.random())
    monkeypatch.setattr(client.engine, "prepare", lambda *a, **k: "prepared")
    monkeypatch.setattr(
        client.engine,
        "sign_and_submit",
        lambda tx, signer: ConfirmedTx(tx_hash="h", return_value=scval.to_uint128(123)),
    )
    assert client.contract_call("some_fn") == 123  # native int, not a raw SCVal


@pytest.mark.parametrize("auth_kind", ["default", "nested", "empty"])
def test_raw_contract_call_passes_only_client_auth(monkeypatch, auth_kind):
    from stellar_sdk import Account, Keypair, TransactionBuilder, scval
    from aquarius.authorization import authorized_invocation, source_account_entry
    from aquarius.submit import ConfirmedTx

    client = AquariusClient(network="testnet", signer=Keypair.random())
    args = [scval.to_uint32(5)]
    root = authorized_invocation(client.network.router, "some_fn", args)
    explicit = None
    if auth_kind == "nested":
        root.sub_invocations = [authorized_invocation(client.network.router, "nested", [])]
        explicit = [source_account_entry(root)]
    elif auth_kind == "empty":
        explicit = []
    prepared = []

    def prepare(source, append, signer):
        builder = TransactionBuilder(Account(source, 1), client.network.passphrase, 100)
        prepared.extend(append(builder).operations)
        return "prepared"

    monkeypatch.setattr(client.engine, "prepare", prepare)
    monkeypatch.setattr(client.engine, "sign_and_submit", lambda *args: ConfirmedTx("h", None))
    if auth_kind == "default":
        client.contract_call("some_fn", *args)
    else:
        client.contract_call("some_fn", *args, auth=explicit)

    expected = [source_account_entry(root)] if explicit is None else explicit
    assert [entry.to_xdr() for entry in prepared[0].auth] == [e.to_xdr() for e in expected]


def test_internal_submit_requires_an_explicit_auth_list():
    client = AquariusClient(network="testnet")
    with pytest.raises(TypeError, match="auth"):
        client._submit_contract(client.network.router, "some_fn", [])
    with pytest.raises(AquariusError, match="authorization"):
        client._submit_contract(client.network.router, "some_fn", [], auth=None)


def test_swap_retries_requote_on_slippage(monkeypatch):
    monkeypatch.setattr(AquariusClient, "_requote_delays_s", (0, 0))
    client = AquariusClient(network="testnet")
    attempts = []

    class FakeQuote:
        def __init__(self, n):
            self.n = n

        def execute(self):
            if self.n < 3:
                raise SlippageError("moved")
            return "receipt"

    client.quote = lambda *a, **k: (attempts.append(1), FakeQuote(len(attempts)))[1]
    assert client.swap(XLM, AQUA, retries=2, amount_in=1) == "receipt"
    assert len(attempts) == 3
    attempts.clear()
    with pytest.raises(SlippageError):
        client.swap(XLM, AQUA, retries=1, amount_in=1)
    assert len(attempts) == 2


def test_swap_backs_off_between_requote_attempts(monkeypatch):
    client = AquariusClient(network="testnet")
    quotes = []

    class AlwaysBreached:
        def execute(self):
            raise SlippageError("guard breached")

    monkeypatch.setattr(
        client, "quote", lambda *args, **kwargs: quotes.append(1) or AlwaysBreached()
    )
    sleeps = []
    monkeypatch.setattr("aquarius.client.time.sleep", lambda seconds: sleeps.append(seconds))

    with pytest.raises(SlippageError):
        client.swap(XLM, AQUA, amount_in=1, retries=3)

    assert len(quotes) == 4  # initial attempt + 3 retries, each freshly quoted
    # First retry is immediate (0 -> no sleep call), later ones escalate;
    # nothing sleeps after the final attempt.
    assert sleeps == [
        AquariusClient._requote_delays_s[1],
        AquariusClient._requote_delays_s[2],
    ]


FOOTPRINT_FIXTURE = json.loads(
    (TESTDATA / "diagnostic_events_footprint_withdraw.json").read_text()
)


def test_handled_probe_errors_do_not_drive_the_diagnosis():
    """The footprint fixture contains a handled trustline probe before the
    fatal storage error - the diagnosis must report the storage failure."""
    error = error_from_diagnostics(FOOTPRINT_FIXTURE["events_xdr"])
    assert isinstance(error, StaleSimulationError)


def test_swap_operation_carries_bounded_client_built_authorization():
    from stellar_sdk import Account, Keypair, TransactionBuilder, scval
    from stellar_sdk.xdr import SorobanCredentialsType

    from aquarius.client import Quote

    signer = Keypair.random()
    client = AquariusClient(network="testnet", signer=signer)
    token_in = XLM.contract_id(TESTNET_PASSPHRASE)

    def build_op(exact_input):
        parsed = parse_find_path_response(
            FIXTURE,
            amount_in=100_000_000 if exact_input else None,
            amount_out=None if exact_input else 100_000_000,
            slippage_bps=100,
            pair_label="XLM -> AQUA",
        )
        quote = Quote(
            amount_in=parsed.amount_in,
            amount_out=parsed.amount_out,
            guard=parsed.guard,
            route=parsed.route,
            is_exact_input=exact_input,
            _client=client,
            _parsed=parsed,
            _params=dict(from_=XLM, to=AQUA, amount_in=None, amount_out=None, slippage=0.01),
        )
        builder = TransactionBuilder(
            Account(signer.public_key, 1), network_passphrase=TESTNET_PASSPHRASE, base_fee=100
        )
        return client._swap_append(quote)(builder).operations[0], quote

    from stellar_sdk import Address

    op, quote = build_op(exact_input=True)
    [entry] = op.auth  # auth is client-built, not left for simulation to fill
    assert entry.credentials.type == SorobanCredentialsType.SOROBAN_CREDENTIALS_SOURCE_ACCOUNT
    root = entry.root_invocation
    assert root.function.contract_fn.function_name.sc_symbol == b"swap_chained"
    assert (
        Address.from_xdr_sc_address(root.function.contract_fn.contract_address).address
        == client.network.router
    )
    [transfer] = root.sub_invocations
    t = transfer.function.contract_fn
    assert t.function_name.sc_symbol == b"transfer"
    assert Address.from_xdr_sc_address(t.contract_address).address == token_in
    assert scval.from_int128(t.args[2]) == quote.amount_in  # bounded: exactly what is spent

    op, quote = build_op(exact_input=False)
    [entry] = op.auth
    root = entry.root_invocation
    assert root.function.contract_fn.function_name.sc_symbol == b"swap_chained_strict_receive"
    [transfer] = root.sub_invocations
    # max-in: the contract pulls at most the guard and refunds the difference
    assert scval.from_int128(transfer.function.contract_fn.args[2]) == quote.guard
