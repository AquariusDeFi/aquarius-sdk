// Provider-fee collectors: read/claim wiring and auth shape on a fake context.
// Mirrors python/tests/test_collector.py.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

import { AquariusError, FeeCollector } from "../dist/index.js";

const COLLECTOR = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const USDC = "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE";
const OWNER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER";
const DEST = "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";

const CHAIN_XDR = xdr.ScVal.scvVec([]).toXDR("base64");

function fakeContext(reads = {}) {
  const ctx = {
    passphrase: "Test SDF Network ; September 2015",
    reads,
    readCalls: [],
    submitted: [],
    submitResult: undefined,
    quotes: [],
    readSource: () => OWNER,
    readContract: async (contractId, fn, args) => {
      ctx.readCalls.push([contractId, fn, args]);
      return ctx.reads[fn];
    },
    submitContract: async (contractId, fn, args, auth) => {
      ctx.submitted.push([contractId, fn, args, auth]);
      return { txHash: "h", returnValue: ctx.submitResult };
    },
    quoteSwapChain: async (from, to, amountIn, slippage) => {
      ctx.quotes.push([from, to, amountIn, slippage]);
      return { swapChainXdr: CHAIN_XDR, guard: (amountIn * 99n) / 100n };
    },
  };
  return ctx;
}

test("reads wire the collector contract", async () => {
  const ctx = fakeContext({
    get_fee_destination: new Address(DEST).toScVal(),
    get_max_swap_fee_fraction: nativeToScVal(100, { type: "u32" }),
    balance: nativeToScVal(12345n, { type: "i128" }),
  });
  const collector = new FeeCollector(COLLECTOR, ctx);
  assert.equal(await collector.feeDestination(), DEST);
  assert.equal(await collector.maxFeeFraction(), 100);
  assert.equal(await collector.balance(TOKEN), 12345n);
  const [contractId, fn, args] = ctx.readCalls.at(-1);
  assert.equal(contractId, TOKEN);
  assert.equal(fn, "balance");
  assert.equal(Address.fromScVal(args[0]).toString(), COLLECTOR);
});

test("feeConfig builds a provider fee for this collector", () => {
  const config = new FeeCollector(COLLECTOR, fakeContext()).feeConfig(30, { recipient: DEST });
  assert.deepEqual(config, {
    contractId: COLLECTOR,
    feeFraction: 30,
    feeDenominator: 10_000,
    recipient: DEST,
  });
});

test("claim submits root-only operator auth", async () => {
  const ctx = fakeContext();
  ctx.submitResult = nativeToScVal(777n, { type: "u128" });
  const claimed = await new FeeCollector(COLLECTOR, ctx).claim(TOKEN);

  const [contractId, fn, args, auth] = ctx.submitted[0];
  assert.equal(contractId, COLLECTOR);
  assert.equal(fn, "claim_fees");
  assert.equal(Address.fromScVal(args[0]).toString(), OWNER);
  assert.equal(Address.fromScVal(args[1]).toString(), TOKEN);
  const [entry] = auth;
  const root = entry.rootInvocation;
  assert.equal(root.function.contractFn.functionName.toString(), "claim_fees");
  assert.deepEqual(root.subInvocations, []); // the contract moves its own tokens
  assert.equal(claimed.amountIn, 777n);
  assert.equal(claimed.amountOut, 777n);
});

test("claimAndSwap quotes the balance and guards the swap", async () => {
  const ctx = fakeContext({ balance: nativeToScVal(1000n, { type: "i128" }) });
  ctx.submitResult = nativeToScVal(950n, { type: "u128" });
  const claimed = await new FeeCollector(COLLECTOR, ctx).claimAndSwap(TOKEN, USDC, {
    slippage: 0.05,
  });

  const [, , amountIn, slippage] = ctx.quotes[0];
  assert.equal(amountIn, 1000n);
  assert.equal(slippage, 0.05);
  const [, fn, args, auth] = ctx.submitted[0];
  assert.equal(fn, "claim_fees_and_swap");
  assert.equal(scValToNative(args[3]), (1000n * 99n) / 100n); // quote guard as out_min
  const [entry] = auth;
  assert.deepEqual(entry.rootInvocation.subInvocations, []);
  assert.equal(claimed.amountIn, 1000n);
  assert.equal(claimed.amountOut, 950n);
});

test("balance returns zero for a never-held token", async () => {
  const ctx = fakeContext();
  ctx.readContract = async () => {
    throw new AquariusError("HostError: Error(Storage, MissingValue)");
  };
  assert.equal(await new FeeCollector(COLLECTOR, ctx).balance(TOKEN), 0n);
});

test("balance re-raises other read errors", async () => {
  const ctx = fakeContext();
  ctx.readContract = async () => {
    throw new AquariusError("HostError: Error(Contract, #205)");
  };
  await assert.rejects(new FeeCollector(COLLECTOR, ctx).balance(TOKEN), /205/);
});

test("claimAndSwap refuses an empty balance", async () => {
  const ctx = fakeContext({ balance: nativeToScVal(0n, { type: "i128" }) });
  await assert.rejects(
    new FeeCollector(COLLECTOR, ctx).claimAndSwap(TOKEN, USDC),
    AquariusError,
  );
});
