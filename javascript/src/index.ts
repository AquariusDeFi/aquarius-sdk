/**
 * @aquariusdefi/sdk — the TypeScript SDK for the Aquarius protocol on Stellar.
 *
 * Swaps (quote/execute in both modes), pools, liquidity, and rewards,
 * with trustline and friendbot helpers, typed errors, and escape hatches.
 */

export { Asset, XLM } from "./assets.js";
export {
  AquariusClient,
  type AquariusConfig,
  type OnchainLimitOrderParams,
  type Quote,
  type QuoteParams,
  type Receipt,
} from "./client.js";
export type { Signer } from "./signer.js";
export { ApiClient, parseFindPathResponse } from "./api.js";
export type { FindPathRequest, FindPathResponse, ParsedRoute } from "./api.js";
export { NETWORKS, type NetworkConfig } from "./networks.js";
export {
  LimitOrderConfig,
  OnchainLimitOrder,
  buildOnchainPlacementArgs,
  validateOnchainLimitOrderDraft,
  type LimitOrderConfigInput,
  type OnchainLimitOrderActions,
  type OnchainLimitOrderDraftPayload,
  type OnchainLimitOrderReceipt,
  type ValidateOnchainDraftContext,
} from "./limit-orders.js";
export {
  Pool,
  sortTokenIds,
  type ClaimResult,
  type DepositAmounts,
  type DepositResult,
  type PoolType,
  type Position,
  type WithdrawResult,
} from "./pool.js";
export {
  AquariusError,
  NoRouteError,
  NoTrustlineError,
  PausedError,
  SlippageError,
  StaleSimulationError,
  TxTimeoutError,
  UserRejectedError,
} from "./errors.js";
