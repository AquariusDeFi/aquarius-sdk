// E2E: mainnet read path — the JavaScript mirror of mainnet_readonly.py.
// No signer, no transactions. Run: npm run build --prefix javascript && node javascript/e2e/mainnet_readonly.mjs
import assert from "node:assert/strict";

import { AquariusClient, AquariusError, Asset, XLM, snapTick } from "../dist/index.js";

const AQUA = Asset.classic("AQUA", "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA");
const USDC = Asset.classic("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
// The dedicated mainnet E2E wallet (the same one mainnet_lifecycle signs with).
const E2E_WALLET = "GACBDYR3MNVUYY7NXP47ZL6JAWZNFXXXHTHLKWENADUMAWRO762L32WW";
const fmt = stroops => (Number(stroops) / 1e7).toFixed(7);

const aqua = new AquariusClient({ network: "mainnet" }); // deliberately signer-less

const quote = await aqua.quote({ from: XLM, to: AQUA, amountIn: 1_000_000_000n });
assert.ok(quote.amountOut > 0n && quote.guard < quote.amountOut && quote.route.length > 0);
console.log(`exact-in : 100 XLM -> ~${fmt(quote.amountOut)} AQUA via ${quote.route.length} pool(s)`);

const quote2 = await aqua.quote({ from: AQUA, to: USDC, amountOut: 100_000_000n });
assert.ok(quote2.amountIn > 0n && quote2.guard > quote2.amountIn);
console.log(`exact-out: ~${fmt(quote2.amountIn)} AQUA -> 10 USDC via ${quote2.route.length} pool(s)`);

const pools = await aqua.pools.forPair(XLM, AQUA);
assert.ok(pools.length > 0, "no XLM/AQUA pools on mainnet?!");
for (const pool of pools) {
  const reserves = await pool.reserves();
  assert.equal(reserves.length, pool.tokens.length);
}
console.log(`pools + on-chain reserves read: ${pools.map(p => `${p.type}@${p.feeBps}bps`).join(", ")}`);

// Concentrated read surface against the production contracts: price state,
// tick spacing, range status, the e2e wallet's positions, and the contract's
// own deposit estimator (a simulation — no signer, no funds).
const concentrated = pools.find(p => p.type === "concentrated");
assert.ok(concentrated, "no concentrated XLM/AQUA pool on mainnet?!");
const spacing = await concentrated.tickSpacing();
const slot = await concentrated.slot0();
assert.ok(spacing > 0 && slot.sqrtPriceX96 > 0n);
const lower = snapTick(slot.tick - 10 * spacing, spacing);
const upper = snapTick(slot.tick + 10 * spacing, spacing, { up: true });
const status = await concentrated.positionRangeStatus(lower, upper);
assert.ok(status.inRange, "a range straddling the current tick must be in_range");

const ranges = await concentrated.positionRanges(E2E_WALLET);
assert.ok(Array.isArray(ranges));

const cReserves = await concentrated.reserves();
const xlmIndex = concentrated.tokens.indexOf(XLM.contractId(aqua.network.passphrase));
const aquaSide = (100_000_000n * cReserves[1 - xlmIndex]) / cReserves[xlmIndex];
const est = await concentrated.estimatePositionDeposit({
  amounts: [[XLM, 100_000_000n], [AQUA, aquaSide]],
  tickRange: [lower, upper],
});
assert.ok(est.liquidity > 0n && est.amounts.length === concentrated.tokens.length);
console.log(
  `concentrated: tick ${slot.tick}, spacing ${spacing}, ${ranges.length} e2e-wallet position(s), ` +
  `estimate [${est.amounts.map(fmt)}] -> ${est.liquidity} liquidity`,
);

// Provider-fee collector reads against a live production collector (the
// LOBSTR frontend's) — proves the collector ABI without funds or signer.
const collector = aqua.feeCollector("CCPGFQUTSEHDIQODRE3GJDNE64A35HZ32L7LPDN7GXOCIYNBJSMS6V6B");
const dest = await collector.feeDestination();
const maxFee = await collector.maxFeeFraction();
assert.ok(dest.startsWith("G") && maxFee > 0);
const accrued = await collector.balance(AQUA);
assert.ok(accrued >= 0n);
console.log(`collector: destination ${dest.slice(0, 8)}…, max fee ${maxFee}, accrued AQUA ${fmt(accrued)}`);

await assert.rejects(quote.execute(), AquariusError, "execute() without a signer was not refused");
console.log("signer-less execute() refused cleanly");

console.log("\nmainnet read path: all checks passed");
