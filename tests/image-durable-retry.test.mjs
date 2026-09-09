import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { generatePlannedImages, imageExecutionPriority, retryPromptForImage } from '../worker/lib/image-executor.js';
import { generatePlannedImages as generateResilient } from '../worker/lib/image-executor-resilient.js';

function fixture(t, active = false) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY); INSERT INTO jobs VALUES (1);');
  for (const file of ['0004_phase2_images.sql', '0026_kie_async_image_tasks.sql', '0027_kie_image_attempt_count.sql']) {
    db.exec(readFileSync(new URL(`../worker/migrations/${file}`, import.meta.url), 'utf8'));
  }
  db.exec("ALTER TABLE job_images ADD COLUMN hook_text TEXT; INSERT INTO job_images (job_id, role, position, prompt, alt_text) VALUES (1, 'body', 1, 'A plain wooden table', 'Table');");
  if (active) db.exec("UPDATE job_images SET provider='kie-ai', provider_task_id='paid-task', provider_status='generating', provider_attempt_count=1;");
  const env = {
    IMAGE_PROVIDER_MODE: 'kie', IMAGE_PUBLIC_BASE_URL: 'https://images.example.com',
    IMAGE_BUCKET: { async put() {} },
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
  return { env, row: () => db.prepare('SELECT * FROM job_images').get() };
}

test('a transient poll failure retains the paid task and never calls a fallback provider', async (t) => {
  const { env, row } = fixture(t, true);
  env.IMAGE_PROVIDER_MODE = 'auto';
  const calls = [];
  const result = await generatePlannedImages(env, 1, { callHubFn: async (_, __, payload) => {
    calls.push(payload);
    throw new Error('API_HUB_TIMEOUT');
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskId, 'paid-task');
  assert.equal(result.pending, 1);
  assert.equal(row().provider_task_id, 'paid-task');
  assert.equal(row().provider_attempt_count, 1);
  assert.equal(imageExecutionPriority(row()), 0);
});

test('failed KIE submissions consume the retry budget and hand off to Cloudflare', async (t) => {
  const { env, row } = fixture(t);
  const modes = [];
  const callHubFn = async (_, __, payload) => {
    modes.push(payload.providerMode);
    if (payload.providerMode === 'kie') throw new Error('KIE_PROVIDER_ERROR');
    return { provider: 'cloudflare', model: 'flux', mimeType: 'image/png', imageBase64: btoa('image-bytes') };
  };
  for (let n = 0; n < 3; n++) await generateResilient(env, 1, { callHubFn });
  assert.equal(row().provider_attempt_count, 3);
  const result = await generateResilient(env, 1, { callHubFn });
  assert.deepEqual(modes, ['kie', 'kie', 'kie', 'cloudflare']);
  assert.equal(result.stored, 1);
});

test('terminal task failure retires its ID without counting the same task twice', async (t) => {
  const { env, row } = fixture(t, true);
  const result = await generatePlannedImages(env, 1, { callHubFn: async () => {
    throw new Error('KIE_PROVIDER_GENERATION_FAILED');
  } });
  assert.equal(result.retrying, 1);
  assert.equal(row().provider_task_id, null);
  assert.equal(row().provider_attempt_count, 1);
});

test('QA rejection survives a persisted retry and still changes the next prompt', async (t) => {
  const { env, row } = fixture(t, true);
  env.KIE_IMAGE_QA_RETRY_MAX = '1';
  await generatePlannedImages(env, 1, { callHubFn: async () => { throw new Error('IMAGE_QA_REJECTED'); } });
  assert.equal(row().error, null);
  assert.match(retryPromptForImage(row()), /KIE_RECOVERY_LEVEL_2/);
});

test('pending result retrieval stays ahead of creating more images', () => {
  for (const provider_status of ['query_retry', 'result_pending', 'result_download_retry']) {
    assert.equal(imageExecutionPriority({ status: 'planned', provider_task_id: 'paid-task', provider_status }), 0);
  }
});
