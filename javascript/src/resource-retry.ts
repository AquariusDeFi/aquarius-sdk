import { ResourceLimitError, SlippageError } from './errors.js';
import type { SwapSplitPlan } from './split-swap.js';

export type SwapResourceRetryEvent = {
  outcome: 'resource_limit' | 'prepared' | 'quote_failed' | 'unchanged_route' | 'below_minimum';
  budgetBps: 7000 | 5000;
  plan: SwapSplitPlan;
  error?: ResourceLimitError;
};

function routeKey(plan: SwapSplitPlan): string {
  return JSON.stringify([plan.amountIn, plan.stages.map(stage => stage.map(p => [p.share, p.swapChainXdr]))]);
}

/**
 * Prepare a validated 7000-bps quote, then at most one new 5000-bps quote.
 * Callbacks must only prepare, never sign or submit, preserving the original
 * pair/input/minimum. Requote must normalize against the original request.
 * Observers cannot affect execution. Errors with a submitted tx hash never retry.
 */
export async function prepareSwapWithResourceRetry<T>(plan: SwapSplitPlan, options: {
  minimumOutput: string;
  prepare: (plan: SwapSplitPlan) => Promise<T>;
  requote: (budgetBps: 5000) => Promise<SwapSplitPlan>;
  observe?: (event: SwapResourceRetryEvent) => void;
}): Promise<{ prepared: T; plan: SwapSplitPlan; budgetBps: 7000 | 5000 }> {
  const minimum = BigInt(options.minimumOutput);
  if (minimum <= 0n) throw new Error('Swap minimum must be positive.');
  const emit = (event: SwapResourceRetryEvent) => {
    try { options.observe?.(event); } catch { /* Telemetry must not change execution. */ }
  };
  const original = plan;
  for (const budgetBps of [7000, 5000] as const) {
    try {
      const prepared = await options.prepare(plan);
      emit({ outcome: 'prepared', budgetBps, plan });
      return { prepared, plan, budgetBps };
    } catch (error) {
      if (!(error instanceof ResourceLimitError) || error.txHash !== undefined) throw error;
      emit({ outcome: 'resource_limit', budgetBps, plan, error });
      if (budgetBps === 5000) throw error;
      try { plan = await options.requote(5000); }
      catch (quoteError) {
        emit({ outcome: 'quote_failed', budgetBps: 5000, plan: original });
        throw quoteError;
      }
      if (routeKey(plan) === routeKey(original)) {
        emit({ outcome: 'unchanged_route', budgetBps: 5000, plan });
        throw error;
      }
      if (plan.amountIn !== original.amountIn) throw new Error('Fallback changed swap input.');
      if (BigInt(plan.amountOut) < minimum) {
        emit({ outcome: 'below_minimum', budgetBps: 5000, plan });
        throw new SlippageError('Fallback output is below the original minimum.');
      }
    }
  }
  throw new Error('Unreachable resource retry state');
}
