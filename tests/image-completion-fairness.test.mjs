import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/lib/image-completion.js', import.meta.url), 'utf8');

test('recent failed image jobs rotate behind healthy work but become priority again after cooldown', () => {
  assert.match(source, /AS has_failed_images/);
  assert.match(source, /AS image_activity_at/);
  assert.match(source, /failedRetryCooldownMinutes/);
  assert.match(source, /WHEN has_failed_images = 1 AND image_activity_at <= datetime\('now', \?\) THEN 0/);
  assert.match(source, /WHEN has_failed_images = 0 THEN 1/);
  assert.match(source, /ELSE 2/);
  assert.match(source, /CASE WHEN has_failed_images = 1 THEN image_activity_at ELSE j\.updated_at END/);
});

test('failed image work remains retryable without introducing concurrent image execution', () => {
  assert.match(source, /retryFailed:\s*true/);
  assert.match(source, /maxImages:\s*positiveLimit\(options\.maxImages, 1, 3\)/);
  assert.match(source, /const maxJobs = positiveLimit\(options\.maxJobs, env\?\.IMAGE_COMPLETION_MAX_ITEMS \|\| 1\)/);
  assert.match(source, /Math\.max\(3, Math\.min\(60, Number\(options\.failedRetryCooldownMinutes \?\? 10\)/);
});

test('scheduled image lane stays on one article, polls active KIE work, and cools down only between articles', () => {
  assert.match(source, /SERIAL_IMAGE_POLL_INTERVAL_MS/);
  assert.match(source, /SERIAL_ARTICLE_IMAGE_COOLDOWN_MS/);
  assert.match(source, /completeReadyJobImages\(env, candidate, effective, \{ \.\.\.options, maxImages: 1 \}\)/);
  assert.match(source, /if \(Number\(item\?\.pending \|\| 0\) > 0\) \{\s*await sleep\(pollIntervalMs\)/s);
  assert.match(source, /if \(!item\?\.complete\) break/);
  assert.match(source, /await sleep\(articleCooldownMs\)/);
});
