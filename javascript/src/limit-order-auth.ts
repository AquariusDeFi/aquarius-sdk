import {
  Address,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { Buffer } from "buffer";
import { AquariusError } from "./errors.js";

export const getAuthEntryPreimage = (
  entryXdr: string,
  address: string,
  networkPassphrase: string,
) => {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
  if (entry.credentials.type !== "sorobanCredentialsAddressV2") {
    throw new AquariusError("The order uses unsupported authorization credentials.");
  }
  const credentials = entry.credentials.addressV2;
  if (Address.fromScAddress(credentials.address).toString() !== address) {
    throw new AquariusError("The authorization belongs to another account.");
  }
  return buildAuthorizationEntryPreimage(
    entry,
    credentials.signatureExpirationLedger,
    networkPassphrase,
  );
};

// SEP-43 returns a raw signature; some providers return the complete entry.
// Verify either shape against the original ADDRESS_V2 payload before publishing it.
export async function normalizeSignedAuthEntry(
  unsignedEntryXdr: string,
  walletResult: string,
  address: string,
  networkPassphrase: string,
  signerAddress = address,
): Promise<string> {
  if (signerAddress !== address) {
    throw new AquariusError(
      "The wallet signed with another account. Please reconnect your wallet.",
    );
  }
  getAuthEntryPreimage(unsignedEntryXdr, address, networkPassphrase);
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(unsignedEntryXdr, "base64");
  if (entry.credentials.type !== "sorobanCredentialsAddressV2") {
    throw new AquariusError("The order uses unsupported authorization credentials.");
  }
  let completeEntry: xdr.SorobanAuthorizationEntry | undefined;
  try {
    completeEntry = xdr.SorobanAuthorizationEntry.fromXDR(walletResult, "base64");
  } catch {
    // Raw signatures are not authorization-entry XDR.
  }
  let signature = Buffer.from(walletResult, "base64");
  if (completeEntry) {
    if (completeEntry.credentials.type !== "sorobanCredentialsAddressV2") {
      throw new AquariusError("The wallet changed the authorization credentials.");
    }
    const credentials = completeEntry.credentials.addressV2;
    const signatures = scValToNative(credentials.signature);
    const unsignedWalletEntry = new xdr.SorobanAuthorizationEntry({
      ...completeEntry,
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
        new xdr.SorobanAddressCredentials({
          ...credentials,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
    });
    if (unsignedWalletEntry.toXDR("base64") !== unsignedEntryXdr) {
      throw new AquariusError("The wallet changed the authorization payload.");
    }
    if (
      !Array.isArray(signatures) ||
      signatures.length !== 1 ||
      !(signatures[0]?.public_key instanceof Uint8Array) ||
      !(signatures[0]?.signature instanceof Uint8Array) ||
      Address.account(signatures[0].public_key).toString() !== address
    ) {
      throw new AquariusError("The wallet returned an invalid authorization signature.");
    }
    signature = Buffer.from(signatures[0].signature);
  }
  try {
    const signed = await authorizeEntry(
      entry,
      async () => ({ signature, publicKey: address }),
      entry.credentials.addressV2.signatureExpirationLedger,
      networkPassphrase,
    );
    return signed.toXDR("base64");
  } catch (e) {
    if (e instanceof Error && e.message.includes(`signature doesn't match payload`)) {
      throw new AquariusError(
        "The wallet signature does not match the Protocol 27 authorization payload. " +
          "Update the wallet to a version that supports ADDRESS_V2 authorization entries.",
      );
    }
    throw e;
  }
}
