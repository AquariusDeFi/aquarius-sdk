import { AquariusError, NoRouteError } from "./errors.js";

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

  /** Indexed metadata for the given pool addresses (type, fee, token labels). */
  async poolsByAddresses(addresses: string[]): Promise<PoolMeta[]> {
    const response = await fetch(
      `${this.baseUrl}/pools/?address__in=${addresses.join(",")}`,
    );
    if (!response.ok) {
      throw new Error(`Pools request failed: HTTP ${response.status}`);
    }
    const data = (await response.json()) as { results?: PoolMeta[] };
    return data.results ?? [];
  }

  /** Pools where the address holds a position. Empty when it holds none. */
  async userPools(address: string): Promise<PoolMeta[]> {
    const response = await fetch(`${this.baseUrl}/pools/user/${address}/`);
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new Error(`User pools request failed: HTTP ${response.status}`);
    }
    const data = (await response.json()) as PoolMeta[] | { results?: PoolMeta[] };
    return Array.isArray(data) ? data : (data.results ?? []);
  }

  async createLimitOrderDraft(
    baseUrl: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/drafts/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as { detail?: string };
        detail = body.detail ? `: ${body.detail}` : "";
      } catch {
        // The status remains sufficient when the server returns no JSON body.
      }
      throw new AquariusError(
        `Limit-order draft request failed: HTTP ${response.status}${detail}`,
      );
    }
    return (await response.json()) as Record<string, unknown>;
  }
}

export interface PoolMeta {
  /** The pool hash, hex-encoded (the backend calls it "index"). */
  index: string;
  address: string;
  tokens_addresses: string[];
  tokens_str: string[];
  pool_type: string;
  /** Decimal fraction as a string, for example "0.0030". */
  fee: string;
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
