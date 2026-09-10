import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureImageSchema } from '../scripts/ensure-image-schema.mjs';

test('required image migration preserves rows, backfills Puter and is safe to rerun', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec("CREATE TABLE job_images(id INTEGER PRIMARY KEY, provider TEXT); INSERT INTO job_images VALUES(1,'puter'),(2,'kie-ai'); CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP);");
  const query = async (sql, params = []) => db.prepare(sql).all(...params);
  assert.equal((await ensureImageSchema(query)).applied, true);
  assert.equal((await ensureImageSchema(query)).applied, false);
  assert.deepEqual(db.prepare('SELECT puter_attempted FROM job_images ORDER BY id').all().map(row => row.puter_attempted), [1, 0]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM d1_migrations').get().n, 1);
});
