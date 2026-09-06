import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const phase6 = fs.readFileSync('worker/phase6-entry.js', 'utf8');
const runner = fs.readFileSync('worker/lib/job-recovery-runner.js', 'utf8');
const rescue = fs.readFileSync('worker/lib/job-auto-rescue.js', 'utf8');

test('admin recovery tick waits for bounded recovery work instead of detaching it', () => {
  assert.match(phase6, /\/api\/operations\/recovery-tick/);
  assert.match(phase6, /await requireAdminOr401\(request, env\)/);
  assert.match(phase6, /await runDueJobRecoveries\(env/);
  assert.match(phase6, /maxItems/);
  assert.match(phase6, /staleMinutes/);
  assert.doesNotMatch(phase6.slice(phase6.indexOf('async function recoveryTick'), phase6.indexOf('async function externalOverview')), /waitUntil/);
});

test('recovery runner forwards a caller-selected stale threshold to automatic rescue', () => {
  assert.match(runner, /const staleMinutes = Number\(options\.staleMinutes \?\? 20\)/);
  assert.match(runner, /autoRescueFn\(env, \{ now, limit: 20, staleMinutes \}\)/);
});

test('synchronous recovery preserves duplicate and ambiguous Blogger write holds', () => {
  assert.match(rescue, /DUPLICATE_TOPIC_PUBLICATION_BLOCKED/);
  assert.match(rescue, /BLOGGER_WRITE_OUTCOME_UNKNOWN/);
  assert.match(rescue, /STALE_PUBLICATION_CLAIM/);
  assert.match(rescue, /MANUAL_RETRY_REQUIRES_PUBLICATION_REVIEW/);
  assert.match(rescue, /hasUnsafePublication/);
});
