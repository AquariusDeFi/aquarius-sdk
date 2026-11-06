"""One resource-only retry of an unsigned swap preparation; search stays in the API."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Generic, TypeVar

from .errors import ResourceLimitError, SlippageError
from .split_swap import SwapSplitPlan

T = TypeVar('T')


@dataclass(frozen=True)
class PreparedSwapWithBudget(Generic[T]):
    prepared: T
    plan: SwapSplitPlan
    budget_bps: int


@dataclass(frozen=True)
class SwapResourceRetryEvent:
    outcome: str
    budget_bps: int
    plan: SwapSplitPlan
    error: ResourceLimitError | None = None


def _route_key(plan: SwapSplitPlan):
    return plan.amount_in, tuple(tuple((p.share, p.swap_chain_xdr) for p in stage) for stage in plan.stages)


def prepare_swap_with_resource_retry(
    plan: SwapSplitPlan, *, minimum_output: str,
    prepare: Callable[[SwapSplitPlan], T], requote: Callable[[int], SwapSplitPlan],
    observe: Callable[[SwapResourceRetryEvent], None] | None = None,
) -> PreparedSwapWithBudget[T]:
    """Prepare a validated 7000-bps quote, then at most one new 5000-bps quote.

    Callbacks must only prepare, never sign or submit. Both must preserve the
    pair/input and original minimum. `requote` must normalize the API response
    against the original request. Observation is best-effort and cannot cause
    a retry. No retry is allowed for an error carrying a submitted tx hash.
    """
    minimum = int(minimum_output)
    if minimum <= 0:
        raise ValueError('Swap minimum must be positive.')

    def emit(outcome, budget, current, error=None):
        if observe is not None:
            try:
                observe(SwapResourceRetryEvent(outcome, budget, current, error))
            except Exception:
                pass  # Telemetry must not change preparation or submission behavior.

    original = plan
    for budget in (7000, 5000):
        try:
            prepared = prepare(plan)
        except ResourceLimitError as error:
            if error.tx_hash is not None:
                raise
            emit('resource_limit', budget, plan, error)
            if budget == 5000:
                raise
            try:
                plan = requote(5000)
            except Exception:
                emit('quote_failed', 5000, original)
                raise
            if _route_key(plan) == _route_key(original):
                emit('unchanged_route', 5000, plan)
                raise error
            if plan.amount_in != original.amount_in:
                raise ValueError('Fallback changed swap input.')
            if int(plan.amount_out) < minimum:
                emit('below_minimum', 5000, plan)
                raise SlippageError('Fallback output is below the original minimum.')
        else:
            emit('prepared', budget, plan)
            return PreparedSwapWithBudget(prepared, plan, budget)
    raise AssertionError('Unreachable resource retry state')
