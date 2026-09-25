# aquarius-sdk

The Python SDK for [Aquarius](https://aqua.network) — swaps, liquidity, and rewards on Stellar.

**Status: 0.5.x — swaps and the liquidity lifecycle are complete and verified with real testnet transactions.** Concentrated liquidity position management is available as a beta surface (the contracts are under an ongoing external audit). The API may still change before 1.0.

## Swap through a specific pool

`client.quote()`/`swap()` route through the path-finding API. To pin a swap to
one pool you trust — your own routing, API independence — quote and swap on the
pool itself; the estimate comes from the router's on-chain `estimate_swap`:

```python
pool = next(p for p in client.pools_for_pair(XLM, AQUA) if p.fee_bps == 10)

quote = pool.quote(XLM, AQUA, amount_in=100_0000000)   # no signer needed
receipt = quote.execute()                              # swaps in this pool only
# or: pool.swap(XLM, AQUA, amount_in=100_0000000, retries=3)
```

Exact input only — the router has no single-pool strict-receive; for exact
output use `client.quote(..., amount_out=...)`.

## Concentrated liquidity positions (beta)

A position is the key `(owner, tick_lower, tick_upper)` on the pool contract — no
NFTs, merged on re-deposit, at most 20 ranges per account. Quotes come from the
contract's own estimators; `execute`/`withdraw_position` derive real slippage
guards from them:

```python
pool = next(p for p in aqua.pools_for_pair(XLM, AQUA) if p.type == "concentrated")

est = pool.estimate_position_deposit(
    {XLM: 10_0000000, AQUA: 100_0000000},
    price_range=("0.9", "1.1"),   # snaps to tick spacing; or tick_range=(lower, upper)
)
opened = est.execute(slippage=0.01)          # min-liquidity guard from the estimate

pool.position_ranges()                        # all of the signer's ranges
pool.position_range_status(est.tick_lower, est.tick_upper)  # in_range / below / above
pool.position_value(est.tick_lower, est.tick_upper)  # principal / fees / total, split
pool.claim_position_fees(est.tick_lower, est.tick_upper)
pool.withdraw_position(est.tick_lower, est.tick_upper)  # full close, auto-claims fees
```

`tick_from_price`, `price_at_tick`, and `snap_tick` are exported for range math —
integer-exact and identical across both language packages.

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
    fee_fraction=30,   # 30 / fee_denominator=10_000 -> 0.3% of the output
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

## Infrastructure

Defaults point at the protocol's own endpoints: the mainnet RPC is
`https://soroban-rpc.aqua.network` — the same node the Aquarius web app and
backend use. Running your own infrastructure? Every endpoint is overridable:

```python
aqua = AquariusClient(
    network="mainnet",
    rpc_url="https://your-rpc.example.com",
    horizon_url="https://your-horizon.example.com",
)
```

## Fees

`base_fee` (default `100_000` stroops) is the inclusion fee bid. On top of it,
every Soroban transaction declares a resource fee taken from simulation, raised
by `resource_fee_headroom` (default `0.5`, i.e. +50%; `0` disables):

```python
aqua = AquariusClient(network="mainnet", signer=signer, resource_fee_headroom=0.3)
```

The declared resource fee is a cap: the network charges the non-refundable part
plus the refundable part actually consumed (rent, events, return value) and
refunds the rest, so headroom costs nothing unless it is used. The refundable
part depends on ledger state at apply time, so the bare simulated fee can fall
short and fail the transaction on-chain with
`INVOKE_HOST_FUNCTION_INSUFFICIENT_REFUNDABLE_FEE`. The headroom is applied
before signing (also to automatic restore transactions and to
`quote.build_transaction()`), so wallets see and sign the final fee.

## Amounts

All amounts are integers in token base units (stroops for classic assets: 1 token = 10^7).

Questions and integration help: [Discord](https://discord.gg/sgzFscHp4C).
