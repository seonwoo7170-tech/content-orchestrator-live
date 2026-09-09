import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const entry = fs.readFileSync('worker/mcp-entry.js', 'utf8');
const cards = fs.readFileSync('web/work-cards.js', 'utf8');
const routes = fs.readFileSync('api-hub-v2/src/lib/image-routes.js', 'utf8');
const executor = fs.readFileSync('worker/lib/image-executor.js', 'utf8');
const completion = fs.readFileSync('worker/lib/image-completion.js', 'utf8');
const store = fs.readFileSync('worker/lib/job-store.js', 'utf8');

test('image lane has no fixed wait between images and keeps the safety gap at article boundaries', () => {
  const part = entry.slice(entry.indexOf('async function runSerialImageWatchdog'), entry.indexOf('async function runLegacyMaintenance'));
  assert.match(part, /cooldownMs:\s*0/);
  assert.match(part, /maxJobs:\s*maxItems/);
  assert.doesNotMatch(part, /await sleep\(cooldownMs\)/);
  assert.match(executor, /SERIAL_IMAGE_COOLDOWN_MS \?\? 0/);
  assert.match(executor, /if \(cooldownMs > 0\) await sleep\(cooldownMs\)/);
  assert.match(completion, /SERIAL_ARTICLE_IMAGE_COOLDOWN_MS/);
  assert.match(completion, /completeReadyJobImages\(env, candidate, effective, \{ \.\.\.options, maxImages: 3 \}\)/);
  assert.match(completion, /await sleep\(articleCooldownMs\)/);
});

test('generated images are visible in work detail', () => {
  assert.match(store, /_images:/);
  assert.match(cards, /result-image-gallery/);
  assert.match(cards, /QA 확인 필요/);
});

test('QA keeps rejected preview evidence', () => {
  assert.match(routes, /rejectedImageUrl/);
  assert.match(executor, /preserveRejectedPreview/);
  assert.match(executor, /rejectedPreviewUrl/);
});

test('stored accepted images are attached and persisted incrementally', () => {
  const attachAt = completion.indexOf('const attachableImages');
  const persistAt = completion.indexOf('await persistJobResult', attachAt);
  const incompleteAt = completion.indexOf('if (!verification.ok)', attachAt);
  assert.ok(attachAt >= 0);
  assert.ok(persistAt > attachAt);
  assert.ok(incompleteAt > persistAt, 'partial image progress must persist before incomplete return');
  assert.match(completion, /for \(const image of attachableImages\) await markImageAttached/);
  assert.match(completion, /attachedThisRun/);
});
