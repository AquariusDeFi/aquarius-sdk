"""E2E: the full write lifecycle on testnet with a throwaway account.

Covers funding, trustline, swaps in both modes, the unsigned-XDR escape
hatch, pool discovery, deposit, position reads, withdraw, claim, and the
error paths. Real transactions on the live testnet; exits non-zero on the
first failed check. Run: python e2e/testnet_lifecycle.py
"""
import time

from stellar_sdk import Keypair, TransactionEnvelope

from aquarius import AquariusClient, AquariusError, Asset, StaleSimulationError, XLM, snap_tick

AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER")
EXPLORER = "https://stellar.expert/explorer/testnet/tx/"


def fmt(stroops: int) -> str:
    return f"{stroops / 10_000_000:,.7f}"


def retry_stale(thunk):
    """router.withdraw can hit a footprint violation when rewards state moved
    between simulation and inclusion (soroban-amm issue; the error itself says
    to rebuild and retry). Retrying re-simulates with a fresh footprint."""
    for attempt in range(3):
        try:
            return thunk()
        except StaleSimulationError:
            if attempt == 2:
                raise
            print("  stale simulation — rebuilding and retrying")
            time.sleep(2)


keypair = Keypair.random()
client = AquariusClient(network="testnet", signer=keypair)
print(f"throwaway account: {keypair.public_key}")

client.fund_with_friendbot()
client.ensure_trustline(AQUA)
print("funded + AQUA trustline in place")

# escape hatch first, before our own swaps move the pool: the unsigned
# envelope must parse and carry no signatures
quote = client.quote(XLM, AQUA, amount_in=1_0000000, slippage=0.05)
envelope = TransactionEnvelope.from_xdr(quote.build_transaction(), client.network.passphrase)
assert len(envelope.signatures) == 0, "escape-hatch XDR arrived signed"
print("build_transaction() escape hatch: unsigned XDR parses")

# exact input, with the SDK's own retry/backoff absorbing testnet lag
receipt = client.swap(XLM, AQUA, amount_in=10_0000000, retries=3, slippage=0.05)
assert receipt.amount_out > 0, "exact-input swap returned nothing"
print(f"swap 10 XLM -> {fmt(receipt.amount_out)} AQUA  {EXPLORER}{receipt.tx_hash}")

# exact output
receipt2 = client.swap(AQUA, XLM, amount_out=1_0000000, retries=3, slippage=0.05)
assert receipt2.amount_out == 1_0000000, "exact-output swap missed the target"
print(f"swap {fmt(receipt2.amount_in)} AQUA -> exactly 1 XLM  {EXPLORER}{receipt2.tx_hash}")

# pool discovery + liquidity lifecycle on a non-concentrated pool
pools = client.pools_for_pair(XLM, AQUA)
assert pools, "no pools discovered for XLM/AQUA"
print(f"pools discovered: {[(p.type, p.fee_bps) for p in pools]}")
pool = next(p for p in pools if p.type != "concentrated")

deposit = retry_stale(lambda: pool.deposit({XLM: 5_0000000, AQUA: 50_0000000}))
assert deposit.shares > 0, "deposit minted no shares"
print(f"deposited {[fmt(a) for a in deposit.amounts]} -> {fmt(deposit.shares)} shares  "
      f"{EXPLORER}{deposit.tx_hash}")
assert pool.share_balance() == deposit.shares, "share balance != minted shares"
assert pool.pending_rewards() >= 0

withdraw = retry_stale(lambda: pool.withdraw(deposit.shares))
assert len(withdraw.amounts) == len(pool.tokens), "withdraw amounts arity mismatch"
print(f"withdrew {[fmt(a) for a in withdraw.amounts]}  {EXPLORER}{withdraw.tx_hash}")

claim = retry_stale(lambda: pool.claim_rewards())
print(f"claimed {fmt(claim.amount)} AQUA rewards  {EXPLORER}{claim.tx_hash}")

# error paths
try:
    client.quote(XLM, AQUA, amount_in=1, amount_out=1)
    raise SystemExit("ambiguous amounts were not rejected")
except AquariusError:
    print("ambiguous amounts rejected")

concentrated = next((p for p in pools if p.type == "concentrated"), None)
if concentrated is not None:
    try:
        concentrated.deposit({XLM: 1_0000000})
        raise SystemExit("concentrated deposit was not refused")
    except AquariusError:
        print("concentrated deposit refused as designed")

    # Close positions a previous crashed run left behind. The contract caps
    # an account at 20 ranges, so leftovers would eventually brick this
    # wallet — and the final cleanup assert below only means something when
    # the run starts from zero.
    for stale_lower, stale_upper in concentrated.position_ranges():
        retry_stale(lambda lo=stale_lower, up=stale_upper: concentrated.withdraw_position(
            lo, up, slippage=0.05))
        print(f"swept leftover position [{stale_lower}, {stale_upper})")

    # full range-position lifecycle on the concentrated pool (beta surface)
    fuel = client.swap(XLM, AQUA, amount_in=2_0000000, retries=3, slippage=0.05)
    spacing = concentrated.tick_spacing()
    tick = concentrated.current_tick()
    lower = snap_tick(tick - 10 * spacing, spacing)
    upper = snap_tick(tick + 10 * spacing, spacing, up=True)

    def open_position():
        est = concentrated.estimate_position_deposit(
            {XLM: 1_0000000, AQUA: fuel.amount_out // 2}, tick_range=(lower, upper)
        )
        assert est.liquidity > 0, "estimate quoted no liquidity"
        return est.execute(slippage=0.05)

    position = retry_stale(open_position)
    assert position.liquidity > 0, "deposit minted no liquidity"
    print(f"opened position [{lower}, {upper}] -> {position.liquidity} liquidity  "
          f"{EXPLORER}{position.tx_hash}")
    assert (lower, upper) in concentrated.position_ranges(), "position missing from snapshot"

    status = concentrated.position_range_status(lower, upper)
    assert status.in_range, f"fresh position around the current tick is {status.status}"
    print(f"range status: {status.status} (tick {status.current_tick} in [{lower}, {upper}))")

    value = concentrated.position_value(lower, upper)
    assert len(value.total) == 2, "position value arity mismatch"
    print(f"position value: total {[fmt(a) for a in value.total]}, "
          f"fees {[fmt(a) for a in value.fees]}")

    half = retry_stale(lambda: concentrated.withdraw_position(
        lower, upper, position.liquidity // 2, slippage=0.05))
    print(f"withdrew half: {[fmt(a) for a in half.amounts]}  {EXPLORER}{half.tx_hash}")

    fees = retry_stale(lambda: concentrated.claim_position_fees(lower, upper))
    print(f"claimed position fees: {[fmt(a) for a in fees.amounts]}  {EXPLORER}{fees.tx_hash}")

    rest = retry_stale(lambda: concentrated.withdraw_position(lower, upper, slippage=0.05))
    print(f"closed position: {[fmt(a) for a in rest.amounts]}  {EXPLORER}{rest.tx_hash}")
    assert (lower, upper) not in concentrated.position_ranges(), "position not cleaned up"
else:
    print("no concentrated XLM/AQUA pool on testnet — concentrated segment skipped")

print("\ntestnet lifecycle: all checks passed")
