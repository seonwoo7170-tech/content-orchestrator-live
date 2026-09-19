import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('serial image lane keeps one global lock but allows three images within one article', () => {
  const scheduler = fs.readFileSync(new URL('../worker/mcp-entry.js', import.meta.url), 'utf8');
  const executor = fs.readFileSync(new URL('../worker/lib/image-executor-resilient.js', import.meta.url), 'utf8');
  assert.match(scheduler, /SERIAL_IMAGE_PARALLEL_MAX, 3, 1, 3/);
  assert.match(scheduler, /acquireRuntimeLock\(env, IMAGE_LANE_LOCK_KEY/);
  assert.match(scheduler, /maxJobs: maxItems, maxImages: parallelMax/);
  assert.doesNotMatch(scheduler, /maxJobs: maxItems, maxImages: 1/);
  assert.match(executor, /Promise\.all\(images\.map/);
  assert.match(executor, /return Math\.min\(3, number\)/);
});
