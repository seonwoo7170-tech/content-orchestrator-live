import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dedupe = await readFile(new URL('../worker/lib/repair-ready-dedupe.js', import.meta.url), 'utf8');
const phase4 = await readFile(new URL('../worker/phase4-entry.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../worker/migrations/0021_dedupe_ready_repairs.sql', import.meta.url), 'utf8');

test('duplicate unslotted ready repairs keep the newest identity and archive older safe candidates', () => {
  assert.match(dedupe, /ORDER BY j\.blog_id, j\.blogger_post_id, datetime\(j\.updated_at\) DESC, j\.id DESC/);
  assert.match(dedupe, /SUPERSEDED_REPAIR_JOB/);
  assert.match(dedupe, /publicationStatus !== 'scheduled_update'/);
  assert.match(dedupe, /DELETE FROM job_publications/);
});

test('scheduled repair cleanup runs before repair scheduling and has an admin-only manual tick', () => {
  assert.match(phase4, /await cleanupSupersededReadyRepairs\(env\)/);
  assert.match(phase4, /\/api\/operations\/repair-publish-tick/);
  assert.match(phase4, /if \(!await requireAdmin\(request, env\)\)/);
});

test('database migration removes duplicate scheduled updates before enforcing active identity uniqueness', () => {
  assert.match(migration, /ROW_NUMBER\(\) OVER/);
  assert.match(migration, /DELETE FROM job_publications/);
  assert.match(migration, /idx_job_publications_active_repair_identity/);
  assert.match(migration, /status IN \('scheduled_update', 'claimed'\)/);
});
