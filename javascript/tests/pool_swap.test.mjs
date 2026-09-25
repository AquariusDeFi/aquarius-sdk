// Single-pool swaps: estimate wiring, guard math, and auth shape on a fake context.
// Mirrors python/tests/test_pool_swap.py.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Address, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";

import { AquariusError, NETWORKS, Pool } from "../dist/index.js";

const XLM_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const AQUA_ID = "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE";
const POOL_ID = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const OWNER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER";
const ROUTER = NETWORKS.testnet.router;

const u128 = value => nativeToScVal(value, { type: "u128" });

function fakeContext(estimate) {
  const ctx = {
    passphrase: "Test SDF Network ; September 2015",
    router: ROUTER,
    routerReads: [],
    submitted: [],
    submitResult: undefined,
    readSource: () => OWNER,
    readRouter: async (fn, args) => {
      ctx.routerReads.push([fn, args]);
      return u128(estimate);
    },
    readContract: async () => {
      throw new Error("pool contract must not be read for router swaps");
    },
    submitRouter: (fn, args, auth) => ctx.submitContract(ROUTER, fn, args, auth),
    submitContract: async (contractId, fn, args, auth) => {
      ctx.submitted.push([contractId, fn, args, auth]);
      return { txHash: "h", returnValue: ctx.submitResult };
    },
  };
  return ctx;
}

const volatilePool = ctx =>
  new Pool(POOL_ID, new Uint8Array(32), "volatile", 30, [XLM_ID, AQUA_ID], [], ctx);

test("quote wires the pool estimator and derives the guard", async () => {
  const ctx = fakeContext(1000n);
  const quote = await volatilePool(ctx).quote({ from: XLM_ID, to: AQUA_ID, amountIn: 500n });

  const [fn, args] = ctx.routerReads[0];
  assert.equal(fn, "estimate_swap");
  assert.equal(scValToNative(args[4]), 500n);
  assert.equal(quote.amountIn, 500n);
  assert.equal(quote.amountOut, 1000n);
  assert.equal(quote.guard, (1000n * 9_900n) / 10_000n); // default 1% slippage
});

test("quote validates input", async () => {
  const pool = volatilePool(fakeContext(1n));
  await assert.rejects(
    pool.quote({ from: XLM_ID, to: AQUA_ID, amountOut: 100n }),
    /strict-receive/,
  );
  await assert.rejects(pool.quote({ from: XLM_ID, to: AQUA_ID }), /positive amountIn/);
  await assert.rejects(
    pool.quote({ from: XLM_ID, to: POOL_ID, amountIn: 1n }),
    /not part of this pool/,
  );
  await assert.rejects(
    pool.quote({ from: XLM_ID, to: XLM_ID, amountIn: 1n }),
    /different tokens/,
  );
});

test("execute submits a pinned router swap with bounded auth", async () => {
  const ctx = fakeContext(1000n);
  ctx.submitResult = u128(995n);
  const receipt = await (
    await volatilePool(ctx).quote({ from: XLM_ID, to: AQUA_ID, amountIn: 500n })
  ).execute();

  const [contract, fn, args, auth] = ctx.submitted[0];
  assert.equal(contract, ROUTER);
  assert.equal(fn, "swap");
  assert.equal(args.length, 7);
  assert.equal(scValToNative(args[5]), 500n); // in_amount
  assert.equal(scValToNative(args[6]), 990n); // out_min = the guard
  const [entry] = auth;
  const root = entry.rootInvocation;
  assert.equal(root.function.contractFn.functionName.toString(), "swap");
  // Nested exactly like the contracts call each other:
  // router.swap -> pool.swap (require_auth) -> transfer(user, pool, amount).
  const [poolSwap] = root.subInvocations;
  const poolFn = poolSwap.function.contractFn;
  assert.equal(poolFn.functionName.toString(), "swap");
  assert.equal(scValToNative(poolFn.args[1]), 0); // in_idx (XLM)
  assert.equal(scValToNative(poolFn.args[2]), 1); // out_idx (AQUA)
  assert.equal(scValToNative(poolFn.args[3]), 500n);
  assert.equal(scValToNative(poolFn.args[4]), 990n);
  const [transfer] = poolSwap.subInvocations;
  const transferFn = transfer.function.contractFn;
  assert.equal(transferFn.functionName.toString(), "transfer");
  assert.equal(Address.fromScVal(transferFn.args[1]).toString(), POOL_ID);
  assert.equal(scValToNative(transferFn.args[2]), 500n);
  assert.equal(receipt.amountIn, 500n);
  assert.equal(receipt.amountOut, 995n);
});

test("swap surfaces AquariusError for non-slippage failures unchanged", async () => {
  const ctx = fakeContext(1000n);
  ctx.submitContract = async () => {
    throw new AquariusError("Contract error #205");
  };
  await assert.rejects(
    volatilePool(ctx).swap({ from: XLM_ID, to: AQUA_ID, amountIn: 500n, retries: 3 }),
    /205/,
  );
});
