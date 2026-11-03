import { AquariusError, NoRouteError } from "./errors.js";

/** @internal Bound on every HTTP request (matches the Python SDK's 30s) — a dead connection must fail, not hang. */
export const HTTP_TIMEOUT_MS = 30_000;

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
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new AquariusError(`Find-path request failed: HTTP ${response.status}`);
    }
    return (await response.json()) as FindPathResponse;
  }

  /** Indexed metadata for the given pool addresses (type, fee, token labels). */
  async poolsByAddresses(addresses: string[]): Promise<PoolMeta[]> {
    const response = await fetch(`${this.baseUrl}/pools/?address__in=${addresses.join(",")}`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new AquariusError(`Pools request failed: HTTP ${response.status}`);
    }
    const data = (await response.json()) as { results?: PoolMeta[] };
    return data.results ?? [];
  }

  /** Pools where the address holds a position. Empty when it holds none. */
  async userPools(address: string): Promise<PoolMeta[]> {
    const response = await fetch(`${this.baseUrl}/pools/user/${address}/`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new AquariusError(`User pools request failed: HTTP ${response.status}`);
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
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as { detail?: string };
        detail = body.detail ? `: ${body.detail}` : "";
      } catch {
        // The status remains sufficient when the server returns no JSON body.
      }
      throw new AquariusError(`Limit-order draft request failed: HTTP ${response.status}${detail}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async authorizeLimitOrder(
    baseUrl: string,
    orderId: string,
    authorizationXdr: string,
  ): Promise<Record<string, unknown>> {
    if (!/^[0-9a-f]{64}$/i.test(orderId)) throw new AquariusError("Invalid limit-order ID");
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/orders/${orderId}/authorize/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authorization_xdr: authorizationXdr }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as { detail?: string };
        detail = body.detail ? `: ${body.detail}` : "";
      } catch {
        /* Status is sufficient for non-JSON errors. */
      }
      throw new AquariusError(`Limit-order authorization failed: HTTP ${response.status}${detail}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async listLimitOrders(
    baseUrl: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams(params);
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/orders/?${query}`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new AquariusError(`Limit-order list request failed: HTTP ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async getLimitOrder(baseUrl: string, orderId: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/orders/${orderId}/`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new AquariusError(`Limit-order detail request failed: HTTP ${response.status}`);
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
 * Turn a find-path response into quote numbers.
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
