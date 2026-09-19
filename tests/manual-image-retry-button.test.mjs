import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workCards = fs.readFileSync('web/work-cards.js', 'utf8');

test('a job stuck on "이미지 확인 필요" gets a dedicated image-only retry button', () => {
  assert.match(workCards, /retryImages\.dataset\.action = 'retry-images'/);
  assert.match(workCards, /retryImages\.textContent = '이미지 재시도'/);
});

test('the retry-images button is synced from applyCardStatus, not the one-time synchronous enhanceCard pass', () => {
  // "이미지 확인 필요" is a derived sub-status only known once the async
  // publication-aware refresh resolves (see publicationAwareStatus/refreshReadyCardState),
  // never at app.js's raw, synchronous initial label ('승인/발행 준비' for status='ready').
  // A gate inside enhanceCard()'s one-time setup would never see that label and the
  // button would never appear -- it must react every time applyCardStatus assigns it.
  const start = workCards.indexOf('function syncRetryImagesButton');
  const end = workCards.indexOf('function applyCardStatus');
  assert.ok(start >= 0 && end > start);
  const helper = workCards.slice(start, end);
  assert.match(helper, /label !== '이미지 확인 필요'/);
  assert.match(helper, /existing\?\.remove\(\)/);

  const applyStart = workCards.indexOf('function applyCardStatus');
  const applyEnd = workCards.indexOf('function applyPublicationStatus');
  assert.ok(applyStart >= 0 && applyEnd > applyStart);
  assert.match(workCards.slice(applyStart, applyEnd), /syncRetryImagesButton\(card, label\)/);

  const enhanceStart = workCards.indexOf('function enhanceCard');
  const enhanceEnd = workCards.indexOf('function enhanceAll');
  assert.ok(enhanceStart >= 0 && enhanceEnd > enhanceStart);
  assert.doesNotMatch(workCards.slice(enhanceStart, enhanceEnd), /retry-images/);
});

test('the image-only retry button calls the images/generate endpoint, never the full job retry/run endpoints', () => {
  const start = workCards.indexOf('async function retryJobImages');
  const end = workCards.indexOf('async function showReadableDetail');
  assert.ok(start >= 0 && end > start);
  const source = workCards.slice(start, end);
  assert.match(source, /\/api\/jobs\/\$\{jobId\}\/images\/generate/);
  assert.match(source, /method: 'POST'/);
  assert.match(source, /retryFailed: true/);
  assert.doesNotMatch(source, /\/api\/jobs\/\$\{jobId\}\/retry/);
  assert.doesNotMatch(source, /\/api\/jobs\/\$\{jobId\}\/run/);
});

test('the retry button resets the KIE retry budget on failed images before regenerating, or generate() would silently no-op', () => {
  // kieRetryAvailable() in image-executor-resilient.js gates on provider_attempt_count,
  // which a bare /images/generate call never clears -- a 'failed' image (budget already
  // exhausted) would immediately re-fail with the same KIE_RETRY_BUDGET_EXHAUSTED without
  // ever calling KIE again unless the button resets that count first.
  const start = workCards.indexOf('async function retryJobImages');
  const end = workCards.indexOf('async function showReadableDetail');
  assert.ok(start >= 0 && end > start);
  const source = workCards.slice(start, end);
  assert.match(source, /adminApi\(`\/api\/jobs\/\$\{jobId\}\/images`\)/);
  assert.match(source, /status === 'failed'/);
  assert.match(source, /adminApi\('\/api\/operations\/images\/reset-failed', \{/);
  assert.match(source, /imageIds: failedImageIds/);
  const resetIndex = source.indexOf('reset-failed');
  const generateIndex = source.indexOf('/images/generate');
  assert.ok(resetIndex >= 0 && generateIndex > resetIndex, 'reset-failed must run before the generate call');
});

test('the click handler routes retry-images to retryJobImages', () => {
  assert.match(workCards, /\['detail', 'retry-readable', 'preview-readable', 'retry-images'\]/);
  assert.match(workCards, /if \(action === 'retry-images'\) return retryJobImages\(jobId, button\)/);
});

// A KIE-budget backlog can span dozens of ready jobs at once (see the production diagnostics
// that found 66 failed images across 42 jobs after retry budgets ran out with nothing
// auto-retrying) -- clicking "이미지 재시도" per job one at a time doesn't scale, so a queue-level
// bulk button reuses the exact same reset-then-generate sequence per job instead of a new,
// unproven bulk code path.
test('the queue has a bulk "전체 이미지 재시도" button wired to a confirm-gated retryAllFailedImages', () => {
  const start = workCards.indexOf('async function retryAllFailedImages');
  const end = workCards.indexOf('async function showReadableDetail');
  assert.ok(start >= 0 && end > start);
  const source = workCards.slice(start, end);
  assert.match(source, /window\.confirm\(/);
  assert.match(source, /adminApi\('\/api\/jobs\?status=ready&limit=100'\)/);
  assert.match(source, /adminApi\(`\/api\/jobs\/\$\{job\.id\}\/images`\)/);
  assert.match(source, /status === 'failed'/);
  assert.match(source, /if \(failedImageIds\.length === 0\) continue/);
  assert.match(source, /adminApi\('\/api\/operations\/images\/reset-failed', \{/);
  assert.match(source, /adminApi\(`\/api\/jobs\/\$\{job\.id\}\/images\/generate`, \{/);
  assert.match(source, /retryFailed: true/);
  const resetIndex = source.indexOf('reset-failed');
  const generateIndex = source.indexOf('/images/generate');
  assert.ok(resetIndex >= 0 && generateIndex > resetIndex, 'reset-failed must run before the generate call');
  assert.match(workCards, /document\.querySelector\('#retry-all-images'\)\?\.addEventListener\('click'/);
});
