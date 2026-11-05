import {
  Address,
  Asset as StellarAsset,
  Operation,
  StrKey,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import type { FindPathSplitPart, FindPathSplitResponse } from "./api.js";
import { authorizedInvocation, sourceAccountEntry } from "./authorization.js";
import { batchOperation } from "./batch.js";
import { NoRouteError } from "./errors.js";

/** One part of a stage: a chain in the `swap_chained` format and its share. */
export type SwapSplitPart = {
  /** Basis points of the stage input; the shares of a stage sum to 10000. */
  share: number;
  amountIn: string;
  amountOut: string;
  swapChainXdr: string;
  pools: string[];
  tokensAddresses: string[];
  tokens: string[];
};

/** A validated `swap_split` plan; amounts are raw-unit integer strings. */
export type SwapSplitPlan = {
  amountIn: string;
  amountOut: string;
  stages: SwapSplitPart[][];
};

const MAX_AMOUNT = (1n << 127n) - 1n;
const SHARE_DENOMINATOR = 10_000n;
const MAX_STAGES = 4;
const MAX_PARTS = 4;
const MAX_HOPS = 4;
const invalidQuote = () =>
  new Error("Invalid swap quote. Please request a new quote.");

const rawAmount = (value: string): bigint => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value))
    throw invalidQuote();
  const parsed = BigInt(value);
  if (parsed > MAX_AMOUNT) throw invalidQuote();
  return parsed;
};

export const sellAmountToRaw = (amount: string, decimals: number): string => {
  if (
    !Number.isSafeInteger(decimals) ||
    decimals < 0 ||
    decimals > 38 ||
    !/^\d+(?:\.\d+)?$/.test(amount)
  )
    throw invalidQuote();
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.slice(decimals).replace(/0/g, "")) throw invalidQuote();
  const raw = BigInt(
    whole + fraction.slice(0, decimals).padEnd(decimals, "0"),
  ).toString();
  rawAmount(raw);
  return raw;
};

const contractAddress = (value: xdr.ScVal) => {
  if (value.type !== "scvAddress") throw invalidQuote();
  const address = Address.fromScVal(value).toString();
  if (!StrKey.isValidContract(address)) throw invalidQuote();
  return address;
};

// The route XDR selects token sets, pool indices and outputs. Validate it
// against the displayed token path, which starts at the stage input token,
// before it can become spending authorization. Returns the chain and the
// token it ends in.
const decodeChain = (
  part: SwapSplitPart,
  tokenIn: string,
): [xdr.ScVal, string] => {
  const { pools, tokensAddresses: tokens, swapChainXdr: encoded } = part;
  if (
    !Array.isArray(pools) ||
    !pools.length ||
    pools.length > MAX_HOPS ||
    pools.some((pool) => !StrKey.isValidContract(pool)) ||
    new Set(pools).size !== pools.length ||
    !Array.isArray(tokens) ||
    tokens.length !== pools.length + 1 ||
    tokens.some((token) => !StrKey.isValidContract(token)) ||
    tokens[0] !== tokenIn ||
    typeof encoded !== "string" ||
    encoded.length > 32_768
  ) {
    throw invalidQuote();
  }
  // Base64 decoders differ on padding and stray characters; accept only an
  // encoding that round-trips exactly.
  const chain = xdr.ScVal.fromXdr(encoded, "base64");
  if (
    chain.toXdr("base64") !== encoded ||
    chain.type !== "scvVec" ||
    chain.vec?.length !== pools.length
  ) {
    throw invalidQuote();
  }
  const usedPools = new Set<string>();
  chain.vec!.forEach((hop, index) => {
    if (hop.type !== "scvVec" || hop.vec?.length !== 3) throw invalidQuote();
    const [poolTokens, poolIndex, output] = hop.vec!;
    if (
      poolTokens.type !== "scvVec" ||
      !poolTokens.vec ||
      poolIndex.type !== "scvBytes" ||
      poolIndex.bytes!.toBytes().length !== 32 ||
      contractAddress(output) !== tokens[index + 1]
    ) {
      throw invalidQuote();
    }
    const addresses = poolTokens.vec.map(contractAddress);
    if (
      new Set(addresses).size !== addresses.length ||
      !addresses.includes(tokens[index]) ||
      !addresses.includes(tokens[index + 1]) ||
      tokens[index] === tokens[index + 1]
    ) {
      throw invalidQuote();
    }
    const poolKey = `${addresses.join(",")}:${Buffer.from(poolIndex.bytes!.toBytes()).toString("hex")}`;
    if (usedPools.has(poolKey)) throw invalidQuote();
    usedPools.add(poolKey);
  });
  return [chain, tokens[tokens.length - 1]];
};

// The `stages` argument of `swap_split`, encoded from the readable chains
// after checking them as the router does: stage by stage from `tokenIn`, all
// chains of a stage ending in the next stage's input token and the last stage
// in `tokenOut`. Every part's input must be the router's allocation of the
// stage input, and the parts' outputs make the next stage's input.
const encodeStages = (
  plan: SwapSplitPlan,
  tokenIn: string,
  tokenOut: string,
): xdr.ScVal => {
  try {
    const { stages } = plan;
    if (
      !StrKey.isValidContract(tokenIn) ||
      !StrKey.isValidContract(tokenOut) ||
      tokenIn === tokenOut ||
      !Array.isArray(stages) ||
      !stages.length ||
      stages.length > MAX_STAGES
    ) {
      throw invalidQuote();
    }
    let stageToken = tokenIn;
    let stageAmount = rawAmount(plan.amountIn);
    const encoded = stages.map((parts) => {
      if (!Array.isArray(parts) || !parts.length || parts.length > MAX_PARTS)
        throw invalidQuote();
      let shares = 0n;
      let allocated = 0n;
      let output = 0n;
      let stageEnd: string | undefined;
      const values = parts.map((part, index) => {
        const { share } = part;
        if (!Number.isInteger(share) || share < 1) throw invalidQuote();
        shares += BigInt(share);
        // Every part but the last gets floor(stage input * share / 10000);
        // the last part takes the rest.
        const amount =
          index === parts.length - 1
            ? stageAmount - allocated
            : (stageAmount * BigInt(share)) / SHARE_DENOMINATOR;
        if (rawAmount(part.amountIn) !== amount) throw invalidQuote();
        allocated += amount;
        output += rawAmount(part.amountOut);
        const [chain, end] = decodeChain(part, stageToken);
        if (stageEnd !== undefined && end !== stageEnd) throw invalidQuote();
        stageEnd = end;
        return xdr.ScVal.scvVec([chain, xdr.ScVal.scvU32(share)]);
      });
      if (shares !== SHARE_DENOMINATOR) throw invalidQuote();
      stageToken = stageEnd!;
      stageAmount = output;
      return xdr.ScVal.scvVec(values);
    });
    if (stageToken !== tokenOut || stageAmount !== rawAmount(plan.amountOut))
      throw invalidQuote();
    return xdr.ScVal.scvVec(encoded);
  } catch {
    throw invalidQuote();
  }
};

const list = <T>(value: T[]): T[] => {
  if (!Array.isArray(value)) throw invalidQuote();
  return [...value];
};

const readPart = (part: FindPathSplitPart): SwapSplitPart => ({
  share: part.share,
  amountIn: part.amount_in,
  amountOut: part.amount_out,
  swapChainXdr: part.swap_chain_xdr,
  pools: list(part.pools),
  tokensAddresses: list(part.tokens_addresses),
  tokens: Array.isArray(part.tokens) ? [...part.tokens] : [],
});

/**
 * The plan of a `findPathSplit` response for the requested exact input.
 * Throws NoRouteError when the API found no route, and an "Invalid swap
 * quote" error when the plan does not match the request or the router's
 * execution, or `stages_xdr` is not the encoding of the readable stages.
 */
export const normalizeSwapSplitPlan = (
  response: FindPathSplitResponse,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
): SwapSplitPlan => {
  if (response?.success === false) throw new NoRouteError("No route found.");
  try {
    if (
      response.success !== true ||
      response.amount_in !== amountIn ||
      !Array.isArray(response.stages)
    ) {
      throw invalidQuote();
    }
    const plan: SwapSplitPlan = {
      amountIn,
      amountOut: response.amount_out,
      stages: response.stages.map((parts) => list(parts).map(readPart)),
    };
    // The call is built from the readable chains; the API's encoding of
    // them must be the same bytes.
    if (
      encodeStages(plan, tokenIn, tokenOut).toXdr("base64") !==
      response.stages_xdr
    ) {
      throw invalidQuote();
    }
    return plan;
  } catch {
    throw invalidQuote();
  }
};

export const getSwapMinimum = (output: string, slippage: string): string => {
  if (!/^\d+(?:\.\d+)?$/.test(slippage) || slippage.length > 100)
    throw new Error("Invalid swap slippage.");
  const [whole, fraction = ""] = slippage.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const tolerance = BigInt(whole) * scale + BigInt(fraction || "0");
  if (tolerance > 10n * scale) throw new Error("Invalid swap slippage.");
  return (
    (rawAmount(output) * (100n * scale - tolerance)) /
    (100n * scale)
  ).toString();
};

export interface BuildSwapSplitOptions {
  source: string;
  /** The AMM router, which runs `swap_split`. */
  router: string;
  tokenIn: string;
  tokenOut: string;
  plan: SwapSplitPlan;
  /** The least total output to accept, raw units; see `getSwapMinimum`. */
  minimum: string;
  /** The batch contract; required with `trustline`. */
  batch?: string;
  /** Only a verified classic output asset can receive an atomic trust call. */
  trustline?: { assetCode: string; issuer: string; networkPassphrase: string };
}

/**
 * `router.swap_split` with its authorization: the call with all its
 * arguments and the one input transfer. Checks the plan again before
 * encoding it. Does not simulate, sign or submit.
 */
export function buildSwapSplitOperation(
  options: BuildSwapSplitOptions,
): xdr.Operation {
  const { source, router, tokenIn, tokenOut, plan, minimum, batch, trustline } =
    options;
  if (
    !StrKey.isValidEd25519PublicKey(source) ||
    !StrKey.isValidContract(router)
  )
    throw invalidQuote();
  const stages = encodeStages(plan, tokenIn, tokenOut);
  if (
    typeof minimum !== "string" ||
    !/^\d+$/.test(minimum) ||
    BigInt(minimum) > MAX_AMOUNT
  )
    throw invalidQuote();
  const addr = (s: string) => new Address(s).toScVal();
  const args = [
    addr(source),
    stages,
    addr(tokenIn),
    addr(tokenOut),
    nativeToScVal(BigInt(plan.amountIn), { type: "u128" }),
    nativeToScVal(BigInt(minimum), { type: "u128" }),
  ];
  const transfer = authorizedInvocation(tokenIn, "transfer", [
    addr(source),
    addr(router),
    nativeToScVal(BigInt(plan.amountIn), { type: "i128" }),
  ]);
  const root = authorizedInvocation(router, "swap_split", args, [transfer]);
  if (trustline === undefined || trustline === null)
    return Operation.invokeContractFunction({
      contract: router,
      function: "swap_split",
      args,
      auth: [sourceAccountEntry(root)],
    });
  if (
    !batch ||
    !StrKey.isValidContract(batch) ||
    typeof trustline !== "object" ||
    Array.isArray(trustline) ||
    [trustline.assetCode, trustline.issuer, trustline.networkPassphrase].some(
      (value) => typeof value !== "string",
    ) ||
    trustline.issuer === source ||
    new StellarAsset(trustline.assetCode, trustline.issuer).contractId(
      trustline.networkPassphrase,
    ) !== tokenOut
  )
    throw new Error("This asset does not support automatic trustlines.");
  const trust = { contractId: tokenOut, fn: "trust", args: [addr(source)] };
  return batchOperation(
    batch,
    source,
    [trust, { contractId: router, fn: "swap_split", args }],
    [authorizedInvocation(tokenOut, "trust", trust.args), root],
    true,
  );
}

/**
 * The total output from the return value of a simulated or executed
 * `swap_split`; with a trustline, from the batch's results.
 */
export const getSwapSplitResult = (
  result: xdr.ScVal,
  withTrustline: boolean,
): bigint => {
  const unexpected = () =>
    new Error("Unexpected swap result. Check the transaction in the explorer.");
  let value = result;
  if (withTrustline) {
    // The batch returns one value per call: void for the trust call, then
    // the swap's output.
    if (
      result.type !== "scvVec" ||
      result.vec?.length !== 2 ||
      result.vec[0].type !== "scvVoid"
    )
      throw unexpected();
    value = result.vec[1];
  }
  if (value.type !== "scvU128") throw unexpected();
  return scValToNative(value) as bigint;
};
