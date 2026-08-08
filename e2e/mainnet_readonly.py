"""E2E: mainnet read path — quotes in both modes, pool discovery, on-chain
reserve reads, and the no-signer refusal. No signer, no transactions; safe to
run anywhere, any time. Run: python e2e/mainnet_readonly.py
"""
from aquarius import AquariusClient, AquariusError, Asset, XLM, snap_tick

AQUA = Asset.classic("AQUA", "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA")
USDC = Asset.classic("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")
# The dedicated mainnet E2E wallet (the same one mainnet_lifecycle signs with).
E2E_WALLET = "GACBDYR3MNVUYY7NXP47ZL6JAWZNFXXXHTHLKWENADUMAWRO762L32WW"


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

# Concentrated read surface against the production contracts: price state,
# tick spacing, range status, the e2e wallet's positions, and the contract's
# own deposit estimator (a simulation — no signer, no funds).
concentrated = next((p for p in pools if p.type == "concentrated"), None)
assert concentrated is not None, "no concentrated XLM/AQUA pool on mainnet?!"
spacing = concentrated.tick_spacing()
slot = concentrated.slot0()
assert spacing > 0 and slot.sqrt_price_x96 > 0
lower = snap_tick(slot.tick - 10 * spacing, spacing)
upper = snap_tick(slot.tick + 10 * spacing, spacing, up=True)
status = concentrated.position_range_status(lower, upper)
assert status.in_range, "a range straddling the current tick must be in_range"

ranges = concentrated.position_ranges(address=E2E_WALLET)
assert isinstance(ranges, list)

reserves = concentrated.reserves()
xlm_index = concentrated.tokens.index(XLM.contract_id(client.network.passphrase))
aqua_side = 10_0000000 * reserves[1 - xlm_index] // reserves[xlm_index]
est = concentrated.estimate_position_deposit(
    {XLM: 10_0000000, AQUA: aqua_side}, tick_range=(lower, upper)
)
assert est.liquidity > 0 and len(est.amounts) == len(concentrated.tokens)
print(f"concentrated: tick {slot.tick}, spacing {spacing}, "
      f"{len(ranges)} e2e-wallet position(s), estimate "
      f"{[fmt(a) for a in est.amounts]} -> {est.liquidity} liquidity")

# Provider-fee collector reads against a live production collector (the
# LOBSTR frontend's) — proves the collector ABI without funds or signer.
collector = client.fee_collector("CCPGFQUTSEHDIQODRE3GJDNE64A35HZ32L7LPDN7GXOCIYNBJSMS6V6B")
dest = collector.fee_destination()
assert dest.startswith("G") and collector.max_fee_fraction() > 0
accrued = collector.balance(AQUA)
assert accrued >= 0
print(f"collector: destination {dest[:8]}…, max fee {collector.max_fee_fraction()}, "
      f"accrued AQUA {fmt(accrued)}")

try:
    quote.execute()
    raise SystemExit("execute() without a signer was not refused")
except AquariusError:
    print("signer-less execute() refused cleanly")

print("\nmainnet read path: all checks passed")
