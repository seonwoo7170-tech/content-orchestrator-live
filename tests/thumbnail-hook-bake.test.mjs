import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { generatePlannedImages, shouldPreserveImageTask, shouldSendThumbnailHookText } from '../worker/lib/image-executor.js';

class FakeFont {
  constructor(name, options) { this.name = name; this.options = options; this.data = Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer); }
}

function fakePngBytes() {
  const bytes = new Uint8Array(160);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

function fixture(t, { attemptCount = 0, hookBaked = 0, taskId = null } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY); INSERT INTO jobs VALUES (1);');
  for (const file of ['0004_phase2_images.sql', '0026_kie_async_image_tasks.sql', '0027_kie_image_attempt_count.sql', '0028_puter_image_attempted.sql', '0033_thumbnail_hook_baked.sql']) {
    db.exec(readFileSync(new URL(`../worker/migrations/${file}`, import.meta.url), 'utf8'));
  }
  db.exec("ALTER TABLE job_images ADD COLUMN hook_text TEXT;");
  db.prepare(
    `INSERT INTO job_images (job_id, role, position, prompt, alt_text, hook_text, provider_attempt_count, hook_baked, provider_task_id)
     VALUES (1, 'thumbnail', 0, 'A tidy kitchen scene', 'Kitchen', 'Try This First', ?, ?, ?)`
  ).run(attemptCount, hookBaked, taskId);
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

test('shouldSendThumbnailHookText opts a brand-new thumbnail attempt into hook-baking', () => {
  assert.equal(shouldSendThumbnailHookText({ role: 'thumbnail', hook_text: 'Try This First', provider_attempt_count: 0, provider_task_id: null }), true);
});

test('shouldSendThumbnailHookText keeps sending it while an already-baked task is still being polled', () => {
  assert.equal(shouldSendThumbnailHookText({ role: 'thumbnail', hook_text: 'Try This First', hook_baked: 1, provider_attempt_count: 1, provider_task_id: 'task-1' }), true);
});

test('shouldSendThumbnailHookText refuses a retry (attempt_count > 0, never baked, no active task)', () => {
  assert.equal(shouldSendThumbnailHookText({ role: 'thumbnail', hook_text: 'Try This First', hook_baked: 0, provider_attempt_count: 1, provider_task_id: null }), false);
});

test('shouldSendThumbnailHookText never applies to body-role images', () => {
  assert.equal(shouldSendThumbnailHookText({ role: 'body', hook_text: 'Try This First', provider_attempt_count: 0, provider_task_id: null }), false);
});

test('shouldPreserveImageTask treats a hook-text mismatch as a genuine terminal outcome, not a transient one to keep polling', () => {
  assert.equal(shouldPreserveImageTask({ provider_task_id: 'task-1' }, new Error('IMAGE_HOOK_TEXT_MISMATCH')), false);
});

test('a fresh thumbnail attempt sends hookText to the Hub and persists hook_baked once the Hub confirms it baked the hook', async (t) => {
  const { env, row } = fixture(t);
  const seenPayloads = [];
  const result = await generatePlannedImages(env, 1, {
    callHubFn: async (_env, _path, payload) => {
      seenPayloads.push(payload);
      return { pending: true, complete: false, provider: 'kie-ai', model: 'gpt4o-image', taskId: 'task_gpt', state: 'waiting', hookBaked: true };
    }
  });
  assert.equal(seenPayloads[0].hookText, 'Try This First');
  assert.equal(result.pending, 1);
  assert.equal(row().hook_baked, 1);
  assert.equal(row().provider_task_id, 'task_gpt');
});

test('a completed hook-baked thumbnail skips postprocessing entirely and stores the raw gpt4o-image bytes as-is', async (t) => {
  const { env, row } = fixture(t, { attemptCount: 1, hookBaked: 1, taskId: 'task_gpt' });
  let postprocessCalled = false;
  const result = await generatePlannedImages(env, 1, {
    imageResponse: { async create() { postprocessCalled = true; return new Response(fakePngBytes(), { status: 200, headers: { 'content-type': 'image/png' } }); } },
    fontClass: FakeFont,
    callHubFn: async () => ({
      pending: false, complete: true, provider: 'kie-ai', model: 'gpt4o-image',
      taskId: 'task_gpt', mimeType: 'image/png', imageBase64: Buffer.from(fakePngBytes()).toString('base64')
    })
  });
  assert.equal(postprocessCalled, false, 'the HTML-overlay renderer must never run for an already hook-baked image');
  assert.equal(result.stored, 1);
  assert.equal(row().status, 'stored');
  assert.equal(row().hook_baked, 1);
});

test('a completed thumbnail WITHOUT hook_baked still runs the normal HTML-overlay postprocessing (unchanged default behavior)', async (t) => {
  const { env, row } = fixture(t, { attemptCount: 1, hookBaked: 0, taskId: 'task_z' });
  let postprocessCalled = false;
  const result = await generatePlannedImages(env, 1, {
    imageResponse: { async create(html) { postprocessCalled = true; assert.match(html, /Try This First/); return new Response(fakePngBytes(), { status: 200, headers: { 'content-type': 'image/png' } }); } },
    fontClass: FakeFont,
    callHubFn: async () => ({
      pending: false, complete: true, provider: 'kie-ai', model: 'z-image',
      taskId: 'task_z', mimeType: 'image/png', imageBase64: Buffer.from(fakePngBytes()).toString('base64')
    })
  });
  assert.equal(postprocessCalled, true);
  assert.equal(result.stored, 1);
  assert.equal(row().status, 'stored');
});

test('a hook-text-mismatch failure clears the task and resets hook_baked so the next attempt falls back to the standard flow', async (t) => {
  const { env, row } = fixture(t, { attemptCount: 1, hookBaked: 1, taskId: 'task_gpt' });
  const result = await generatePlannedImages(env, 1, {
    callHubFn: async () => { throw new Error('IMAGE_HOOK_TEXT_MISMATCH'); }
  });
  assert.equal(result.retrying, 1);
  assert.equal(row().status, 'planned');
  assert.equal(row().provider_task_id, null);
  assert.equal(row().hook_baked, 0);
});
