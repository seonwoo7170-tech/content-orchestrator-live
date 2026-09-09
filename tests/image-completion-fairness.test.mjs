import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/lib/image-completion.js', import.meta.url), 'utf8');

test('active provider tasks win first and rotate by oldest provider check before failed and healthy work', () => {
  assert.match(source, /AS has_active_provider_task/);
  assert.match(source, /AS active_provider_checked_at/);
  assert.match(source, /AS has_failed_images/);
  assert.match(source, /AS image_activity_at/);
  assert.match(source, /failedRetryCooldownMinutes/);
  assert.match(source, /WHEN has_active_provider_task = 1 THEN 0/);
  assert.match(source, /WHEN has_failed_images = 1 AND image_activity_at <= datetime\('now', \?\) THEN 1/);
  assert.match(source, /WHEN has_failed_images = 0 THEN 2/);
  assert.match(source, /ELSE 3/);
  assert.match(source, /WHEN has_active_provider_task = 1 THEN active_provider_checked_at/);
  assert.match(source, /WHEN has_failed_images = 1 THEN image_activity_at/);
  assert.match(source, /ELSE j\.updated_at/);
});

test('failed image work remains retryable within a bounded article batch', () => {
  assert.match(source, /retryFailed:\s*true/);
  assert.match(source, /maxImages:\s*positiveLimit\(options\.maxImages, 3, 3\)/);
  assert.match(source, /const maxJobs = positiveLimit\(options\.maxJobs, env\?\.IMAGE_COMPLETION_MAX_ITEMS \|\| 1\)/);
  assert.match(source, /Math\.max\(3, Math\.min\(60, Number\(options\.failedRetryCooldownMinutes \?\? 10\)/);
});

test('scheduled image lane polls fresh work quickly but rotates already-active work without head-of-line blocking', () => {
  assert.match(source, /SERIAL_IMAGE_POLL_INTERVAL_MS/);
  assert.match(source, /SERIAL_ARTICLE_IMAGE_COOLDOWN_MS/);
  assert.match(source, /storedBeforeGeneration/);
  assert.match(source, /maxImages:\s*positiveLimit\(options\.maxImages, 1, 3\)/);
  assert.match(source, /const resumedActiveTask = Number\(candidate\?\.has_active_provider_task \|\| 0\) === 1/);
  assert.match(source, /if \(Number\(item\?\.pending \|\| 0\) > 0\) \{/);
  assert.match(source, /AWAITING_KIE_CALLBACK/);
  assert.match(source, /AWAITING_PROVIDER_REPOLL/);
  assert.match(source, /await sleep\(pollIntervalMs\)/);
  assert.match(source, /if \(!item\?\.complete && !rotateIncomplete\) break/);
  assert.match(source, /if \(rotateIncomplete\) continue/);
  assert.match(source, /await sleep\(articleCooldownMs\)/);
});
