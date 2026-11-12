import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

import { UserRejectedError, isUserRejection } from "./errors.js";

/**
 * Anything that can identify an account and sign a transaction envelope.
 * A stellar-sdk Keypair satisfies this structurally; wallet adapters provide
 * the XDR-signing form. Raw secret strings are never accepted.
 */
export type Signer = {
  publicKey(): string;
  /** Optional detached Soroban authorization support. Omit for transaction-only wallets. */
  signAuthEntry?(entryXdr: string): Promise<string> | string;
} & ({ secret(): string } | { sign(txXdr: string): Promise<string> | string });

/** @internal */
export async function signTransaction(
  signer: Signer,
  tx: Transaction,
  passphrase: string,
): Promise<Transaction> {
  try {
    if ("secret" in signer && typeof signer.secret === "function") {
      tx.sign(Keypair.fromSecret(signer.secret()));
      return tx;
    }
    const signedXdr = await (signer as { sign(xdr: string): Promise<string> | string }).sign(
      tx.toXDR(),
    );
    return TransactionBuilder.fromXDR(signedXdr, passphrase) as Transaction;
  } catch (error) {
    if (isUserRejection(error)) {
      throw new UserRejectedError("Transaction cancelled by the user");
    }
    throw error;
  }
}
