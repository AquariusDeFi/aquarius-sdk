import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import {
  loadSwapResourceLimits,
  assertSwapResources,
  getSellSwapResult,
  assertSwapAuthorization,
} from "../dist/swap-resources.js";
import {
  swapResourceConfig,
  swapResourceNetwork,
} from "./split-resource-fixture.mjs";
const source = Keypair.random().publicKey(),
  contract = Address.contract(Buffer.alloc(32, 8)).toString();
const op = Operation.invokeContractFunction({
  contract,
  function: "swap",
  args: [],
});
const tx = (instructions = 500) =>
  new TransactionBuilder(new Account(source, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
    sorobanData: new SorobanDataBuilder()
      .setResources(instructions, 500, 250)
      .build(),
  })
    .addOperation(op)
    .setTimeout(120)
    .build();
const reader = {
  getNetwork: async () => swapResourceNetwork(),
  getLedgerEntries: async () => swapResourceConfig(),
};
test("network config matches keys, fails closed on missing config, and checks half-budget", async () => {
  const limits = await loadSwapResourceLimits(reader, Networks.TESTNET);
  assert.equal(limits.instructions, 1000n);
  assert.doesNotThrow(() =>
    assertSwapResources(
      tx(),
      limits,
      { events: [], retval: xdr.ScVal.scvVoid() },
      true,
    ),
  );
  assert.throws(
    () =>
      assertSwapResources(
        tx(501),
        limits,
        { events: [], retval: xdr.ScVal.scvVoid() },
        true,
      ),
    /instructions/,
  );
  await assert.rejects(
    loadSwapResourceLimits(
      {
        ...reader,
        getLedgerEntries: async () => ({ latestLedger: 1, entries: [] }),
      },
      Networks.TESTNET,
    ),
  );
});
test("events and full return count, diagnostics and reverted calls do not", async () => {
  const event = (type, success = true) =>
    new xdr.DiagnosticEvent({
      inSuccessfulContractCall: success,
      event: new xdr.ContractEvent({
        ext: xdr.ExtensionPoint.v0(),
        contractId: null,
        type,
        body: xdr.ContractEventBody.v0(
          new xdr.ContractEventV0({
            topics: [],
            data: xdr.ScVal.scvBytes(Buffer.alloc(20)),
          }),
        ),
      }),
    });
  const events = [
    event(xdr.ContractEventType.contract),
    event(xdr.ContractEventType.system),
    event(xdr.ContractEventType.diagnostic),
    event(xdr.ContractEventType.contract, false),
  ];
  const retval = xdr.ScVal.scvVec([
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVec([
      nativeToScVal(1n, { type: "u128" }),
      nativeToScVal(2n, { type: "u128" }),
    ]),
  ]);
  const bytes =
    events[0].event.toXdr().length +
    events[1].event.toXdr().length +
    retval.toXdr().length;
  const limits = {
    ...(await loadSwapResourceLimits(reader, Networks.TESTNET)),
    eventsAndReturnBytes: bytes * 2,
  };
  assert.doesNotThrow(() =>
    assertSwapResources(tx(), limits, { events, retval }, true),
  );
  assert.throws(
    () =>
      assertSwapResources(
        tx(),
        { ...limits, eventsAndReturnBytes: bytes * 2 - 1 },
        { events, retval },
        true,
      ),
    /events and return/,
  );
  assert.deepEqual(getSellSwapResult(retval, 2, true), [1n, 2n]);
  assert.throws(() => getSellSwapResult(retval, 1, true));
});
test("prepared transaction cannot replace source or invocation", () => {
  assert.doesNotThrow(() =>
    assertSwapAuthorization(tx(), source, op.toXdr("base64")),
  );
  assert.throws(() =>
    assertSwapAuthorization(
      tx(),
      Keypair.random().publicKey(),
      op.toXdr("base64"),
    ),
  );
});
