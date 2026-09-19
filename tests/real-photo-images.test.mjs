import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fillBodyImagesFromRealPhotos } from '../worker/lib/real-photo-images.js';
import { listJobImages } from '../worker/lib/image-store.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY); INSERT INTO jobs VALUES (1);');
  for (const file of ['0004_phase2_images.sql', '0026_kie_async_image_tasks.sql', '0027_kie_image_attempt_count.sql', '0028_puter_image_attempted.sql', '0033_thumbnail_hook_baked.sql']) {
    db.exec(readFileSync(new URL(`../worker/migrations/${file}`, import.meta.url), 'utf8'));
  }
  db.exec("ALTER TABLE job_images ADD COLUMN hook_text TEXT;");
  db.exec(`
    INSERT INTO job_images (job_id, role, position, status, prompt, alt_text) VALUES
      (1, 'thumbnail', 0, 'planned', 'A tidy hero shot', 'Thumbnail'),
      (1, 'body', 1, 'planned', 'A neighborhood street scene', 'Body 1'),
      (1, 'body', 2, 'planned', 'A palace courtyard', 'Body 2');
  `);
  const puts = [];
  const env = {
    IMAGE_PUBLIC_BASE_URL: 'https://images.example.com',
    IMAGE_BUCKET: { async put(key, bytes, options) { puts.push({ key, bytes, options }); } },
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
  return { env, db, puts };
}

function pngResponse(bytes = new Uint8Array([1, 2, 3, 4])) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/png' : null) },
    async arrayBuffer() { return bytes.buffer; }
  };
}

test('real attraction photos fill body slots in position order and are marked stored, never touching the thumbnail', async (t) => {
  const { env, puts } = fixture(t);
  const calls = [];
  const result = await fillBodyImagesFromRealPhotos(
    env, 1,
    await listJobImages(env, 1),
    ['https://tour.example/a.jpg', 'https://tour.example/b.jpg'],
    { fetchImpl: async (url) => { calls.push(url); return pngResponse(); } }
  );

  assert.deepEqual(result, { attempted: 2, filled: 2 });
  assert.deepEqual(calls, ['https://tour.example/a.jpg', 'https://tour.example/b.jpg']);

  const images = await listJobImages(env, 1);
  const thumbnail = images.find((image) => image.role === 'thumbnail');
  const body1 = images.find((image) => image.position === 1);
  const body2 = images.find((image) => image.position === 2);

  assert.equal(thumbnail.status, 'planned');
  assert.equal(thumbnail.provider, null);
  assert.equal(body1.status, 'stored');
  assert.equal(body1.provider, 'tour-api');
  assert.match(body1.public_url, /^https:\/\/images\.example\.com\/media\/jobs\/1\/body-1\.png$/);
  assert.equal(body2.status, 'stored');
  assert.equal(puts.length, 2);
});

test('fewer real photos than body slots leaves the remaining slot planned for the normal KIE fallback', async (t) => {
  const { env } = fixture(t);
  const result = await fillBodyImagesFromRealPhotos(
    env, 1,
    await listJobImages(env, 1),
    ['https://tour.example/a.jpg'],
    { fetchImpl: async () => pngResponse() }
  );

  assert.deepEqual(result, { attempted: 1, filled: 1 });
  const images = await listJobImages(env, 1);
  assert.equal(images.find((image) => image.position === 1).status, 'stored');
  assert.equal(images.find((image) => image.position === 2).status, 'planned');
});

test('a failed download leaves that slot planned instead of throwing, so KIE still gets a chance at it', async (t) => {
  const { env } = fixture(t);
  let call = 0;
  const result = await fillBodyImagesFromRealPhotos(
    env, 1,
    await listJobImages(env, 1),
    ['https://tour.example/broken.jpg', 'https://tour.example/b.jpg'],
    { fetchImpl: async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 404 };
      return pngResponse();
    } }
  );

  assert.deepEqual(result, { attempted: 2, filled: 1 });
  const images = await listJobImages(env, 1);
  assert.equal(images.find((image) => image.position === 1).status, 'planned');
  assert.equal(images.find((image) => image.position === 2).status, 'stored');
});

test('no photo URLs is a clean no-op', async (t) => {
  const { env, puts } = fixture(t);
  const result = await fillBodyImagesFromRealPhotos(env, 1, await listJobImages(env, 1), [], {});
  assert.deepEqual(result, { attempted: 0, filled: 0 });
  assert.equal(puts.length, 0);
});

test('a non-image content-type is rejected and leaves the slot planned', async (t) => {
  const { env } = fixture(t);
  const result = await fillBodyImagesFromRealPhotos(
    env, 1,
    await listJobImages(env, 1),
    ['https://tour.example/not-an-image.html'],
    { fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/html' : null) },
      async arrayBuffer() { return new Uint8Array([1]).buffer; }
    }) }
  );
  assert.deepEqual(result, { attempted: 1, filled: 0 });
  const images = await listJobImages(env, 1);
  assert.equal(images.find((image) => image.position === 1).status, 'planned');
});
