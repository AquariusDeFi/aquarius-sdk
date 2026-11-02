import json
from pathlib import Path
from copy import deepcopy
import pytest
from aquarius import normalize_sell_swap_plan
from aquarius.split_swap import (
    sell_amount_to_raw,
    get_swap_minimum,
)

ROOT = Path(__file__).parents[2] / "testdata"
CASES = json.loads((ROOT / "split-behavior.json").read_text())
API = json.loads((ROOT / "split-api-response.json").read_text())


@pytest.mark.parametrize("case", CASES["amounts"])
def test_shared_amounts(case):
    if case.get("error"):
        with pytest.raises(ValueError):
            sell_amount_to_raw(case["amount"], case["decimals"])
    else:
        assert sell_amount_to_raw(case["amount"], case["decimals"]) == case["expected"]


@pytest.mark.parametrize("case", CASES["minimums"])
def test_shared_minimums(case):
    if case.get("error"):
        with pytest.raises(ValueError):
            get_swap_minimum(case["output"], case["slippage"])
    else:
        assert get_swap_minimum(case["output"], case["slippage"]) == case["expected"]


@pytest.mark.parametrize("case", CASES["quotes"], ids=lambda c: c["name"])
def test_shared_quotes(case):
    q = deepcopy({**API["response"], **case.get("quote", {})})
    for key in case.get("omit", []):
        del q[key]
    if "plan" in case:
        q["split_plan"].update(case["plan"])
    if "legs" in case:
        legs = API["response"]["split_plan"]["legs"]
        q["split_plan"]["legs"] = [
            {**legs[leg["from"]], **{k: v for k, v in leg.items() if k != "from"}}
            for leg in case["legs"]
        ]
    r = API["request"]

    def run():
        return normalize_sell_swap_plan(
            q, r["token_in_address"], r["token_out_address"], r["amount"]
        )

    if case.get("error"):
        with pytest.raises(ValueError, match="Invalid swap quote"):
            run()
    else:
        result = run()
        assert len(result.legs) == case["expectedParts"]
        assert result.amount_out == case["expectedOutput"]


def test_public_capability_parity():
    import aquarius

    for _, name in CASES["capabilities"]:
        assert callable(getattr(aquarius, name)), name
