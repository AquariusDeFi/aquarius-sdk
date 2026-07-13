"""No-network tests: public surface, argument validation, golden-fixture parsing."""
import json
import pathlib

import pytest

import aquarius
from aquarius import XLM, AquariusClient, Asset, NoRouteError

TESTDATA = pathlib.Path(__file__).resolve().parents[2] / "testdata"

TESTNET_AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER")


def test_public_surface():
    for name in aquarius.__all__:
        assert getattr(aquarius, name)


def test_asset_forms_resolve_to_contract_ids():
    passphrase = "Test SDF Network ; September 2015"
    assert XLM.contract_id(passphrase) == "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
    assert TESTNET_AQUA.contract_id(passphrase) == "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE"
    assert Asset.contract("CABC").contract_id(passphrase) == "CABC"


def test_quote_requires_exactly_one_amount():
    aqua = AquariusClient(network="testnet")
    with pytest.raises(ValueError):
        aqua.quote(XLM, TESTNET_AQUA)
    with pytest.raises(ValueError):
        aqua.quote(XLM, TESTNET_AQUA, amount_in=1, amount_out=1)


def test_parse_find_path_golden_fixture():
    aqua = AquariusClient(network="testnet")
    response = json.loads((TESTDATA / "find_path_testnet_xlm_aqua.json").read_text())
    quote = aqua._parse_find_path(response, XLM, TESTNET_AQUA,
                                  amount_in=100_000_000, amount_out=None, slippage=0.01)
    assert quote.is_exact_input
    assert quote.amount_out == int(response["amount"])
    assert quote.guard == int(quote.amount_out * 0.99)
    assert quote.route == response["pools"]


def test_no_route_raises_typed_error():
    aqua = AquariusClient(network="testnet")
    with pytest.raises(NoRouteError):
        aqua._parse_find_path({"success": False}, XLM, TESTNET_AQUA,
                              amount_in=1, amount_out=None, slippage=0.01)
