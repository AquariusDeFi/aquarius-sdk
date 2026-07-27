from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from stellar_sdk import Address, Network, scval, xdr

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
    """Trusted deployment coordinates for programmatic on-chain orders."""

    settlement: str
    batcher: str
    api_url: str | None = None

    def __post_init__(self):
        object.__setattr__(
            self, "settlement", _contract_address(self.settlement, "settlement")
        )
        object.__setattr__(self, "batcher", _contract_address(self.batcher, "batcher"))
        if self.api_url is not None and not self.api_url:
            raise AquariusError("limit-order api_url must be non-empty")


@dataclass(frozen=True)
class OnchainLimitOrderReceipt:
    order_id: str
    tx_hash: str


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


__all__ = [
    "LimitOrderConfig",
    "OnchainLimitOrder",
    "OnchainLimitOrderReceipt",
    "build_onchain_placement_args",
    "validate_onchain_limit_order_draft",
]
