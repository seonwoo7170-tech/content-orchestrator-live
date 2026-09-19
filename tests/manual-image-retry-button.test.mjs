import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workCards = fs.readFileSync('web/work-cards.js', 'utf8');

test('a job stuck on "이미지 확인 필요" gets a dedicated image-only retry button', () => {
  assert.match(workCards, /statusText === '이미지 확인 필요' && !actions\.querySelector\('\[data-action="retry-images"\]'\)/);
  assert.match(workCards, /retryImages\.dataset\.action = 'retry-images'/);
  assert.match(workCards, /retryImages\.textContent = '이미지 재시도'/);
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
