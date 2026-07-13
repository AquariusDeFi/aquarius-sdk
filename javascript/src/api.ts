import { NoRouteError } from "./errors.js";

export interface FindPathRequest {
  token_in_address: string;
  token_out_address: string;
  /** Base units (stroops for 7-decimal tokens), as a decimal string. */
  amount: string;
}

export interface FindPathResponse {
  success: boolean;
  swap_chain_xdr: string;
  pools: string[];
  tokens: string[];
  tokens_addresses: string[];
  /** Expected output (find-path) or required input (strict-receive), base units. */
  amount: number | string;
  amount_with_fee: number | string;
}

/** Typed client for the public backend API. */
export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  async findPath(request: FindPathRequest, exactInput: boolean): Promise<FindPathResponse> {
    const endpoint = exactInput ? "/find-path/" : "/find-path-strict-receive/";
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      throw new Error(`Find-path request failed: HTTP ${response.status}`);
    }
    return (await response.json()) as FindPathResponse;
  }
}

export interface ParsedRoute {
  amountIn: bigint;
  amountOut: bigint;
  guard: bigint;
  route: string[];
  swapChainXdr: string;
}

/**
 * @internal Turn a find-path response into quote numbers.
 * Guards: minOut rounds down, maxIn rounds up — never in the caller's favor.
 */
export function parseFindPathResponse(
  response: FindPathResponse,
  params: { amountIn?: bigint; amountOut?: bigint; slippageBps: number; pairLabel: string },
): ParsedRoute {
  if (!response.success) {
    throw new NoRouteError(`No route found for ${params.pairLabel}`);
  }
  const bps = BigInt(params.slippageBps);
  const quoted = BigInt(response.amount);
  if (params.amountIn !== undefined) {
    return {
      amountIn: params.amountIn,
      amountOut: quoted,
      guard: (quoted * (10_000n - bps)) / 10_000n,
      route: response.pools,
      swapChainXdr: response.swap_chain_xdr,
    };
  }
  return {
    amountIn: quoted,
    amountOut: params.amountOut!,
    guard: (quoted * (10_000n + bps) + 9_999n) / 10_000n,
    route: response.pools,
    swapChainXdr: response.swap_chain_xdr,
  };
}
