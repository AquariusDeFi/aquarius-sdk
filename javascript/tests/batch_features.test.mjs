import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Address, Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

import {
  AquariusClient,
  AquariusError,
  Asset,
  NETWORKS,
  Pool,
  SlippageError,
  XLM,
  batchCallScVal,
  parseFindPathResponse,
  sortTokenIds,
  tickSpacingForFee,
} from "../dist/index.js";
import { batchArgs, batchResults } from "../dist/batch.js";
import { classifyContractError } from "../dist/errors.js";
import { addressSalt, deployedContractId } from "../dist/authorization.js";

const NET = NETWORKS.testnet;
const PASSPHRASE = NET.passphrase;
const AQUA = Asset.classic("AQUA", "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER");
const XLM_ID = XLM.contractId(PASSPHRASE);
const AQUA_ID = AQUA.contractId(PASSPHRASE);
const PAIR = sortTokenIds([XLM_ID, AQUA_ID]);
const OWNER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER";
const POOL_ID = "CCSXYUVLYALKJGIIYMGYLZI447VS6TDWFTVDL43B4IKK2WERHLWUVCRC";
const SHARE_ID = "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE";

const fixture = JSON.parse(
  readFileSync(new URL("../../testdata/find_path_testnet_xlm_aqua.json", import.meta.url), "utf8"),
);

const u128 = v => nativeToScVal(v, { type: "u128" });
const i128 = v => nativeToScVal(v, { type: "i128" });
const sym = s => xdr.ScVal.scvSymbol(s);
const symMap = obj =>
  xdr.ScVal.scvMap(Object.entries(obj).map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: i128(v) })));
const fnName = inv => inv.function.contractFn.functionName.toString();
const contractOf = inv => Address.fromScAddress(inv.function.contractFn.contractAddress).toString();
const argsOf = inv => inv.function.contractFn.args;

// --- batch encoding ------------------------------------------------------------------

test("batch calls encode as (address, symbol, args) and unpack in order", () => {
  const call = { contractId: POOL_ID, fn: "claim", args: [new Address(OWNER).toScVal()] };
  const native = scValToNative(batchCallScVal(call));
  assert.equal(native[0], POOL_ID);
  assert.equal(native[1], "claim");
  assert.equal(native[2][0], OWNER);

  const args = batchArgs(OWNER, [call, call], true);
  assert.equal(scValToNative(args[0])[0], OWNER); // authorizers
  assert.equal(scValToNative(args[1]).length, 2);
  assert.equal(scValToNative(args[2]), true);

  const results = batchResults(xdr.ScVal.scvVec([u128(1n), u128(2n)]), 2);
  assert.equal(results.length, 2);
  assert.throws(() => batchResults(xdr.ScVal.scvVec([u128(1n)]), 2), AquariusError);
});

// --- trustline + swap ------------------------------------------------------------------

function quoteWithCapturedOps(client) {
  const ops = [];
  client.engine.prepare = async (_source, buildOp) => {
    const op = buildOp();
    ops.push(op);
    return { toXDR: () => "ENVELOPE" };
  };
  const parsed = parseFindPathResponse(fixture, {
    amountIn: 100_000_000n,
    slippageBps: 100,
    pairLabel: "XLM -> AQUA",
  });
  const quote = client.makeQuote(parsed, true, XLM_ID, { from: XLM, to: AQUA, amountIn: 100_000_000n });
  return { quote, ops, parsed };
}

test("addTrustline wraps trust + swap in one batch with both authorized", async () => {
  const signer = Keypair.random();
  const client = new AquariusClient({ network: "testnet", signer });
  const { quote, ops, parsed } = quoteWithCapturedOps(client);

  await quote.buildTransaction({ addTrustline: true });
  const op = ops[0];
  const invoke = op.body.invokeHostFunctionOp;
  const hostFn = invoke.hostFunction.invokeContract;
  assert.equal(Address.fromScAddress(hostFn.contractAddress).toString(), NET.batch);
  assert.equal(hostFn.functionName.toString(), "batch");

  const [, calls, returnResults] = hostFn.args.map(scValToNative);
  assert.equal(returnResults, true);
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[0][0], calls[0][1]], [AQUA_ID, "trust"]);
  assert.equal(calls[0][2][0], signer.publicKey());
  assert.deepEqual([calls[1][0], calls[1][1]], [NET.router, "swap_chained"]);

  const root = invoke.auth[0].rootInvocation;
  assert.equal(fnName(root), "batch");
  const [trust, swap] = root.subInvocations;
  assert.equal(fnName(trust), "trust");
  assert.equal(contractOf(trust), AQUA_ID);
  assert.equal(fnName(swap), "swap_chained");
  const [transfer] = swap.subInvocations; // the bounded transfer survives inside the batch
  assert.equal(fnName(transfer), "transfer");
  assert.equal(scValToNative(argsOf(transfer)[2]), parsed.amountIn);
});

test("addTrustline is refused for native, contract-only and self-issued assets", async () => {
  const issuer = Keypair.random();
  const client = new AquariusClient({ network: "testnet", signer: issuer });
  client.engine.prepare = async (_source, buildOp) => ({ toXDR: () => buildOp() && "X" });
  const parsedIn = parseFindPathResponse(fixture, { amountIn: 1n, slippageBps: 100, pairLabel: "x" });
  for (const to of [XLM, Asset.contract(POOL_ID)]) {
    const q = client.makeQuote(parsedIn, true, AQUA_ID, { from: AQUA, to, amountIn: 1n });
    await assert.rejects(q.buildTransaction({ addTrustline: true }), /classic/);
  }

  const own = client.makeQuote(
    parseFindPathResponse(fixture, { amountIn: 1n, slippageBps: 100, pairLabel: "x" }),
    true,
    XLM_ID,
    { from: XLM, to: Asset.classic("OWN", issuer.publicKey()), amountIn: 1n },
  );
  await assert.rejects(own.buildTransaction({ addTrustline: true }), /issuer/);
});

test("without addTrustline the swap operation is unchanged", async () => {
  const client = new AquariusClient({ network: "testnet", signer: Keypair.random() });
  const { quote, ops } = quoteWithCapturedOps(client);
  await quote.buildTransaction();
  const hostFn = ops[0].body.invokeHostFunctionOp.hostFunction.invokeContract;
  assert.equal(Address.fromScAddress(hostFn.contractAddress).toString(), NET.router);
  assert.equal(hostFn.functionName.toString(), "swap_chained");
});

// --- pool: withdrawals through the batch -------------------------------------------------

function fakeContext(reads) {
  const ctx = {
    passphrase: PASSPHRASE,
    router: NET.router,
    rewardToken: AQUA_ID,
    batches: [],
    built: [],
    readSource: () => OWNER,
    readRouter: async fn => reads[fn],
    readContract: async (_id, fn) => reads[fn],
    readBatch: async calls => calls.map(c => reads[c.fn + "#" + scValToNative(c.args[1])] ?? reads[c.fn]),
    submitRouter: async (fn, args, withUser) => {
      ctx.routerCalls = [...(ctx.routerCalls ?? []), [fn, args, withUser]];
      return { txHash: "h", returnValue: reads.__return };
    },
    submitContract: async (id, fn, args, auth) => {
      ctx.contractCalls = [...(ctx.contractCalls ?? []), [id, fn, args, auth]];
      return { txHash: "h", returnValue: reads.__return };
    },
    submitBatch: async (calls, auth, returnResults) => {
      ctx.batches.push({ calls, auth, returnResults });
      return { txHash: "h", returnValue: reads.__return };
    },
    buildRouter: async (fn, args, withUser) => {
      ctx.built.push([fn, args, withUser]);
      return "XDR";
    },
    buildContract: async (id, fn, args, auth) => {
      ctx.built.push([id, fn, args, auth]);
      return "XDR";
    },
    buildBatch: async (calls, auth, returnResults) => {
      ctx.built.push({ calls, auth, returnResults });
      return "XDR";
    },
  };
  return ctx;
}
const pool = (ctx, type = "volatile") => new Pool(POOL_ID, new Uint8Array(32), type, 30, PAIR, [], ctx);

test("withdrawAndClaim batches a bounded burn withdrawal with the requested claims", async () => {
  const ctx = fakeContext({
    share_id: new Address(SHARE_ID).toScVal(),
    withdraw: nativeToScVal([1_000n, 2_000n], { type: ["u128", "u128"] }),
    __return: xdr.ScVal.scvVec([nativeToScVal([990n, 1980n], { type: ["u128", "u128"] }), u128(5n), u128(0n)]),
  });
  const p = pool(ctx);
  const result = await p.withdrawAndClaim({ shares: 50n, slippage: 0.01, claimRewards: true, claimIncentives: true });
  assert.deepEqual(result.amounts, [990n, 1980n]);

  const { calls, auth, returnResults } = ctx.batches[0];
  assert.equal(returnResults, true);
  assert.deepEqual(calls.map(c => c.fn), ["withdraw", "claim", "gauges_claim"]);
  assert.ok(calls.every(c => c.contractId === POOL_ID));
  const [, shares, minimums] = calls[0].args.map(scValToNative);
  assert.equal(shares, 50n);
  assert.deepEqual(minimums, [990n, 1980n]); // estimate reduced by 1%

  const [burn] = auth[0].subInvocations;
  assert.equal(fnName(burn), "burn");
  assert.equal(contractOf(burn), SHARE_ID);
  assert.equal(scValToNative(argsOf(burn)[1]), 50n);
  assert.deepEqual(auth.slice(1).map(fnName), ["claim", "gauges_claim"]);

  await p.buildWithdrawAndClaim({ shares: 50n });
  assert.deepEqual(ctx.built[0].calls.map(c => c.fn), ["withdraw"]); // no claims requested
});

test("withdrawOneCoin guards with calc_withdraw_one_coin and targets the token index", async () => {
  const ctx = fakeContext({
    share_id: new Address(SHARE_ID).toScVal(),
    calc_withdraw_one_coin: u128(4_000n),
    // withdraw_one_coin returns Vec<u128>, with zero in every other slot.
    __return: xdr.ScVal.scvVec([xdr.ScVal.scvVec(PAIR.map(t => u128(t === AQUA_ID ? 3_970n : 0n)))]),
  });
  const p = pool(ctx, "stable");
  const result = await p.withdrawOneCoin({ shares: 10n, token: AQUA, slippage: 0.01 });
  assert.equal(result.amount, 3_970n);
  const [, shares, index, minimum] = ctx.batches[0].calls[0].args.map(scValToNative);
  assert.equal(shares, 10n);
  assert.equal(index, PAIR.indexOf(AQUA_ID));
  assert.equal(minimum, 3_960n);
  await assert.rejects(p.withdrawOneCoin({ shares: 1n, token: Asset.contract("CFOREIGN") }), /not one of/);

  ctx.readBatch = async calls => calls.map((_, i) => u128(BigInt(100 + i)));
  assert.deepEqual(await p.estimateWithdrawOneCoin(1n), [100n, 101n]);
});

test("withdrawImbalanced caps the shares from a simulation, rounding up", async () => {
  const ctx = fakeContext({
    share_id: new Address(SHARE_ID).toScVal(),
    balance: i128(10_000n),
    remove_liquidity_imbalance: u128(999n),
    __return: xdr.ScVal.scvVec([u128(1_000n)]),
  });
  const p = pool(ctx, "stable");
  const result = await p.withdrawImbalanced({ amounts: [[XLM, 5n], [AQUA, 7n]], slippage: 0.01 });
  assert.equal(result.shares, 1_000n);
  const { calls, auth } = ctx.batches[0];
  assert.equal(calls[0].fn, "remove_liquidity_imbalance");
  const [, amounts, maxShares] = calls[0].args.map(scValToNative);
  assert.deepEqual([...amounts].sort(), [5n, 7n]);
  assert.equal(maxShares, 1_009n); // ceil(999 * 1.01)
  assert.equal(scValToNative(argsOf(auth[0].subInvocations[0])[1]), 1_009n); // burn cap = share cap
});

test("single-token withdrawals decode every token slot with bundled claims", async () => {
  for (const token of PAIR) {
    const ctx = fakeContext({
      share_id: new Address(SHARE_ID).toScVal(),
      calc_withdraw_one_coin: u128(4_000n),
      __return: xdr.ScVal.scvVec([
        xdr.ScVal.scvVec(PAIR.map(t => u128(t === token ? 3_970n : 0n))),
        u128(5n),
        xdr.ScVal.scvMap([]),
      ]),
    });
    assert.deepEqual(
      await pool(ctx, "stable").withdrawOneCoin({ shares: 10n, token, claimRewards: true, claimIncentives: true }),
      { txHash: "h", amount: 3_970n },
    );
  }
});

test("malformed confirmed withdrawal results retain the transaction hash", async () => {
  for (const value of [u128(3_970n), xdr.ScVal.scvVec([u128(3_970n)])]) {
    const ctx = fakeContext({
      share_id: new Address(SHARE_ID).toScVal(),
      calc_withdraw_one_coin: u128(4_000n),
      __return: xdr.ScVal.scvVec([value]),
    });
    await assert.rejects(
      pool(ctx, "stable").withdrawOneCoin({ shares: 10n, token: AQUA }),
      e => e instanceof AquariusError && e.txHash === "h" && /confirmed transaction/.test(e.message),
    );
  }
});

test("stable-only withdrawal methods reject other pool types before RPC", async () => {
  for (const type of ["volatile", "concentrated"]) {
    const p = pool(null, type);
    for (const operation of [
      () => p.estimateWithdrawOneCoin(1n),
      () => p.buildWithdrawOneCoin({ shares: 1n, token: AQUA }),
      () => p.withdrawOneCoin({ shares: 1n, token: AQUA }),
      () => p.estimateWithdrawImbalanced([1n, 1n]),
      () => p.buildWithdrawImbalanced({ amounts: [1n, 1n] }),
    ]) {
      await assert.rejects(operation, /only available for stable pools/);
    }
  }
});

// --- pool: rewards, boost, incentives -------------------------------------------------

test("rewardsInfo, rewardsEnabled and working balance parse the contract's shapes", async () => {
  const ctx = fakeContext({
    get_rewards_info: symMap({ to_claim: 5n, tps: 7n, exp_at: 1_700_000_000n, working_balance: 3n, working_supply: 9n, supply: 12n }),
    get_rewards_state: xdr.ScVal.scvBool(true),
    estimate_working_balance: nativeToScVal([30n, 90n], { type: ["i128", "i128"] }),
  });
  const p = pool(ctx);
  const info = await p.rewardsInfo();
  assert.equal(info.toClaim, 5n);
  assert.equal(info.tps, 7n);
  assert.equal(info.expiresAt, 1_700_000_000n);
  assert.equal(info.workingBalance, 3n);
  assert.equal(info.supply, 12n);
  assert.equal(info.raw.to_claim, 5n);
  assert.equal(await p.rewardsEnabled(), true);
  assert.deepEqual(await p.estimateWorkingBalance(100n), { workingBalance: 30n, workingSupply: 90n });
  await assert.rejects(p.estimatePositionWorkingBalance(-60, 60, 1n), /concentrated/);
  assert.deepEqual(await pool(ctx, "concentrated").estimatePositionWorkingBalance(-60, 60, 1n), {
    workingBalance: 30n,
    workingSupply: 90n,
  });
});

test("setRewardsEnabled and claimIncentives authorize the pool call itself", async () => {
  const ctx = fakeContext({ __return: xdr.ScVal.scvVoid() });
  const p = pool(ctx);
  await p.setRewardsEnabled(false);
  await p.buildSetRewardsEnabled(true);
  const [id, fn, args, auth] = ctx.contractCalls[0];
  assert.equal(id, POOL_ID);
  assert.equal(fn, "set_rewards_state");
  assert.equal(scValToNative(args[1]), false);
  assert.equal(fnName(auth[0].rootInvocation), "set_rewards_state");
  assert.equal(scValToNative(ctx.built[0][2][1]), true);

  await p.claimIncentives();
  assert.equal(ctx.contractCalls[1][1], "gauges_claim");
  assert.equal(fnName(ctx.contractCalls[1][3][0].rootInvocation), "gauges_claim");
});

test("incentives and gauges parse token-keyed maps", async () => {
  const ctx = fakeContext({
    gauges_get_reward_info: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: new Address(AQUA_ID).toScVal(),
        val: symMap({ tps: 2n, expired_at: 99n, user_reward: 11n }),
      }),
    ]),
    get_gauges: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: new Address(AQUA_ID).toScVal(), val: new Address(SHARE_ID).toScVal() }),
    ]),
  });
  const p = pool(ctx);
  assert.deepEqual(await p.incentives(), [{ token: AQUA_ID, tps: 2n, expiresAt: 99n, userReward: 11n }]);
  assert.deepEqual(await p.gauges(), [{ token: AQUA_ID, gauge: SHARE_ID }]);
});


// --- client: multi-pool claims, creation, config ------------------------------------------

function clientWithCapturedBatches(signer = Keypair.random()) {
  const client = new AquariusClient({ network: "testnet", signer });
  client.batches = [];
  client.submitBatch = async (calls, auth, returnResults) => {
    client.batches.push({ calls, auth, returnResults });
    return { txHash: "h", returnValue: undefined };
  };
  client.buildBatch = async (calls, auth, returnResults) => {
    client.batches.push({ calls, auth, returnResults, built: true });
    return "XDR";
  };
  return client;
}

test("claim bundles rewards, incentives and position fees across pools", async () => {
  const client = clientWithCapturedBatches();
  const a = pool(fakeContext({}));
  const b = new Pool(SHARE_ID, new Uint8Array(32), "concentrated", 30, PAIR, [], fakeContext({}));
  await client.claim([
    { pool: a, kind: "rewards" },
    { pool: a, kind: "incentives" },
    { pool: b, kind: "positionFees" },
  ]);
  const { calls, auth, returnResults } = client.batches[0];
  assert.equal(returnResults, false);
  assert.deepEqual(
    calls.map(c => [c.contractId, c.fn]),
    [[POOL_ID, "claim"], [POOL_ID, "gauges_claim"], [SHARE_ID, "claim_all_position_fees"]],
  );
  assert.deepEqual(auth.map(fnName), ["claim", "gauges_claim", "claim_all_position_fees"]);
  await assert.rejects(client.claim([]), /Nothing/);
});

test("poolCreationFee and incentives.config read the router in one batch each", async () => {
  const client = new AquariusClient({ network: "testnet" });
  client.readBatch = async calls => {
    assert.ok(calls.every(c => c.contractId === NET.router));
    return calls.map(c => ({
      get_init_pool_payment_token: new Address(AQUA_ID).toScVal(),
      get_standard_pool_payment_amount: u128(100n),
      get_stable_pool_payment_amount: u128(250n),
      get_conc_pool_payment_amount: u128(375n),
      get_init_pool_payment_address: new Address(OWNER).toScVal(),
      pool_gauge_get_min_duration: nativeToScVal(86_400n, { type: "u64" }),
      pool_gauge_get_min_daily_amount: u128(7n),
    })[c.fn]);
  };
  assert.deepEqual(await client.poolCreationFee(), {
    token: AQUA_ID,
    destination: OWNER,
    volatile: 100n,
    stable: 250n,
    concentrated: 375n,
  });
  assert.deepEqual(await client.incentives.config(), { minDurationSeconds: 86_400n, minDailyAmount: 7n });
});

function creatingClient(minted = 1_000n) {
  const signer = Keypair.random();
  const client = clientWithCapturedBatches(signer);
  client.poolCreationFee = async () => ({
    token: AQUA_ID,
    destination: OWNER,
    volatile: 100n,
    stable: 250n,
    concentrated: 375n,
  });
  client.simulated = [];
  client.engine.read = async (_source, buildOp) => {
    const op = buildOp();
    client.simulated.push(op);
    const initResult = xdr.ScVal.scvVec([xdr.ScVal.scvBytes(Buffer.alloc(32, 7)), new Address(POOL_ID).toScVal()]);
    const invocation = op.body.invokeHostFunctionOp.hostFunction.invokeContract;
    if (invocation.functionName.toString() !== "batch") return initResult;
    const calls = scValToNative(invocation.args[1]);
    assert.equal(calls.length, 2);
    assert.match(calls[0][1], /^init_/);
    assert.match(calls[1][1], /^deposit/);
    return xdr.ScVal.scvVec([
      initResult,
      xdr.ScVal.scvVec([xdr.ScVal.scvVec([u128(500n), u128(700n)]), u128(minted)]),
    ]);
  };
  return { client, signer };
}

test("pools.create is init + first deposit in one batch, fee and transfers authorized", async () => {
  const { client, signer } = creatingClient();
  const { pool: created } = await client.pools.create({
    type: "volatile",
    tokens: [XLM, AQUA],
    feeBps: 30,
    amounts: [[XLM, 500n], [AQUA, 700n]],
  });
  assert.equal(created.address, POOL_ID);
  assert.equal(created.type, "volatile");
  assert.equal(created.feeBps, 30);
  assert.deepEqual(created.tokens, PAIR);
  assert.equal(Buffer.from(created.poolHash).toString("hex"), "07".repeat(32));

  // the address came from simulating the init on its own, with its fee auth
  const init = client.simulated[0].body.invokeHostFunctionOp;
  assert.equal(init.hostFunction.invokeContract.functionName.toString(), "init_standard_pool");
  assert.equal(fnName(init.auth[0].rootInvocation.subInvocations[0]), "transfer");

  const { calls, auth, returnResults } = client.batches[0];
  assert.equal(returnResults, true);
  assert.deepEqual(calls.map(c => [c.contractId, c.fn]), [[NET.router, "init_standard_pool"], [POOL_ID, "deposit"]]);
  const initArgs = calls[0].args.map(scValToNative);
  assert.equal(initArgs[0], signer.publicKey());
  assert.deepEqual(initArgs[1], PAIR);
  assert.equal(initArgs[2], 30);
  const [, amounts, minShares] = calls[1].args.map(scValToNative);
  assert.deepEqual([...amounts].sort(), [500n, 700n]);
  assert.equal(minShares, 990n);
  assert.equal(client.simulated.length, 2); // init, then the entire init + deposit batch
  const previewCalls = scValToNative(client.simulated[1].body.invokeHostFunctionOp.hostFunction.invokeContract.args[1]);
  assert.equal(previewCalls[1][2].at(-1), 1n);
  assert.deepEqual(argsOf(auth[1]).map(scValToNative), calls[1].args.map(scValToNative));

  const [feeTransfer] = auth[0].subInvocations;
  assert.equal(contractOf(feeTransfer), AQUA_ID);
  assert.equal(scValToNative(argsOf(feeTransfer)[1]), OWNER);
  assert.equal(scValToNative(argsOf(feeTransfer)[2]), 100n); // the volatile fee
  assert.equal(auth[1].subInvocations.length, 2); // one transfer per token into the new pool
  assert.ok(auth[1].subInvocations.every(t => scValToNative(argsOf(t)[1]) === POOL_ID));
});

test("pools.create for a concentrated pool snaps the range and opens a position", async () => {
  const { client } = creatingClient();
  const spacing = tickSpacingForFee(30);
  await client.pools.create({
    type: "concentrated",
    tokens: [XLM, AQUA],
    feeBps: 30,
    amounts: [[XLM, 5n], [AQUA, 5n]],
    priceRange: ["0.9", "1.1"],
  });
  const { calls, auth } = client.batches[0];
  assert.equal(calls[0].fn, "init_concentrated_pool");
  assert.equal(calls[1].fn, "deposit_position");
  const [, lower, upper, desired, minLiquidity] = calls[1].args.map(scValToNative);
  assert.ok(lower < 0 && upper > 0);
  assert.equal(Math.abs(lower) % spacing, 0);
  assert.equal(Math.abs(upper) % spacing, 0);
  assert.deepEqual(desired, [5n, 5n]);
  assert.equal(minLiquidity, 990n);
  assert.equal(scValToNative(argsOf(auth[0].subInvocations[0])[2]), 375n); // independent concentrated fee
  assert.equal(fnName(auth[1]), "deposit_position");
});

test("pools.create refuses empty deposits, bad arity and unknown tiers", async () => {
  const { client } = creatingClient();
  await assert.rejects(
    client.pools.create({ type: "volatile", tokens: [XLM, AQUA], feeBps: 30, amounts: [0n, 0n] }),
    /non-zero/,
  );
  await assert.rejects(
    client.pools.create({ type: "volatile", tokens: [XLM, AQUA, Asset.contract("CTHIRD")], feeBps: 30, amounts: [1n, 1n, 1n] }),
    /exactly two/,
  );
  await assert.rejects(
    client.pools.create({ type: "concentrated", tokens: [XLM, AQUA], feeBps: 42, amounts: [1n, 1n], tickRange: [-60, 60] }),
    /fee tier/,
  );
  await assert.rejects(
    client.pools.create({ type: "concentrated", tokens: [XLM, AQUA], feeBps: 30, amounts: [1n, 1n] }),
    /tickRange or priceRange/,
  );
  assert.equal(client.batches.length, 0);
});

test("pool creation guards custom slippage and never rounds a positive minimum to zero", async () => {
  for (const [minted, slippage, expected] of [[1_000n, 0.025, 975n], [1_000n, 0, 1_000n], [1n, 0.01, 1n]]) {
    const { client } = creatingClient(minted);
    await client.pools.buildCreate({ type: "stable", tokens: [XLM, AQUA], feeBps: 30, amounts: [500n, 700n], slippage });
    const { calls, auth } = client.batches[0];
    assert.equal(scValToNative(calls[1].args.at(-1)), expected);
    assert.deepEqual(argsOf(auth[1]).map(scValToNative), calls[1].args.map(scValToNative));
  }
  for (const slippage of [-0.1, 1, 2, NaN, Infinity]) {
    const { client } = creatingClient();
    await assert.rejects(
      client.pools.buildCreate({ type: "volatile", tokens: [XLM, AQUA], feeBps: 30, amounts: [1n, 1n], slippage }),
      /slippage/,
    );
    assert.equal(client.simulated.length, 0);
  }
});

test("pool creation rejects a failed mint estimate before building or submitting", async () => {
  const { client } = creatingClient(0n);
  await assert.rejects(
    client.pools.create({ type: "volatile", tokens: [XLM, AQUA], feeBps: 30, amounts: [500n, 700n] }),
    /positive shares\/liquidity/,
  );
  assert.equal(client.batches.length, 0);
});

test("creation into a resolved pool refuses a deposit that moved past the preview guard", async () => {
  for (const type of ["volatile", "stable", "concentrated"]) {
    const { client } = creatingClient(1_000n);
    // Keep the real buildBatch path, inspecting the operation sent to prepare.
    delete client.buildBatch;
    client.engine.prepare = async (_source, buildOp) => {
      const op = buildOp().body.invokeHostFunctionOp;
      const calls = scValToNative(op.hostFunction.invokeContract.args[1]);
      const minimum = calls[1][2].at(-1);
      const authArgs = argsOf(op.auth[0].rootInvocation.subInvocations[1]).map(scValToNative);
      assert.equal(authArgs.at(-1), minimum);
      // The pool would now mint 980, below the 990 bound of the 1000 preview.
      if (980n < minimum) throw classifyContractError("Error(Contract, #2006)");
      return { toXDR: () => "UNGUARDED" };
    };
    await assert.rejects(
      client.pools.buildCreate({ type, tokens: [XLM, AQUA], feeBps: 30, amounts: [500n, 700n], tickRange: [-60, 60] }),
      SlippageError,
    );
    assert.equal(client.batches.length, 0);
  }
});

test("batch.read splits a batch that exceeds the simulation budget, keeping order", async () => {
  const client = new AquariusClient({ network: "testnet" });
  let simulations = 0;
  client.engine.read = async (_source, buildOp) => {
    simulations++;
    const op = buildOp();
    const calls = scValToNative(op.body.invokeHostFunctionOp.hostFunction.invokeContract.args[1]);
    // Use the actual error classification performed by SubmitEngine.read.
    if (calls.length > 2) throw classifyContractError("HostError: Error(Budget, ExceededLimit)");
    return xdr.ScVal.scvVec(calls.map(c => u128(BigInt(c[1].length))));
  };
  const calls = ["a", "bb", "ccc", "dddd", "eeeee"].map(fn => ({ contractId: POOL_ID, fn, args: [] }));
  const values = (await client.batch.read(calls)).map(scValToNative);
  assert.deepEqual(values, [1n, 2n, 3n, 4n, 5n]);
  assert.ok(simulations >= 4);
  assert.deepEqual(await client.batch.read([]), []);
});


// --- scheduleIncentive: client-built auth, checked against a testnet simulation ---------------

// Recorded from a testnet simulation of pool_gauge_schedule_reward (e2e/inspect_schedule_auth.mjs).
const GOLDEN = {
  pool: "CA3ONLQ2ICEVLKPN6DVOISTH4P2Q6K5EDH6RFTVVQ3LCJ6CZLT2FD466",
  gauge: "CAFKAOVPNWXCKWX27D6AMSMICAHFRERI3O56XVKJYZ26P7UJLCGIQZ5R",
  user: OWNER,
  tps: 10_000_000n,
  startAt: 1_789_475_057n,
  duration: 86_400n,
  workingSupply: 7_466_711_709n,
  transfer: 864_000_000_000n,
};

test("gauge address derivation works without a global Buffer", () => {
  const original = globalThis.Buffer;
  try {
    delete globalThis.Buffer;
    const salt = addressSalt([GOLDEN.pool, AQUA_ID]);
    assert.equal(deployedContractId(NET.router, salt, PASSPHRASE), GOLDEN.gauge);
  } finally {
    globalThis.Buffer = original;
  }
});

test("the reward gauge address is derived exactly as the router deploys it", async () => {
  const ctx = fakeContext({ get_gauges: xdr.ScVal.scvMap([]) });
  const p = new Pool(GOLDEN.pool, new Uint8Array(32), "volatile", 30, PAIR, [], ctx);
  assert.equal(await p.gaugeFor(AQUA), GOLDEN.gauge); // not attached yet -> derived
  ctx.readContract = async () =>
    xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: new Address(AQUA_ID).toScVal(), val: new Address(SHARE_ID).toScVal() })]);
  assert.equal(await p.gaugeFor(AQUA), SHARE_ID); // attached -> read
});

test("scheduleIncentive on a volatile pool builds the router -> pool -> gauge -> transfer tree", async () => {
  const ctx = fakeContext({
    get_gauges: xdr.ScVal.scvMap([]),
    get_rewards_info: symMap({ working_supply: GOLDEN.workingSupply, to_claim: 0n }),
    __return: xdr.ScVal.scvVoid(),
  });
  const p = new Pool(GOLDEN.pool, new Uint8Array(32), "volatile", 30, PAIR, [], ctx);
  await p.scheduleIncentive({ token: AQUA, tps: GOLDEN.tps, startAt: GOLDEN.startAt, durationSeconds: GOLDEN.duration });

  const [contractId, fn, args, auth] = ctx.contractCalls[0];
  assert.equal(contractId, NET.router);
  assert.equal(fn, "pool_gauge_schedule_reward");
  const native = args.map(scValToNative);
  assert.equal(native[0], GOLDEN.user);
  assert.deepEqual(native[1], PAIR);
  assert.equal(native[3], AQUA_ID);
  assert.deepEqual(native.slice(4), [GOLDEN.tps, GOLDEN.startAt, GOLDEN.duration, []]);

  assert.equal(auth.length, 1);
  assert.equal(auth[0].credentials.type, "sorobanCredentialsSourceAccount");
  const root = auth[0].rootInvocation;
  assert.equal(contractOf(root), NET.router);
  assert.equal(fnName(root), "pool_gauge_schedule_reward");
  assert.deepEqual(argsOf(root).map(a => a.toXDR("base64")), args.map(a => a.toXDR("base64")));

  const [poolCall] = root.subInvocations;
  assert.equal(contractOf(poolCall), GOLDEN.pool);
  assert.equal(fnName(poolCall), "gauge_schedule_reward");
  assert.deepEqual(argsOf(poolCall).map(scValToNative), [
    NET.router, GOLDEN.user, GOLDEN.gauge, GOLDEN.startAt, GOLDEN.duration, GOLDEN.tps,
  ]);

  const [gaugeCall] = poolCall.subInvocations;
  assert.equal(contractOf(gaugeCall), GOLDEN.gauge);
  assert.equal(fnName(gaugeCall), "schedule_rewards_config");
  assert.deepEqual(argsOf(gaugeCall).map(scValToNative), [
    GOLDEN.pool, GOLDEN.user, GOLDEN.startAt, GOLDEN.duration, GOLDEN.tps, GOLDEN.workingSupply,
  ]);

  const [transfer] = gaugeCall.subInvocations;
  assert.equal(contractOf(transfer), AQUA_ID);
  assert.equal(fnName(transfer), "transfer");
  assert.deepEqual(argsOf(transfer).map(scValToNative), [GOLDEN.user, GOLDEN.gauge, GOLDEN.transfer]);
  assert.equal(transfer.subInvocations.length, 0);

  await assert.rejects(p.scheduleIncentive({ token: AQUA, tps: 0n, startAt: 1, durationSeconds: 1 }), /tps/);
});

test("scheduleIncentive on a concentrated pool funds the incentives vault directly", async () => {
  const VAULT = SHARE_ID;
  const ctx = fakeContext({
    get_incentives_vault_addr: new Address(VAULT).toScVal(),
    __return: xdr.ScVal.scvVoid(),
  });
  const p = new Pool(GOLDEN.pool, new Uint8Array(32), "concentrated", 30, PAIR, [], ctx);
  await p.buildScheduleIncentive({ token: XLM, tps: 5n, startAt: 100, durationSeconds: 1_000 });

  const [, , , auth] = ctx.built[0];
  const [poolCall] = auth[0].rootInvocation.subInvocations;
  assert.equal(fnName(poolCall), "tick_schedule_reward");
  assert.deepEqual(argsOf(poolCall).map(scValToNative), [NET.router, OWNER, XLM_ID, 100n, 1_000n, 5n]);
  const [transfer] = poolCall.subInvocations;
  assert.equal(contractOf(transfer), XLM_ID);
  assert.deepEqual(argsOf(transfer).map(scValToNative), [OWNER, VAULT, 5_000n]);

  // no vault yet -> the address the pool will deploy it at, salted with the pool and AQUA
  ctx.readContract = async () => xdr.ScVal.scvVoid();
  const { deployedContractId, addressSalt } = await import("../dist/authorization.js");
  assert.equal(
    await p.incentivesVault(),
    deployedContractId(GOLDEN.pool, addressSalt([GOLDEN.pool, AQUA_ID], "incentives"), PASSPHRASE),
  );
});
