import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Account, Address, SorobanDataBuilder, TransactionBuilder, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

import { AquariusClient, AquariusError, Asset, Pool, RestoreRequiredError, XLM, sortTokenIds } from "../dist/index.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER");
const XLM_ID = XLM.contractId(TESTNET_PASSPHRASE);
const AQUA_ID = AQUA.contractId(TESTNET_PASSPHRASE);
const SORTED_PAIR = sortTokenIds([XLM_ID, AQUA_ID]);
const OWNER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER";
const POOL_ID = "CCSXYUVLYALKJGIIYMGYLZI447VS6TDWFTVDL43B4IKK2WERHLWUVCRC";
const ROUTER = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const SHARE_TOKEN = "CCNMIX72UQIM44MB4T3LIKIMADPFBNIBVHTX27QTFLB6IACJLRWM6PA4";

const poolsFixture = JSON.parse(
  readFileSync(new URL("../../testdata/pools_by_address_testnet.json", import.meta.url), "utf8"),
);

/**
 * A context that records both paths, so a build* call and its submit*
 * counterpart can be compared argument for argument.
 */
function recordingContext(readResults = {}, returnValue = undefined) {
  const ctx = {
    passphrase: TESTNET_PASSPHRASE,
    router: ROUTER,
    submitted: [],
    built: [],
    readSource: () => OWNER,
    readRouter: async (fn) => readResults[fn],
    readContract: async (_contractId, fn) => readResults[fn],
    submitRouter: async (fn, args, auth) => {
      ctx.submitted.push([fn, args, auth]);
      return { txHash: "h", returnValue };
    },
    submitContract: async (contractId, fn, args, auth) => {
      ctx.submitted.push([contractId, fn, args, auth]);
      return { txHash: "h", returnValue };
    },
    buildRouter: async (fn, args, auth) => {
      ctx.built.push([fn, args, auth]);
      return "ENVELOPE_XDR";
    },
    buildContract: async (contractId, fn, args, auth) => {
      ctx.built.push([contractId, fn, args, auth]);
      return "ENVELOPE_XDR";
    },
  };
  return ctx;
}

const scv = (v) => v.toXDR("base64");
const sameArgs = (a, b) => assert.deepEqual(a.map(scv), b.map(scv));

// --- router writes -----------------------------------------------------------------

test("buildDeposit prepares the same guarded call deposit submits", async () => {
  const reads = { deposit: (await import("@stellar/stellar-sdk")).nativeToScVal(
    [[1_000n, 2_000n], 500n],
    { type: ["u128", "u128"] },
  ) };
  // estimate_deposit is not used: the guard comes from simulating deposit itself.
  const ctx = recordingContext(reads, reads.deposit);
  const pool = new Pool(POOL_ID, new Uint8Array(32), "volatile", 30, SORTED_PAIR, [], ctx);

  await pool.deposit({ amounts: [[XLM, 10n], [AQUA, 20n]], slippage: 0.01 });
  await pool.buildDeposit({ amounts: [[XLM, 10n], [AQUA, 20n]], slippage: 0.01 });

  assert.equal(ctx.submitted.length, 1);
  assert.equal(ctx.built.length, 1);
  const [subFn, subArgs, subAuth] = ctx.submitted[0];
  const [buildFn, buildArgs, buildAuth] = ctx.built[0];
  assert.equal(subFn, "deposit");
  assert.equal(buildFn, "deposit");
  assert.equal(subAuth.length, 1);
  assert.deepEqual(subAuth.map(scv), buildAuth.map(scv)); // same auth tree
  sameArgs(subArgs, buildArgs); // identical guards, identical call
});

test("buildWithdraw and buildClaimRewards mirror their submitting twins", async () => {
  const sdk = await import("@stellar/stellar-sdk");
  const estimate = sdk.nativeToScVal([1_000n, 2_000n], { type: ["u128", "u128"] });
  const ctx = recordingContext(
    { withdraw: estimate, share_id: new Address(SHARE_TOKEN).toScVal() },
    estimate,
  );
  const pool = new Pool(POOL_ID, new Uint8Array(32), "volatile", 30, SORTED_PAIR, [], ctx);

  await pool.withdraw({ shares: 50n, slippage: 0.02 });
  await pool.buildWithdraw({ shares: 50n, slippage: 0.02 });
  sameArgs(ctx.submitted[0][1], ctx.built[0][1]);
  assert.deepEqual(ctx.submitted[0][2].map(scv), ctx.built[0][2].map(scv));

  ctx.submitted.length = 0;
  ctx.built.length = 0;
  await pool.claimRewards();
  assert.equal(await pool.buildClaimRewards(), "ENVELOPE_XDR");
  assert.equal(ctx.built[0][0], "claim");
  sameArgs(ctx.submitted[0][1], ctx.built[0][1]);
  assert.deepEqual(ctx.submitted[0][2].map(scv), ctx.built[0][2].map(scv));
});

test("buildDeposit refuses a concentrated pool before touching the network", async () => {
  const pool = new Pool(POOL_ID, new Uint8Array(32), "concentrated", 30, SORTED_PAIR, [], null);
  await assert.rejects(pool.buildDeposit({ amounts: [[XLM, 1n]] }), /full-range/);
});

// --- concentrated writes -----------------------------------------------------------

test("concentrated build* carry the same args and bounded auth as execute", async () => {
  const sdk = await import("@stellar/stellar-sdk");
  const reads = {
    get_position: sdk.nativeToScVal({ liquidity: 900n }, { type: { liquidity: ["symbol", "u128"] } }),
    estimate_withdraw_position: sdk.nativeToScVal([10n, 20n], { type: ["u128", "u128"] }),
    get_tick_spacing: sdk.nativeToScVal(60, { type: "u32" }),
  };
  const ctx = recordingContext(reads, sdk.nativeToScVal([10n, 20n], { type: ["u128", "u128"] }));
  const pool = new Pool(POOL_ID, new Uint8Array(32), "concentrated", 30, SORTED_PAIR, [], ctx);

  const params = { tickLower: -60, tickUpper: 60, liquidity: 900n, slippage: 0.01 };
  await pool.withdrawPosition(params);
  await pool.buildWithdrawPosition(params);
  const [subContract, subFn, subArgs, subAuth] = ctx.submitted[0];
  const [bContract, bFn, bArgs, bAuth] = ctx.built[0];
  assert.equal(subContract, bContract);
  assert.equal(subFn, "withdraw_position");
  assert.equal(bFn, "withdraw_position");
  sameArgs(subArgs, bArgs);
  assert.deepEqual(subAuth.map(scv), bAuth.map(scv)); // same auth tree

  ctx.submitted.length = 0;
  ctx.built.length = 0;
  await pool.claimPositionFees(-60, 60);
  await pool.buildClaimPositionFees(-60, 60);
  sameArgs(ctx.submitted[0][2], ctx.built[0][2]);
  assert.deepEqual(ctx.submitted[0][3].map(scv), ctx.built[0][3].map(scv));

  ctx.submitted.length = 0;
  ctx.built.length = 0;
  await pool.claimAllPositionFees();
  await pool.buildClaimAllPositionFees();
  assert.equal(ctx.built[0][1], "claim_all_position_fees");
  sameArgs(ctx.submitted[0][2], ctx.built[0][2]);
});

test("range deposit estimate can be built instead of executed", async () => {
  const sdk = await import("@stellar/stellar-sdk");
  const reads = {
    get_tick_spacing: sdk.nativeToScVal(60, { type: "u32" }),
    estimate_deposit_position: sdk.nativeToScVal([[5n, 7n], 111n], { type: ["u128", "u128"] }),
  };
  const ctx = recordingContext(reads, sdk.nativeToScVal([[5n, 7n], 111n], { type: ["u128", "u128"] }));
  const pool = new Pool(POOL_ID, new Uint8Array(32), "concentrated", 30, SORTED_PAIR, [], ctx);

  const estimate = await pool.estimatePositionDeposit({
    amounts: [5n, 7n],
    tickRange: [-60, 60],
  });
  await estimate.execute({ slippage: 0.01 });
  assert.equal(await estimate.buildTransaction({ slippage: 0.01 }), "ENVELOPE_XDR");

  const [, subFn, subArgs, subAuth] = ctx.submitted[0];
  const [, bFn, bArgs, bAuth] = ctx.built[0];
  assert.equal(subFn, "deposit_position");
  assert.equal(bFn, "deposit_position");
  sameArgs(subArgs, bArgs); // same min-liquidity guard
  assert.deepEqual(subAuth.map(scv), bAuth.map(scv));
});

// --- pools.byAddress ---------------------------------------------------------------

test("byAddress resolves a pool from its address in one API request", async () => {
  const entry = poolsFixture.results[0];
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ results: [entry] }) };
  };
  try {
    const client = new AquariusClient({ network: "testnet" });
    const pool = await client.pools.byAddress(entry.address);
    assert.equal(pool.address, entry.address);
    assert.equal(pool.type, "volatile");
    assert.equal(pool.feeBps, 30);
    assert.deepEqual(pool.tokens, sortTokenIds(entry.tokens_addresses));
    assert.equal(Buffer.from(pool.poolHash).toString("hex"), entry.index);
    assert.equal(urls.length, 1); // no get_pools, no second round-trip
    assert.ok(urls[0].includes(entry.address));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("byAddress on an unindexed pool says the pair is needed", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) });
  try {
    const client = new AquariusClient({ network: "testnet" });
    await assert.rejects(client.pools.byAddress("CNOTINDEXED"), /pass \{ tokens \}/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Exercise the actual client -> SubmitEngine -> RPC path, including the
// preliminary reads used to derive deposit guards and incentive auth.
async function archivedClient() {
  const entry = poolsFixture.results[0];
  const counts = { signatures: 0, submissions: 0, simulations: 0 };
  const client = new AquariusClient({
    network: "testnet",
    baseFee: "100",
    signer: {
      publicKey: () => OWNER,
      sign: () => { counts.signatures++; throw new Error("unexpected wallet prompt"); },
    },
  });
  client.api.poolsByAddresses = async () => [entry];
  client.api.findPath = async () => JSON.parse(
    readFileSync(new URL("../../testdata/find_path_testnet_xlm_aqua.json", import.meta.url), "utf8"),
  );
  client.server.getAccount = async source => new Account(source, "100");
  client.server.sendTransaction = async () => { counts.submissions++; throw new Error("unexpected send"); };
  const u128 = value => nativeToScVal(value, { type: "u128" });
  const valuesFor = (fn, args) => {
    switch (fn) {
      case "batch":
        return xdr.ScVal.scvVec(args[1].map(([, method, params]) => valuesFor(method, params)));
      case "get_init_pool_payment_token": return new Address(AQUA_ID).toScVal();
      case "get_init_pool_payment_address": return new Address(OWNER).toScVal();
      case "get_standard_pool_payment_amount":
      case "get_stable_pool_payment_amount":
      case "get_conc_pool_payment_amount": return u128(1n);
      case "init_standard_pool":
        return xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.from(entry.index, "hex")), new Address(entry.address).toScVal()]);
      case "deposit": return xdr.ScVal.scvVec([xdr.ScVal.scvVec([u128(10n), u128(20n)]), u128(1_000n)]);
      case "withdraw": return xdr.ScVal.scvVec([u128(10n), u128(20n)]);
      case "share_id": return new Address(SHARE_TOKEN).toScVal();
      case "get_gauges": return xdr.ScVal.scvMap([]);
      case "get_rewards_info": return nativeToScVal({ working_supply: 1_000n }, { type: { working_supply: ["symbol", "i128"] } });
      default: return xdr.ScVal.scvVoid();
    }
  };
  client.server.simulateTransaction = async tx => {
    counts.simulations++;
    const call = tx.operations[0].func.invokeContract;
    return {
      transactionData: new SorobanDataBuilder(),
      minResourceFee: "10",
      result: { auth: [], retval: valuesFor(call.functionName.toString(), call.args.map(scValToNative)) },
      restorePreamble: { minResourceFee: "500", transactionData: new SorobanDataBuilder() },
    };
  };
  return { client, pool: await client.pools.byAddress(entry.address), counts };
}

test("build paths return unsigned restore XDR without prompting the signer or sending", async () => {
  const builds = [
    (client, pool) => pool.buildDeposit({ amounts: [10n, 20n] }),
    (client, pool) => pool.buildWithdraw({ shares: 1n }),
    (client, pool) => pool.buildClaimRewards(),
    (client, pool) => pool.buildSetRewardsEnabled(true),
    (client, pool) => pool.buildScheduleIncentive({ token: AQUA, tps: 1n, startAt: 1_900_000_000n, durationSeconds: 86_400n }),
    (client, pool) => client.buildClaim([{ pool, kind: "rewards" }]),
    client => client.pools.buildCreate({ type: "volatile", tokens: [XLM, AQUA], feeBps: 30, amounts: [10n, 20n] }),
    async client => (await client.quote({ from: XLM, to: AQUA, amountIn: 10n })).buildTransaction(),
  ];
  for (const build of builds) {
    const { client, pool, counts } = await archivedClient();
    await assert.rejects(() => build(client, pool), error => {
      assert.ok(error instanceof RestoreRequiredError, error.stack);
      const restore = TransactionBuilder.fromXDR(error.restoreTransactionXdr, TESTNET_PASSPHRASE);
      assert.equal(restore.source, OWNER);
      assert.equal(restore.sequence, "101");
      // base fee 100 + minResourceFee 500 + 50% resource-fee headroom
      assert.equal(restore.fee, "850");
      assert.equal(restore.toEnvelope().toXdrObject().v1.tx.ext.sorobanData.resourceFee, 750n);
      assert.equal(restore.operations[0].type, "restoreFootprint");
      assert.equal(restore.signatures.length, 0);
      return true;
    });
    assert.equal(counts.signatures, 0);
    assert.equal(counts.submissions, 0);
    assert.ok(counts.simulations >= 1);
  }
});

test("reads of archived entries return their values even with a configured signer", async () => {
  const { client, pool, counts } = await archivedClient();
  assert.equal((await pool.rewardsInfo()).workingSupply, 1_000n);
  assert.equal((await client.poolCreationFee()).concentrated, 1n);
  assert.equal(counts.signatures, 0);
  assert.equal(counts.submissions, 0);
  assert.equal(counts.simulations, 2);
});

test("concentrated builders never weaken reviewed minimum amounts or liquidity", async () => {
  const sdk = await import("@stellar/stellar-sdk");
  const ctx = recordingContext({
    estimate_withdraw_position: sdk.nativeToScVal([1000n, 2000n], { type: ["u128", "u128"] }),
    get_tick_spacing: sdk.nativeToScVal(60, { type: "u32" }),
    estimate_deposit_position: sdk.nativeToScVal([[1000n, 2000n], 900n], { type: ["u128", "u128"] }),
  });
  const pool = new Pool(POOL_ID, new Uint8Array(32), "concentrated", 30, SORTED_PAIR, [], ctx);
  await pool.buildWithdrawPosition({ tickLower: -60, tickUpper: 60, liquidity: 500n, minimumAmounts: [999n, 0n] });
  assert.deepEqual(scValToNative(ctx.built.at(-1)[2][4]), [999n, 1980n]);
  const deposit = await pool.estimatePositionDeposit({ amounts: [1000n, 2000n], tickRange: [-60, 60] });
  await deposit.buildTransaction({ minimumLiquidity: 899n });
  assert.equal(scValToNative(ctx.built.at(-1)[2][4]), 899n);
  await deposit.buildTransaction({ minimumLiquidity: 1n });
  assert.equal(scValToNative(ctx.built.at(-1)[2][4]), 891n);
});
