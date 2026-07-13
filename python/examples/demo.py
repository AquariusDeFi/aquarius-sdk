"""End-to-end demo: two real swaps on testnet with a throwaway account.

Run: python examples/demo.py  (needs the package installed: pip install -e .)
"""
from stellar_sdk import Keypair

from aquarius import XLM, AquariusClient, Asset

AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER")

aqua = AquariusClient(network="testnet", signer=Keypair.random())
aqua.fund_with_friendbot()
aqua.ensure_trustline(AQUA)

# exact input: swap 10 XLM
quote = aqua.quote(XLM, AQUA, amount_in=10_0000000)
print(f"quote:   10 XLM -> {quote.amount_out / 1e7:,.2f} AQUA "
      f"via {len(quote.route)} pool(s), guaranteed >= {quote.guard / 1e7:,.2f}")
receipt = quote.execute()
print(f"swapped: received {receipt.amount_out / 1e7:,.2f} AQUA")
print(f"         https://stellar.expert/explorer/testnet/tx/{receipt.tx_hash}")

# exact output: receive exactly 100 AQUA
quote = aqua.quote(XLM, AQUA, amount_out=100_0000000)
print(f"quote:   exactly 100 AQUA costs {quote.amount_in / 1e7:.4f} XLM")
receipt = quote.execute()
print(f"swapped: paid {receipt.amount_in / 1e7:.4f} XLM for exactly 100 AQUA")
print(f"         https://stellar.expert/explorer/testnet/tx/{receipt.tx_hash}")
