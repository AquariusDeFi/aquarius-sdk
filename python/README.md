# aquarius-sdk

The Python SDK for [Aquarius](https://aqua.network) — swaps, liquidity, and rewards on Stellar.

**Status: 0.3.x — swaps and the liquidity lifecycle are complete and verified with real testnet transactions.** Limit-order placement, registry reads, cancellation, and permissionless filling are a PoC with unit/fixture coverage. Concentrated liquidity position management is not covered yet. The API may still change before 1.0.

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

## Programmatic on-chain limit orders

The web application uses detached/off-chain placement. Bots and blockchain
integrations can opt into `CONTRACT_ONCHAIN` by supplying trusted settlement and
batcher addresses:

```python
import os

from aquarius import (
    AquariusClient,
    LimitOrderConfig,
    NoRouteError,
    XLM,
    parse_find_path_response,
)

aqua = AquariusClient(
    network="testnet",
    signer=signer,
    limit_orders=LimitOrderConfig(
        settlement=os.environ["AQUARIUS_LIMIT_ORDER_SETTLEMENT"],
        batcher=os.environ["AQUARIUS_BATCHER"],
    ),
)
current_ledger = aqua.latest_ledger()
order = aqua.create_onchain_limit_order(
    XLM,
    AQUA,
    sell_amount=100_0000000,
    min_buy_amount=500_0000000,
    valid_after_ledger=current_ledger,
    expires_at_ledger=current_ledger + 17_280,
    allowance_expiration_ledger=current_ledger + 17_280,
)
receipt = order.place()
```

`allowance_expiration_ledger` is explicit because SEP-41 `allowance()` does not
return the existing expiration. Keep it at or beyond this order and every other
open order sharing the settlement allowance. It does not affect the order ID.
For custom C accounts, use `validate_onchain_limit_order_draft()` and
`build_onchain_placement_args()` with the account's own authorization policy.

`batcher` is required only for `CONTRACT_ONCHAIN` placement. Registry reads,
cancellation, and filling need the trusted settlement address:

```python
aqua = AquariusClient(
    network="testnet",
    signer=signer,
    limit_orders=LimitOrderConfig(
        settlement=os.environ["AQUARIUS_LIMIT_ORDER_SETTLEMENT"],
    ),
)

orders = aqua.open_limit_orders(maker=signer.public_key)
order = aqua.get_limit_order(orders[0].order_id)
order.cancel()
```

An independent filler can request an exact-send route and prepare execution:

```python
response = aqua.api.find_path(
    {
        "token_in_address": order.order.sell_token,
        "token_out_address": order.order.buy_token,
        "amount": str(order.order.sell_amount),
    },
    exact_input=True,
)
route = parse_find_path_response(
    response,
    amount_in=order.order.sell_amount,
    slippage_bps=0,
    pair_label=f"{order.order.sell_token} -> {order.order.buy_token}",
)
xlm_token = XLM.contract_id(aqua.network.passphrase)
if route.amount_out < order.order.required_router_min(xlm_token):
    raise NoRouteError("Current route does not meet the order minimum")

prepared = order.prepare_fill(route.swap_chain_xdr)
result = prepared.execute()
```

The existing generic path lookup and parser are reused unchanged. Route lookup
and limit policy are separate primitives. Before returning `prepared`, the SDK
validates the registry record, detached
`ADDRESS_V2` invocation tree or confirmed on-chain placement, settlement
receipt, maker minimum, exact execution fee, and maximum transaction fee.

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
