"""No-network tests for the liquidity surface, on the shared golden fixtures."""
import json
import pathlib
from types import SimpleNamespace

import pytest
from stellar_sdk import Address, scval

from aquarius import AquariusClient, AquariusError, Asset, Pool, XLM
from aquarius.pool import (
    parse_deposit_result,
    parse_pools_map,
    parse_u128_vec,
    resolve_amounts,
    sort_token_ids,
)
from aquarius.networks import NETWORKS
from aquarius.submit import ConfirmedTx

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


OWNER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER"
POOL_ID = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD"


def liquidity_pool(pool_type, estimate, result):
    submissions = []
    client = SimpleNamespace(
        network=NETWORKS["testnet"],
        _read_source=lambda **kwargs: OWNER,
        _read_router=lambda fn, args: estimate,
        _submit_contract=lambda contract, fn, args, *, auth: (
            submissions.append((contract, fn, args, auth)) or ConfirmedTx("h", result)
        ),
    )
    pool = Pool(POOL_ID, bytes(32), pool_type, 30, SORTED_PAIR, [], client)
    return pool, submissions


def invocation_call(invocation):
    fn = invocation.function.contract_fn
    return (Address.from_xdr_sc_address(fn.contract_address).address,
            fn.function_name.sc_symbol.decode(), [a.to_xdr() for a in fn.args])


def submitted_pool_call(pool, submissions):
    contract, fn, args, [entry] = submissions[0]
    assert invocation_call(entry.root_invocation) == (
        contract, fn, [a.to_xdr() for a in args]
    )
    [pool_call] = entry.root_invocation.sub_invocations
    assert invocation_call(pool_call) == (
        pool.address, fn, [a.to_xdr() for a in [args[0]] + args[3:]]
    )
    return args, pool_call


@pytest.mark.parametrize("pool_type,desired", [
    ("volatile", [100, 200]), ("volatile", [100, 0]), ("stable", [100, 0]),
])
def test_deposit_authorizes_desired_transfers_with_pool_zero_rules(pool_type, desired):
    # An imbalance may refund input: estimated amounts must never become auth.
    estimated = scval.to_vec([
        scval.to_vec([scval.to_uint128(50), scval.to_uint128(0)]), scval.to_uint128(1000),
    ])
    pool, submissions = liquidity_pool(pool_type, estimated, estimated)
    pool.deposit(desired)

    args, pool_call = submitted_pool_call(pool, submissions)
    assert scval.from_uint128(args[4]) == 990
    transfers = [invocation_call(i) for i in pool_call.sub_invocations]
    assert transfers == [
        (token, "transfer", [v.to_xdr() for v in [
            scval.to_address(OWNER), scval.to_address(POOL_ID), scval.to_int128(amount),
        ]])
        for token, amount in zip(SORTED_PAIR, desired)
        if pool_type == "volatile" or amount > 0
    ]


@pytest.mark.parametrize("pool_type", ["volatile", "stable", "concentrated"])
def test_withdraw_authorizes_lp_burn_only_for_legacy_pools(pool_type):
    amounts = scval.to_vec([scval.to_uint128(100), scval.to_uint128(200)])
    pool, submissions = liquidity_pool(pool_type, amounts, amounts)
    share_reads = []
    pool.share_token = lambda: share_reads.append(True) or AQUA_ID
    pool.withdraw(123)

    args, pool_call = submitted_pool_call(pool, submissions)
    assert parse_u128_vec(args[4]) == [99, 198]
    if pool_type == "concentrated":
        assert pool_call.sub_invocations == []
        assert share_reads == []
    else:
        [burn] = pool_call.sub_invocations
        assert invocation_call(burn) == (AQUA_ID, "burn", [
            scval.to_address(OWNER).to_xdr(), scval.to_int128(123).to_xdr(),
        ])


def test_reward_claim_authorizes_router_and_pool_without_token_debits():
    result = scval.to_uint128(77)
    pool, submissions = liquidity_pool("stable", None, result)
    assert pool.claim_rewards().amount == 77
    _, pool_call = submitted_pool_call(pool, submissions)
    assert pool_call.sub_invocations == []
