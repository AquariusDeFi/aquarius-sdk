import { Transaction as StellarTransaction } from "@stellar/stellar-sdk";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test as it, describe, beforeEach, mock } from "node:test";
import { format } from "node:util";
import * as sdk from "../dist/index.js";
import {
  Account,
  Address,
  Asset,
  hash,
  nativeToScVal,
  Networks,
  Operation,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
const vector = JSON.parse(
  readFileSync(new URL("../../testdata/limit_order_onchain_draft.json", import.meta.url), "utf8"),
);
const validateLimitOrderDraft = (
  draft,
  intent,
  settlement,
  xlm,
  reward,
  allow = false,
  require = false,
) =>
  sdk.validateLimitOrderDraft(
    draft,
    intent,
    settlement,
    xlm,
    reward,
    Networks.TESTNET,
    allow,
    require,
  );
const {} = sdk;
const each = (cases, name, run) => {
  for (const item of cases) {
    const args = Array.isArray(item) ? item : [item];
    it(format(name, ...args), () => run(...args));
  }
};
const messageIncludes = (expected) => (error) =>
  typeof expected === "string" ? error.message.includes(expected) : error instanceof expected;
const ENV_TESTNET = "testnet";
const CONTRACTS = {
  testnet: {
    batch: "CCNMIX72UQIM44MB4T3LIKIMADPFBNIBVHTX27QTFLB6IACJLRWM6PA4",
    guard: "CCNRZ56LMLRLWOFKFUVPIJ2EJ33WAF34QPG4KE2VONFCSN3LIWBZC45Z",
  },
};
const tracked = new Set();
const implementation = (fn, impl, once = false) => {
  tracked.add(fn);
  fn.mock[once ? "mockImplementationOnce" : "mockImplementation"](impl);
  return fn;
};
const resetCalls = () => {
  for (const fn of [...tracked, ...Object.values(connection)]) if (fn?.mock) fn.mock.resetCalls();
};
const simulateBatch = mock.fn();
class LimitOrderContract extends sdk.LimitOrderManager {
  constructor(connection, settlement) {
    super({
      passphrase: Networks.TESTNET,
      settlement,
      batcher: CONTRACTS.testnet.batch,
      guard: CONTRACTS.testnet.guard,
      apiUrl: "https://registry.test",
      api: {},
      server: connection,
      readBatch: simulateBatch,
      readContract: () => {
        throw new Error("Unexpected view");
      },
      prepare: async (maker, operation) =>
        connection.prepareTransaction(
          await connection.buildSmartContractTxFromOp(maker, operation),
        ),
    });
  }
  async getPlacementTx(...args) {
    return new StellarTransaction(await this.buildPlacementTransaction(...args), Networks.TESTNET);
  }
}
const draft = vector;
const xlm = Asset.native().contractId(Networks.TESTNET);
const request = {
  placement_mode: "CONTRACT_ONCHAIN",
  maker: draft.maker,
  sell_token: draft.sell_token,
  buy_token: draft.buy_token,
  sell_amount: draft.sell_amount,
  min_buy_amount: draft.min_buy_amount,
  valid_after_ledger: draft.valid_after_ledger,
  expires_at_ledger: draft.expires_at_ledger,
};
const approval = {
  request,
  executorRewardXlm: draft.executor_reward_xlm,
};
const settings = mock.method(LimitOrderContract.prototype, "getSettlementConfig");
const replaceOrder = (changes) => {
  const order = xdr.ScVal.fromXDR(draft.order_xdr, "base64");
  for (const [field, value] of Object.entries(changes)) {
    const encoded =
      typeof value === "number"
        ? xdr.ScVal.scvU32(value)
        : /amount|reward/.test(field)
          ? nativeToScVal(BigInt(value), {
              type: "u128",
            })
          : new Address(value).toScVal();
    Object.assign(
      order.map.find((entry) => entry.key.sym.toString() === field),
      {
        val: encoded,
      },
    );
  }
  return {
    ...draft,
    ...changes,
    order_xdr: order.toXDR("base64"),
    order_id: Buffer.from(hash(order.toXDR())).toString("hex"),
  };
};
const build = (_maker, operation) =>
  Promise.resolve(
    new TransactionBuilder(new Account(draft.maker, "10"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(operation)
      .setTimeout(0)
      .build(),
  );
const connection = {
  getLatestLedger: mock.fn(),
  getLedgerEntries: mock.fn(),
  buildSmartContractTxFromOp: mock.fn(build),
  prepareTransaction: mock.fn(async (tx) => tx),
};
const contract = () => new LimitOrderContract(connection, draft.settlement_address);
const calls = (tx) => {
  const op = tx.operations[0];
  return scValToNative(op.func.invokeContract.args[1]);
};
const allowanceEntry = (token, amount, expiry, expiryField = "live_until_ledger") => {
  const key = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Allowance"),
    xdr.ScVal.scvMap(
      ["from", "spender"].map(
        (name, index) =>
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol(name),
            val: new Address(index ? draft.settlement_address : draft.maker).toScVal(),
          }),
      ),
    ),
  ]);
  const contractAddress = new Address(token).toScAddress();
  return {
    key: xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contractAddress,
        key,
        durability: xdr.ContractDataDurability.temporary,
      }),
    ),
    val: xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: xdr.ExtensionPoint.v0(),
        contract: contractAddress,
        key,
        durability: xdr.ContractDataDurability.temporary,
        val: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol("amount"),
            val: nativeToScVal(amount, {
              type: "i128",
            }),
          }),
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol(expiryField),
            val: xdr.ScVal.scvU32(expiry),
          }),
        ]),
      }),
    ),
    liveUntilLedgerSeq: Math.max(expiry, 400),
    lastModifiedLedgerSeq: 100,
  };
};
const snapshot = (values) => {
  implementation(
    connection.getLedgerEntries,
    () =>
      Promise.resolve({
        latestLedger: 110,
        entries: values.map(([token, amount, expiry]) => allowanceEntry(token, amount, expiry)),
      }),
    false,
  );
  implementation(
    simulateBatch,
    () =>
      Promise.resolve(
        values.map(([, amount]) =>
          nativeToScVal(amount, {
            type: "i128",
          }),
        ),
      ),
    false,
  );
};
const approvals = (tx) =>
  new Map(
    calls(tx)
      .filter(([, method]) => method === "approve")
      .map(([token, , args]) => [
        token,
        {
          amount: args[2],
          expiry: args[3],
        },
      ]),
  );
beforeEach(() => {
  resetCalls();
  implementation(
    settings,
    () =>
      Promise.resolve({
        maxOrderTtl: 3_110_399,
        executorRewardXlm: draft.executor_reward_xlm,
      }),
    false,
  );
  implementation(
    connection.getLatestLedger,
    () =>
      Promise.resolve({
        sequence: 110,
      }),
    false,
  );
  implementation(
    connection.getLedgerEntries,
    () =>
      Promise.resolve({
        latestLedger: 110,
        entries: [allowanceEntry(draft.sell_token, 123n, 180), allowanceEntry(xlm, 100n, 180)],
      }),
    false,
  );
  implementation(connection.prepareTransaction, async (tx) => tx, false);
  implementation(
    simulateBatch,
    () =>
      Promise.resolve([
        nativeToScVal(123n, {
          type: "i128",
        }),
        nativeToScVal(100n, {
          type: "i128",
        }),
      ]),
    false,
  );
});
describe("on-chain order placement authorization", () => {
  it("validates the shared SDK canonical draft and rejects substitutions", () => {
    assert.doesNotThrow(() =>
      validateLimitOrderDraft(
        draft,
        request,
        draft.settlement_address,
        xlm,
        draft.executor_reward_xlm,
      ),
    );
    assert.throws(
      () =>
        validateLimitOrderDraft(
          draft,
          {
            ...request,
            min_buy_amount: "901",
          },
          draft.settlement_address,
          xlm,
          draft.executor_reward_xlm,
        ),
      messageIncludes("details"),
    );
    assert.throws(() =>
      validateLimitOrderDraft(
        {
          ...draft,
          status: "OPEN",
        },
        request,
        draft.settlement_address,
        xlm,
        draft.executor_reward_xlm,
      ),
    );
    assert.throws(
      () =>
        validateLimitOrderDraft(
          {
            ...draft,
            unsigned_authorization_xdr: "unexpected",
          },
          request,
          draft.settlement_address,
          xlm,
          draft.executor_reward_xlm,
        ),
      messageIncludes("unexpected authorization"),
    );
  });
  it("atomically guards and adds the exact confirmed budgets", async () => {
    const tx = await contract().getPlacementTx(draft, xlm, true, approval);
    const expiration = draft.expires_at_ledger;
    assert.deepEqual(calls(tx), [
      [
        CONTRACTS.testnet.guard,
        "assert_result",
        [[], draft.settlement_address, "get_executor_reward", [], 5000000n],
      ],
      [
        CONTRACTS.testnet.guard,
        "assert_result",
        [
          [],
          draft.settlement_address,
          "get_order_state",
          [draft.maker, Uint8Array.from(Buffer.from(draft.order_id, "hex"))],
          null,
        ],
      ],
      [
        CONTRACTS.testnet.guard,
        "assert_result",
        [[], draft.sell_token, "allowance", [draft.maker, draft.settlement_address], 123n],
      ],
      [
        CONTRACTS.testnet.guard,
        "assert_result",
        [[], xlm, "allowance", [draft.maker, draft.settlement_address], 100n],
      ],
      [draft.buy_token, "trust", [draft.maker]],
      [draft.sell_token, "approve", [draft.maker, draft.settlement_address, 1123n, expiration]],
      [xlm, "approve", [draft.maker, draft.settlement_address, 5000100n, expiration]],
      [
        draft.settlement_address,
        "place_contract_order",
        [draft.maker, Uint8Array.from(Buffer.from(draft.order_id, "hex")), 200],
      ],
    ]);
    const op = tx.operations[0];
    assert.deepEqual(scValToNative(op.func.invokeContract.args[0]), [draft.maker]);
    assert.equal(op.auth.length, 1);
    assert.equal(op.auth[0].credentials.type, "sorobanCredentialsSourceAccount");
    const children = op.auth[0].rootInvocation.subInvocations;
    assert.equal(children.length, 4);
    assert.deepEqual(children[3].function.contractFn.args.map(scValToNative), [
      Uint8Array.from(Buffer.from(draft.order_id, "hex")),
      200,
    ]);
    assert.equal(
      Address.fromScAddress(op.func.invokeContract.contractAddress).toString(),
      CONTRACTS[ENV_TESTNET].batch,
    );
  });
  it("combines native input and the execution reward in one bounded approval", async () => {
    const nativeOrder = xdr.ScVal.fromXDR(draft.order_xdr, "base64");
    Object.assign(
      nativeOrder.map.find((entry) => entry.key.sym.toString() === "sell_token"),
      {
        val: new Address(xlm).toScVal(),
      },
    );
    const nativeDraft = {
      ...draft,
      sell_token: xlm,
      order_xdr: nativeOrder.toXDR("base64"),
      order_id: Buffer.from(hash(nativeOrder.toXDR())).toString("hex"),
    };
    snapshot([[xlm, 123n, 180]]);
    const tx = await contract().getPlacementTx(nativeDraft, xlm, false, {
      ...approval,
      request: {
        ...request,
        sell_token: xlm,
      },
    });
    assert.deepEqual(
      calls(tx).filter(([, method]) => method === "approve"),
      [
        [
          xlm,
          "approve",
          [draft.maker, draft.settlement_address, 5001123n, draft.expires_at_ledger],
        ],
      ],
    );
  });
  it("rejects an overflowing allowance and does not build a transaction", async () => {
    snapshot([
      [draft.sell_token, (1n << 127n) - 1n, 200],
      [xlm, 0n, 0],
    ]);
    await assert.rejects(
      contract().getPlacementTx(draft, xlm, false, approval),
      messageIncludes("supported amount"),
    );
    assert.equal(connection.buildSmartContractTxFromOp.mock.callCount(), 0);
  });
  each(
    [
      [
        "fee",
        {
          executor_reward_xlm: "5000001",
        },
      ],
      [
        "sell amount",
        {
          sell_amount: "1001",
        },
      ],
      [
        "sell token",
        {
          sell_token: xlm,
        },
      ],
      [
        "expiry",
        {
          expires_at_ledger: 201,
        },
      ],
    ],
    "rejects a self-consistent registry substitution of %s",
    async (_, changes) => {
      await assert.rejects(
        contract().getPlacementTx(replaceOrder(changes), xlm, false, approval),
        messageIncludes("details you confirmed"),
      );
      assert.equal(connection.buildSmartContractTxFromOp.mock.callCount(), 0);
    },
  );
  each(
    [
      ["sell token", 1001n, 0n],
      ["XLM reward", 0n, 5000001n],
    ],
    "rejects a substituted %s allowance read",
    async (_, sell, reward) => {
      implementation(
        simulateBatch,
        () =>
          Promise.resolve(
            [sell, reward].map((value) =>
              nativeToScVal(value, {
                type: "i128",
              }),
            ),
          ),
        false,
      );
      await assert.rejects(
        contract().getPlacementTx(draft, xlm, false, approval),
        messageIncludes("could not be verified"),
      );
      assert.equal(connection.prepareTransaction.mock.callCount(), 0);
    },
  );
  it("adds only the new budget to verified existing allowances", async () => {
    snapshot([
      [draft.sell_token, 1000n, 200],
      [xlm, 5000000n, 200],
    ]);
    const tx = await contract().getPlacementTx(draft, xlm, false, approval);
    assert.deepEqual(
      calls(tx)
        .filter(([, method]) => method === "approve")
        .map(([, , args]) => args.slice(2)),
      [
        [2000n, 200],
        [10000000n, 200],
      ],
    );
  });
  it("rejects a changed settlement fee before preparing the placement", async () => {
    implementation(
      settings,
      () =>
        Promise.resolve({
          maxOrderTtl: 3_110_399,
          executorRewardXlm: "5000001",
        }),
      false,
    );
    await assert.rejects(
      contract().getPlacementTx(draft, xlm, false, approval),
      messageIncludes("execution fee changed"),
    );
    assert.equal(connection.prepareTransaction.mock.callCount(), 0);
  });
  it("stops if reading the settlement fee fails", async () => {
    implementation(settings, () => Promise.reject(new Error("fee read failed")), false);
    await assert.rejects(
      contract().getPlacementTx(draft, xlm, false, approval),
      messageIncludes("fee read failed"),
    );
    assert.equal(connection.prepareTransaction.mock.callCount(), 0);
  });
  it("does not replace a failed allowance read with a fresh approval", async () => {
    implementation(simulateBatch, () => Promise.reject(new Error("allowance read failed")), false);
    await assert.rejects(
      contract().getPlacementTx(draft, xlm, false, approval),
      messageIncludes("allowance read failed"),
    );
    assert.equal(connection.prepareTransaction.mock.callCount(), 0);
  });
  it("respects a lower settlement lifetime without extending the confirmed expiry", async () => {
    implementation(
      settings,
      () =>
        Promise.resolve({
          maxOrderTtl: 89,
          executorRewardXlm: draft.executor_reward_xlm,
        }),
      false,
    );
    await assert.rejects(
      contract().getPlacementTx(draft, xlm, false, approval),
      messageIncludes("expiry is no longer valid"),
    );
    assert.equal(connection.prepareTransaction.mock.callCount(), 0);
  });
  each(
    [
      [],
      [
        nativeToScVal(0n, {
          type: "i128",
        }),
      ],
      [
        nativeToScVal(-1n, {
          type: "i128",
        }),
        nativeToScVal(0n, {
          type: "i128",
        }),
      ],
      [
        xdr.ScVal.scvString("0"),
        nativeToScVal(0n, {
          type: "i128",
        }),
      ],
    ],
    "rejects incomplete or invalid allowance reads",
    async (...values) => {
      implementation(simulateBatch, () => Promise.resolve(values), false);
      await assert.rejects(
        contract().getPlacementTx(draft, xlm, false, approval),
        messageIncludes("allowance"),
      );
      assert.equal(connection.prepareTransaction.mock.callCount(), 0);
    },
  );
  it("rejects native sell plus fee overflow before building a transaction", async () => {
    const amount = ((1n << 127n) - 1n).toString();
    const large = replaceOrder({
      sell_token: xlm,
      sell_amount: amount,
    });
    await assert.rejects(
      contract().getPlacementTx(large, xlm, false, {
        ...approval,
        request: {
          ...request,
          sell_token: xlm,
          sell_amount: amount,
        },
      }),
      messageIncludes("supported amount"),
    );
    assert.equal(connection.buildSmartContractTxFromOp.mock.callCount(), 0);
  });
  each(
    ["amount", "expiry", "spender", "authorization"],
    "rejects simulation substituting the approval %s",
    async (field) => {
      implementation(
        connection.prepareTransaction,
        (tx) => {
          const op = xdr.Operation.fromXDR(tx.toEnvelope().v1.tx.operations[0].toXDR());
          const invoke = op.body.invokeHostFunctionOp;
          if (field === "authorization") {
            const args = invoke.auth[0].rootInvocation.subInvocations[0].function.contractFn.args;
            args[2] = nativeToScVal(1001n, {
              type: "i128",
            });
          } else {
            const args = invoke.hostFunction.invokeContract.args[1].vec.find(
              (call) => call.vec[1].sym.toString() === "approve",
            ).vec[2].vec;
            if (field === "amount")
              args[2] = nativeToScVal(1001n, {
                type: "i128",
              });
            if (field === "expiry") args[3] = xdr.ScVal.scvU32(201);
            if (field === "spender") args[1] = new Address(draft.buy_token).toScVal();
          }
          return build(draft.maker, op);
        },
        false,
      );
      await assert.rejects(
        contract().getPlacementTx(draft, xlm, false, approval),
        messageIncludes("authorization changed"),
      );
    },
  );
  it("pins the original authorization before an in-place builder mutation", async () => {
    implementation(
      connection.buildSmartContractTxFromOp,
      (maker, op) => {
        op.body.invokeHostFunctionOp.auth[0].rootInvocation.subInvocations[0].function.contractFn.args[2] =
          nativeToScVal(1001n, {
            type: "i128",
          });
        return build(maker, op);
      },
      true,
    );
    await assert.rejects(
      contract().getPlacementTx(draft, xlm, false, approval),
      messageIncludes("authorization changed"),
    );
  });
  it("rejects simulation replacing the requested operation", async () => {
    implementation(
      connection.prepareTransaction,
      async () =>
        new TransactionBuilder(new Account(draft.maker, "10"), {
          fee: "100",
          networkPassphrase: Networks.TESTNET,
        })
          .addOperation(
            Operation.invokeContractFunction({
              contract: CONTRACTS[ENV_TESTNET].batch,
              function: "different",
              args: [],
            }),
          )
          .setTimeout(0)
          .build(),
      false,
    );
    await assert.rejects(
      contract().getPlacementTx(draft, xlm, false, approval),
      messageIncludes("authorization changed"),
    );
  });
});
describe("multiple open orders", () => {
  const placePair = async (first, second) => {
    const forOrder = (order) => ({
      ...approval,
      request: {
        ...request,
        sell_token: order.sell_token,
        sell_amount: order.sell_amount,
        expires_at_ledger: order.expires_at_ledger,
      },
    });
    snapshot([...new Set([first.sell_token, xlm])].map((token) => [token, 0n, 0]));
    const before = approvals(await contract().getPlacementTx(first, xlm, false, forOrder(first)));
    snapshot(
      [...new Set([second.sell_token, xlm])].map((token) => [
        token,
        before.get(token)?.amount ?? 0n,
        before.get(token)?.expiry ?? 0,
      ]),
    );
    const after = approvals(await contract().getPlacementTx(second, xlm, false, forOrder(second)));
    return {
      before,
      after,
    };
  };
  it("preserves the longer expiry of both previously approved tokens", async () => {
    const { after } = await placePair(
      replaceOrder({
        expires_at_ledger: 300,
      }),
      draft,
    );
    assert.equal(after.get(draft.sell_token)?.expiry, 300);
    assert.equal(after.get(xlm)?.expiry, 300);
  });
  it("adds both sale and shared XLM fee budgets for two equal orders", async () => {
    const { after } = await placePair(
      draft,
      replaceOrder({
        expires_at_ledger: 300,
      }),
    );
    assert.deepEqual(after.get(draft.sell_token), {
      amount: 2000n,
      expiry: 300,
    });
    assert.deepEqual(after.get(xlm), {
      amount: 10000000n,
      expiry: 300,
    });
  });
  it("allows a smaller subsequent order without reducing earlier capacity", async () => {
    const { after } = await placePair(
      draft,
      replaceOrder({
        sell_amount: "500",
        expires_at_ledger: 300,
      }),
    );
    assert.deepEqual(after.get(draft.sell_token), {
      amount: 1500n,
      expiry: 300,
    });
  });
  it("preserves the shared fee budget and deadline across different sell tokens", async () => {
    const other = CONTRACTS[ENV_TESTNET].batch;
    const { after } = await placePair(
      replaceOrder({
        expires_at_ledger: 300,
      }),
      replaceOrder({
        sell_token: other,
      }),
    );
    assert.deepEqual(after.get(other), {
      amount: 1000n,
      expiry: 200,
    });
    assert.deepEqual(after.get(xlm), {
      amount: 10000000n,
      expiry: 300,
    });
    assert.equal(after.has(draft.sell_token), false);
  });
  it("adds native sale and fee exactly once per order", async () => {
    const { after } = await placePair(
      replaceOrder({
        sell_token: xlm,
        expires_at_ledger: 300,
      }),
      replaceOrder({
        sell_token: xlm,
        sell_amount: "500",
      }),
    );
    assert.deepEqual(
      [...after],
      [
        [
          xlm,
          {
            amount: 10001500n,
            expiry: 300,
          },
        ],
      ],
    );
  });
  it("adds to the remaining budget after a fill without restoring spent capacity", async () => {
    snapshot([
      [draft.sell_token, 400n, 300],
      [xlm, 2000000n, 300],
    ]);
    const result = approvals(await contract().getPlacementTx(draft, xlm, false, approval));
    assert.deepEqual(result.get(draft.sell_token), {
      amount: 1400n,
      expiry: 300,
    });
    assert.deepEqual(result.get(xlm), {
      amount: 7000000n,
      expiry: 300,
    });
  });
  it("preserves an earlier grant beyond a subsequently lowered order lifetime", async () => {
    implementation(
      settings,
      () =>
        Promise.resolve({
          maxOrderTtl: 90,
          executorRewardXlm: draft.executor_reward_xlm,
        }),
      false,
    );
    snapshot([
      [draft.sell_token, 1000n, 300],
      [xlm, 5000000n, 300],
    ]);
    const result = approvals(await contract().getPlacementTx(draft, xlm, false, approval));
    assert.equal(result.get(draft.sell_token)?.expiry, 300);
    assert.equal(result.get(xlm)?.expiry, 300);
  });
});
describe("verified allowance storage and execution guards", () => {
  it("requires a new order ID before increasing its shared budgets", async () => {
    const tx = await contract().getPlacementTx(draft, xlm, false, approval);
    assert.deepEqual(calls(tx)[1], [
      CONTRACTS.testnet.guard,
      "assert_result",
      [
        [],
        draft.settlement_address,
        "get_order_state",
        [draft.maker, Uint8Array.from(Buffer.from(draft.order_id, "hex"))],
        null,
      ],
    ]);
  });
  it("uses the logical deadline rather than a longer storage TTL", async () => {
    const result = approvals(await contract().getPlacementTx(draft, xlm, false, approval));
    assert.equal(result.get(draft.sell_token)?.expiry, 200);
  });
  it("does not revive an expired grant still present in storage", async () => {
    snapshot([
      [draft.sell_token, 1000n, 109],
      [xlm, 5000000n, 109],
    ]);
    implementation(
      simulateBatch,
      () =>
        Promise.resolve(
          [0n, 0n].map((value) =>
            nativeToScVal(value, {
              type: "i128",
            }),
          ),
        ),
      false,
    );
    const result = approvals(await contract().getPlacementTx(draft, xlm, false, approval));
    assert.deepEqual(result.get(draft.sell_token), {
      amount: 1000n,
      expiry: 200,
    });
    assert.deepEqual(result.get(xlm), {
      amount: 5000000n,
      expiry: 200,
    });
  });
  it("supports Aquarius token logical expiry", async () => {
    implementation(
      connection.getLedgerEntries,
      () =>
        Promise.resolve({
          latestLedger: 110,
          entries: [
            allowanceEntry(draft.sell_token, 123n, 300, "expiration_ledger"),
            allowanceEntry(xlm, 100n, 180),
          ],
        }),
      false,
    );
    const result = approvals(await contract().getPlacementTx(draft, xlm, false, approval));
    assert.deepEqual(result.get(draft.sell_token), {
      amount: 1123n,
      expiry: 300,
    });
  });
  it("permits a missing grant only when allowance() confirms zero", async () => {
    implementation(
      connection.getLedgerEntries,
      () =>
        Promise.resolve({
          latestLedger: 110,
          entries: [],
        }),
      false,
    );
    implementation(
      simulateBatch,
      () =>
        Promise.resolve(
          [0n, 0n].map((value) =>
            nativeToScVal(value, {
              type: "i128",
            }),
          ),
        ),
      false,
    );
    const result = approvals(await contract().getPlacementTx(draft, xlm, false, approval));
    assert.equal(result.get(draft.sell_token)?.amount, 1000n);
  });
  it("does not overwrite a nonzero grant with an unknown storage key", async () => {
    implementation(
      connection.getLedgerEntries,
      () =>
        Promise.resolve({
          latestLedger: 110,
          entries: [],
        }),
      false,
    );
    await assert.rejects(
      contract().getPlacementTx(draft, xlm, false, approval),
      messageIncludes("could not be verified"),
    );
    assert.equal(connection.buildSmartContractTxFromOp.mock.callCount(), 0);
  });
  it("stops when the logical deadline cannot be read", async () => {
    implementation(
      connection.getLedgerEntries,
      () => Promise.reject(new Error("ledger read failed")),
      false,
    );
    await assert.rejects(
      contract().getPlacementTx(draft, xlm, false, approval),
      messageIncludes("ledger read failed"),
    );
    assert.equal(connection.buildSmartContractTxFromOp.mock.callCount(), 0);
  });
  each(
    [
      "token",
      "maker",
      "spender",
      "durability",
      "value identity",
      "duplicate",
      "negative",
      "amount type",
      "unknown expiry",
      "expiry above maximum",
    ],
    "rejects invalid allowance storage: %s",
    async (mutation) => {
      const entry = allowanceEntry(draft.sell_token, 123n, 180);
      const key = entry.key.contractData;
      const data = entry.val.contractData;
      if (mutation === "token")
        Object.assign(key, {
          contract: new Address(xlm).toScAddress(),
        });
      if (mutation === "maker" || mutation === "spender") {
        const ownerFields = key.key.vec[1].map;
        Object.assign(ownerFields[mutation === "maker" ? 0 : 1], {
          val: new Address(draft.buy_token).toScVal(),
        });
      }
      if (mutation === "durability")
        Object.assign(key, {
          durability: xdr.ContractDataDurability.persistent,
        });
      if (mutation === "value identity")
        Object.assign(data, {
          contract: new Address(xlm).toScAddress(),
        });
      if (mutation === "negative")
        Object.assign(data.val.map[0], {
          val: nativeToScVal(-1n, {
            type: "i128",
          }),
        });
      if (mutation === "amount type")
        Object.assign(data.val.map[0], {
          val: nativeToScVal(123n, {
            type: "u128",
          }),
        });
      if (mutation === "unknown expiry")
        Object.assign(data.val.map[1], {
          key: xdr.ScVal.scvSymbol("unknown"),
        });
      if (mutation === "expiry above maximum")
        Object.assign(data.val.map[1], {
          val: xdr.ScVal.scvU32(0xffffffff),
        });
      implementation(
        connection.getLedgerEntries,
        () =>
          Promise.resolve({
            latestLedger: 110,
            entries: [
              entry,
              ...(mutation === "duplicate" ? [entry] : []),
              allowanceEntry(xlm, 100n, 180),
            ],
          }),
        false,
      );
      await assert.rejects(contract().getPlacementTx(draft, xlm, false, approval));
      assert.equal(connection.buildSmartContractTxFromOp.mock.callCount(), 0);
    },
  );
  it("accepts exact i128 aggregate limits for both tokens", async () => {
    const max = (1n << 127n) - 1n;
    snapshot([
      [draft.sell_token, max - 1000n, 300],
      [xlm, max - 5000000n, 300],
    ]);
    const result = approvals(await contract().getPlacementTx(draft, xlm, false, approval));
    assert.equal(result.get(draft.sell_token)?.amount, max);
    assert.equal(result.get(xlm)?.amount, max);
  });
  it("rejects XLM aggregate overflow even when the sale fits", async () => {
    snapshot([
      [draft.sell_token, 0n, 0],
      [xlm, (1n << 127n) - 5000000n, 300],
    ]);
    await assert.rejects(
      contract().getPlacementTx(draft, xlm, false, approval),
      messageIncludes("supported amount"),
    );
    assert.equal(connection.buildSmartContractTxFromOp.mock.callCount(), 0);
  });
  each(
    ["amount", "expiry", "backwards ledger"],
    "rejects a snapshot changed during preparation: %s",
    async (change) => {
      implementation(
        implementation(
          connection.getLedgerEntries,
          () =>
            Promise.resolve({
              latestLedger: 110,
              entries: [
                allowanceEntry(draft.sell_token, 123n, 180),
                allowanceEntry(xlm, 100n, 180),
              ],
            }),
          true,
        ),
        () =>
          Promise.resolve({
            latestLedger: change === "backwards ledger" ? 109 : 111,
            entries: [
              allowanceEntry(
                draft.sell_token,
                change === "amount" ? 124n : 123n,
                change === "expiry" ? 300 : 180,
              ),
              allowanceEntry(xlm, 100n, 180),
            ],
          }),
        false,
      );
      await assert.rejects(
        contract().getPlacementTx(draft, xlm, false, approval),
        messageIncludes("allowance changed"),
      );
    },
  );
  it("rejects simulation removing an execution guard", async () => {
    implementation(
      connection.prepareTransaction,
      (tx) => {
        const op = xdr.Operation.fromXDR(tx.toEnvelope().v1.tx.operations[0].toXDR());
        op.body.invokeHostFunctionOp.hostFunction.invokeContract.args[1].vec.shift();
        return build(draft.maker, op);
      },
      false,
    );
    await assert.rejects(
      contract().getPlacementTx(draft, xlm, false, approval),
      messageIncludes("authorization changed"),
    );
  });
});
