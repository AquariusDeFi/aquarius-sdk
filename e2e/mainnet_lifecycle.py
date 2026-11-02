"""E2E: the write lifecycle on MAINNET with real (tiny) funds.

Flow: swap 1 XLM -> AQUA, deposit 0.5 XLM + matching AQUA into the deep
XLM/AQUA volatile pool, read the position back, withdraw; then the same
shape on a concentrated pool (beta surface): sweep leftovers, open a
range around the current tick between ticks other LPs already
initialized, read it back, close; finally swap everything back to XLM.
~2 XLM in play, returned minus fees (typically < 0.05 XLM).

Requires MAINNET_E2E_SECRET in the environment — a dedicated, lightly funded
account (>= 5 XLM spendable). Never run two instances concurrently: they
trade against each other. In CI this is enforced with a concurrency group;
locally, just don't.

Run: MAINNET_E2E_SECRET=S... python e2e/mainnet_lifecycle.py
"""
import os
import sys
import time

import requests
from stellar_sdk import Keypair, scval

from aquarius import AquariusClient, Asset, StaleSimulationError, XLM, snap_tick

AQUA = Asset.classic("AQUA", "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA")
EXPLORER = "https://stellar.expert/explorer/public/tx/"
SWAP_XLM = 1_0000000
DEPOSIT_XLM = 5000000
# 0.9 XLM: a normal run costs ~0.22-0.25 XLM, ~0.155 of it rent for the
# concentrated position's new persistent entry (its bounds reuse initialized
# ticks, so no fresh tick storage). The volatile pool keeps reward invariants
# in shared pages of 100 reward blocks (RewardInvDataV2, ~2.1 KB), and the
# deposit or withdraw that crosses a page boundary pays ~0.54 XLM rent to
# create the next page. The budget admits one such page and still fails on
# anything beyond it, e.g. fresh tick storage on top of a normal run.
MAX_ACCEPTABLE_LOSS = 9000000

secret = os.environ.get("MAINNET_E2E_SECRET", "")
if not secret:
    print("MAINNET_E2E_SECRET is not set — skipping the mainnet write lifecycle.")
    sys.exit(0)

keypair = Keypair.from_secret(secret)
client = AquariusClient(network="mainnet", signer=keypair)
print(f"wallet: {keypair.public_key}")


def fmt(stroops: int) -> str:
    return f"{stroops / 10_000_000:,.7f}"


def retry_stale(thunk):
    """Rebuild-and-retry on footprint drift, per the error's own advice."""
    for attempt in range(3):
        try:
            return thunk()
        except StaleSimulationError:
            if attempt == 2:
                raise
            print("  stale simulation — rebuilding and retrying")
            time.sleep(2)


def balances() -> tuple[int, int]:
    account = requests.get(
        f"{client.network.horizon_url}/accounts/{keypair.public_key}", timeout=30
    ).json()
    xlm = aqua = 0
    for balance in account.get("balances", []):
        if balance.get("asset_type") == "native":
            xlm = int(round(float(balance["balance"]) * 10_000_000))
        elif (balance.get("asset_code"), balance.get("asset_issuer")) == (AQUA.code, AQUA.issuer):
            aqua = int(round(float(balance["balance"]) * 10_000_000))
    return xlm, aqua


# Balance gates: below the floor the lifecycle refuses to run (a failed
# guard mid-run is worse than not starting); below the warning line it
# still runs but flags the run so the wallet gets topped up in time.
MIN_BALANCE = 5_0000000
TOP_UP_WARNING = 10_0000000

xlm_start, aqua_have = balances()
if xlm_start < MIN_BALANCE:
    print(f"::error title=E2E wallet needs a top-up::{keypair.public_key} holds "
          f"{fmt(xlm_start)} XLM, below the {fmt(MIN_BALANCE)} floor — "
          f"send XLM to it and re-run.")
    sys.exit(1)
if xlm_start < TOP_UP_WARNING:
    print(f"::warning title=E2E wallet running low::{keypair.public_key} holds "
          f"{fmt(xlm_start)} XLM — top up soon; runs stop below {fmt(MIN_BALANCE)}.")
client.ensure_trustline(AQUA)

if aqua_have < 100_0000000:
    receipt = client.swap(XLM, AQUA, amount_in=SWAP_XLM, retries=3)
    aqua_have += receipt.amount_out
    print(f"swap in : 1 XLM -> {fmt(receipt.amount_out)} AQUA  {EXPLORER}{receipt.tx_hash}")
else:
    print(f"resuming with {fmt(aqua_have)} AQUA from a previous run")

pools = client.pools_for_pair(XLM, AQUA)
volatiles = [p for p in pools if p.type == "volatile"]
pool = next((p for p in volatiles if p.fee_bps == 30), None) or max(
    volatiles, key=lambda p: p.reserves()[0]
)
# swap pinned to this exact pool — no path-finding API involved
pinned = pool.swap(XLM, AQUA, amount_in=2000000, retries=3)
aqua_have += pinned.amount_out
print(f"pinned-pool swap: 0.2 XLM -> {fmt(pinned.amount_out)} AQUA "
      f"({pool.type}@{pool.fee_bps}bps)  {EXPLORER}{pinned.tx_hash}")

reserves = pool.reserves()
xlm_index = pool.tokens.index(XLM.contract_id(client.network.passphrase))
aqua_needed = DEPOSIT_XLM * reserves[1 - xlm_index] // reserves[xlm_index]

deposit = retry_stale(lambda: pool.deposit({XLM: DEPOSIT_XLM, AQUA: min(aqua_needed, aqua_have)}))
aqua_have -= deposit.amounts[1 - xlm_index]
assert deposit.shares > 0
print(f"deposit : {[fmt(a) for a in deposit.amounts]} -> {fmt(deposit.shares)} shares  "
      f"{EXPLORER}{deposit.tx_hash}")
assert pool.share_balance() >= deposit.shares
assert pool.pending_rewards() >= 0

# The withdraw must simulate past the deposit's ledger (reward checkpoint).
client.wait_for_next_ledger()
withdraw = retry_stale(lambda: pool.withdraw(deposit.shares))
aqua_have += withdraw.amounts[1 - xlm_index]
print(f"withdraw: {[fmt(a) for a in withdraw.amounts]}  {EXPLORER}{withdraw.tx_hash}")

# --- concentrated lifecycle (beta surface) on a production pool -------------
def initialized_range(pool) -> tuple[int, int] | None:
    """Bounds around the current tick that other LPs already initialized.

    Ticks live in persistent 16-tick chunks that are never deleted; a bound
    in an untouched chunk makes the deposit create, and pay rent for, new
    tick storage, while a tick with liquidity_gross > 0 is in a live chunk.
    Bounds keep a one-spacing margin from the current tick so the position
    stays in range while the run executes. None when either side has no
    initialized tick within 40 spacings.
    """
    spacing = pool.tick_spacing()
    tick = pool.current_tick()
    candidates = list(range(snap_tick(tick - 40 * spacing, spacing, up=True),
                            tick + 40 * spacing + 1, spacing))
    infos = pool._read_pool("get_ticks_batch", [
        scval.to_vec([scval.to_int32(t) for t in candidates])
    ])
    initialized = [t for t, info in zip(candidates, infos) if int(info["liquidity_gross"]) > 0]
    lowers = [t for t in initialized if t <= tick - spacing]
    uppers = [t for t in initialized if t >= tick + spacing]
    print(f"concentrated {pool.address} ({pool.fee_bps}bps): tick {tick}, spacing "
          f"{spacing}, {len(initialized)} initialized ticks within 40 spacings")
    if not lowers or not uppers:
        return None
    return (min(lowers, key=lambda t: abs(t - (tick - 10 * spacing))),
            min(uppers, key=lambda t: abs(t - (tick + 10 * spacing))))


concentrated_pools = [p for p in pools if p.type == "concentrated"]
if not concentrated_pools:
    print("no concentrated XLM/AQUA pool on mainnet — concentrated segment skipped")
else:
    xlm_id = XLM.contract_id(client.network.passphrase)

    # Close positions a previous crashed run left behind (20-range cap; and
    # the cleanup assert below only means something starting from zero), on
    # every pool: the pool picked below can differ from run to run.
    for swept in concentrated_pools:
        for stale_lower, stale_upper in swept.position_ranges():
            out = retry_stale(lambda p=swept, lo=stale_lower, up=stale_upper:
                              p.withdraw_position(lo, up))
            aqua_have += out.amounts[1 - swept.tokens.index(xlm_id)]
            print(f"swept leftover position [{stale_lower}, {stale_upper}) "
                  f"in {swept.address}")

    concentrated = None
    for candidate in concentrated_pools:
        bounds = initialized_range(candidate)
        if bounds:
            concentrated, (lower, upper) = candidate, bounds
            break
    assert concentrated is not None, (
        "no concentrated XLM/AQUA pool has initialized ticks around the current price; "
        "refusing to pay for fresh tick storage")
    print(f"concentrated pool: {concentrated.address} ({concentrated.fee_bps}bps), "
          f"range [{lower}, {upper}) on initialized ticks")
    xlm_c = concentrated.tokens.index(xlm_id)
    c_reserves = concentrated.reserves()
    aqua_for_range = DEPOSIT_XLM * c_reserves[1 - xlm_c] // c_reserves[xlm_c]

    def open_position():
        est = concentrated.estimate_position_deposit(
            {XLM: DEPOSIT_XLM, AQUA: min(aqua_for_range, aqua_have)},
            tick_range=(lower, upper),
        )
        assert est.liquidity > 0, "estimate quoted no liquidity"
        return est.execute()

    position = retry_stale(open_position)
    aqua_have -= position.amounts[1 - xlm_c]
    assert position.liquidity > 0
    print(f"position: [{lower}, {upper}) {[fmt(a) for a in position.amounts]} "
          f"-> {position.liquidity} liquidity  {EXPLORER}{position.tx_hash}")

    status = concentrated.position_range_status(lower, upper)
    assert status.in_range, f"fresh position around the current tick is {status.status}"
    value = concentrated.position_value(lower, upper)
    assert len(value.total) == len(concentrated.tokens)

    # The withdraw must simulate past the deposit's ledger (reward checkpoint).
    client.wait_for_next_ledger()
    closed = retry_stale(lambda: concentrated.withdraw_position(lower, upper))
    aqua_have += closed.amounts[1 - xlm_c]
    print(f"closed  : {[fmt(a) for a in closed.amounts]}  {EXPLORER}{closed.tx_hash}")
    assert (lower, upper) not in concentrated.position_ranges(), "position not cleaned up"

receipt2 = client.swap(AQUA, XLM, amount_in=aqua_have, retries=3)
print(f"swap out: {fmt(receipt2.amount_in)} AQUA -> {fmt(receipt2.amount_out)} XLM  "
      f"{EXPLORER}{receipt2.tx_hash}")

xlm_end, aqua_end = balances()
for _ in range(3):  # Horizon can lag the just-confirmed swap by a moment
    if aqua_end == 0:
        break
    time.sleep(2)
    xlm_end, aqua_end = balances()
loss = xlm_start - xlm_end
print(f"\nnet XLM cost of the run: {fmt(loss)} (fees + slippage)")
assert aqua_end == 0, f"AQUA left dangling: {fmt(aqua_end)}"
assert loss <= MAX_ACCEPTABLE_LOSS, f"lifecycle cost {fmt(loss)} XLM — investigate"
print("mainnet lifecycle: all checks passed")
