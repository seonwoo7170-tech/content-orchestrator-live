import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resetFailedImageForRetry } from '../worker/lib/image-store.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY); INSERT INTO jobs VALUES (1);');
  for (const file of ['0004_phase2_images.sql', '0026_kie_async_image_tasks.sql', '0027_kie_image_attempt_count.sql', '0028_puter_image_attempted.sql', '0033_thumbnail_hook_baked.sql']) {
    db.exec(readFileSync(new URL(`../worker/migrations/${file}`, import.meta.url), 'utf8'));
  }
  db.exec("ALTER TABLE job_images ADD COLUMN hook_text TEXT; INSERT INTO job_images (job_id, role, position, prompt, alt_text) VALUES (1, 'thumbnail', 0, 'A plain wooden desk', 'Desk');");
  const env = {
    ORCHESTRATOR_DB: {
      prepare(sql) {
        return { bind(...args) {
          const statement = db.prepare(sql);
          return {
            async all() { return { results: statement.all(...args) }; },
            async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; }
          };
        } };
      }
    }
  };
  return { env, db, row: () => db.prepare('SELECT * FROM job_images').get() };
}

test('resetting a permanently-failed image clears its exhausted retry budget back to a fresh, resumable state', async (t) => {
  const { env, db, row } = fixture(t);
  db.exec(`UPDATE job_images SET status='failed', provider='kie-ai', provider_task_id='old-task',
    provider_status='fail', provider_attempt_count=4, provider_error_code='KIE_RETRY_BUDGET_EXHAUSTED',
    provider_error_message='KIE_RETRY_BUDGET_EXHAUSTED', error='KIE_RETRY_BUDGET_EXHAUSTED'`);

  const result = await resetFailedImageForRetry(env, row().id);
  assert.deepEqual(result, { id: row().id, reset: true });

  const reset = row();
  assert.equal(reset.status, 'planned');
  assert.equal(reset.provider_task_id, null);
  assert.equal(reset.provider_status, null);
  assert.equal(reset.provider_attempt_count, 0);
  assert.equal(reset.provider_error_code, null);
  assert.equal(reset.provider_error_message, null);
  assert.equal(reset.error, null);
});

test('resetting an image that is not currently failed is refused instead of silently touching it', async (t) => {
  const { env, db, row } = fixture(t);
  db.exec("UPDATE job_images SET status='attached', provider='kie-ai', provider_status='success'");
  await assert.rejects(() => resetFailedImageForRetry(env, row().id), /IMAGE_NOT_RESETTABLE/);
  assert.equal(row().status, 'attached');
});

test('resetting a non-existent image id is refused', async (t) => {
  const { env } = fixture(t);
  await assert.rejects(() => resetFailedImageForRetry(env, 999999), /IMAGE_NOT_RESETTABLE/);
});
