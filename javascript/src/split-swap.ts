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
import { validateProviderFee, type ProviderFeeConfig } from "./client.js";

/**
 * One part of a stage: a chain in the `swap_chained` format and its share.
 * `pools` and `tokens` are display data from the API; the signed call is
 * built only from the validated token addresses, pool indexes, shares and
 * amounts.
 */
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
const U128_MAX = (1n << 128n) - 1n;
const SHARE_DENOMINATOR = 10_000;
const MAX_STAGES = 4;
const MAX_PARTS = 4;
const MAX_HOPS = 4;
const MAX_CHAIN_XDR_LENGTH = 32_768;
// Canonical padded base64; decoders differ on everything else.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// Every error this module raises on purpose; the catch-alls keep its reason.
class SwapError extends Error {}

/** A quote the SDK will not build from; the reason names the failed check. */
function ensure(ok: unknown, reason: string): asserts ok {
  if (!ok)
    throw new SwapError(
      `Invalid swap quote: ${reason}. Please request a new quote.`,
    );
}

/** An argument the SDK will not build with. */
function ensureSwap(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new SwapError(`Invalid swap: ${reason}.`);
}

const malformed = (error: unknown) =>
  error instanceof SwapError
    ? error
    : new SwapError(
        "Invalid swap quote: the plan is malformed. Please request a new quote.",
      );

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isContract = (value: unknown): value is string =>
  typeof value === "string" && StrKey.isValidContract(value);

// A canonical integer from 1 to 2^127 - 1 (a token amount), or undefined.
const parseAmount = (value: unknown): bigint | undefined =>
  typeof value === "string" &&
  /^[1-9]\d*$/.test(value) &&
  BigInt(value) <= MAX_AMOUNT
    ? BigInt(value)
    : undefined;

const quoteAmount = (value: unknown, label: string): bigint => {
  const parsed = parseAmount(value);
  ensure(
    parsed !== undefined,
    `${label} is not an integer from 1 to 2^127 - 1`,
  );
  return parsed;
};

export const sellAmountToRaw = (amount: string, decimals: number): string => {
  ensureSwap(
    Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 38,
    "decimals is not an integer from 0 to 38",
  );
  ensureSwap(
    typeof amount === "string" && /^\d+(?:\.\d+)?$/.test(amount),
    "the amount is not a decimal number",
  );
  const [whole, fraction = ""] = amount.split(".");
  ensureSwap(
    !fraction.slice(decimals).replace(/0/g, ""),
    "the amount has more decimal places than the token",
  );
  const raw = BigInt(
    whole + fraction.slice(0, decimals).padEnd(decimals, "0"),
  ).toString();
  ensureSwap(
    parseAmount(raw) !== undefined,
    "the amount is not an integer from 1 to 2^127 - 1",
  );
  return raw;
};

const contractAddress = (value: xdr.ScVal): string => {
  ensure(value.type === "scvAddress", "a hop token is not an address");
  let address = "";
  try {
    address = Address.fromScVal(value).toString();
  } catch {
    // An address type the SDK cannot print is not a contract either.
  }
  ensure(isContract(address), "a hop token is not a contract");
  return address;
};

const decode = (encoded: string): xdr.ScVal | undefined => {
  try {
    return xdr.ScVal.fromXdr(encoded, "base64");
  } catch {
    return undefined;
  }
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
  ensure(Array.isArray(pools), "pools are not a list");
  ensure(pools.length > 0, "a chain has no hops");
  ensure(pools.length <= MAX_HOPS, `a chain has more than ${MAX_HOPS} hops`);
  ensure(pools.every(isContract), "a pool is not a contract");
  ensure(new Set(pools).size === pools.length, "a chain lists a pool twice");
  ensure(Array.isArray(tokens), "tokens_addresses are not a list");
  ensure(
    tokens.length === pools.length + 1,
    "tokens_addresses do not match the pools",
  );
  ensure(tokens.every(isContract), "a token address is not a contract");
  ensure(tokens[0] === tokenIn, "a chain does not start at its stage input");
  ensure(typeof encoded === "string", "swap_chain_xdr is not a string");
  ensure(
    encoded.length <= MAX_CHAIN_XDR_LENGTH,
    "swap_chain_xdr is too long",
  );
  ensure(BASE64.test(encoded), "swap_chain_xdr is not base64");
  const chain = decode(encoded);
  ensure(chain !== undefined, "swap_chain_xdr does not decode");
  ensure(
    chain.toXdr("base64") === encoded,
    "swap_chain_xdr is not canonical",
  );
  ensure(chain.type === "scvVec", "swap_chain_xdr is not a list of hops");
  const hops = chain.vec ?? [];
  ensure(
    hops.length === pools.length,
    "swap_chain_xdr does not have one hop per pool",
  );
  const usedPools = new Set<string>();
  hops.forEach((hop, index) => {
    const fields = hop.type === "scvVec" ? (hop.vec ?? []) : [];
    ensure(fields.length === 3, "a hop is not a triple");
    const [poolTokens, poolIndex, output] = fields;
    ensure(
      poolTokens.type === "scvVec",
      "a hop's pool tokens are not a list",
    );
    ensure(poolIndex.type === "scvBytes", "a hop's pool index is not bytes");
    const indexBytes = Buffer.from(poolIndex.bytes.toBytes());
    ensure(indexBytes.length === 32, "a hop's pool index is not 32 bytes");
    ensure(
      contractAddress(output) === tokens[index + 1],
      "a hop's output is not the next token of the path",
    );
    const addresses = (poolTokens.vec ?? []).map(contractAddress);
    ensure(
      new Set(addresses).size === addresses.length,
      "a hop's pool tokens repeat",
    );
    ensure(
      addresses.includes(tokens[index]),
      "a hop's pool does not hold its input",
    );
    ensure(
      addresses.includes(tokens[index + 1]),
      "a hop's pool does not hold its output",
    );
    ensure(
      tokens[index] !== tokens[index + 1],
      "a hop's input and output are the same token",
    );
    const poolKey = `${addresses.join(",")}:${indexBytes.toString("hex")}`;
    ensure(!usedPools.has(poolKey), "a chain uses a pool twice");
    usedPools.add(poolKey);
  });
  return [chain, tokens[tokens.length - 1]];
};

// The `stages` argument of `swap_split`, encoded from the readable chains
// after checking them as the router runs them: stage by stage from `tokenIn`,
// all chains of a stage ending in the next stage's input token and the last
// stage in `tokenOut`. Every part's input must be the router's allocation of
// the stage input, and the parts' outputs make the next stage's input, which
// the router adds up in a u128.
const encodeStages = (
  plan: SwapSplitPlan,
  tokenIn: string,
  tokenOut: string,
): xdr.ScVal => {
  try {
    ensure(isContract(tokenIn), "token_in is not a contract");
    ensure(isContract(tokenOut), "token_out is not a contract");
    ensure(tokenIn !== tokenOut, "token_in and token_out are the same");
    let stageAmount = quoteAmount(plan.amountIn, "amount_in");
    let stageToken = tokenIn;
    const { stages } = plan;
    ensure(Array.isArray(stages), "stages are not a list");
    ensure(stages.length > 0, "the plan has no stages");
    ensure(
      stages.length <= MAX_STAGES,
      `the plan has more than ${MAX_STAGES} stages`,
    );
    const encoded = stages.map((parts) => {
      ensure(Array.isArray(parts), "a stage is not a list");
      ensure(parts.length > 0, "a stage has no parts");
      ensure(
        parts.length <= MAX_PARTS,
        `a stage has more than ${MAX_PARTS} parts`,
      );
      let shares = 0;
      let allocated = 0n;
      let output = 0n;
      let stageEnd: string | undefined;
      const values = parts.map((part, index) => {
        ensure(isObject(part), "a part is not an object");
        const share = Number.isInteger(part.share) ? part.share : undefined;
        ensure(
          share !== undefined && share >= 1 && share <= SHARE_DENOMINATOR,
          `a share is not an integer from 1 to ${SHARE_DENOMINATOR}`,
        );
        shares += share;
        // Every part but the last gets floor(stage input * share / 10000);
        // the last part takes the rest.
        const amount =
          index === parts.length - 1
            ? stageAmount - allocated
            : (stageAmount * BigInt(share)) / BigInt(SHARE_DENOMINATOR);
        ensure(
          quoteAmount(part.amountIn, "a part's amount_in") === amount,
          "a part's amount_in is not the router's allocation",
        );
        allocated += amount;
        output += quoteAmount(part.amountOut, "a part's amount_out");
        const [chain, end] = decodeChain(part, stageToken);
        // As in the router, the first chain sets the token the stage ends in.
        stageEnd ??= end;
        ensure(
          end === stageEnd,
          "the chains of a stage end in different tokens",
        );
        return xdr.ScVal.scvVec([chain, xdr.ScVal.scvU32(share)]);
      });
      ensure(
        shares === SHARE_DENOMINATOR,
        `the shares of a stage do not sum to ${SHARE_DENOMINATOR}`,
      );
      ensure(output <= U128_MAX, "a stage's output does not fit in u128");
      stageToken = stageEnd!;
      stageAmount = output;
      return xdr.ScVal.scvVec(values);
    });
    ensure(stageToken === tokenOut, "the last stage does not end at token_out");
    ensure(
      stageAmount === quoteAmount(plan.amountOut, "amount_out"),
      "amount_out is not the output of the last stage",
    );
    return xdr.ScVal.scvVec(encoded);
  } catch (error) {
    throw malformed(error);
  }
};

const copied = (value: unknown) => (Array.isArray(value) ? [...value] : value);

// The response's plan in SDK form; `encodeStages` checks it.
const readPart = (part: FindPathSplitPart) =>
  isObject(part)
    ? {
        share: part.share,
        amountIn: part.amount_in,
        amountOut: part.amount_out,
        swapChainXdr: part.swap_chain_xdr,
        pools: copied(part.pools),
        tokensAddresses: copied(part.tokens_addresses),
        tokens: Array.isArray(part.tokens) ? [...part.tokens] : [],
      }
    : part;

/**
 * The plan of a `findPathSplit` response for the requested exact input.
 * Throws NoRouteError when the API found no route, and an "Invalid swap
 * quote" error naming the failed check when the plan does not match the
 * request or the router's execution of it, or `stages_xdr` is not the
 * encoding of the readable stages.
 */
export const normalizeSwapSplitPlan = (
  response: FindPathSplitResponse,
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
): SwapSplitPlan => {
  if (isObject(response) && response.success === false)
    throw new NoRouteError("No route found.");
  try {
    ensure(isObject(response), "the response is not an object");
    ensure(response.success === true, "success is not true");
    ensure(
      response.amount_in === amountIn,
      "amount_in is not the requested amount",
    );
    const { stages } = response;
    const plan = {
      amountIn,
      amountOut: response.amount_out,
      stages: Array.isArray(stages)
        ? stages.map((parts) =>
            Array.isArray(parts) ? parts.map(readPart) : parts,
          )
        : stages,
    } as SwapSplitPlan;
    // The call is built from the readable chains; the API's encoding of
    // them must be the same bytes.
    ensure(
      encodeStages(plan, tokenIn, tokenOut).toXdr("base64") ===
        response.stages_xdr,
      "stages_xdr is not the encoding of the stages",
    );
    return plan;
  } catch (error) {
    throw malformed(error);
  }
};

export const getSwapMinimum = (
  output: string,
  slippage: string,
  providerFee?: ProviderFeeConfig,
): string => {
  ensureSwap(
    typeof slippage === "string" &&
      slippage.length <= 100 &&
      /^\d+(?:\.\d+)?$/.test(slippage),
    "the slippage is not a decimal percentage",
  );
  const [whole, fraction = ""] = slippage.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const tolerance = BigInt(whole) * scale + BigInt(fraction || "0");
  ensureSwap(tolerance <= 10n * scale, "the slippage is above 10%");
  let quoted = parseAmount(output);
  ensureSwap(
    quoted !== undefined,
    "the output is not an integer from 1 to 2^127 - 1",
  );
  if (providerFee) {
    validateProviderFee(providerFee);
    const denominator = BigInt(providerFee.feeDenominator);
    quoted -=
      (quoted * BigInt(providerFee.feeFraction) + denominator - 1n) /
      denominator;
  }
  return ((quoted * (100n * scale - tolerance)) / (100n * scale)).toString();
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
  /** Optional provider-fee collector; `minimum` bounds its net payout. */
  providerFee?: ProviderFeeConfig;
  /** Legacy trust+swap batching for contracts without automatic trustlines.
   * Omit to authorize `trust` directly under the swap invocation. */
  batch?: string;
  /** Only a verified classic output asset can receive an atomic trust call. */
  trustline?: { assetCode: string; issuer: string; networkPassphrase: string };
}

const assetContract = (
  trustline: NonNullable<BuildSwapSplitOptions["trustline"]>,
) => {
  try {
    return new StellarAsset(trustline.assetCode, trustline.issuer).contractId(
      trustline.networkPassphrase,
    );
  } catch {
    return undefined;
  }
};

/**
 * `router.swap_split` with its authorization: the call with all its
 * arguments and the one input transfer. Checks the plan again before
 * encoding it. Does not simulate, sign or submit.
 */
export function buildSwapSplitOperation(
  options: BuildSwapSplitOptions,
): xdr.Operation {
  const {
    source,
    router,
    tokenIn,
    tokenOut,
    plan,
    minimum,
    providerFee,
    batch,
    trustline,
  } = options;
  ensureSwap(
    typeof source === "string" && StrKey.isValidEd25519PublicKey(source),
    "source is not an account",
  );
  ensureSwap(isContract(router), "router is not a contract");
  if (providerFee) {
    validateProviderFee(providerFee);
    ensureSwap(
      isContract(providerFee.contractId),
      "provider fee collector is not a contract",
    );
    ensureSwap(
      providerFee.recipient === undefined ||
        isContract(providerFee.recipient) ||
        StrKey.isValidEd25519PublicKey(providerFee.recipient),
      "provider fee recipient is not an address",
    );
  }
  const target = providerFee?.contractId ?? router;
  const recipient = providerFee?.recipient ?? source;
  const fn =
    providerFee?.recipient === undefined ? "swap_split" : "swap_split_to";
  const stages = encodeStages(plan, tokenIn, tokenOut);
  ensureSwap(
    typeof minimum === "string" && /^\d+$/.test(minimum),
    "minimum is not a non-negative integer string",
  );
  ensureSwap(BigInt(minimum) <= MAX_AMOUNT, "minimum is above 2^127 - 1");
  const addr = (s: string) => new Address(s).toScVal();
  const args = [
    addr(source),
    ...(providerFee?.recipient === undefined ? [] : [addr(recipient)]),
    stages,
    addr(tokenIn),
    addr(tokenOut),
    nativeToScVal(BigInt(plan.amountIn), { type: "u128" }),
    nativeToScVal(BigInt(minimum), { type: "u128" }),
    ...(providerFee
      ? [nativeToScVal(providerFee.feeFraction, { type: "u32" })]
      : []),
  ];
  const transfer = authorizedInvocation(tokenIn, "transfer", [
    addr(source),
    addr(target),
    nativeToScVal(BigInt(plan.amountIn), { type: "i128" }),
  ]);
  const root = authorizedInvocation(target, fn, args, [transfer]);
  if (trustline === undefined || trustline === null)
    return Operation.invokeContractFunction({
      contract: target,
      function: fn,
      args,
      auth: [sourceAccountEntry(root)],
    });
  if (batch != null) ensureSwap(isContract(batch), "batch is not a contract");
  ensureSwap(
    recipient === source,
    "opening another recipient's trustline requires its authorization",
  );
  ensureSwap(
    isObject(trustline) &&
      [
        trustline.assetCode,
        trustline.issuer,
        trustline.networkPassphrase,
      ].every((value) => typeof value === "string"),
    "trustline is not an asset code, issuer and network passphrase",
  );
  ensureSwap(
    trustline.issuer !== source,
    "the trustline asset is issued by the source",
  );
  ensureSwap(
    assetContract(trustline) === tokenOut,
    "the trustline asset is not token_out",
  );
  const trust = { contractId: tokenOut, fn: "trust", args: [addr(source)] };
  if (batch == null) {
    return Operation.invokeContractFunction({
      contract: target,
      function: fn,
      args,
      auth: [
        sourceAccountEntry(
          authorizedInvocation(target, fn, args, [
            authorizedInvocation(tokenOut, "trust", trust.args),
            transfer,
          ]),
        ),
      ],
    });
  }
  return batchOperation(
    batch,
    source,
    [trust, { contractId: target, fn, args }],
    [authorizedInvocation(tokenOut, "trust", trust.args), root],
    true,
  );
}

/**
 * The total output from the return value of a simulated or executed
 * `swap_split`; with explicit legacy batch mode, from the batch's results.
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
