import { Buffer } from "buffer";

import { Address, Asset as StellarAsset, Keypair, Operation, nativeToScVal, scValToNative, rpc, xdr } from "@stellar/stellar-sdk";

import { ApiClient, HTTP_TIMEOUT_MS, parseFindPathResponse, ParsedRoute } from "./api.js";
import { Asset } from "./assets.js";
import { authorizedInvocation, sourceAccountEntry } from "./authorization.js";
import { AquariusError, SlippageError } from "./errors.js";
import { CollectorContext, FeeCollector } from "./collector.js";
import { NETWORKS, NetworkConfig } from "./networks.js";
import {
  Pool,
  Position,
  parsePoolMeta,
  parsePoolsMap,
  sortTokenIds,
} from "./pool.js";
import { Signer } from "./signer.js";
import { ConfirmedTx, SubmitEngine } from "./submit.js";

export interface AquariusConfig {
  network: "mainnet" | "testnet";
  signer?: Signer;
  /** Overrides for self-hosted infrastructure. */
  rpcUrl?: string;
  horizonUrl?: string;
  apiUrl?: string;
  /** Inclusion fee bid in stroops. Default 100000 (0.01 XLM). */
  baseFee?: string;
  /**
   * Transaction time bound in seconds, or "infinite". Default: 300 when the
   * signer is a local keypair (a stale bot transaction should expire, not
   * execute later at a worse price); "infinite" when signing goes through a
   * wallet (humans take their time).
   */
  timeoutSeconds?: number | "infinite";
}

export interface Receipt {
  txHash: string;
  /** Base units actually spent. */
  amountIn: bigint;
  /** Base units actually received. */
  amountOut: bigint;
}

export interface ProviderFeeConfig {
  /** Deployed provider-fee collector contract. */
  readonly contractId: string;
  /** Raw u32 fee_fraction passed to the collector. */
  readonly feeFraction: number;
  /** Denominator configured when the collector was deployed. */
  readonly feeDenominator: number;
  /** Output recipient. Omit to send output back to the signer. */
  readonly recipient?: string;
}

export type QuoteParams = {
  from: Asset;
  to: Asset;
  /** Fraction, default 0.01 (1%). */
  slippage?: number;
  /** Route and execute the swap through a provider-fee collector. */
  providerFee?: ProviderFeeConfig;
} & ({ amountIn: bigint; amountOut?: never } | { amountOut: bigint; amountIn?: never });

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
  /** Escape hatch: the simulated, unsigned transaction envelope XDR — sign it anywhere. */
  buildTransaction(): Promise<string>;
}

const FRIENDBOT_URL = "https://friendbot.stellar.org";
const U32_MAX = 2 ** 32 - 1;

function validateProviderFee(config: ProviderFeeConfig): void {
  if (typeof config.contractId !== "string" || config.contractId.length === 0) {
    throw new AquariusError("provider fee contractId must be a non-empty address");
  }
  if (config.recipient !== undefined && config.recipient.length === 0) {
    throw new AquariusError("provider fee recipient must be a non-empty address");
  }
  if (!Number.isInteger(config.feeFraction) || config.feeFraction < 0 || config.feeFraction > U32_MAX) {
    throw new AquariusError("provider feeFraction must be a u32");
  }
  if (
    !Number.isInteger(config.feeDenominator)
    || config.feeDenominator < 1
    || config.feeDenominator > U32_MAX
  ) {
    throw new AquariusError("provider feeDenominator must be a positive u32");
  }
  if (config.feeFraction >= config.feeDenominator) {
    throw new AquariusError("provider feeFraction must be smaller than feeDenominator");
  }
}

function netAfterProviderFee(gross: bigint, config: ProviderFeeConfig): bigint {
  const fraction = BigInt(config.feeFraction);
  const denominator = BigInt(config.feeDenominator);
  const fee = (gross * fraction + denominator - 1n) / denominator;
  return gross - fee;
}

function grossBeforeProviderFee(net: bigint, config: ProviderFeeConfig): bigint {
  const denominator = BigInt(config.feeDenominator);
  const divisor = denominator - BigInt(config.feeFraction);
  return (net * denominator + divisor - 1n) / divisor;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class AquariusClient {
  /**
   * Pauses before re-quotes in swap(), indexed by retry attempt (the last
   * entry repeats). The find-path API prices from an indexer that can lag the
   * chain — after your own swap moves a pool, a too-early re-quote reprices
   * from pre-swap reserves and breaches the guard again. The first retry is
   * immediate (an on-chain guard breach already burned enough wall-clock for
   * the indexer to catch up); later ones wait for the lag window to close.
   * Static so tests can shrink it.
   */
  static _requoteDelaysMs = [0, 1_500, 3_000];

  readonly network: NetworkConfig;
  /** Typed client for the public backend API — the raw escape hatch. */
  readonly api: ApiClient;

  private readonly server: rpc.Server;
  private readonly engine: SubmitEngine;
  private readonly signer?: Signer;

  constructor(config: AquariusConfig) {
    const preset = NETWORKS[config.network];
    if (!preset) throw new AquariusError(`Unknown network: ${config.network}`);
    this.network = {
      ...preset,
      rpcUrl: config.rpcUrl ?? preset.rpcUrl,
      horizonUrl: config.horizonUrl ?? preset.horizonUrl,
      apiUrl: config.apiUrl ?? preset.apiUrl,
    };
    this.api = new ApiClient(this.network.apiUrl);
    this.server = new rpc.Server(this.network.rpcUrl);
    let timeout: number | null;
    if (config.timeoutSeconds === undefined) {
      timeout = config.signer && "secret" in config.signer ? 300 : null;
    } else {
      timeout = config.timeoutSeconds === "infinite" ? null : config.timeoutSeconds;
    }
    this.engine = new SubmitEngine(
      this.server,
      this.network.passphrase,
      config.baseFee ?? "100000",
      timeout,
    );
    this.signer = config.signer;
  }

  // -- reads (no signer required) --------------------------------------------

  /** Best route for a swap. Pass amountIn (exact input) or amountOut (exact output). */
  async quote(params: QuoteParams): Promise<Quote> {
    const providerFee = params.providerFee
      ? Object.freeze({ ...params.providerFee })
      : undefined;
    params = { ...params, providerFee } as QuoteParams;
    if ((params.amountIn === undefined) === (params.amountOut === undefined)) {
      throw new AquariusError("Pass exactly one of amountIn / amountOut");
    }
    const exactInput = params.amountIn !== undefined;
    if (params.providerFee) validateProviderFee(params.providerFee);
    const slippageBps = Math.round((params.slippage ?? 0.01) * 10_000);
    const tokenIn = params.from.contractId(this.network.passphrase);
    const tokenOut = params.to.contractId(this.network.passphrase);
    const requestedAmount = exactInput ? params.amountIn! : params.amountOut!;
    const routeAmount = params.providerFee && !exactInput
      ? grossBeforeProviderFee(requestedAmount, params.providerFee)
      : requestedAmount;

    const response = await this.api.findPath(
      {
        token_in_address: tokenIn,
        token_out_address: tokenOut,
        amount: routeAmount.toString(),
      },
      exactInput,
    );
    const parsed = parseFindPathResponse(response, {
      amountIn: params.amountIn,
      amountOut: exactInput ? undefined : routeAmount,
      slippageBps,
      pairLabel: `${params.from} -> ${params.to}`,
    });
    if (params.providerFee) {
      if (exactInput) {
        parsed.amountOut = netAfterProviderFee(parsed.amountOut, params.providerFee);
        parsed.guard = netAfterProviderFee(parsed.guard, params.providerFee);
      } else {
        parsed.amountOut = params.amountOut!;
      }
    }

    return this.makeQuote(parsed, exactInput, tokenIn, params);
  }

  // -- writes ------------------------------------------------------------------

  /**
   * quote() + execute() in one call, for bots.
   *
   * retries: how many times to re-quote and retry after a SlippageError.
   * Each attempt starts from a fresh quote; the first retry is immediate and
   * later ones back off briefly so the pricing indexer can catch up with the
   * chain. Default 0 — fail on the first guard breach.
   */
  async swap(params: QuoteParams & { retries?: number }): Promise<Receipt> {
    const { retries = 0, ...quoteParams } = params;
    if (retries < 0) throw new AquariusError("retries must be >= 0");
    for (let attempt = 0; ; attempt++) {
      try {
        return await (await this.quote(quoteParams as QuoteParams)).execute();
      } catch (error) {
        if (!(error instanceof SlippageError) || attempt >= retries) throw error;
        const delays = AquariusClient._requoteDelaysMs;
        const delay = delays[Math.min(attempt, delays.length - 1)];
        if (delay) await sleep(delay);
      }
    }
  }

  // -- provider-fee collectors ---------------------------------------------------

  /** Attach to a deployed provider-fee collector contract. */
  feeCollector(address: string): FeeCollector {
    return new FeeCollector(address, this.collectorContext());
  }

  /**
   * Deploy a new provider-fee collector through the factory. The signer
   * becomes the collector's operator; `feeDestination` defaults to the
   * operator. `factory` overrides the network's known factory — required on
   * networks without one.
   */
  async deployFeeCollector(params: {
    maxFeeFraction: number;
    feeDenominator?: number;
    feeDestination?: string;
    factory?: string;
  }): Promise<FeeCollector> {
    const factory = params.factory ?? this.network.collectorFactory;
    if (!factory) {
      throw new AquariusError("No collector factory known for this network — pass factory");
    }
    const operator = this.readSource(true);
    const args = [
      new Address(operator).toScVal(),
      new Address(params.feeDestination ?? operator).toScVal(),
      nativeToScVal(params.maxFeeFraction, { type: "u32" }),
      nativeToScVal(params.feeDenominator ?? 10_000, { type: "u32" }),
    ];
    const confirmed = await this.submitContract(factory, "deploy_swap_fee_contract", args, [
      sourceAccountEntry(authorizedInvocation(factory, "deploy_swap_fee_contract", args)),
    ]);
    const address = scValToNative(confirmed.returnValue!) as string;
    return new FeeCollector(address, this.collectorContext());
  }

  private collectorContext(): CollectorContext {
    return {
      passphrase: this.network.passphrase,
      readSource: (requireSigner?: boolean) => this.readSource(requireSigner),
      readContract: (contractId, fn, args) => this.readContract(contractId, fn, args),
      submitContract: (contractId, fn, args, auth) =>
        this.submitContract(contractId, fn, args, auth),
      quoteSwapChain: async (from, to, amountIn, slippage) => {
        const response = await this.api.findPath(
          {
            token_in_address: from.contractId(this.network.passphrase),
            token_out_address: to.contractId(this.network.passphrase),
            amount: amountIn.toString(),
          },
          true,
        );
        const parsed = parseFindPathResponse(response, {
          amountIn,
          slippageBps: Math.round(slippage * 10_000),
          pairLabel: `${from} -> ${to}`,
        });
        return { swapChainXdr: parsed.swapChainXdr, guard: parsed.guard };
      },
    };
  }

  // -- Stellar quirks, absorbed --------------------------------------------------

  /** Create the trustline if the signer's account doesn't hold one. No-op for native. */
  async ensureTrustline(asset: Asset): Promise<void> {
    if (asset.isNative) return;
    const signer = this.requireSigner();
    const account = await this.fetchHorizonAccount(signer.publicKey());
    const holds = account.balances.some(
      b => b.asset_code === asset.code && b.asset_issuer === asset.issuer,
    );
    if (holds) return;
    const tx = await this.engine.buildTransaction(
      signer.publicKey(),
      Operation.changeTrust({ asset: asset.toClassic() as StellarAsset }),
    );
    await this.engine.signAndSubmit(tx, signer);
  }

  /**
   * Fund with 10,000 test XLM, then wait up to 30s for Horizon and RPC visibility.
   * Testnet only. A readiness timeout does not mean funding failed.
   */
  async fundWithFriendbot(): Promise<void> {
    if (this.network.passphrase !== NETWORKS.testnet.passphrase) {
      throw new AquariusError("Friendbot funds testnet accounts only");
    }
    const signer = this.requireSigner();
    const source = signer.publicKey();
    const response = await fetch(`${FRIENDBOT_URL}?addr=${source}`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new AquariusError(`Friendbot funding failed: HTTP ${response.status}`);
    }
    await this.waitForAccountReady(source);
  }

  private async waitForAccountReady(publicKey: string): Promise<void> {
    const deadline = performance.now() + 30_000;
    const remaining = () => {
      const ms = deadline - performance.now();
      if (ms <= 0) {
        throw new AquariusError(
          "Timed out waiting for funded account visibility on Horizon and RPC",
        );
      }
      return Math.ceil(ms);
    };
    // A separate transport bounds readiness requests without changing the
    // transaction client. getAccount masks RPC errors as account absence.
    const server = new rpc.Server(this.network.rpcUrl);
    const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({
      accountId: Keypair.fromPublicKey(publicKey).xdrAccountId(),
    }));
    while (true) {
      const response = await fetch(`${this.network.horizonUrl}/accounts/${publicKey}`, {
        signal: AbortSignal.timeout(remaining()),
      });
      if (!response.ok && response.status !== 404) {
        throw new AquariusError(`Account lookup failed: HTTP ${response.status}`);
      }
      if (response.ok) {
        server.httpClient.defaults.timeout = remaining();
        const result = await server.getLedgerEntries(key);
        if (result.entries.length > 0) {
          remaining();
          return;
        }
      }
      await sleep(Math.min(1_000, remaining()));
    }
  }

  // -- escape hatches ---------------------------------------------------------------

  /** Raw router invocation. Arguments are xdr.ScVal values; the result is decoded. */
  readonly contract = {
    call: async (fn: string, ...args: xdr.ScVal[]): Promise<unknown> => {
      const signer = this.requireSigner();
      const tx = await this.engine.prepare(
        signer.publicKey(),
        () => Operation.invokeContractFunction({ contract: this.network.router, function: fn, args }),
        signer,
      );
      const result = await this.engine.signAndSubmit(tx, signer);
      return result.returnValue ? scValToNative(result.returnValue) : undefined;
    },
  };

  // -- pools & positions ---------------------------------------------------------------

  readonly pools = {
    /** Every pool for the token pair, discovered on-chain, labeled via the API. */
    forPair: async (a: Asset, b: Asset): Promise<Pool[]> => {
      const tokens = sortTokenIds([
        a.contractId(this.network.passphrase),
        b.contractId(this.network.passphrase),
      ]);
      const value = await this.readRouter("get_pools", [
        xdr.ScVal.scvVec(tokens.map(t => new Address(t).toScVal())),
      ]);
      const byHash = parsePoolsMap(value);
      if (byHash.length === 0) return [];
      const meta = new Map(
        (await this.api.poolsByAddresses(byHash.map(([, address]) => address))).map(m => [
          m.address,
          m,
        ]),
      );
      const pools = await Promise.all(
        byHash.map(([hash, address]) => this.makePool(hash, address, tokens, meta.get(address))),
      );
      const order: Record<string, number> = { volatile: 0, stable: 1, concentrated: 2 };
      return pools.sort(
        (x, y) => (order[x.type] ?? 3) - (order[y.type] ?? 3) || x.feeBps - y.feeBps,
      );
    },
  };

  /**
   * Every pool where the address holds shares (default: the signer's account).
   *
   * Backed by the indexer — a deposit that just confirmed can take a few
   * seconds to appear. Share amounts are read from the chain.
   */
  async positions(address?: string): Promise<Position[]> {
    const holder = address ?? this.readSource(true);
    const entries = await this.api.userPools(holder);
    // Each pool needs its own share_id -> balance read chain; the chains are
    // independent of each other, so they run concurrently.
    const held = await Promise.all(
      entries.map(async entry => {
        const pool = await this.makePool(
          Buffer.from(entry.index, "hex"),
          entry.address,
          entry.tokens_addresses,
          entry,
        );
        return { pool, shares: await pool.shareBalance(holder) };
      }),
    );
    return held.filter(p => p.shares > 0n);
  }

  private async makePool(
    poolHash: Uint8Array,
    address: string,
    tokens: string[],
    meta?: { pool_type: string; fee: string; tokens_str?: string[] },
  ): Promise<Pool> {
    let parsed;
    if (meta) {
      parsed = parsePoolMeta(meta);
    } else {
      // pool not indexed yet — read type and fee from the contract
      const info = scValToNative(
        await this.readRouter("get_info", [
          xdr.ScVal.scvVec(tokens.map(t => new Address(t).toScVal())),
          xdr.ScVal.scvBytes(Buffer.from(poolHash)),
        ]),
      ) as { pool_type: string; fee: number | bigint };
      parsed = parsePoolMeta({
        pool_type: info.pool_type,
        fee: (Number(info.fee) / 10_000).toString(),
        tokens_str: [],
      });
    }
    return new Pool(address, poolHash, parsed.type, parsed.feeBps, [...tokens], parsed.labels, {
      passphrase: this.network.passphrase,
      router: this.network.router,
      readSource: (requireSigner?: boolean) => this.readSource(requireSigner),
      readRouter: (fn, args) => this.readRouter(fn, args),
      readContract: (contractId, fn, args) => this.readContract(contractId, fn, args),
      submitRouter: (fn, args, withUser) => this.submitRouter(fn, args, withUser),
      submitContract: (contractId, fn, args, auth) =>
        this.submitContract(contractId, fn, args, auth),
    });
  }

  // -- read/submit plumbing shared with Pool ---------------------------------------------

  private readSource(requireSigner = false): string {
    if (this.signer) return this.signer.publicKey();
    if (requireSigner) {
      throw new AquariusError("This operation requires a signer — pass one in the client config");
    }
    return this.network.readSource;
  }

  private readRouter(fn: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    return this.readContract(this.network.router, fn, args);
  }

  private readContract(contractId: string, fn: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
    return this.engine.read(
      this.readSource(),
      () => Operation.invokeContractFunction({ contract: contractId, function: fn, args }),
      this.signer,
    );
  }

  private async submitRouter(
    fn: string,
    args: xdr.ScVal[],
    withUser: boolean,
  ): Promise<ConfirmedTx> {
    const signer = this.requireSigner();
    const finalArgs = withUser ? [new Address(signer.publicKey()).toScVal(), ...args] : args;
    return this.submitContract(this.network.router, fn, finalArgs);
  }

  private async submitContract(
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
    auth?: xdr.SorobanAuthorizationEntry[],
  ): Promise<ConfirmedTx> {
    const signer = this.requireSigner();
    const tx = await this.engine.prepare(
      signer.publicKey(),
      () => Operation.invokeContractFunction({ contract: contractId, function: fn, args, auth }),
      signer,
    );
    return this.engine.signAndSubmit(tx, signer);
  }

  // -- internals ---------------------------------------------------------------------

  private makeQuote(
    parsed: ParsedRoute,
    exactInput: boolean,
    tokenIn: string,
    originalParams: QuoteParams,
  ): Quote {
    const buildOperation = () => this.buildSwapOperation(
      parsed,
      exactInput,
      tokenIn,
      originalParams.providerFee,
    );

    const quote: Quote = {
      amountIn: parsed.amountIn,
      amountOut: parsed.amountOut,
      guard: parsed.guard,
      route: parsed.route,
      isExactInput: exactInput,

      buildTransaction: async () => {
        const source = this.requireSigner().publicKey();
        const tx = await this.engine.prepare(source, buildOperation, this.signer);
        return tx.toXDR();
      },

      execute: async (): Promise<Receipt> => {
        const signer = this.requireSigner();
        try {
          const tx = await this.engine.prepare(signer.publicKey(), buildOperation, signer);
          const result = await this.engine.signAndSubmit(tx, signer);
          const returned = BigInt(scValToNative(result.returnValue!) as bigint);
          return exactInput
            ? { txHash: result.txHash, amountIn: parsed.amountIn, amountOut: returned }
            : { txHash: result.txHash, amountIn: returned, amountOut: parsed.amountOut };
        } catch (error) {
          if (error instanceof SlippageError) {
            error.attachRequote(() => this.quote(originalParams));
          }
          throw error;
        }
      },
    };
    return quote;
  }

  /**
   * Mirrors the transaction shape used by the Aquarius web app: explicit
   * authorization of the router call and its token-transfer sub-invocation
   * with exact amounts, so wallets present a bounded approval. For
   * strict-receive the authorized transfer is maxIn — the contract pulls the
   * maximum and refunds the difference.
   */
  private buildSwapOperation(
    parsed: ParsedRoute,
    exactInput: boolean,
    tokenIn: string,
    providerFee?: ProviderFeeConfig,
  ): xdr.Operation {
    const signer = this.requireSigner();
    const user = signer.publicKey();
    const contractId = providerFee?.contractId ?? this.network.router;
    let fn = exactInput ? "swap_chained" : "swap_chained_strict_receive";
    const amount = exactInput ? parsed.amountIn : parsed.amountOut;
    const transferAmount = exactInput ? parsed.amountIn : parsed.guard;

    const args: xdr.ScVal[] = [new Address(user).toScVal()];
    if (providerFee?.recipient !== undefined) {
      fn += "_to";
      args.push(new Address(providerFee.recipient).toScVal());
    }
    args.push(
      xdr.ScVal.fromXDR(parsed.swapChainXdr, "base64"),
      new Address(tokenIn).toScVal(),
      nativeToScVal(amount, { type: "u128" }),
      nativeToScVal(parsed.guard, { type: "u128" }),
    );
    if (providerFee) {
      args.push(nativeToScVal(providerFee.feeFraction, { type: "u32" }));
    }

    // With a provider fee the collector is the invoked contract: it pulls
    // the tokens from the user, takes its cut, and drives the router as
    // itself — so both the call and the bounded transfer target it.
    const transferInvocation = authorizedInvocation(tokenIn, "transfer", [
      new Address(user).toScVal(),
      new Address(contractId).toScVal(),
      nativeToScVal(transferAmount, { type: "i128" }),
    ]);

    return Operation.invokeContractFunction({
      contract: contractId,
      function: fn,
      args,
      auth: [
        sourceAccountEntry(authorizedInvocation(contractId, fn, args, [transferInvocation])),
      ],
    });
  }

  private async fetchHorizonAccount(
    publicKey: string,
  ): Promise<{ balances: { asset_code?: string; asset_issuer?: string }[] }> {
    const response = await fetch(`${this.network.horizonUrl}/accounts/${publicKey}`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new AquariusError(`Account lookup failed: HTTP ${response.status}`);
    }
    return (await response.json()) as { balances: { asset_code?: string; asset_issuer?: string }[] };
  }

  private requireSigner(): Signer {
    if (!this.signer) {
      throw new AquariusError("This operation requires a signer — pass one in the client config");
    }
    return this.signer;
  }
}
