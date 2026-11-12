import { Buffer } from "buffer";
import { AquariusError } from "./errors.js";
import { Keypair, Transaction, xdr } from "@stellar/stellar-sdk";

// Simulation supplies resources and fees, never additional spending authority.
export const assertLimitOrderAuthorization = (
  tx: Transaction,
  source: string,
  expected: string,
) => {
  const operation = tx.operations[0];
  const expectedBody = xdr.Operation.fromXDR(expected, "base64").body;
  if (expectedBody.type !== "invokeHostFunction") {
    throw new AquariusError("Order authorization changed. Please try again.");
  }
  const expectedInvoke = expectedBody.invokeHostFunctionOp;
  if (
    tx.source !== source ||
    tx.operations.length !== 1 ||
    operation.type !== "invokeHostFunction" ||
    (operation.source && operation.source !== source) ||
    operation.func.toXDR("base64") !== expectedInvoke.hostFunction.toXDR("base64") ||
    JSON.stringify((operation.auth ?? []).map((entry) => entry.toXDR("base64"))) !==
      JSON.stringify(expectedInvoke.auth.map((entry) => entry.toXDR("base64")))
  ) {
    throw new AquariusError("Order authorization changed. Please try again.");
  }
};

export const assertLimitOrderTransaction = (expected: Transaction, signedXdr: string) => {
  let signed: Transaction;
  try {
    signed = new Transaction(signedXdr, expected.networkPassphrase);
  } catch {
    throw new AquariusError("The wallet returned an invalid signed transaction.");
  }
  // Pin the complete transaction, including fees, auth trees and resources.
  // Stellar SDK returns Uint8Array; browser Buffer.equals requires Buffer on both sides.
  if (!Buffer.from(signed.hash()).equals(Buffer.from(expected.hash())))
    throw new AquariusError("The wallet changed the limit order transaction. Review it again.");
  if (!signed.signatures.length)
    throw new AquariusError(
      "The transaction has no signatures. Collect the required signatures first.",
    );
  return signed;
};

export const assertLimitOrderSignatures = (
  signed: Transaction,
  account: {
    signers: Array<{ type: string; key: string; weight: number }>;
    thresholds: { low_threshold?: number; med_threshold: number };
  },
) => {
  // RPC remains authoritative (including pre-auth/hash signers). For the
  // usual ed25519 multisig, catch partial signatures before caching/submitting.
  if (account.signers.some((signer) => signer.type !== "ed25519_public_key")) return;
  const hash = signed.hash();
  const weight = account.signers.reduce((total, signer) => {
    const key = Keypair.fromPublicKey(signer.key);
    const valid = signed.signatures.some((signature) => {
      try {
        return (
          Buffer.from(signature.hint.toBytes()).equals(Buffer.from(key.signatureHint())) &&
          key.verify(hash, signature.signature.toBytes())
        );
      } catch {
        return false;
      }
    });
    return total + (valid ? signer.weight : 0);
  }, 0);
  if (weight < Math.max(1, account.thresholds.low_threshold ?? 0, account.thresholds.med_threshold))
    throw new AquariusError(
      "More signatures are required. Collect all required signatures and retry.",
    );
};
