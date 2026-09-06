import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('live work cards expose operational state, gate progress, and Blogger readback', async () => {
  const source = await readFile(new URL('../web/work-live-progress.js', import.meta.url), 'utf8');
  assert.match(source, /RUNNING/);
  assert.match(source, /REVIEW/);
  assert.match(source, /BLOCKED/);
  assert.match(source, /FAILED/);
  assert.match(source, /DONE/);
  assert.match(source, /완료 Gate/);
  assert.match(source, /publicationVerification/);
  assert.match(source, /Blogger Post ID/);
});

test('PWA cache remains explicitly versioned for delivery gate UI updates', async () => {
  const source = await readFile(new URL('../web/sw.js', import.meta.url), 'utf8');
  assert.match(source, /const CACHE = 'content-orchestrator-v\d+'/);
});