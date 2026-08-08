"""Concentrated-liquidity tests: golden tick math + pool flows on a fake client."""
import json
import pathlib
from math import isqrt

import pytest
from stellar_sdk import scval

from aquarius import MAX_TICK, AquariusError, snap_tick, tick_from_price
from aquarius.concentrated import sqrt_ratio_x96
from aquarius.pool import Pool
from aquarius.submit import ConfirmedTx

TESTDATA = pathlib.Path(__file__).resolve().parents[2] / "testdata"
FIX = json.loads((TESTDATA / "concentrated_tick_math.json").read_text())

XLM_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
AQUA_ID = "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE"
POOL_ID = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD"
OWNER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER"


# --- tick math: parity with the golden fixture, accuracy from first principles ------


def test_sqrt_ratio_matches_golden_fixture():
    for tick, expected in FIX["sqrt_ratio_x96"].items():
        assert sqrt_ratio_x96(int(tick)) == int(expected)


def test_tick_from_price_matches_golden_fixture():
    for case in FIX["tick_from_price"]:
        assert tick_from_price(case["price"]) == case["tick"]
    for case in FIX["tick_from_price_with_decimals"]:
        got = tick_from_price(case["price"], decimals=tuple(case["decimals"]))
        assert got == case["tick"]


def test_snap_matches_golden_fixture():
    for case in FIX["snap"]:
        assert snap_tick(case["tick"], case["spacing"], up=case["up"]) == case["snapped"]


def test_sqrt_ratio_accuracy_from_first_principles():
    for t in (-4096, -200, -1, 0, 1, 60, 200, 4096):
        if t >= 0:
            true = isqrt((10001**t << 192) // 10000**t)
        else:
            true = isqrt((10000**-t << 192) // 10001**-t)
        assert abs(sqrt_ratio_x96(t) - true) <= max(true >> 40, 2)


def test_known_values_and_bounds():
    assert sqrt_ratio_x96(0) == 1 << 96
    assert tick_from_price("1") == 0
    assert tick_from_price("1.0001") == 1
    assert tick_from_price("0.9999") == -2  # floor semantics
    with pytest.raises(AquariusError):
        sqrt_ratio_x96(MAX_TICK + 1)
    with pytest.raises(AquariusError):
        tick_from_price("0")
    with pytest.raises(AquariusError):
        tick_from_price("not a price")


# --- pool flows on a fake client ----------------------------------------------------


class FakeClient:
    def __init__(self, read_results):
        from aquarius.networks import NETWORKS

        self.network = NETWORKS["testnet"]
        self.read_results = read_results
        self.reads = []
        self.submitted = []
        self.submit_result = None

    def _read_source(self, require_signer=False):
        return OWNER

    def _read_contract(self, contract_id, fn, args):
        self.reads.append((contract_id, fn, args))
        return self.read_results[fn]

    def _submit_contract(self, contract_id, fn, args, auth=None):
        self.submitted.append((contract_id, fn, args, auth))
        return ConfirmedTx(tx_hash="h", return_value=self.submit_result)


def concentrated_pool(client, pool_type="concentrated"):
    return Pool(
        address=POOL_ID,
        pool_hash=bytes(32),
        type=pool_type,
        fee_bps=30,
        tokens=[XLM_ID, AQUA_ID],
        token_labels=[],
        _client=client,
    )


def test_concentrated_methods_refuse_other_pool_types():
    pool = concentrated_pool(FakeClient({}), pool_type="volatile")
    with pytest.raises(AquariusError, match="concentrated"):
        pool.tick_spacing()
    with pytest.raises(AquariusError, match="concentrated"):
        pool.estimate_position_deposit([1, 1], tick_range=(-60, 60))


def test_estimate_snaps_price_range_and_execute_carries_bounded_auth():
    client = FakeClient({
        "get_tick_spacing": scval.to_uint32(60),
        "estimate_deposit_position": scval.to_vec([
            scval.to_vec([scval.to_uint128(90), scval.to_uint128(880)]),
            scval.to_uint128(1234),
        ]),
    })
    pool = concentrated_pool(client)
    est = pool.estimate_position_deposit([100, 900], price_range=("0.5", "2"))

    assert est.tick_lower == snap_tick(tick_from_price("0.5"), 60)  # floored
    assert est.tick_upper == snap_tick(tick_from_price("2"), 60, up=True)  # ceiled
    assert est.tick_lower % 60 == 0 and est.tick_upper % 60 == 0
    assert est.amounts == [90, 880] and est.liquidity == 1234

    client.submit_result = scval.to_vec([
        scval.to_vec([scval.to_uint128(90), scval.to_uint128(880)]),
        scval.to_uint128(1200),
    ])
    result = est.execute(slippage=0.05)

    contract, fn, args, auth = client.submitted[0]
    assert contract == POOL_ID and fn == "deposit_position"
    assert scval.from_uint128(args[4]) == 1234 * 9_500 // 10_000  # min-liquidity guard
    [entry] = auth
    root = entry.root_invocation
    assert root.function.contract_fn.function_name.sc_symbol == b"deposit_position"
    transfers = root.sub_invocations
    # Full desired amounts authorized per token, mirroring the web app.
    assert [
        scval.from_int128(t.function.contract_fn.args[2]) for t in transfers
    ] == [100, 900]
    assert [
        t.function.contract_fn.function_name.sc_symbol for t in transfers
    ] == [b"transfer", b"transfer"]
    assert result.amounts == [90, 880] and result.liquidity == 1200


def test_estimate_validates_tick_input():
    client = FakeClient({"get_tick_spacing": scval.to_uint32(60)})
    pool = concentrated_pool(client)
    with pytest.raises(AquariusError, match="exactly one"):
        pool.estimate_position_deposit([1, 1])
    with pytest.raises(AquariusError, match="spacing"):
        pool.estimate_position_deposit([1, 1], tick_range=(-61, 60))
    with pytest.raises(AquariusError, match="below tick_upper"):
        pool.estimate_position_deposit([1, 1], tick_range=(60, -60))


def test_withdraw_derives_min_amounts_and_uses_root_only_auth():
    client = FakeClient({
        "get_position": scval.to_map({
            scval.to_symbol("liquidity"): scval.to_uint128(500),
        }),
        "estimate_withdraw_position": scval.to_vec([
            scval.to_uint128(100), scval.to_uint128(200),
        ]),
    })
    pool = concentrated_pool(client)
    client.submit_result = scval.to_vec([scval.to_uint128(99), scval.to_uint128(199)])

    result = pool.withdraw_position(-60, 60)  # liquidity defaults to the whole position

    contract, fn, args, auth = client.submitted[0]
    assert fn == "withdraw_position"
    assert scval.from_uint128(args[3]) == 500
    mins = [scval.from_uint128(v) for v in args[4].vec.sc_vec]
    assert mins == [99, 198]  # estimate reduced by the default 1% slippage
    [entry] = auth
    assert entry.root_invocation.sub_invocations == []  # nothing pulled from the user
    assert result.amounts == [99, 199]


def test_position_value_splits_principal_and_fees():
    client = FakeClient({
        "get_position": scval.to_map({
            scval.to_symbol("liquidity"): scval.to_uint128(500),
        }),
        "estimate_withdraw_position": scval.to_vec([
            scval.to_uint128(110), scval.to_uint128(220),
        ]),
        "get_position_fees": scval.to_vec([
            scval.to_uint128(10), scval.to_uint128(20),
        ]),
    })
    value = concentrated_pool(client).position_value(-60, 60)
    assert value.total == [110, 220]
    assert value.fees == [10, 20]
    assert value.principal == [100, 200]


def test_reads_parse_slot0_and_ranges():
    client = FakeClient({
        "get_slot0": scval.to_map({
            scval.to_symbol("sqrt_price_x96"): scval.to_uint256(1 << 96),
            scval.to_symbol("tick"): scval.to_int32(7),
        }),
        "get_user_position_snapshot": scval.to_map({
            scval.to_symbol("ranges"): scval.to_vec([
                scval.to_map({
                    scval.to_symbol("tick_lower"): scval.to_int32(-60),
                    scval.to_symbol("tick_upper"): scval.to_int32(120),
                }),
            ]),
        }),
    })
    pool = concentrated_pool(client)
    slot = pool.slot0()
    assert slot.tick == 7 and slot.sqrt_price_x96 == 1 << 96
    assert pool.position_ranges() == [(-60, 120)]
