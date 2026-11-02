import json
from pathlib import Path
from copy import deepcopy
import pytest
from aquarius import normalize_sell_swap_plans
from aquarius.split_swap import (
    sell_amount_to_raw,
    prepare_sell_swap_plans,
    get_swap_minimum,
)

ROOT = Path(__file__).parents[2] / "testdata"
CASES = json.loads((ROOT / "split-behavior.json").read_text())
API = json.loads((ROOT / "split-api-response.json").read_text())


def plans():
    r = API["request"]
    all_plans = normalize_sell_swap_plans(
        API["response"], r["token_in_address"], r["token_out_address"], r["amount"]
    )
    return [all_plans[0], all_plans[2]]


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


@pytest.mark.parametrize("case", CASES["preparations"], ids=lambda c: c["name"])
def test_shared_preparation(case):
    candidates = plans()
    calls = [[], []]
    original = deepcopy(candidates)

    def simulate(plan, minimum):
        index = next(i for i, p in enumerate(candidates) if p is plan)
        step = len(calls[index])
        calls[index].append(minimum)
        result = case["results"][index][step]
        if result == "error":
            raise ValueError("candidate unavailable")
        return {"tx": f"{index}:{minimum}", "outputs": list(map(int, result))}

    if case.get("error"):
        with pytest.raises(ValueError):
            prepare_sell_swap_plans(candidates, "1", simulate)
    else:
        result = prepare_sell_swap_plans(candidates, "1", simulate)
        assert result.tx == f"{case['selected']}:{case['minimum']}"
        assert result.output_amount == case["output"]
        assert result.minimum_output == case["minimum"]
        assert sum(map(int, result.leg_outputs)) == int(result.output_amount)
    assert calls == case["calls"]
    assert candidates == original


@pytest.mark.parametrize("case", CASES["quotes"])
def test_shared_quote_rejection(case):
    q = deepcopy(API["response"])
    q["split_plans"][0]["legs"][0][case["field"]] = case["value"]
    r = API["request"]
    assert [
        len(p.legs)
        for p in normalize_sell_swap_plans(
            q, r["token_in_address"], r["token_out_address"], r["amount"]
        )
    ] == case["expectedParts"]


def test_public_capability_parity():
    import aquarius

    for _, name in CASES["capabilities"]:
        assert callable(getattr(aquarius, name)), name
