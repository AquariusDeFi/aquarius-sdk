"""E2E: the write lifecycle on MAINNET with real (tiny) funds.

Flow: swap 1 XLM -> AQUA, deposit 0.5 XLM + matching AQUA into the deep
XLM/AQUA volatile pool, read the position back, withdraw, swap everything
back to XLM. ~1.5 XLM in play, returned minus fees (typically < 0.05 XLM).

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
from stellar_sdk import Keypair

from aquarius import AquariusClient, Asset, StaleSimulationError, XLM

AQUA = Asset.classic("AQUA", "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA")
EXPLORER = "https://stellar.expert/explorer/public/tx/"
SWAP_XLM = 1_0000000
DEPOSIT_XLM = 5000000
MAX_ACCEPTABLE_LOSS = 2000000  # 0.2 XLM: fees + slippage on a clean run are far below this

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


xlm_start, aqua_have = balances()
assert xlm_start >= 5_0000000, f"wallet too low for the lifecycle: {fmt(xlm_start)} XLM"
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

withdraw = retry_stale(lambda: pool.withdraw(deposit.shares))
aqua_have += withdraw.amounts[1 - xlm_index]
print(f"withdraw: {[fmt(a) for a in withdraw.amounts]}  {EXPLORER}{withdraw.tx_hash}")

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
