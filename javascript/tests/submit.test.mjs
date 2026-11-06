// SubmitEngine sequence-recovery tests on a fake RPC server — no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { Account, Keypair, Networks, Operation, SorobanDataBuilder, StrKey, rpc, xdr } from "@stellar/stellar-sdk";

import { authorizedInvocation, sourceAccountEntry } from "../dist/authorization.js";
import { AquariusClient, XLM } from "../dist/index.js";
import { AquariusError, NoTrustlineError, SlippageError } from "../dist/errors.js";
import { SubmitEngine } from "../dist/submit.js";

const PASSPHRASE = Networks.TESTNET;
const KEYPAIR = Keypair.random();
const STALE_SEQUENCE = "100"; // what the lagging replica serves on the first load
const CHAIN_SEQUENCE = "105"; // where the chain actually is
const CONFIRMED_LEDGER = 1000; // the ledger that applies every submitted transaction

SubmitEngine._badSeqDelaysMs = [1, 1]; // keep the tests fast
SubmitEngine._nextLedgerPollIntervalMs = 1;
AquariusClient._requoteDelaysMs = [0, 0];

const rejected = name => ({
  status: "ERROR",
  hash: "rejected",
  errorResult: new xdr.TransactionResult({
    feeCharged: 0n,
    result: xdr.TransactionResultResult[name](),
    ext: xdr.TransactionResultExt.v0(),
  }),
});
const PENDING = { status: "PENDING", hash: "abc123" };

/** Scripted sendTransaction responses; the first account load serves a stale
 * sequence (lagging replica), later loads the converged one. */
class FakeServer {
  constructor(sendResponses, latestLedgers = []) {
    this.sendResponses = [...sendResponses];
    this.loads = 0;
    this.submitted = [];
    this.latestLedgers = [...latestLedgers]; // the last one repeats
    this.calls = [];
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
    return {
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      returnValue: undefined,
      ledger: CONFIRMED_LEDGER,
    };
  }

  async getHealth() {
    this.calls.push("getHealth");
    const latestLedger = this.latestLedgers[0];
    if (this.latestLedgers.length > 1) this.latestLedgers.shift();
    return { latestLedger };
  }

  async simulateTransaction() {
    this.calls.push("simulate");
    return { result: { retval: xdr.ScVal.scvU32(7) } };
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
  assert.ok(KEYPAIR.verify(resubmitted.hash(), resubmitted.signatures[0].signature.toBytes()));
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

test("an executing write still restores, re-simulates and signs the original call", async () => {
  const server = new FakeServer([PENDING, PENDING]);
  let simulations = 0;
  server.simulateTransaction = async () => {
    simulations++;
    const result = {
      _parsed: true,
      transactionData: new SorobanDataBuilder(),
      minResourceFee: "10",
      result: { retval: xdr.ScVal.scvVoid(), auth: [] },
    };
    return simulations === 1
      ? { ...result, restorePreamble: { minResourceFee: "500", transactionData: new SorobanDataBuilder() } }
      : result;
  };
  // The fake server serves no network config, so instruction headroom is off.
  const engine = new SubmitEngine(server, PASSPHRASE, "100", null, undefined, 0);
  const tx = await engine.prepare(KEYPAIR.publicKey(), () => Operation.invokeContractFunction({
    contract: "CCSXYUVLYALKJGIIYMGYLZI447VS6TDWFTVDL43B4IKK2WERHLWUVCRC",
    function: "claim",
    args: [],
  }), KEYPAIR);
  assert.equal(simulations, 2);
  assert.equal(server.submitted.length, 1);
  assert.equal(server.submitted[0].operations[0].type, "restoreFootprint");
  assert.equal(server.submitted[0].signatures.length, 1);
  assert.equal(tx.signatures.length, 0);
  await engine.signAndSubmit(tx, KEYPAIR);
  assert.equal(server.submitted[1].operations[0].type, "invokeHostFunction");
  assert.equal(server.submitted[1].signatures.length, 1);
});

function diagnosticEvent(contractCode) {
  const topics = [xdr.ScVal.scvSymbol("error")];
  if (contractCode !== undefined) {
    topics.push(xdr.ScVal.scvError(xdr.ScError.sceContract(contractCode)));
  }
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(), contractId: null,
      type: xdr.ContractEventType.diagnostic,
      body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({
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
  assert.equal(value.u32, 7);
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

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 1));
const fixedAuth = () => [sourceAccountEntry(authorizedInvocation(CONTRACT, "fixed", []))];
const hostileAuth = () => [sourceAccountEntry(authorizedInvocation(CONTRACT, "unexpected_debit", []))];
const authXdr = tx => tx.operations[0].auth.map(entry => entry.toXDR("base64"));
// The fake server serves no network config, so instruction headroom is off.
const authEngine = server => new SubmitEngine(server, PASSPHRASE, "100", null, undefined, 0);
const success = (auth = hostileAuth()) => ({
  _parsed: true,
  latestLedger: 100,
  events: [],
  minResourceFee: "0",
  transactionData: new SorobanDataBuilder(),
  result: { auth, retval: xdr.ScVal.scvVoid() },
});

for (const auth of [fixedAuth(), []]) {
  test(`prepare enforces and preserves ${auth.length ? "fixed" : "empty"} auth despite hostile simulation auth`, async () => {
    const server = new FakeServer([]);
    const modes = [];
    server.simulateTransaction = async (tx, resources, mode) => {
      modes.push(mode);
      assert.equal(resources, undefined);
      return success();
    };
    const engine = authEngine(server);
    const tx = await engine.prepare(KEYPAIR.publicKey(), () => Operation.invokeContractFunction({
      contract: CONTRACT, function: "fixed", args: [], auth,
    }));
    assert.deepEqual(modes, ["enforce"]);
    assert.deepEqual(authXdr(tx), auth.map(entry => entry.toXDR("base64")));
    assert.equal(tx.signatures.length, 0);
  });
}

test("restore retry freezes the original operation and enforces auth on both simulations", async () => {
  const server = new FakeServer([]);
  const simulations = [];
  server.simulateTransaction = async (tx, _resources, mode) => {
    simulations.push({ tx, mode });
    return simulations.length === 1
      ? { ...success(), restorePreamble: { minResourceFee: "0", transactionData: new SorobanDataBuilder() } }
      : success();
  };
  const engine = authEngine(server);
  const auth = fixedAuth();
  const original = auth.map(entry => entry.toXDR("base64"));
  // Stub restoration: exercise the retry without signing any restore.
  engine.restore = async () => { auth.splice(0, 1, ...hostileAuth()); };
  let builds = 0;
  const tx = await engine.prepare(KEYPAIR.publicKey(), () => {
    builds += 1;
    return Operation.invokeContractFunction({ contract: CONTRACT, function: "fixed", args: [], auth });
  }, KEYPAIR);
  assert.equal(builds, 1);
  assert.deepEqual(simulations.map(({ mode }) => mode), ["enforce", "enforce"]);
  assert.deepEqual(simulations.map(({ tx }) => authXdr(tx)), [original, original]);
  assert.deepEqual(authXdr(tx), original);
});

test("a repeated restore response cannot produce a prepared contract transaction", async () => {
  const server = new FakeServer([]);
  let simulations = 0;
  server.simulateTransaction = async () => {
    simulations += 1;
    return { ...success(), restorePreamble: { minResourceFee: "0", transactionData: new SorobanDataBuilder() } };
  };
  const engine = authEngine(server);
  engine.restore = async () => {};
  await assert.rejects(() => engine.prepare(KEYPAIR.publicKey(), () => Operation.invokeContractFunction({
    contract: CONTRACT, function: "fixed", args: [], auth: fixedAuth(),
  }), KEYPAIR), /still archived/);
  assert.equal(simulations, 2);
});

test("enforcement failure aborts preparation without falling back to recording", async () => {
  const server = new FakeServer([]);
  const modes = [];
  server.simulateTransaction = async (_tx, _resources, mode) => {
    modes.push(mode);
    return { error: "HostError: Error(Auth, InvalidAction)" };
  };
  const engine = authEngine(server);
  await assert.rejects(() => engine.prepare(KEYPAIR.publicKey(), () => Operation.invokeContractFunction({
    contract: CONTRACT, function: "fixed", args: [], auth: [],
  })), /Auth/);
  assert.deepEqual(modes, ["enforce"]);
  assert.deepEqual(server.submitted, []);
});

test("read simulations retain recording and never return authorization for signing", async () => {
  const server = new FakeServer([]);
  server.simulateTransaction = async (_tx, _resources, mode) => {
    assert.equal(mode, undefined);
    return { ...success(), result: { auth: hostileAuth(), retval: xdr.ScVal.scvU32(7) } };
  };
  const engine = authEngine(server);
  const result = await engine.read(KEYPAIR.publicKey(), () => Operation.invokeContractFunction({
    contract: CONTRACT, function: "estimate", args: [],
  }));
  assert.equal(result.u32, 7);
  assert.deepEqual(server.submitted, []);
});

test("sequence retries preserve the fixed authorization without a new simulation", async () => {
  const server = new FakeServer([rejected("txBadSeq"), PENDING]);
  let simulations = 0;
  server.simulateTransaction = async () => { simulations += 1; return success(); };
  const engine = authEngine(server);
  const auth = fixedAuth();
  const tx = await engine.prepare(KEYPAIR.publicKey(), () => Operation.invokeContractFunction({
    contract: CONTRACT, function: "fixed", args: [], auth,
  }));
  await engine.signAndSubmit(tx, KEYPAIR);
  assert.equal(simulations, 1);
  assert.deepEqual(server.submitted.map(authXdr), [authXdr(tx), authXdr(tx)]);
});

const manageData = () => Operation.manageData({ name: "t", value: "1" });

async function write(engine) {
  const tx = await engine.buildTransaction(KEYPAIR.publicKey(), manageData());
  return engine.signAndSubmit(tx, KEYPAIR);
}

function clientOn(server) {
  const client = new AquariusClient({ network: "testnet" });
  client.engine = new SubmitEngine(server, PASSPHRASE, "100");
  return client;
}

test("simulations and writes never poll for the next ledger", async () => {
  const server = new FakeServer([PENDING], [CONFIRMED_LEDGER]);
  const engine = new SubmitEngine(server, PASSPHRASE, "100");
  await engine.read(KEYPAIR.publicKey(), manageData);
  await write(engine);
  await engine.read(KEYPAIR.publicKey(), manageData);
  await engine.read(KEYPAIR.publicKey(), manageData);
  assert.deepEqual(server.calls, ["simulate", "simulate", "simulate"]);
});

test("waitForNextLedger without a transaction waits past the current latest ledger", async () => {
  const server = new FakeServer([], [CONFIRMED_LEDGER, CONFIRMED_LEDGER, CONFIRMED_LEDGER + 1]);
  const latest = await clientOn(server).waitForNextLedger();
  assert.equal(latest, CONFIRMED_LEDGER + 1);
  assert.deepEqual(server.calls, ["getHealth", "getHealth", "getHealth"]);
});

test("waitForNextLedger defaults to the ledger of the last transaction", async () => {
  const server = new FakeServer([PENDING], [CONFIRMED_LEDGER, CONFIRMED_LEDGER, CONFIRMED_LEDGER + 1]);
  const client = clientOn(server);
  await write(client.engine);
  assert.equal(await client.waitForNextLedger(), CONFIRMED_LEDGER + 1);
  assert.deepEqual(server.calls, ["getHealth", "getHealth", "getHealth"]);

  server.calls = [];
  server.latestLedgers = [CONFIRMED_LEDGER + 1]; // already past it: no further wait
  assert.equal(await client.waitForNextLedger(), CONFIRMED_LEDGER + 1);
  assert.deepEqual(server.calls, ["getHealth"]);
});

test("waitForNextLedger waits past an explicit ledger", async () => {
  const server = new FakeServer(
    [PENDING],
    [CONFIRMED_LEDGER, CONFIRMED_LEDGER + 1, CONFIRMED_LEDGER + 2],
  );
  const client = clientOn(server);
  await write(client.engine);
  assert.equal(await client.waitForNextLedger({ ledger: CONFIRMED_LEDGER + 1 }), CONFIRMED_LEDGER + 2);
  assert.deepEqual(server.calls, ["getHealth", "getHealth", "getHealth"]);
});

test("waitForNextLedger rejects when the ledger does not advance in time", async () => {
  const server = new FakeServer([PENDING], [CONFIRMED_LEDGER]);
  const client = clientOn(server);
  await write(client.engine);
  await assert.rejects(
    () => client.waitForNextLedger({ timeoutMs: 20 }),
    error =>
      error instanceof AquariusError &&
      error.message.includes(`did not advance past ledger ${CONFIRMED_LEDGER}`),
  );
  assert.ok(server.calls.length > 1);
  assert.ok(server.calls.every(call => call === "getHealth"));
});

test("waitForNextLedger rejects invalid arguments before polling", async () => {
  const server = new FakeServer([], [CONFIRMED_LEDGER]);
  const client = clientOn(server);
  const invalid = message => error => error instanceof AquariusError && error.message === message;
  for (const ledger of [-1, 1.5, NaN, Infinity, "1"]) {
    await assert.rejects(
      () => client.waitForNextLedger({ ledger }),
      invalid("ledger must be a non-negative integer"),
    );
  }
  for (const timeoutMs of [0, -1, NaN, Infinity, "1000", null]) {
    await assert.rejects(
      () => client.waitForNextLedger({ timeoutMs }),
      invalid("timeoutMs must be a positive finite number"),
    );
  }
  assert.deepEqual(server.calls, []);
});

const handledProbe = JSON.parse(readFileSync(
  new URL("../../testdata/simulation_error_after_handled_probe.json", import.meta.url), "utf8",
));
const missingTrustline = JSON.parse(readFileSync(
  new URL("../../testdata/diagnostic_events_missing_trustline.json", import.meta.url), "utf8",
));
for (const method of ["prepare", "read"]) {
  for (const [label, message, events, errorType] of [
    ["handled ICE trustline probe", handledProbe.error, handledProbe.events_xdr, SlippageError],
    ["missing diagnostics", handledProbe.error, undefined, SlippageError],
    ["undecodable diagnostics", handledProbe.error, ["invalid"], SlippageError],
    ["failing output trustline", handledProbe.missing_trustline_error, missingTrustline.events_xdr, NoTrustlineError],
    ["text-only failing output trustline", handledProbe.missing_trustline_error, undefined, NoTrustlineError],
    ["failing output trustline with unreadable diagnostics", handledProbe.missing_trustline_error, ["invalid"], NoTrustlineError],
  ]) {
    test(`${method} diagnoses the simulation failure: ${label}`, async () => {
      const server = new FakeServer([]);
      server.simulateTransaction = async () => ({ _parsed: true, error: message, events: events?.map(raw => {
        try { return xdr.DiagnosticEvent.fromXdr(raw, "base64"); } catch { return raw; }
      }), latestLedger: 100 });
      const engine = new SubmitEngine(server, PASSPHRASE, "100");
      await assert.rejects(engine[method](KEYPAIR.publicKey(), () => Operation.manageData({ name: "test", value: "1" })), error => {
        assert.equal(error.constructor, errorType);
        if (errorType === SlippageError) assert.match(error.message, /#2006/);
        return true;
      });
      assert.equal(server.submitted.length, 0);
    });
  }
}
