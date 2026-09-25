import {
  Account,
  Operation,
  TimeoutInfinite,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";

import {
  AquariusError,
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

  private readonly simulationAccounts = new Map<string, Promise<Account>>();

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
   * Enforce client-built authorization and assemble a contract transaction.
   * Simulation supplies resources, never authorization. If it reports
   * archived ledger entries, restore them first (one extra signed
   * transaction), then rebuild and simulate again.
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

    if (rpc.Api.isSimulationRestore(simulation)) {
      if (!signer) {
        throw new AquariusError(
          "Ledger entries for this call are archived and need a restore, which requires a signer",
        );
      }
      await this.restore(source, simulation, signer);
      tx = await this.buildTransaction(source, operation());
      simulation = await this.server.simulateTransaction(tx, undefined, "enforce");
    }

    if (rpc.Api.isSimulationError(simulation)) {
      throw classifyContractError(simulation.error) ?? new AquariusError(simulation.error);
    }

    if (rpc.Api.isSimulationRestore(simulation)) {
      throw new AquariusError("Ledger entries are still archived after restoration");
    }
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
      throw new AquariusError("Simulation returned no contract result");
    }

    // Stellar assembly fills an empty operation auth list from result.auth.
    // Supply only client auth, including an intentionally empty list, and
    // retain the original operation byte-for-byte in the prepared envelope.
    const auth = operation().body().invokeHostFunctionOp().auth();
    return rpc.assembleTransaction(tx, {
      ...simulation,
      result: { ...simulation.result, auth },
    }).clearOperations().addOperation(operation()).build();
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
    let tx = this.build(await this.simulationAccount(source), buildOperation());
    let simulation = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationRestore(simulation) && signer) {
      await this.restore(source, simulation, signer);
      tx = this.build(await this.simulationAccount(source), buildOperation());
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
    envelope
      .v1()
      .tx()
      .seqNum(xdr.Int64.fromString((BigInt(account.sequenceNumber()) + 1n).toString()));
    envelope.v1().signatures([]);
    return signTransaction(signer, new Transaction(envelope, this.passphrase), this.passphrase);
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
