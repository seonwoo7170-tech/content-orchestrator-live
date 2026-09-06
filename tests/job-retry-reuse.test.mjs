import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workCards = fs.readFileSync('web/work-cards.js', 'utf8');
const phase6 = fs.readFileSync('worker/phase6-entry.js', 'utf8');
const jobStore = fs.readFileSync('worker/lib/job-store.js', 'utf8');
const serviceWorker = fs.readFileSync('web/sw.js', 'utf8');

test('manual retry reuses the same job instead of creating another queue item', () => {
  const retryStart = workCards.indexOf('async function retryJob');
  const retryEnd = workCards.indexOf('async function showReadableDetail');
  assert.ok(retryStart >= 0 && retryEnd > retryStart);
  const retrySource = workCards.slice(retryStart, retryEnd);
  assert.match(retrySource, /\/api\/jobs\/\$\{jobId\}\/retry/);
  assert.match(retrySource, /\/api\/jobs\/\$\{jobId\}\/run/);
  assert.doesNotMatch(retrySource, /\/api\/jobs\/new/);
  assert.doesNotMatch(retrySource, /\/api\/jobs\/repair-existing/);
  assert.match(retrySource, /같은 큐에서 다시 실행했습니다/);
});

test('retry endpoint is admin-only and resets only failed or review jobs', () => {
  assert.ok(phase6.includes("url.pathname.match(/^\\/api\\/jobs\\/(\\d+)\\/retry$/)"));
  assert.match(phase6, /requireAdminOr401\(request, env\)/);
  assert.match(jobStore, /status IN \('failed', 'needs_review'\)/);
  assert.match(jobStore, /JOB_RETRY_ALREADY_CLAIMED/);
  assert.match(jobStore, /MANUAL_RETRY_REQUIRES_PUBLICATION_REVIEW/);
  assert.match(jobStore, /DUPLICATE_TOPIC_RETRY_NOT_ALLOWED/);
});

test('ordinary retry clears stale artifacts but preserves duplicate-publication safety', () => {
  assert.match(jobStore, /DELETE FROM job_images WHERE job_id = \?/);
  assert.match(jobStore, /result_json = NULL/);
  assert.match(jobStore, /retry_count = 0/);
  assert.match(jobStore, /recovery_state = 'none'/);
  assert.match(jobStore, /\['claimed', 'published'\]/);
  assert.match(jobStore, /Boolean\(publication\.blogger_post_id\)/);
  assert.match(phase6, /IMAGE_BUCKET\.delete/);
});

test('Critic review continuation retry preserves the repaired result and images', () => {
  assert.match(jobStore, /hasContinuationResult/);
  assert.match(jobStore, /last_error_code = 'CRITIC_REVIEW_CONTINUE'/);
  assert.match(jobStore, /preserveResult: preserveContinuation/);
  assert.match(jobStore, /preserveImages: preserveContinuation/);
  assert.match(jobStore, /if \(!preserveContinuation\)/);
  assert.match(phase6, /reset\.preserveImages/);
  assert.match(phase6, /clearedImages: reset\.preserveImages \? 0 : images\.length/);
});

test('PWA cache keeps retry code and live progress in the current versioned build', () => {
  assert.match(serviceWorker, /const CACHE = 'content-orchestrator-v\d+'/);
  assert.match(serviceWorker, /'\.\/work-cards\.js'/);
  assert.match(serviceWorker, /'\.\/work-live-progress\.js'/);
  assert.match(serviceWorker, /'\.\/live-work-progress\.js'/);
});