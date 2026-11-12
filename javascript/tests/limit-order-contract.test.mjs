import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test as it, describe } from "node:test";
import { format } from "node:util";
import * as sdk from "../dist/index.js";
import {
  Address,
  Asset,
  authorizeEntry,
  hash,
  Keypair,
  nativeToScVal,
  Networks,
  xdr,
} from "@stellar/stellar-sdk";
const autoTrustVector = JSON.parse(
  readFileSync(new URL("../../testdata/limit_order_auto_trust.json", import.meta.url), "utf8"),
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
const validateLimitOrderRecord = (record, settlement, maker, statuses) =>
  sdk.validateLimitOrderRecord(record, settlement, maker, Networks.TESTNET, statuses);
const { assertSignedAuthorizationMatchesDraft, getLimitOrderFillOperation } = sdk;
const each = (cases, name, run) => {
  for (const item of cases) {
    const args = Array.isArray(item) ? item : [item];
    it(format(name, ...args), () => run(...args));
  }
};
const messageIncludes = (expected) => (error) =>
  typeof expected === "string" ? error.message.includes(expected) : error instanceof expected;
const key = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const settlement = "CAXNZ5VERZTUW6Z5FFXT6EE675KS2ML2PZYFW6KP6PTU3TABPYCFPYYU";
const xlm = Asset.native().contractId(Networks.TESTNET);
const buy = "CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5";
const reward = "5000000";
const intent = {
  maker: key.publicKey(),
  placement_mode: "DETACHED",
  sell_token: xlm,
  buy_token: buy,
  sell_amount: "10000000",
  min_buy_amount: "25000000",
  valid_after_ledger: 100,
  expires_at_ledger: 200,
};
const invoke = (contract, method, args, children = []) =>
  new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contract).toScAddress(),
        functionName: method,
        args,
      }),
    ),
    subInvocations: children,
  });
const fixture = (overrides = {}) => {
  const body = {
    ...intent,
    ...overrides,
  };
  const fields = {
    buy_token: Address.fromString(body.buy_token).toScVal(),
    executor_reward_xlm: nativeToScVal(BigInt(reward), {
      type: "u128",
    }),
    expires_at_ledger: nativeToScVal(body.expires_at_ledger, {
      type: "u32",
    }),
    maker: Address.fromString(body.maker).toScVal(),
    min_buy_amount: nativeToScVal(BigInt(body.min_buy_amount), {
      type: "u128",
    }),
    placement_mode: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Detached")]),
    salt: xdr.ScVal.scvBytes(Buffer.alloc(32, 2)),
    sell_amount: nativeToScVal(BigInt(body.sell_amount), {
      type: "u128",
    }),
    sell_token: Address.fromString(body.sell_token).toScVal(),
    valid_after_ledger: nativeToScVal(body.valid_after_ledger, {
      type: "u32",
    }),
    version: nativeToScVal(1, {
      type: "u32",
    }),
  };
  const value = xdr.ScVal.scvMap(
    Object.entries(fields).map(
      ([name, val]) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(name),
          val,
        }),
    ),
  );
  const transfer = (token, amount) =>
    invoke(token, "transfer", [
      Address.fromString(body.maker).toScVal(),
      Address.fromString(settlement).toScVal(),
      nativeToScVal(BigInt(amount), {
        type: "i128",
      }),
    ]);
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(body.maker).toScAddress(),
        nonce: xdr.Int64.fromString("42"),
        signatureExpirationLedger: body.expires_at_ledger,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invoke(
      settlement,
      "fill",
      [value],
      [transfer(body.sell_token, body.sell_amount), transfer(xlm, reward)],
    ),
  });
  const draft = {
    ...body,
    placement_mode: "DETACHED",
    version: 1,
    status: "DRAFT",
    salt: Buffer.alloc(32, 2).toString("hex"),
    executor_reward_xlm: reward,
    order_xdr: value.toXDR("base64"),
    order_id: Buffer.from(hash(value.toXDR())).toString("hex"),
    network_id: Buffer.from(hash(Buffer.from(Networks.TESTNET))).toString("hex"),
    settlement_address: settlement,
    unsigned_authorization_xdr: auth.toXDR("base64"),
    admission_ledger: null,
    placement_ledger: null,
    placement_transaction_hash: "",
    funding_snapshot: {},
  };
  return {
    draft,
    auth,
  };
};
const validate = (draft) => validateLimitOrderDraft(draft, intent, settlement, xlm, reward);
describe("limit order fill recognition from Horizon operations", () => {
  const operation = (contract = settlement, method = "fill", maker = key.publicKey()) => ({
    type: "invoke_host_function",
    transaction_successful: true,
    transaction_hash: "ab".repeat(32),
    created_at: "2026-10-19T12:00:00Z",
    parameters: [
      {
        value: Address.fromString(contract).toScVal().toXDR("base64"),
      },
      {
        value: xdr.ScVal.scvSymbol(method).toXDR("base64"),
      },
      {
        value: fixture({
          maker,
        }).draft.order_xdr,
      },
    ],
  });
  it("recognizes a successful fill of this maker’s order on the configured settlement", () => {
    assert.deepEqual(getLimitOrderFillOperation(operation(), settlement, key.publicKey()), {
      orderId: fixture().draft.order_id,
      maker: key.publicKey(),
      settlementContract: settlement,
      transactionHash: "ab".repeat(32),
      createdAt: "2026-10-19T12:00:00Z",
    });
  });
  it("does not confuse a swap or another settlement with a limit fill", () => {
    assert.equal(getLimitOrderFillOperation(operation(buy), settlement, key.publicKey()), null);
    assert.equal(
      getLimitOrderFillOperation(operation(settlement, "swap"), settlement, key.publicKey()),
      null,
    );
    assert.equal(
      getLimitOrderFillOperation(operation(settlement, "cancel"), settlement, key.publicKey()),
      null,
    );
  });
  it("does not relabel executor or unrelated account payments", () => {
    const otherMaker = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
    assert.equal(
      getLimitOrderFillOperation(
        operation(settlement, "fill", otherMaker),
        settlement,
        key.publicKey(),
      ),
      null,
    );
  });
  it("ignores failed operations, missing deployments and malformed arguments", () => {
    const failed = {
      ...operation(),
      transaction_successful: false,
    };
    assert.equal(getLimitOrderFillOperation(failed, settlement, key.publicKey()), null);
    assert.equal(getLimitOrderFillOperation(operation(), "", key.publicKey()), null);
    const invalid = operation();
    invalid.parameters[2].value = "invalid xdr";
    assert.equal(getLimitOrderFillOperation(invalid, settlement, key.publicKey()), null);
    assert.equal(
      getLimitOrderFillOperation(
        {
          ...operation(),
          parameters: [],
        },
        settlement,
        key.publicKey(),
      ),
      null,
    );
  });
});
describe("order authorization boundary", () => {
  it("matches the shared backend/SDK vector with a single wallet authorization", async () => {
    const draft = {
      ...autoTrustVector,
      placement_mode: "DETACHED",
      status: "DRAFT",
      admission_ledger: null,
      placement_ledger: null,
      placement_transaction_hash: "",
      funding_snapshot: {},
    };
    const request = {
      maker: draft.maker,
      placement_mode: "DETACHED",
      sell_token: draft.sell_token,
      buy_token: draft.buy_token,
      sell_amount: draft.sell_amount,
      min_buy_amount: draft.min_buy_amount,
      valid_after_ledger: draft.valid_after_ledger,
      expires_at_ledger: draft.expires_at_ledger,
    };
    assert.doesNotThrow(() =>
      validateLimitOrderDraft(
        draft,
        request,
        draft.settlement_address,
        draft.sell_token,
        reward,
        true,
        true,
      ),
    );
    const signed = await authorizeEntry(
      xdr.SorobanAuthorizationEntry.fromXDR(draft.unsigned_authorization_xdr, "base64"),
      Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)),
      draft.expires_at_ledger,
      Networks.TESTNET,
    );
    assert.equal(signed.toXDR("base64"), autoTrustVector.authorization_xdr);
  });
  it("accepts one exact trust child and rejects a different recipient or nested call", () => {
    const { draft, auth } = fixture();
    const trust = invoke(buy, "trust", [Address.fromString(intent.maker).toScVal()]);
    auth.rootInvocation.subInvocations.unshift(trust);
    draft.unsigned_authorization_xdr = auth.toXDR("base64");
    assert.doesNotThrow(() =>
      validateLimitOrderDraft(draft, intent, settlement, xlm, reward, true, true),
    );
    Object.assign(trust.function.contractFn, {
      args: [Address.fromString(Keypair.random().publicKey()).toScVal()],
    });
    draft.unsigned_authorization_xdr = auth.toXDR("base64");
    assert.throws(
      () => validateLimitOrderDraft(draft, intent, settlement, xlm, reward, true),
      messageIncludes("exact order"),
    );
    Object.assign(trust.function.contractFn, {
      args: [Address.fromString(intent.maker).toScVal()],
    });
    trust.subInvocations.push(auth.rootInvocation.subInvocations[1]);
    draft.unsigned_authorization_xdr = auth.toXDR("base64");
    assert.throws(
      () => validateLimitOrderDraft(draft, intent, settlement, xlm, reward, true),
      messageIncludes("exact order"),
    );
  });
  it("requires trust permission before signing when the receive trustline is missing", () => {
    assert.throws(
      () => validateLimitOrderDraft(fixture().draft, intent, settlement, xlm, reward, true, true),
      messageIncludes("trustline"),
    );
  });
  it("accepts the exact detached order, including separate XLM input and reward transfers", () =>
    assert.doesNotThrow(() => validate(fixture().draft)));
  it("rejects a self-consistent replacement order before wallet signing", () =>
    assert.throws(
      () =>
        validate(
          fixture({
            sell_amount: "20000000",
          }).draft,
        ),
      messageIncludes("confirmed"),
    ));
  each(
    ["network_id", "settlement_address", "maker", "order_id", "min_buy_amount"],
    "rejects substituted %s",
    (field) => {
      const { draft } = fixture();
      draft[field] = field === "min_buy_amount" ? "2" : "invalid";
      assert.throws(() => validate(draft));
    },
  );
  it("rejects extra transfers and changed authorization expiry", () => {
    const { draft, auth } = fixture();
    auth.rootInvocation.subInvocations.push(auth.rootInvocation.subInvocations[0]);
    draft.unsigned_authorization_xdr = auth.toXDR("base64");
    assert.throws(() => validate(draft), messageIncludes("exact order"));
    const fresh = fixture();
    Object.assign(fresh.auth.credentials.addressV2, {
      signatureExpirationLedger: 300,
    });
    fresh.draft.unsigned_authorization_xdr = fresh.auth.toXDR("base64");
    assert.throws(() => validate(fresh.draft), messageIncludes("exact order"));
  });
  it("rejects the wrong fee and accepts valid history records without open-order proofs", () => {
    const { draft } = fixture();
    assert.throws(
      () => validateLimitOrderDraft(draft, intent, settlement, xlm, "1"),
      messageIncludes("confirmed"),
    );
    assert.doesNotThrow(() =>
      validateLimitOrderRecord(
        {
          ...draft,
          status: "FILLED",
        },
        settlement,
        intent.maker,
        ["FILLED"],
      ),
    );
  });
  it("accepts a valid signature and rejects wallet changes to the authorization", async () => {
    const { draft, auth } = fixture();
    const signed = await authorizeEntry(auth, key, intent.expires_at_ledger, Networks.TESTNET);
    assert.doesNotThrow(() =>
      assertSignedAuthorizationMatchesDraft(
        draft.unsigned_authorization_xdr,
        signed.toXDR("base64"),
        key.publicKey(),
      ),
    );
    Object.assign(signed.credentials.addressV2, {
      signatureExpirationLedger: 999,
    });
    assert.throws(
      () =>
        assertSignedAuthorizationMatchesDraft(
          draft.unsigned_authorization_xdr,
          signed.toXDR("base64"),
          key.publicKey(),
        ),
      messageIncludes("credentials"),
    );
  });
});
