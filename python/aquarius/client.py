from __future__ import annotations

from dataclasses import dataclass, field

import requests
from stellar_sdk import Asset as StellarAsset, SorobanServer, scval
from stellar_sdk.xdr import SCVal

from .api import ApiClient, ParsedRoute, parse_find_path_response
from .assets import Asset
from .errors import AquariusError, SlippageError
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
        for attempt in range(retries + 1):
            try:
                return self.quote(from_, to, **kwargs).execute()
            except SlippageError:
                if attempt == retries:
                    raise

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

    # -- not yet implemented ------------------------------------------------------------

    def pools_for_pair(self, *_args, **_kwargs):
        raise AquariusError("Pool operations arrive in 0.2.0 — see the docs code examples meanwhile")

    def positions(self, *_args, **_kwargs):
        raise AquariusError("positions() arrives in 0.2.0 — see the docs code examples meanwhile")

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

    def _fetch_horizon_account(self, public_key: str) -> dict:
        response = requests.get(f"{self.network.horizon_url}/accounts/{public_key}", timeout=30)
        if not response.ok:
            raise AquariusError(f"Account lookup failed: HTTP {response.status_code}")
        return response.json()

    def _require_signer(self):
        if self.signer is None:
            raise AquariusError("This operation requires a signer — pass one in the client config")
        return self.signer
