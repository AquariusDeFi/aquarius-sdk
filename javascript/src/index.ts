/**
 * @aquariusdefi/sdk — the TypeScript SDK for the Aquarius protocol on Stellar.
 *
 * Swaps (quote/execute in both modes), pools, liquidity, and rewards,
 * with trustline and friendbot helpers, typed errors, and escape hatches.
 */

export { Asset, XLM } from "./assets.js";
export { authorizedInvocation, sourceAccountEntry } from "./authorization.js";
export {
  AquariusClient,
  type AquariusConfig,
  type ClaimKind,
  type CreatePoolParams,
  type CreatePoolResult,
  type IncentivesConfig,
  type PoolCreationFee,
  type ProviderFeeConfig,
  type OnchainLimitOrderParams,
  type Quote,
  type QuoteParams,
  type Receipt,
  type SwapOptions,
} from "./client.js";
export { batchCallScVal, type BatchCall } from "./batch.js";
export type { Signer } from "./signer.js";
export { FeeCollector, type ClaimedFees } from "./collector.js";
export type { CreateLockParams } from "./locker.js";
export {
  DELEGATION_FRACTION_DENOMINATOR,
  type DelegateParams,
  type IceProxy,
  type UndelegateParams,
} from "./delegation.js";
export { ApiClient, parseFindPathResponse } from "./api.js";
export type { FindPathRequest, FindPathResponse, ParsedRoute } from "./api.js";
export { NETWORKS, type NetworkConfig } from "./networks.js";
export {
  LimitOrder,
  LimitOrderConfig,
  LimitOrderRecord,
  OnchainLimitOrder,
  PreparedLimitOrderFill,
  buildOnchainPlacementArgs,
  fillParameters,
  parseLimitOrderRecord,
  routeScValFromSwapChain,
  validateAuthorizationTree,
  validateFillReceipt,
  validateOnchainLimitOrderDraft,
  type LimitOrderConfigInput,
  type LimitOrderFillReceipt,
  type LimitOrderFillResult,
  type LimitOrderPage,
  type LimitOrderStatus,
  type OnchainLimitOrderActions,
  type OnchainLimitOrderDraftPayload,
  type OnchainLimitOrderReceipt,
  type ValidateOnchainDraftContext,
} from "./limit-orders.js";
export {
  ConcentratedDepositEstimate,
  Pool,
  PoolQuote,
  sortTokenIds,
  type ClaimResult,
  type DepositAmounts,
  type DepositResult,
  type Incentive,
  type PoolType,
  type Position,
  type RewardsInfo,
  type ScheduleIncentiveParams,
  type WithdrawClaims,
  type WithdrawResult,
  type WorkingBalance,
} from "./pool.js";
export {
  MAX_TICK,
  MIN_TICK,
  priceAtTick,
  rangeStatus,
  snapTick,
  tickFromPrice,
  tickSpacingForFee,
  type ClaimFeesResult,
  type ConcentratedDepositResult,
  type ConcentratedPosition,
  type ConcentratedWithdrawResult,
  type PositionRangeStatus,
  type PositionValue,
  type RangeStatus,
  type Slot0,
} from "./concentrated.js";
export {
  AquariusError,
  NoRouteError,
  NoTrustlineError,
  PausedError,
  RestoreRequiredError,
  ResourceLimitError,
  SlippageError,
  StaleSimulationError,
  TxTimeoutError,
  UserRejectedError,
} from "./errors.js";
