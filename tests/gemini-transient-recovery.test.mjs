import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyFailureCode, decideJobRecovery } from '../worker/lib/job-recovery.js';

const repairRecoverySource = fs.readFileSync(new URL('../worker/lib/repair-hold-recovery.js', import.meta.url), 'utf8');

test('Gemini transport and capacity failures retry automatically', () => {
  for (const code of [
    'GEMINI_REQUEST_FAILED',
    'GEMINI_TIMEOUT',
    'GEMINI_RATE_LIMITED',
    'GEMINI_UNAVAILABLE',
    'GEMINI_API_FAILED',
    'GEMINI_EMPTY_RESPONSE'
  ]) {
    assert.equal(classifyFailureCode(code).classification, 'transient', code);
    const decision = decideJobRecovery({ error: code, retryCount: 0, now: '2026-09-19T00:00:00.000Z' });
    assert.equal(decision.recoveryState, 'retry_wait', code);
    assert.equal(decision.delayMinutes, 1, code);
  }
});

test('Gemini permanent request, auth, and safety failures remain held', () => {
  for (const code of ['GEMINI_REQUEST_REJECTED', 'GEMINI_AUTH_FAILED', 'GEMINI_BLOCKED']) {
    assert.equal(classifyFailureCode(code).classification, 'held', code);
    assert.equal(decideJobRecovery({ error: code, retryCount: 0 }).recoveryState, 'held', code);
  }
});

test('held existing repairs can reuse a safe full-rewrite candidate at Critic after transient Gemini failure', () => {
  assert.match(repairRecoverySource, /TRANSIENT_GEMINI_HOLD_CODES/);
  assert.match(repairRecoverySource, /safeRepairContinuationResult/);
  assert.match(repairRecoverySource, /full_article_same_post_id/);
  assert.match(repairRecoverySource, /CRITIC_REVIEW_CONTINUE/);
  assert.match(repairRecoverySource, /REPAIR_TRANSIENT_AI_RETRY_RELEASED/);
  assert.match(repairRecoverySource, /safeRepairPublication\(row\)/);
});
