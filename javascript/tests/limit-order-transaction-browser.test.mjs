import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { Buffer as BrowserBuffer } from "buffer/index.js";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

// Node's native Buffer.equals accepts Uint8Array, but the browser polyfill does not.
// Load the actual SDK validators with the same buffer resolution as the frontend.
register(new URL("./helpers/browser-buffer-loader.mjs", import.meta.url));
const { assertLimitOrderTransaction, assertLimitOrderSignatures } =
  await import("../dist/limit-order-transaction.js");

const maker = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(5));
const cosigner = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(6));
const transaction = () =>
  new TransactionBuilder(new Account(maker.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.manageData({ name: "test", value: "limit-order" }))
    .setTimeout(0)
    .build();
const account = (keys, threshold = 1) => ({
  signers: keys.map((key) => ({ type: "ed25519_public_key", key: key.publicKey(), weight: 1 })),
  thresholds: { med_threshold: threshold },
});

test("accepts an unchanged wallet-signed transaction with browser Buffer", () => {
  const expected = transaction();
  assert.equal(BrowserBuffer.isBuffer(expected.hash()), false);
  assert.throws(() => BrowserBuffer.from(expected.hash()).equals(expected.hash()), /Buffer/);
  const signed = new Transaction(expected.toXDR(), Networks.TESTNET);
  signed.sign(maker);
  const validated = assertLimitOrderTransaction(expected, signed.toXDR());
  assert.equal(validated.toXDR(), signed.toXDR());
});

test("accepts sufficient valid signatures with browser Buffer", () => {
  const signed = transaction();
  signed.sign(maker);
  assert.equal(BrowserBuffer.isBuffer(maker.signatureHint()), false);
  assert.doesNotThrow(() => assertLimitOrderSignatures(signed, account([maker])));
  signed.sign(cosigner);
  assert.doesNotThrow(() => assertLimitOrderSignatures(signed, account([maker, cosigner], 2)));
});

test("rejects modified, unsigned and malformed wallet transactions with browser Buffer", () => {
  const expected = transaction();
  const changed = TransactionBuilder.cloneFrom(expected, { fee: "200" }).build();
  changed.sign(maker);
  assert.throws(() => assertLimitOrderTransaction(expected, changed.toXDR()), /wallet changed/);
  assert.throws(() => assertLimitOrderTransaction(expected, expected.toXDR()), /no signatures/);
  assert.throws(
    () => assertLimitOrderTransaction(expected, "invalid"),
    /invalid signed transaction/,
  );
});

test("rejects partial, duplicate and unrelated signatures with browser Buffer", () => {
  const signed = transaction();
  signed.sign(maker);
  const multisig = account([maker, cosigner], 2);
  assert.throws(() => assertLimitOrderSignatures(signed, multisig), /More signatures/);
  signed.sign(maker);
  assert.throws(() => assertLimitOrderSignatures(signed, multisig), /More signatures/);
  assert.throws(() => assertLimitOrderSignatures(signed, account([cosigner])), /More signatures/);
  const changed = TransactionBuilder.cloneFrom(signed, { fee: "200" }).build();
  changed.signatures.push(...signed.signatures);
  assert.throws(() => assertLimitOrderSignatures(changed, account([maker])), /More signatures/);
  assert.throws(
    () =>
      assertLimitOrderSignatures(signed, {
        ...account([maker]),
        thresholds: { low_threshold: 2, med_threshold: 1 },
      }),
    /More signatures/,
  );
});
