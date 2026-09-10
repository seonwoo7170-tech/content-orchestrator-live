import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { listReadyImageCandidates, completeReadyJobImages } from '../worker/lib/image-completion.js';

test('image scheduler selects same-day ISO timestamps and orders mixed UTC formats chronologically', async (t) => {
  assert.equal(typeof completeReadyJobImages, 'function');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY, mode TEXT, blog_id TEXT, result_json TEXT, updated_at TEXT, status TEXT, archived_at TEXT);
    CREATE TABLE daily_plan_slots (job_id INTEGER, plan_date TEXT, kind TEXT, status TEXT);
    CREATE TABLE job_images (job_id INTEGER, status TEXT, updated_at TEXT, provider TEXT, provider_task_id TEXT, provider_status TEXT, provider_checked_at TEXT);`);
  // A fixed SQLite clock makes the mixed-format ordering regression deterministic.
  const insert = db.prepare("INSERT INTO jobs VALUES (?, 'repair_existing', 'blog', '{}', ?, 'ready', NULL)");
  insert.run(105, '2026-09-10T10:00:00.000Z');
  insert.run(106, '2026-09-10 11:00:00');
  insert.run(107, '2026-09-10T13:00:00.000Z');
  for (const [id, checked] of [[105, '2026-09-10T09:00:00.000Z'], [106, '2026-09-10 10:00:00']]) {
    db.prepare("INSERT INTO job_images VALUES (?, 'planned', ?, 'kie-ai', 'task', 'waiting', ?)").run(id, checked, checked);
  }
  const env = { ORCHESTRATOR_DB: { prepare(sql) { return { bind(...args) { return { async all() { return { results: db.prepare(sql.replaceAll("'now'", "'2026-09-10 12:00:00'")).all(...args) }; } }; } }; } } };
  const rows = await listReadyImageCandidates(env, { maxJobs: 10, staleMinutes: 2 });
  assert.deepEqual(rows.map(row => row.job_id), [105, 106]);
});
