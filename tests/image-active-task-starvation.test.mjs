import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('ready image scheduler prioritizes durable active provider tasks ahead of failed backlog', async () => {
  const source = await readFile(new URL('../worker/lib/image-completion.js', import.meta.url), 'utf8');
  assert.match(source, /AS has_active_provider_task/);
  assert.match(source, /WHEN has_active_provider_task = 1 THEN 0/);
  assert.match(source, /provider_task_id IS NOT NULL/);
  assert.match(source, /provider_status IN \('waiting', 'queuing', 'generating'/);
});

test('auto image routing resumes the provider that owns an existing task before any new provider', async () => {
  const source = await readFile(new URL('../worker/lib/image-executor.js', import.meta.url), 'utf8');
  assert.match(source, /providerMode === 'auto' && existingTaskId/);
  assert.match(source, /existingProvider === 'kie' \|\| existingProvider === 'kie-ai'\) providers = \['kie', 'cloudflare'\]/);
  assert.match(source, /existingProvider === 'modelscope'\) providers = \['modelscope', 'kie', 'cloudflare'\]/);
});
