import {
  Operation,
  TimeoutInfinite,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

import {
  AquariusError,
  SlippageError,
  TxTimeoutError,
  classifyContractError,
  errorFromDiagnostics,
} from "./errors.js";
import { Signer, signTransaction } from "./signer.js";

// Congestion backoff between resubmissions of the same signed transaction.
// Resubmitting is safe: the network dedupes by transaction hash.
const RETRY_DELAYS_MS = [1_500, 3_000, 5_000, 8_000];

const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 2_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface ConfirmedTx {
  txHash: string;
  returnValue?: xdr.ScVal;
}

/**
 * @internal Builds, simulates, signs, submits, and confirms transactions,
 * handling the production failure modes: archived ledger state (restore and
 * retry), network congestion (bounded resubmission), and typed contract errors.
 */
export class SubmitEngine {
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
  ) {}

  async buildTransaction(source: string, operation: xdr.Operation): Promise<Transaction> {
    const account = await this.server.getAccount(source);
    return new TransactionBuilder(account, {
      fee: this.baseFee,
      networkPassphrase: this.passphrase,
    })
      .addOperation(operation)
      .setTimeout(this.timeoutSeconds ?? TimeoutInfinite)
      .build();
  }

  /**
   * Simulate and assemble a contract transaction. If simulation reports
   * archived ledger entries, restore them first (one extra signed
   * transaction), then rebuild and simulate again.
   */
  async prepare(
    source: string,
    buildOperation: () => xdr.Operation,
    signer?: Signer,
  ): Promise<Transaction> {
    let tx = await this.buildTransaction(source, buildOperation());
    let simulation = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationRestore(simulation)) {
      if (!signer) {
        throw new AquariusError(
          "Ledger entries for this call are archived and need a restore, which requires a signer",
        );
      }
      await this.restore(source, simulation, signer);
      tx = await this.buildTransaction(source, buildOperation());
      simulation = await this.server.simulateTransaction(tx);
    }

    if (rpc.Api.isSimulationError(simulation)) {
      throw classifyContractError(simulation.error) ?? new AquariusError(simulation.error);
    }

    return rpc.assembleTransaction(tx, simulation).build();
  }

  private async restore(
    source: string,
    simulation: rpc.Api.SimulateTransactionRestoreResponse,
    signer: Signer,
  ): Promise<void> {
    const account = await this.server.getAccount(source);
    const fee =
      parseInt(this.baseFee, 10) + parseInt(simulation.restorePreamble.minResourceFee, 10);
    const restoreTx = new TransactionBuilder(account, {
      fee: fee.toString(),
      networkPassphrase: this.passphrase,
    })
      .setSorobanData(simulation.restorePreamble.transactionData.build())
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(TimeoutInfinite)
      .build();
    const signed = await signTransaction(signer, restoreTx, this.passphrase);
    await this.submit(signed);
  }

  /**
   * Execute a read through simulation — nothing is signed or submitted. If the
   * entries are archived and a signer is available, restore them first.
   */
  async read(
    source: string,
    buildOperation: () => xdr.Operation,
    signer?: Signer,
  ): Promise<xdr.ScVal> {
    let tx = await this.buildTransaction(source, buildOperation());
    let simulation = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationRestore(simulation) && signer) {
      await this.restore(source, simulation, signer);
      tx = await this.buildTransaction(source, buildOperation());
      simulation = await this.server.simulateTransaction(tx);
    }

    if (rpc.Api.isSimulationError(simulation)) {
      throw classifyContractError(simulation.error) ?? new AquariusError(simulation.error);
    }
    const retval = (simulation as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) {
      throw new AquariusError("Simulation returned no result");
    }
    return retval;
  }

  /** Sign, submit with congestion retries, and wait for confirmation. */
  async signAndSubmit(tx: Transaction, signer: Signer): Promise<ConfirmedTx> {
    const signed = await signTransaction(signer, tx, this.passphrase);
    return this.submit(signed);
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
        const name = response.errorResult?.result().switch().name ?? "unknown";
        throw new AquariusError(`Transaction rejected on submission: ${name}`, response.hash);
      }
    }
  }

  private async poll(hash: string): Promise<ConfirmedTx> {
    const result = await this.server.pollTransaction(hash, {
      attempts: POLL_ATTEMPTS,
      sleepStrategy: () => POLL_INTERVAL_MS,
    });

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { txHash: hash, returnValue: result.returnValue };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      const diagnosed = errorFromDiagnostics(
        (result as { diagnosticEventsXdr?: xdr.DiagnosticEvent[] }).diagnosticEventsXdr,
        hash,
      );
      if (diagnosed) throw diagnosed;
      // No recognizable cause in the diagnostics: simulation already passed,
      // so pool state most likely moved past the guard between simulation and
      // inclusion.
      throw new SlippageError(
        "The transaction failed on-chain — pool state likely moved past your guard between simulation and inclusion. Re-quote and retry.",
        hash,
      );
    }
    throw new TxTimeoutError("Transaction was not confirmed in time", hash);
  }
}
