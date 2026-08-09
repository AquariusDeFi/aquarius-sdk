// E2E: the write lifecycle on MAINNET with real (tiny) funds — the
// JavaScript mirror of mainnet_lifecycle.py, on the built package.
//
// Flow: swap 1 XLM -> AQUA, pinned-pool swap, deposit 0.5 XLM + matching
// AQUA into the deep XLM/AQUA volatile pool, read the position back,
// withdraw; then the concentrated lifecycle (sweep leftovers, open a range
// around the current tick, read it back, close); finally swap everything
// back to XLM. Requires MAINNET_E2E_SECRET; runs after the Python
// lifecycle in CI — both share the wallet, and each starts from the flat
// state the other leaves behind (no AQUA, no positions).
//
// Run: MAINNET_E2E_SECRET=S... node javascript/e2e/mainnet_lifecycle.mjs
import assert from "node:assert/strict";

import { Keypair } from "@stellar/stellar-sdk";

import {
  AquariusClient,
  Asset,
  StaleSimulationError,
  XLM,
  snapTick,
} from "../dist/index.js";

const AQUA = Asset.classic("AQUA", "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA");
const EXPLORER = "https://stellar.expert/explorer/public/tx/";
const SWAP_XLM = 10_000_000n;
const DEPOSIT_XLM = 5_000_000n;
// 0.6 XLM: the concentrated deposit initializes fresh tick entries most runs
// (new persistent ledger entries) at ~0.32 XLM in resource fees; everything
// else totals well under 0.1.
const MAX_ACCEPTABLE_LOSS = 6_000_000n;

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

async function balances() {
  const response = await fetch(
    `${aqua.network.horizonUrl}/accounts/${keypair.publicKey()}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  const account = await response.json();
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

let [xlmStart, aquaHave] = await balances();
assert.ok(xlmStart >= 50_000_000n, `wallet too low for the lifecycle: ${fmt(xlmStart)} XLM`);
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

const withdraw = await retryStale(() => pool.withdraw({ shares: deposit.shares }));
aquaHave += withdraw.amounts[1 - xlmIndex];
console.log(`withdraw: [${withdraw.amounts.map(fmt)}]  ${EXPLORER}${withdraw.txHash}`);

// --- concentrated lifecycle (beta surface) on the production pool -----------
const concentrated = pools.find(p => p.type === "concentrated");
if (!concentrated) {
  console.log("no concentrated XLM/AQUA pool on mainnet — concentrated segment skipped");
} else {
  const xlmC = concentrated.tokens.indexOf(xlmContract);

  // Close positions a previous crashed run left behind (20-range cap; and
  // the cleanup assert below only means something starting from zero).
  for (const [staleLower, staleUpper] of await concentrated.positionRanges()) {
    const out = await retryStale(() =>
      concentrated.withdrawPosition({ tickLower: staleLower, tickUpper: staleUpper }));
    aquaHave += out.amounts[1 - xlmC];
    console.log(`swept leftover position [${staleLower}, ${staleUpper})`);
  }

  const spacing = await concentrated.tickSpacing();
  const tick = await concentrated.currentTick();
  const lower = snapTick(tick - 10 * spacing, spacing);
  const upper = snapTick(tick + 10 * spacing, spacing, { up: true });
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

let [xlmEnd, aquaEnd] = await balances();
for (let i = 0; i < 3 && aquaEnd !== 0n; i++) {  // Horizon can lag the just-confirmed swap
  await sleep(2000);
  [xlmEnd, aquaEnd] = await balances();
}
const loss = xlmStart - xlmEnd;
console.log(`\nnet XLM cost of the run: ${fmt(loss)} (fees + slippage)`);
assert.equal(aquaEnd, 0n, `AQUA left dangling: ${fmt(aquaEnd)}`);
assert.ok(loss <= MAX_ACCEPTABLE_LOSS, `lifecycle cost ${fmt(loss)} XLM — investigate`);
console.log("mainnet lifecycle: all checks passed");
