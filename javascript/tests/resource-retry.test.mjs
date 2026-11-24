import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import * as sdk from '../dist/index.js';
const read = name => JSON.parse(readFileSync(new URL('../../testdata/' + name, import.meta.url)));
const fixture = read('split-plans.json');
for (const c of read('resource-retry.json')) test(c.name, async () => {
  const r = fixture.request;
  const plans = c.plans.map(name => sdk.normalizeSwapSplitPlan(fixture.plans[name].response, r.token_in_address, r.token_out_address, r.amount));
  const calls = [], budgets = [], events = [];
  const errors = {
    resource: new sdk.ResourceLimitError('limit'),
    submitted: new sdk.ResourceLimitError('limit', 'already-submitted'),
    other: new sdk.AquariusError('transport'), slippage: new sdk.SlippageError('minimum'),
  };
  const run = () => sdk.prepareSwapWithResourceRetry(plans[0], {
    minimumOutput: c.minimum ?? '1',
    prepare: async plan => {
      const index = calls.length;
      calls.push(plan);
      if (index < c.failures.length) throw errors[c.failures[index]];
      return 'unsigned';
    },
    requote: async budget => { budgets.push(budget); return plans[1]; },
    observe: event => events.push(event),
  });
  if (c.error) await assert.rejects(run, errors[c.error].constructor);
  else {
    const result = await run();
    assert.equal(result.prepared, 'unsigned');
    assert.equal(result.budgetBps, c.budget);
    assert.deepEqual(result.plan, plans.at(-1));
  }
  assert.equal(calls.length, c.prepared);
  assert.deepEqual(budgets, Array(c.queries).fill(5000));
});
