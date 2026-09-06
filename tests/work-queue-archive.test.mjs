import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const store = fs.readFileSync(new URL('../worker/lib/job-store.js', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../worker/migrations/0020_job_queue_archive.sql', import.meta.url), 'utf8');

test('active queue hides completed and archived historical work', () => {
  assert.match(store, /archived_at IS NULL/);
  assert.match(store, /status <> 'completed'/);
  assert.match(store, /updated_at < datetime\('now', '-1 day'\)/);
});

test('completed jobs automatically leave the active queue without deleting history', () => {
  assert.match(store, /archived_at = CASE WHEN \? = 'completed' THEN datetime\('now'\) ELSE archived_at END/);
  assert.doesNotMatch(store, /DELETE FROM jobs/);
});

test('historical cleanup archives completed, stale attention items and retry duplicates', () => {
  assert.match(migration, /ALTER TABLE jobs ADD COLUMN archived_at TEXT/);
  assert.match(migration, /status = 'completed'/);
  assert.match(migration, /status IN \('failed', 'needs_review'\)/);
  assert.match(migration, /newer\.id > jobs\.id/);
  assert.doesNotMatch(migration, /DELETE FROM jobs/);
});

test('manual retry cannot revive archived queue history', () => {
  assert.match(store, /JOB_ARCHIVED/);
  assert.match(store, /archived_at IS NULL AND status IN \('failed', 'needs_review'\)/);
});
