import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdaptiveDailySlots,
  deriveAdaptiveWorkloadDecision,
  failedJobBlocksWork
} from '../worker/lib/adaptive-workload.js';

function effective(overrides = {}) {
  return {
    enabled: true,
    newArticlesEnabled: true,
    repairsEnabled: true,
    newArticlesPerDay: 3,
    repairsPerDay: 2,
    fixedDailyTargets: false,
    operationMode: 'validation',
    ...overrides
  };
}

test('held, review, retry and backlog remain diagnostic but never zero today configured targets', () => {
  for (const signals of [
    { held: 1 },
    { needsReview: 2 },
    { retryWait: 1 },
    { failed: 2 },
    { active: 3 },
    { held: 2, needsReview: 4, failed: 1, active: 5 }
  ]) {
    const decision = deriveAdaptiveWorkloadDecision({
      blog: { blogId: JSON.stringify(signals), name: 'Blog', postsTotal: 100 },
      effective: effective({ operationMode: 'validation', newArticlesPerDay: 2, repairsPerDay: 2 }),
      signals
    });
    assert.equal(decision.priorityLabel, 'validation_target');
    assert.equal(decision.newArticles, 2);
    assert.equal(decision.repairs, 2);
    assert.ok(decision.reasons.includes('HISTORICAL_ATTENTION_NONBLOCKING'));
    assert.ok(decision.reasons.includes('USER_DAILY_TARGET_PRESERVED'));
  }
});

test('user daily targets are preserved across operation modes without a separate fixed-target toggle', () => {
  for (const operationMode of ['growth', 'recovery', 'validation']) {
    const decision = deriveAdaptiveWorkloadDecision({
      blog: { blogId: operationMode, postsTotal: operationMode === 'growth' ? 10 : 1400 },
      effective: effective({ operationMode, fixedDailyTargets: false, newArticlesPerDay: 2, repairsPerDay: 2 }),
      signals: {}
    });
    assert.equal(decision.newArticles, 2);
    assert.equal(decision.repairs, 2);
    assert.ok(decision.reasons.includes('USER_DAILY_TARGET_PRESERVED'));
  }
});

test('recovery mode changes priority but does not silently zero configured new articles', () => {
  const decision = deriveAdaptiveWorkloadDecision({
    blog: { blogId: 'b2', postsTotal: 1400 },
    effective: effective({ operationMode: 'recovery', newArticlesPerDay: 5, repairsPerDay: 2 }),
    signals: { held: 1, needsReview: 3 }
  });
  assert.equal(decision.priorityScore, 82);
  assert.equal(decision.priorityLabel, 'recovery_target');
  assert.equal(decision.newArticles, 5);
  assert.equal(decision.repairs, 2);
  assert.ok(decision.reasons.includes('HISTORICAL_ATTENTION_NONBLOCKING'));
});

test('growth mode preserves configured counts while low-post blogs keep higher priority', () => {
  const young = deriveAdaptiveWorkloadDecision({
    blog: { blogId: 'young', postsTotal: 9 },
    effective: effective({ operationMode: 'growth', newArticlesPerDay: 2, repairsPerDay: 4 }),
    signals: { needsReview: 2 }
  });
  const mature = deriveAdaptiveWorkloadDecision({
    blog: { blogId: 'mature', postsTotal: 100 },
    effective: effective({ operationMode: 'growth', newArticlesPerDay: 2, repairsPerDay: 4 }),
    signals: { held: 1 }
  });
  assert.equal(young.newArticles, 2);
  assert.equal(young.repairs, 4);
  assert.ok(young.priorityScore > mature.priorityScore);
  assert.equal(mature.newArticles, 2);
  assert.equal(mature.repairs, 4);
});

test('empty blog preserves new target but cannot schedule repairs without an existing post', () => {
  const empty = deriveAdaptiveWorkloadDecision({
    blog: { blogId: 'empty', postsTotal: 0 },
    effective: effective({ operationMode: 'growth', newArticlesPerDay: 7, repairsPerDay: 7 }),
    signals: { needsReview: 1 }
  });
  assert.equal(empty.newArticles, 7);
  assert.equal(empty.repairs, 0);
  assert.ok(empty.reasons.includes('REPAIR_TARGET_NOT_APPLICABLE'));

  const validation = deriveAdaptiveWorkloadDecision({
    blog: { blogId: 'validation', postsTotal: 50 },
    effective: effective({ operationMode: 'validation', newArticlesPerDay: 8, repairsPerDay: 8 }),
    signals: {}
  });
  assert.equal(validation.newArticles, 8);
  assert.equal(validation.repairs, 8);
});

test('individual work toggles are authoritative', () => {
  const noNew = deriveAdaptiveWorkloadDecision({
    blog: { blogId: 'no-new', postsTotal: 50 },
    effective: effective({ newArticlesEnabled: false, newArticlesPerDay: 5, repairsPerDay: 2 }),
    signals: { held: 1 }
  });
  assert.equal(noNew.newArticles, 0);
  assert.equal(noNew.repairs, 2);

  const noRepair = deriveAdaptiveWorkloadDecision({
    blog: { blogId: 'no-repair', postsTotal: 50 },
    effective: effective({ repairsEnabled: false, newArticlesPerDay: 3, repairsPerDay: 5 }),
    signals: { needsReview: 1 }
  });
  assert.equal(noRepair.newArticles, 3);
  assert.equal(noRepair.repairs, 0);
});

test('disabled automation produces zero workload even if targets and attention exist', () => {
  const decision = deriveAdaptiveWorkloadDecision({
    blog: { blogId: 'off', postsTotal: 100 },
    effective: effective({ enabled: false }),
    signals: { held: 2, needsReview: 5 }
  });
  assert.equal(decision.priorityScore, 0);
  assert.equal(decision.priorityLabel, 'paused');
  assert.equal(decision.newArticles, 0);
  assert.equal(decision.repairs, 0);
});

test('adaptive slot materialization carries the current priority score', () => {
  const slots = buildAdaptiveDailySlots(
    [{ blogId: 'b1', name: 'Blog One' }],
    '2026-08-31',
    { decisions: [{ blogId: 'b1', priorityScore: 85, newArticles: 2, repairs: 1 }] }
  );
  assert.equal(slots.length, 3);
  assert.deepEqual(slots.map((slot) => slot.priorityScore), [85, 85, 85]);
  assert.equal(slots.filter((slot) => slot.kind === 'new_article').length, 2);
  assert.equal(slots.filter((slot) => slot.kind === 'repair_existing').length, 1);
});

test('stale failed jobs are still classified safely for recovery diagnostics', () => {
  assert.equal(failedJobBlocksWork({ status: 'failed', recovery_state: 'none', updated_at: '2026-08-28 23:10:21' }, '2026-08-31'), false);
  assert.equal(failedJobBlocksWork({ status: 'failed', recovery_state: 'none', updated_at: '2026-08-31 08:10:21' }, '2026-08-31'), true);
});

test('explicit retry or hold state remains classified as recovery attention regardless of age', () => {
  assert.equal(failedJobBlocksWork({ status: 'failed', recovery_state: 'retry_wait', updated_at: '2026-08-28 23:10:21' }, '2026-08-31'), true);
  assert.equal(failedJobBlocksWork({ status: 'failed', recovery_state: 'held', updated_at: '2026-08-28 23:10:21' }, '2026-08-31'), true);
});
