/** Base class for every error this SDK raises. */
export class AquariusError extends Error {
  constructor(
    message: string,
    readonly txHash?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The find-path API found no route for the requested pair and amount. */
export class NoRouteError extends AquariusError {}

/** The pool moved past your guard (contract errors 2006 / 2020). Re-quote and retry. */
export class SlippageError extends AquariusError {
  /** Set by the client when the error is thrown from a quote context. */
  private requoteThunk?: () => Promise<unknown>;

  /** A fresh quote for the same parameters. */
  requote<T = unknown>(): Promise<T> {
    if (!this.requoteThunk) {
      throw new AquariusError("requote() is only available on errors raised by execute()");
    }
    return this.requoteThunk() as Promise<T>;
  }

  /** @internal */
  attachRequote(thunk: () => Promise<unknown>): this {
    this.requoteThunk = thunk;
    return this;
  }
}

/** Operations paused by an emergency kill switch (contract errors 205-207). Not your bug. */
export class PausedError extends AquariusError {}

/** The signer (wallet) rejected the transaction. */
export class UserRejectedError extends AquariusError {}

/** The transaction was not confirmed within the polling window. Safe to retry. */
export class TxTimeoutError extends AquariusError {}

// Wallet-rejection messages across signers: Freighter, WalletConnect, Ledger.
const USER_REJECTED_MESSAGES = [
  "the user rejected this request.",
  "cancelled_by_user",
  "transaction cancelled by the user",
];

/** @internal Detect a wallet-side cancellation from a thrown error. */
export function isUserRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return USER_REJECTED_MESSAGES.some(m => message.includes(m));
}

const PAUSED_CODES = new Set([205, 206, 207, 2139]);
const SLIPPAGE_CODES = new Set([2005, 2006, 2020]);

/**
 * @internal Map a simulation/prepare failure string to a typed error.
 * Contract failures surface as substrings like `Error(Contract, #2006)`.
 */
export function classifyContractError(message: string, txHash?: string): AquariusError | null {
  const match = message.match(/Error\(Contract, #(\d+)\)/);
  if (match) {
    const code = Number(match[1]);
    if (SLIPPAGE_CODES.has(code)) {
      return new SlippageError(
        `Price moved past your guard (contract error #${code}) — re-quote and retry`,
        txHash,
      );
    }
    if (PAUSED_CODES.has(code)) {
      return new PausedError(
        `Operations are paused for this pool (contract error #${code}) — not an integration bug`,
        txHash,
      );
    }
    return new AquariusError(`Contract error #${code}`, txHash);
  }
  if (message.includes("Error(Budget, ExceededLimit)")) {
    return new AquariusError(
      "The call exceeded Soroban resource limits — for swaps this usually means too many hops",
      txHash,
    );
  }
  return null;
}
