// E2E: the write lifecycle on MAINNET with real (tiny) funds — the
// JavaScript mirror of mainnet_lifecycle.py, on the built package.
//
// Flow: swap 1 XLM -> AQUA, pinned-pool swap, deposit 0.5 XLM + matching
// AQUA into the deep XLM/AQUA volatile pool, read the position back,
// withdraw; then the concentrated lifecycle (sweep leftovers, open a range
// around the current tick between ticks other LPs already initialized, read
// it back, close); finally swap everything back to XLM. Requires
// MAINNET_E2E_SECRET; runs after the Python lifecycle in CI — both share
// the wallet, and each starts from the flat state the other leaves behind
// (no AQUA, no positions).
//
// Run: MAINNET_E2E_SECRET=S... node javascript/e2e/mainnet_lifecycle.mjs
import assert from "node:assert/strict";

import { Keypair, xdr } from "@stellar/stellar-sdk";

import {
  AquariusClient,
  Asset,
  StaleSimulationError,
  XLM,
  snapTick,
} from "../dist/index.js";

import { waitForHorizonAccount } from "./horizon.mjs";

const AQUA = Asset.classic("AQUA", "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA");
const EXPLORER = "https://stellar.expert/explorer/public/tx/";
const SWAP_XLM = 10_000_000n;
const DEPOSIT_XLM = 5_000_000n;
// 0.9 XLM: a normal run costs ~0.22-0.25 XLM, ~0.155 of it rent for the
// concentrated position's new persistent entry (its bounds reuse initialized
// ticks, so no fresh tick storage). The volatile pool keeps reward invariants
// in shared pages of 100 reward blocks (RewardInvDataV2, ~2.1 KB), and the
// deposit or withdraw that crosses a page boundary pays ~0.54 XLM rent to
// create the next page. The budget admits one such page and still fails on
// anything beyond it, e.g. fresh tick storage on top of a normal run.
const MAX_ACCEPTABLE_LOSS = 9_000_000n;

const secret = process.env.MAINNET_E2E_SECRET ?? "";
if (!secret) {
  console.log("MAINNET_E2E_SECRET is not set — skipping the mainnet write lifecycle.");
  process.exit(0);
}

const keypair = Keypair.fromSecret(secret);
const aqua = new AquariusClient({ network: "mainnet", signer: keypair });
console.log(`wallet: ${keypair.publicKey()}`);

const fmt = stroops => (Number(stroops) / 1e7).toFixed(7);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function retryStale(thunk) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await thunk();
    } catch (error) {
      if (!(error instanceof StaleSimulationError) || attempt >= 2) throw error;
      console.log("  stale simulation — rebuilding and retrying");
      await sleep(2000);
    }
  }
}

async function balances(account) {
  if (!account) {
    const response = await fetch(
      `${aqua.network.horizonUrl}/accounts/${keypair.publicKey()}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    account = await response.json();
  }
  let xlm = 0n;
  let aquaHeld = 0n;
  for (const balance of account.balances ?? []) {
    if (balance.asset_type === "native") {
      xlm = BigInt(Math.round(parseFloat(balance.balance) * 1e7));
    } else if (balance.asset_code === AQUA.code && balance.asset_issuer === AQUA.issuer) {
      aquaHeld = BigInt(Math.round(parseFloat(balance.balance) * 1e7));
    }
  }
  return [xlm, aquaHeld];
}

// Balance gates: below the floor the lifecycle refuses to run (a failed
// guard mid-run is worse than not starting); below the warning line it
// still runs but flags the run so the wallet gets topped up in time.
const MIN_BALANCE = 50_000_000n;
const TOP_UP_WARNING = 100_000_000n;

let [xlmStart, aquaHave] = await balances();
if (xlmStart < MIN_BALANCE) {
  console.log(`::error title=E2E wallet needs a top-up::${keypair.publicKey()} holds `
    + `${fmt(xlmStart)} XLM, below the ${fmt(MIN_BALANCE)} floor — send XLM to it and re-run.`);
  process.exit(1);
}
if (xlmStart < TOP_UP_WARNING) {
  console.log(`::warning title=E2E wallet running low::${keypair.publicKey()} holds `
    + `${fmt(xlmStart)} XLM — top up soon; runs stop below ${fmt(MIN_BALANCE)}.`);
}
await aqua.ensureTrustline(AQUA);

if (aquaHave < 1_000_000_000n) {
  const receipt = await aqua.swap({ from: XLM, to: AQUA, amountIn: SWAP_XLM, retries: 3 });
  aquaHave += receipt.amountOut;
  console.log(`swap in : 1 XLM -> ${fmt(receipt.amountOut)} AQUA  ${EXPLORER}${receipt.txHash}`);
} else {
  console.log(`resuming with ${fmt(aquaHave)} AQUA from a previous run`);
}

const pools = await aqua.pools.forPair(XLM, AQUA);
const volatiles = pools.filter(p => p.type === "volatile");
let pool = volatiles.find(p => p.feeBps === 30);
if (!pool) {
  let best = -1n;
  for (const candidate of volatiles) {
    const r = (await candidate.reserves())[0];
    if (r > best) { best = r; pool = candidate; }
  }
}
const xlmContract = XLM.contractId(aqua.network.passphrase);
const xlmIndex = pool.tokens.indexOf(xlmContract);

// swap pinned to this exact pool — no path-finding API involved
const pinned = await pool.swap({ from: XLM, to: AQUA, amountIn: 2_000_000n, retries: 3 });
aquaHave += pinned.amountOut;
console.log(`pinned-pool swap: 0.2 XLM -> ${fmt(pinned.amountOut)} AQUA `
  + `(${pool.type}@${pool.feeBps}bps)  ${EXPLORER}${pinned.txHash}`);

const reserves = await pool.reserves();
const aquaNeeded = (DEPOSIT_XLM * reserves[1 - xlmIndex]) / reserves[xlmIndex];
const depositAqua = aquaNeeded < aquaHave ? aquaNeeded : aquaHave;

const deposit = await retryStale(() =>
  pool.deposit({ amounts: [[XLM, DEPOSIT_XLM], [AQUA, depositAqua]] }));
aquaHave -= deposit.amounts[1 - xlmIndex];
assert.ok(deposit.shares > 0n);
console.log(`deposit : [${deposit.amounts.map(fmt)}] -> ${fmt(deposit.shares)} shares  `
  + `${EXPLORER}${deposit.txHash}`);
assert.ok((await pool.shareBalance()) >= deposit.shares);
assert.ok((await pool.pendingRewards()) >= 0n);

// The withdraw must simulate past the deposit's ledger (reward checkpoint).
await aqua.waitForNextLedger();
const withdraw = await retryStale(() => pool.withdraw({ shares: deposit.shares }));
aquaHave += withdraw.amounts[1 - xlmIndex];
console.log(`withdraw: [${withdraw.amounts.map(fmt)}]  ${EXPLORER}${withdraw.txHash}`);

// --- concentrated lifecycle (beta surface) on a production pool -------------
// Bounds around the current tick that other LPs already initialized. Ticks
// live in persistent 16-tick chunks that are never deleted; a bound in an
// untouched chunk makes the deposit create, and pay rent for, new tick
// storage, while a tick with liquidity_gross > 0 is in a live chunk. Bounds
// keep a one-spacing margin from the current tick so the position stays in
// range while the run executes. null when either side has no initialized
// tick within 40 spacings. readPool is the pool's internal simulation read.
async function initializedRange(pool) {
  const spacing = await pool.tickSpacing();
  const tick = await pool.currentTick();
  const candidates = [];
  const first = snapTick(tick - 40 * spacing, spacing, { up: true });
  for (let t = first; t <= tick + 40 * spacing; t += spacing) candidates.push(t);
  const infos = await pool.readPool("get_ticks_batch", [
    xdr.ScVal.scvVec(candidates.map(t => xdr.ScVal.scvI32(t))),
  ]);
  const initialized = candidates.filter((t, i) => BigInt(infos[i].liquidity_gross) > 0n);
  const lowers = initialized.filter(t => t <= tick - spacing);
  const uppers = initialized.filter(t => t >= tick + spacing);
  console.log(`concentrated ${pool.address} (${pool.feeBps}bps): tick ${tick}, spacing `
    + `${spacing}, ${initialized.length} initialized ticks within 40 spacings`);
  if (!lowers.length || !uppers.length) return null;
  const closest = (ticks, target) => ticks.reduce((best, t) =>
    (Math.abs(t - target) < Math.abs(best - target) ? t : best));
  return [closest(lowers, tick - 10 * spacing), closest(uppers, tick + 10 * spacing)];
}

const concentratedPools = pools.filter(p => p.type === "concentrated");
if (!concentratedPools.length) {
  console.log("no concentrated XLM/AQUA pool on mainnet — concentrated segment skipped");
} else {
  // Close positions a previous crashed run left behind (20-range cap; and
  // the cleanup assert below only means something starting from zero), on
  // every pool: the pool picked below can differ from run to run.
  for (const swept of concentratedPools) {
    for (const [staleLower, staleUpper] of await swept.positionRanges()) {
      const out = await retryStale(() =>
        swept.withdrawPosition({ tickLower: staleLower, tickUpper: staleUpper }));
      aquaHave += out.amounts[1 - swept.tokens.indexOf(xlmContract)];
      console.log(`swept leftover position [${staleLower}, ${staleUpper}) in ${swept.address}`);
    }
  }

  let concentrated;
  let lower;
  let upper;
  for (const candidate of concentratedPools) {
    const bounds = await initializedRange(candidate);
    if (bounds) {
      concentrated = candidate;
      [lower, upper] = bounds;
      break;
    }
  }
  assert.ok(concentrated, "no concentrated XLM/AQUA pool has initialized ticks around the "
    + "current price; refusing to pay for fresh tick storage");
  console.log(`concentrated pool: ${concentrated.address} (${concentrated.feeBps}bps), `
    + `range [${lower}, ${upper}) on initialized ticks`);
  const xlmC = concentrated.tokens.indexOf(xlmContract);
  const cReserves = await concentrated.reserves();
  const aquaForRange = (DEPOSIT_XLM * cReserves[1 - xlmC]) / cReserves[xlmC];
  const rangeAqua = aquaForRange < aquaHave ? aquaForRange : aquaHave;

  const position = await retryStale(async () => {
    const est = await concentrated.estimatePositionDeposit({
      amounts: [[XLM, DEPOSIT_XLM], [AQUA, rangeAqua]],
      tickRange: [lower, upper],
    });
    assert.ok(est.liquidity > 0n, "estimate quoted no liquidity");
    return est.execute();
  });
  aquaHave -= position.amounts[1 - xlmC];
  assert.ok(position.liquidity > 0n);
  console.log(`position: [${lower}, ${upper}) [${position.amounts.map(fmt)}] `
    + `-> ${position.liquidity} liquidity  ${EXPLORER}${position.txHash}`);

  const status = await concentrated.positionRangeStatus(lower, upper);
  assert.ok(status.inRange, `fresh position around the current tick is ${status.status}`);
  const value = await concentrated.positionValue(lower, upper);
  assert.equal(value.total.length, concentrated.tokens.length);

  // The withdraw must simulate past the deposit's ledger (reward checkpoint).
  await aqua.waitForNextLedger();
  const closed = await retryStale(() =>
    concentrated.withdrawPosition({ tickLower: lower, tickUpper: upper }));
  aquaHave += closed.amounts[1 - xlmC];
  console.log(`closed  : [${closed.amounts.map(fmt)}]  ${EXPLORER}${closed.txHash}`);
  const after = await concentrated.positionRanges();
  assert.ok(!after.some(([l, u]) => l === lower && u === upper), "position not cleaned up");
}

const receipt2 = await aqua.swap({ from: AQUA, to: XLM, amountIn: aquaHave, retries: 3 });
console.log(`swap out: ${fmt(receipt2.amountIn)} AQUA -> ${fmt(receipt2.amountOut)} XLM  `
  + `${EXPLORER}${receipt2.txHash}`);

const settledAccount = await waitForHorizonAccount(
  aqua.network.horizonUrl, keypair.publicKey(), receipt2.txHash,
);
const [xlmEnd, aquaEnd] = await balances(settledAccount);
const loss = xlmStart - xlmEnd;
console.log(`\nnet XLM cost of the run: ${fmt(loss)} (fees + slippage)`);
assert.equal(aquaEnd, 0n, `AQUA left dangling: ${fmt(aquaEnd)}`);
assert.ok(loss <= MAX_ACCEPTABLE_LOSS, `lifecycle cost ${fmt(loss)} XLM — investigate`);
console.log("mainnet lifecycle: all checks passed");
