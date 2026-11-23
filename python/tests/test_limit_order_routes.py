"""Settlement ABI parity with XDR produced by the Rust contract types."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from stellar_sdk import scval

from aquarius import AquariusError, LimitOrderConfig, fill_parameters, normalize_swap_split_plan

DATA = Path(__file__).parents[2] / "testdata"
QUOTES = json.loads((DATA / "split-plans.json").read_text())
EXPECTED = json.loads((DATA / "settlement-routes.json").read_text())
REQUEST = QUOTES["request"]
RECORD = SimpleNamespace(order=SimpleNamespace(
    sell_token=REQUEST["token_in_address"], buy_token=REQUEST["token_out_address"],
    sell_amount=int(REQUEST["amount"]), order_scval=scval.to_void(),
))
CHAIN = QUOTES["plans"]["single"]["response"]["stages"][0][0]["swap_chain_xdr"]


def plan(name="single"):
    return normalize_swap_split_plan(QUOTES["plans"][name]["response"],
                                     RECORD.order.sell_token, RECORD.order.buy_token,
                                     REQUEST["amount"])


def test_legacy_default_and_typed_chain_match_contract_encoding():
    assert LimitOrderConfig(settlement=QUOTES["router"]).route_format == "legacy"
    assert fill_parameters(RECORD, QUOTES["source"], CHAIN)[2].to_xdr() == EXPECTED["legacy"]
    assert fill_parameters(RECORD, QUOTES["source"], CHAIN, route_format="typed")[2].to_xdr() == EXPECTED["chained"]
    with pytest.raises(AquariusError, match="route format"):
        LimitOrderConfig(settlement=QUOTES["router"], route_format="typo")


@pytest.mark.parametrize("name", [name for name in QUOTES["plans"] if not name.startswith("five")])
def test_split_plan_matches_contract_structs(name):
    route = fill_parameters(RECORD, QUOTES["source"], plan(name), route_format="typed")[2]
    assert route.to_xdr() == EXPECTED["split"][name]


def test_split_requires_typed_settlement_and_revalidates_the_plan():
    value = plan()
    with pytest.raises(AquariusError, match="typed"):
        fill_parameters(RECORD, QUOTES["source"], value)
    bad = copy.deepcopy(value)
    bad.amount_in = str(RECORD.order.sell_amount + 1)
    with pytest.raises(AquariusError, match="order input"):
        fill_parameters(RECORD, QUOTES["source"], bad, route_format="typed")
    bad = copy.deepcopy(value)
    bad.stages[0][0].share -= 1
    with pytest.raises(ValueError, match="shares"):
        fill_parameters(RECORD, QUOTES["source"], bad, route_format="typed")
    wrong_order = SimpleNamespace(order=SimpleNamespace(**vars(RECORD.order)))
    wrong_order.order.buy_token = QUOTES["router"]
    with pytest.raises(ValueError, match="token_out"):
        fill_parameters(wrong_order, QUOTES["source"], value, route_format="typed")


@pytest.mark.parametrize("name", ["fiveHops", "fiveParts", "fiveStages"])
def test_oversized_plans_are_rejected(name):
    with pytest.raises(ValueError, match="more than 4"):
        plan(name)
