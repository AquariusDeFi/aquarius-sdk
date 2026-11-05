"""Exact-input split swaps through the AMM router's `swap_split`.

Search stays in the API. A caller validates the API's plan, builds the call with
a minimum from its own slippage, simulates it once and checks network resources
before signing. These helpers never sign or submit.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from fractions import Fraction

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
from .errors import NoRouteError

_MAX_AMOUNT = (1 << 127) - 1
_SHARE_DENOMINATOR = 10_000
_MAX_STAGES = 4
_MAX_PARTS = 4
_MAX_HOPS = 4


def _raw(value: str) -> int:
    if (
        not isinstance(value, str)
        or not re.fullmatch(r"[1-9][0-9]*", value)
        or int(value) > _MAX_AMOUNT
    ):
        raise ValueError("Invalid swap quote")
    return int(value)


@dataclass
class SwapSplitPart:
    """One part of a stage: a chain in the `swap_chained` format and its share.

    `share` is in basis points of the stage input; the shares of a stage sum to 10000.
    """

    share: int
    amount_in: str
    amount_out: str
    swap_chain_xdr: str
    pools: list[str]
    tokens_addresses: list[str]
    tokens: list[str]


@dataclass
class SwapSplitPlan:
    """A validated plan for the router's `swap_split`; amounts are raw-unit integer strings."""

    amount_in: str
    amount_out: str
    stages: list[list[SwapSplitPart]]


def _contract(value: SCVal) -> str:
    if value.type != SCValType.SCV_ADDRESS:
        raise ValueError("Invalid route address")
    address = Address.from_xdr_sc_address(value.address).address
    if not StrKey.is_valid_contract(address):
        raise ValueError("Invalid contract")
    return address


def _is_contract(value) -> bool:
    return isinstance(value, str) and StrKey.is_valid_contract(value)


def _chain(part: SwapSplitPart, token_in: str) -> tuple[SCVal, str]:
    """Decode a part's route XDR and check it against the displayed token path.

    The route XDR selects token sets, pool indices and outputs, and the path starts
    at the stage input token. Returns the chain and the token it ends in.
    """
    pools, tokens, encoded = part.pools, part.tokens_addresses, part.swap_chain_xdr
    if (
        not isinstance(pools, list)
        or not 1 <= len(pools) <= _MAX_HOPS
        or not all(_is_contract(p) for p in pools)
        or len(set(pools)) != len(pools)
        or not isinstance(tokens, list)
        or len(tokens) != len(pools) + 1
        or not all(_is_contract(t) for t in tokens)
        or tokens[0] != token_in
        or not isinstance(encoded, str)
        or len(encoded) > 32768
    ):
        raise ValueError("Invalid route")
    # Base64 decoders differ on padding and stray characters; accept only an
    # encoding that round-trips exactly.
    chain = SCVal.from_xdr(encoded)
    if (
        chain.to_xdr() != encoded
        or chain.type != SCValType.SCV_VEC
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
            len(set(addresses)) != len(addresses)
            or tokens[i] not in addresses
            or tokens[i + 1] not in addresses
            or tokens[i] == tokens[i + 1]
        ):
            raise ValueError("Invalid pool tokens")
        key = (tuple(addresses), index.bytes.sc_bytes)
        if key in used:
            raise ValueError("Repeated pool")
        used.add(key)
    return chain, tokens[-1]


def _stages(plan: SwapSplitPlan, token_in: str, token_out: str) -> SCVal:
    """The `stages` argument of `swap_split`, encoded from the readable chains.

    The chains are checked as the router runs them: stage by stage from `token_in`,
    all chains of a stage ending in the next stage's input token and the last
    stage in `token_out`. Every part's input must be the router's allocation of the
    stage input, and the parts' outputs make the next stage's input.
    """
    try:
        stages = plan.stages
        if (
            not _is_contract(token_in)
            or not _is_contract(token_out)
            or token_in == token_out
            or not isinstance(stages, list)
            or not 1 <= len(stages) <= _MAX_STAGES
        ):
            raise ValueError("Invalid stages")
        stage_token, stage_amount = token_in, _raw(plan.amount_in)
        encoded = []
        for parts in stages:
            if not isinstance(parts, list) or not 1 <= len(parts) <= _MAX_PARTS:
                raise ValueError("Invalid stage")
            shares, allocated, output, stage_end, values = 0, 0, 0, None, []
            for index, part in enumerate(parts):
                share = part.share
                if type(share) is not int or share < 1:
                    raise ValueError("Invalid share")
                shares += share
                # Every part but the last gets floor(stage input * share / 10000);
                # the last part takes the rest.
                if index == len(parts) - 1:
                    amount = stage_amount - allocated
                else:
                    amount = stage_amount * share // _SHARE_DENOMINATOR
                if _raw(part.amount_in) != amount:
                    raise ValueError("Invalid allocation")
                allocated += amount
                output += _raw(part.amount_out)
                chain, end = _chain(part, stage_token)
                if stage_end is not None and end != stage_end:
                    raise ValueError("Stage chains end in different tokens")
                stage_end = end
                values.append(scval.to_vec([chain, scval.to_uint32(share)]))
            if shares != _SHARE_DENOMINATOR:
                raise ValueError("Invalid shares")
            stage_token, stage_amount = stage_end, output
            encoded.append(scval.to_vec(values))
        if stage_token != token_out or stage_amount != _raw(plan.amount_out):
            raise ValueError("Invalid plan output")
        return scval.to_vec(encoded)
    except Exception as error:
        raise ValueError("Invalid swap quote") from error


def _list(value) -> list:
    if not isinstance(value, list):
        raise ValueError("Invalid swap quote")
    return list(value)


def _read_part(part: dict) -> SwapSplitPart:
    return SwapSplitPart(
        part["share"],
        part["amount_in"],
        part["amount_out"],
        part["swap_chain_xdr"],
        _list(part["pools"]),
        _list(part["tokens_addresses"]),
        list(part["tokens"]) if isinstance(part.get("tokens"), list) else [],
    )


def normalize_swap_split_plan(
    response: dict, token_in: str, token_out: str, amount_in: str
) -> SwapSplitPlan:
    """The plan of a `find_path_split` response for the requested exact input.

    Raises NoRouteError when the API found no route, and ValueError("Invalid swap
    quote") when the plan does not match the request or the router's execution, or
    `stages_xdr` is not the encoding of the readable stages.
    """
    if isinstance(response, dict) and response.get("success") is False:
        raise NoRouteError("No route found")
    try:
        if (
            response.get("success") is not True
            or response.get("amount_in") != amount_in
            or not isinstance(response.get("stages"), list)
        ):
            raise ValueError("Invalid swap quote")
        plan = SwapSplitPlan(
            amount_in,
            response.get("amount_out"),
            [
                [_read_part(part) for part in _list(parts)]
                for parts in response["stages"]
            ],
        )
        # The call is built from the readable chains; the API's encoding of them
        # must be the same bytes.
        if _stages(plan, token_in, token_out).to_xdr() != response.get("stages_xdr"):
            raise ValueError("Invalid swap quote")
        return plan
    except Exception as error:
        raise ValueError("Invalid swap quote") from error


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


def get_swap_split_result(result: SCVal, with_trustline: bool = False) -> int:
    """The total output from the return value of a simulated or executed `swap_split`.

    With a trustline, the batch returns one value per call: void for the trust call,
    then the swap's output.
    """
    if with_trustline:
        if (
            result.type != SCValType.SCV_VEC
            or result.vec is None
            or len(result.vec.sc_vec) != 2
            or result.vec.sc_vec[0].type != SCValType.SCV_VOID
        ):
            raise ValueError(
                "Unexpected swap result. Check the transaction in the explorer."
            )
        result = result.vec.sc_vec[1]
    if result.type != SCValType.SCV_U128:
        raise ValueError(
            "Unexpected swap result. Check the transaction in the explorer."
        )
    return scval.from_uint128(result)


def build_swap_split_operation(
    *,
    source: str,
    router: str,
    token_in: str,
    token_out: str,
    plan: SwapSplitPlan,
    minimum: str,
    batch: str | None = None,
    trustline: dict | None = None,
) -> InvokeHostFunction:
    """`router.swap_split` with its authorization: the call with all its arguments
    and the one input transfer.

    Checks the plan again before encoding it. `trustline` requires `batch` and
    asset_code, issuer, network_passphrase of the classic output asset. Does not
    simulate, sign or submit.
    """
    if not StrKey.is_valid_ed25519_public_key(source) or not _is_contract(router):
        raise ValueError("Invalid swap addresses")
    stages = _stages(plan, token_in, token_out)
    if (
        not isinstance(minimum, str)
        or not re.fullmatch(r"[0-9]+", minimum)
        or int(minimum) > _MAX_AMOUNT
    ):
        raise ValueError("Invalid swap minimum")
    args = [
        scval.to_address(source),
        stages,
        scval.to_address(token_in),
        scval.to_address(token_out),
        scval.to_uint128(int(plan.amount_in)),
        scval.to_uint128(int(minimum)),
    ]
    transfer = authorized_invocation(
        token_in,
        "transfer",
        [
            scval.to_address(source),
            scval.to_address(router),
            scval.to_int128(int(plan.amount_in)),
        ],
    )
    root = authorized_invocation(router, "swap_split", args, [transfer])
    target, function = router, "swap_split"
    if trustline is not None:
        if (
            not batch
            or not _is_contract(batch)
            or not isinstance(trustline, dict)
            or any(
                not isinstance(trustline.get(key), str)
                for key in ("asset_code", "issuer", "network_passphrase")
            )
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
                    scval.to_address(router),
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
