"""No-network tests for the liquidity surface, on the shared golden fixtures."""
import json
import pathlib

import pytest
from stellar_sdk import scval

from aquarius import AquariusClient, AquariusError, Asset, Pool, XLM
from aquarius.pool import (
    parse_deposit_result,
    parse_pools_map,
    parse_u128_vec,
    resolve_amounts,
    sort_token_ids,
)

TESTDATA = pathlib.Path(__file__).resolve().parents[2] / "testdata"
TESTNET_PASSPHRASE = "Test SDF Network ; September 2015"
AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER")

XLM_ID = XLM.contract_id(TESTNET_PASSPHRASE)
AQUA_ID = AQUA.contract_id(TESTNET_PASSPHRASE)
SORTED_PAIR = sort_token_ids([AQUA_ID, XLM_ID])

POOLS_FIXTURE = json.loads((TESTDATA / "pools_by_address_testnet.json").read_text())


def test_token_ordering_matches_contract_rule():
    # sorted by contract-ID bytes, and stable regardless of input order
    assert sort_token_ids([XLM_ID, AQUA_ID]) == SORTED_PAIR
    assert sort_token_ids([AQUA_ID, XLM_ID]) == SORTED_PAIR


def test_resolve_amounts_accepts_assets_ids_and_lists():
    by_asset = resolve_amounts({XLM: 5, AQUA: 7}, SORTED_PAIR, TESTNET_PASSPHRASE)
    by_id = resolve_amounts({XLM_ID: 5, AQUA_ID: 7}, SORTED_PAIR, TESTNET_PASSPHRASE)
    assert by_asset == by_id
    assert sorted(by_asset) == [5, 7]
    assert resolve_amounts(by_asset, SORTED_PAIR, TESTNET_PASSPHRASE) == by_asset
    # missing tokens default to zero
    assert 0 in resolve_amounts({XLM: 5}, SORTED_PAIR, TESTNET_PASSPHRASE)


def test_resolve_amounts_rejects_foreign_tokens_and_bad_lengths():
    with pytest.raises(AquariusError):
        resolve_amounts({Asset.contract("CFOREIGN"): 1}, SORTED_PAIR, TESTNET_PASSPHRASE)
    with pytest.raises(AquariusError):
        resolve_amounts([1], SORTED_PAIR, TESTNET_PASSPHRASE)


def test_scval_parsers_round_trip():
    vec = scval.to_vec([scval.to_uint128(3), scval.to_uint128(9)])
    assert parse_u128_vec(vec) == [3, 9]
    deposit = scval.to_vec([vec, scval.to_uint128(42)])
    assert parse_deposit_result(deposit) == ([3, 9], 42)
    pools = scval.to_map(
        {scval.to_bytes(b"\x01" * 32): scval.to_address(SORTED_PAIR[0])}
    )
    parsed = parse_pools_map(pools)
    assert parsed == {b"\x01" * 32: SORTED_PAIR[0]}


def test_make_pool_from_api_fixture():
    client = AquariusClient(network="testnet")
    entry = POOLS_FIXTURE["results"][0]
    pool = client._make_pool(
        bytes.fromhex(entry["index"]), entry["address"], entry["tokens_addresses"], entry
    )
    assert pool.type == "volatile"          # constant_product maps to the docs name
    assert pool.fee_bps == 30               # "0.0030"
    assert pool.tokens == entry["tokens_addresses"]
    assert pool.token_labels[0] == "native"


def test_concentrated_deposit_is_blocked_before_any_network_call():
    pool = Pool(
        address="CPOOL",
        pool_hash=b"\x00" * 32,
        type="concentrated",
        fee_bps=30,
        tokens=SORTED_PAIR,
        token_labels=[],
        _client=None,  # would explode if any network path were reached
    )
    with pytest.raises(AquariusError, match="full-range"):
        pool.deposit({XLM: 1})
