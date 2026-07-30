import { Buffer } from "buffer";

import { Address, Asset as StellarAsset, Operation, hash, nativeToScVal, scValToNative, rpc, xdr } from "@stellar/stellar-sdk";

import { ApiClient, parseFindPathResponse, ParsedRoute } from "./api.js";
import { Asset } from "./assets.js";
import { AquariusError, SlippageError } from "./errors.js";
import {
  LimitOrderConfig,
  LimitOrderConfigInput,
  LimitOrderPage,
  LimitOrderRecord,
  OnchainLimitOrderReceipt,
  OnchainLimitOrder,
  OnchainLimitOrderActions,
  OnchainLimitOrderDraftPayload,
  PreparedLimitOrderFill,
  buildOnchainPlacementArgs,
  fillParameters,
  parseLimitOrderRecord,
  validateFillReceipt,
  validateOnchainLimitOrderDraft,
} from "./limit-orders.js";
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
  /** Trusted coordinates for programmatic on-chain limit-order placement. */
  limitOrders?: LimitOrderConfigInput;
}

export interface Receipt {
  txHash: string;
  /** Base units actually spent. */
  amountIn: bigint;
  /** Base units actually received. */
  amountOut: bigint;
}

export type QuoteParams = {
  from: Asset;
  to: Asset;
  /** Fraction, default 0.01 (1%). */
  slippage?: number;
} & ({ amountIn: bigint; amountOut?: never } | { amountOut: bigint; amountIn?: never });

export interface OnchainLimitOrderParams {
  from: Asset;
  to: Asset;
  sellAmount: bigint;
  minBuyAmount: bigint;
  validAfterLedger: number;
  expiresAtLedger: number;
  /**
   * SEP-41 allowance horizon. Must cover this order and should be no earlier
   * than any other order sharing the same settlement allowance.
   */
  allowanceExpirationLedger: number;
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
  /** Escape hatch: the simulated, unsigned transaction envelope XDR — sign it anywhere. */
  buildTransaction(): Promise<string>;
}

const FRIENDBOT_URL = "https://friendbot.stellar.org";

export class AquariusClient {
  readonly network: NetworkConfig;
  /** Typed client for the public backend API — the raw escape hatch. */
  readonly api: ApiClient;

  private readonly server: rpc.Server;
  private readonly engine: SubmitEngine;
  private readonly signer?: Signer;
  private readonly limitOrderConfig?: LimitOrderConfig;

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
    this.limitOrderConfig = config.limitOrders
      ? new LimitOrderConfig(config.limitOrders)
      : undefined;
  }

  // -- reads (no signer required) --------------------------------------------

  /** Current Soroban RPC ledger sequence. */
  async latestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  /** Read one validated cursor page from the public order registry. */
  async listLimitOrders(params: {
    maker?: string;
    status?: string;
    cursor?: string;
    limit?: number;
  } = {}): Promise<LimitOrderPage> {
    this.requireLimitOrderConfig();
    const limit = params.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new AquariusError("limit-order page size must be between 1 and 100");
    }
    const query: Record<string, string> = { limit: String(limit) };
    if (params.maker !== undefined) query.maker = params.maker;
    if (params.status !== undefined) query.status = params.status;
    if (params.cursor !== undefined) query.cursor = params.cursor;
    const page = await this.api.listLimitOrders(this.limitOrderApiUrl(), query);
    if (!Array.isArray(page.orders)) {
      throw new AquariusError("limit-order registry returned an invalid page");
    }
    return {
      orders: page.orders.map(item =>
        this.parseLimitOrderRecord(item as Record<string, unknown>)),
      nextCursor: page.next_cursor === null || page.next_cursor === undefined
        ? null
        : String(page.next_cursor),
    };
  }

  /** Read every open order, following cursor pages defensively. */
  async openLimitOrders(maker?: string): Promise<LimitOrderRecord[]> {
    const records: LimitOrderRecord[] = [];
    const seenOrderIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 10_000; pageNumber++) {
      const page = await this.listLimitOrders({
        maker,
        status: "open",
        cursor,
      });
      for (const order of page.orders) {
        if (seenOrderIds.has(order.orderId)) {
          throw new AquariusError(
            "limit-order registry repeated an order across pages",
          );
        }
        seenOrderIds.add(order.orderId);
        records.push(order);
      }
      if (page.nextCursor === null) return records;
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
        throw new AquariusError(
          "limit-order registry returned an invalid pagination cursor",
        );
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new AquariusError("limit-order pagination exceeded the safety limit");
  }

  /** Read and validate one public order-registry record. */
  async getLimitOrder(orderId: string): Promise<LimitOrderRecord> {
    return this.parseLimitOrderRecord(
      await this.api.getLimitOrder(this.limitOrderApiUrl(), orderId),
    );
  }

  /** Best route for a swap. Pass amountIn (exact input) or amountOut (exact output). */
  async quote(params: QuoteParams): Promise<Quote> {
    if ((params.amountIn === undefined) === (params.amountOut === undefined)) {
      throw new AquariusError("Pass exactly one of amountIn / amountOut");
    }
    const exactInput = params.amountIn !== undefined;
    const slippageBps = Math.round((params.slippage ?? 0.01) * 10_000);
    const tokenIn = params.from.contractId(this.network.passphrase);
    const tokenOut = params.to.contractId(this.network.passphrase);

    const response = await this.api.findPath(
      {
        token_in_address: tokenIn,
        token_out_address: tokenOut,
        amount: (exactInput ? params.amountIn! : params.amountOut!).toString(),
      },
      exactInput,
    );
    const parsed = parseFindPathResponse(response, {
      amountIn: params.amountIn,
      amountOut: params.amountOut,
      slippageBps,
      pairLabel: `${params.from} -> ${params.to}`,
    });

    return this.makeQuote(parsed, exactInput, tokenIn, params);
  }

  // -- writes ------------------------------------------------------------------

  /**
   * quote() + execute() in one call, for bots.
   *
   * retries: how many times to re-quote and retry after a SlippageError.
   * Each attempt starts from a fresh quote. Default 0 — fail on the first
   * guard breach.
   */
  async swap(params: QuoteParams & { retries?: number }): Promise<Receipt> {
    const { retries = 0, ...quoteParams } = params;
    if (retries < 0) throw new AquariusError("retries must be >= 0");
    for (let attempt = 0; ; attempt++) {
      try {
        return await (await this.quote(quoteParams as QuoteParams)).execute();
      } catch (error) {
        if (!(error instanceof SlippageError) || attempt >= retries) throw error;
      }
    }
  }

  /** Create a canonical API draft for programmatic G-account placement. */
  async createOnchainLimitOrder(
    params: OnchainLimitOrderParams,
  ): Promise<OnchainLimitOrder> {
    const signer = this.requireSigner();
    const maker = signer.publicKey();
    if (!maker.startsWith("G")) {
      throw new AquariusError("generic SDK on-chain placement requires a G-account signer");
    }
    const i128Max = (1n << 127n) - 1n;
    if (
      params.sellAmount <= 0n ||
      params.minBuyAmount <= 0n ||
      params.sellAmount > i128Max ||
      params.minBuyAmount > i128Max ||
      !Number.isInteger(params.validAfterLedger) ||
      !Number.isInteger(params.expiresAtLedger) ||
      params.validAfterLedger < 0 ||
      params.validAfterLedger > 0xffffffff ||
      params.expiresAtLedger < 0 ||
      params.expiresAtLedger > 0xffffffff ||
      params.validAfterLedger > params.expiresAtLedger
    ) {
      throw new AquariusError(
        "on-chain limit-order amounts must fit positive i128 values and ledgers must fit u32",
      );
    }
    if (
      !Number.isInteger(params.allowanceExpirationLedger) ||
      params.allowanceExpirationLedger < params.expiresAtLedger ||
      params.allowanceExpirationLedger > 0xffffffff
    ) {
      throw new AquariusError(
        "allowance expiration must be a u32 ledger at or after order expiration",
      );
    }
    const sellToken = params.from.contractId(this.network.passphrase);
    const buyToken = params.to.contractId(this.network.passphrase);
    if (sellToken === buyToken) {
      throw new AquariusError("limit-order sell and buy tokens must differ");
    }
    const config = this.requireLimitOrderConfig(true);
    const payload = await this.api.createLimitOrderDraft(
      config.apiUrl ?? this.network.limitOrdersApiUrl,
      {
        placement_mode: "CONTRACT_ONCHAIN",
        maker,
        sell_token: sellToken,
        sell_amount: params.sellAmount.toString(),
        buy_token: buyToken,
        min_buy_amount: params.minBuyAmount.toString(),
        valid_after_ledger: params.validAfterLedger,
        expires_at_ledger: params.expiresAtLedger,
      },
    );
    return validateOnchainLimitOrderDraft(
      payload as OnchainLimitOrderDraftPayload,
      {
        expectedNetworkPassphrase: this.network.passphrase,
        expectedSettlement: config.settlement,
        expectedMaker: maker,
        expectedOrder: {
          sellToken,
          sellAmount: params.sellAmount,
          buyToken,
          minBuyAmount: params.minBuyAmount,
          validAfterLedger: params.validAfterLedger,
          expiresAtLedger: params.expiresAtLedger,
        },
        allowanceExpirationLedger: params.allowanceExpirationLedger,
        actions: this.onchainLimitOrderActions(),
      },
    );
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

  /** Testnet only: fund the signer's account with 10,000 test XLM. */
  async fundWithFriendbot(): Promise<void> {
    if (this.network.passphrase !== NETWORKS.testnet.passphrase) {
      throw new AquariusError("Friendbot funds testnet accounts only");
    }
    const signer = this.requireSigner();
    const response = await fetch(`${FRIENDBOT_URL}?addr=${signer.publicKey()}`);
    if (!response.ok) {
      throw new AquariusError(`Friendbot funding failed: HTTP ${response.status}`);
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
    const positions: Position[] = [];
    for (const entry of await this.api.userPools(holder)) {
      const pool = await this.makePool(
        Buffer.from(entry.index, "hex"),
        entry.address,
        entry.tokens_addresses,
        entry,
      );
      const shares = await pool.shareBalance(holder);
      if (shares > 0n) positions.push({ pool, shares });
    }
    return positions;
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
      readSource: (requireSigner?: boolean) => this.readSource(requireSigner),
      readRouter: (fn, args) => this.readRouter(fn, args),
      readContract: (contractId, fn, args) => this.readContract(contractId, fn, args),
      submitRouter: (fn, args, withUser) => this.submitRouter(fn, args, withUser),
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
    const tx = await this.engine.prepare(
      signer.publicKey(),
      () =>
        Operation.invokeContractFunction({
          contract: this.network.router,
          function: fn,
          args: finalArgs,
        }),
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
    const buildOperation = () => this.buildSwapOperation(parsed, exactInput, tokenIn);

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

  private async prepareLimitOrderFill(
    record: LimitOrderRecord,
    swapChainXdr: string,
    rewardTo?: string,
  ): Promise<PreparedLimitOrderFill> {
    this.validateLimitOrderContext(record);
    if (record.status !== "OPEN") {
      throw new AquariusError("only an open limit order can be filled");
    }
    const signer = this.requireSigner();
    const filler = signer.publicKey();
    const recipient = rewardTo ?? filler;
    if (recipient !== filler) {
      throw new AquariusError(
        "the SDK requires the execution fee to pay the transaction signer",
      );
    }
    const operation = Operation.invokeContractFunction({
      contract: record.settlementAddress,
      function: "fill",
      args: fillParameters(record, recipient, swapChainXdr),
      auth: record.authorization ? [record.authorization] : [],
    });
    const transaction = await this.engine.buildTransaction(filler, operation);
    const simulation = await this.server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationRestore(simulation)) {
      throw new AquariusError("limit-order fill requires footprint restoration");
    }
    if (rpc.Api.isSimulationError(simulation)) {
      throw new AquariusError(
        `limit-order fill simulation failed: ${simulation.error}`,
      );
    }
    const resultValue = simulation.result?.retval;
    if (!resultValue) {
      throw new AquariusError("limit-order fill simulation returned no receipt");
    }
    const receipt = validateFillReceipt(record, recipient, resultValue);
    const prepared = this.assembleLimitOrderFill(transaction, simulation);
    const maximumFee = BigInt(prepared.fee);
    if (maximumFee >= record.order.executorRewardXlm) {
      throw new AquariusError(
        `fill maximum fee ${maximumFee} is not below execution fee ` +
        `${record.order.executorRewardXlm}`,
      );
    }
    return new PreparedLimitOrderFill(
      record,
      receipt,
      maximumFee,
      prepared.toXDR(),
      async () => {
        const result = await this.engine.signAndSubmit(prepared, signer);
        return { txHash: result.txHash, order: record, receipt };
      },
    );
  }

  /** @internal Exposed for deterministic simulation/assembly tests. */
  assembleLimitOrderFill(
    transaction: import("@stellar/stellar-sdk").Transaction,
    simulation: rpc.Api.SimulateTransactionSuccessResponse,
  ): import("@stellar/stellar-sdk").Transaction {
    return rpc.assembleTransaction(transaction, simulation).build();
  }

  private async buildLimitOrderCancel(record: LimitOrderRecord): Promise<string> {
    const signer = this.limitOrderMakerSigner(record);
    const operation = this.buildLimitOrderCancelOperation(record);
    return (
      await this.engine.prepare(record.order.maker, () => operation, signer)
    ).toXDR();
  }

  private async cancelLimitOrder(
    record: LimitOrderRecord,
  ): Promise<OnchainLimitOrderReceipt> {
    const signer = this.limitOrderMakerSigner(record);
    const operation = this.buildLimitOrderCancelOperation(record);
    const transaction = await this.engine.prepare(
      record.order.maker,
      () => operation,
      signer,
    );
    const result = await this.engine.signAndSubmit(transaction, signer);
    return { orderId: record.orderId, txHash: result.txHash };
  }

  private limitOrderRecordActions() {
    return {
      prepareLimitOrderFill: (
        record: LimitOrderRecord,
        swapChainXdr: string,
        rewardTo?: string,
      ) => this.prepareLimitOrderFill(record, swapChainXdr, rewardTo),
      buildLimitOrderCancel: (record: LimitOrderRecord) =>
        this.buildLimitOrderCancel(record),
      cancelLimitOrder: (record: LimitOrderRecord) =>
        this.cancelLimitOrder(record),
    };
  }

  private buildLimitOrderCancelOperation(record: LimitOrderRecord): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: record.settlementAddress,
      function: "cancel",
      args: [record.order.orderScVal],
    });
  }

  private limitOrderMakerSigner(record: LimitOrderRecord): Signer {
    this.validateLimitOrderContext(record);
    const signer = this.requireSigner();
    if (signer.publicKey() !== record.order.maker) {
      throw new AquariusError("the signer is not the limit-order maker");
    }
    return signer;
  }

  private onchainLimitOrderActions(): OnchainLimitOrderActions {
    return {
      buildPlacement: async order => {
        const signer = this.requireSigner();
        const operation = await this.buildOnchainLimitOrderOperation(order);
        const tx = await this.engine.prepare(signer.publicKey(), () => operation, signer);
        return tx.toXDR();
      },
      place: async order => {
        const signer = this.requireSigner();
        const operation = await this.buildOnchainLimitOrderOperation(order);
        const tx = await this.engine.prepare(signer.publicKey(), () => operation, signer);
        const result = await this.engine.signAndSubmit(tx, signer);
        return { orderId: order.orderId, txHash: result.txHash };
      },
      buildCancel: async order => {
        const signer = this.requireSigner();
        const operation = this.buildOnchainLimitOrderCancelOperation(order);
        const tx = await this.engine.prepare(signer.publicKey(), () => operation, signer);
        return tx.toXDR();
      },
      cancel: async order => {
        const signer = this.requireSigner();
        const operation = this.buildOnchainLimitOrderCancelOperation(order);
        const tx = await this.engine.prepare(signer.publicKey(), () => operation, signer);
        const result = await this.engine.signAndSubmit(tx, signer);
        return { orderId: order.orderId, txHash: result.txHash };
      },
    };
  }

  private async buildOnchainLimitOrderOperation(
    order: OnchainLimitOrder,
  ): Promise<xdr.Operation> {
    const config = this.requireLimitOrderConfig(true);
    const xlmToken = Asset.native().contractId(this.network.passphrase);
    const currentAllowances = new Map<string, bigint>();
    for (const token of order.requiredAllowances(xlmToken).keys()) {
      const value = await this.readContract(token, "allowance", [
        new Address(order.maker).toScVal(),
        new Address(order.settlementAddress).toScVal(),
      ]);
      currentAllowances.set(token, BigInt(scValToNative(value) as bigint));
    }
    return Operation.invokeContractFunction({
      contract: config.batcher!,
      function: "batch",
      args: buildOnchainPlacementArgs(order, currentAllowances, xlmToken),
    });
  }

  private buildOnchainLimitOrderCancelOperation(order: OnchainLimitOrder): xdr.Operation {
    return Operation.invokeContractFunction({
      contract: order.settlementAddress,
      function: "cancel",
      args: [order.orderScVal],
    });
  }

  /**
   * Mirrors the transaction shape used by the Aquarius web app: explicit
   * authorization of the router call and its token-transfer sub-invocation
   * with exact amounts, so wallets present a bounded approval. For
   * strict-receive the authorized transfer is maxIn — the contract pulls the
   * maximum and refunds the difference.
   */
  private buildSwapOperation(parsed: ParsedRoute, exactInput: boolean, tokenIn: string): xdr.Operation {
    const signer = this.requireSigner();
    const user = signer.publicKey();
    const fn = exactInput ? "swap_chained" : "swap_chained_strict_receive";
    const amount = exactInput ? parsed.amountIn : parsed.amountOut;
    const transferAmount = exactInput ? parsed.amountIn : parsed.guard;

    const args = [
      new Address(user).toScVal(),
      xdr.ScVal.fromXDR(parsed.swapChainXdr, "base64"),
      new Address(tokenIn).toScVal(),
      nativeToScVal(amount, { type: "u128" }),
      nativeToScVal(parsed.guard, { type: "u128" }),
    ];

    const transferInvocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(tokenIn).toScAddress(),
          functionName: "transfer",
          args: [
            new Address(user).toScVal(),
            new Address(this.network.router).toScVal(),
            nativeToScVal(transferAmount, { type: "i128" }),
          ],
        }),
      ),
      subInvocations: [],
    });

    const rootInvocation = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(this.network.router).toScAddress(),
            functionName: fn,
            args,
          }),
        ),
        subInvocations: [transferInvocation],
      }),
    });

    return Operation.invokeContractFunction({
      contract: this.network.router,
      function: fn,
      args,
      auth: [rootInvocation],
    });
  }

  private async fetchHorizonAccount(
    publicKey: string,
  ): Promise<{ balances: { asset_code?: string; asset_issuer?: string }[] }> {
    const response = await fetch(`${this.network.horizonUrl}/accounts/${publicKey}`);
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

  private limitOrderApiUrl(): string {
    return this.requireLimitOrderConfig().apiUrl ?? this.network.limitOrdersApiUrl;
  }

  private parseLimitOrderRecord(payload: Record<string, unknown>): LimitOrderRecord {
    const config = this.requireLimitOrderConfig();
    return parseLimitOrderRecord(payload, {
      networkPassphrase: this.network.passphrase,
      settlementAddress: config.settlement,
      xlmToken: Asset.native().contractId(this.network.passphrase),
      actions: this.limitOrderRecordActions(),
    });
  }

  private validateLimitOrderContext(record: LimitOrderRecord): void {
    const config = this.requireLimitOrderConfig();
    if (record.settlementAddress !== config.settlement) {
      throw new AquariusError("limit order targets another settlement contract");
    }
    const expectedNetworkId = hash(Buffer.from(this.network.passphrase)).toString("hex");
    if (record.networkId !== expectedNetworkId) {
      throw new AquariusError("limit order targets another network");
    }
    const validated = this.parseLimitOrderRecord(record.raw);
    if (
      validated.orderId !== record.orderId ||
      validated.status !== record.status ||
      !validated.order.orderScVal.toXDR().equals(record.order.orderScVal.toXDR()) ||
      (validated.authorization?.toXDR("base64") ?? null) !==
        (record.authorization?.toXDR("base64") ?? null)
    ) {
      throw new AquariusError(
        "limit-order record differs from its canonical payload",
      );
    }
  }

  private requireLimitOrderConfig(requireBatcher = false): LimitOrderConfig {
    if (!this.limitOrderConfig) {
      throw new AquariusError(
        "Limit orders require trusted settlement configuration",
      );
    }
    if (requireBatcher && !this.limitOrderConfig.batcher) {
      throw new AquariusError(
        "On-chain placement requires trusted batcher configuration",
      );
    }
    return this.limitOrderConfig;
  }
}
