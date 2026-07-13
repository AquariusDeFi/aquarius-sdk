/**
 * @aquariusdefi/sdk — the TypeScript SDK for the Aquarius protocol on Stellar.
 *
 * INTERFACE STUBS for design review. Method signatures and types are the
 * proposal; bodies throw. The Python package implements the same surface —
 * the two are kept in lockstep, verified against shared fixtures in /testdata.
 */

// --- assets -----------------------------------------------------------------

/** A token, however you happen to know it: native, code+issuer, or contract ID. */
export class Asset {
  private constructor(
    readonly code?: string,
    readonly issuer?: string,
    private readonly contractId_?: string,
  ) {}

  static native(): Asset {
    return new Asset("XLM");
  }
  static classic(code: string, issuer: string): Asset {
    return new Asset(code, issuer);
  }
  static contract(contractId: string): Asset {
    return new Asset(undefined, undefined, contractId);
  }

  /** Resolve to the Soroban contract ID for the given network passphrase. */
  contractId(passphrase: string): string {
    throw new NotImplemented();
  }
}

export const XLM = Asset.native();

// --- config -----------------------------------------------------------------

/** Anything that can sign a transaction envelope XDR. Never a raw secret string. */
export type Signer =
  | { sign(xdr: string): Promise<string> } // wallet adapters (Freighter, …)
  | { secret(): string };                  // stellar-sdk Keypair (bots, scripts)

export interface AquariusConfig {
  network: "mainnet" | "testnet";
  signer?: Signer;
  /** Monetization in one line: routes swaps through your fee collector. */
  providerFee?: { bps: number; destination: string };
  /** Overrides for self-hosted infrastructure. */
  rpcUrl?: string;
  horizonUrl?: string;
  apiUrl?: string;
}

// --- quotes & receipts --------------------------------------------------------

export interface Receipt {
  txHash: string;
  amountIn: bigint;  // stroops actually spent
  amountOut: bigint; // stroops actually received
}

export interface Quote {
  amountIn: bigint;
  amountOut: bigint;
  /** minOut (exact-input) or maxIn (exact-output). */
  guard: bigint;
  /** Pool contract addresses along the path. */
  route: string[];
  isExactInput: boolean;
  /** Build, sign, submit, confirm, and parse the swap this quote describes. */
  execute(): Promise<Receipt>;
  /** Escape hatch: the unsigned transaction envelope XDR — sign it anywhere. */
  buildTransaction(): Promise<string>;
}

export type QuoteParams = {
  from: Asset;
  to: Asset;
  slippage?: number; // default 0.01
} & ({ amountIn: bigint; amountOut?: never } | { amountOut: bigint; amountIn?: never });

// --- pools ---------------------------------------------------------------------

export interface PoolReserves {
  tokens: Asset[];
  amounts: bigint[];
}

export interface Pool {
  address: string;
  type: "volatile" | "stable" | "concentrated";
  /** Fee in basis points. */
  fee: number;
  reserves(): Promise<PoolReserves>;
  deposit(params: { amounts: bigint[]; slippage?: number }): Promise<Receipt>;
  withdraw(params: { shares: bigint; slippage?: number }): Promise<Receipt>;
  pendingRewards(address: string): Promise<bigint>;
  claimRewards(): Promise<Receipt>;
}

// --- errors ----------------------------------------------------------------------

export class AquariusError extends Error {}
/** The find-path API found no route for the requested pair and amount. */
export class NoRouteError extends AquariusError {}
/** The pool moved past your guard (contract errors 2006 / 2020). Re-quote and retry. */
export class SlippageError extends AquariusError {
  requote(): Promise<Quote> {
    throw new NotImplemented();
  }
}
/** Operations paused by an emergency kill switch (contract errors 205–207). Not your bug. */
export class PausedError extends AquariusError {}

class NotImplemented extends Error {
  constructor() {
    super("interface stub — implementation follows design review");
  }
}

// --- client ------------------------------------------------------------------------

export class AquariusClient {
  constructor(readonly config: AquariusConfig) {}

  // -- reads (no signer required) --------------------------------------------------

  /** Best route for a swap. Pass amountIn (exact input) or amountOut (exact output). */
  quote(params: QuoteParams): Promise<Quote> {
    throw new NotImplemented();
  }

  pools = {
    forPair: (a: Asset, b: Asset): Promise<Pool[]> => {
      throw new NotImplemented();
    },
  };

  /** Everything an address holds: pool shares, pending rewards. */
  positions(address: string): Promise<{ pool: Pool; shares: bigint; pendingRewards: bigint }[]> {
    throw new NotImplemented();
  }

  // -- writes ------------------------------------------------------------------------

  /** quote() + execute() in one call, for bots. */
  swap(params: QuoteParams): Promise<Receipt> {
    throw new NotImplemented();
  }

  // -- Stellar quirks, absorbed --------------------------------------------------------

  /** Create the trustline if the signer's account doesn't hold one. No-op for native. */
  ensureTrustline(asset: Asset): Promise<void> {
    throw new NotImplemented();
  }

  /** Testnet only: fund the signer's account with 10,000 test XLM. */
  fundWithFriendbot(): Promise<void> {
    throw new NotImplemented();
  }

  // -- escape hatches ---------------------------------------------------------------------

  /** Raw router invocation with ScVal helpers — the SDK wraps, it never traps. */
  contract = {
    call: (fn: string, ...args: unknown[]): Promise<unknown> => {
      throw new NotImplemented();
    },
  };

  /** Typed raw API client. */
  api = {
    findPath: (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
      throw new NotImplemented();
    },
  };
}
