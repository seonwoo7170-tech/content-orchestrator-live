import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const completion = await readFile(new URL('../worker/lib/image-completion.js', import.meta.url), 'utf8');
const repairUpdater = await readFile(new URL('../worker/lib/auto-repair-updater.js', import.meta.url), 'utf8');
const phase5 = await readFile(new URL('../worker/phase5-entry.js', import.meta.url), 'utf8');

test('image completion covers both new articles and existing-post repairs', () => {
  assert.match(completion, /j\.mode IN \('new_article', 'repair_existing'\)/);
  assert.match(completion, /j\.mode = 'repair_existing'/);
  assert.match(completion, /READY_TO_UPDATE_EXISTING/);
  assert.match(completion, /image-pipeline-v2/);
});

test('repair publication is blocked until the shared image policy is complete', () => {
  assert.match(repairUpdater, /validateImagePolicy\('repair_existing'/);
  assert.match(repairUpdater, /REPAIR_IMAGES_INCOMPLETE/);
  assert.match(repairUpdater, /executeScheduledUpdate\(env, action, settings/);
});

test('admin-safe image diagnostics endpoint is exposed', () => {
  assert.match(phase5, /\/api\/operations\/images\/diagnostics/);
  assert.match(phase5, /listImageDiagnostics/);
});
