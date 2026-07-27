from __future__ import annotations

from dataclasses import dataclass, field

import requests
from stellar_sdk import Asset as StellarAsset, SorobanServer, scval
from stellar_sdk.xdr import SCVal

from .api import ApiClient, ParsedRoute, parse_find_path_response
from .assets import Asset
from .errors import AquariusError, SlippageError
from .limit_orders import (
    LimitOrderConfig,
    OnchainLimitOrder,
    OnchainLimitOrderReceipt,
    build_onchain_placement_args,
    validate_onchain_limit_order_draft,
)
from .pool import Pool, Position, parse_pools_map, sort_token_ids
from .networks import NETWORKS, NetworkConfig
from .signer import signer_public_key
from .submit import SubmitEngine

_FRIENDBOT_URL = "https://friendbot.stellar.org"


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
        limit_orders: LimitOrderConfig | None = None,
    ):
        """timeout: transaction time bound in seconds, or "infinite".

        Default: 300 seconds when the signer is a local keypair (a stale bot
        transaction should expire, not execute later at a worse price);
        no bound when signing goes through a wallet (humans take their time).
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
            self.server, self.network.passphrase, base_fee, timeout=resolved_timeout
        )
        self.signer = signer
        self.limit_order_config = limit_orders

    # -- reads (no signer required) -------------------------------------------

    def latest_ledger(self) -> int:
        """Current Soroban RPC ledger sequence."""
        return self.server.get_latest_ledger().sequence

    def quote(
        self,
        from_: Asset,
        to: Asset,
        *,
        amount_in: int | None = None,
        amount_out: int | None = None,
        slippage: float = 0.01,
    ) -> Quote:
        """Best route for a swap. Pass amount_in (exact input) or amount_out (exact output)."""
        if (amount_in is None) == (amount_out is None):
            raise AquariusError("Pass exactly one of amount_in / amount_out")
        exact_input = amount_in is not None
        slippage_bps = round(slippage * 10_000)
        token_in = from_.contract_id(self.network.passphrase)
        token_out = to.contract_id(self.network.passphrase)

        response = self.api.find_path(
            {
                "token_in_address": token_in,
                "token_out_address": token_out,
                "amount": str(amount_in if exact_input else amount_out),
            },
            exact_input,
        )
        parsed = parse_find_path_response(
            response,
            amount_in=amount_in,
            amount_out=amount_out,
            slippage_bps=slippage_bps,
            pair_label=f"{from_} -> {to}",
        )
        params = dict(
            from_=from_, to=to, amount_in=amount_in, amount_out=amount_out, slippage=slippage
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
        Each attempt starts from a fresh quote. Default 0 — fail on the first
        guard breach.
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

    def create_onchain_limit_order(
        self,
        from_: Asset,
        to: Asset,
        *,
        sell_amount: int,
        min_buy_amount: int,
        valid_after_ledger: int,
        expires_at_ledger: int,
        allowance_expiration_ledger: int,
    ) -> OnchainLimitOrder:
        """Create a canonical API draft for programmatic G-account placement.

        allowance_expiration_ledger is explicit because SEP-41 allowance()
        exposes the amount but not the current expiration. Callers reusing an
        allowance should choose a horizon no earlier than their other orders.
        """
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
                "on-chain limit-order amounts must fit positive i128 values and ledgers must fit u32"
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
        config = self._require_limit_order_config()
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
            config.api_url or self.network.limit_orders_api_url,
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
            allowance_expiration_ledger=allowance_expiration_ledger,
            client=self,
        )

    # -- Stellar quirks, absorbed --------------------------------------------------

    def ensure_trustline(self, asset: Asset) -> None:
        """Create the trustline if the signer's account doesn't hold one. No-op for native."""
        if asset.is_native:
            return
        signer = self._require_signer()
        source = signer_public_key(signer)
        account = self._fetch_horizon_account(source)
        for balance in account["balances"]:
            if balance.get("asset_code") == asset.code and balance.get("asset_issuer") == asset.issuer:
                return
        tx = self.engine.build_transaction(
            source,
            lambda b: b.append_change_trust_op(asset=StellarAsset(asset.code, asset.issuer)),
        )
        self.engine.sign_and_submit(tx, signer)

    def fund_with_friendbot(self) -> None:
        """Testnet only: fund the signer's account with 10,000 test XLM."""
        if self.network.passphrase != NETWORKS["testnet"].passphrase:
            raise AquariusError("Friendbot funds testnet accounts only")
        signer = self._require_signer()
        response = requests.get(
            _FRIENDBOT_URL, params={"addr": signer_public_key(signer)}, timeout=30
        )
        if not response.ok:
            raise AquariusError(f"Friendbot funding failed: HTTP {response.status_code}")

    # -- escape hatches ---------------------------------------------------------------

    def contract_call(self, fn: str, *args: SCVal):
        """Raw router invocation. Arguments are SCVal values; the raw return SCVal comes back."""
        signer = self._require_signer()
        source = signer_public_key(signer)
        tx = self.engine.prepare(
            source,
            lambda b: b.append_invoke_contract_function_op(
                contract_id=self.network.router, function_name=fn, parameters=list(args)
            ),
            signer,
        )
        result = self.engine.sign_and_submit(tx, signer)
        return result.return_value

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

    def _read_contract(self, contract_id: str, fn: str, args: list[SCVal]) -> SCVal:
        return self.engine.read(
            self._read_source(),
            lambda b: b.append_invoke_contract_function_op(
                contract_id=contract_id, function_name=fn, parameters=args
            ),
            self.signer,
        )

    def _submit_router(self, fn: str, args: list[SCVal], with_user: bool = False):
        signer = self._require_signer()
        source = signer_public_key(signer)
        if with_user:
            args = [scval.to_address(source)] + args
        tx = self.engine.prepare(
            source,
            lambda b: b.append_invoke_contract_function_op(
                contract_id=self.network.router, function_name=fn, parameters=args
            ),
            signer,
        )
        return self.engine.sign_and_submit(tx, signer)

    # -- internals ---------------------------------------------------------------------

    def _swap_append(self, quote: Quote):
        token_in = quote._params["from_"].contract_id(self.network.passphrase)
        fn = "swap_chained" if quote.is_exact_input else "swap_chained_strict_receive"
        amount = quote.amount_in if quote.is_exact_input else quote.amount_out
        return lambda b: b.append_invoke_contract_function_op(
            contract_id=self.network.router,
            function_name=fn,
            parameters=[
                scval.to_address(signer_public_key(self._require_signer())),
                SCVal.from_xdr(quote._parsed.swap_chain_xdr),
                scval.to_address(token_in),
                scval.to_uint128(amount),
                scval.to_uint128(quote.guard),
            ],
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
            ))
            raise

    def _onchain_limit_order_append(self, order: OnchainLimitOrder):
        config = self._require_limit_order_config()
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
            )
            current_allowances[token] = scval.from_int128(value)
        args = build_onchain_placement_args(order, current_allowances, xlm_token)
        return lambda builder: builder.append_invoke_contract_function_op(
            contract_id=config.batcher,
            function_name="batch",
            parameters=args,
        )

    def _build_onchain_limit_order(self, order: OnchainLimitOrder) -> str:
        source = signer_public_key(self._require_signer())
        tx = self.engine.prepare(
            source,
            self._onchain_limit_order_append(order),
            self.signer,
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
        return lambda builder: builder.append_invoke_contract_function_op(
            contract_id=order.settlement_address,
            function_name="cancel",
            parameters=[order.order_scval],
        )

    def _build_onchain_limit_order_cancel(self, order: OnchainLimitOrder) -> str:
        source = signer_public_key(self._require_signer())
        tx = self.engine.prepare(
            source,
            self._onchain_limit_order_cancel_append(order),
            self.signer,
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

    def _require_limit_order_config(self) -> LimitOrderConfig:
        if self.limit_order_config is None:
            raise AquariusError(
                "On-chain limit orders require trusted settlement and batcher configuration"
            )
        return self.limit_order_config
