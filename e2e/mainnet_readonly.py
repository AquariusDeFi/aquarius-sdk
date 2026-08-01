"""E2E: mainnet read path — quotes in both modes, pool discovery, on-chain
reserve reads, and the no-signer refusal. No signer, no transactions; safe to
run anywhere, any time. Run: python e2e/mainnet_readonly.py
"""
from aquarius import AquariusClient, AquariusError, Asset, XLM

AQUA = Asset.classic("AQUA", "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA")
USDC = Asset.classic("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")


def fmt(stroops: int) -> str:
    return f"{stroops / 10_000_000:,.7f}"


client = AquariusClient(network="mainnet")  # deliberately signer-less

quote = client.quote(XLM, AQUA, amount_in=100_0000000)
assert quote.amount_out > 0 and quote.guard < quote.amount_out and quote.route
print(f"exact-in : 100 XLM -> ~{fmt(quote.amount_out)} AQUA via {len(quote.route)} pool(s)")

quote2 = client.quote(AQUA, USDC, amount_out=10_0000000)
assert quote2.amount_in > 0 and quote2.guard > quote2.amount_in
print(f"exact-out: ~{fmt(quote2.amount_in)} AQUA -> 10 USDC via {len(quote2.route)} pool(s)")

pools = client.pools_for_pair(XLM, AQUA)
assert pools, "no XLM/AQUA pools on mainnet?!"
for pool in pools:
    reserves = pool.reserves()
    assert len(reserves) == len(pool.tokens)
print(f"pools + on-chain reserves read: {[(p.type, p.fee_bps) for p in pools]}")

try:
    quote.execute()
    raise SystemExit("execute() without a signer was not refused")
except AquariusError:
    print("signer-less execute() refused cleanly")

print("\nmainnet read path: all checks passed")
