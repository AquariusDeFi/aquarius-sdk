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
  split_plans?: {
    amount_in: string;
    amount_out: string;
    legs: SplitSwapQuoteLeg[];
  }[];
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
const MAX_SPLIT_PLANS = 3;
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
  const chain = xdr.ScVal.fromXdr(encoded, "base64");
  if (chain.type !== "scvVec" || chain.vec!.length !== pools.length) {
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

export const normalizeSellSwapPlans = (
  quote: SellSwapQuote,
  base: string,
  counter: string,
  amountIn: string,
): SellSwapPlan[] => {
  rawAmount(amountIn);
  if (quote.success !== true || base === counter) throw invalidQuote();
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
  const plans: SellSwapPlan[] = [
    { amountIn, amountOut: baselineAmount, legs: [baseline] },
  ];
  const seen = new Set<string>();
  if (!Array.isArray(quote.split_plans)) return plans;
  // Bound work independently of an API response's size. Malformed optional
  // plans cannot remove the valid legacy route or expand spending.
  for (const candidate of quote.split_plans.slice(0, MAX_SPLIT_PLANS)) {
    try {
      if (
        candidate.amount_in !== amountIn ||
        !Array.isArray(candidate.legs) ||
        candidate.legs.length < 2 ||
        candidate.legs.length > MAX_PARTS
      ) {
        continue;
      }
      const legs = candidate.legs.map((leg) =>
        normalizeLeg(leg, base, counter),
      );
      if (
        legs.reduce((sum, leg) => sum + BigInt(leg.amountIn), 0n) !==
          BigInt(amountIn) ||
        legs.reduce((sum, leg) => sum + BigInt(leg.amountOut), 0n) !==
          rawAmount(candidate.amount_out)
      ) {
        continue;
      }
      const key = JSON.stringify(
        legs.map((leg) => [leg.amountIn, leg.swapChainXdr]),
      );
      if (seen.has(key)) continue;
      seen.add(key);
      plans.push({ amountIn, amountOut: candidate.amount_out, legs });
    } catch {
      // A legacy baseline remains usable when an optional plan is invalid.
    }
  }
  return plans;
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

// Probe the entire ordered transaction, then bind its aggregate output to one
// minimum and simulate that exact bounded transaction before exposing it to UI.
// Only a simulation with the computed minimum is returned for signing.
export const prepareSellSwapPlans = async <Tx>(
  plans: SellSwapPlan[],
  slippage: string,
  simulate: (
    plan: SellSwapPlan,
    minimum: string,
  ) => Promise<{ tx: Tx; outputs: bigint[] }>,
) => {
  type Prepared = {
    tx: Tx;
    plan: SellSwapPlan;
    outputAmount: string;
    minimumOutput: string;
    legOutputs: string[];
  };
  const prepared: Prepared[] = [];
  let baselineError: unknown;
  for (const [index, plan] of plans.entries()) {
    try {
      let result = await simulate(plan, "0");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (result.outputs.length !== plan.legs.length) throw invalidQuote();
        if (result.outputs.some((output) => output < 0n)) throw invalidQuote();
        const outputAmount = result.outputs
          .reduce((sum, value) => sum + value, 0n)
          .toString();
        const minimumOutput = getSwapMinimum(outputAmount, slippage);
        const bounded = await simulate(plan, minimumOutput);
        if (
          bounded.outputs.length === plan.legs.length &&
          bounded.outputs.every((output) => output >= 0n) &&
          bounded.outputs.reduce((sum, value) => sum + value, 0n).toString() ===
            outputAmount
        ) {
          const outputs = bounded.outputs.map(String);
          prepared.push({
            tx: bounded.tx,
            plan: {
              ...plan,
              amountOut: outputAmount,
              legs: plan.legs.map((leg, i) => ({
                ...leg,
                amountOut: outputs[i],
              })),
            },
            outputAmount,
            minimumOutput,
            legOutputs: outputs,
          });
          break;
        }
        result = bounded;
      }
    } catch (error) {
      if (index === 0) baselineError = error;
    }
  }
  prepared.sort((a, b) => {
    const diff = BigInt(b.outputAmount) - BigInt(a.outputAmount);
    return diff === 0n
      ? a.plan.legs.length - b.plan.legs.length
      : diff > 0n
        ? 1
        : -1;
  });
  if (!prepared.length) {
    throw baselineError instanceof Error
      ? baselineError
      : new Error(
          "The swap quote changed or could not be prepared. Please request a new quote.",
        );
  }
  return prepared[0];
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
  if (!trustline)
    return Operation.invokeContractFunction({
      contract,
      function: "swap_chained",
      args,
      auth: [sourceAccountEntry(root)],
    });
  if (
    !batch ||
    !StrKey.isValidContract(batch) ||
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
