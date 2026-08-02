// E2E: the full write lifecycle on testnet with a throwaway account —
// the JavaScript mirror of testnet_lifecycle.py, on the built package.
// Run: npm run build --prefix javascript && node javascript/e2e/testnet_lifecycle.mjs
import assert from "node:assert/strict";

import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

import { AquariusClient, AquariusError, Asset, StaleSimulationError, XLM } from "../dist/index.js";

const AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER");
const EXPLORER = "https://stellar.expert/explorer/testnet/tx/";
const fmt = stroops => (Number(stroops) / 1e7).toFixed(7);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// router.withdraw can hit a footprint violation when rewards state moved
// between simulation and inclusion (soroban-amm issue; the error itself says
// to rebuild and retry). Retrying re-simulates with a fresh footprint.
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

const keypair = Keypair.random();
const aqua = new AquariusClient({ network: "testnet", signer: keypair });
console.log(`throwaway account: ${keypair.publicKey()}`);

await aqua.fundWithFriendbot();
await aqua.ensureTrustline(AQUA);
console.log("funded + AQUA trustline in place");

// escape hatch first, before our own swaps move the pool
const quote = await aqua.quote({ from: XLM, to: AQUA, amountIn: 10_000_000n, slippage: 0.05 });
const envelope = TransactionBuilder.fromXDR(await quote.buildTransaction(), aqua.network.passphrase);
assert.equal(envelope.signatures.length, 0, "escape-hatch XDR arrived signed");
console.log("buildTransaction() escape hatch: unsigned XDR parses");

const receipt = await aqua.swap({ from: XLM, to: AQUA, amountIn: 100_000_000n, retries: 3, slippage: 0.05 });
assert.ok(receipt.amountOut > 0n, "exact-input swap returned nothing");
console.log(`swap 10 XLM -> ${fmt(receipt.amountOut)} AQUA  ${EXPLORER}${receipt.txHash}`);

const receipt2 = await aqua.swap({ from: AQUA, to: XLM, amountOut: 10_000_000n, retries: 3, slippage: 0.05 });
assert.equal(receipt2.amountOut, 10_000_000n, "exact-output swap missed the target");
console.log(`swap ${fmt(receipt2.amountIn)} AQUA -> exactly 1 XLM  ${EXPLORER}${receipt2.txHash}`);

const pools = await aqua.pools.forPair(XLM, AQUA);
assert.ok(pools.length > 0, "no pools discovered for XLM/AQUA");
console.log(`pools discovered: ${pools.map(p => `${p.type}@${p.feeBps}bps`).join(", ")}`);
const pool = pools.find(p => p.type !== "concentrated");

const deposit = await retryStale(() => pool.deposit({ amounts: [[XLM, 50_000_000n], [AQUA, 500_000_000n]] }));
assert.ok(deposit.shares > 0n, "deposit minted no shares");
console.log(`deposited [${deposit.amounts.map(fmt)}] -> ${fmt(deposit.shares)} shares  ${EXPLORER}${deposit.txHash}`);
assert.equal(await pool.shareBalance(), deposit.shares, "share balance != minted shares");
assert.ok((await pool.pendingRewards()) >= 0n);

const withdraw = await retryStale(() => pool.withdraw({ shares: deposit.shares }));
assert.equal(withdraw.amounts.length, pool.tokens.length, "withdraw amounts arity mismatch");
console.log(`withdrew [${withdraw.amounts.map(fmt)}]  ${EXPLORER}${withdraw.txHash}`);

const claim = await retryStale(() => pool.claimRewards());
console.log(`claimed ${fmt(claim.amount)} AQUA rewards  ${EXPLORER}${claim.txHash}`);

await assert.rejects(
  aqua.quote({ from: XLM, to: AQUA, amountIn: 1n, amountOut: 1n }),
  AquariusError,
  "ambiguous amounts were not rejected",
);
console.log("ambiguous amounts rejected");

const concentrated = pools.find(p => p.type === "concentrated");
if (concentrated) {
  await assert.rejects(
    concentrated.deposit({ amounts: [[XLM, 10_000_000n]] }),
    AquariusError,
    "concentrated deposit was not refused",
  );
  console.log("concentrated deposit refused as designed");
}

console.log("\ntestnet lifecycle: all checks passed");
