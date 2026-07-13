from __future__ import annotations

from dataclasses import dataclass, field

import requests
from stellar_sdk import Asset as _StellarAsset, Keypair, Network, Server, SorobanServer, TransactionBuilder, scval
from stellar_sdk.xdr import SCVal, TransactionMeta

from .assets import Asset
from .errors import NoRouteError, SlippageError

_NETWORKS = {
    "mainnet": dict(
        router="CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
        api="https://amm-api.aqua.network/api/external/v2",
        rpc="https://mainnet.sorobanrpc.com",
        horizon="https://horizon.stellar.org",
        passphrase=Network.PUBLIC_NETWORK_PASSPHRASE,
    ),
    "testnet": dict(
        router="CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
        api="https://amm-api-testnet.aqua.network/api/external/v2",
        rpc="https://soroban-testnet.stellar.org:443",
        horizon="https://horizon-testnet.stellar.org",
        passphrase=Network.TESTNET_NETWORK_PASSPHRASE,
    ),
}


@dataclass
class Receipt:
    tx_hash: str
    amount_in: int   # stroops actually spent
    amount_out: int  # stroops actually received


@dataclass
class Quote:
    amount_in: int
    amount_out: int
    guard: int              # min_out (exact-input) or max_in (exact-output)
    route: list[str]        # pool addresses along the path
    is_exact_input: bool
    _xdr: str = field(repr=False)
    _token_in: str = field(repr=False)
    _client: "AquariusClient" = field(repr=False)

    def execute(self) -> Receipt:
        """Build, sign, submit, confirm, and parse the swap this quote describes."""
        return self._client._execute(self)


class AquariusClient:
    def __init__(self, network: str = "mainnet", signer: Keypair | None = None):
        cfg = _NETWORKS[network]
        self.network = network
        self.router = cfg["router"]
        self.api = cfg["api"]
        self.passphrase = cfg["passphrase"]
        self.horizon = Server(cfg["horizon"])
        self.rpc = SorobanServer(cfg["rpc"])
        self.signer = signer

    # -- reads (no signer required) -------------------------------------------

    def quote(self, from_: Asset, to: Asset, *, amount_in: int | None = None,
              amount_out: int | None = None, slippage: float = 0.01) -> Quote:
        """Best route for a swap. Pass amount_in (exact input) or amount_out (exact output)."""
        if (amount_in is None) == (amount_out is None):
            raise ValueError("pass exactly one of amount_in / amount_out")
        is_exact_input = amount_in is not None
        endpoint = "/find-path/" if is_exact_input else "/find-path-strict-receive/"
        response = requests.post(f"{self.api}{endpoint}", json={
            "token_in_address": from_.contract_id(self.passphrase),
            "token_out_address": to.contract_id(self.passphrase),
            "amount": str(amount_in if is_exact_input else amount_out),
        }).json()
        return self._parse_find_path(response, from_, to,
                                     amount_in=amount_in, amount_out=amount_out,
                                     slippage=slippage)

    # -- writes ----------------------------------------------------------------

    def swap(self, from_: Asset, to: Asset, **kwargs) -> Receipt:
        """quote() + execute() in one call, for bots."""
        return self.quote(from_, to, **kwargs).execute()

    # -- Stellar quirks, absorbed ----------------------------------------------

    def ensure_trustline(self, asset: Asset) -> None:
        """Create the trustline if the signer's account doesn't hold one. No-op for native."""
        if asset.is_native:
            return
        account = self.horizon.accounts().account_id(self.signer.public_key).call()
        for b in account["balances"]:
            if b.get("asset_code") == asset.code and b.get("asset_issuer") == asset.issuer:
                return
        tx = (TransactionBuilder(self.horizon.load_account(self.signer.public_key),
                                 network_passphrase=self.passphrase, base_fee=100)
              .append_change_trust_op(asset=_StellarAsset(asset.code, asset.issuer))
              .set_timeout(60).build())
        tx.sign(self.signer)
        self.horizon.submit_transaction(tx)

    def fund_with_friendbot(self) -> None:
        """Testnet only: fund the signer's account with 10,000 test XLM."""
        requests.get("https://friendbot.stellar.org",
                     params={"addr": self.signer.public_key}).raise_for_status()

    # -- internals ---------------------------------------------------------------

    def _parse_find_path(self, response: dict, from_: Asset, to: Asset, *,
                         amount_in: int | None, amount_out: int | None,
                         slippage: float) -> Quote:
        if not response.get("success"):
            raise NoRouteError(f"no route {from_} -> {to}")
        token_in = from_.contract_id(self.passphrase)
        if amount_in is not None:
            out = int(response["amount"])
            return Quote(amount_in, out, int(out * (1 - slippage)), response["pools"],
                         True, response["swap_chain_xdr"], token_in, self)
        required_in = int(response["amount"])
        return Quote(required_in, amount_out, int(required_in * (1 + slippage)), response["pools"],
                     False, response["swap_chain_xdr"], token_in, self)

    def _execute(self, q: Quote) -> Receipt:
        fn = "swap_chained" if q.is_exact_input else "swap_chained_strict_receive"
        amount = q.amount_in if q.is_exact_input else q.amount_out
        try:
            tx = self.rpc.prepare_transaction(
                TransactionBuilder(self.horizon.load_account(self.signer.public_key),
                                   network_passphrase=self.passphrase, base_fee=10000)
                .append_invoke_contract_function_op(
                    contract_id=self.router, function_name=fn,
                    parameters=[
                        scval.to_address(self.signer.public_key),
                        SCVal.from_xdr(q._xdr),
                        scval.to_address(q._token_in),
                        scval.to_uint128(amount),
                        scval.to_uint128(q.guard),
                    ])
                .set_timeout(300).build())
        except Exception as e:  # surface the two guard errors as a typed, retryable error
            if "#2006" in str(e) or "#2020" in str(e):
                raise SlippageError("price moved past your guard — re-quote and retry") from e
            raise
        tx.sign(self.signer)
        resp = self.horizon.submit_transaction(tx)
        meta = TransactionMeta.from_xdr(self.rpc.get_transaction(resp["id"]).result_meta_xdr)
        soroban_meta = meta.v4.soroban_meta if meta.v == 4 else meta.v3.soroban_meta
        result = scval.from_uint128(soroban_meta.return_value)
        if q.is_exact_input:
            return Receipt(resp["id"], q.amount_in, result)
        return Receipt(resp["id"], result, q.amount_out)
