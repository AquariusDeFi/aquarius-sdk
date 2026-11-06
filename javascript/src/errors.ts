import { Buffer } from "buffer";

import { xdr } from "@stellar/stellar-sdk";

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

/** The pool moved past your guard (contract errors 2005 / 2006 / 2020). Re-quote and retry. */
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

/** Operations paused by an emergency kill switch (contract errors 205-207, 2139). Not your bug. */
export class PausedError extends AquariusError {}

/** The signer (wallet) rejected the transaction. */
export class UserRejectedError extends AquariusError {}

/** The transaction was not confirmed within the polling window. Safe to retry. */
export class TxTimeoutError extends AquariusError {}

/** The receiving account holds no trustline for the output asset. */
export class NoTrustlineError extends AquariusError {}

/**
 * The ledger footprint changed between simulation and execution.
 * Safe to retry: rebuilding the transaction re-simulates against current state.
 */
export class StaleSimulationError extends AquariusError {}

/** A build needs a separate restore: sign/submit this XDR, confirm it, then rebuild the call. */
export class RestoreRequiredError extends AquariusError {
  constructor(readonly restoreTransactionXdr: string) {
    super(
      "Ledger entries need restoration. Sign and submit restoreTransactionXdr, wait for confirmation, then rebuild the original transaction.",
    );
  }
}

/** The simulated call exceeded Soroban's resource budget. */
export class ResourceLimitError extends AquariusError {}

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

// Known contract error codes without a dedicated error class — the code alone
// is opaque, so attach what it means (concentrated position management).
const CONTRACT_MESSAGES: Record<number, string> = {
  212: "position not found",
  213: "insufficient liquidity",
  2107: "tick out of bounds",
  2109: "tick not aligned to the pool's tick spacing",
  2110: "tick_lower must be below tick_upper",
  2114: "amount must be greater than zero",
  2119: "too many positions for this account",
  2120: "liquidity amount too large",
};

// The token contract reports a missing trustline in its diagnostic output.
// Checked before contract codes: the same situation surfaces under different
// codes depending on where in the chain the payout fails.
const TRUSTLINE_MARKER = "trustline entry is missing";

const NO_TRUSTLINE_MESSAGE =
  "The output recipient holds no trustline for the output asset — create the trustline on that recipient before retrying";

/** @internal Map a numeric contract error code to a typed error. */
export function classifyContractCode(code: number, txHash?: string): AquariusError {
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
  const detail = CONTRACT_MESSAGES[code];
  if (detail) {
    return new AquariusError(`Contract error #${code}: ${detail}`, txHash);
  }
  return new AquariusError(`Contract error #${code}`, txHash);
}

/**
 * @internal Map a simulation/prepare failure string to a typed error.
 * Contract failures surface as substrings like `Error(Contract, #2006)`.
 */
export function classifyContractError(
  message: string,
  txHash?: string,
  events?: (xdr.DiagnosticEvent | string)[],
): AquariusError | null {
  const cause = errorFromDiagnostics(events, txHash);
  if (cause) return cause;
  // RPC's text log is newest first. Preserve a genuine trustline failure
  // when XDR events are unavailable, without diagnosing earlier caught probes.
  const failure = message.split(/\r?\n/, 1)[0];
  const errorLines: string[] = [];
  if (message.includes("Event log (newest first):")) {
    for (const line of message.split(/\r?\n/)) {
      if (!/^\s*\d+:/.test(line)) continue;
      if (/topics:\s*\[\s*error\b/.test(line)) errorLines.push(line);
      else if (errorLines.length) break;
    }
  }
  message = failure;
  if (failure.includes(TRUSTLINE_MARKER) || errorLines.some(line => line.includes(TRUSTLINE_MARKER))) {
    return new NoTrustlineError(NO_TRUSTLINE_MESSAGE, txHash);
  }
  const match = message.match(/Error\(Contract, #(\d+)\)/);
  if (match) {
    return classifyContractCode(Number(match[1]), txHash);
  }
  if (message.includes("Error(Budget, ExceededLimit)")) {
    return new ResourceLimitError(
      "The call exceeded Soroban resource limits — for swaps this usually means too many hops",
      txHash,
    );
  }
  return null;
}

/**
 * @internal Typed error from a failed transaction's diagnostic events, if
 * determinable. The trustline marker is checked on the raw event bytes;
 * contract error codes are read from `error` topics.
 */
function topicsOf(event: xdr.DiagnosticEvent): xdr.ScVal[] {
  return event.event.body.v0.topics;
}

export function errorFromDiagnostics(
  events: (xdr.DiagnosticEvent | string)[] | undefined,
  txHash?: string,
): AquariusError | null {
  // Only the trailing cascade of error events is diagnosed — that is the
  // failure that actually took the transaction down. Earlier error events can
  // be handled probes inside try_call (a reward-boost balance check on an
  // account without that trustline is routine) and must not drive the
  // diagnosis.
  const decoded: { bytes: Buffer; event: xdr.DiagnosticEvent; isError: boolean }[] = [];
  for (const raw of events ?? []) {
    try {
      const event = typeof raw === "string" ? xdr.DiagnosticEvent.fromXdr(raw, "base64") : raw;
      const bytes = typeof raw === "string" ? Buffer.from(raw, "base64") : Buffer.from(raw.toXdr());
      const isError = topicsOf(event).some(t => t.type === "scvSymbol" && t.sym.toString() === "error");
      decoded.push({ bytes, event, isError });
    } catch {
      // a single undecodable event never masks the rest
    }
  }

  const cascade: { bytes: Buffer; event: xdr.DiagnosticEvent }[] = [];
  let seenError = false;
  for (let i = decoded.length - 1; i >= 0; i--) {
    if (decoded[i].isError) {
      seenError = true;
      cascade.push(decoded[i]);
    } else if (seenError) {
      break;
    }
  }
  if (cascade.length === 0) return null;

  let code: number | null = null;
  let storage = false;
  for (const { bytes, event } of cascade) {
    if (bytes.includes(TRUSTLINE_MARKER)) {
      return new NoTrustlineError(NO_TRUSTLINE_MESSAGE, txHash);
    }
    for (const topic of topicsOf(event)) {
      if (topic.type !== "scvError") continue;
      const scError = topic.error;
      if (scError.type === "sceContract" && code === null) {
        code = scError.contractCode;
      } else if (scError.type === "sceStorage") {
        storage = true;
      }
    }
  }
  if (code !== null) return classifyContractCode(code, txHash);
  if (storage) {
    return new StaleSimulationError(
      "The ledger footprint changed between simulation and execution — rebuild the transaction and retry",
      txHash,
    );
  }
  return null;
}
