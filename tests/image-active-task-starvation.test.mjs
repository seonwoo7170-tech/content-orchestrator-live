import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ready image scheduler prioritizes and rotates durable active provider tasks by oldest provider check', async () => {
  const source = await readFile(new URL('../worker/lib/image-completion.js', import.meta.url), 'utf8');
  assert.match(source, /AS has_active_provider_task/);
  assert.match(source, /AS active_provider_checked_at/);
  assert.match(source, /MIN\(COALESCE\(pi\.provider_checked_at, pi\.updated_at\)\)/);
  assert.match(source, /WHEN has_active_provider_task = 1 THEN 0/);
  assert.match(source, /WHEN has_active_provider_task = 1 THEN active_provider_checked_at/);
  assert.match(source, /provider_task_id IS NOT NULL/);
  assert.match(source, /provider_status IN \('waiting', 'queuing', 'generating'/);
});

test('an already-active provider task gets one status refresh and rotates instead of monopolizing the lane', async () => {
  const source = await readFile(new URL('../worker/lib/image-completion.js', import.meta.url), 'utf8');
  assert.match(source, /const resumedActiveTask = Number\(candidate\?\.has_active_provider_task \|\| 0\) === 1/);
  assert.match(source, /if \(resumedActiveTask\) \{/);
  assert.match(source, /AWAITING_PROVIDER_REPOLL/);
  assert.match(source, /rotateIncomplete = true/);
  assert.match(source, /if \(!item\?\.complete && !rotateIncomplete\) break/);
  assert.match(source, /if \(rotateIncomplete\) continue/);
});

test('auto image routing resumes the provider that owns an existing task before any new provider', async () => {
  const source = await readFile(new URL('../worker/lib/image-executor.js', import.meta.url), 'utf8');
  assert.match(source, /providerMode === 'auto' && existingTaskId/);
  assert.match(source, /existingProvider === 'kie' \|\| existingProvider === 'kie-ai'\) providers = \['kie', 'cloudflare'\]/);
  assert.match(source, /existingProvider === 'modelscope'\) providers = \['modelscope', 'kie', 'cloudflare'\]/);
});
