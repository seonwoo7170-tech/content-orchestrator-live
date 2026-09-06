import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('async KIE progress uses provider fields without violating legacy job_images status CHECK', async () => {
  const [schema, store] = await Promise.all([
    readFile(new URL('../worker/migrations/0004_phase2_images.sql', import.meta.url), 'utf8'),
    readFile(new URL('../worker/lib/image-store.js', import.meta.url), 'utf8')
  ]);

  assert.match(schema, /status TEXT NOT NULL DEFAULT 'planned' CHECK \(status IN \('planned', 'generated', 'stored', 'attached', 'failed'\)\)/);
  assert.doesNotMatch(store, /SET status = 'generating'/);
  assert.match(store, /SET status = 'planned',[\s\S]*provider_task_id = \?,[\s\S]*provider_status = \?/);
});
