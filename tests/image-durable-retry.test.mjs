import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { generatePlannedImages, imageExecutionPriority, retryPromptForImage } from '../worker/lib/image-executor.js';
import { generatePlannedImages as generateResilient, isSuccessfulPaidImageCheckpoint } from '../worker/lib/image-executor-resilient.js';
import { handleKieImageCallback } from '../worker/lib/kie-image-callback.js';

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
  return { env, db, row: () => db.prepare('SELECT * FROM job_images').get() };
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

test('successful KIE generated checkpoint reuses the exact paid task and never creates a replacement task', async (t) => {
  const { env, db, row } = fixture(t);
  db.exec("UPDATE job_images SET status='generated', provider='kie-ai', provider_task_id='paid-task', provider_status='success', provider_attempt_count=1, mime_type='image/png'");
  assert.equal(isSuccessfulPaidImageCheckpoint(row()), true);
  const calls = [];
  const result = await generateResilient(env, 1, { callHubFn: async (_, __, payload) => {
    calls.push(payload);
    assert.equal(payload.providerMode, 'kie');
    assert.equal(payload.taskId, 'paid-task');
    return { provider: 'kie-ai', model: 'z-image', mimeType: 'image/png', imageBase64: btoa('same-paid-image') };
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskId, 'paid-task');
  assert.equal(result.stored, 1);
  assert.equal(row().provider_task_id, 'paid-task');
  assert.equal(row().status, 'stored');
});

test('successful KIE checkpoint without task id is protected instead of generating another image', async (t) => {
  const { env, db, row } = fixture(t);
  db.exec("UPDATE job_images SET status='generated', provider='kie-ai', provider_task_id=NULL, provider_status='success', provider_attempt_count=3, mime_type='image/png'");
  let calls = 0;
  const result = await generateResilient(env, 1, { callHubFn: async () => {
    calls++;
    throw new Error('PROVIDER_MUST_NOT_BE_CALLED');
  } });
  assert.equal(calls, 0);
  assert.equal(result.pending, 1);
  assert.equal(result.outcomes[0].error, 'KIE_SUCCESS_CHECKPOINT_TASK_ID_MISSING_NO_REGEN');
  assert.equal(row().status, 'generated');
  assert.equal(row().provider_status, 'success');
});

test('stored successful image never enters generation again', async (t) => {
  const { env, db, row } = fixture(t);
  db.exec("UPDATE job_images SET status='stored', provider='kie-ai', provider_task_id='paid-task', provider_status='success', storage_key='jobs/1/body-1.png', public_url='https://images.example.com/media/jobs/1/body-1.png'");
  let calls = 0;
  const result = await generateResilient(env, 1, { callHubFn: async () => { calls++; throw new Error('MUST_NOT_CALL_PROVIDER'); } });
  assert.equal(calls, 0);
  assert.equal(result.requested, 0);
  assert.equal(row().status, 'stored');
});

test('final failed KIE submission hands off to Cloudflare in the same invocation', async (t) => {
  const { env, row } = fixture(t);
  const modes = [];
  const callHubFn = async (_, __, payload) => {
    modes.push(payload.providerMode);
    if (payload.providerMode === 'kie') throw new Error('KIE_PROVIDER_ERROR');
    return { provider: 'cloudflare', model: 'flux', mimeType: 'image/png', imageBase64: btoa('image-bytes') };
  };
  let result;
  for (let n = 0; n < 3; n++) result = await generateResilient(env, 1, { callHubFn });
  assert.equal(row().provider_attempt_count, 3);
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

test('polling mode ignores callbacks without touching the database', async () => {
  const response = await handleKieImageCallback(new Request('https://example.com/callback', {
    method: 'POST', body: JSON.stringify({ data: { taskId: 'paid-task' } })
  }), { KIE_IMAGE_CALLBACK_ENABLED: 'false' }, {});
  const result = await response.json();
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'CALLBACK_DISABLED_POLLING_ACTIVE');
});

test('three parallel submissions persist a distinct task for each image', async (t) => {
  const { env, db } = fixture(t);
  db.exec("INSERT INTO job_images (job_id, role, position, prompt, alt_text) VALUES (1, 'body', 2, 'Second scene', 'Second'), (1, 'body', 3, 'Third scene', 'Third');");
  let started = 0;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const timeout = setTimeout(release, 1000);
  t.after(() => clearTimeout(timeout));
  const result = await generateResilient(env, 1, { callHubFn: async (_, __, payload) => {
    started++;
    if (started === 3) release();
    await barrier;
    assert.equal(started, 3, 'all three submissions must start before any completes');
    return { pending: true, provider: 'kie-ai', taskId: `task-${payload.prompt}`, state: 'waiting' };
  } });
  assert.equal(result.pending, 3);
  const rows = db.prepare('SELECT provider_task_id, provider_attempt_count FROM job_images').all();
  assert.equal(new Set(rows.map(row => row.provider_task_id)).size, 3);
  assert.ok(rows.every(row => row.provider_attempt_count === 1));
});
