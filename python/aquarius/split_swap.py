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
_U128_MAX = (1 << 128) - 1
_SHARE_DENOMINATOR = 10_000
_MAX_STAGES = 4
_MAX_PARTS = 4
_MAX_HOPS = 4
_MAX_CHAIN_XDR_LENGTH = 32768
# Canonical padded base64; decoders differ on everything else.
_BASE64 = re.compile(r"(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")


class _SwapError(ValueError):
    """Every error this module raises on purpose; the catch-alls keep its reason."""


def _ensure(ok, reason: str) -> None:
    """A quote the SDK will not build from; the reason names the failed check."""
    if not ok:
        raise _SwapError(f"Invalid swap quote: {reason}")


def _ensure_swap(ok, reason: str) -> None:
    """An argument the SDK will not build with."""
    if not ok:
        raise _SwapError(f"Invalid swap: {reason}")


def _malformed() -> _SwapError:
    return _SwapError("Invalid swap quote: the plan is malformed")


def _is_contract(value) -> bool:
    return isinstance(value, str) and StrKey.is_valid_contract(value)


def _parse_amount(value) -> int | None:
    """A canonical integer from 1 to 2^127 - 1 (a token amount), or None."""
    if (
        isinstance(value, str)
        and re.fullmatch(r"[1-9][0-9]*", value)
        and int(value) <= _MAX_AMOUNT
    ):
        return int(value)
    return None


def _quote_amount(value, label: str) -> int:
    parsed = _parse_amount(value)
    _ensure(parsed is not None, f"{label} is not an integer from 1 to 2^127 - 1")
    return parsed


def _share(value):
    """A share as an int, or None: JSON numbers such as 10000.0 or 1e4 are 10000."""
    if type(value) is int:
        return value
    if type(value) is float and value.is_integer():
        return int(value)
    return None


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
    _ensure(value.type == SCValType.SCV_ADDRESS, "a hop token is not an address")
    try:
        address = Address.from_xdr_sc_address(value.address).address
    except Exception:
        # An address type the SDK cannot print is not a contract either.
        address = ""
    _ensure(_is_contract(address), "a hop token is not a contract")
    return address


def _decode(encoded: str) -> SCVal | None:
    try:
        return SCVal.from_xdr(encoded)
    except Exception:
        return None


def _chain(part: SwapSplitPart, token_in: str) -> tuple[SCVal, str]:
    """Decode a part's route XDR and check it against the displayed token path.

    The route XDR selects token sets, pool indices and outputs, and the path starts
    at the stage input token. Returns the chain and the token it ends in.
    """
    pools, tokens, encoded = part.pools, part.tokens_addresses, part.swap_chain_xdr
    _ensure(isinstance(pools, list), "pools are not a list")
    _ensure(len(pools) > 0, "a chain has no hops")
    _ensure(len(pools) <= _MAX_HOPS, f"a chain has more than {_MAX_HOPS} hops")
    _ensure(all(_is_contract(pool) for pool in pools), "a pool is not a contract")
    _ensure(len(set(pools)) == len(pools), "a chain lists a pool twice")
    _ensure(isinstance(tokens, list), "tokens_addresses are not a list")
    _ensure(len(tokens) == len(pools) + 1, "tokens_addresses do not match the pools")
    _ensure(
        all(_is_contract(token) for token in tokens),
        "a token address is not a contract",
    )
    _ensure(tokens[0] == token_in, "a chain does not start at its stage input")
    _ensure(isinstance(encoded, str), "swap_chain_xdr is not a string")
    _ensure(len(encoded) <= _MAX_CHAIN_XDR_LENGTH, "swap_chain_xdr is too long")
    _ensure(_BASE64.fullmatch(encoded), "swap_chain_xdr is not base64")
    chain = _decode(encoded)
    _ensure(chain is not None, "swap_chain_xdr does not decode")
    _ensure(chain.to_xdr() == encoded, "swap_chain_xdr is not canonical")
    _ensure(chain.type == SCValType.SCV_VEC, "swap_chain_xdr is not a list of hops")
    hops = chain.vec.sc_vec if chain.vec is not None else []
    _ensure(len(hops) == len(pools), "swap_chain_xdr does not have one hop per pool")
    used = set()
    for i, hop in enumerate(hops):
        fields = (
            hop.vec.sc_vec
            if hop.type == SCValType.SCV_VEC and hop.vec is not None
            else []
        )
        _ensure(len(fields) == 3, "a hop is not a triple")
        pool_tokens, index, output = fields
        _ensure(
            pool_tokens.type == SCValType.SCV_VEC, "a hop's pool tokens are not a list"
        )
        _ensure(index.type == SCValType.SCV_BYTES, "a hop's pool index is not bytes")
        index_bytes = index.bytes.sc_bytes
        _ensure(len(index_bytes) == 32, "a hop's pool index is not 32 bytes")
        _ensure(
            _contract(output) == tokens[i + 1],
            "a hop's output is not the next token of the path",
        )
        values = pool_tokens.vec.sc_vec if pool_tokens.vec is not None else []
        addresses = [_contract(value) for value in values]
        _ensure(len(set(addresses)) == len(addresses), "a hop's pool tokens repeat")
        _ensure(tokens[i] in addresses, "a hop's pool does not hold its input")
        _ensure(tokens[i + 1] in addresses, "a hop's pool does not hold its output")
        _ensure(
            tokens[i] != tokens[i + 1], "a hop's input and output are the same token"
        )
        key = (tuple(addresses), index_bytes)
        _ensure(key not in used, "a chain uses a pool twice")
        used.add(key)
    return chain, tokens[-1]


def _stages(plan: SwapSplitPlan, token_in: str, token_out: str) -> SCVal:
    """The `stages` argument of `swap_split`, encoded from the readable chains.

    The chains are checked as the router runs them: stage by stage from `token_in`,
    all chains of a stage ending in the next stage's input token and the last
    stage in `token_out`. Every part's input must be the router's allocation of the
    stage input, and the parts' outputs make the next stage's input, which the
    router adds up in a u128.
    """
    try:
        _ensure(_is_contract(token_in), "token_in is not a contract")
        _ensure(_is_contract(token_out), "token_out is not a contract")
        _ensure(token_in != token_out, "token_in and token_out are the same")
        stage_amount = _quote_amount(plan.amount_in, "amount_in")
        stage_token = token_in
        stages = plan.stages
        _ensure(isinstance(stages, list), "stages are not a list")
        _ensure(len(stages) > 0, "the plan has no stages")
        _ensure(
            len(stages) <= _MAX_STAGES, f"the plan has more than {_MAX_STAGES} stages"
        )
        encoded = []
        for parts in stages:
            _ensure(isinstance(parts, list), "a stage is not a list")
            _ensure(len(parts) > 0, "a stage has no parts")
            _ensure(
                len(parts) <= _MAX_PARTS, f"a stage has more than {_MAX_PARTS} parts"
            )
            shares, allocated, output, stage_end, values = 0, 0, 0, None, []
            for index, part in enumerate(parts):
                _ensure(isinstance(part, SwapSplitPart), "a part is not an object")
                share = _share(part.share)
                _ensure(
                    share is not None and 1 <= share <= _SHARE_DENOMINATOR,
                    f"a share is not an integer from 1 to {_SHARE_DENOMINATOR}",
                )
                shares += share
                # Every part but the last gets floor(stage input * share / 10000);
                # the last part takes the rest.
                if index == len(parts) - 1:
                    amount = stage_amount - allocated
                else:
                    amount = stage_amount * share // _SHARE_DENOMINATOR
                _ensure(
                    _quote_amount(part.amount_in, "a part's amount_in") == amount,
                    "a part's amount_in is not the router's allocation",
                )
                allocated += amount
                output += _quote_amount(part.amount_out, "a part's amount_out")
                chain, end = _chain(part, stage_token)
                # As in the router, the first chain sets the token the stage ends in.
                if stage_end is None:
                    stage_end = end
                _ensure(
                    end == stage_end, "the chains of a stage end in different tokens"
                )
                values.append(scval.to_vec([chain, scval.to_uint32(share)]))
            _ensure(
                shares == _SHARE_DENOMINATOR,
                f"the shares of a stage do not sum to {_SHARE_DENOMINATOR}",
            )
            _ensure(output <= _U128_MAX, "a stage's output does not fit in u128")
            stage_token, stage_amount = stage_end, output
            encoded.append(scval.to_vec(values))
        _ensure(stage_token == token_out, "the last stage does not end at token_out")
        _ensure(
            stage_amount == _quote_amount(plan.amount_out, "amount_out"),
            "amount_out is not the output of the last stage",
        )
        return scval.to_vec(encoded)
    except _SwapError:
        raise
    except Exception as error:
        raise _malformed() from error


def _copied(value):
    return list(value) if isinstance(value, list) else value


def _read_part(part):
    """The response's part in SDK form; `_stages` checks it."""
    if not isinstance(part, dict):
        return part
    share = part.get("share")
    return SwapSplitPart(
        share if _share(share) is None else _share(share),
        part.get("amount_in"),
        part.get("amount_out"),
        part.get("swap_chain_xdr"),
        _copied(part.get("pools")),
        _copied(part.get("tokens_addresses")),
        list(part["tokens"]) if isinstance(part.get("tokens"), list) else [],
    )


def normalize_swap_split_plan(
    response: dict, token_in: str, token_out: str, amount_in: str
) -> SwapSplitPlan:
    """The plan of a `find_path_split` response for the requested exact input.

    Raises NoRouteError when the API found no route, and ValueError("Invalid swap
    quote: <reason>") naming the failed check when the plan does not match the
    request or the router's execution of it, or `stages_xdr` is not the encoding
    of the readable stages.
    """
    if isinstance(response, dict) and response.get("success") is False:
        raise NoRouteError("No route found")
    try:
        _ensure(isinstance(response, dict), "the response is not an object")
        _ensure(response.get("success") is True, "success is not true")
        _ensure(
            response.get("amount_in") == amount_in,
            "amount_in is not the requested amount",
        )
        stages = response.get("stages")
        plan = SwapSplitPlan(
            amount_in,
            response.get("amount_out"),
            [
                [_read_part(part) for part in parts]
                if isinstance(parts, list)
                else parts
                for parts in stages
            ]
            if isinstance(stages, list)
            else stages,
        )
        # The call is built from the readable chains; the API's encoding of them
        # must be the same bytes.
        _ensure(
            _stages(plan, token_in, token_out).to_xdr() == response.get("stages_xdr"),
            "stages_xdr is not the encoding of the stages",
        )
        return plan
    except _SwapError:
        raise
    except Exception as error:
        raise _malformed() from error


def get_swap_minimum(output: str, slippage: str) -> str:
    _ensure_swap(
        isinstance(slippage, str)
        and len(slippage) <= 100
        and re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", slippage),
        "the slippage is not a decimal percentage",
    )
    tolerance = Fraction(slippage)
    _ensure_swap(tolerance <= 10, "the slippage is above 10%")
    quoted = _parse_amount(output)
    _ensure_swap(quoted is not None, "the output is not an integer from 1 to 2^127 - 1")
    return str(
        quoted * (100 - tolerance).numerator // ((100 - tolerance).denominator * 100)
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


def _asset_contract(trustline: dict) -> str | None:
    try:
        return Asset(trustline["asset_code"], trustline["issuer"]).contract_id(
            trustline["network_passphrase"]
        )
    except Exception:
        return None


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
    _ensure_swap(
        isinstance(source, str) and StrKey.is_valid_ed25519_public_key(source),
        "source is not an account",
    )
    _ensure_swap(_is_contract(router), "router is not a contract")
    stages = _stages(plan, token_in, token_out)
    _ensure_swap(
        isinstance(minimum, str) and re.fullmatch(r"[0-9]+", minimum),
        "minimum is not a non-negative integer string",
    )
    _ensure_swap(int(minimum) <= _MAX_AMOUNT, "minimum is above 2^127 - 1")
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
        _ensure_swap(_is_contract(batch), "batch is not a contract")
        _ensure_swap(
            isinstance(trustline, dict)
            and all(
                isinstance(trustline.get(key), str)
                for key in ("asset_code", "issuer", "network_passphrase")
            ),
            "trustline is not an asset code, issuer and network passphrase",
        )
        _ensure_swap(
            trustline["issuer"] != source,
            "the trustline asset is issued by the source",
        )
        _ensure_swap(
            _asset_contract(trustline) == token_out,
            "the trustline asset is not token_out",
        )
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
    _ensure_swap(
        type(decimals) is int and 0 <= decimals <= 38,
        "decimals is not an integer from 0 to 38",
    )
    _ensure_swap(
        isinstance(amount, str) and re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", amount),
        "the amount is not a decimal number",
    )
    whole, _, fraction = amount.partition(".")
    _ensure_swap(
        not fraction[decimals:].replace("0", ""),
        "the amount has more decimal places than the token",
    )
    value = str(int(whole + fraction[:decimals].ljust(decimals, "0")))
    _ensure_swap(
        _parse_amount(value) is not None,
        "the amount is not an integer from 1 to 2^127 - 1",
    )
    return value
