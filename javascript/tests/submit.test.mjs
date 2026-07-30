// SubmitEngine sequence-recovery tests on a fake RPC server — no network.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Account, Keypair, Networks, Operation, rpc } from "@stellar/stellar-sdk";

import { AquariusError } from "../dist/errors.js";
import { SubmitEngine } from "../dist/submit.js";

const PASSPHRASE = Networks.TESTNET;
const KEYPAIR = Keypair.random();
const STALE_SEQUENCE = "100"; // what the lagging replica serves on the first load
const CHAIN_SEQUENCE = "105"; // where the chain actually is

SubmitEngine._badSeqDelaysMs = [1, 1]; // keep the tests fast

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
