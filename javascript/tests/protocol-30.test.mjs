// Shared, independently encoded Python fixtures; all signing below uses unfunded ephemeral keys.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  Account, Address, Keypair, Operation, TransactionBuilder, authorizeEntry,
  buildAuthorizationEntryPreimage, hash, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";
import { authorizedInvocation, sourceAccountEntry } from "../dist/authorization.js";
import { signTransaction } from "../dist/signer.js";

const fixture = JSON.parse(readFileSync(new URL("../../testdata/protocol_30.json", import.meta.url)));
const passphrase = fixture.network_passphrase;
const getAddressCredentials = credentials => credentials.address ?? credentials.addressV2 ?? credentials.addressWithDelegates.addressCredentials;
const hex = bytes => Buffer.from(bytes).toString("hex");
const muxed = fixture.addresses.find(a => a.name === "muxed_contract");
const contract = fixture.addresses.find(a => a.name === "contract");

test("old and Protocol 30 W addresses preserve Python XDR and the full uint64 muxed ID", () => {
  for (const entry of fixture.addresses) {
    const address = xdr.ScAddress.fromXdr(entry.sc_address_xdr, "base64");
    const value = xdr.ScVal.fromXdr(entry.sc_val_xdr, "base64");
    assert.equal(Address.fromScAddress(address).toString(), entry.address);
    assert.equal(scValToNative(value), entry.address);
    assert.equal(new Address(entry.address).toScAddress().toXdr("base64"), entry.sc_address_xdr);
    assert.equal(new Address(entry.address).toScVal().toXdr("base64"), entry.sc_val_xdr);
  }
  const address = new Address(muxed.address).toScAddress();
  assert.equal(address.muxedContract.id, BigInt(fixture.muxed_contract_id));
});

test("CAP-88 StellarValue and nested ledger headers decode all old/new variants", () => {
  for (const entry of fixture.stellar_values) {
    const value = xdr.StellarValue.fromXdr(entry.xdr, "base64");
    assert.equal(value.ext.toXdrObject().v, entry.extension);
    assert.equal(value.closeTime, BigInt(entry.close_time));
    if (entry.close_time_ms) assert.equal(value.ext.value.closeTimeMs, BigInt(entry.close_time_ms));
    assert.equal(value.toXdr("base64"), entry.xdr);
  }
  for (const entry of fixture.ledger_headers) {
    const header = xdr.LedgerHeader.fromXdr(entry.xdr, "base64");
    assert.equal(header.ledgerVersion, entry.protocol_version);
    assert.equal(header.scpValue.ext.toXdrObject().v, entry.extension);
    assert.equal(header.toXdr("base64"), entry.xdr);
  }
});

test("classic and Soroban envelopes retain cross-language hashes and valid signatures", () => {
  for (const entry of fixture.envelopes) {
    const tx = TransactionBuilder.fromXDR(entry.xdr, passphrase);
    assert.equal(tx.source, entry.source);
    assert.equal(tx.sequence, entry.sequence);
    assert.equal(hex(tx.hash()), entry.hash);
    assert.ok(Keypair.fromPublicKey(entry.source).verify(tx.hash(), tx.signatures[0].signature.toBytes()));
    assert.equal(tx.toXDR(), entry.xdr);
  }
});

test("legacy/address-bound/delegated auth preserve Python payloads and signatures", async () => {
  for (const entry of fixture.authorizations) {
    const auth = xdr.SorobanAuthorizationEntry.fromXdr(entry.xdr, "base64");
    const payload = hash(buildAuthorizationEntryPreimage(auth, entry.valid_until_ledger, passphrase).toXdr());
    const credentials = getAddressCredentials(auth.credentials);
    const signature = scValToNative(credentials.signature)[0].signature;
    assert.equal(hex(payload), entry.payload_hash);
    assert.equal(hex(signature), entry.signature_hex);
    assert.ok(Keypair.fromPublicKey(entry.public_key).verify(payload, signature));
    assert.equal(auth.toXdr("base64"), entry.xdr);

    // Signing with either supported credential version must keep the bounded invocation.
    const key = Keypair.random();
    const updated = new xdr.SorobanAddressCredentials({
      ...credentials, address: new Address(key.publicKey()).toScAddress(), signature: xdr.ScVal.scvVoid(),
    });
    const creds = entry.name === "legacy" ? xdr.SorobanCredentials.sorobanCredentialsAddress(updated)
      : entry.name === "address_v2" ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(updated)
      : xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
        new xdr.SorobanAddressCredentialsWithDelegates({ addressCredentials: updated, delegates: [] }),
      );
    const unsigned = new xdr.SorobanAuthorizationEntry({ credentials: creds, rootInvocation: auth.rootInvocation });
    const signed = await authorizeEntry(unsigned, key, entry.valid_until_ledger, passphrase);
    const signedPayload = hash(buildAuthorizationEntryPreimage(signed, entry.valid_until_ledger, passphrase).toXdr());
    const signedBytes = scValToNative(getAddressCredentials(signed.credentials).signature)[0].signature;
    assert.ok(key.verify(signedPayload, signedBytes));
    assert.equal(signed.rootInvocation.toXdr("base64"), auth.rootInvocation.toXdr("base64"));
  }
});

test("RPC v30 events without the removed success flag decode W values", () => {
  const response = rpc.parseRawEvents({ latestLedger: 123, events: [fixture.rpc_event], cursor: "next" });
  assert.equal(response.events.length, 1);
  assert.equal(scValToNative(response.events[0].value), muxed.address);
});

test("transaction meta v3/v4 retain old and W return values", () => {
  for (const entry of fixture.transaction_meta) {
    const meta = xdr.TransactionMeta.fromXdr(entry.xdr, "base64");
    const value = meta.value.sorobanMeta.returnValue;
    assert.equal(value.toXdr("base64"), entry.return_value_xdr);
    assert.equal(meta.toXdr("base64"), entry.xdr);
  }
});

for (const wallet of [false, true]) {
  test(`Aquarius ${wallet ? "wallet" : "keypair"} signing preserves source-account auth and W arguments`, async () => {
    const key = Keypair.random();
    const args = [new Address(muxed.address).toScVal()];
    const root = authorizedInvocation(contract.address, "compatibility", args);
    const operation = Operation.invokeContractFunction({
      contract: contract.address, function: "compatibility", args, auth: [sourceAccountEntry(root)],
    });
    const tx = new TransactionBuilder(new Account(key.publicKey(), "100"), { fee: "100", networkPassphrase: passphrase })
      .addOperation(operation).setTimeout(300).build();
    const signer = wallet ? {
      publicKey: () => key.publicKey(),
      sign: envelope => {
        const signed = TransactionBuilder.fromXDR(envelope, passphrase);
        signed.sign(key);
        return signed.toXDR();
      },
    } : key;
    const signed = await signTransaction(signer, tx, passphrase);
    assert.ok(key.verify(signed.hash(), signed.signatures[0].signature.toBytes()));
    const auth = signed.toEnvelope().v1.tx.operations[0].body.invokeHostFunctionOp.auth[0];
    assert.equal(auth.credentials.type, "sorobanCredentialsSourceAccount");
    assert.equal(auth.rootInvocation.toXdr("base64"), root.toXdr("base64"));
  });
}

test("Aquarius simulation assembly preserves bounded source auth over RPC-provided auth", async () => {
  const { SubmitEngine } = await import("../dist/submit.js");
  const key = Keypair.random();
  const args = [new Address(muxed.address).toScVal()];
  const entry = sourceAccountEntry(authorizedInvocation(contract.address, "compatibility", args));
  const simulation = rpc.parseRawSimulation(fixture.rpc_simulation);
  const server = {
    getAccount: async () => new Account(key.publicKey(), "100"),
    simulateTransaction: async () => simulation,
  };
  const engine = new SubmitEngine(server, passphrase, "100", undefined, 0, 0);
  const tx = await engine.prepare(key.publicKey(), () => Operation.invokeContractFunction({
    contract: contract.address, function: "compatibility", args, auth: [entry],
  }));
  assert.equal(tx.operations[0].auth[0].toXdr("base64"), entry.toXdr("base64"));
  assert.equal(tx.fee, "421");
  const value = await engine.read(key.publicKey(), () => Operation.invokeContractFunction({
    contract: contract.address, function: "compatibility", args,
  }));
  assert.equal(scValToNative(value), muxed.address);
});
