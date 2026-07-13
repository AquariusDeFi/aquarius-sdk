"""The liquidity lifecycle on testnet with a throwaway account.

Run: python examples/liquidity.py  (needs the package installed: pip install -e .)
"""
import time

from stellar_sdk import Keypair

from aquarius import XLM, AquariusClient, Asset

AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER")

aqua = AquariusClient(network="testnet", signer=Keypair.random())
aqua.fund_with_friendbot()
aqua.ensure_trustline(AQUA)
aqua.swap(XLM, AQUA, amount_in=200_0000000)  # acquire AQUA to deposit

pools = aqua.pools_for_pair(XLM, AQUA)
print("pools:", [(p.type, p.fee_bps) for p in pools])
pool = next(p for p in pools if p.type == "volatile")

result = pool.deposit({XLM: 50_0000000, AQUA: 20000_0000000}, slippage=0.02)
print(f"deposited {[a / 1e7 for a in result.amounts]}, minted {result.shares / 1e7:.4f} shares")

time.sleep(10)  # the indexer needs a moment before positions() sees the deposit
print("positions:", [(p.pool.type, p.shares / 1e7) for p in aqua.positions()])

withdrawn = pool.withdraw(result.shares, slippage=0.02)
print(f"withdrew {[a / 1e7 for a in withdrawn.amounts]}")

claimed = pool.claim_rewards()
print(f"claimed {claimed.amount / 1e7} AQUA of rewards")
