import {
  ApiClient,
  normalizeSellSwapPlan,
  type SellSwapPlan,
} from "../../src/index.js";

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
  const plan: SellSwapPlan = normalizeSellSwapPlan(
    response,
    base,
    counter,
    "100",
  );
  return { plan, selected: response.split_plan };
}
void splitApiComposition;
