import { ApiClient, normalizeSellSwapPlans } from "../../src/index.js";

async function splitApiComposition(
  api: ApiClient,
  base: string,
  counter: string,
) {
  const response = await api.findPath(
    {
      token_in_address: base,
      token_out_address: counter,
      amount: "100",
      split: true,
    },
    true,
  );
  const plans = normalizeSellSwapPlans(response, base, counter, "100");
  return { plans, candidates: response.split_plans };
}
void splitApiComposition;
