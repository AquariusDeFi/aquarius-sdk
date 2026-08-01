"""E2E: the full write lifecycle on testnet with a throwaway account.

Covers funding, trustline, swaps in both modes, the unsigned-XDR escape
hatch, pool discovery, deposit, position reads, withdraw, claim, and the
error paths. Real transactions on the live testnet; exits non-zero on the
first failed check. Run: python e2e/testnet_lifecycle.py
"""
import time

from stellar_sdk import Keypair, TransactionEnvelope

from aquarius import AquariusClient, AquariusError, Asset, StaleSimulationError, XLM

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
quote = client.quote(XLM, AQUA, amount_in=1_0000000)
envelope = TransactionEnvelope.from_xdr(quote.build_transaction(), client.network.passphrase)
assert len(envelope.signatures) == 0, "escape-hatch XDR arrived signed"
print("build_transaction() escape hatch: unsigned XDR parses")

# exact input, with the SDK's own retry/backoff absorbing testnet lag
receipt = client.swap(XLM, AQUA, amount_in=10_0000000, retries=3)
assert receipt.amount_out > 0, "exact-input swap returned nothing"
print(f"swap 10 XLM -> {fmt(receipt.amount_out)} AQUA  {EXPLORER}{receipt.tx_hash}")

# exact output
receipt2 = client.swap(AQUA, XLM, amount_out=1_0000000, retries=3)
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

print("\ntestnet lifecycle: all checks passed")
