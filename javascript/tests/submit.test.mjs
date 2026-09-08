// SubmitEngine sequence-recovery tests on a fake RPC server — no network.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Account, Keypair, Networks, Operation, rpc, xdr } from "@stellar/stellar-sdk";

import { AquariusClient, XLM } from "../dist/index.js";
import { AquariusError, SlippageError } from "../dist/errors.js";
import { SubmitEngine } from "../dist/submit.js";

const PASSPHRASE = Networks.TESTNET;
const KEYPAIR = Keypair.random();
const STALE_SEQUENCE = "100"; // what the lagging replica serves on the first load
const CHAIN_SEQUENCE = "105"; // where the chain actually is

SubmitEngine._badSeqDelaysMs = [1, 1]; // keep the tests fast
AquariusClient._requoteDelaysMs = [0, 0];

const rejected = name => ({
  status: "ERROR",
  hash: "rejected",
  errorResult: { result: () => ({ switch: () => ({ name }) }) },
});
const PENDING = { status: "PENDING", hash: "abc123" };

/** Scripted sendTransaction responses; the first account load serves a stale
 * sequence (lagging replica), later loads the converged one. */
class FakeServer {
  constructor(sendResponses) {
    this.sendResponses = [...sendResponses];
    this.loads = 0;
    this.submitted = [];
  }

  async getAccount(accountId) {
    this.loads += 1;
    return new Account(accountId, this.loads === 1 ? STALE_SEQUENCE : CHAIN_SEQUENCE);
  }

  async sendTransaction(tx) {
    this.submitted.push(tx);
    return this.sendResponses.shift();
  }

  async pollTransaction() {
    return { status: rpc.Api.GetTransactionStatus.SUCCESS, returnValue: undefined };
  }
}

async function submitThrough(server) {
  const engine = new SubmitEngine(server, PASSPHRASE, "100");
  const tx = await engine.buildTransaction(
    KEYPAIR.publicKey(),
    Operation.manageData({ name: "test", value: "1" }),
  );
  assert.equal(tx.sequence, (BigInt(STALE_SEQUENCE) + 1n).toString());
  return engine.signAndSubmit(tx, KEYPAIR);
}

test("txBadSeq is re-signed with a fresh sequence and resubmitted", async () => {
  const server = new FakeServer([rejected("txBadSeq"), PENDING]);
  const confirmed = await submitThrough(server);

  assert.equal(confirmed.txHash, "abc123");
  assert.equal(server.submitted.length, 2);
  const resubmitted = server.submitted[1];
  assert.equal(resubmitted.sequence, (BigInt(CHAIN_SEQUENCE) + 1n).toString()); // reloaded
  assert.equal(resubmitted.signatures.length, 1); // stale signature dropped, re-signed
  assert.ok(KEYPAIR.verify(resubmitted.hash(), resubmitted.signatures[0].signature()));
});

test("txBadSeq gives up after bounded retries", async () => {
  const server = new FakeServer([rejected("txBadSeq"), rejected("txBadSeq"), rejected("txBadSeq")]);
  await assert.rejects(
    () => submitThrough(server),
    error => error instanceof AquariusError && /txBadSeq/.test(error.message),
  );
  assert.equal(server.submitted.length, 3); // initial + one per configured delay
});

test("other rejections are not retried", async () => {
  const server = new FakeServer([rejected("txInsufficientBalance")]);
  await assert.rejects(
    () => submitThrough(server),
    error => error instanceof AquariusError && /txInsufficientBalance/.test(error.message),
  );
  assert.equal(server.submitted.length, 1);
});

function diagnosticEvent(contractCode) {
  const topics = [xdr.ScVal.scvSymbol("error")];
  if (contractCode !== undefined) {
    topics.push(xdr.ScVal.scvError(xdr.ScError.sceContract(contractCode)));
  }
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0), contractId: null,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({
        topics, data: xdr.ScVal.scvVoid(),
      })),
    }),
  });
}

for (const [label, events, errorType, attempts] of [
  ["absent", undefined, AquariusError, 1],
  ["empty", [], AquariusError, 1],
  ["unrecognized", [diagnosticEvent()], AquariusError, 1],
  ["confirmed slippage", [diagnosticEvent(2006)], SlippageError, 3],
]) {
  test(`swap retries FAILED only for diagnosed slippage: ${label} diagnostics`, async t => {
    const client = new AquariusClient({ network: "testnet" });
    const server = new FakeServer([]);
    server.pollTransaction = async () => ({
      status: rpc.Api.GetTransactionStatus.FAILED, diagnosticEventsXdr: events,
    });
    const engine = new SubmitEngine(server, PASSPHRASE, "100");
    const quote = t.mock.method(client, "quote", async () => ({
      execute: () => engine.poll("failed-hash"),
    }));
    await assert.rejects(client.swap({ from: XLM, to: XLM, amountIn: 1n, retries: 2 }), error => {
      assert.equal(error.constructor, errorType);
      assert.equal(error.txHash, "failed-hash");
      if (errorType === AquariusError) assert.match(error.message, /without recognized diagnostics/);
      return true;
    });
    assert.equal(quote.mock.callCount(), attempts);
  });
}

test("reads share one account fetch, even concurrently", async () => {
  const server = new FakeServer([]);
  server.simulateTransaction = async () => ({ result: { retval: xdr.ScVal.scvU32(7) } });
  const engine = new SubmitEngine(server, PASSPHRASE, "100");
  const op = () => Operation.manageData({ name: "t", value: "1" });
  await Promise.all([engine.read(KEYPAIR.publicKey(), op), engine.read(KEYPAIR.publicKey(), op)]);
  const value = await engine.read(KEYPAIR.publicKey(), op);
  assert.equal(value.u32(), 7);
  assert.equal(server.loads, 1); // sequence numbers are irrelevant to simulation
});

test("write builds always load a fresh account", async () => {
  const server = new FakeServer([]);
  const engine = new SubmitEngine(server, PASSPHRASE, "100");
  const op = Operation.manageData({ name: "t", value: "1" });
  await engine.buildTransaction(KEYPAIR.publicKey(), op);
  await engine.buildTransaction(KEYPAIR.publicKey(), op);
  assert.equal(server.loads, 2); // writes must never reuse a cached sequence
});
