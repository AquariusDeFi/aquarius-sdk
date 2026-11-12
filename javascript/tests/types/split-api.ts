import {
  ApiClient,
  buildSwapSplitOperation,
  getSwapMinimum,
  normalizeSwapSplitPlan,
  type FindPathResponse,
  type SwapSplitPlan,
} from "../../src/index.js";

async function splitApiComposition(
  api: ApiClient,
  source: string,
  router: string,
  tokenIn: string,
  tokenOut: string,
) {
  const response = await api.findPathSplit({
    token_in_address: tokenIn,
    token_out_address: tokenOut,
    amount: "100",
    slippage: "0.005",
  });
  const plan: SwapSplitPlan = normalizeSwapSplitPlan(
    response,
    tokenIn,
    tokenOut,
    "100",
  );
  const minimum = getSwapMinimum(plan.amountOut, "0.5");
  return buildSwapSplitOperation({
    source,
    router,
    tokenIn,
    tokenOut,
    plan,
    minimum,
  });
}

async function findPathHasNoSplit(api: ApiClient) {
  const quote: FindPathResponse = await api.findPath(
    // @ts-expect-error find-path has no split option
    { token_in_address: "a", token_out_address: "b", amount: "1", split: true },
    true,
  );
  // @ts-expect-error find-path has no split plan
  return quote.split_plan;
}
void splitApiComposition;
void findPathHasNoSplit;
