// E2E: mainnet read path — the JavaScript mirror of mainnet_readonly.py.
// No signer, no transactions. Run: npm run build --prefix javascript && node javascript/e2e/mainnet_readonly.mjs
import assert from "node:assert/strict";

import { AquariusClient, AquariusError, Asset, XLM } from "../dist/index.js";

const AQUA = Asset.classic("AQUA", "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA");
const USDC = Asset.classic("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
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

await assert.rejects(quote.execute(), AquariusError, "execute() without a signer was not refused");
console.log("signer-less execute() refused cleanly");

console.log("\nmainnet read path: all checks passed");
