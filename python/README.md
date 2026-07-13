# aquarius-sdk

The Python SDK for [Aquarius](https://aqua.network) — swaps, liquidity, and rewards on Stellar.

**Status: interface preview (0.0.x).** The swap surface works end-to-end — quote → execute, exact-input and exact-output, on mainnet and testnet. Pools, liquidity, and rewards are under development, and the API may change before 0.1. Follow the [developer documentation](https://docs.aqua.network/developers/quickstart) for the stable integration path in the meantime.

```python
from stellar_sdk import Keypair
from aquarius import AquariusClient, Asset, XLM

AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER")

aqua = AquariusClient(network="testnet", signer=Keypair.random())
aqua.fund_with_friendbot()          # testnet only: 10,000 test XLM
aqua.ensure_trustline(AQUA)

quote = aqua.quote(XLM, AQUA, amount_in=10_0000000)   # amount_out= for exact output
print(f"10 XLM -> {quote.amount_out / 1e7:,.2f} AQUA via {len(quote.route)} pool(s)")

receipt = quote.execute()
print(f"received {receipt.amount_out / 1e7:,.2f} AQUA in tx {receipt.tx_hash}")
```

- Reads need no signer; writes take a `Keypair`. Raw secrets are never stored.
- Slippage guards raise a typed `SlippageError` ("re-quote and retry"); missing routes raise `NoRouteError`.
- Amounts are integer stroops (1 token = 10^7 stroops).

Questions and integration help: [Discord](https://discord.gg/sgzFscHp4C).
