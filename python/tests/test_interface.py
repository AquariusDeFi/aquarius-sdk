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
from aquarius import NoTrustlineError
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


def test_swap_retries_requote_on_slippage(monkeypatch):
    monkeypatch.setattr(AquariusClient, "_requote_backoff_s", 0)
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
        client.swap(XLM, AQUA, amount_in=1, retries=2)

    assert len(quotes) == 3  # initial attempt + 2 retries, each freshly quoted
    assert sleeps == [AquariusClient._requote_backoff_s] * 2  # none after the last
