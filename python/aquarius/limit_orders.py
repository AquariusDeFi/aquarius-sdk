from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from stellar_sdk import Address, Network, scval, xdr
from stellar_sdk.xdr import SCVal, TransactionEnvelope

from .errors import AquariusError

if TYPE_CHECKING:
    from .client import AquariusClient


_ORDER_FIELDS = {
    "buy_token",
    "executor_reward_xlm",
    "expires_at_ledger",
    "maker",
    "min_buy_amount",
    "placement_mode",
    "salt",
    "sell_amount",
    "sell_token",
    "valid_after_ledger",
    "version",
}


def _contract_address(value: str, name: str) -> str:
    try:
        Address(value)
    except Exception as exc:
        raise AquariusError(
            f"limit-order {name} must be a valid contract address"
        ) from exc
    if not value.startswith("C"):
        raise AquariusError(f"limit-order {name} must be a contract address")
    return value


@dataclass(frozen=True)
class LimitOrderConfig:
    """Trusted deployment coordinates for limit-order operations."""

    settlement: str
    batcher: str | None = None
    api_url: str | None = None

    def __post_init__(self):
        object.__setattr__(
            self, "settlement", _contract_address(self.settlement, "settlement")
        )
        if self.batcher is not None:
            object.__setattr__(
                self, "batcher", _contract_address(self.batcher, "batcher")
            )
        if self.api_url is not None and not self.api_url:
            raise AquariusError("limit-order api_url must be non-empty")


@dataclass(frozen=True)
class OnchainLimitOrderReceipt:
    order_id: str
    tx_hash: str


@dataclass(frozen=True)
class LimitOrder:
    version: int
    placement_mode: str
    salt: bytes
    maker: str
    sell_token: str
    sell_amount: int
    buy_token: str
    min_buy_amount: int
    valid_after_ledger: int
    expires_at_ledger: int
    executor_reward_xlm: int
    order_scval: SCVal = field(repr=False)

    def required_router_min(self, xlm_token: str) -> int:
        if self.buy_token == xlm_token:
            return self.min_buy_amount + self.executor_reward_xlm
        return self.min_buy_amount


@dataclass(frozen=True)
class LimitOrderFillReceipt:
    order_id: str
    router_output: int
    maker_buy_delta_before_reward: int
    reward_xlm: int
    reward_to: str


@dataclass(frozen=True)
class LimitOrderFillResult:
    tx_hash: str
    order: "LimitOrderRecord"
    receipt: LimitOrderFillReceipt


@dataclass(frozen=True)
class PreparedLimitOrderFill:
    order: "LimitOrderRecord"
    receipt: LimitOrderFillReceipt
    maximum_fee: int
    transaction_xdr: str
    _transaction: TransactionEnvelope = field(repr=False, compare=False)
    _client: "AquariusClient" = field(repr=False, compare=False)

    def execute(self) -> LimitOrderFillResult:
        signer = self._client._require_signer()
        result = self._client.engine.sign_and_submit(self._transaction, signer)
        receipt = validate_fill_receipt(self.order, self.receipt.reward_to, result.return_value)
        return LimitOrderFillResult(result.tx_hash, self.order, receipt)


@dataclass(frozen=True)
class LimitOrderRecord:
    order_id: str
    status: str
    order: LimitOrder
    authorization: xdr.SorobanAuthorizationEntry | None
    settlement_address: str
    network_id: str
    placement_ledger: int | None = None
    placement_transaction_hash: str | None = None
    _raw: dict = field(default_factory=dict, repr=False, compare=False)
    _client: "AquariusClient | None" = field(default=None, repr=False, compare=False)

    def prepare_fill(
        self, swap_chain_xdr: str, *, reward_to: str | None = None
    ) -> PreparedLimitOrderFill:
        return self._bound_client()._prepare_limit_order_fill(
            self, swap_chain_xdr, reward_to=reward_to
        )

    def build_cancel_transaction(self) -> str:
        return self._bound_client()._build_limit_order_cancel(self)

    def cancel(self) -> OnchainLimitOrderReceipt:
        return self._bound_client()._cancel_limit_order(self)

    @property
    def raw(self) -> dict:
        return dict(self._raw)

    def _bound_client(self) -> "AquariusClient":
        if self._client is None:
            raise AquariusError("limit-order record is not bound to an AquariusClient")
        return self._client


@dataclass(frozen=True)
class LimitOrderPage:
    orders: list[LimitOrderRecord]
    next_cursor: str | None


@dataclass(frozen=True)
class OnchainLimitOrder:
    order_id: str
    settlement_address: str
    maker: str
    sell_token: str
    sell_amount: int
    buy_token: str
    min_buy_amount: int
    valid_after_ledger: int
    expires_at_ledger: int
    allowance_expiration_ledger: int
    executor_reward_xlm: int
    order_scval: xdr.SCVal = field(repr=False)
    _client: AquariusClient | None = field(default=None, repr=False)

    def required_allowances(self, xlm_token: str) -> dict[str, int]:
        if self.sell_token == xlm_token:
            return {xlm_token: self.sell_amount + self.executor_reward_xlm}
        return {
            self.sell_token: self.sell_amount,
            xlm_token: self.executor_reward_xlm,
        }

    def build_transaction(self) -> str:
        """Simulate and assemble the unsigned batcher placement transaction."""
        return self._bound_client()._build_onchain_limit_order(self)

    def place(self) -> OnchainLimitOrderReceipt:
        """Build, sign, submit, and confirm approve(s) plus placement."""
        return self._bound_client()._place_onchain_limit_order(self)

    def build_cancel_transaction(self) -> str:
        """Simulate and assemble an unsigned settlement cancellation."""
        return self._bound_client()._build_onchain_limit_order_cancel(self)

    def cancel(self) -> OnchainLimitOrderReceipt:
        """Build, sign, submit, and confirm settlement cancellation."""
        return self._bound_client()._cancel_onchain_limit_order(self)

    def _bound_client(self) -> AquariusClient:
        if self._client is None:
            raise AquariusError("limit order is not bound to an AquariusClient")
        return self._client


def validate_onchain_limit_order_draft(
    payload: dict,
    *,
    expected_network_passphrase: str,
    expected_settlement: str,
    expected_maker: str,
    expected_order: dict,
    allowance_expiration_ledger: int,
    client: AquariusClient | None = None,
) -> OnchainLimitOrder:
    """Validate the registry JSON against its canonical OrderV1 ScVal."""
    try:
        order_scval = xdr.SCVal.from_xdr(payload["order_xdr"])
        order_id = hashlib.sha256(order_scval.to_xdr_bytes()).hexdigest()
    except Exception as exc:
        raise AquariusError(
            "order registry returned invalid canonical order XDR"
        ) from exc
    if order_id != payload.get("order_id"):
        raise AquariusError(
            "order registry returned an order ID that does not match its XDR"
        )

    _limit_order_from_scval(order_scval)

    try:
        native = scval.to_native(order_scval)
        if not isinstance(native, dict) or set(native) != _ORDER_FIELDS:
            raise AquariusError("order registry returned a non-canonical OrderV1")
        for address_field in ("maker", "sell_token", "buy_token"):
            address = native[address_field]
            if not isinstance(address, Address):
                raise AquariusError("order registry returned a non-canonical OrderV1")
            native[address_field] = address.address
        projection = {
            "version": payload.get("version"),
            "placement_mode": ["ContractOnChain"],
            "salt": bytes.fromhex(payload.get("salt", "")),
            "maker": payload.get("maker"),
            "sell_token": payload.get("sell_token"),
            "sell_amount": int(payload.get("sell_amount", -1)),
            "buy_token": payload.get("buy_token"),
            "min_buy_amount": int(payload.get("min_buy_amount", -1)),
            "valid_after_ledger": payload.get("valid_after_ledger"),
            "expires_at_ledger": payload.get("expires_at_ledger"),
            "executor_reward_xlm": int(payload.get("executor_reward_xlm", -1)),
        }
    except AquariusError:
        raise
    except (TypeError, ValueError) as exc:
        raise AquariusError(
            "order registry JSON does not match its canonical order XDR"
        ) from exc
    if native != projection:
        raise AquariusError(
            "order registry JSON does not match its canonical order XDR"
        )

    expected_network_id = Network(expected_network_passphrase).network_id().hex()
    if (
        payload.get("status") != "AWAITING_PLACEMENT"
        or payload.get("placement_mode") != "CONTRACT_ONCHAIN"
        or payload.get("network_id") != expected_network_id
        or payload.get("settlement_address") != expected_settlement
        or payload.get("maker") != expected_maker
        or "authorization_xdr" in payload
        or "unsigned_authorization_xdr" in payload
    ):
        raise AquariusError(
            "order registry returned a draft for another execution context"
        )
    for name, expected in expected_order.items():
        actual = projection[name]
        if actual != expected:
            raise AquariusError(f"order registry changed requested field {name}")
    if (
        not isinstance(allowance_expiration_ledger, int)
        or not projection["expires_at_ledger"]
        <= allowance_expiration_ledger
        <= 2**32 - 1
    ):
        raise AquariusError(
            "allowance expiration must be a u32 ledger at or after order expiration"
        )

    return OnchainLimitOrder(
        order_id=order_id,
        settlement_address=expected_settlement,
        maker=expected_maker,
        sell_token=projection["sell_token"],
        sell_amount=projection["sell_amount"],
        buy_token=projection["buy_token"],
        min_buy_amount=projection["min_buy_amount"],
        valid_after_ledger=projection["valid_after_ledger"],
        expires_at_ledger=projection["expires_at_ledger"],
        allowance_expiration_ledger=allowance_expiration_ledger,
        executor_reward_xlm=projection["executor_reward_xlm"],
        order_scval=order_scval,
        _client=client,
    )


def build_onchain_placement_args(
    order: OnchainLimitOrder,
    current_allowances: dict[str, int],
    xlm_token: str,
) -> list[xdr.SCVal]:
    """Encode batch(auth_users, approve(s)+place, false).

    Approvals are absolute and never reduce the observed allowance. The caller
    supplies the expiration explicitly because SEP-41 allowance() does not
    expose the existing expiration ledger.
    """
    calls = []
    for token, required in order.required_allowances(xlm_token).items():
        current = current_allowances.get(token, 0)
        if current < 0:
            raise AquariusError("token allowance cannot be negative")
        amount = max(current, required)
        if amount > 2**127 - 1:
            raise AquariusError("required token allowance does not fit i128")
        calls.append(
            scval.to_vec(
                [
                    scval.to_address(token),
                    scval.to_symbol("approve"),
                    scval.to_vec(
                        [
                            scval.to_address(order.maker),
                            scval.to_address(order.settlement_address),
                            scval.to_int128(amount),
                            scval.to_uint32(order.allowance_expiration_ledger),
                        ]
                    ),
                ]
            )
        )
    calls.append(
        scval.to_vec(
            [
                scval.to_address(order.settlement_address),
                scval.to_symbol("place_contract_order"),
                scval.to_vec(
                    [
                        scval.to_address(order.maker),
                        scval.to_bytes(bytes.fromhex(order.order_id)),
                        scval.to_uint32(order.expires_at_ledger),
                    ]
                ),
            ]
        )
    )
    return [
        scval.to_vec([scval.to_address(order.maker)]),
        scval.to_vec(calls),
        scval.to_bool(False),
    ]


def parse_limit_order_record(
    payload: dict,
    *,
    network_passphrase: str,
    settlement_address: str,
    xlm_token: str,
    client: AquariusClient | None = None,
) -> LimitOrderRecord:
    """Validate one public registry record against its canonical OrderV1 XDR."""
    if payload.get("status") not in {"OPEN", "FILLED", "CANCELLED", "EXPIRED"}:
        raise AquariusError("limit-order registry returned a non-public status")
    if payload.get("settlement_address") != settlement_address:
        raise AquariusError("limit order targets another settlement contract")
    expected_network_id = Network(network_passphrase).network_id().hex()
    if payload.get("network_id") != expected_network_id:
        raise AquariusError("limit order targets another network")

    try:
        order_scval = SCVal.from_xdr(payload["order_xdr"])
        order = _limit_order_from_scval(order_scval)
        projection = {
            "version": int(payload["version"]),
            "placement_mode": str(payload["placement_mode"]),
            "salt": bytes.fromhex(payload["salt"]),
            "maker": str(payload["maker"]),
            "sell_token": str(payload["sell_token"]),
            "sell_amount": int(payload["sell_amount"]),
            "buy_token": str(payload["buy_token"]),
            "min_buy_amount": int(payload["min_buy_amount"]),
            "valid_after_ledger": int(payload["valid_after_ledger"]),
            "expires_at_ledger": int(payload["expires_at_ledger"]),
            "executor_reward_xlm": int(payload["executor_reward_xlm"]),
        }
    except AquariusError:
        raise
    except (KeyError, TypeError, ValueError) as exc:
        raise AquariusError(
            "limit-order registry JSON does not match canonical order XDR"
        ) from exc
    expected = {
        "version": order.version,
        "placement_mode": order.placement_mode,
        "salt": order.salt,
        "maker": order.maker,
        "sell_token": order.sell_token,
        "sell_amount": order.sell_amount,
        "buy_token": order.buy_token,
        "min_buy_amount": order.min_buy_amount,
        "valid_after_ledger": order.valid_after_ledger,
        "expires_at_ledger": order.expires_at_ledger,
        "executor_reward_xlm": order.executor_reward_xlm,
    }
    if projection != expected or order.order_scval.to_xdr_bytes() != order_scval.to_xdr_bytes():
        raise AquariusError(
            "limit-order registry JSON does not match canonical order XDR"
        )
    order_id = hashlib.sha256(order_scval.to_xdr_bytes()).hexdigest()
    if payload.get("order_id") != order_id:
        raise AquariusError("limit-order ID does not match canonical order XDR")

    authorization = None
    authorization_xdr = payload.get("authorization_xdr")
    placement_ledger = payload.get("placement_ledger")
    placement_hash = payload.get("placement_transaction_hash")
    if order.placement_mode == "DETACHED":
        if payload["status"] == "OPEN" and not authorization_xdr:
            raise AquariusError("open detached limit order has no authorization")
        if authorization_xdr:
            try:
                authorization = xdr.SorobanAuthorizationEntry.from_xdr(
                    authorization_xdr
                )
            except Exception as exc:
                raise AquariusError(
                    "detached limit order has invalid authorization XDR"
                ) from exc
            validate_authorization_tree(
                authorization,
                order=order,
                settlement_address=settlement_address,
                xlm_token=xlm_token,
            )
    elif authorization_xdr not in (None, ""):
        raise AquariusError(
            "contract-on-chain order includes detached authorization"
        )
    elif (
        not isinstance(placement_ledger, int)
        or placement_ledger <= 0
        or not isinstance(placement_hash, str)
        or len(placement_hash) != 64
    ):
        raise AquariusError(
            "contract-on-chain order has no confirmed placement reference"
        )
    else:
        try:
            bytes.fromhex(placement_hash)
        except ValueError as exc:
            raise AquariusError(
                "contract-on-chain placement transaction hash is not hex"
            ) from exc

    return LimitOrderRecord(
        order_id=order_id,
        status=payload["status"],
        order=order,
        authorization=authorization,
        settlement_address=settlement_address,
        network_id=expected_network_id,
        placement_ledger=placement_ledger,
        placement_transaction_hash=placement_hash,
        _raw=dict(payload),
        _client=client,
    )


def _limit_order_from_scval(value: SCVal) -> LimitOrder:
    types = {
        "buy_token": xdr.SCValType.SCV_ADDRESS,
        "executor_reward_xlm": xdr.SCValType.SCV_U128,
        "expires_at_ledger": xdr.SCValType.SCV_U32,
        "maker": xdr.SCValType.SCV_ADDRESS,
        "min_buy_amount": xdr.SCValType.SCV_U128,
        "placement_mode": xdr.SCValType.SCV_VEC,
        "salt": xdr.SCValType.SCV_BYTES,
        "sell_amount": xdr.SCValType.SCV_U128,
        "sell_token": xdr.SCValType.SCV_ADDRESS,
        "valid_after_ledger": xdr.SCValType.SCV_U32,
        "version": xdr.SCValType.SCV_U32,
    }
    entries = value.map.sc_map if value.type == xdr.SCValType.SCV_MAP and value.map is not None else []
    if len(entries) != len(types):
        raise AquariusError("limit order is not a canonical OrderV1")
    for entry, (name, kind) in zip(entries, types.items()):
        if entry.key.type != xdr.SCValType.SCV_SYMBOL or scval.from_symbol(entry.key) != name or entry.val.type != kind:
            raise AquariusError("limit order is not a canonical OrderV1")
        if name == "placement_mode" and (
            entry.val.vec is None or len(entry.val.vec.sc_vec) != 1
            or entry.val.vec.sc_vec[0].type != xdr.SCValType.SCV_SYMBOL
        ):
            raise AquariusError("limit order is not a canonical OrderV1")
    try:
        native = scval.to_native(value)
        if not isinstance(native, dict) or set(native) != _ORDER_FIELDS:
            raise AquariusError("limit order is not a canonical OrderV1")

        def address(field: str) -> str:
            parsed = native[field]
            if not isinstance(parsed, Address):
                raise AquariusError(f"limit-order {field} must be an address")
            return parsed.address

        placement = native["placement_mode"]
        if placement == ["Detached"]:
            placement_mode = "DETACHED"
        elif placement == ["ContractOnChain"]:
            placement_mode = "CONTRACT_ONCHAIN"
        else:
            raise AquariusError("limit order has an unsupported placement mode")
        order = LimitOrder(
            version=int(native["version"]),
            placement_mode=placement_mode,
            salt=bytes(native["salt"]),
            maker=address("maker"),
            sell_token=address("sell_token"),
            sell_amount=int(native["sell_amount"]),
            buy_token=address("buy_token"),
            min_buy_amount=int(native["min_buy_amount"]),
            valid_after_ledger=int(native["valid_after_ledger"]),
            expires_at_ledger=int(native["expires_at_ledger"]),
            executor_reward_xlm=int(native["executor_reward_xlm"]),
            order_scval=value,
        )
    except AquariusError:
        raise
    except (KeyError, TypeError, ValueError) as exc:
        raise AquariusError("limit order is not a canonical OrderV1") from exc
    _validate_limit_order(order)
    return order


def _validate_limit_order(order: LimitOrder) -> None:
    if order.version != 1:
        raise AquariusError("unsupported limit-order version")
    if order.placement_mode == "DETACHED" and not order.maker.startswith("G"):
        raise AquariusError("detached orders require a G-account maker")
    if len(order.salt) != 32:
        raise AquariusError("limit-order salt must be 32 bytes")
    if order.sell_token == order.buy_token:
        raise AquariusError("limit-order sell and buy tokens must differ")
    amounts = (
        order.sell_amount,
        order.min_buy_amount,
        order.executor_reward_xlm,
    )
    if min(amounts) <= 0 or max(amounts) > 2**127 - 1:
        raise AquariusError("limit-order amounts must fit positive i128 values")
    if not (
        0
        <= order.valid_after_ledger
        <= order.expires_at_ledger
        <= 2**32 - 1
    ):
        raise AquariusError("limit order has an invalid ledger window")


def validate_authorization_tree(
    entry: xdr.SorobanAuthorizationEntry,
    *,
    order: LimitOrder,
    settlement_address: str,
    xlm_token: str,
) -> None:
    if (
        entry.credentials.type
        != xdr.SorobanCredentialsType.SOROBAN_CREDENTIALS_ADDRESS_V2
    ):
        raise AquariusError("limit-order authorization must use ADDRESS_V2")
    credentials = entry.credentials.address_v2
    if credentials is None:
        raise AquariusError("limit-order authorization has no ADDRESS_V2 credentials")
    if Address.from_xdr_sc_address(credentials.address).address != order.maker:
        raise AquariusError("limit-order authorization maker does not match the order")
    if credentials.signature_expiration_ledger.uint32 != order.expires_at_ledger:
        raise AquariusError(
            "limit-order authorization expiration does not match the order"
        )
    if credentials.signature.type == xdr.SCValType.SCV_VOID:
        raise AquariusError("limit-order authorization is not signed")
    expected = _authorization_invocation(
        order,
        settlement_address=settlement_address,
        xlm_token=xlm_token,
    )
    if entry.root_invocation.to_xdr_bytes() != expected.to_xdr_bytes():
        raise AquariusError(
            "limit-order authorization invocation tree does not match the order"
        )


def _authorization_invocation(
    order: LimitOrder,
    *,
    settlement_address: str,
    xlm_token: str,
) -> xdr.SorobanAuthorizedInvocation:
    maker = scval.to_address(order.maker)
    settlement = scval.to_address(settlement_address)

    def contract_call(
        contract: str,
        function_name: str,
        args: list[SCVal],
        sub_invocations=None,
    ):
        return xdr.SorobanAuthorizedInvocation(
            function=xdr.SorobanAuthorizedFunction(
                type=xdr.SorobanAuthorizedFunctionType.SOROBAN_AUTHORIZED_FUNCTION_TYPE_CONTRACT_FN,
                contract_fn=xdr.InvokeContractArgs(
                    contract_address=Address(contract).to_xdr_sc_address(),
                    function_name=xdr.SCSymbol(function_name.encode()),
                    args=args,
                ),
            ),
            sub_invocations=sub_invocations or [],
        )

    return contract_call(
        settlement_address,
        "fill",
        [order.order_scval],
        [
            contract_call(
                order.sell_token,
                "transfer",
                [maker, settlement, scval.to_int128(order.sell_amount)],
            ),
            contract_call(
                xlm_token,
                "transfer",
                [
                    maker,
                    settlement,
                    scval.to_int128(order.executor_reward_xlm),
                ],
            ),
        ],
    )


def route_scval_from_swap_chain(swap_chain_xdr: str) -> SCVal:
    try:
        chain = SCVal.from_xdr(swap_chain_xdr)
    except Exception as exc:
        raise AquariusError("swap chain is not valid XDR") from exc
    if chain.vec is None or not chain.vec.sc_vec:
        raise AquariusError("swap chain must be a non-empty vec")
    route_hops = []
    for raw_hop in chain.vec.sc_vec:
        if raw_hop.vec is None or len(raw_hop.vec.sc_vec) != 3:
            raise AquariusError("swap-chain hop must contain three fields")
        pool_tokens, pool_index, token_out = raw_hop.vec.sc_vec
        route_hops.append(
            scval.to_struct(
                {
                    "pool_tokens": pool_tokens,
                    "pool_index": pool_index,
                    "token_out": token_out,
                }
            )
        )
    return scval.to_vec(route_hops)


def fill_parameters(
    record: LimitOrderRecord,
    reward_to: str,
    swap_chain_xdr: str,
) -> list[SCVal]:
    return [
        record.order.order_scval,
        scval.to_address(reward_to),
        route_scval_from_swap_chain(swap_chain_xdr),
    ]


def validate_fill_receipt(
    record: LimitOrderRecord,
    reward_to: str,
    value: SCVal,
) -> LimitOrderFillReceipt:
    try:
        receipt = scval.to_native(value)
    except Exception as exc:
        raise AquariusError(
            "limit-order fill simulation returned an invalid receipt"
        ) from exc
    native_reward_to = receipt.get("reward_to") if isinstance(receipt, dict) else None
    if (
        not isinstance(receipt, dict)
        or receipt.get("order_id") != bytes.fromhex(record.order_id)
        or not isinstance(receipt.get("router_output"), int)
        or receipt["router_output"] < 0
        or not isinstance(receipt.get("maker_buy_delta_before_reward"), int)
        or receipt["maker_buy_delta_before_reward"] < record.order.min_buy_amount
        or receipt.get("reward_xlm") != record.order.executor_reward_xlm
        or not isinstance(native_reward_to, Address)
        or native_reward_to.address != reward_to
    ):
        raise AquariusError(
            "limit-order fill receipt does not preserve maker payout and execution fee"
        )
    return LimitOrderFillReceipt(
        order_id=record.order_id,
        router_output=receipt["router_output"],
        maker_buy_delta_before_reward=receipt[
            "maker_buy_delta_before_reward"
        ],
        reward_xlm=receipt["reward_xlm"],
        reward_to=reward_to,
    )


__all__ = [
    "LimitOrder",
    "LimitOrderConfig",
    "LimitOrderFillReceipt",
    "LimitOrderFillResult",
    "LimitOrderPage",
    "LimitOrderRecord",
    "OnchainLimitOrder",
    "OnchainLimitOrderReceipt",
    "PreparedLimitOrderFill",
    "build_onchain_placement_args",
    "fill_parameters",
    "parse_limit_order_record",
    "route_scval_from_swap_chain",
    "validate_authorization_tree",
    "validate_fill_receipt",
    "validate_onchain_limit_order_draft",
]
