/**
 * Provider-fee collectors: deploy, read, and claim partner swap fees.
 *
 * A collector accumulates the provider's cut as plain token balances (the
 * fee is taken from each swap's output token); claims are per token,
 * operator-gated by the contract, and always pay out to the collector's
 * baked-in fee_destination. claimAndSwap converts through the router along
 * a quoted route first, guarded by the quote's minimum.
 */

import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

import { Asset } from "./assets.js";
import { authorizedInvocation, sourceAccountEntry } from "./authorization.js";
import type { ProviderFeeConfig } from "./client.js";
import { AquariusError } from "./errors.js";
import { ConfirmedTx } from "./submit.js";

/** @internal The slice of the client a collector needs. */
export interface CollectorContext {
  passphrase: string;
  readSource(requireSigner?: boolean): string;
  readContract(contractId: string, fn: string, args: xdr.ScVal[]): Promise<xdr.ScVal>;
  submitContract(
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
    auth: xdr.SorobanAuthorizationEntry[],
  ): Promise<ConfirmedTx>;
  quoteSwapChain(
    from: Asset,
    to: Asset,
    amountIn: bigint,
    slippage: number,
  ): Promise<{ swapChainXdr: string; guard: bigint }>;
}

export interface ClaimedFees {
  txHash: string;
  /** Collector balance claimed, in the claimed token. */
  amountIn: bigint;
  /** Paid to fee_destination (equals amountIn for plain claims). */
  amountOut: bigint;
}

/** One deployed provider-fee collector contract. */
export class FeeCollector {
  constructor(
    readonly address: string,
    private readonly ctx: CollectorContext,
  ) {}

  // -- reads (no signer required) --------------------------------------------

  /** Where every claim pays out — fixed at deploy time. */
  async feeDestination(): Promise<string> {
    const value = await this.ctx.readContract(this.address, "get_fee_destination", []);
    return scValToNative(value) as string;
  }

  async router(): Promise<string> {
    const value = await this.ctx.readContract(this.address, "get_router", []);
    return scValToNative(value) as string;
  }

  /** Upper bound for the per-swap feeFraction this collector accepts. */
  async maxFeeFraction(): Promise<number> {
    const value = await this.ctx.readContract(this.address, "get_max_swap_fee_fraction", []);
    return Number(scValToNative(value));
  }

  /** Accrued, unclaimed fees in the given token, in base units. */
  async balance(asset: Asset | string): Promise<bigint> {
    // A token the collector has never held has no balance entry, so its
    // contract fails simulation with `Storage, MissingValue` — semantically
    // an empty balance, not an error.
    try {
      const value = await this.ctx.readContract(this.tokenId(asset), "balance", [
        new Address(this.address).toScVal(),
      ]);
      return scValToNative(value) as bigint;
    } catch (error) {
      if (error instanceof AquariusError && error.message.includes("MissingValue")) {
        return 0n;
      }
      throw error;
    }
  }

  /**
   * A ProviderFeeConfig routing swaps through this collector. The fee is
   * `feeFraction / denominator` of each swap's output: `feeConfig(10)` is
   * 10/10000 = **0.1%**, `feeConfig(30)` is 0.3%. `denominator` must match
   * the value the collector was deployed with — there is no getter, so
   * keep your deploy parameters. With `denominator: 100000`, 0.1% is
   * `feeConfig(100, { denominator: 100000 })`.
   */
  feeConfig(feeFraction: number, options?: { recipient?: string; denominator?: number }): ProviderFeeConfig {
    return {
      contractId: this.address,
      feeFraction,
      feeDenominator: options?.denominator ?? 10_000,
      recipient: options?.recipient,
    };
  }

  // -- writes (the signer must be the collector's operator) ---------------------

  /** Sweep the collector's entire balance of one token to fee_destination. */
  async claim(asset: Asset | string): Promise<ClaimedFees> {
    const args = [
      new Address(this.ctx.readSource(true)).toScVal(),
      new Address(this.tokenId(asset)).toScVal(),
    ];
    const confirmed = await this.submit("claim_fees", args);
    const amount = scValToNative(confirmed.returnValue!) as bigint;
    return { txHash: confirmed.txHash, amountIn: amount, amountOut: amount };
  }

  /**
   * Claim one token, swap it through the router, pay out the output token.
   * Route and minimum-out guard come from a fresh quote for the collector's
   * current balance.
   */
  async claimAndSwap(
    asset: Asset | string,
    to: Asset | string,
    options?: { slippage?: number },
  ): Promise<ClaimedFees> {
    const amount = await this.balance(asset);
    if (amount <= 0n) {
      throw new AquariusError("Nothing to claim: the collector holds none of this token");
    }
    const { swapChainXdr, guard } = await this.ctx.quoteSwapChain(
      this.asAsset(asset),
      this.asAsset(to),
      amount,
      options?.slippage ?? 0.01,
    );
    const args = [
      new Address(this.ctx.readSource(true)).toScVal(),
      xdr.ScVal.fromXDR(swapChainXdr, "base64"),
      new Address(this.tokenId(asset)).toScVal(),
      nativeToScVal(guard, { type: "u128" }),
    ];
    const confirmed = await this.submit("claim_fees_and_swap", args);
    return {
      txHash: confirmed.txHash,
      amountIn: amount,
      amountOut: scValToNative(confirmed.returnValue!) as bigint,
    };
  }

  // -- internals ---------------------------------------------------------------

  private submit(fn: string, args: xdr.ScVal[]): Promise<ConfirmedTx> {
    // Root-only entry: the contract authorizes its own token movements
    // (authorize_as_current_contract), the operator only signs the call.
    return this.ctx.submitContract(this.address, fn, args, [
      sourceAccountEntry(authorizedInvocation(this.address, fn, args)),
    ]);
  }

  private tokenId(asset: Asset | string): string {
    return asset instanceof Asset ? asset.contractId(this.ctx.passphrase) : asset;
  }

  private asAsset(asset: Asset | string): Asset {
    return asset instanceof Asset ? asset : Asset.contract(asset);
  }
}
