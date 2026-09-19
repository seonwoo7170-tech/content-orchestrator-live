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

test('the click handler routes retry-images to retryJobImages', () => {
  assert.match(workCards, /\['detail', 'retry-readable', 'preview-readable', 'retry-images'\]/);
  assert.match(workCards, /if \(action === 'retry-images'\) return retryJobImages\(jobId, button\)/);
});
