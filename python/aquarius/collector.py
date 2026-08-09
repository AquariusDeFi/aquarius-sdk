"""Provider-fee collectors: deploy, read, and claim partner swap fees.

A collector accumulates the provider's cut as plain token balances (the fee
is taken from each swap's output token); claims are per token, operator-gated
by the contract, and always pay out to the collector's baked-in
fee_destination. claim_and_swap converts through the router along a quoted
route first, guarded by the quote's minimum.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from stellar_sdk import Address, scval
from stellar_sdk.xdr import SCVal

from .assets import Asset
from .authorization import authorized_invocation, source_account_entry
from .errors import AquariusError


@dataclass
class ClaimedFees:
    tx_hash: str
    amount_in: int   # collector balance claimed, in the claimed token
    amount_out: int  # paid to fee_destination (equals amount_in for plain claims)


@dataclass
class FeeCollector:
    """One deployed provider-fee collector contract."""

    address: str
    _client: object = field(repr=False)

    # -- reads (no signer required) --------------------------------------------

    def fee_destination(self) -> str:
        """Where every claim pays out — fixed at deploy time."""
        value = self._client._read_contract(self.address, "get_fee_destination", [])
        return Address.from_xdr_sc_address(value.address).address

    def router(self) -> str:
        value = self._client._read_contract(self.address, "get_router", [])
        return Address.from_xdr_sc_address(value.address).address

    def max_fee_fraction(self) -> int:
        """Upper bound for the per-swap fee_fraction this collector accepts."""
        value = self._client._read_contract(self.address, "get_max_swap_fee_fraction", [])
        return value.u32.uint32

    def balance(self, asset) -> int:
        """Accrued, unclaimed fees in the given token, in base units."""
        token = self._token_id(asset)
        value = self._client._read_contract(
            token, "balance", [scval.to_address(self.address)]
        )
        return scval.from_int128(value)

    def fee_config(self, fee_fraction: int, *, recipient: str | None = None,
                   denominator: int = 10_000):
        """A ProviderFeeConfig routing swaps through this collector.

        The fee is the fraction ``fee_fraction / denominator`` of each
        swap's output: ``fee_config(10)`` is 10/10_000 = **0.1%**,
        ``fee_config(30)`` is 0.3%. ``denominator`` must match the value
        the collector was deployed with — there is no getter for it, and
        deployments differ (the docs use 10_000; LOBSTR's production
        collector uses 100_000, where 0.1% is ``fee_config(100,
        denominator=100_000)``).
        """
        from .client import ProviderFeeConfig

        return ProviderFeeConfig(
            contract_id=self.address,
            fee_fraction=fee_fraction,
            fee_denominator=denominator,
            recipient=recipient,
        )

    # -- writes (the signer must be the collector's operator) ---------------------

    def claim(self, asset) -> ClaimedFees:
        """Sweep the collector's entire balance of one token to fee_destination."""
        token = self._token_id(asset)
        args = [
            scval.to_address(self._client._read_source(require_signer=True)),
            scval.to_address(token),
        ]
        confirmed = self._submit("claim_fees", args)
        amount = scval.from_uint128(confirmed.return_value)
        return ClaimedFees(confirmed.tx_hash, amount, amount)

    def claim_and_swap(self, asset, to, *, slippage: float = 0.01) -> ClaimedFees:
        """Claim one token, swap it through the router, pay out the output token.

        The route and the minimum-out guard come from a fresh quote for the
        collector's current balance; the contract swaps its balance at
        execution time, so fees accrued in between ride along under the guard.
        """
        amount = self.balance(asset)
        if amount <= 0:
            raise AquariusError("Nothing to claim: the collector holds none of this token")
        quote = self._client.quote(
            self._as_asset(asset), self._as_asset(to),
            amount_in=amount, slippage=slippage,
        )
        args = [
            scval.to_address(self._client._read_source(require_signer=True)),
            SCVal.from_xdr(quote._parsed.swap_chain_xdr),
            scval.to_address(self._token_id(asset)),
            scval.to_uint128(quote.guard),
        ]
        confirmed = self._submit("claim_fees_and_swap", args)
        return ClaimedFees(
            confirmed.tx_hash, amount, scval.from_uint128(confirmed.return_value)
        )

    # -- internals ---------------------------------------------------------------

    def _submit(self, fn: str, args: list[SCVal]):
        # Root-only entry: the contract authorizes its own token movements
        # (authorize_as_current_contract), the operator only signs the call.
        return self._client._submit_contract(
            self.address, fn, args,
            auth=[source_account_entry(authorized_invocation(self.address, fn, args))],
        )

    def _token_id(self, asset) -> str:
        if isinstance(asset, Asset):
            return asset.contract_id(self._client.network.passphrase)
        return asset

    def _as_asset(self, asset) -> Asset:
        return asset if isinstance(asset, Asset) else Asset.contract(asset)
