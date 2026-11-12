import {
  Account,
  Operation,
  SorobanDataBuilder,
  TimeoutInfinite,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

import {
  AquariusError,
  RestoreRequiredError,
  TxTimeoutError,
  classifyContractError,
  errorFromDiagnostics,
} from "./errors.js";
import { Signer, signTransaction } from "./signer.js";

// Congestion backoff between resubmissions of the same signed transaction.
// Resubmitting is safe: the network dedupes by transaction hash. Starts fast —
// transient congestion often clears within a ledger — and escalates.
const RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

/** txBadSeq on submission — retried internally with a fresh sequence. */
class BadSeqRejection extends AquariusError {}

const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 2_000;

// How often waitForNextLedger polls the RPC's latest ledger.
const NEXT_LEDGER_POLL_INTERVAL_MS = 1_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fraction of the simulated Soroban resource fee added on top of it. The
 * declared resource fee is a cap: the network charges the non-refundable part
 * plus the refundable part actually consumed (rent, events, return value) and
 * refunds the rest, so headroom costs nothing unless it is used. The refundable
 * part depends on ledger state at apply time, which can change between
 * simulation and apply; without headroom such a transaction fails on-chain with
 * INVOKE_HOST_FUNCTION_INSUFFICIENT_REFUNDABLE_FEE.
 */
export const DEFAULT_RESOURCE_FEE_HEADROOM = 0.5;

/**
 * Fraction of the simulated CPU instructions added on top of them. Simulation
 * measures instructions against ledger state at simulation time, and the
 * declared count is a hard limit: a transaction that needs even one more
 * instruction at apply time fails on-chain with
 * INVOKE_HOST_FUNCTION_RESOURCE_LIMIT_EXCEEDED. Swaps have been observed to
 * use from ~0% to ~9% more instructions than simulated.
 */
export const DEFAULT_INSTRUCTION_HEADROOM = 0.25;

const UINT32_MAX = 4_294_967_295n;

/** Soroban charges compute per this many instructions. */
const INSTRUCTIONS_INCREMENT = 10_000n;

/**
 * How long the network's compute settings are reused. They change only
 * through validator-voted network upgrades.
 */
const NETWORK_COMPUTE_TTL_MS = 60 * 60 * 1_000;

/** @internal The network's CONFIG_SETTING_CONTRACT_COMPUTE_V0 values used here. */
export interface NetworkCompute {
  txMaxInstructions: bigint;
  feeRatePerInstructionsIncrement: bigint;
}

/** @internal Throws unless `headroom` is a non-negative finite number. */
export function validateHeadroom(headroom: unknown, option: string): number {
  if (typeof headroom !== "number" || !Number.isFinite(headroom) || headroom < 0) {
    throw new AquariusError(`${option} must be a non-negative finite number`);
  }
  return headroom;
}

/**
 * @internal Raises the declared Soroban instructions by
 * ceil(instructions * headroom), capped at the network's per-transaction
 * limit, and raises the resource fee and the total fee by the compute fee of
 * the added instructions — the same amount the network adds to the
 * non-refundable fee for them. Returned as is when nothing can be added or
 * the total fee would not fit in uint32.
 */
export function withInstructionHeadroom(
  tx: Transaction,
  headroom: number,
  compute: NetworkCompute,
  passphrase: string,
): Transaction {
  // XDR values are immutable; edit the wire form and rebuild the envelope.
  const wire = tx.toEnvelope().toXdrObject();
  if (headroom === 0 || wire.type !== 2 || wire.v1.tx.ext.v !== 1) return tx;
  const body = wire.v1.tx;
  const sorobanData = wire.v1.tx.ext.sorobanData;
  const simulated = sorobanData.resources.instructions;
  const declared = Math.min(
    simulated + Math.ceil(simulated * headroom),
    Number(compute.txMaxInstructions),
  );
  if (declared <= simulated) return tx;
  const computeFee = (instructions: number) => {
    const scaled = BigInt(instructions) * compute.feeRatePerInstructionsIncrement;
    return (scaled + INSTRUCTIONS_INCREMENT - 1n) / INSTRUCTIONS_INCREMENT;
  };
  const extraFee = computeFee(declared) - computeFee(simulated);
  if (BigInt(body.fee) + extraFee > UINT32_MAX) return tx;
  sorobanData.resources.instructions = declared;
  sorobanData.resourceFee += extraFee;
  body.fee = Number(BigInt(body.fee) + extraFee);
  return new Transaction(xdr.TransactionEnvelope.fromXdrObject(wire), passphrase);
}

async function fetchNetworkCompute(server: rpc.Server): Promise<NetworkCompute> {
  const key = xdr.LedgerKey.configSetting(
    new xdr.LedgerKeyConfigSetting({
      configSettingId: xdr.ConfigSettingId.configSettingContractComputeV0,
    }),
  );
  const { entries } = await server.getLedgerEntries(key);
  if (!entries.length) {
    throw new AquariusError("The RPC returned no CONTRACT_COMPUTE_V0 config setting");
  }
  const data = entries[0].val;
  if (data.type !== "configSetting" || data.configSetting.type !== "configSettingContractComputeV0") {
    throw new AquariusError("The RPC returned no CONTRACT_COMPUTE_V0 config setting");
  }
  const compute = data.configSetting.contractCompute;
  return {
    txMaxInstructions: compute.txMaxInstructions,
    feeRatePerInstructionsIncrement: compute.feeRatePerInstructionsIncrement,
  };
}

/**
 * @internal Raises the declared Soroban resource fee by
 * ceil(resourceFee * headroom) and the total fee by the same amount, so the
 * inclusion fee is unchanged. The increase is capped so the total fee stays
 * within uint32. Transactions without Soroban data are returned as is.
 */
export function withResourceFeeHeadroom(
  tx: Transaction,
  headroom: number,
  passphrase: string,
): Transaction {
  // XDR values are immutable; edit the wire form and rebuild the envelope.
  const wire = tx.toEnvelope().toXdrObject();
  if (headroom === 0 || wire.type !== 2 || wire.v1.tx.ext.v !== 1) return tx;
  const body = wire.v1.tx;
  const sorobanData = wire.v1.tx.ext.sorobanData;
  const resourceFee = sorobanData.resourceFee;
  const room = UINT32_MAX - BigInt(body.fee);
  const wanted = Number(resourceFee) * headroom;
  const extra = wanted >= Number(room) ? room : BigInt(Math.ceil(wanted));
  if (extra === 0n) return tx;
  sorobanData.resourceFee = resourceFee + extra;
  body.fee = Number(BigInt(body.fee) + extra);
  return new Transaction(xdr.TransactionEnvelope.fromXdrObject(wire), passphrase);
}

export interface ConfirmedTx {
  txHash: string;
  returnValue?: xdr.ScVal;
}

/**
 * @internal Builds, simulates, signs, submits, and confirms transactions,
 * handling the production failure modes: archived ledger state (restore and
 * retry), network congestion (bounded resubmission), stale sequence numbers
 * from load-balanced RPC (re-sign and resubmit), and typed contract errors.
 */
export class SubmitEngine {
  /**
   * Delays before re-signing after a txBadSeq rejection. Behind a
   * load-balanced RPC, the replica that served the sequence number may lag
   * the one that confirmed the previous transaction. The reload usually
   * lands on a converged replica, so retry fast first and escalate.
   * Static so tests can shrink the delays.
   */
  static _badSeqDelaysMs = [500, 1_000, 2_000];

  /** waitForNextLedger poll interval; static so tests can shrink it. */
  static _nextLedgerPollIntervalMs = NEXT_LEDGER_POLL_INTERVAL_MS;

  constructor(
    private readonly server: rpc.Server,
    private readonly passphrase: string,
    private readonly baseFee: string,
    /**
     * Transaction time bound in seconds; null means no upper bound (the right
     * default when a human signs through a wallet, the wrong one for bots,
     * whose stale transactions should expire rather than execute).
     */
    private readonly timeoutSeconds: number | null = null,
    /**
     * Fraction of the simulated resource fee added on top of it before
     * signing; 0 disables. See DEFAULT_RESOURCE_FEE_HEADROOM.
     */
    private readonly resourceFeeHeadroom: number = DEFAULT_RESOURCE_FEE_HEADROOM,
    /**
     * Fraction of the simulated CPU instructions added on top of them before
     * signing; 0 disables. See DEFAULT_INSTRUCTION_HEADROOM.
     */
    private readonly instructionHeadroom: number = DEFAULT_INSTRUCTION_HEADROOM,
  ) {
    validateHeadroom(resourceFeeHeadroom, "resourceFeeHeadroom");
    validateHeadroom(instructionHeadroom, "instructionHeadroom");
  }

  private readonly simulationAccounts = new Map<string, Promise<Account>>();

  private networkComputeCache?: { fetchedAt: number; value: Promise<NetworkCompute> };

  /**
   * Ledger of this engine's last transaction that made it on-chain (confirmed
   * or failed); the default for waitForNextLedger.
   */
  private lastTxLedger?: number;

  private networkCompute(): Promise<NetworkCompute> {
    const now = Date.now();
    const cached = this.networkComputeCache;
    if (cached && now - cached.fetchedAt < NETWORK_COMPUTE_TTL_MS) return cached.value;
    const value = fetchNetworkCompute(this.server).catch((error: unknown) => {
      // a failed fetch must not poison later transactions
      if (this.networkComputeCache?.value === value) this.networkComputeCache = undefined;
      throw error;
    });
    this.networkComputeCache = { fetchedAt: now, value };
    return value;
  }

  async buildTransaction(source: string, operation: xdr.Operation): Promise<Transaction> {
    return this.build(await this.server.getAccount(source), operation);
  }

  private build(account: Account, operation: xdr.Operation): Transaction {
    return new TransactionBuilder(account, {
      fee: this.baseFee,
      networkPassphrase: this.passphrase,
    })
      .addOperation(operation)
      .setTimeout(this.timeoutSeconds ?? TimeoutInfinite)
      .build();
  }

  private simulationAccount(source: string): Promise<Account> {
    // Simulation ignores sequence numbers, so one fetch per source serves
    // every read — concurrent reads share the in-flight request. Writes keep
    // loading fresh accounts via buildTransaction.
    let account = this.simulationAccounts.get(source);
    if (!account) {
      account = this.server.getAccount(source).catch((error: unknown) => {
        this.simulationAccounts.delete(source); // a failed fetch must not poison later reads
        throw error;
      });
      this.simulationAccounts.set(source, account);
    }
    return account;
  }

  /**
   * Wait until the RPC's latest ledger is greater than `ledger` and resolve
   * to the latest ledger observed. `ledger` defaults to the ledger of this
   * engine's last on-chain transaction (confirmed or failed), or, if there is
   * none, to the RPC's current latest ledger. Polls `getHealth` about once a
   * second and rejects with AquariusError after `timeoutMs`.
   */
  async waitForNextLedger(ledger?: number, timeoutMs = 30_000): Promise<number> {
    if (ledger !== undefined && (!Number.isSafeInteger(ledger) || ledger < 0)) {
      throw new AquariusError("ledger must be a non-negative integer");
    }
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new AquariusError("timeoutMs must be a positive finite number");
    }
    const deadline = Date.now() + timeoutMs;
    let latest = (await this.server.getHealth()).latestLedger;
    const target = ledger ?? this.lastTxLedger ?? latest;
    while (latest <= target) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new AquariusError(
          `The RPC did not advance past ledger ${target} within ${timeoutMs / 1_000} s`,
        );
      }
      await sleep(Math.min(SubmitEngine._nextLedgerPollIntervalMs, remaining));
      latest = (await this.server.getHealth()).latestLedger;
    }
    return latest;
  }

  /**
   * Enforce client-built authorization and assemble a contract transaction.
   * Simulation supplies resources, never authorization. If it reports
   * archived ledger entries and a signer is supplied, restore them first
   * (one extra signed transaction), then rebuild and simulate again.
   * Without a signer, return the unsigned restore via RestoreRequiredError.
   */
  async prepare(
    source: string,
    buildOperation: () => xdr.Operation,
    signer?: Signer,
  ): Promise<Transaction> {
    // Freeze the call and auth before awaiting RPC. Restoration must retry
    // this same authorization even if a caller mutates its original arrays.
    const operationXdr = buildOperation().toXDR();
    const operation = () => xdr.Operation.fromXDR(operationXdr);
    let tx = await this.buildTransaction(source, operation());
    let simulation = await this.server.simulateTransaction(tx, undefined, "enforce");

    if (rpc.Api.isSimulationRestore(simulation) && signer) {
      await this.restore(source, simulation, signer);
      tx = await this.buildTransaction(source, operation());
      simulation = await this.server.simulateTransaction(tx, undefined, "enforce");
    }

    if (rpc.Api.isSimulationRestore(simulation)) {
      if (signer) {
        throw new AquariusError("Ledger entries are still archived after restoration");
      }
      const restoreTx = await this.buildRestoreTransaction(source, simulation);
      throw new RestoreRequiredError(restoreTx.toXDR());
    }

    if (rpc.Api.isSimulationError(simulation)) {
      throw classifyContractError(simulation.error) ?? new AquariusError(simulation.error);
    }
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
      throw new AquariusError("Simulation returned no contract result");
    }

    return this.assemble(tx, operation(), simulation);
  }

  /** @internal Assemble fixed operations with configured resource headroom. */
  async assemble(
    tx: Transaction,
    fixedOperation: xdr.Operation,
    simulation: rpc.Api.SimulateTransactionSuccessResponse,
  ): Promise<Transaction> {
    const operationXdr = fixedOperation.toXDR();
    const operation = () => xdr.Operation.fromXDR(operationXdr);
    // Stellar assembly fills an empty operation auth list from result.auth.
    // Supply only client auth, including an intentionally empty list, and
    // retain the original operation byte-for-byte in the prepared envelope.
    const body = operation().body;
    if (body.type !== "invokeHostFunction") {
      throw new AquariusError("Only contract invocations can be prepared");
    }
    const auth = body.invokeHostFunctionOp.auth;
    let assembled = rpc.assembleTransaction(tx, {
      ...simulation,
      result: { ...simulation.result!, auth },
    }).clearOperations().addOperation(operation()).build();
    // Instructions first: their compute fee is part of the resource fee that
    // the fee headroom then scales.
    if (this.instructionHeadroom !== 0) {
      assembled = withInstructionHeadroom(
        assembled,
        this.instructionHeadroom,
        await this.networkCompute(),
        this.passphrase,
      );
    }
    return withResourceFeeHeadroom(assembled, this.resourceFeeHeadroom, this.passphrase);
  }

  private async restore(
    source: string,
    simulation: rpc.Api.SimulateTransactionRestoreResponse,
    signer: Signer,
  ): Promise<void> {
    const restoreTx = await this.buildRestoreTransaction(source, simulation);
    const signed = await signTransaction(signer, restoreTx, this.passphrase);
    await this.submit(signed);
  }

  private async buildRestoreTransaction(
    source: string,
    simulation: rpc.Api.SimulateTransactionRestoreResponse,
  ): Promise<Transaction> {
    const account = await this.server.getAccount(source);
    // The builder adds the Soroban resource fee to the inclusion fee.
    const sorobanData = new SorobanDataBuilder(simulation.restorePreamble.transactionData.build())
      .setResourceFee(simulation.restorePreamble.minResourceFee)
      .build();
    return withResourceFeeHeadroom(
      new TransactionBuilder(account, {
        fee: this.baseFee,
        networkPassphrase: this.passphrase,
      })
        .setSorobanData(sorobanData)
        .addOperation(Operation.restoreFootprint({}))
        .setTimeout(TimeoutInfinite)
        .build(),
      this.resourceFeeHeadroom,
      this.passphrase,
    );
  }

  /**
   * Execute a read through simulation — nothing is signed or submitted.
   * Archived entries are readable: restorePreamble accompanies the result.
   */
  async read(
    source: string,
    buildOperation: () => xdr.Operation,
  ): Promise<xdr.ScVal> {
    const tx = this.build(await this.simulationAccount(source), buildOperation());
    const simulation = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simulation)) {
      throw classifyContractError(simulation.error) ?? new AquariusError(simulation.error);
    }
    const retval = (simulation as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) {
      throw new AquariusError("Simulation returned no result");
    }
    return retval;
  }

  /** @internal Resubmit an already reviewed signed transaction without changing its hash. */
  submitSignedTransaction(tx: Transaction): Promise<ConfirmedTx> {
    return this.submit(tx);
  }

  /**
   * Sign, submit with congestion retries, and wait for confirmation.
   *
   * A txBadSeq rejection never touched the chain, so it is safe to retry: the
   * transaction is re-signed with a freshly loaded sequence number and
   * resubmitted — same operations, same guards.
   */
  async signAndSubmit(tx: Transaction, signer: Signer): Promise<ConfirmedTx> {
    let signed = await signTransaction(signer, tx, this.passphrase);
    for (const delay of SubmitEngine._badSeqDelaysMs) {
      try {
        return await this.submit(signed);
      } catch (error) {
        if (!(error instanceof BadSeqRejection)) throw error;
        await sleep(delay);
        signed = await this.resignWithFreshSequence(signed, signer);
      }
    }
    return this.submit(signed);
  }

  private async resignWithFreshSequence(signed: Transaction, signer: Signer): Promise<Transaction> {
    const account = await this.server.getAccount(signed.source);
    const envelope = signed.toEnvelope();
    if (envelope.type !== "envelopeTypeTx") {
      throw new AquariusError("Sequence recovery requires a v1 transaction envelope");
    }
    const updated = xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({
      tx: new xdr.Transaction({
        ...envelope.v1.tx,
        seqNum: BigInt(account.sequenceNumber()) + 1n,
      }),
      signatures: [],
    }));
    return signTransaction(signer, new Transaction(updated, this.passphrase), this.passphrase);
  }

  private async submit(signed: Transaction): Promise<ConfirmedTx> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendAndPoll(signed);
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (!delay || !(error instanceof TxTimeoutError)) {
          throw error;
        }
        await sleep(delay);
      }
    }
  }

  private async sendAndPoll(signed: Transaction): Promise<ConfirmedTx> {
    const response = await this.server.sendTransaction(signed);

    switch (response.status) {
      case "TRY_AGAIN_LATER":
        throw new TxTimeoutError("The network is congested — submission deferred", response.hash);
      case "DUPLICATE":
      case "PENDING":
        return this.poll(response.hash);
      default: {
        const name = response.errorResult?.result.type ?? "unknown";
        const message = `Transaction rejected on submission: ${name}`;
        if (name.toUpperCase().includes("BADSEQ")) {
          throw new BadSeqRejection(message, response.hash);
        }
        throw new AquariusError(message, response.hash);
      }
    }
  }

  private async poll(hash: string): Promise<ConfirmedTx> {
    // Poll fast at first — inclusion often lands within a ledger — then
    // settle into the steady interval.
    const result = await this.server.pollTransaction(hash, {
      attempts: POLL_ATTEMPTS,
      sleepStrategy: (iter: number) => Math.min(500 * Math.max(iter, 1), POLL_INTERVAL_MS),
    });

    // A failed transaction also applied in its ledger (sequence number, fee),
    // and what usually follows it is a retry that should simulate on the state
    // after it, so its ledger is remembered as well.
    if (
      result.status === rpc.Api.GetTransactionStatus.SUCCESS ||
      result.status === rpc.Api.GetTransactionStatus.FAILED
    ) {
      this.lastTxLedger = result.ledger ?? this.lastTxLedger;
    }

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { txHash: hash, returnValue: result.returnValue };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      const diagnosed = errorFromDiagnostics(
        (result as { diagnosticEventsXdr?: xdr.DiagnosticEvent[] }).diagnosticEventsXdr,
        hash,
      );
      if (diagnosed) throw diagnosed;
      throw new AquariusError(
        "The transaction failed on-chain without recognized diagnostics. Inspect the transaction hash before retrying.",
        hash,
      );
    }
    throw new TxTimeoutError("Transaction was not confirmed in time", hash);
  }
}
