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
from aquarius.errors import classify_contract_error, is_user_rejection

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
