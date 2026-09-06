import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dailyPlanCoverageComplete } from '../worker/phase5-entry.js';

const phase5 = fs.readFileSync(new URL('../worker/phase5-entry.js', import.meta.url), 'utf8');

test('daily plan coverage is incomplete when any connected blog has no workload decision', () => {
  const blogs = [{ blogId: 'a' }, { blogId: 'b' }, { blogId: 'c' }];
  assert.equal(dailyPlanCoverageComplete(blogs, [{ blogId: 'a' }, { blogId: 'c' }]), false);
});

test('daily plan coverage is complete when every connected blog has a workload decision', () => {
  const blogs = [{ blogId: 'a' }, { blogId: 'b' }];
  assert.equal(dailyPlanCoverageComplete(blogs, [{ blogId: 'b' }, { blogId: 'a' }]), true);
});

test('self healer refreshes the plan after the initial window even when decision coverage is already complete', () => {
  assert.match(phase5, /if \(!hasDailyOperationStarted\(settings, now\)\)/);
  assert.match(phase5, /if \(isDailyOperationDue\(settings, now, 5\)\)/);
  assert.match(phase5, /const coverageBefore = dailyPlanCoverageComplete/);
  assert.match(phase5, /const result = await ensureDailyPlan\(env, blogs, \{ now \}\)/);
  assert.match(phase5, /refreshed: true/);
  assert.doesNotMatch(phase5, /if \(dailyPlanCoverageComplete\(blogs, existing\.decisions\)\) \{[\s\S]*?return/);
});
