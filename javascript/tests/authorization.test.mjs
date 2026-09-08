// Client-defined authorization only: fake RPC/context, no network.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Address, Keypair, StrKey, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

import { AquariusClient, NETWORKS, Pool } from "../dist/index.js";
import { authorizedInvocation, sourceAccountEntry } from "../dist/authorization.js";

const TOKEN_A = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TOKEN_B = "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE";
const POOL = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const OWNER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER";
const ROUTER = NETWORKS.testnet.router;
const SHARE_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 9));
const u128 = value => nativeToScVal(value, { type: "u128" });
const vector = values => xdr.ScVal.scvVec(values.map(u128));
const encodeArgs = args => args.map(value => value.toXDR("base64"));

function describe(invocation) {
  const fn = invocation.function().contractFn();
  return {
    contract: Address.fromScAddress(fn.contractAddress()).toString(),
    fn: fn.functionName().toString(),
    args: fn.args().map(scValToNative),
    children: invocation.subInvocations().map(describe),
  };
}

function poolContext(type) {
  const ctx = {
    passphrase: NETWORKS.testnet.passphrase,
    router: ROUTER,
    submitted: [],
    reads: [],
    readSource: () => OWNER,
    readRouter: async (fn, args) => {
      ctx.reads.push(fn);
      if (fn === "deposit") return xdr.ScVal.scvVec([vector([40n, 90n]), u128(1000n)]);
      if (fn === "withdraw") return vector([200n, 500n]);
      if (fn === "share_id" && type !== "concentrated") return new Address(SHARE_TOKEN).toScVal();
      throw new Error(`Unexpected read: ${fn}`);
    },
    submitContract: async (contract, fn, args, auth) => {
      ctx.submitted.push({ contract, fn, args, auth });
      const returnValue = fn === "deposit"
        ? xdr.ScVal.scvVec([vector([40n, 90n]), u128(1000n)])
        : fn === "withdraw" ? vector([200n, 500n]) : u128(7n);
      return { txHash: "hash", returnValue };
    },
  };
  return { ctx, pool: new Pool(POOL, new Uint8Array(32), type, 30, [TOKEN_A, TOKEN_B], [], ctx) };
}

for (const type of ["volatile", "stable"]) {
  test(`${type} deposit authorizes desired transfers under exact router and pool calls`, async () => {
    const { ctx, pool } = poolContext(type);
    await pool.deposit({ amounts: [100n, 200n] });
    const { args, auth } = ctx.submitted[0];
    assert.equal(auth.length, 1);
    assert.equal(auth[0].credentials().switch().name, "sorobanCredentialsSourceAccount");
    const root = auth[0].rootInvocation();
    assert.deepEqual(encodeArgs(root.function().contractFn().args()), encodeArgs(args));
    const tree = describe(root);
    assert.equal(tree.contract, ROUTER);
    assert.equal(tree.fn, "deposit");
    assert.deepEqual(tree.children, [{
      contract: POOL, fn: "deposit", args: [OWNER, [100n, 200n], 990n],
      children: [TOKEN_A, TOKEN_B].map((contract, i) => ({
        contract, fn: "transfer", args: [OWNER, POOL, [100n, 200n][i]], children: [],
      })),
    }]);
    for (const transfer of root.subInvocations()[0].subInvocations()) {
      assert.equal(transfer.function().contractFn().args()[2].switch().name, "scvI128");
    }
  });

  test(`${type} deposit mirrors the contract's zero-transfer behavior`, async () => {
    const { ctx, pool } = poolContext(type);
    await pool.deposit({ amounts: [0n, 200n] });
    const transfers = describe(ctx.submitted[0].auth[0].rootInvocation()).children[0].children;
    assert.deepEqual(transfers.map(t => t.args[2]), type === "stable" ? [200n] : [0n, 200n]);
  });

  test(`${type} withdrawal authorizes the exact LP burn`, async () => {
    const { ctx, pool } = poolContext(type);
    await pool.withdraw({ shares: 10n });
    const { args, auth } = ctx.submitted[0];
    const root = auth[0].rootInvocation();
    assert.deepEqual(encodeArgs(root.function().contractFn().args()), encodeArgs(args));
    assert.deepEqual(describe(root).children, [{
      contract: POOL, fn: "withdraw", args: [OWNER, 10n, [198n, 495n]],
      children: [{ contract: SHARE_TOKEN, fn: "burn", args: [OWNER, 10n], children: [] }],
    }]);
    assert.equal(root.subInvocations()[0].subInvocations()[0].function().contractFn().args()[1].switch().name, "scvI128");
  });
}

test("concentrated legacy withdrawal has no share-token burn or lookup", async () => {
  const { ctx, pool } = poolContext("concentrated");
  await pool.withdraw({ shares: 10n });
  assert.deepEqual(ctx.reads, ["withdraw"]);
  assert.deepEqual(describe(ctx.submitted[0].auth[0].rootInvocation()).children, [{
    contract: POOL, fn: "withdraw", args: [OWNER, 10n, [198n, 495n]], children: [],
  }]);
});

test("rewards claims authorize only the exact router and pool calls", async () => {
  const { ctx, pool } = poolContext("volatile");
  await pool.claimRewards();
  const { args, auth } = ctx.submitted[0];
  assert.deepEqual(encodeArgs(auth[0].rootInvocation().function().contractFn().args()), encodeArgs(args));
  assert.deepEqual(describe(auth[0].rootInvocation()).children, [{
    contract: POOL, fn: "claim", args: [OWNER], children: [],
  }]);
});

test("raw calls default to exact root authorization and accept an explicit tree or empty auth", async () => {
  const client = new AquariusClient({ network: "testnet", signer: Keypair.random() });
  const operations = [];
  client.engine.prepare = async (_source, buildOperation) => {
    operations.push(buildOperation().body().invokeHostFunctionOp());
    return "prepared";
  };
  client.engine.signAndSubmit = async () => ({ txHash: "hash", returnValue: u128(7n) });
  const args = [u128(10n)];
  assert.equal(await client.contract.call("custom", ...args), 7n);
  const root = operations[0].auth()[0].rootInvocation();
  assert.deepEqual(describe(root), { contract: ROUTER, fn: "custom", args: [10n], children: [] });
  const auth = [sourceAccountEntry(authorizedInvocation(ROUTER, "custom", args, [
    authorizedInvocation(TOKEN_A, "transfer", []),
  ]))];
  await client.contract.callWithAuth("custom", args, auth);
  assert.equal(operations[1].auth()[0].toXDR("base64"), auth[0].toXDR("base64"));
  await client.contract.callWithAuth("public_call", [], []);
  assert.deepEqual(operations[2].auth(), []);
  await assert.rejects(() => client.contract.callWithAuth("missing_auth", []), /explicit.*auth/i);
});
