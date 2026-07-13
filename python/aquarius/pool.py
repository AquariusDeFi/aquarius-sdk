from __future__ import annotations

from dataclasses import dataclass, field

from stellar_sdk import Address, StrKey, scval
from stellar_sdk.xdr import SCVal

from .assets import Asset
from .errors import AquariusError

# On-chain pool_type symbols -> the names the documentation uses.
_POOL_TYPES = {
    "constant_product": "volatile",
    "stable": "stable",
    "concentrated": "concentrated",
}


def sort_token_ids(contract_ids: list[str]) -> list[str]:
    """Order token contract IDs the way the contracts require (by contract ID bytes)."""
    return sorted(contract_ids, key=StrKey.decode_contract)


def resolve_amounts(amounts, tokens: list[str], passphrase: str) -> list[int]:
    """Accept a dict keyed by Asset or contract ID, or a list in sorted-token order."""
    if isinstance(amounts, (list, tuple)):
        if len(amounts) != len(tokens):
            raise AquariusError(
                f"Expected {len(tokens)} amounts in sorted-token order, got {len(amounts)}"
            )
        return [int(a) for a in amounts]
    resolved = {t: 0 for t in tokens}
    for key, value in amounts.items():
        contract_id = key.contract_id(passphrase) if isinstance(key, Asset) else key
        if contract_id not in resolved:
            raise AquariusError(f"Token {contract_id} is not part of this pool")
        resolved[contract_id] = int(value)
    return [resolved[t] for t in tokens]


# --- SCVal parsing (the only place liquidity results are decoded) --------------


def parse_u128(value: SCVal) -> int:
    return scval.from_uint128(value)


def parse_i128(value: SCVal) -> int:
    return scval.from_int128(value)


def parse_u128_vec(value: SCVal) -> list[int]:
    return [scval.from_uint128(item) for item in value.vec.sc_vec]


def parse_deposit_result(value: SCVal) -> tuple[list[int], int]:
    amounts, shares = value.vec.sc_vec
    return parse_u128_vec(amounts), scval.from_uint128(shares)


def parse_pools_map(value: SCVal) -> dict[bytes, str]:
    """get_pools result: Map<BytesN<32>, Address> -> {pool hash: pool address}."""
    result: dict[bytes, str] = {}
    for entry in value.map.sc_map:
        pool_hash = entry.key.bytes.sc_bytes
        result[pool_hash] = Address.from_xdr_sc_address(entry.val.address).address
    return result


# --- results --------------------------------------------------------------------


@dataclass
class DepositResult:
    tx_hash: str
    amounts: list[int]  # base units actually deposited, in sorted-token order
    shares: int         # pool share tokens minted


@dataclass
class WithdrawResult:
    tx_hash: str
    amounts: list[int]  # base units returned, in sorted-token order


@dataclass
class ClaimResult:
    tx_hash: str
    amount: int  # AQUA claimed, in stroops


@dataclass
class Position:
    pool: "Pool"
    shares: int


# --- the pool object ---------------------------------------------------------------


@dataclass
class Pool:
    """One liquidity pool: reads need no signer, writes go through the router."""

    address: str
    pool_hash: bytes
    type: str            # "volatile" | "stable" | "concentrated"
    fee_bps: int
    tokens: list[str]    # token contract IDs in the contract's sorted order
    token_labels: list[str]
    _client: object = field(repr=False)
    _share_token: str | None = field(default=None, repr=False)

    # -- reads (no signer required) --------------------------------------------

    def reserves(self) -> list[int]:
        """Pool reserves in base units, in sorted-token order."""
        return parse_u128_vec(self._router_read("get_reserves"))

    def total_shares(self) -> int:
        return parse_u128(self._router_read("get_total_shares"))

    def share_token(self) -> str:
        """The pool's share token contract ID."""
        if self._share_token is None:
            value = self._router_read("share_id")
            self._share_token = Address.from_xdr_sc_address(value.address).address
        return self._share_token

    def share_balance(self, address: str | None = None) -> int:
        """Pool shares held by the address (default: the signer's account)."""
        holder = address or self._client._read_source(require_signer=True)
        value = self._client._read_contract(
            self.share_token(), "balance", [scval.to_address(holder)]
        )
        return parse_i128(value)

    def pending_rewards(self, address: str | None = None) -> int:
        """Accrued, unclaimed AQUA rewards in stroops (default: the signer's account)."""
        holder = address or self._client._read_source(require_signer=True)
        value = self._router_read("get_user_reward", [scval.to_address(holder)], prepend=True)
        return parse_u128(value)

    # -- writes ------------------------------------------------------------------

    def deposit(self, amounts, *, slippage: float = 0.01) -> DepositResult:
        """Deposit liquidity. `amounts` is a dict keyed by Asset or contract ID
        (missing pool tokens default to 0), or a list in sorted-token order.

        The minted-shares guard comes from a simulation of this exact deposit,
        reduced by `slippage`.
        """
        if self.type == "concentrated":
            raise AquariusError(
                "Depositing into a concentrated pool through the router opens a "
                "full-range position. Manage concentrated positions through the "
                "pool contract — see the concentrated liquidity documentation."
            )
        desired = resolve_amounts(amounts, self.tokens, self._client.network.passphrase)
        estimated_amounts, estimated_shares = parse_deposit_result(
            self._simulate_write("deposit", self._deposit_args(desired, 0))
        )
        min_shares = estimated_shares * round((1 - slippage) * 10_000) // 10_000
        confirmed = self._submit_write("deposit", self._deposit_args(desired, min_shares))
        deposited, shares = parse_deposit_result(confirmed.return_value)
        return DepositResult(tx_hash=confirmed.tx_hash, amounts=deposited, shares=shares)

    def withdraw(self, shares: int, *, slippage: float = 0.01) -> WithdrawResult:
        """Burn pool shares for the underlying tokens.

        The per-token minimums come from a simulation of this exact withdrawal,
        reduced by `slippage`.
        """
        estimated = parse_u128_vec(
            self._simulate_write("withdraw", self._withdraw_args(shares, [0] * len(self.tokens)))
        )
        factor = round((1 - slippage) * 10_000)
        minimums = [amount * factor // 10_000 for amount in estimated]
        confirmed = self._submit_write("withdraw", self._withdraw_args(shares, minimums))
        return WithdrawResult(
            tx_hash=confirmed.tx_hash, amounts=parse_u128_vec(confirmed.return_value)
        )

    def claim_rewards(self) -> ClaimResult:
        """Claim accrued AQUA rewards for the signer."""
        confirmed = self._submit_write("claim", self._base_args())
        return ClaimResult(
            tx_hash=confirmed.tx_hash, amount=parse_u128(confirmed.return_value)
        )

    # -- internals ---------------------------------------------------------------------

    def _base_args(self) -> list[SCVal]:
        return [
            scval.to_vec([scval.to_address(t) for t in self.tokens]),
            scval.to_bytes(self.pool_hash),
        ]

    def _deposit_args(self, desired: list[int], min_shares: int) -> list[SCVal]:
        return self._base_args() + [
            scval.to_vec([scval.to_uint128(a) for a in desired]),
            scval.to_uint128(min_shares),
        ]

    def _withdraw_args(self, shares: int, minimums: list[int]) -> list[SCVal]:
        return self._base_args() + [
            scval.to_uint128(shares),
            scval.to_vec([scval.to_uint128(m) for m in minimums]),
        ]

    def _router_read(self, fn: str, extra: list[SCVal] | None = None, prepend: bool = False) -> SCVal:
        args = self._base_args()
        if extra:
            args = extra + args if prepend else args + extra
        return self._client._read_router(fn, args)

    def _simulate_write(self, fn: str, args: list[SCVal]) -> SCVal:
        user = scval.to_address(self._client._read_source(require_signer=True))
        return self._client._read_router(fn, [user] + args)

    def _submit_write(self, fn: str, args: list[SCVal]):
        return self._client._submit_router(fn, args, with_user=True)
