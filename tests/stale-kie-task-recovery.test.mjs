import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { generatePlannedImages as generateResilient, isStaleKieActiveTask, kieActiveTaskStaleMs } from '../worker/lib/image-executor-resilient.js';

function fixture(t, { ageMinutes = 180 } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY); INSERT INTO jobs VALUES (1);');
  for (const file of ['0004_phase2_images.sql', '0026_kie_async_image_tasks.sql', '0027_kie_image_attempt_count.sql', '0028_puter_image_attempted.sql']) {
    db.exec(readFileSync(new URL(`../worker/migrations/${file}`, import.meta.url), 'utf8'));
  }
  db.exec("ALTER TABLE job_images ADD COLUMN hook_text TEXT;");
  db.prepare(`INSERT INTO job_images
    (job_id, role, position, status, prompt, alt_text, provider, provider_task_id, provider_status, provider_attempt_count, created_at, updated_at)
    VALUES (1, 'body', 1, 'planned', 'A clean home repair scene', 'Repair scene', 'kie-ai', 'legacy-paid-task', 'waiting', 1, datetime('now', ?), datetime('now', ?))`)
    .run(`-${ageMinutes} minutes`, `-${ageMinutes} minutes`);
  const env = {
    IMAGE_PROVIDER_MODE: 'auto',
    PUTER_IMAGE_ENABLED: 'true',
    KIE_ACTIVE_TASK_STALE_MS: '1800000',
    IMAGE_PUBLIC_BASE_URL: 'https://images.example.com',
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
  return { env, db, row: () => db.prepare('SELECT * FROM job_images WHERE job_id=1').get() };
}

test('KIE stale timeout defaults to 30 minutes and stays bounded', () => {
  assert.equal(kieActiveTaskStaleMs({}), 30 * 60_000);
  assert.equal(kieActiveTaskStaleMs({ KIE_ACTIVE_TASK_STALE_MS: '1800000' }), 30 * 60_000);
  assert.equal(kieActiveTaskStaleMs({ KIE_ACTIVE_TASK_STALE_MS: '1000' }), 30 * 60_000);
});

test('legacy KIE task older than the stale window is detected before final poll', (t) => {
  const { env, row } = fixture(t, { ageMinutes: 180 });
  assert.equal(isStaleKieActiveTask(row(), env), true);
});

test('fresh KIE task is preserved and only polled', async (t) => {
  const { env, row } = fixture(t, { ageMinutes: 5 });
  const calls = [];
  const result = await generateResilient(env, 1, { callHubFn: async (_, __, payload) => {
    calls.push(payload);
    return { pending: true, provider: 'kie-ai', model: 'z-image', taskId: 'legacy-paid-task', state: 'waiting' };
  } });
  assert.equal(result.pending, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].providerMode, 'kie');
  assert.equal(calls[0].taskId, 'legacy-paid-task');
  assert.equal(row().provider_task_id, 'legacy-paid-task');
});

test('stale KIE task gets one final poll then free fallback without a second paid KIE submission', async (t) => {
  const { env, row } = fixture(t, { ageMinutes: 180 });
  // No runtime Puter token in this fixture, so the safe free fallback is Cloudflare.
  delete env.PUTER_AUTH_TOKEN;
  const calls = [];
  const result = await generateResilient(env, 1, { callHubFn: async (_, __, payload) => {
    calls.push(payload);
    if (payload.providerMode === 'kie') {
      assert.equal(payload.taskId, 'legacy-paid-task');
      return { pending: true, provider: 'kie-ai', model: 'z-image', taskId: 'legacy-paid-task', state: 'waiting' };
    }
    assert.equal(payload.providerMode, 'cloudflare');
    assert.equal(payload.taskId, undefined);
    return { provider: 'cloudflare', model: 'flux', mimeType: 'image/png', imageBase64: btoa('free-fallback-image') };
  } });

  assert.deepEqual(calls.map((call) => call.providerMode), ['kie', 'cloudflare']);
  assert.equal(calls.filter((call) => call.providerMode === 'kie').length, 1);
  assert.equal(result.stored, 1);
  assert.equal(row().status, 'stored');
  assert.equal(row().provider, 'cloudflare');
  assert.equal(row().provider_task_id, null);
});
