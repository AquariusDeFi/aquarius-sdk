"""Opt-in exact-input split primitives. These helpers never sign or submit.

Search remains in the API. A caller must simulate the full ordered operation,
check network resources and bind the aggregate minimum before signing.
"""

from __future__ import annotations

import re
import binascii
import struct
from dataclasses import dataclass, replace
from fractions import Fraction
from typing import Any, Callable, Generic, TypeVar, TypedDict

from stellar_sdk import Address, Asset, StrKey, scval
from stellar_sdk.operation import InvokeHostFunction
from stellar_sdk.xdr import (
    SCVal,
    SCValType,
    HostFunction,
    HostFunctionType,
    InvokeContractArgs,
    SCSymbol,
)

from .authorization import authorized_invocation, source_account_entry

_MAX_AMOUNT = (1 << 127) - 1


def _raw(value: str) -> int:
    if (
        not isinstance(value, str)
        or not re.fullmatch(r"[1-9][0-9]*", value)
        or int(value) > _MAX_AMOUNT
    ):
        raise ValueError("Invalid swap quote")
    return int(value)


@dataclass
class SellSwapLeg:
    amount_in: str
    amount_out: str
    swap_chain_xdr: str
    pools: list[str]
    tokens_addresses: list[str]
    tokens: list[str]


@dataclass
class SellSwapPlan:
    amount_in: str
    amount_out: str
    legs: list[SellSwapLeg]


def _contract(value: SCVal) -> str:
    if value.type != SCValType.SCV_ADDRESS:
        raise ValueError("Invalid route address")
    address = Address.from_xdr_sc_address(value.address).address
    if not StrKey.is_valid_contract(address):
        raise ValueError("Invalid contract")
    return address


def _leg(value: dict, base: str, counter: str) -> SellSwapLeg:
    _raw(value["amount_in"])
    _raw(value["amount_out"])
    pools, tokens, encoded = (
        value["pools"],
        value["tokens_addresses"],
        value["swap_chain_xdr"],
    )
    if (
        not isinstance(pools, list)
        or not 1 <= len(pools) <= 4
        or len(set(pools)) != len(pools)
        or any(not StrKey.is_valid_contract(p) for p in pools)
        or not isinstance(tokens, list)
        or len(tokens) != len(pools) + 1
        or any(not StrKey.is_valid_contract(t) for t in tokens)
        or tokens[0] != base
        or tokens[-1] != counter
        or not isinstance(encoded, str)
        or len(encoded) > 32768
    ):
        raise ValueError("Invalid route")
    chain = SCVal.from_xdr(encoded)
    if (
        chain.type != SCValType.SCV_VEC
        or chain.vec is None
        or len(chain.vec.sc_vec) != len(pools)
    ):
        raise ValueError("Invalid route shape")
    used = set()
    for i, hop in enumerate(chain.vec.sc_vec):
        if hop.type != SCValType.SCV_VEC or hop.vec is None or len(hop.vec.sc_vec) != 3:
            raise ValueError("Invalid hop")
        pool_tokens, index, output = hop.vec.sc_vec
        if (
            pool_tokens.type != SCValType.SCV_VEC
            or pool_tokens.vec is None
            or index.type != SCValType.SCV_BYTES
            or len(index.bytes.sc_bytes) != 32
            or _contract(output) != tokens[i + 1]
        ):
            raise ValueError("Invalid hop fields")
        addresses = [_contract(t) for t in pool_tokens.vec.sc_vec]
        if (
            len(addresses) < 2
            or len(set(addresses)) != len(addresses)
            or tokens[i] not in addresses
            or tokens[i + 1] not in addresses
            or tokens[i] == tokens[i + 1]
        ):
            raise ValueError("Invalid pool tokens")
        key = (tuple(addresses), index.bytes.sc_bytes)
        if key in used:
            raise ValueError("Repeated pool")
        used.add(key)
    return SellSwapLeg(
        value["amount_in"],
        value["amount_out"],
        encoded,
        pools[:],
        tokens[:],
        list(value["tokens"]) if isinstance(value.get("tokens"), list) else [],
    )


def normalize_sell_swap_plans(
    quote: dict, base: str, counter: str, amount_in: str
) -> list[SellSwapPlan]:
    _raw(amount_in)
    if (
        quote.get("success") is not True
        or base == counter
        or not isinstance(quote.get("amount"), str)
        or not re.fullmatch(r"[0-9]+(?:\.0+)?", quote["amount"])
    ):
        raise ValueError("Invalid swap quote")
    amount_out = str(int(quote["amount"].split(".")[0]))
    baseline = _leg(
        {**quote, "amount_in": amount_in, "amount_out": amount_out}, base, counter
    )
    plans = [SellSwapPlan(amount_in, amount_out, [baseline])]
    candidates = quote.get("split_plans")
    if not isinstance(candidates, list):
        return plans
    seen = set()
    for candidate in candidates[:3]:
        try:
            if (
                candidate["amount_in"] != amount_in
                or not isinstance(candidate["legs"], list)
                or not 2 <= len(candidate["legs"]) <= 4
            ):
                continue
            legs = [_leg(l, base, counter) for l in candidate["legs"]]
            if sum(int(l.amount_in) for l in legs) != int(amount_in) or sum(
                int(l.amount_out) for l in legs
            ) != _raw(candidate["amount_out"]):
                continue
            key = tuple((l.amount_in, l.swap_chain_xdr) for l in legs)
            if key in seen:
                continue
            seen.add(key)
            plans.append(SellSwapPlan(amount_in, candidate["amount_out"], legs))
        except (
            ValueError,
            TypeError,
            KeyError,
            AttributeError,
            EOFError,
            binascii.Error,
            struct.error,
        ):
            continue
    return plans


def get_swap_minimum(output: str, slippage: str) -> str:
    if (
        not isinstance(slippage, str)
        or len(slippage) > 100
        or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", slippage)
    ):
        raise ValueError("Invalid swap slippage")
    tolerance = Fraction(slippage)
    if tolerance > 10:
        raise ValueError("Invalid swap slippage")
    return str(
        _raw(output)
        * (100 - tolerance).numerator
        // ((100 - tolerance).denominator * 100)
    )


def get_sell_swap_result(
    result: SCVal, leg_count: int, with_trustline: bool = False
) -> list[int]:
    if type(leg_count) is not int or not 1 <= leg_count <= 4:
        raise ValueError("Invalid leg count")
    if with_trustline:
        if (
            result.type != SCValType.SCV_VEC
            or result.vec is None
            or len(result.vec.sc_vec) != 2
            or result.vec.sc_vec[0].type != SCValType.SCV_VOID
        ):
            raise ValueError("Unexpected batch result")
        result = result.vec.sc_vec[1]
    if leg_count > 1 and (result.type != SCValType.SCV_VEC or result.vec is None):
        raise ValueError("Unexpected split result")
    values = [result] if leg_count == 1 else result.vec.sc_vec
    if len(values) != leg_count or any(v.type != SCValType.SCV_U128 for v in values):
        raise ValueError("Unexpected split result")
    return [scval.from_uint128(v) for v in values]


def build_sell_swap_operation(
    *,
    source: str,
    token_in: str,
    token_out: str,
    router: str,
    plan: SellSwapPlan,
    minimum: str,
    split_router: str | None = None,
    batch: str | None = None,
    trustline: dict | None = None,
) -> InvokeHostFunction:
    """Fixed ordered auth; trustline requires asset_code, issuer, network_passphrase."""
    if (
        not StrKey.is_valid_ed25519_public_key(source)
        or not StrKey.is_valid_contract(router)
        or token_in == token_out
    ):
        raise ValueError("Invalid swap addresses")
    _raw(plan.amount_in)
    _raw(plan.amount_out)
    if (
        not isinstance(minimum, str)
        or not re.fullmatch(r"[0-9]+", minimum)
        or int(minimum) > _MAX_AMOUNT
        or not 1 <= len(plan.legs) <= 4
    ):
        raise ValueError("Invalid swap minimum or parts")
    legs = [_leg(vars(l), token_in, token_out) for l in plan.legs]
    if sum(int(l.amount_in) for l in legs) != int(plan.amount_in) or sum(
        int(l.amount_out) for l in legs
    ) != int(plan.amount_out):
        raise ValueError("Invalid allocation")
    split = len(legs) > 1
    if split and (not split_router or not StrKey.is_valid_contract(split_router)):
        raise ValueError("Split router not configured")
    children, args_by_leg = [], []
    for leg in legs:
        args = [
            scval.to_address(source),
            SCVal.from_xdr(leg.swap_chain_xdr),
            scval.to_address(token_in),
            scval.to_uint128(int(leg.amount_in)),
            scval.to_uint128(0 if split else int(minimum)),
        ]
        transfer = authorized_invocation(
            token_in,
            "transfer",
            [
                scval.to_address(source),
                scval.to_address(router),
                scval.to_int128(int(leg.amount_in)),
            ],
        )
        children.append(authorized_invocation(router, "swap_chained", args, [transfer]))
        args_by_leg.append(args)
    target = split_router if split else router
    args = (
        [
            scval.to_address(source),
            scval.to_vec(
                [
                    scval.to_vec(
                        [
                            SCVal.from_xdr(l.swap_chain_xdr),
                            scval.to_uint128(int(l.amount_in)),
                        ]
                    )
                    for l in legs
                ]
            ),
            scval.to_address(token_in),
            scval.to_address(token_out),
            scval.to_uint128(int(plan.amount_in)),
            scval.to_uint128(int(minimum)),
        ]
        if split
        else args_by_leg[0]
    )
    root = (
        authorized_invocation(target, "swap_chained", args, children)
        if split
        else children[0]
    )
    function = "swap_chained"
    if trustline:
        if (
            not batch
            or not StrKey.is_valid_contract(batch)
            or trustline["issuer"] == source
            or Asset(trustline["asset_code"], trustline["issuer"]).contract_id(
                trustline["network_passphrase"]
            )
            != token_out
        ):
            raise ValueError("Invalid automatic trustline asset")
        trust_args = [scval.to_address(source)]
        calls = [
            scval.to_vec(
                [
                    scval.to_address(token_out),
                    scval.to_symbol("trust"),
                    scval.to_vec(trust_args),
                ]
            ),
            scval.to_vec(
                [
                    scval.to_address(target),
                    scval.to_symbol(function),
                    scval.to_vec(args),
                ]
            ),
        ]
        args = [
            scval.to_vec([scval.to_address(source)]),
            scval.to_vec(calls),
            scval.to_bool(True),
        ]
        root = authorized_invocation(
            batch,
            "batch",
            args,
            [authorized_invocation(token_out, "trust", trust_args), root],
        )
        target, function = batch, "batch"
    host = HostFunction(
        type=HostFunctionType.HOST_FUNCTION_TYPE_INVOKE_CONTRACT,
        invoke_contract=InvokeContractArgs(
            contract_address=Address(target).to_xdr_sc_address(),
            function_name=SCSymbol(function.encode()),
            args=args,
        ),
    )
    return InvokeHostFunction(host, [source_account_entry(root)])


def sell_amount_to_raw(amount: str, decimals: int) -> str:
    """Convert a positive decimal amount exactly, rejecting fractional base units."""
    if (
        type(decimals) is not int
        or not 0 <= decimals <= 38
        or not isinstance(amount, str)
        or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", amount)
    ):
        raise ValueError("Invalid swap quote")
    whole, _, fraction = amount.partition(".")
    if fraction[decimals:].replace("0", ""):
        raise ValueError("Invalid swap quote")
    value = str(int(whole + fraction[:decimals].ljust(decimals, "0")))
    _raw(value)
    return value


_Tx = TypeVar("_Tx")


class SellSwapSimulation(TypedDict):
    tx: Any
    outputs: list[int]


@dataclass
class PreparedSellSwap(Generic[_Tx]):
    tx: _Tx
    plan: SellSwapPlan
    output_amount: str
    minimum_output: str
    leg_outputs: list[str]


def prepare_sell_swap_plans(
    plans: list[SellSwapPlan],
    slippage: str,
    simulate: Callable[[SellSwapPlan, str], SellSwapSimulation],
) -> PreparedSellSwap[Any]:
    """Select by full simulated output; return only a stable bounded transaction.

    The synchronous callback owns full ordered simulation, resource checks,
    fixed-auth verification and current account/network/quote checks. No wallet
    or submission side effects are performed by this selector.
    """
    prepared = []
    baseline_error = None
    for index, plan in enumerate(plans):
        try:
            result = simulate(plan, "0")
            for _ in range(2):
                outputs = result["outputs"]
                if len(outputs) != len(plan.legs) or any(
                    type(v) is not int or v < 0 for v in outputs
                ):
                    raise ValueError("Invalid swap quote")
                output_amount = str(sum(outputs))
                minimum = get_swap_minimum(output_amount, slippage)
                bounded = simulate(plan, minimum)
                bounded_outputs = bounded["outputs"]
                if (
                    len(bounded_outputs) == len(plan.legs)
                    and all(type(v) is int and v >= 0 for v in bounded_outputs)
                    and str(sum(bounded_outputs)) == output_amount
                ):
                    leg_outputs = list(map(str, bounded_outputs))
                    selected_plan = replace(
                        plan,
                        amount_out=output_amount,
                        legs=[
                            replace(leg, amount_out=leg_outputs[i])
                            for i, leg in enumerate(plan.legs)
                        ],
                    )
                    prepared.append(
                        PreparedSellSwap(
                            bounded["tx"],
                            selected_plan,
                            output_amount,
                            minimum,
                            leg_outputs,
                        )
                    )
                    break
                result = bounded
        except Exception as error:
            # Candidate failures are isolated, including resource/restore errors.
            if index == 0:
                baseline_error = error
    prepared.sort(
        key=lambda result: (-int(result.output_amount), len(result.plan.legs))
    )
    if not prepared:
        if baseline_error is not None:
            raise baseline_error
        raise ValueError(
            "The swap quote changed or could not be prepared. Please request a new quote."
        )
    return prepared[0]
