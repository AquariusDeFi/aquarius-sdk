import json
from pathlib import Path
import pytest
from stellar_sdk import Keypair, StrKey, scval
from aquarius.split_swap import (
    normalize_sell_swap_plan,
    build_sell_swap_operation,
    get_swap_minimum,
    get_sell_swap_result,
)

FIXTURE = json.loads(
    (Path(__file__).parents[2] / "testdata/split-api-response.json").read_text()
)


def plan():
    r = FIXTURE["request"]
    return normalize_sell_swap_plan(
        FIXTURE["response"], r["token_in_address"], r["token_out_address"], r["amount"]
    )


def test_allocation_and_serialized_routes():
    assert len(plan().legs) == 2
    assert sum(int(l.amount_in) for l in plan().legs) == int(plan().amount_in)


@pytest.mark.parametrize("value", ["0", "-1", "1.1", "1e3", str(1 << 127)])
def test_invalid_amount(value):
    r = FIXTURE["request"]
    with pytest.raises(ValueError):
        normalize_sell_swap_plan(
            FIXTURE["response"], r["token_in_address"], r["token_out_address"], value
        )


def test_minimum_and_return():
    assert get_swap_minimum("10001", "0.005") == "10000"
    assert get_sell_swap_result(
        scval.to_vec(
            [
                scval.to_void(),
                scval.to_vec([scval.to_uint128(10), scval.to_uint128(20)]),
            ]
        ),
        2,
        True,
    ) == [10, 20]


def test_fixed_auth():
    r = FIXTURE["request"]
    p = plan()
    op = build_sell_swap_operation(
        source=Keypair.random().public_key,
        token_in=r["token_in_address"],
        token_out=r["token_out_address"],
        router=StrKey.encode_contract(bytes([8]) * 32),
        split_router=StrKey.encode_contract(bytes([9]) * 32),
        plan=p,
        minimum="123",
    )
    root = op.auth[0].root_invocation
    assert scval.from_uint128(root.function.contract_fn.args[5]) == 123
    assert [
        scval.from_int128(c.sub_invocations[0].function.contract_fn.args[2])
        for c in root.sub_invocations
    ] == [int(l.amount_in) for l in p.legs]


@pytest.mark.parametrize("encoded", ["AAAA", "", "invalid"])
def test_malformed_split_xdr_fails_closed(encoded):
    from copy import deepcopy

    q = deepcopy(FIXTURE["response"])
    q["split_plan"]["legs"][0]["swap_chain_xdr"] = encoded
    r = FIXTURE["request"]
    with pytest.raises(ValueError, match="Invalid swap quote"):
        normalize_sell_swap_plan(
            q, r["token_in_address"], r["token_out_address"], r["amount"]
        )
