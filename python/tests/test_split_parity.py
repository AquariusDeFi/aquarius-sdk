import json
from copy import deepcopy
from dataclasses import asdict
from pathlib import Path

import pytest
from stellar_sdk import Address, scval, xdr

import aquarius
from aquarius import (
    NoRouteError,
    SwapSplitPart,
    SwapSplitPlan,
    build_swap_split_operation,
    get_swap_minimum,
    normalize_swap_split_plan,
    sell_amount_to_raw,
)

ROOT = Path(__file__).parents[2] / "testdata"
CASES = json.loads((ROOT / "split-behavior.json").read_text())
FIXTURE = json.loads((ROOT / "split-plans.json").read_text())
REQUEST = FIXTURE["request"]
OPTION_NAMES = {"tokenIn": "token_in", "tokenOut": "token_out"}


def patched(value, changes=()):
    """Fixture changes: set or delete the value at a path of keys and indices;
    an empty path replaces the whole value."""
    value = deepcopy(value)
    for change in changes:
        if not change["path"]:
            value = deepcopy(change["value"])
            continue
        *parents, last = change["path"]
        node = value
        for step in parents:
            node = node[step]
        if change.get("delete"):
            del node[last]
        else:
            node[last] = change["value"]
    return value


def base(name):
    return FIXTURE["noRoute"] if name == "noRoute" else FIXTURE["plans"][name]


def normalize(response, overrides=None):
    r = {**REQUEST, **(overrides or {})}
    return normalize_swap_split_plan(
        response, r["token_in_address"], r["token_out_address"], r["amount"]
    )


def plan_of(response):
    """The response's plan without validation, for building from changed plans."""
    return SwapSplitPlan(
        response["amount_in"],
        response["amount_out"],
        [
            [
                SwapSplitPart(
                    part["share"],
                    part["amount_in"],
                    part["amount_out"],
                    part["swap_chain_xdr"],
                    part["pools"],
                    part["tokens_addresses"],
                    part.get("tokens", []),
                )
                for part in stage
            ]
            for stage in response["stages"]
        ],
    )


def trustline(value):
    if not isinstance(value, dict):
        return value
    names = {"assetCode": "asset_code", "networkPassphrase": "network_passphrase"}
    return {names.get(key, key): item for key, item in value.items()}


def build_options(plan, minimum, extra=None):
    """Builder keyword arguments; `extra` overrides them by their shared camelCase names."""
    options = {
        "source": FIXTURE["source"],
        "router": FIXTURE["router"],
        "token_in": REQUEST["token_in_address"],
        "token_out": REQUEST["token_out_address"],
        "plan": plan,
        "minimum": minimum,
    }
    for key, value in (extra or {}).items():
        key = OPTION_NAMES.get(key, key)
        options[key] = trustline(value) if key == "trustline" else value
    return options


def assert_rejected(run, family, reason):
    """The SDK's message for a rejection: its family and the failed check."""
    with pytest.raises(ValueError) as caught:
        run()
    prefix = "Invalid swap" if family == "swap" else "Invalid swap quote"
    assert str(caught.value) == f"{prefix}: {reason}"


@pytest.mark.parametrize("case", CASES["amounts"])
def test_shared_amounts(case):
    def run():
        return sell_amount_to_raw(case["amount"], case["decimals"])

    if case.get("error"):
        assert_rejected(run, case["error"], case["reason"])
    else:
        assert run() == case["expected"]


@pytest.mark.parametrize("case", CASES["minimums"])
def test_shared_minimums(case):
    def run():
        return get_swap_minimum(case["output"], case["slippage"])

    if case.get("error"):
        assert_rejected(run, case["error"], case["reason"])
    else:
        assert run() == case["expected"]


@pytest.mark.parametrize("case", CASES["quotes"], ids=lambda c: c["name"])
def test_shared_quotes(case):
    response = patched(base(case["base"])["response"], case.get("patch", []))

    def run():
        return normalize(response, case.get("request"))

    if case.get("error") == "noRoute":
        with pytest.raises(NoRouteError):
            run()
    elif case.get("error"):
        assert_rejected(run, case["error"], case["reason"])
    else:
        plan = run()
        assert asdict(plan) == asdict(plan_of(response))
        assert plan.amount_out == case["expected"]["amountOut"]
        shares = [[part.share for part in stage] for stage in plan.stages]
        assert shares == case["expected"]["shares"]
        assert all(type(share) is int for stage in shares for share in stage)


@pytest.mark.parametrize("case", CASES["builds"], ids=lambda c: c["name"])
def test_shared_builds(case):
    response = base(case["base"])["response"]
    trust = (
        {"batch": FIXTURE["batch"], "trustline": FIXTURE["trustline"]}
        if case.get("trust")
        else {}
    )
    options = build_options(
        plan_of(patched(response, case.get("patch", []))),
        response["amount_out_min"],
        {**trust, **case.get("options", {})},
    )
    if case.get("error"):
        assert_rejected(
            lambda: build_swap_split_operation(**options), case["error"], case["reason"]
        )
    else:
        build_swap_split_operation(**options)


def address(value):
    return Address.from_xdr_sc_address(value.address).address


def contract_call(fn):
    return (
        Address.from_xdr_sc_address(fn.contract_address).address,
        fn.function_name.sc_symbol.decode(),
        fn.args,
    )


def encoded(values):
    return [value.to_xdr() for value in values]


def assert_swap_split(call, root, response, minimum):
    """The swap_split call and the user's whole authorization of it: the call with
    the same arguments and the one input transfer."""
    contract, name, args = call
    assert (contract, name, len(args)) == (FIXTURE["router"], "swap_split", 6)
    assert address(args[0]) == FIXTURE["source"]
    assert args[1].to_xdr() == response["stages_xdr"]
    assert address(args[2]) == REQUEST["token_in_address"]
    assert address(args[3]) == REQUEST["token_out_address"]
    assert args[4].type == xdr.SCValType.SCV_U128
    assert scval.from_uint128(args[4]) == int(response["amount_in"])
    assert args[5].type == xdr.SCValType.SCV_U128
    assert scval.from_uint128(args[5]) == int(minimum)
    signed_contract, signed_name, signed_args = contract_call(root.function.contract_fn)
    assert (signed_contract, signed_name) == (contract, name)
    assert encoded(signed_args) == encoded(args)
    assert len(root.sub_invocations) == 1
    transfer = root.sub_invocations[0]
    moved_contract, moved_name, moved_args = contract_call(
        transfer.function.contract_fn
    )
    assert (moved_contract, moved_name, len(moved_args)) == (
        REQUEST["token_in_address"],
        "transfer",
        3,
    )
    assert [address(moved_args[0]), address(moved_args[1])] == [
        FIXTURE["source"],
        FIXTURE["router"],
    ]
    assert moved_args[2].type == xdr.SCValType.SCV_I128
    assert scval.from_int128(moved_args[2]) == int(response["amount_in"])
    assert transfer.sub_invocations == []


GOLDEN = [name for name, entry in FIXTURE["plans"].items() if "operationXdr" in entry]


@pytest.mark.parametrize("name", GOLDEN)
def test_shared_swap_split_operation_and_authorization(name):
    entry = FIXTURE["plans"][name]
    response = entry["response"]
    plan = normalize(response)
    minimum = get_swap_minimum(plan.amount_out, "0.5")
    assert minimum == response["amount_out_min"]
    operation = build_swap_split_operation(
        **build_options(plan, minimum)
    ).to_xdr_object()
    assert operation.to_xdr() == entry["operationXdr"]
    assert operation.source_account is None
    invoke = operation.body.invoke_host_function_op
    assert len(invoke.auth) == 1
    assert (
        invoke.auth[0].credentials.type
        == xdr.SorobanCredentialsType.SOROBAN_CREDENTIALS_SOURCE_ACCOUNT
    )
    assert_swap_split(
        contract_call(invoke.host_function.invoke_contract),
        invoke.auth[0].root_invocation,
        response,
        minimum,
    )


@pytest.mark.parametrize("name", GOLDEN)
def test_shared_trust_and_swap_split_batch(name):
    entry = FIXTURE["plans"][name]
    response = entry["response"]
    minimum = response["amount_out_min"]
    operation = build_swap_split_operation(
        **build_options(
            normalize(response),
            minimum,
            {"batch": FIXTURE["batch"], "trustline": FIXTURE["trustline"]},
        )
    ).to_xdr_object()
    assert operation.to_xdr() == entry["trustOperationXdr"]
    invoke = operation.body.invoke_host_function_op
    contract, name, args = contract_call(invoke.host_function.invoke_contract)
    assert (contract, name) == (FIXTURE["batch"], "batch")
    authorizers, calls, return_results = args
    assert [address(value) for value in authorizers.vec.sc_vec] == [FIXTURE["source"]]
    assert return_results.b is True
    assert len(calls.vec.sc_vec) == 2
    trust, swap = (value.vec.sc_vec for value in calls.vec.sc_vec)
    assert [
        address(trust[0]),
        trust[1].sym.sc_symbol.decode(),
        [address(v) for v in trust[2].vec.sc_vec],
    ] == [
        REQUEST["token_out_address"],
        "trust",
        [FIXTURE["source"]],
    ]
    assert len(invoke.auth) == 1
    root = invoke.auth[0].root_invocation
    signed_contract, signed_name, signed_args = contract_call(root.function.contract_fn)
    assert (signed_contract, signed_name) == (FIXTURE["batch"], "batch")
    assert encoded(signed_args) == encoded(args)
    assert len(root.sub_invocations) == 2
    trust_auth, swap_auth = root.sub_invocations
    trusted_contract, trusted_name, trusted_args = contract_call(
        trust_auth.function.contract_fn
    )
    assert [trusted_contract, trusted_name, [address(v) for v in trusted_args]] == [
        REQUEST["token_out_address"],
        "trust",
        [FIXTURE["source"]],
    ]
    assert trust_auth.sub_invocations == []
    assert_swap_split(
        (address(swap[0]), swap[1].sym.sc_symbol.decode(), swap[2].vec.sc_vec),
        swap_auth,
        response,
        minimum,
    )


def test_over_long_route_xdr_is_rejected_before_decoding():
    response = patched(
        FIXTURE["plans"]["single"]["response"],
        [{"path": ["stages", 0, 0, "swap_chain_xdr"], "value": "A" * 32772}],
    )
    reason = "swap_chain_xdr is too long"
    assert_rejected(lambda: normalize(response), "quote", reason)
    assert_rejected(
        lambda: build_swap_split_operation(**build_options(plan_of(response), "1")),
        "quote",
        reason,
    )


def test_public_capability_parity():
    for _, name in CASES["capabilities"]:
        assert callable(getattr(aquarius, name)), name
        assert name in aquarius.__all__
