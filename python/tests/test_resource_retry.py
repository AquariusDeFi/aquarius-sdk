import json
from pathlib import Path

import pytest

from aquarius import (
    AquariusError, ResourceLimitError, SlippageError,
    normalize_swap_split_plan, prepare_swap_with_resource_retry,
)

ROOT = Path(__file__).parents[2] / 'testdata'
FIXTURE = json.loads((ROOT / 'split-plans.json').read_text())
CASES = json.loads((ROOT / 'resource-retry.json').read_text())


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['name'])
def test_resource_retry_policy(case):
    request = FIXTURE['request']
    plans = [normalize_swap_split_plan(FIXTURE['plans'][name]['response'],
             request['token_in_address'], request['token_out_address'], request['amount'])
             for name in case['plans']]
    calls, budgets, events = [], [], []
    errors = {'resource': ResourceLimitError('limit'),
              'submitted': ResourceLimitError('limit', 'already-submitted'),
              'other': AquariusError('transport'), 'slippage': SlippageError('minimum')}

    def prepare(plan):
        index = len(calls)
        calls.append(plan)
        if index < len(case['failures']):
            raise errors[case['failures'][index]]
        return 'unsigned'

    def requote(budget):
        budgets.append(budget)
        return plans[1]

    def run():
        return prepare_swap_with_resource_retry(
            plans[0], prepare=prepare, requote=requote,
            minimum_output=case.get('minimum', '1'), observe=events.append,
        )

    if 'error' in case:
        with pytest.raises(type(errors[case['error']])):
            run()
    else:
        result = run()
        assert result.prepared == 'unsigned'
        assert result.budget_bps == case['budget']
        assert result.plan == plans[-1]
    assert len(calls) == case['prepared']
    assert budgets == [5000] * case['queries']
