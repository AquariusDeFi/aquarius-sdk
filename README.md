# Aquarius SDK

Official SDKs for building on [Aquarius](https://aqua.network) — swaps, liquidity, and rewards on Stellar, in Python and TypeScript.

**Status: 0.2.x.** Swaps (quote → execute in both modes) and the liquidity lifecycle — pool discovery, deposit, withdraw, rewards, positions — are complete in both languages, each verified end to end with real testnet transactions. Limit-order placement, registry reads, cancellation, and permissionless filling are a PoC with unit/fixture coverage. Concentrated liquidity position management is not covered yet: pools are discovered and readable, and deposits into them are refused with an explanatory error.

## Layout

| Directory | Package | Registry name |
| --- | --- | --- |
| `python/` | `import aquarius` | [`aquarius-sdk`](https://pypi.org/project/aquarius-sdk/) on PyPI |
| `javascript/` | `@aquariusdefi/sdk` | [`@aquariusdefi/sdk`](https://www.npmjs.com/package/@aquariusdefi/sdk) on npm |
| `testdata/` | Golden fixtures shared by both test suites | — |

## Try it

```bash
cd python
pip install -e .
python examples/demo.py   # two real swaps on testnet with a throwaway account
```

```python
from stellar_sdk import Keypair
from aquarius import AquariusClient, Asset, XLM

AQUA = Asset.classic("AQUA", "GAHPYWLK...LAGER")

aqua = AquariusClient(network="testnet", signer=Keypair.random())
aqua.fund_with_friendbot()
aqua.ensure_trustline(AQUA)

quote = aqua.quote(XLM, AQUA, amount_in=10_0000000)   # amount_out= for exact output
receipt = quote.execute()
```

## Programmatic on-chain limit orders

The SDK supports the `CONTRACT_ONCHAIN` placement mode for bots and contract
integrations. The web application uses the simpler detached/off-chain flow.

The high-level G-account helper requests a canonical draft from `amm-api`,
validates the returned XDR against the trusted network, settlement address and
requested fields, then atomically batches token approval(s) with
`place_contract_order`. Settlement and batcher addresses must be supplied from
trusted deployment configuration.

```python
import os

from aquarius import AquariusClient, LimitOrderConfig, XLM

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

SEP-41 `allowance()` exposes the amount but not its expiration. The allowance
horizon is therefore explicit and must cover the order; integrations reusing a
settlement allowance should choose a horizon no earlier than their other open
orders. It is execution policy and is not part of the signed order or order ID.

Custom C-account integrations can use the exported canonical-draft validator
and batch-argument builder, then provide their own contract-account
authorization policy.

The same configuration exposes the validated public registry and cancellation:

```python
orders = aqua.open_limit_orders(maker=signer.public_key)
order = aqua.get_limit_order(orders[0].order_id)
order.cancel()
```

For permissionless execution, request an exact-send route and let the SDK
validate the canonical order, detached `ADDRESS_V2` tree or confirmed
on-chain placement, simulation receipt, maker minimum, execution fee, and
maximum transaction fee before submission:

```python
path = aqua.api.find_path(
    {
        "token_in_address": order.order.sell_token,
        "token_out_address": order.order.buy_token,
        "amount": str(order.order.sell_amount),
    },
    exact_input=True,
)
prepared = order.prepare_fill(path["swap_chain_xdr"])
result = prepared.execute()
```

## Design principles

1. **Two-phase everything.** `quote()` → `Quote.execute()`. UIs show before they commit; the quote object carries everything needed to execute, so what you quoted is what you execute.
2. **Reads never need a signer.** Writes take one injected signer abstraction — a `Keypair` or a wallet-adapter callback. The SDK never accepts a raw secret string where avoidable and never stores keys.
3. **Escape hatches at every layer.** `Quote.buildTransaction()` returns unsigned XDR; `client.contract.call()` invokes the router raw; `client.api` is the typed REST client. The SDK wraps, it never traps.
4. **Protocol details are the SDK's problem.** `swaps_chain` encoding, token-vector sorting, pool hashes, transaction meta v3/v4, u128 conversion — none of these exist in the public surface.
5. **Typed errors that encode what we know.** Guard failures raise `SlippageError` ("re-quote and retry"), kill switches raise `PausedError` ("not your bug"), missing routes raise `NoRouteError`.
6. **Language parity is a feature.** Same names, same semantics in both packages, enforced by shared golden fixtures in `testdata/`. Feature releases move in lockstep minor versions (`py-v0.4.x` and `js-v0.4.x` have the same surface).

## Scope of v1

Swaps (both modes), pool discovery, deposit/withdraw/claim, positions overview, limit-order placement/reads/cancellation/filling, trustline and friendbot helpers, provider-fee configuration. Explicitly out: wallet and key management, price oracles, governance/ICE, SDEX rewards, historical data.

## Releases

Tags trigger publishing: `py-v*` → PyPI, `js-v*` → npm. Independent patches, lockstep minors.

## Development

- Python: `cd python && pip install -e .[dev] && pytest`
- TypeScript: `cd javascript && npm install && npm run typecheck`
- Fixtures in `testdata/` are recorded from the live testnet API; when the API contract changes, re-record them in the same PR that adapts the parsers — both languages, one PR.
