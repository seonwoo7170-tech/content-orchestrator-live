import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../worker/entry.js', import.meta.url), 'utf8');

test('manual retry route resets the job without running the long pipeline in the request', () => {
  assert.match(source, /resetStoredJobForManualRetry\(env, jobId\)/);
  assert.match(source, /return json\(\{ accepted: true, \.\.\.result \}, 202\)/);
});

test('manual run route claims synchronously then moves pipeline execution to waitUntil', () => {
  assert.match(source, /claimStoredJobExecution\(env, jobId, initialStatus\)/);
  assert.match(source, /ctx\.waitUntil\(execution\)/);
  assert.match(source, /return json\(\{ accepted: true, ok: true, jobId, status: initialStatus \}, 202\)/);

  const runFunction = source.slice(source.indexOf('async function runManualJob'), source.indexOf('export async function runScheduledDailyPlan'));
  assert.doesNotMatch(runFunction, /await processStoredJob\(/);
});

test('entry intercepts retry and run before delegating to the synchronous legacy app route', () => {
  const retryIndex = source.indexOf("matchManualJobPath(url.pathname, 'retry')");
  const runIndex = source.indexOf("matchManualJobPath(url.pathname, 'run')");
  const delegateIndex = source.indexOf('return app.fetch(request, env, ctx);');
  assert.ok(retryIndex >= 0 && retryIndex < delegateIndex);
  assert.ok(runIndex >= 0 && runIndex < delegateIndex);
});
