from __future__ import annotations

import time
from dataclasses import dataclass, field

import requests
from stellar_sdk import Address, SorobanServer, scval
from stellar_sdk.client.requests_client import RequestsClient
from stellar_sdk.exceptions import AccountNotFoundException
from stellar_sdk.xdr import SCVal, SorobanAuthorizationEntry

from .api import ApiClient, ParsedRoute, parse_find_path_response
from .authorization import authorized_invocation, source_account_entry
from .assets import Asset
from .collector import FeeCollector
from .errors import AquariusError, SlippageError
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

    # -- reads (no signer required) -------------------------------------------

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

    def _read_contract(self, contract_id: str, fn: str, args: list[SCVal]) -> SCVal:
        return self.engine.read(
            self._read_source(),
            lambda b: b.append_invoke_contract_function_op(
                contract_id=contract_id, function_name=fn, parameters=args
            ),
            self.signer,
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

    def _fetch_horizon_account(self, public_key: str) -> dict:
        response = requests.get(f"{self.network.horizon_url}/accounts/{public_key}", timeout=30)
        if not response.ok:
            raise AquariusError(f"Account lookup failed: HTTP {response.status_code}")
        return response.json()

    def _require_signer(self):
        if self.signer is None:
            raise AquariusError("This operation requires a signer — pass one in the client config")
        return self.signer
