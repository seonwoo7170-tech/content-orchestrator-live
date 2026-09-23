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
  const codes = source.slice(source.indexOf('const CONTINUATION_RESULT_CODES'), source.indexOf('function hasContinuationResult'));
  assert.match(codes, /'QUALITY_REVIEW_LIMIT_REACHED'/);
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

// CRITIC_SCHEMA_INVALID is the review failing, not the writing. The article, its paid images
// and the prior critic history are all still in result_json, so the retry must resume from
// them. Jobs 217, 223 and 230 each sat on this code on 2026-09-22 with a finished article the
// destructive branch would have thrown away.
test('a critic contract failure keeps its article and images on a manual retry', async () => {
  const source = await readFile(new URL('../worker/lib/job-store.js', import.meta.url), 'utf8');
  const codes = source.slice(source.indexOf('const CONTINUATION_RESULT_CODES'), source.indexOf('function hasContinuationResult'));
  assert.match(codes, /'CRITIC_SCHEMA_INVALID'/);
  // The continuation budget was never spent on a contract failure, so there is nothing to reset.
  assert.match(source, /CONTINUATION_BUDGET_EXHAUSTED_CODES = new Set\(\['QUALITY_REVIEW_LIMIT_REACHED', 'REPAIR_BLOCKED_BY_GUARD'\]\)/);
});

// Resetting retry_count on every continuation multiplied the two budgets: 4 continuations x
// (1 run + 3 transient retries) = 16 full pipeline runs, each a paid writer, critic and repair
// call. Job 230 logged exactly sixteen "first critic" events between 14:55 and 16:56 on
// 2026-09-22 and still ended held.
test('a continuation does not hand the job a fresh transient-retry budget', async () => {
  const source = await readFile(new URL('../worker/lib/job-auto-rescue.js', import.meta.url), 'utf8');
  const branch = source.slice(source.indexOf('async function rescueNeedsReview'), source.indexOf('async function rescueOrphanFailure'));
  assert.doesNotMatch(branch, /retry_count = 0,/);
  assert.match(branch, /recovery_state = 'retry_wait',/);
  // The stale/timeout path still stops at MAX_JOB_RETRIES, which now caps the job as a whole.
  assert.match(source, /if \(retryCount >= MAX_JOB_RETRIES\)/);
});

// 2026-09-22 was spent draining backlogs by hand: every fix that shipped left held jobs that
// only a manual retry could move, and the backlog outlived several fixes. A hold caused by the
// machinery rather than by a verdict about the article now drains itself, so shipping the fix
// is enough. Bounded hard, because retrying into a still-broken pipeline only pays to fail
// again -- and a content verdict is deliberately excluded, since repeating it changes nothing.
test('a machine-fault hold revives itself, a content verdict does not', async () => {
  const source = await readFile(new URL('../worker/lib/job-auto-rescue.js', import.meta.url), 'utf8');
  assert.match(source, /MACHINE_FAULT_HOLD_CODES = new Set\(\['CRITIC_SCHEMA_INVALID', REPAIR_BLOCKED_CODE\]\)/);
  assert.doesNotMatch(source.slice(source.indexOf('MACHINE_FAULT_HOLD_CODES'), source.indexOf('LEGACY_ROUTE_CODES')), /QUALITY_REVIEW_LIMIT_REACHED/);
  assert.match(source, /if \(isMachineFaultHold\(row, now\)\) \{/);
});

test('the self-revival is bounded by a lifetime count, a delay, an article and publication safety', async () => {
  const source = await readFile(new URL('../worker/lib/job-auto-rescue.js', import.meta.url), 'utf8');
  const detector = source.slice(source.indexOf('function isMachineFaultHold'), source.indexOf('async function reviveMachineFaultHold'));
  assert.match(detector, /machineFaultRevivals\(row\) >= MAX_MACHINE_FAULT_REVIVALS/);
  assert.match(detector, /MACHINE_FAULT_REVIVAL_DELAY_MINUTES \* 60_000/);
  assert.match(detector, /hasSavedArticle\(row\)/);
  const reviver = source.slice(source.indexOf('async function reviveMachineFaultHold'), source.indexOf('function isReviewContinuationRetry'));
  assert.match(reviver, /await hasUnsafePublication\(db, jobId\)/);
  // The count is written back, or the same job would revive forever.
  assert.match(reviver, /json_set\(result_json, '\$\.machineFaultRevivals', \?\)/);
  // It re-enters as a continuation, which is the branch that keeps the article and its images.
  assert.match(reviver, /last_error_code = \?,/);
});

// A hold reason is a label, and jobs held before REPAIR_BLOCKED_BY_GUARD existed carry the old
// one. 154, 157, 165 and 216 all read QUALITY_REVIEW_LIMIT_REACHED while their saved result
// says the budget ran out on TARGETED_REPAIR_SCOPE_VIOLATION with the guard rejecting the work
// -- 154 has been cycling since 2026-09-12 on a location the guard now resolves. Deciding by
// the label alone would leave every such job needing a person, which is the whole problem.
test('a guard-exhausted hold is recognised even under the old quality-limit label', async () => {
  const source = await readFile(new URL('../worker/lib/job-auto-rescue.js', import.meta.url), 'utf8');
  assert.match(source, /function guardExhaustedTheBudget\(row\) \{/);
  // Both halves of the evidence are required, so a genuine content verdict does not match.
  assert.match(source, /reviewReason \|\| ''\) !== 'TARGETED_REPAIR_SCOPE_VIOLATION'\) return false;/);
  assert.match(source, /holdReason === 'QUALITY_REVIEW_LIMIT_REACHED' && guardExhaustedTheBudget\(row\)/);
});

// 156, 207 and 213 are the other half: no guard violation at all, the critic simply asking for
// material the article does not have. Reviving those would only repeat the same verdict, so
// the reviewReason half of the test is what keeps them out.
test('a content verdict with no guard violation is still left for a person', async () => {
  const source = await readFile(new URL('../worker/lib/job-auto-rescue.js', import.meta.url), 'utf8');
  const detector = source.slice(source.indexOf('function guardExhaustedTheBudget'), source.indexOf('function machineFaultRevivals'));
  assert.match(detector, /violations\.length > 0;/);
  // STRUCTURAL_REPLAN_REQUIRED and CRITIC_FAILED_AFTER_MAX_TARGETED_REPAIRS are not the
  // reviewReason this looks for, so 156, 207 and 213 never reach the revival path.
  assert.doesNotMatch(detector, /STRUCTURAL_REPLAN_REQUIRED|CRITIC_FAILED_AFTER_MAX_TARGETED_REPAIRS/);
});
