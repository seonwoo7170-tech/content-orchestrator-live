import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
const operations = fs.readFileSync(new URL('../worker/lib/daily-operations.js', import.meta.url), 'utf8');
const workload = fs.readFileSync(new URL('../worker/lib/adaptive-workload.js', import.meta.url), 'utf8');
const planStore = fs.readFileSync(new URL('../worker/lib/daily-plan-store.js', import.meta.url), 'utf8');

test('operations API exposes current adaptive workload decisions for today', () => {
  assert.match(index, /listAdaptiveWorkloadDecisions/);
  assert.match(index, /\/api\/operations\/workload\/today/);
  assert.match(index, /workload/);
});

test('daily planning reports user-target policy and zero-work anomaly instead of silently succeeding', () => {
  assert.match(operations, /ensureAdaptiveWorkloadPlan/);
  assert.match(operations, /buildAdaptiveDailySlots/);
  assert.match(operations, /reconcileDailySlotsToWorkload/);
  assert.match(operations, /policySource: 'user-target-workload-v2'/);
  assert.match(operations, /AUTOMATION_ZERO_WORK_ANOMALY/);
  assert.match(operations, /reactivatedSlots/);
});

test('same-day workload decisions refresh and historical attention cannot zero configured daily targets', () => {
  assert.match(workload, /ON CONFLICT\(plan_date, blog_id\) DO UPDATE SET/);
  assert.match(workload, /USER_DAILY_TARGET_PRESERVED/);
  assert.match(workload, /HISTORICAL_ATTENTION_NONBLOCKING/);
  assert.doesNotMatch(workload, /TEMPORARY_SAFETY_PAUSE/);
  assert.doesNotMatch(workload, /existingIds\.has\(blogId\)/);
});

test('only workload-reconciled skipped slots can be safely reactivated', () => {
  assert.match(workload, /last_error_code = 'WORKLOAD_RECONCILED'/);
  assert.match(planStore, /status = 'skipped'.*last_error_code = 'WORKLOAD_RECONCILED'/s);
  assert.match(planStore, /SET status = 'pending'/);
  assert.match(planStore, /reactivated/);
});
