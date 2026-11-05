from __future__ import annotations

import time
from collections.abc import Mapping
from dataclasses import dataclass, field

import requests
from stellar_sdk import Address, Network, SorobanServer, scval
from stellar_sdk.client.requests_client import RequestsClient
from stellar_sdk.exceptions import AccountNotFoundException
from stellar_sdk.xdr import SCVal, SorobanAuthorizationEntry
from stellar_sdk.soroban_rpc import AuthMode

from .api import ApiClient, ParsedRoute, parse_find_path_response
from .authorization import authorized_invocation, source_account_entry
from .assets import Asset
from .collector import FeeCollector
from .errors import AquariusError, SlippageError
from .limit_orders import (
    _validate_executor_reward,
    LimitOrderConfig,
    LimitOrderPage,
    LimitOrderRecord,
    OnchainLimitOrder,
    OnchainLimitOrderReceipt,
    PreparedLimitOrderFill,
    build_onchain_placement_args,
    fill_parameters,
    parse_limit_order_record,
    validate_fill_receipt,
    validate_onchain_limit_order_draft,
)
from .pool import Pool, Position, parse_pools_map, sort_token_ids
from .networks import NETWORKS, NetworkConfig
from .signer import signer_public_key
from .submit import SubmitEngine

_FRIENDBOT_URL = "https://friendbot.stellar.org"
_U32_MAX = 2**32 - 1


@dataclass(frozen=True)
class ProviderFeeConfig:
    """Configuration for a swap through a provider-fee collector contract."""

    contract_id: str
    fee_fraction: int
    fee_denominator: int
    recipient: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.contract_id, str) or not self.contract_id:
            raise AquariusError("provider fee contract_id must be a non-empty address")
        if self.recipient is not None and (
            not isinstance(self.recipient, str) or not self.recipient
        ):
            raise AquariusError("provider fee recipient must be a non-empty address")
        if type(self.fee_fraction) is not int or not 0 <= self.fee_fraction <= _U32_MAX:
            raise AquariusError("provider fee_fraction must be a u32")
        if type(self.fee_denominator) is not int or not 1 <= self.fee_denominator <= _U32_MAX:
            raise AquariusError("provider fee_denominator must be a positive u32")
        if self.fee_fraction >= self.fee_denominator:
            raise AquariusError("provider fee_fraction must be smaller than fee_denominator")

    def _net_amount(self, gross: int) -> int:
        fee = (gross * self.fee_fraction + self.fee_denominator - 1) // self.fee_denominator
        return gross - fee

    def _gross_amount(self, net: int) -> int:
        divisor = self.fee_denominator - self.fee_fraction
        return (net * self.fee_denominator + divisor - 1) // divisor


@dataclass
class Receipt:
    tx_hash: str
    amount_in: int   # base units actually spent
    amount_out: int  # base units actually received


@dataclass
class Quote:
    amount_in: int
    amount_out: int
    guard: int              # min-out (exact-input) or max-in (exact-output)
    route: list[str]        # pool addresses along the path
    is_exact_input: bool
    _client: "AquariusClient" = field(repr=False)
    _parsed: ParsedRoute = field(repr=False)
    _params: dict = field(repr=False)

    def execute(self) -> Receipt:
        """Build, sign, submit, confirm, and parse the swap this quote describes."""
        return self._client._execute(self)

    def build_transaction(self) -> str:
        """Escape hatch: the simulated, unsigned transaction envelope XDR."""
        return self._client._build_unsigned(self)


class AquariusClient:
    # Pauses before re-quotes in swap(), indexed by retry attempt (the last
    # entry repeats). The find-path API prices from an indexer that can lag the
    # chain — after your own swap moves a pool, a too-early re-quote reprices
    # from pre-swap reserves and breaches the guard again. The first retry is
    # immediate (an on-chain guard breach already burned enough wall-clock for
    # the indexer to catch up); later ones wait for the lag window to close.
    # Class attribute so tests can shrink it.
    _requote_delays_s: tuple = (0.0, 1.5, 3.0)

    def __init__(
        self,
        network: str = "mainnet",
        signer=None,
        *,
        rpc_url: str | None = None,
        horizon_url: str | None = None,
        api_url: str | None = None,
        base_fee: int = 100_000,
        timeout: int | str | None = None,
        resource_fee_headroom: float | None = None,
        instruction_headroom: float | None = None,
        limit_orders: LimitOrderConfig | None = None,
    ):
        """timeout: transaction time bound in seconds, or "infinite".

        Default: 300 seconds when the signer is a local keypair (a stale bot
        transaction should expire, not execute later at a worse price);
        no bound when signing goes through a wallet (humans take their time).

        resource_fee_headroom: fraction of the simulated Soroban resource fee
        added on top of it before signing. Default (None) 0.5, i.e. 50%; 0
        disables. The declared resource fee is a cap and unused fee is
        refunded, so headroom costs nothing unless the transaction needs it at
        apply time. The source account must still hold the full declared fee
        (inclusion + resource + headroom): it is debited before execution and
        the unused part is refunded after apply.

        instruction_headroom: fraction of the simulated CPU instructions added
        on top of them before signing, capped at the network's per-transaction
        limit. Default (None) 0.25, i.e. 25%; 0 disables. The resource fee is
        raised by the compute fee of the added instructions, which is charged
        whether or not they are used.
        """
        preset = NETWORKS.get(network)
        if preset is None:
            raise AquariusError(f"Unknown network: {network}")
        self.network = NetworkConfig(
            router=preset.router,
            api_url=api_url or preset.api_url,
            rpc_url=rpc_url or preset.rpc_url,
            horizon_url=horizon_url or preset.horizon_url,
            passphrase=preset.passphrase,
            read_source=preset.read_source,
            collector_factory=preset.collector_factory,
            limit_orders_api_url=preset.limit_orders_api_url,
        )
        if timeout is None:
            resolved_timeout = 300 if isinstance(getattr(signer, "secret", None), str) else None
        elif timeout == "infinite":
            resolved_timeout = None
        else:
            resolved_timeout = int(timeout)
        self.api = ApiClient(self.network.api_url)
        self.server = SorobanServer(self.network.rpc_url)
        self.engine = SubmitEngine(
            self.server,
            self.network.passphrase,
            base_fee,
            timeout=resolved_timeout,
            resource_fee_headroom=resource_fee_headroom,
            instruction_headroom=instruction_headroom,
        )
        self.signer = signer
        self.limit_order_config = limit_orders

    # -- reads (no signer required) -------------------------------------------

    def latest_ledger(self) -> int:
        """Current Soroban RPC ledger sequence."""
        return self.server.get_latest_ledger().sequence

    def list_limit_orders(
        self,
        *,
        maker: str | None = None,
        status: str | None = None,
        cursor: str | None = None,
        limit: int = 100,
    ) -> LimitOrderPage:
        """Read one validated cursor page from the public order registry."""
        self._require_limit_order_config()
        if not 1 <= limit <= 100:
            raise AquariusError("limit-order page size must be between 1 and 100")
        params: dict[str, str | int] = {"limit": limit}
        if maker is not None:
            params["maker"] = maker
        if status is not None:
            params["status"] = status
        if cursor is not None:
            params["cursor"] = cursor
        page = self.api.list_limit_orders(self._limit_order_api_url(), params)
        payloads = page.get("orders") if isinstance(page, dict) else None
        if not isinstance(payloads, list):
            raise AquariusError("limit-order registry returned an invalid page")
        return LimitOrderPage(
            orders=[self._parse_limit_order_record(item) for item in payloads],
            next_cursor=(
                None
                if page.get("next_cursor") is None
                else str(page["next_cursor"])
            ),
        )

    def open_limit_orders(self, *, maker: str | None = None) -> list[LimitOrderRecord]:
        """Read every open order, following cursor pages defensively."""
        records: list[LimitOrderRecord] = []
        seen_order_ids: set[str] = set()
        seen_cursors: set[str] = set()
        cursor = None
        for _ in range(10_000):
            page = self.list_limit_orders(
                maker=maker,
                status="open",
                cursor=cursor,
            )
            for order in page.orders:
                if order.order_id in seen_order_ids:
                    raise AquariusError(
                        "limit-order registry repeated an order across pages"
                    )
                seen_order_ids.add(order.order_id)
                records.append(order)
            cursor = page.next_cursor
            if cursor is None:
                return records
            if not cursor or cursor in seen_cursors:
                raise AquariusError(
                    "limit-order registry returned an invalid pagination cursor"
                )
            seen_cursors.add(cursor)
        raise AquariusError("limit-order pagination exceeded the safety limit")

    def get_limit_order(self, order_id: str) -> LimitOrderRecord:
        """Read and validate one public order-registry record."""
        payload = self.api.get_limit_order(self._limit_order_api_url(), order_id)
        return self._parse_limit_order_record(payload)

    def quote(
        self,
        from_: Asset,
        to: Asset,
        *,
        amount_in: int | None = None,
        amount_out: int | None = None,
        slippage: float = 0.01,
        provider_fee: ProviderFeeConfig | None = None,
    ) -> Quote:
        """Best route for a swap. Pass amount_in (exact input) or amount_out (exact output)."""
        if (amount_in is None) == (amount_out is None):
            raise AquariusError("Pass exactly one of amount_in / amount_out")
        exact_input = amount_in is not None
        slippage_bps = round(slippage * 10_000)
        token_in = from_.contract_id(self.network.passphrase)
        token_out = to.contract_id(self.network.passphrase)

        route_amount = amount_in if exact_input else amount_out
        if provider_fee is not None and not exact_input:
            route_amount = provider_fee._gross_amount(amount_out)

        response = self.api.find_path(
            {
                "token_in_address": token_in,
                "token_out_address": token_out,
                "amount": str(route_amount),
            },
            exact_input,
        )
        parsed = parse_find_path_response(
            response,
            amount_in=amount_in,
            amount_out=None if exact_input else route_amount,
            slippage_bps=slippage_bps,
            pair_label=f"{from_} -> {to}",
        )
        if provider_fee is not None:
            if exact_input:
                parsed.amount_out = provider_fee._net_amount(parsed.amount_out)
                parsed.guard = provider_fee._net_amount(parsed.guard)
            else:
                parsed.amount_out = amount_out
        params = dict(
            from_=from_,
            to=to,
            amount_in=amount_in,
            amount_out=amount_out,
            slippage=slippage,
            provider_fee=provider_fee,
        )
        return Quote(
            amount_in=parsed.amount_in,
            amount_out=parsed.amount_out,
            guard=parsed.guard,
            route=parsed.route,
            is_exact_input=exact_input,
            _client=self,
            _parsed=parsed,
            _params=params,
        )

    # -- writes ------------------------------------------------------------------

    def swap(self, from_: Asset, to: Asset, *, retries: int = 0, **kwargs) -> Receipt:
        """quote() + execute() in one call, for bots.

        retries: how many times to re-quote and retry after a SlippageError.
        Each attempt starts from a fresh quote; the first retry is immediate
        and later ones back off briefly so the pricing indexer can catch up
        with the chain. Default 0 — fail on the first guard breach.
        """
        if retries < 0:
            raise AquariusError("retries must be >= 0")
        for attempt in range(retries + 1):
            try:
                return self.quote(from_, to, **kwargs).execute()
            except SlippageError:
                if attempt == retries:
                    raise
                delays = self._requote_delays_s
                delay = delays[min(attempt, len(delays) - 1)]
                if delay:
                    time.sleep(delay)
        raise AquariusError("unreachable: the retry loop always returns or raises")

    # -- provider-fee collectors ---------------------------------------------------

    def fee_collector(self, address: str) -> FeeCollector:
        """Attach to a deployed provider-fee collector contract."""
        return FeeCollector(address=address, _client=self)

    def deploy_fee_collector(
        self,
        *,
        max_fee_fraction: int,
        fee_denominator: int = 10_000,
        fee_destination: str | None = None,
        factory: str | None = None,
    ) -> FeeCollector:
        """Deploy a new provider-fee collector through the factory.

        The signer becomes the collector's operator; ``fee_destination``
        defaults to the operator. ``factory`` overrides the network's known
        factory — required on networks without one.
        """
        factory_id = factory or self.network.collector_factory
        if factory_id is None:
            raise AquariusError(
                "No collector factory known for this network — pass factory=..."
            )
        operator = self._read_source(require_signer=True)
        args = [
            scval.to_address(operator),
            scval.to_address(fee_destination or operator),
            scval.to_uint32(max_fee_fraction),
            scval.to_uint32(fee_denominator),
        ]
        confirmed = self._submit_contract(
            factory_id, "deploy_swap_fee_contract", args,
            auth=[source_account_entry(
                authorized_invocation(factory_id, "deploy_swap_fee_contract", args)
            )],
        )
        address = Address.from_xdr_sc_address(confirmed.return_value.address).address
        return FeeCollector(address=address, _client=self)

    def get_limit_order_executor_reward(self) -> int:
        """Read the configured settlement fee without signing or restoring."""
        config = self._require_limit_order_config()
        value = self._read_contract(
            config.settlement, "get_executor_reward", [], allow_restore=False,
        )
        try:
            reward = scval.from_uint128(value)
        except (TypeError, ValueError) as exc:
            raise AquariusError("settlement returned an invalid executor reward") from exc
        return _validate_executor_reward(reward)

    def create_onchain_limit_order(
        self,
        from_: Asset,
        to: Asset,
        *,
        sell_amount: int,
        min_buy_amount: int,
        valid_after_ledger: int,
        expires_at_ledger: int,
        expected_executor_reward_xlm: int,
        allowance_expiration_ledger: int,
        max_allowances: Mapping[str, int] | None = None,
    ) -> OnchainLimitOrder:
        """Create a canonical API draft for programmatic G-account placement.

        allowance_expiration_ledger is explicit because SEP-41 allowance()
        exposes the amount but not the current expiration. Callers reusing an
        allowance should choose a horizon no earlier than their other orders.
        expected_executor_reward_xlm must come from the caller's approved intent,
        not the registry. max_allowances explicitly permits larger shared totals.
        """
        _validate_executor_reward(expected_executor_reward_xlm)
        signer = self._require_signer()
        maker = signer_public_key(signer)
        if not maker.startswith("G"):
            raise AquariusError(
                "generic SDK on-chain placement requires a G-account signer"
            )
        if (
            min(sell_amount, min_buy_amount) <= 0
            or max(sell_amount, min_buy_amount) > 2**127 - 1
            or not 0 <= valid_after_ledger <= 2**32 - 1
            or not 0 <= expires_at_ledger <= 2**32 - 1
            or valid_after_ledger > expires_at_ledger
        ):
            raise AquariusError(
                "on-chain limit-order amounts must fit positive i128 values "
                "and ledgers must fit u32"
            )
        if (
            not isinstance(allowance_expiration_ledger, int)
            or not expires_at_ledger <= allowance_expiration_ledger <= 2**32 - 1
        ):
            raise AquariusError(
                "allowance expiration must be a u32 ledger at or after order expiration"
            )
        sell_token = from_.contract_id(self.network.passphrase)
        buy_token = to.contract_id(self.network.passphrase)
        if sell_token == buy_token:
            raise AquariusError("limit-order sell and buy tokens must differ")
        config = self._require_limit_order_config(require_batcher=True)
        if self.get_limit_order_executor_reward() != expected_executor_reward_xlm:
            raise AquariusError("settlement executor reward changed; review the order again")
        request = {
            "placement_mode": "CONTRACT_ONCHAIN",
            "maker": maker,
            "sell_token": sell_token,
            "sell_amount": str(sell_amount),
            "buy_token": buy_token,
            "min_buy_amount": str(min_buy_amount),
            "valid_after_ledger": valid_after_ledger,
            "expires_at_ledger": expires_at_ledger,
        }
        payload = self.api.create_limit_order_draft(
            self._limit_order_api_url(),
            request,
        )
        return validate_onchain_limit_order_draft(
            payload,
            expected_network_passphrase=self.network.passphrase,
            expected_settlement=config.settlement,
            expected_maker=maker,
            expected_order={
                "sell_token": sell_token,
                "sell_amount": sell_amount,
                "buy_token": buy_token,
                "min_buy_amount": min_buy_amount,
                "valid_after_ledger": valid_after_ledger,
                "expires_at_ledger": expires_at_ledger,
            },
            expected_executor_reward_xlm=expected_executor_reward_xlm,
            allowance_expiration_ledger=allowance_expiration_ledger,
            max_allowances=max_allowances,
            client=self,
            buy_asset=to,
        )

    # -- Stellar quirks, absorbed --------------------------------------------------

    def ensure_trustline(self, asset: Asset) -> None:
        """Create the trustline if the signer's account doesn't hold one. No-op for native."""
        if asset.is_native:
            return
        classic = asset.to_classic()  # rejects contract-only assets before any network call
        signer = self._require_signer()
        source = signer_public_key(signer)
        account = self._fetch_horizon_account(source)
        for balance in account["balances"]:
            if balance.get("asset_code") == asset.code and balance.get("asset_issuer") == asset.issuer:
                return
        tx = self.engine.build_transaction(
            source,
            lambda b: b.append_change_trust_op(asset=classic),
        )
        self.engine.sign_and_submit(tx, signer)

    def fund_with_friendbot(self) -> None:
        """Fund with 10,000 test XLM, then wait up to 30s for Horizon and RPC visibility.

        Testnet only. A readiness timeout does not mean funding failed.
        """
        if self.network.passphrase != NETWORKS["testnet"].passphrase:
            raise AquariusError("Friendbot funds testnet accounts only")
        signer = self._require_signer()
        source = signer_public_key(signer)
        response = requests.get(
            _FRIENDBOT_URL, params={"addr": source}, timeout=30
        )
        if not response.ok:
            raise AquariusError(f"Friendbot funding failed: HTTP {response.status_code}")
        self._wait_for_account_ready(source)

    def _wait_for_account_ready(self, public_key: str) -> None:
        deadline = time.monotonic() + 30

        def remaining() -> float:
            seconds = deadline - time.monotonic()
            if seconds <= 0:
                raise AquariusError(
                    "Timed out waiting for funded account visibility on Horizon and RPC"
                )
            return seconds

        # Only account absence is retryable here. Keep this transport separate
        # so HTTP retries/timeouts for transaction submission are unchanged.
        rpc_client = RequestsClient(num_retries=0)
        with SorobanServer(self.network.rpc_url, client=rpc_client) as server:
            while True:
                response = requests.get(
                    f"{self.network.horizon_url}/accounts/{public_key}", timeout=remaining()
                )
                if not response.ok and response.status_code != 404:
                    raise AquariusError(f"Account lookup failed: HTTP {response.status_code}")
                if response.ok:
                    rpc_client.post_timeout = remaining()
                    try:
                        server.load_account(public_key)
                    except AccountNotFoundException:
                        pass
                    else:
                        remaining()
                        return
                time.sleep(min(1, remaining()))

    def wait_for_next_ledger(self, ledger: int | None = None, timeout: float = 30.0) -> int:
        """Wait until the RPC's latest ledger is greater than ``ledger``; return
        the latest ledger observed.

        Call it before a follow-up call whose simulation depends on ledger-time
        state changed by a previous transaction — e.g. a withdraw or claim
        right after a deposit into a pool with rewards. Simulation runs on the
        latest ledger's state, but the transaction applies in a later one. The
        rewards contract rewrites the user's reward entry only when rewards
        accrued since the user's last checkpoint, so a withdraw simulated on the
        deposit's own ledger declares that entry read-only, and the transaction
        fails on-chain once time has advanced.

        ledger: defaults to the ledger of this client's last on-chain
        transaction (confirmed or failed); if there is none, to the RPC's
        current latest ledger, i.e. simply wait for the next ledger.

        timeout: seconds; raises ``AquariusError`` when the RPC has not moved
        past ``ledger`` by then. Polls ``getHealth`` about once a second.
        """
        return self.engine.wait_for_next_ledger(ledger, timeout)

    # -- escape hatches ---------------------------------------------------------------

    def contract_call(
        self, fn: str, *args: SCVal, auth: list[SorobanAuthorizationEntry] | None = None,
    ):
        """Raw router invocation with fixed auth; return a decoded result.

        By default only the root call is authorized by the source account.
        Supply ``auth`` for nested calls, or ``[]`` for a call requiring no
        authorization. Missing permissions fail during enforced simulation.
        """
        parameters = list(args)
        if auth is None:
            auth = [source_account_entry(
                authorized_invocation(self.network.router, fn, parameters)
            )]
        result = self._submit_router(fn, parameters, auth=auth)
        return scval.to_native(result.return_value) if result.return_value is not None else None

    # -- pools & positions ---------------------------------------------------------------

    def pools_for_pair(self, a: Asset, b: Asset) -> list[Pool]:
        """Every pool for the token pair, discovered on-chain, labeled via the API."""
        tokens = sort_token_ids([
            a.contract_id(self.network.passphrase),
            b.contract_id(self.network.passphrase),
        ])
        value = self._read_router("get_pools", [
            scval.to_vec([scval.to_address(t) for t in tokens])
        ])
        by_hash = parse_pools_map(value)
        if not by_hash:
            return []
        meta = {m["address"]: m for m in self.api.pools_by_addresses(list(by_hash.values()))}
        pools = [
            self._make_pool(pool_hash, address, tokens, meta.get(address))
            for pool_hash, address in by_hash.items()
        ]
        order = {"volatile": 0, "stable": 1, "concentrated": 2}
        return sorted(pools, key=lambda p: (order.get(p.type, 3), p.fee_bps))

    def positions(self, address: str | None = None) -> list[Position]:
        """Every pool where the address holds shares (default: the signer's account).

        Backed by the indexer — a deposit that just confirmed can take a few
        seconds to appear. Share amounts are read from the chain.
        """
        holder = address or self._read_source(require_signer=True)
        positions = []
        for entry in self.api.user_pools(holder):
            pool = self._make_pool(
                bytes.fromhex(entry["index"]),
                entry["address"],
                entry["tokens_addresses"],
                entry,
            )
            shares = pool.share_balance(holder)
            if shares > 0:
                positions.append(Position(pool=pool, shares=shares))
        return positions

    def _make_pool(self, pool_hash: bytes, address: str, tokens: list[str], meta: dict | None) -> Pool:
        from .pool import _POOL_TYPES

        if meta is not None:
            pool_type = _POOL_TYPES.get(meta["pool_type"], meta["pool_type"])
            fee_bps = round(float(meta["fee"]) * 10_000)
            labels = meta.get("tokens_str", [])
        else:  # pool not indexed yet — read type and fee from the contract
            info = self._read_router("get_info", [
                scval.to_vec([scval.to_address(t) for t in tokens]),
                scval.to_bytes(pool_hash),
            ])
            fields = {}
            for item in info.map.sc_map:
                key = item.key.sym.sc_symbol.decode()
                fields[key] = item.val
            pool_type = _POOL_TYPES.get(
                fields["pool_type"].sym.sc_symbol.decode(),
                fields["pool_type"].sym.sc_symbol.decode(),
            )
            fee_bps = fields["fee"].u32.uint32
            labels = []
        return Pool(
            address=address,
            pool_hash=pool_hash,
            type=pool_type,
            fee_bps=fee_bps,
            tokens=list(tokens),
            token_labels=labels,
            _client=self,
        )

    # -- read/submit plumbing shared with Pool ---------------------------------------------

    def _read_source(self, require_signer: bool = False) -> str:
        if self.signer is not None:
            return signer_public_key(self.signer)
        if require_signer:
            raise AquariusError("This operation requires a signer — pass one in the client config")
        return self.network.read_source

    def _read_router(self, fn: str, args: list[SCVal]) -> SCVal:
        return self._read_contract(self.network.router, fn, args)

    def _read_contract(
        self, contract_id: str, fn: str, args: list[SCVal], *, allow_restore: bool = True,
    ) -> SCVal:
        return self.engine.read(
            self._read_source(),
            lambda b: b.append_invoke_contract_function_op(
                contract_id=contract_id, function_name=fn, parameters=args
            ),
            self.signer if allow_restore else None,
        )

    def _submit_router(
        self, fn: str, args: list[SCVal], *, auth: list[SorobanAuthorizationEntry],
    ):
        return self._submit_contract(self.network.router, fn, args, auth=auth)

    def _submit_contract(
        self, contract_id: str, fn: str, args: list[SCVal],
        *, auth: list[SorobanAuthorizationEntry],
    ):
        if not isinstance(auth, list):
            raise AquariusError("Contract submission requires an explicit authorization list")
        signer = self._require_signer()
        source = signer_public_key(signer)
        tx = self.engine.prepare(
            source,
            lambda b: b.append_invoke_contract_function_op(
                contract_id=contract_id, function_name=fn, parameters=args, auth=auth
            ),
            signer,
        )
        return self.engine.sign_and_submit(tx, signer)

    def assemble_transaction(self, transaction, operation, simulation):
        """Assemble a fixed operation with configured CPU and fee headroom.

        Uses the supplied simulation only; does not sign, submit or restore.
        """
        return self.engine._assemble(
            transaction, simulation, (operation.to_xdr_object().to_xdr(),)
        )

    # -- internals ---------------------------------------------------------------------

    def _swap_append(self, quote: Quote):
        """The swap invocation with explicit, client-built authorization.

        Mirrors the transaction shape of the Aquarius web app and the JS SDK:
        the router call and its token-transfer sub-invocation are authorized
        with exact amounts, so wallets present a bounded approval and the
        authorization content never depends on what simulation echoes back
        (assembly keeps pre-built auth and only fills in resources). For
        strict-receive the authorized transfer is max-in — the contract pulls
        the maximum and refunds the difference.
        """
        user = signer_public_key(self._require_signer())
        token_in = quote._params["from_"].contract_id(self.network.passphrase)
        provider_fee = quote._params.get("provider_fee")
        # With a provider fee the collector is the invoked contract: it pulls
        # the tokens from the user, takes its cut, and drives the router as
        # itself — so both the call and the bounded transfer target it.
        target = self.network.router if provider_fee is None else provider_fee.contract_id
        fn = "swap_chained" if quote.is_exact_input else "swap_chained_strict_receive"
        amount = quote.amount_in if quote.is_exact_input else quote.amount_out
        transfer_amount = quote.amount_in if quote.is_exact_input else quote.guard

        args = [scval.to_address(user)]
        if provider_fee is not None and provider_fee.recipient is not None:
            fn += "_to"
            args.append(scval.to_address(provider_fee.recipient))
        args.extend([
            SCVal.from_xdr(quote._parsed.swap_chain_xdr),
            scval.to_address(token_in),
            scval.to_uint128(amount),
            scval.to_uint128(quote.guard),
        ])
        if provider_fee is not None:
            args.append(scval.to_uint32(provider_fee.fee_fraction))

        transfer_invocation = authorized_invocation(token_in, "transfer", [
            scval.to_address(user),
            scval.to_address(target),
            scval.to_int128(transfer_amount),
        ])
        root_entry = source_account_entry(
            authorized_invocation(target, fn, args, [transfer_invocation])
        )

        return lambda b: b.append_invoke_contract_function_op(
            contract_id=target,
            function_name=fn,
            parameters=args,
            auth=[root_entry],
        )

    def _build_unsigned(self, quote: Quote) -> str:
        source = signer_public_key(self._require_signer())
        tx = self.engine.prepare(source, self._swap_append(quote), self.signer)
        return tx.to_xdr()

    def _execute(self, quote: Quote) -> Receipt:
        signer = self._require_signer()
        source = signer_public_key(signer)
        try:
            tx = self.engine.prepare(source, self._swap_append(quote), signer)
            result = self.engine.sign_and_submit(tx, signer)
            returned = scval.from_uint128(result.return_value)
            if quote.is_exact_input:
                return Receipt(result.tx_hash, quote.amount_in, returned)
            return Receipt(result.tx_hash, returned, quote.amount_out)
        except SlippageError as error:
            error.attach_requote(lambda: self.quote(
                quote._params["from_"],
                quote._params["to"],
                amount_in=quote._params["amount_in"],
                amount_out=quote._params["amount_out"],
                slippage=quote._params["slippage"],
                provider_fee=quote._params["provider_fee"],
            ))
            raise

    def _prepare_limit_order_fill(
        self,
        record: LimitOrderRecord,
        swap_chain_xdr: str,
        *,
        reward_to: str | None = None,
    ) -> PreparedLimitOrderFill:
        """Simulate and assemble a permissionless V1 fill without submitting it."""
        self._validate_limit_order_context(record)
        if record.status != "OPEN":
            raise AquariusError("only an open limit order can be filled")
        signer = self._require_signer()
        filler = signer_public_key(signer)
        recipient = reward_to or filler
        if recipient != filler:
            raise AquariusError(
                "the SDK requires the execution fee to pay the transaction signer"
            )
        auth = [record.authorization] if record.authorization is not None else []
        transaction = self.engine.build_transaction(
            filler,
            lambda builder: builder.append_invoke_contract_function_op(
                contract_id=record.settlement_address,
                function_name="fill",
                parameters=fill_parameters(record, recipient, swap_chain_xdr),
                auth=auth,
            ),
        )
        expected_operations = self.engine._operation_xdr(transaction)
        simulation = self.server.simulate_transaction(transaction, auth_mode=AuthMode.ENFORCE)
        if simulation.restore_preamble is not None:
            raise AquariusError("limit-order fill requires footprint restoration")
        if simulation.error is not None:
            raise AquariusError(f"limit-order fill simulation failed: {simulation.error}")
        if not isinstance(simulation.results, list) or len(simulation.results) != 1:
            raise AquariusError(
                "limit-order fill simulation returned an invalid result count"
            )
        try:
            result_value = SCVal.from_xdr(simulation.results[0].xdr)
        except Exception as exc:
            raise AquariusError(
                "limit-order fill simulation returned an invalid receipt"
            ) from exc
        receipt = validate_fill_receipt(record, recipient, result_value)
        expected_auth = [entry.to_xdr() for entry in auth]
        rpc_auth = simulation.results[0].auth or []
        if rpc_auth and rpc_auth != expected_auth:
            raise AquariusError("limit-order simulation changed authorization")
        prepared = self.engine._assemble(transaction, simulation, expected_operations)
        maximum_fee = prepared.transaction.fee
        if maximum_fee >= record.order.executor_reward_xlm:
            raise AquariusError(
                f"fill maximum fee {maximum_fee} is not below execution fee "
                f"{record.order.executor_reward_xlm}"
            )
        return PreparedLimitOrderFill(
            order=record,
            receipt=receipt,
            maximum_fee=maximum_fee,
            transaction_xdr=prepared.to_xdr(),
            _transaction=prepared,
            _client=self,
        )

    def _build_limit_order_cancel(self, record: LimitOrderRecord) -> str:
        self._limit_order_maker_signer(record)
        transaction = self.engine.prepare(
            record.order.maker,
            self._limit_order_cancel_append(record),
        )
        return transaction.to_xdr()

    def _cancel_limit_order(
        self, record: LimitOrderRecord
    ) -> OnchainLimitOrderReceipt:
        signer = self._limit_order_maker_signer(record)
        transaction = self.engine.prepare(
            record.order.maker,
            self._limit_order_cancel_append(record),
            signer,
        )
        result = self.engine.sign_and_submit(transaction, signer)
        return OnchainLimitOrderReceipt(record.order_id, result.tx_hash)

    def _limit_order_cancel_append(self, record: LimitOrderRecord):
        args = [record.order.order_scval]
        auth = [source_account_entry(authorized_invocation(record.settlement_address, "cancel", args))]
        return lambda builder: builder.append_invoke_contract_function_op(
            contract_id=record.settlement_address,
            function_name="cancel",
            parameters=args,
            auth=auth,
        )

    def _limit_order_maker_signer(self, record: LimitOrderRecord):
        self._validate_limit_order_context(record)
        signer = self._require_signer()
        if signer_public_key(signer) != record.order.maker:
            raise AquariusError("the signer is not the limit-order maker")
        return signer

    def _onchain_limit_order_append(self, order: OnchainLimitOrder):
        config = self._require_limit_order_config(require_batcher=True)
        if (
            order.settlement_address != config.settlement
            or order.network_passphrase != self.network.passphrase
            or order.maker != signer_public_key(self._require_signer())
        ):
            raise AquariusError("limit order does not match the client execution context")
        if self.get_limit_order_executor_reward() != order.executor_reward_xlm:
            raise AquariusError("settlement executor reward changed; review the order again")
        xlm_token = Asset.native().contract_id(self.network.passphrase)
        current_allowances = {}
        for token in order.required_allowances(xlm_token):
            value = self._read_contract(
                token,
                "allowance",
                [
                    scval.to_address(order.maker),
                    scval.to_address(order.settlement_address),
                ],
                # No signing (including restoration) before allowance limits pass.
                allow_restore=False,
            )
            current_allowances[token] = scval.from_int128(value)
        args = build_onchain_placement_args(order, current_allowances, xlm_token)
        calls = []
        for call in scval.from_vec(args[1]):
            target, name, parameters = scval.from_vec(call)
            function_name = scval.from_symbol(name)
            auth_args = scval.from_vec(parameters)
            # Settlement commits only (order_id, expires_at_ledger) in require_auth_for_args.
            if function_name == "place_contract_order":
                auth_args = auth_args[1:]
            calls.append(authorized_invocation(
                Address.from_xdr_sc_address(target.address).address,
                function_name, auth_args,
            ))
        auth = [source_account_entry(authorized_invocation(config.batcher, "batch", args, calls))]
        return lambda builder: builder.append_invoke_contract_function_op(
            contract_id=config.batcher,
            function_name="batch",
            parameters=args,
            auth=auth,
        )

    def _build_onchain_limit_order(self, order: OnchainLimitOrder) -> str:
        source = signer_public_key(self._require_signer())
        tx = self.engine.prepare(
            source,
            self._onchain_limit_order_append(order),
        )
        return tx.to_xdr()

    def _place_onchain_limit_order(
        self, order: OnchainLimitOrder
    ) -> OnchainLimitOrderReceipt:
        signer = self._require_signer()
        source = signer_public_key(signer)
        tx = self.engine.prepare(
            source,
            self._onchain_limit_order_append(order),
            signer,
        )
        result = self.engine.sign_and_submit(tx, signer)
        return OnchainLimitOrderReceipt(order.order_id, result.tx_hash)

    def _onchain_limit_order_cancel_append(self, order: OnchainLimitOrder):
        args = [order.order_scval]
        auth = [source_account_entry(authorized_invocation(order.settlement_address, "cancel", args))]
        return lambda builder: builder.append_invoke_contract_function_op(
            contract_id=order.settlement_address,
            function_name="cancel",
            parameters=args,
            auth=auth,
        )

    def _build_onchain_limit_order_cancel(self, order: OnchainLimitOrder) -> str:
        source = signer_public_key(self._require_signer())
        tx = self.engine.prepare(
            source,
            self._onchain_limit_order_cancel_append(order),
        )
        return tx.to_xdr()

    def _cancel_onchain_limit_order(
        self, order: OnchainLimitOrder
    ) -> OnchainLimitOrderReceipt:
        signer = self._require_signer()
        source = signer_public_key(signer)
        tx = self.engine.prepare(
            source,
            self._onchain_limit_order_cancel_append(order),
            signer,
        )
        result = self.engine.sign_and_submit(tx, signer)
        return OnchainLimitOrderReceipt(order.order_id, result.tx_hash)

    def _fetch_horizon_account(self, public_key: str) -> dict:
        response = requests.get(f"{self.network.horizon_url}/accounts/{public_key}", timeout=30)
        if not response.ok:
            raise AquariusError(f"Account lookup failed: HTTP {response.status_code}")
        return response.json()

    def _require_signer(self):
        if self.signer is None:
            raise AquariusError("This operation requires a signer — pass one in the client config")
        return self.signer

    def _limit_order_api_url(self) -> str:
        config = self._require_limit_order_config()
        url = config.api_url or self.network.limit_orders_api_url
        if url is None:
            raise AquariusError("No limit-order API URL configured for this network")
        return url

    def _parse_limit_order_record(self, payload: dict) -> LimitOrderRecord:
        config = self._require_limit_order_config()
        return parse_limit_order_record(
            payload,
            network_passphrase=self.network.passphrase,
            settlement_address=config.settlement,
            xlm_token=Asset.native().contract_id(self.network.passphrase),
            client=self,
        )

    def _validate_limit_order_context(self, record: LimitOrderRecord) -> None:
        config = self._require_limit_order_config()
        if record.settlement_address != config.settlement:
            raise AquariusError("limit order targets another settlement contract")
        expected_network_id = Network(self.network.passphrase).network_id().hex()
        if record.network_id != expected_network_id:
            raise AquariusError("limit order targets another network")
        if not record.raw:
            raise AquariusError("limit-order record has no canonical registry payload")
        validated = self._parse_limit_order_record(record.raw)
        if (
            validated.order_id != record.order_id
            or validated.status != record.status
            or validated.order.order_scval.to_xdr_bytes()
            != record.order.order_scval.to_xdr_bytes()
            or (
                validated.authorization.to_xdr()
                if validated.authorization is not None
                else None
            )
            != (
                record.authorization.to_xdr()
                if record.authorization is not None
                else None
            )
        ):
            raise AquariusError("limit-order record differs from its canonical payload")

    def _require_limit_order_config(
        self, *, require_batcher: bool = False
    ) -> LimitOrderConfig:
        if self.limit_order_config is None:
            raise AquariusError(
                "Limit orders require trusted settlement configuration"
            )
        if require_batcher and self.limit_order_config.batcher is None:
            raise AquariusError(
                "On-chain placement requires trusted batcher configuration"
            )
        return self.limit_order_config
