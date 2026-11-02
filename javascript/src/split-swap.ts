import {
  Address,
  Asset as StellarAsset,
  Operation,
  StrKey,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { authorizedInvocation, sourceAccountEntry } from "./authorization.js";
import { batchOperation } from "./batch.js";

export interface SplitSwapQuoteLeg {
  amount_in: string;
  amount_out: string;
  swap_chain_xdr: string;
  pools: string[];
  tokens_addresses: string[];
  tokens?: string[];
}
export interface SellSwapQuote {
  success: boolean;
  amount: string | number;
  swap_chain_xdr: string;
  pools: string[];
  tokens_addresses: string[];
  tokens?: string[];
  split_plan?: {
    amount_in: string;
    amount_out: string;
    legs: SplitSwapQuoteLeg[];
  } | null;
}

export type SellSwapLeg = {
  amountIn: string;
  amountOut: string;
  swapChainXdr: string;
  pools: string[];
  tokensAddresses: string[];
  tokens: string[];
};

export type SellSwapPlan = {
  amountIn: string;
  amountOut: string;
  legs: SellSwapLeg[];
};

const MAX_AMOUNT = (1n << 127n) - 1n;
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

// The route XDR selects token sets, pool indices and outputs. Validate it against
// the displayed token path before it can become spending authorization.
const normalizeLeg = (
  leg: SplitSwapQuoteLeg,
  base: string,
  counter: string,
): SellSwapLeg => {
  rawAmount(leg.amount_in);
  rawAmount(leg.amount_out);
  const { pools, tokens_addresses: tokens, swap_chain_xdr: encoded } = leg;
  if (
    !Array.isArray(pools) ||
    !pools.length ||
    pools.length > MAX_HOPS ||
    pools.some((pool) => !StrKey.isValidContract(pool)) ||
    new Set(pools).size !== pools.length ||
    !Array.isArray(tokens) ||
    tokens.length !== pools.length + 1 ||
    tokens.some((token) => !StrKey.isValidContract(token)) ||
    tokens[0] !== base ||
    tokens[tokens.length - 1] !== counter ||
    typeof encoded !== "string" ||
    encoded.length > 32_768
  ) {
    throw invalidQuote();
  }
  // Base64 decoders differ on padding and stray characters; accept only an
  // encoding that round-trips exactly.
  const chain = xdr.ScVal.fromXdr(encoded, "base64");
  if (
    chain.toXDR("base64") !== encoded ||
    chain.type !== "scvVec" ||
    chain.vec!.length !== pools.length
  ) {
    throw invalidQuote();
  }
  const usedPools = new Set<string>();
  chain.vec!.forEach((hop, index) => {
    if (hop.type !== "scvVec" || hop.vec!.length !== 3) throw invalidQuote();
    const [poolTokens, poolIndex, output] = hop.vec!;
    if (
      poolTokens.type !== "scvVec" ||
      poolIndex.type !== "scvBytes" ||
      poolIndex.bytes!.toBytes().length !== 32 ||
      contractAddress(output) !== tokens[index + 1]
    ) {
      throw invalidQuote();
    }
    const addresses = poolTokens.vec!.map(contractAddress);
    if (
      addresses.length < 2 ||
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
  return {
    amountIn: leg.amount_in,
    amountOut: leg.amount_out,
    swapChainXdr: encoded,
    pools: [...pools],
    tokensAddresses: [...tokens],
    tokens: Array.isArray(leg.tokens) ? [...leg.tokens] : [],
  };
};

const normalizeSplitPlan = (
  plan: NonNullable<SellSwapQuote["split_plan"]>,
  base: string,
  counter: string,
  amountIn: string,
): SellSwapPlan => {
  if (
    plan.amount_in !== amountIn ||
    !Array.isArray(plan.legs) ||
    plan.legs.length < 2 ||
    plan.legs.length > MAX_PARTS
  ) {
    throw invalidQuote();
  }
  const legs = plan.legs.map((leg) => normalizeLeg(leg, base, counter));
  if (
    legs.reduce((sum, leg) => sum + BigInt(leg.amountIn), 0n) !==
      BigInt(amountIn) ||
    legs.reduce((sum, leg) => sum + BigInt(leg.amountOut), 0n) !==
      rawAmount(plan.amount_out)
  ) {
    throw invalidQuote();
  }
  return { amountIn, amountOut: plan.amount_out, legs };
};

const normalizeOrdinaryRoute = (
  quote: SellSwapQuote,
  base: string,
  counter: string,
  amountIn: string,
): SellSwapPlan => {
  // The legacy DRF DecimalField serializes raw integer outputs with 18 zero
  // decimal places. Only that representation is relaxed; allocations stay
  // canonical integer strings and genuinely fractional units are rejected.
  if (
    typeof quote.amount !== "string" ||
    !/^\d+(?:\.0+)?$/.test(quote.amount)
  ) {
    throw invalidQuote();
  }
  const baselineAmount = BigInt(quote.amount.split(".")[0]).toString();
  rawAmount(baselineAmount);
  const baseline = normalizeLeg(
    { ...quote, amount_in: amountIn, amount_out: baselineAmount },
    base,
    counter,
  );
  return { amountIn, amountOut: baselineAmount, legs: [baseline] };
};

export const normalizeSellSwapPlan = (
  quote: SellSwapQuote,
  base: string,
  counter: string,
  amountIn: string,
): SellSwapPlan => {
  try {
    rawAmount(amountIn);
    if (quote.success !== true || base === counter) throw invalidQuote();
    // A backend-selected split is executed as quoted or rejected; a malformed
    // plan never degrades to the ordinary route.
    return quote.split_plan !== undefined && quote.split_plan !== null
      ? normalizeSplitPlan(quote.split_plan, base, counter, amountIn)
      : normalizeOrdinaryRoute(quote, base, counter, amountIn);
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

export interface BuildSellSwapOptions {
  source: string;
  tokenIn: string;
  tokenOut: string;
  router: string;
  splitRouter?: string;
  batch?: string;
  plan: SellSwapPlan;
  minimum: string;
  /** Only a verified classic output asset can receive an atomic trust call. */
  trustline?: { assetCode: string; issuer: string; networkPassphrase: string };
}

/** Build fixed spending authorization. Does not simulate, sign or submit. */
export function buildSellSwapOperation(
  options: BuildSellSwapOptions,
): xdr.Operation {
  const {
    source,
    tokenIn,
    tokenOut,
    router,
    splitRouter,
    batch,
    plan,
    minimum,
    trustline,
  } = options;
  if (
    !StrKey.isValidEd25519PublicKey(source) ||
    !StrKey.isValidContract(router) ||
    tokenIn === tokenOut
  )
    throw invalidQuote();
  rawAmount(plan.amountIn);
  rawAmount(plan.amountOut);
  if (!/^\d+$/.test(minimum) || BigInt(minimum) > MAX_AMOUNT)
    throw invalidQuote();
  if (
    !Array.isArray(plan.legs) ||
    plan.legs.length < 1 ||
    plan.legs.length > MAX_PARTS
  )
    throw invalidQuote();
  const legs = plan.legs.map((leg) =>
    normalizeLeg(
      {
        amount_in: leg.amountIn,
        amount_out: leg.amountOut,
        swap_chain_xdr: leg.swapChainXdr,
        pools: leg.pools,
        tokens_addresses: leg.tokensAddresses,
        tokens: leg.tokens,
      },
      tokenIn,
      tokenOut,
    ),
  );
  if (
    legs.reduce((n, l) => n + BigInt(l.amountIn), 0n) !==
      BigInt(plan.amountIn) ||
    legs.reduce((n, l) => n + BigInt(l.amountOut), 0n) !==
      BigInt(plan.amountOut)
  )
    throw invalidQuote();
  const isSplit = legs.length > 1;
  if (isSplit && (!splitRouter || !StrKey.isValidContract(splitRouter)))
    throw new Error("Split swaps are not configured for this network.");
  const addr = (s: string) => new Address(s).toScVal();
  const uint = (s: string) => nativeToScVal(BigInt(s), { type: "u128" });
  const swaps = legs.map((leg) => {
    const args = [
      addr(source),
      xdr.ScVal.fromXdr(leg.swapChainXdr, "base64"),
      addr(tokenIn),
      uint(leg.amountIn),
      uint(isSplit ? "0" : minimum),
    ];
    const transfer = authorizedInvocation(tokenIn, "transfer", [
      addr(source),
      addr(router),
      nativeToScVal(BigInt(leg.amountIn), { type: "i128" }),
    ]);
    return {
      args,
      root: authorizedInvocation(router, "swap_chained", args, [transfer]),
    };
  });
  const contract = isSplit ? splitRouter! : router;
  const args = isSplit
    ? [
        addr(source),
        xdr.ScVal.scvVec(
          legs.map((l) =>
            xdr.ScVal.scvVec([
              xdr.ScVal.fromXdr(l.swapChainXdr, "base64"),
              uint(l.amountIn),
            ]),
          ),
        ),
        addr(tokenIn),
        addr(tokenOut),
        uint(plan.amountIn),
        uint(minimum),
      ]
    : swaps[0].args;
  const root = isSplit
    ? authorizedInvocation(
        contract,
        "swap_chained",
        args,
        swaps.map((s) => s.root),
      )
    : swaps[0].root;
  if (trustline === undefined || trustline === null)
    return Operation.invokeContractFunction({
      contract,
      function: "swap_chained",
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
    [trust, { contractId: contract, fn: "swap_chained", args }],
    [authorizedInvocation(tokenOut, "trust", trust.args), root],
    true,
  );
}
