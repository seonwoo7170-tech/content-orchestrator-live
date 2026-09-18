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

test('the tour/attractions admin proxy catches its own Hub error instead of falling through to the generic handler that truncates the message at the first ":"', () => {
  const fnMatch = phase5.match(/async function tourAttractions\(request, env\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'expected to find the tourAttractions function');
  const fnSource = fnMatch[0];
  assert.match(fnSource, /try \{[\s\S]*await callHub\(env, '\/api\/hub\/tour\/attractions'/);
  assert.match(fnSource, /\} catch \(error\) \{/);
  // The whole point of this local catch is to preserve everything after the first ":" in
  // error.message (e.g. "API_HUB_502:TOUR_API_NETWORK_ERROR"), so it must not reuse the
  // generic fetch()-level catch's `.split(/[:\s]/)[0]` truncation.
  assert.doesNotMatch(fnSource, /\.split\(/);
  assert.match(fnSource, /String\(error\?\.message \|\| 'TOUR_ATTRACTIONS_LOOKUP_FAILED'\)/);
});
