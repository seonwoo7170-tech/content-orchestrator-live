import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/lib/job-store.js', import.meta.url), 'utf8');

test('a job that failed only at the publish/write layer with a finished READY result is detected', () => {
  assert.match(source, /function hasPublishReadyResult\(row\)/);
  assert.match(source, /!== 'API_HUB_403'\) return false;/);
  assert.match(source, /result\?\.status === 'READY'/);
});

test('manual retry resets a publish-ready job straight to ready instead of queued, and never touches its images', () => {
  assert.match(source, /const preservePublishReady = !preserveContinuation && hasPublishReadyResult\(row\);/);
  assert.match(source, /const preserveImages = preserveContinuation \|\| preservePublishReady;/);
  assert.match(source, /if \(!preserveImages\) \{\s*statements\.push\(db\.prepare\('DELETE FROM job_images WHERE job_id = \?'\)/);
  assert.match(source, /SET status = 'ready',/);
});

test('the publish-ready branch clears the failure fields without wiping result_json', () => {
  const readyBranch = source.slice(source.indexOf("} else if (preservePublishReady) {"), source.indexOf('} else {'));
  assert.match(readyBranch, /SET status = 'ready',/);
  assert.doesNotMatch(readyBranch, /result_json = NULL/);
  assert.match(readyBranch, /last_error_code = NULL,/);
  assert.match(readyBranch, /hold_reason = NULL,/);
});

test('the retry response reports the ready status and preserved images for a publish-ready reset', () => {
  assert.match(source, /status: preservePublishReady \? 'ready' : 'queued',/);
  assert.match(source, /publishReady: preservePublishReady,/);
  assert.match(source, /preserveResult: preserveImages,/);
});

// A job held at QUALITY_REVIEW_LIMIT_REACHED carries the same saved state as one held at
// CRITIC_REVIEW_CONTINUE -- a finished article plus its critic verdict -- so a manual retry must
// take the preserving branch. Leaving the code off that list sent it down the destructive one,
// which nulls result_json and deletes job_images and their R2 objects; jobs 154, 156 and 157
// each hold three paid KIE images.
test('a quality-limit hold keeps its article and images on a manual retry', async () => {
  const source = await readFile(new URL('../worker/lib/job-store.js', import.meta.url), 'utf8');
  assert.match(source, /CONTINUATION_RESULT_CODES = new Set\(\[\s*'CRITIC_REVIEW_CONTINUE',\s*'QUALITY_REVIEW_LIMIT_REACHED',\s*'REPAIR_BLOCKED_BY_GUARD'\s*\]\)/);
  assert.match(source, /if \(!CONTINUATION_RESULT_CODES\.has\(/);
  // The preserving branch is what skips the job_images delete.
  assert.match(source, /const preserveImages = preserveContinuation \|\| preservePublishReady;/);
});

test('a quality-limit retry clears the continuation counter it was held on', async () => {
  const source = await readFile(new URL('../worker/lib/job-store.js', import.meta.url), 'utf8');
  // Without this the job re-queues with continuationAttempt still at the maximum and
  // job-auto-rescue holds it again on the very next tick.
  assert.match(source, /const resetContinuationBudget = preserveContinuation && isQualityLimitHold\(row\);/);
  assert.match(source, /resetContinuationBudget \? "result_json = json_set\(result_json, '\$\.continuationAttempt', 0\)," : ''/);
  // Only a hold that exhausted the budget resets it -- an ordinary continuation keeps its own
  // count. REPAIR_BLOCKED_BY_GUARD is the same exhausted state named for the machine fault that
  // caused it, so it resets too.
  assert.match(source, /function isQualityLimitHold\(row\) \{\s*return CONTINUATION_BUDGET_EXHAUSTED_CODES\.has\(/);
  assert.match(source, /CONTINUATION_BUDGET_EXHAUSTED_CODES = new Set\(\['QUALITY_REVIEW_LIMIT_REACHED', 'REPAIR_BLOCKED_BY_GUARD'\]\)/);
});

// A job that exhausts its budget without a single repair landing did not fail review; the
// machinery failed. On 2026-09-22 jobs 208, 209, 214, 218 and 220 each burned four
// continuations and eight repair calls on TARGETED_REPAIR_TARGET_NOT_FOUND, and every one was
// filed as QUALITY_REVIEW_LIMIT_REACHED -- indistinguishable, in the queue and in the app, from
// an article the critic genuinely could not pass. The evidence (repairApplied false, two guard
// violations) was in result_json the whole time and nobody could see it.
test('a hold caused by the guard rejecting every repair is named for the machine fault', async () => {
  const source = await readFile(new URL('../worker/lib/job-auto-rescue.js', import.meta.url), 'utf8');
  assert.match(source, /const REPAIR_BLOCKED_CODE = 'REPAIR_BLOCKED_BY_GUARD';/);
  assert.match(source, /function repairBlockedByGuard\(row\) \{/);
  // Both conditions matter: no repair landed, and the guard is why.
  assert.match(source, /result\.repairApplied !== false\) return false;/);
  assert.match(source, /return violations\.length > 0;/);
  assert.match(source, /const reason = repairBlockedByGuard\(row\) \? REPAIR_BLOCKED_CODE : 'QUALITY_REVIEW_LIMIT_REACHED';/);
});

// Naming the failure honestly must not change what a retry does to it. Both codes carry the
// same saved state -- a finished article, its critic verdict and its paid images -- so both
// must stay on the preserving branch.
test('renaming the hold does not send its retry down the destructive branch', async () => {
  const store = await readFile(new URL('../worker/lib/job-store.js', import.meta.url), 'utf8');
  const codes = store.slice(store.indexOf('const CONTINUATION_RESULT_CODES'), store.indexOf('function hasContinuationResult'));
  assert.match(codes, /'CRITIC_REVIEW_CONTINUE'/);
  assert.match(codes, /'QUALITY_REVIEW_LIMIT_REACHED'/);
  assert.match(codes, /'REPAIR_BLOCKED_BY_GUARD'/);
});
