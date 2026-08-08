// Concentrated-liquidity tests: golden tick math + pool flows on a fake context.
// Mirrors python/tests/test_concentrated.py on the shared fixture.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

import { AquariusError, MAX_TICK, Pool, snapTick, tickFromPrice } from "../dist/index.js";
import { sqrtRatioX96 } from "../dist/concentrated.js";

const FIX = JSON.parse(
  readFileSync(new URL("../../testdata/concentrated_tick_math.json", import.meta.url), "utf8"),
);

const XLM_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const AQUA_ID = "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE";
const POOL_ID = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const OWNER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

const u128 = value => nativeToScVal(value, { type: "u128" });
const u32 = value => nativeToScVal(value, { type: "u32" });
const vec = items => xdr.ScVal.scvVec(items);
const sym = s => xdr.ScVal.scvSymbol(s);

// --- tick math: parity with the golden fixture --------------------------------------

test("sqrtRatioX96 matches the golden fixture bit-for-bit", () => {
  for (const [tick, expected] of Object.entries(FIX.sqrt_ratio_x96)) {
    assert.equal(sqrtRatioX96(Number(tick)), BigInt(expected));
  }
});

test("tickFromPrice matches the golden fixture", () => {
  for (const c of FIX.tick_from_price) {
    assert.equal(tickFromPrice(c.price), c.tick);
  }
  for (const c of FIX.tick_from_price_with_decimals) {
    assert.equal(tickFromPrice(c.price, { decimals: c.decimals }), c.tick);
  }
});

test("snapTick matches the golden fixture", () => {
  for (const c of FIX.snap) {
    assert.equal(snapTick(c.tick, c.spacing, { up: c.up }), c.snapped);
  }
});

test("known values and bounds", () => {
  assert.equal(sqrtRatioX96(0), 1n << 96n);
  assert.equal(tickFromPrice("1"), 0);
  assert.equal(tickFromPrice("1.0001"), 1);
  assert.equal(tickFromPrice("0.9999"), -2); // floor semantics
  assert.throws(() => sqrtRatioX96(MAX_TICK + 1), AquariusError);
  assert.throws(() => tickFromPrice("0"), AquariusError);
  assert.throws(() => tickFromPrice("not a price"), AquariusError);
});

// --- pool flows on a fake context ---------------------------------------------------

function fakeContext(readResults) {
  const ctx = {
    passphrase: TESTNET_PASSPHRASE,
    reads: [],
    submitted: [],
    submitResult: undefined,
    readSource: () => OWNER,
    readRouter: async () => {
      throw new Error("router must not be called for concentrated positions");
    },
    readContract: async (contractId, fn, args) => {
      ctx.reads.push([contractId, fn, args]);
      return readResults[fn];
    },
    submitRouter: async () => {
      throw new Error("router must not be called for concentrated positions");
    },
    submitContract: async (contractId, fn, args, auth) => {
      ctx.submitted.push([contractId, fn, args, auth]);
      return { txHash: "h", returnValue: ctx.submitResult };
    },
  };
  return ctx;
}

function concentratedPool(ctx, type = "concentrated") {
  return new Pool(POOL_ID, new Uint8Array(32), type, 30, [XLM_ID, AQUA_ID], [], ctx);
}

test("concentrated methods refuse other pool types", async () => {
  const pool = concentratedPool(fakeContext({}), "volatile");
  await assert.rejects(pool.tickSpacing(), /concentrated/);
  await assert.rejects(
    pool.estimatePositionDeposit({ amounts: [1n, 1n], tickRange: [-60, 60] }),
    /concentrated/,
  );
});

test("estimate snaps price range and execute carries bounded auth", async () => {
  const ctx = fakeContext({
    get_tick_spacing: u32(60),
    estimate_deposit_position: vec([vec([u128(90n), u128(880n)]), u128(1234n)]),
  });
  const pool = concentratedPool(ctx);
  const est = await pool.estimatePositionDeposit({
    amounts: [100n, 900n],
    priceRange: ["0.5", "2"],
  });

  assert.equal(est.tickLower, snapTick(tickFromPrice("0.5"), 60)); // floored
  assert.equal(est.tickUpper, snapTick(tickFromPrice("2"), 60, { up: true })); // ceiled
  assert.equal(Math.abs(est.tickLower % 60), 0); // JS: negative multiples give -0
  assert.equal(Math.abs(est.tickUpper % 60), 0);
  assert.deepEqual(est.amounts, [90n, 880n]);
  assert.equal(est.liquidity, 1234n);

  ctx.submitResult = vec([vec([u128(90n), u128(880n)]), u128(1200n)]);
  const result = await est.execute({ slippage: 0.05 });

  const [contract, fn, args, auth] = ctx.submitted[0];
  assert.equal(contract, POOL_ID);
  assert.equal(fn, "deposit_position");
  assert.equal(scValToNative(args[4]), (1234n * 9_500n) / 10_000n); // min-liquidity guard
  const [entry] = auth;
  const root = entry.rootInvocation();
  assert.equal(root.function().contractFn().functionName().toString(), "deposit_position");
  const transfers = root.subInvocations();
  // Full desired amounts authorized per token, mirroring the web app.
  assert.deepEqual(
    transfers.map(t => scValToNative(t.function().contractFn().args()[2])),
    [100n, 900n],
  );
  assert.deepEqual(
    transfers.map(t => t.function().contractFn().functionName().toString()),
    ["transfer", "transfer"],
  );
  assert.deepEqual(result.amounts, [90n, 880n]);
  assert.equal(result.liquidity, 1200n);
});

test("estimate validates tick input", async () => {
  const ctx = fakeContext({ get_tick_spacing: u32(60) });
  const pool = concentratedPool(ctx);
  await assert.rejects(pool.estimatePositionDeposit({ amounts: [1n, 1n] }), /exactly one/);
  await assert.rejects(
    pool.estimatePositionDeposit({ amounts: [1n, 1n], tickRange: [-61, 60] }),
    /spacing/,
  );
  await assert.rejects(
    pool.estimatePositionDeposit({ amounts: [1n, 1n], tickRange: [60, -60] }),
    /below tickUpper/,
  );
});

test("withdraw derives min amounts and uses root-only auth", async () => {
  const ctx = fakeContext({
    get_position: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("liquidity"), val: u128(500n) }),
    ]),
    estimate_withdraw_position: vec([u128(100n), u128(200n)]),
  });
  const pool = concentratedPool(ctx);
  ctx.submitResult = vec([u128(99n), u128(199n)]);

  const result = await pool.withdrawPosition({ tickLower: -60, tickUpper: 60 });

  const [, fn, args, auth] = ctx.submitted[0];
  assert.equal(fn, "withdraw_position");
  assert.equal(scValToNative(args[3]), 500n); // liquidity defaults to the whole position
  assert.deepEqual(scValToNative(args[4]), [99n, 198n]); // estimate minus default 1%
  const [entry] = auth;
  assert.deepEqual(entry.rootInvocation().subInvocations(), []); // nothing pulled from the user
  assert.deepEqual(result.amounts, [99n, 199n]);
});

test("positionValue splits principal and fees", async () => {
  const ctx = fakeContext({
    get_position: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("liquidity"), val: u128(500n) }),
    ]),
    estimate_withdraw_position: vec([u128(110n), u128(220n)]),
    get_position_fees: vec([u128(10n), u128(20n)]),
  });
  const value = await concentratedPool(ctx).positionValue(-60, 60);
  assert.deepEqual(value.total, [110n, 220n]);
  assert.deepEqual(value.fees, [10n, 20n]);
  assert.deepEqual(value.principal, [100n, 200n]);
});

test("reads parse slot0 and ranges", async () => {
  const ctx = fakeContext({
    get_slot0: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: sym("sqrt_price_x96"),
        val: nativeToScVal(1n << 96n, { type: "u256" }),
      }),
      new xdr.ScMapEntry({ key: sym("tick"), val: xdr.ScVal.scvI32(7) }),
    ]),
    get_user_position_snapshot: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: sym("ranges"),
        val: vec([
          xdr.ScVal.scvMap([
            new xdr.ScMapEntry({ key: sym("tick_lower"), val: xdr.ScVal.scvI32(-60) }),
            new xdr.ScMapEntry({ key: sym("tick_upper"), val: xdr.ScVal.scvI32(120) }),
          ]),
        ]),
      }),
    ]),
  });
  const pool = concentratedPool(ctx);
  const slot = await pool.slot0();
  assert.equal(slot.tick, 7);
  assert.equal(slot.sqrtPriceX96, 1n << 96n);
  assert.deepEqual(await pool.positionRanges(), [[-60, 120]]);
});
