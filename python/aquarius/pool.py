from __future__ import annotations

from dataclasses import dataclass, field

from stellar_sdk import Address, StrKey, scval
from stellar_sdk.xdr import SCVal, SorobanAuthorizedInvocation

from .assets import Asset
from .authorization import authorized_invocation, source_account_entry
from .concentrated import (
    MAX_TICK,
    MIN_TICK,
    ClaimFeesResult,
    ConcentratedDepositResult,
    ConcentratedPosition,
    ConcentratedWithdrawResult,
    PositionRangeStatus,
    PositionValue,
    Slot0,
    range_status,
    snap_tick,
    tick_from_price,
)
from .errors import AquariusError, SlippageError

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
    _tick_spacing: int | None = field(default=None, repr=False)

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
        user = scval.to_address(self._client._read_source(require_signer=True))
        # Pools pull desired input and refund excess. Volatile pools also
        # transfer zero amounts; stable pools skip them.
        transfers = [
            authorized_invocation(token, "transfer", [
                user, scval.to_address(self.address), scval.to_int128(amount),
            ])
            for token, amount in zip(self.tokens, desired)
            if self.type == "volatile" or amount > 0
        ]
        confirmed = self._submit_write(
            "deposit", self._deposit_args(desired, min_shares), transfers,
        )
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
        # The concentrated legacy interface withdraws a full-range position;
        # only volatile/stable pools burn the user's LP token.
        burns = [] if self.type == "concentrated" else [authorized_invocation(
            self.share_token(), "burn", [
                scval.to_address(self._client._read_source(require_signer=True)),
                scval.to_int128(shares),
            ],
        )]
        confirmed = self._submit_write(
            "withdraw", self._withdraw_args(shares, minimums), burns,
        )
        return WithdrawResult(
            tx_hash=confirmed.tx_hash, amounts=parse_u128_vec(confirmed.return_value)
        )

    def claim_rewards(self) -> ClaimResult:
        """Claim accrued AQUA rewards for the signer."""
        confirmed = self._submit_write("claim", self._base_args(), [])
        return ClaimResult(
            tx_hash=confirmed.tx_hash, amount=parse_u128(confirmed.return_value)
        )

    # -- single-pool swaps ---------------------------------------------------------

    def quote(
        self,
        from_,
        to,
        *,
        amount_in: int | None = None,
        amount_out: int | None = None,
        slippage: float = 0.01,
    ) -> "PoolQuote":
        """Quote a swap against this pool only — the router's own on-chain
        estimator, no path-finding API involved.

        Exact input only: the router has no single-pool strict-receive.
        For exact output use ``client.quote(..., amount_out=...)``.
        """
        if amount_out is not None:
            raise AquariusError(
                "The router has no single-pool strict-receive — use "
                "client.quote(..., amount_out=...) for exact-output swaps"
            )
        if amount_in is None or int(amount_in) <= 0:
            raise AquariusError("Pass a positive amount_in")
        token_in, token_out = self._swap_pair(from_, to)
        estimated = parse_u128(self._client._read_router("estimate_swap", [
            scval.to_vec([scval.to_address(t) for t in self.tokens]),
            scval.to_address(token_in),
            scval.to_address(token_out),
            scval.to_bytes(self.pool_hash),
            scval.to_uint128(int(amount_in)),
        ]))
        guard = estimated * round((1 - slippage) * 10_000) // 10_000
        return PoolQuote(
            amount_in=int(amount_in),
            amount_out=estimated,
            guard=guard,
            _pool=self,
            _token_in=token_in,
            _token_out=token_out,
            _slippage=slippage,
        )

    def swap(self, from_, to, *, retries: int = 0, **kwargs):
        """quote() + execute() pinned to this pool, for bots.

        retries: how many times to re-quote and retry after a SlippageError.
        Unlike routed swaps there is no pricing indexer to wait for — the
        estimate reads the chain directly — so retries are immediate.
        Default 0: fail on the first guard breach.
        """
        if retries < 0:
            raise AquariusError("retries must be >= 0")
        for attempt in range(retries + 1):
            try:
                return self.quote(from_, to, **kwargs).execute()
            except SlippageError:
                if attempt == retries:
                    raise
        raise AquariusError("unreachable: the retry loop always returns or raises")

    def _swap_pair(self, from_, to) -> tuple[str, str]:
        passphrase = self._client.network.passphrase
        token_in = from_.contract_id(passphrase) if isinstance(from_, Asset) else from_
        token_out = to.contract_id(passphrase) if isinstance(to, Asset) else to
        for token in (token_in, token_out):
            if token not in self.tokens:
                raise AquariusError(f"Token {token} is not part of this pool")
        if token_in == token_out:
            raise AquariusError("from and to must be different tokens")
        return token_in, token_out

    # -- concentrated positions (beta; direct pool-contract calls) ----------------------
    #
    # Range positions live on the pool contract itself, not the router: a
    # position is the key (owner, tick_lower, tick_upper), merged on
    # re-deposit, max 20 ranges per account. Amounts are always quoted via
    # the contract's own estimate_* functions; withdrawal auto-claims that
    # position's fees. The concentrated surface is beta: the contracts are
    # under an ongoing external audit.

    def _require_concentrated(self) -> None:
        if self.type != "concentrated":
            raise AquariusError(
                f"This operation needs a concentrated pool; this pool is {self.type}"
            )

    def _read_pool(self, fn: str, args: list[SCVal]):
        self._require_concentrated()
        return scval.to_native(self._client._read_contract(self.address, fn, args))

    def tick_spacing(self) -> int:
        """The pool's tick spacing (set by its fee tier)."""
        if self._tick_spacing is None:
            self._tick_spacing = int(self._read_pool("get_tick_spacing", []))
        return self._tick_spacing

    def slot0(self) -> Slot0:
        """Current price state: sqrt price (Q64.96) and current tick."""
        data = self._read_pool("get_slot0", [])
        return Slot0(sqrt_price_x96=int(data["sqrt_price_x96"]), tick=int(data["tick"]))

    def current_tick(self) -> int:
        return self.slot0().tick

    def position_range_status(self, tick_lower: int, tick_upper: int) -> PositionRangeStatus:
        """Where the current price sits relative to the range.

        The contract's range is half-open ``[tick_lower, tick_upper)``: at
        ``tick_upper`` the position is already "above" and earns no fees.
        """
        tick = self.current_tick()
        return PositionRangeStatus(
            status=range_status(tick, tick_lower, tick_upper),
            current_tick=tick,
            tick_lower=tick_lower,
            tick_upper=tick_upper,
            ticks_from_lower=tick - tick_lower,
            ticks_to_upper=tick_upper - tick,
        )

    def position_ranges(self, address: str | None = None) -> list[tuple[int, int]]:
        """All (tick_lower, tick_upper) ranges the address holds (default: signer)."""
        holder = address or self._client._read_source(require_signer=True)
        snapshot = self._read_pool(
            "get_user_position_snapshot", [scval.to_address(holder)]
        )
        return [
            (int(r["tick_lower"]), int(r["tick_upper"]))
            for r in snapshot.get("ranges", [])
        ]

    def position(
        self, tick_lower: int, tick_upper: int, address: str | None = None
    ) -> ConcentratedPosition:
        holder = address or self._client._read_source(require_signer=True)
        data = self._read_pool("get_position", [
            scval.to_address(holder),
            scval.to_int32(tick_lower),
            scval.to_int32(tick_upper),
        ])
        liquidity = data.get("liquidity", data.get("L", 0))
        return ConcentratedPosition(
            tick_lower=tick_lower, tick_upper=tick_upper, liquidity=int(liquidity)
        )

    def position_fees(
        self, tick_lower: int, tick_upper: int, address: str | None = None
    ) -> list[int]:
        """Accrued, unclaimed swap fees for one position, in sorted-token order."""
        holder = address or self._client._read_source(require_signer=True)
        return [int(a) for a in self._read_pool("get_position_fees", [
            scval.to_address(holder),
            scval.to_int32(tick_lower),
            scval.to_int32(tick_upper),
        ])]

    def all_position_fees(self, address: str | None = None) -> list[int]:
        """Accrued fees across all of the address's positions in this pool."""
        holder = address or self._client._read_source(require_signer=True)
        return [int(a) for a in self._read_pool(
            "get_all_position_fees", [scval.to_address(holder)]
        )]

    def position_value(
        self, tick_lower: int, tick_upper: int, address: str | None = None
    ) -> PositionValue:
        """The position's worth, split into principal / fees / total.

        `total` is what a full withdrawal returns right now (withdrawal
        auto-claims fees), `fees` is the unclaimed accrual, `principal`
        is the difference floored at zero.
        """
        holder = address or self._client._read_source(require_signer=True)
        pos = self.position(tick_lower, tick_upper, address=holder)
        total = [int(a) for a in self._read_pool("estimate_withdraw_position", [
            scval.to_address(holder),
            scval.to_int32(tick_lower),
            scval.to_int32(tick_upper),
            scval.to_uint128(pos.liquidity),
        ])]
        fees = self.position_fees(tick_lower, tick_upper, address=holder)
        principal = [max(t - f, 0) for t, f in zip(total, fees)]
        return PositionValue(total=total, fees=fees, principal=principal)

    # -- concentrated writes ------------------------------------------------------------

    def estimate_position_deposit(
        self,
        amounts,
        *,
        tick_range: tuple[int, int] | None = None,
        price_range: tuple | None = None,
    ) -> "ConcentratedDepositEstimate":
        """Quote a range deposit. Pass tick_range=(lower, upper) or
        price_range=(low, high) in raw token1/token0 prices — prices snap to
        the pool's tick spacing (lower floors, upper ceils).

        The returned estimate's execute(slippage=...) performs the deposit
        with min_liquidity derived from this quote.
        """
        self._require_concentrated()
        if (tick_range is None) == (price_range is None):
            raise AquariusError("Pass exactly one of tick_range / price_range")
        spacing = self.tick_spacing()
        if price_range is not None:
            lower = snap_tick(tick_from_price(price_range[0]), spacing)
            upper = snap_tick(tick_from_price(price_range[1]), spacing, up=True)
        else:
            lower, upper = int(tick_range[0]), int(tick_range[1])
            if lower % spacing or upper % spacing:
                raise AquariusError(
                    f"ticks must be multiples of the pool's tick spacing ({spacing})"
                )
        if not (MIN_TICK <= lower < upper <= MAX_TICK):
            raise AquariusError(
                "tick_lower must be below tick_upper, both within tick bounds"
            )
        desired = resolve_amounts(amounts, self.tokens, self._client.network.passphrase)
        estimated_amounts, estimated_liquidity = self._read_pool(
            "estimate_deposit_position",
            [
                scval.to_int32(lower),
                scval.to_int32(upper),
                scval.to_vec([scval.to_uint128(a) for a in desired]),
            ],
        )
        return ConcentratedDepositEstimate(
            tick_lower=lower,
            tick_upper=upper,
            desired=desired,
            amounts=[int(a) for a in estimated_amounts],
            liquidity=int(estimated_liquidity),
            _pool=self,
        )

    def withdraw_position(
        self,
        tick_lower: int,
        tick_upper: int,
        liquidity: int | None = None,
        *,
        slippage: float = 0.01,
    ) -> ConcentratedWithdrawResult:
        """Remove liquidity from a range (default: the whole position).

        Withdrawal auto-claims the position's fees. Per-token minimums come
        from a simulation of this exact withdrawal, reduced by `slippage`.
        """
        self._require_concentrated()
        owner = self._client._read_source(require_signer=True)
        if liquidity is None:
            liquidity = self.position(tick_lower, tick_upper, address=owner).liquidity
        estimated = self._read_pool("estimate_withdraw_position", [
            scval.to_address(owner),
            scval.to_int32(tick_lower),
            scval.to_int32(tick_upper),
            scval.to_uint128(liquidity),
        ])
        factor = round((1 - slippage) * 10_000)
        minimums = [int(a) * factor // 10_000 for a in estimated]
        args = [
            scval.to_address(owner),
            scval.to_int32(tick_lower),
            scval.to_int32(tick_upper),
            scval.to_uint128(liquidity),
            scval.to_vec([scval.to_uint128(m) for m in minimums]),
        ]
        confirmed = self._client._submit_contract(
            self.address, "withdraw_position", args,
            auth=[source_account_entry(
                authorized_invocation(self.address, "withdraw_position", args)
            )],
        )
        return ConcentratedWithdrawResult(
            tx_hash=confirmed.tx_hash,
            amounts=[int(a) for a in scval.to_native(confirmed.return_value)],
        )

    def claim_position_fees(self, tick_lower: int, tick_upper: int) -> ClaimFeesResult:
        """Collect one position's accrued swap fees."""
        self._require_concentrated()
        owner = self._client._read_source(require_signer=True)
        args = [
            scval.to_address(owner),
            scval.to_int32(tick_lower),
            scval.to_int32(tick_upper),
        ]
        confirmed = self._client._submit_contract(
            self.address, "claim_position_fees", args,
            auth=[source_account_entry(
                authorized_invocation(self.address, "claim_position_fees", args)
            )],
        )
        return ClaimFeesResult(
            tx_hash=confirmed.tx_hash,
            amounts=[int(a) for a in scval.to_native(confirmed.return_value)],
        )

    def claim_all_position_fees(self) -> ClaimFeesResult:
        """Collect accrued swap fees across all of the signer's positions."""
        self._require_concentrated()
        owner = self._client._read_source(require_signer=True)
        args = [scval.to_address(owner)]
        confirmed = self._client._submit_contract(
            self.address, "claim_all_position_fees", args,
            auth=[source_account_entry(
                authorized_invocation(self.address, "claim_all_position_fees", args)
            )],
        )
        return ClaimFeesResult(
            tx_hash=confirmed.tx_hash,
            amounts=[int(a) for a in scval.to_native(confirmed.return_value)],
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

    def _submit_write(
        self, fn: str, args: list[SCVal], sub_invocations: list[SorobanAuthorizedInvocation],
    ):
        user = scval.to_address(self._client._read_source(require_signer=True))
        router_args = [user] + args
        # Router selection (tokens, pool hash) is absent from the pool call.
        pool_call = authorized_invocation(self.address, fn, [user] + args[2:], sub_invocations)
        auth = [source_account_entry(authorized_invocation(
            self._client.network.router, fn, router_args, [pool_call],
        ))]
        return self._client._submit_router(fn, router_args, auth=auth)


@dataclass
class PoolQuote:
    """A swap quoted against one specific pool: execute() pins the swap there."""

    amount_in: int
    amount_out: int  # the router's estimate_swap for this pool
    guard: int       # minimum acceptable output: the estimate reduced by slippage
    _pool: Pool = field(repr=False)
    _token_in: str = field(repr=False)
    _token_out: str = field(repr=False)
    _slippage: float = field(repr=False)

    def execute(self):
        """Build, sign, submit, confirm, and parse the pinned-pool swap."""
        pool = self._pool
        client = pool._client
        user = client._read_source(require_signer=True)
        args = [
            scval.to_address(user),
            scval.to_vec([scval.to_address(t) for t in pool.tokens]),
            scval.to_address(self._token_in),
            scval.to_address(self._token_out),
            scval.to_bytes(pool.pool_hash),
            scval.to_uint128(self.amount_in),
            scval.to_uint128(self.guard),
        ]
        # Unlike the chained path (where the router pulls the tokens), the
        # single-pool flow nests: the pool's own swap calls
        # user.require_auth() and then pulls transfer(user -> pool) itself.
        # The auth tree mirrors that exactly:
        #   router.swap -> pool.swap -> token.transfer(user, pool, amount)
        entry = source_account_entry(authorized_invocation(
            client.network.router, "swap", args,
            [authorized_invocation(
                pool.address, "swap",
                [
                    scval.to_address(user),
                    scval.to_uint32(pool.tokens.index(self._token_in)),
                    scval.to_uint32(pool.tokens.index(self._token_out)),
                    scval.to_uint128(self.amount_in),
                    scval.to_uint128(self.guard),
                ],
                [authorized_invocation(self._token_in, "transfer", [
                    scval.to_address(user),
                    scval.to_address(pool.address),
                    scval.to_int128(self.amount_in),
                ])],
            )],
        ))
        from .client import Receipt  # runtime import: client.py imports this module

        try:
            confirmed = client._submit_router("swap", args, auth=[entry])
        except SlippageError as error:
            error.attach_requote(lambda: pool.quote(
                self._token_in, self._token_out,
                amount_in=self.amount_in, slippage=self._slippage,
            ))
            raise
        return Receipt(confirmed.tx_hash, self.amount_in, parse_u128(confirmed.return_value))


@dataclass
class ConcentratedDepositEstimate:
    """A quoted range deposit: execute() performs it with a min-liquidity guard."""

    tick_lower: int
    tick_upper: int
    desired: list[int]    # what will be authorized for transfer, sorted-token order
    amounts: list[int]    # estimated base units the pool will actually use
    liquidity: int        # estimated raw liquidity to be minted
    _pool: Pool = field(repr=False)

    def execute(self, *, slippage: float = 0.01) -> ConcentratedDepositResult:
        pool = self._pool
        client = pool._client
        owner = client._read_source(require_signer=True)
        min_liquidity = self.liquidity * round((1 - slippage) * 10_000) // 10_000
        args = [
            scval.to_address(owner),
            scval.to_int32(self.tick_lower),
            scval.to_int32(self.tick_upper),
            scval.to_vec([scval.to_uint128(a) for a in self.desired]),
            scval.to_uint128(min_liquidity),
        ]
        # Mirror the web app's transaction shape: authorize a transfer of the
        # full desired amount per token — the contract pulls exactly those
        # amounts and refunds whatever the range doesn't need.
        transfers = [
            authorized_invocation(token, "transfer", [
                scval.to_address(owner),
                scval.to_address(pool.address),
                scval.to_int128(amount),
            ])
            for token, amount in zip(pool.tokens, self.desired)
            if amount > 0
        ]
        entry = source_account_entry(
            authorized_invocation(pool.address, "deposit_position", args, transfers)
        )
        confirmed = client._submit_contract(
            pool.address, "deposit_position", args, auth=[entry]
        )
        used, minted = scval.to_native(confirmed.return_value)
        return ConcentratedDepositResult(
            tx_hash=confirmed.tx_hash,
            amounts=[int(a) for a in used],
            liquidity=int(minted),
        )
