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
