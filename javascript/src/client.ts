import { Buffer } from "buffer";

import { Address, Asset as StellarAsset, Keypair, Operation, Transaction, nativeToScVal, scValToNative, rpc, xdr } from "@stellar/stellar-sdk";

import { ApiClient, FindPathResponse, HTTP_TIMEOUT_MS, parseFindPathResponse, ParsedRoute } from "./api.js";
import { Asset } from "./assets.js";
import { authorizedInvocation, sourceAccountEntry } from "./authorization.js";
import { BatchCall, batchArgs, batchOperation, batchResults, isBudgetExceeded } from "./batch.js";
import { snapTick, tickFromPrice, tickSpacingForFee } from "./concentrated.js";
import { AquariusError, SlippageError } from "./errors.js";
import { CollectorContext, FeeCollector } from "./collector.js";
import { NETWORKS, NetworkConfig } from "./networks.js";
import {
  DepositAmounts,
  Pool,
  PoolType,
  Position,
  parsePoolMeta,
  parsePoolsMap,
  resolveAmounts,
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
  /**
   * Contract address overrides — a staging deployment on the same network,
   * for instance, is the network's preset with another router (and usually
   * another `apiUrl`). Unspecified addresses keep the preset's values.
   */
  contracts?: Partial<Pick<NetworkConfig, "router" | "batch" | "collectorFactory">>;
  /** Inclusion fee bid in stroops. Default 100000 (0.01 XLM). */
  baseFee?: string;
  /**
   * Transaction time bound in seconds, or "infinite". Default: 300 when the
   * signer is a local keypair (a stale bot transaction should expire, not
   * execute later at a worse price); "infinite" when signing goes through a
   * wallet (humans take their time).
   */
  timeoutSeconds?: number | "infinite";
  /**
   * Fraction of the simulated Soroban resource fee added on top of it before
   * signing. Default 0.5 (50%); 0 disables. The declared resource fee is a
   * cap and unused fee is refunded, so headroom costs nothing unless the
   * transaction needs it at apply time. The source account must still hold
   * the full declared fee (inclusion + resource + headroom): it is debited
   * before execution and the unused part is refunded after apply.
   */
  resourceFeeHeadroom?: number;
  /**
   * Fraction of the simulated CPU instructions added on top of them before
   * signing, capped at the network's per-transaction limit. Default 0.25
   * (25%); 0 disables. The resource fee is raised by the compute fee of the
   * added instructions, which is charged whether or not they are used.
   */
  instructionHeadroom?: number;
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

export interface SwapOptions {
  /**
   * Add the trustline for the output asset in the same transaction, through
   * the batch contract — one signature, one fee. Only for classic assets the
   * signer does not hold yet and whose issuer does not require authorization.
   */
  addTrustline?: boolean;
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
  execute(options?: SwapOptions): Promise<Receipt>;
  /** Escape hatch: the simulated, unsigned transaction envelope XDR — sign it anywhere. */
  buildTransaction(options?: SwapOptions): Promise<string>;
}

/** What creating a pool costs: paid in `token` to `destination`, per pool type. */
export interface PoolCreationFee {
  token: string;
  destination: string;
  volatile: bigint;
  stable: bigint;
  concentrated: bigint;
}

export type CreatePoolParams = {
  tokens: Asset[];
  /** Pool fee in basis points (10 = 0.1%). */
  feeBps: number;
  /** The first deposit — a pool is never created empty. */
  amounts: DepositAmounts;
  /** Refuse a creation fee that differs from the one the user reviewed. */
  expectedCreationFee?: { token: string; destination: string; amount: bigint };
  /** Fraction of the simulated shares/liquidity to tolerate losing. Default 0.01 (1%). */
  slippage?: number;
} & (
  | { type: "volatile" | "stable" }
  | {
      type: "concentrated";
      tickRange?: [number, number];
      priceRange?: [number | string, number | string];
    }
);

export interface CreatePoolResult {
  txHash: string;
  pool: Pool;
}

export type ClaimKind = "rewards" | "incentives" | "positionFees";

export interface IncentivesConfig {
  minDurationSeconds: bigint;
  /** Minimum reward per day, in the reward token's base units. */
  minDailyAmount: bigint;
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
      router: config.contracts?.router ?? preset.router,
      batch: config.contracts?.batch ?? preset.batch,
      collectorFactory: config.contracts?.collectorFactory ?? preset.collectorFactory,
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
      config.resourceFeeHeadroom,
      config.instructionHeadroom,
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
    return this.quoteFromPath(params, response);
  }

  /** Build a quote from a previously fetched find-path response, preserving the reviewed route. */
  quoteFromPath(params: QuoteParams, response: FindPathResponse): Quote {
    params = {
      ...params,
      providerFee: params.providerFee ? Object.freeze({ ...params.providerFee }) : undefined,
    } as QuoteParams;
    if ((params.amountIn === undefined) === (params.amountOut === undefined)) {
      throw new AquariusError("Pass exactly one of amountIn / amountOut");
    }
    if (params.providerFee) validateProviderFee(params.providerFee);
    const slippage = params.slippage ?? 0.01;
    if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 1) {
      throw new AquariusError("slippage must be a finite fraction in [0, 1)");
    }
    const slippageBps = Math.round(slippage * 10_000);
    const exactInput = params.amountIn !== undefined;
    const tokenIn = params.from.contractId(this.network.passphrase);
    const requestedAmount = exactInput ? params.amountIn! : params.amountOut!;
    const routeAmount = params.providerFee && !exactInput
      ? grossBeforeProviderFee(requestedAmount, params.providerFee)
      : requestedAmount;
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

  /** Raw router invocations with caller-defined authorization; results are decoded. */
  readonly contract = {
    /** Authorize only this router call. Use callWithAuth for nested authorization. */
    call: async (fn: string, ...args: xdr.ScVal[]): Promise<unknown> => {
      return this.contract.callWithAuth(fn, args, [
        sourceAccountEntry(authorizedInvocation(this.network.router, fn, args)),
      ]);
    },
    /** Supply the complete auth tree, or [] for a call requiring no authorization. */
    callWithAuth: async (
      fn: string,
      args: xdr.ScVal[],
      auth: xdr.SorobanAuthorizationEntry[],
    ): Promise<unknown> => {
      const result = await this.submitRouter(fn, args, auth);
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

    /**
     * One pool by its contract address — for callers that hold an address and
     * not a pair (a pool page, a stored position). Resolved through the
     * indexer, which supplies the tokens, hash, type and fee in one request.
     *
     * A pool the indexer has not picked up yet is not resolvable from an
     * address alone: pass `tokens` (the pair, in any order) and it is
     * discovered on-chain via get_pools instead.
     */
    byAddress: async (address: string, options?: { tokens: [Asset, Asset] }): Promise<Pool> => {
      if (options) {
        const pools = await this.pools.forPair(options.tokens[0], options.tokens[1]);
        const pool = pools.find(p => p.address === address);
        if (!pool) {
          throw new AquariusError(`Pool ${address} is not one of the pools for this pair`);
        }
        return pool;
      }
      const [meta] = await this.api.poolsByAddresses([address]);
      if (!meta) {
        throw new AquariusError(
          `Pool ${address} was not found. A pool that is not indexed yet needs its token pair — pass { tokens }.`,
        );
      }
      return this.makePool(
        Uint8Array.from(Buffer.from(meta.index, "hex")),
        meta.address,
        sortTokenIds(meta.tokens_addresses),
        meta,
      );
    },

    /**
     * Create a pool and make its first deposit in one transaction. There is
     * deliberately no way to create an empty pool: the creation fee, the
     * pool init and the deposit are one atomic batch under one signature.
     *
     * Volatile and stable pools take `amounts` in sorted-token order (or as
     * [asset, amount] pairs). A concentrated pool also needs the range —
     * `tickRange` or `priceRange` — snapped to the fee tier's tick spacing.
     * The minimum shares/liquidity comes from simulating the entire batch,
     * reduced by slippage, including when init resolves an existing pool.
     */
    create: async (params: CreatePoolParams): Promise<CreatePoolResult> => {
      const plan = await this.createPoolPlan(params);
      const confirmed = await this.submitBatch(plan.calls, plan.auth, true);
      return { txHash: confirmed.txHash, pool: plan.pool };
    },

    /** The same creation, prepared but not signed: envelope XDR plus the pool it will create. */
    buildCreate: async (
      params: CreatePoolParams,
    ): Promise<{ xdr: string; pool: Pool }> => {
      const plan = await this.createPoolPlan(params);
      return { xdr: await this.buildBatch(plan.calls, plan.auth, true), pool: plan.pool };
    },
  };

  /** What creating a pool costs right now — one simulation for all five values. */
  async poolCreationFee(): Promise<PoolCreationFee> {
    const router = this.network.router;
    const [token, volatile, stable, concentrated, destination] = await this.readBatch([
      { contractId: router, fn: "get_init_pool_payment_token", args: [] },
      { contractId: router, fn: "get_standard_pool_payment_amount", args: [] },
      { contractId: router, fn: "get_stable_pool_payment_amount", args: [] },
      { contractId: router, fn: "get_conc_pool_payment_amount", args: [] },
      { contractId: router, fn: "get_init_pool_payment_address", args: [] },
    ]);
    const stableFee = BigInt(scValToNative(stable) as bigint);
    return {
      token: scValToNative(token) as string,
      destination: scValToNative(destination) as string,
      volatile: BigInt(scValToNative(volatile) as bigint),
      stable: stableFee,
      concentrated: BigInt(scValToNative(concentrated) as bigint),
    };
  }

  private async createPoolPlan(params: CreatePoolParams): Promise<{
    calls: BatchCall[];
    auth: xdr.SorobanAuthorizedInvocation[];
    pool: Pool;
  }> {
    const user = this.requireSigner().publicKey();
    const passphrase = this.network.passphrase;
    const slippage = params.slippage ?? 0.01;
    if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 1) {
      throw new AquariusError("slippage must be a finite fraction in [0, 1)");
    }
    if (params.type === "stable" ? params.tokens.length < 2 : params.tokens.length !== 2) {
      throw new AquariusError(
        params.type === "stable"
          ? "A stable pool needs at least two tokens"
          : `A ${params.type} pool takes exactly two tokens`,
      );
    }
    const tokens = sortTokenIds(params.tokens.map(t => t.contractId(passphrase)));
    const desired = resolveAmounts(params.amounts, tokens, passphrase);
    if (desired.every(a => a === 0n)) {
      throw new AquariusError("A pool is created with its first deposit — pass non-zero amounts");
    }

    // 1. the init call, paying the creation fee
    const fee = await this.poolCreationFee();
    const initFn = {
      volatile: "init_standard_pool",
      stable: "init_stableswap_pool",
      concentrated: "init_concentrated_pool",
    }[params.type];
    const feeAmount = fee[params.type];
    const expected = params.expectedCreationFee;
    if (expected && (expected.token !== fee.token || expected.destination !== fee.destination || expected.amount !== feeAmount)) {
      throw new AquariusError("Pool creation fee changed. Review the fee and try again.");
    }
    const initArgs = [
      new Address(user).toScVal(),
      xdr.ScVal.scvVec(tokens.map(t => new Address(t).toScVal())),
      nativeToScVal(params.feeBps, { type: "u32" }),
    ];
    const initRoot = authorizedInvocation(this.network.router, initFn, initArgs, [
      authorizedInvocation(fee.token, "transfer", [
        new Address(user).toScVal(),
        new Address(fee.destination).toScVal(),
        nativeToScVal(feeAmount, { type: "i128" }),
      ]),
    ]);

    // 2. the address the pool will get: simulate the init on its own
    const created = scValToNative(
      await this.engine.read(
        user,
        () =>
          Operation.invokeContractFunction({
            contract: this.network.router,
            function: initFn,
            args: initArgs,
            auth: [sourceAccountEntry(initRoot)],
          }),
      ),
    ) as [Uint8Array, string];
    if (!Array.isArray(created) || typeof created[1] !== "string") {
      throw new AquariusError("Could not resolve the address of the pool to be created");
    }
    const [poolHash, poolAddress] = created;

    // 3. the first deposit into that address. Stable and concentrated pools
    // skip zero transfers; constant-product pools call transfer even for zero.
    const transfers = tokens.flatMap((token, i) =>
      params.type !== "volatile" && desired[i] === 0n ? [] : [
        authorizedInvocation(token, "transfer", [
          new Address(user).toScVal(),
          new Address(poolAddress).toScVal(),
          nativeToScVal(desired[i], { type: "i128" }),
        ]),
      ],
    );
    let depositFn: string;
    let depositArgs: xdr.ScVal[];
    if (params.type === "concentrated") {
      const spacing = tickSpacingForFee(params.feeBps);
      let range = params.tickRange;
      if (!range) {
        if (!params.priceRange) {
          throw new AquariusError("A concentrated pool needs tickRange or priceRange");
        }
        range = [
          snapTick(tickFromPrice(params.priceRange[0]), spacing),
          snapTick(tickFromPrice(params.priceRange[1]), spacing, { up: true }),
        ];
      }
      if (range[0] >= range[1]) {
        throw new AquariusError("tickLower must be below tickUpper");
      }
      depositFn = "deposit_position";
      depositArgs = [
        new Address(user).toScVal(),
        xdr.ScVal.scvI32(range[0]),
        xdr.ScVal.scvI32(range[1]),
        xdr.ScVal.scvVec(desired.map(a => nativeToScVal(a, { type: "u128" }))),
        nativeToScVal(1n, { type: "u128" }),
      ];
    } else {
      depositFn = "deposit";
      depositArgs = [
        new Address(user).toScVal(),
        xdr.ScVal.scvVec(desired.map(a => nativeToScVal(a, { type: "u128" }))),
        nativeToScVal(1n, { type: "u128" }),
      ];
    }

    const pool = this.newPool(
      poolAddress,
      Uint8Array.from(poolHash),
      params.type,
      params.feeBps,
      tokens,
      [],
    );
    const planFor = (minimum: bigint) => {
      const args = [...depositArgs.slice(0, -1), nativeToScVal(minimum, { type: "u128" })];
      return {
        calls: [
          { contractId: this.network.router, fn: initFn, args: initArgs },
          { contractId: poolAddress, fn: depositFn, args },
        ],
        auth: [initRoot, authorizedInvocation(poolAddress, depositFn, args, transfers)],
        pool,
      };
    };

    // A standalone estimator cannot read a pool that init has not deployed
    // yet. Simulate both calls atomically, then bind the wallet's auth tree
    // to the guarded deposit. Init can also resolve an existing pool.
    const preview = planFor(1n);
    const result = await this.engine.read(user, () =>
      batchOperation(this.network.batch, user, preview.calls, preview.auth, true),
    );
    const deposit = scValToNative(batchResults(result, 2)[1]) as unknown;
    if (
      !Array.isArray(deposit) || deposit.length !== 2 ||
      typeof deposit[1] !== "bigint" || deposit[1] <= 0n
    ) {
      throw new AquariusError("Pool creation simulation returned no positive shares/liquidity");
    }
    const factor = BigInt(Math.round((1 - slippage) * 10_000));
    const minimum = (deposit[1] * factor) / 10_000n;
    return planFor(minimum > 0n ? minimum : 1n);
  }

  // -- claims across pools -------------------------------------------------------------

  /**
   * Claim from several pools under one signature: AQUA rewards, gauge
   * incentives and concentrated position fees, in any mix.
   */
  async claim(items: Array<{ pool: Pool; kind: ClaimKind }>): Promise<{ txHash: string }> {
    const { calls, auth } = this.claimPlan(items);
    const confirmed = await this.submitBatch(calls, auth, false);
    return { txHash: confirmed.txHash };
  }

  /** The same multi-pool claim, prepared but not signed. */
  buildClaim(items: Array<{ pool: Pool; kind: ClaimKind }>): Promise<string> {
    const { calls, auth } = this.claimPlan(items);
    return this.buildBatch(calls, auth, false);
  }

  private claimPlan(items: Array<{ pool: Pool; kind: ClaimKind }>): {
    calls: BatchCall[];
    auth: xdr.SorobanAuthorizedInvocation[];
  } {
    if (items.length === 0) throw new AquariusError("Nothing to claim");
    const user = new Address(this.requireSigner().publicKey()).toScVal();
    const fnFor: Record<ClaimKind, string> = {
      rewards: "claim",
      incentives: "gauges_claim",
      positionFees: "claim_all_position_fees",
    };
    const calls = items.map(({ pool, kind }) => ({
      contractId: pool.address,
      fn: fnFor[kind],
      args: [user],
    }));
    return { calls, auth: calls.map(c => authorizedInvocation(c.contractId, c.fn, c.args)) };
  }

  // -- incentives ------------------------------------------------------------------------

  readonly incentives = {
    /** Router-wide limits for scheduling a gauge incentive. */
    config: async (): Promise<IncentivesConfig> => {
      const router = this.network.router;
      const [duration, daily] = await this.readBatch([
        { contractId: router, fn: "pool_gauge_get_min_duration", args: [] },
        { contractId: router, fn: "pool_gauge_get_min_daily_amount", args: [] },
      ]);
      return {
        minDurationSeconds: BigInt(scValToNative(duration) as bigint),
        minDailyAmount: BigInt(scValToNative(daily) as bigint),
      };
    },
  };

  // -- batch reads ------------------------------------------------------------------------

  readonly batch = {
    /**
     * Many contract reads in one simulation, results in call order. A batch
     * that overflows the simulation budget is split in halves until it fits.
     */
    read: (calls: BatchCall[]): Promise<xdr.ScVal[]> => this.readBatch(calls),
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
    return this.newPool(address, poolHash, parsed.type, parsed.feeBps, tokens, parsed.labels);
  }

  private newPool(
    address: string,
    poolHash: Uint8Array,
    type: PoolType,
    feeBps: number,
    tokens: string[],
    labels: string[],
  ): Pool {
    const { code, issuer } = this.network.rewardToken;
    return new Pool(address, poolHash, type, feeBps, [...tokens], labels, {
      passphrase: this.network.passphrase,
      router: this.network.router,
      rewardToken: Asset.classic(code, issuer).contractId(this.network.passphrase),
      readSource: (requireSigner?: boolean) => this.readSource(requireSigner),
      readRouter: (fn, args) => this.readRouter(fn, args),
      readContract: (contractId, fn, args) => this.readContract(contractId, fn, args),
      readBatch: calls => this.readBatch(calls),
      submitRouter: (fn, args, auth) => this.submitRouter(fn, args, auth),
      submitContract: (contractId, fn, args, auth) =>
        this.submitContract(contractId, fn, args, auth),
      submitBatch: (calls, auth, returnResults) => this.submitBatch(calls, auth, returnResults),
      buildRouter: (fn, args, auth) => this.buildRouter(fn, args, auth),
      buildContract: (contractId, fn, args, auth) =>
        this.buildContract(contractId, fn, args, auth),
      buildBatch: (calls, auth, returnResults) => this.buildBatch(calls, auth, returnResults),
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
    );
  }

  private submitRouter(
    fn: string,
    args: xdr.ScVal[],
    auth: xdr.SorobanAuthorizationEntry[],
  ): Promise<ConfirmedTx> {
    return this.submitContract(this.network.router, fn, args, auth);
  }

  private async submitContract(
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
    auth: xdr.SorobanAuthorizationEntry[],
  ): Promise<ConfirmedTx> {
    const tx = await this.prepareContract(contractId, fn, args, auth, this.requireSigner());
    return this.engine.signAndSubmit(tx, this.requireSigner());
  }

  /**
   * Simulate and assemble a contract call without signing it. The seam the
   * build* escape hatches sit on. Only submitting paths pass a restore
   * signer; builds report RestoreRequiredError with an unsigned restore.
   */
  private async prepareContract(
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
    auth: xdr.SorobanAuthorizationEntry[],
    restoreSigner?: Signer,
  ): Promise<Transaction> {
    if (!Array.isArray(auth)) {
      throw new AquariusError("An explicit auth array is required; use [] for a call without authorization");
    }
    const signer = this.requireSigner();
    return this.engine.prepare(
      signer.publicKey(),
      () => Operation.invokeContractFunction({ contract: contractId, function: fn, args, auth }),
      restoreSigner,
    );
  }

  private async buildContract(
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
    auth: xdr.SorobanAuthorizationEntry[],
  ): Promise<string> {
    return (await this.prepareContract(contractId, fn, args, auth)).toXDR();
  }

  private buildRouter(
    fn: string,
    args: xdr.ScVal[],
    auth: xdr.SorobanAuthorizationEntry[],
  ): Promise<string> {
    return this.buildContract(this.network.router, fn, args, auth);
  }

  private prepareBatch(
    calls: BatchCall[],
    auth: xdr.SorobanAuthorizedInvocation[],
    returnResults: boolean,
    restoreSigner?: Signer,
  ): Promise<Transaction> {
    const signer = this.requireSigner();
    return this.engine.prepare(
      signer.publicKey(),
      () => batchOperation(this.network.batch, signer.publicKey(), calls, auth, returnResults),
      restoreSigner,
    );
  }

  private async submitBatch(
    calls: BatchCall[],
    auth: xdr.SorobanAuthorizedInvocation[],
    returnResults: boolean,
  ): Promise<ConfirmedTx> {
    const tx = await this.prepareBatch(calls, auth, returnResults, this.requireSigner());
    return this.engine.signAndSubmit(tx, this.requireSigner());
  }

  private async buildBatch(
    calls: BatchCall[],
    auth: xdr.SorobanAuthorizedInvocation[],
    returnResults: boolean,
  ): Promise<string> {
    return (await this.prepareBatch(calls, auth, returnResults)).toXDR();
  }

  private async readBatch(calls: BatchCall[]): Promise<xdr.ScVal[]> {
    if (calls.length === 0) return [];
    const source = this.readSource();
    try {
      const retval = await this.engine.read(
        source,
        () =>
          Operation.invokeContractFunction({
            contract: this.network.batch,
            function: "batch",
            args: batchArgs(source, calls, true),
          }),
      );
      return batchResults(retval, calls.length);
    } catch (error) {
      if (!isBudgetExceeded(error) || calls.length < 2) throw error;
      const mid = Math.ceil(calls.length / 2);
      const [left, right] = await Promise.all([
        this.readBatch(calls.slice(0, mid)),
        this.readBatch(calls.slice(mid)),
      ]);
      return [...left, ...right];
    }
  }

  // -- internals ---------------------------------------------------------------------

  private makeQuote(
    parsed: ParsedRoute,
    exactInput: boolean,
    tokenIn: string,
    originalParams: QuoteParams,
  ): Quote {
    const buildOperation = (options?: SwapOptions) => {
      if (!options?.addTrustline) {
        return this.buildSwapOperation(parsed, exactInput, tokenIn, originalParams.providerFee);
      }
      // trust + swap atomically: the batch authorizes both, the swap keeps
      // its own bounded transfer underneath.
      const plan = this.swapPlan(parsed, exactInput, tokenIn, originalParams.providerFee);
      const user = this.requireSigner().publicKey();
      const trustline = this.trustlineCall(originalParams.to, user);
      return batchOperation(
        this.network.batch,
        user,
        [trustline, { contractId: plan.contractId, fn: plan.fn, args: plan.args }],
        [authorizedInvocation(trustline.contractId, trustline.fn, trustline.args), plan.root],
        true,
      );
    };
    const swapReturn = (retval: xdr.ScVal | undefined, options?: SwapOptions): bigint => {
      const value = options?.addTrustline ? batchResults(retval, 2)[1] : retval!;
      return BigInt(scValToNative(value) as bigint);
    };

    const quote: Quote = {
      amountIn: parsed.amountIn,
      amountOut: parsed.amountOut,
      guard: parsed.guard,
      route: parsed.route,
      isExactInput: exactInput,

      buildTransaction: async (options?: SwapOptions) => {
        const source = this.requireSigner().publicKey();
        const tx = await this.engine.prepare(source, () => buildOperation(options));
        return tx.toXDR();
      },

      execute: async (options?: SwapOptions): Promise<Receipt> => {
        const signer = this.requireSigner();
        try {
          const tx = await this.engine.prepare(
            signer.publicKey(),
            () => buildOperation(options),
            signer,
          );
          const result = await this.engine.signAndSubmit(tx, signer);
          const returned = swapReturn(result.returnValue, options);
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
  private swapPlan(
    parsed: ParsedRoute,
    exactInput: boolean,
    tokenIn: string,
    providerFee?: ProviderFeeConfig,
  ): { contractId: string; fn: string; args: xdr.ScVal[]; root: xdr.SorobanAuthorizedInvocation } {
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

    return {
      contractId,
      fn,
      args,
      root: authorizedInvocation(contractId, fn, args, [transferInvocation]),
    };
  }

  private buildSwapOperation(
    parsed: ParsedRoute,
    exactInput: boolean,
    tokenIn: string,
    providerFee?: ProviderFeeConfig,
  ): xdr.Operation {
    const plan = this.swapPlan(parsed, exactInput, tokenIn, providerFee);
    return Operation.invokeContractFunction({
      contract: plan.contractId,
      function: plan.fn,
      args: plan.args,
      auth: [sourceAccountEntry(plan.root)],
    });
  }

  /** The `trust` call on a classic asset's contract — the SAC's trustline creator. */
  private trustlineCall(asset: Asset, user: string): BatchCall {
    if (asset.isNative || asset.code === undefined || asset.issuer === undefined) {
      throw new AquariusError("Automatic trustlines are only available for classic assets");
    }
    if (asset.issuer === user) {
      throw new AquariusError("An issuer needs no trustline for its own asset");
    }
    return {
      contractId: asset.contractId(this.network.passphrase),
      fn: "trust",
      args: [new Address(user).toScVal()],
    };
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
