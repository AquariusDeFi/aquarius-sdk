/**
 * @aquariusdefi/sdk — the TypeScript SDK for the Aquarius protocol on Stellar.
 *
 * 0.1.x scope: the swap surface — quote() and execute() in both modes,
 * trustline and friendbot helpers, typed errors, and escape hatches.
 * Pools, liquidity, and rewards arrive in 0.2.
 */

export { Asset, XLM } from "./assets.js";
export {
  AquariusClient,
  type AquariusConfig,
  type Quote,
  type QuoteParams,
  type Receipt,
} from "./client.js";
export type { Signer } from "./signer.js";
export { ApiClient, parseFindPathResponse } from "./api.js";
export type { FindPathRequest, FindPathResponse, ParsedRoute } from "./api.js";
export { NETWORKS, type NetworkConfig } from "./networks.js";
export {
  AquariusError,
  NoRouteError,
  NoTrustlineError,
  PausedError,
  SlippageError,
  TxTimeoutError,
  UserRejectedError,
} from "./errors.js";
