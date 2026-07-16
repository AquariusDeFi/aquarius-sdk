# aquarius-sdk

The Python SDK for [Aquarius](https://aqua.network) — swaps, liquidity, and rewards on Stellar.

**Status: 0.3.x — swaps, provider-fee collectors, and the liquidity lifecycle are available.** Concentrated liquidity position management is not covered yet. The API may still change before 1.0.

```bash
pip install aquarius-sdk
```

```python
from stellar_sdk import Keypair
from aquarius import AquariusClient, Asset, XLM, SlippageError

AQUA = Asset.classic("AQUA", "GBNZ...AQUA")

aqua = AquariusClient(network="mainnet", signer=Keypair.from_secret(secret))

# exact input: quote, inspect, execute
quote = aqua.quote(XLM, AQUA, amount_in=100_0000000, slippage=0.01)
receipt = quote.execute()

# exact output: pass amount_out instead — strict-receive throughout
quote = aqua.quote(XLM, AQUA, amount_out=500_0000000)
```

## Provider fees

Pass the collector configuration with the quote. The SDK keeps the fee math exact, routes through the collector, and sends output to `recipient` without requiring that address to sign:

```python
from aquarius import ProviderFeeConfig

provider_fee = ProviderFeeConfig(
    contract_id="C...",
    fee_fraction=30,
    fee_denominator=10_000,
    recipient="G...",
)

quote = aqua.quote(
    XLM,
    AQUA,
    amount_in=100_0000000,
    slippage=0.005,
    provider_fee=provider_fee,
)
receipt = quote.execute()
```

Omit `recipient` to send output back to the signer through the collector's legacy swap methods. Use `amount_out` instead of `amount_in` for an exact-output provider swap.

## Liquidity

```python
pools = aqua.pools_for_pair(XLM, AQUA)          # discovered on-chain, sorted by type and fee
pool = pools[0]                                  # Pool(type="volatile", fee_bps=10, ...)

result = pool.deposit({XLM: 50_0000000, AQUA: 2500_0000000}, slippage=0.01)
print(result.shares)                             # pool share tokens minted

pool.pending_rewards()                           # accrued AQUA, in stroops
pool.claim_rewards()
pool.withdraw(result.shares, slippage=0.01)

aqua.positions()                                 # every pool where the signer holds shares
```

Deposit and withdrawal guards come from a simulation of the exact call, reduced by `slippage` — quoted-versus-executed drift is bounded the same way as for swaps. Reads (`reserves()`, `pending_rewards()`, `pools_for_pair()`) need no signer.

## What the SDK handles for you

- **Routing** — quotes come from the find-path API; the swap chain XDR is passed through untouched.
- **Transaction lifecycle** — simulation, assembly, submission with congestion retries (same-hash resubmission with backoff), and confirmation polling.
- **Archived state** — if simulation reports expired ledger entries, the SDK restores them (one extra signed transaction) and retries automatically.
- **Typed errors** — `SlippageError` (with `requote()`), `PausedError` (kill switches — not your bug), `NoRouteError`, `UserRejectedError`, `TxTimeoutError`.

## Signers

A stellar-sdk `Keypair` works as-is. Custom signers provide `public_key` plus `sign(tx_xdr) -> str` returning the signed envelope XDR. Reads — `quote()` — need no signer at all.

## Escape hatches

`quote.build_transaction()` returns the simulated, unsigned envelope XDR for external signing flows. `client.contract_call(fn, *scvals)` invokes the router raw. `client.api` is the typed REST client.

## Amounts

All amounts are integers in token base units (stroops for classic assets: 1 token = 10^7).

Questions and integration help: [Discord](https://discord.gg/sgzFscHp4C).
