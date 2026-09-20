import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { completeReadyJobImages } from '../worker/lib/image-completion.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY, mode TEXT, blog_id TEXT, result_json TEXT, updated_at TEXT, status TEXT, archived_at TEXT);
    CREATE TABLE job_images (id INTEGER PRIMARY KEY, job_id INTEGER, role TEXT, position INTEGER, status TEXT,
      prompt TEXT, alt_text TEXT, hook_text TEXT, hook_baked INTEGER DEFAULT 0, provider TEXT, model TEXT, mime_type TEXT, storage_key TEXT, public_url TEXT,
      error TEXT, provider_task_id TEXT, provider_status TEXT, provider_attempt_count INTEGER DEFAULT 0,
      provider_error_code TEXT, provider_error_message TEXT, provider_checked_at TEXT, puter_attempted INTEGER DEFAULT 1,
      created_at TEXT, updated_at TEXT, UNIQUE(job_id,role,position));
    CREATE TABLE klook_products (id INTEGER PRIMARY KEY AUTOINCREMENT, activity_id TEXT UNIQUE, country_name TEXT,
      city_name TEXT, product_name TEXT, product_image TEXT, currency TEXT, sell_price REAL, commission_rate REAL,
      instant_confirmation INTEGER DEFAULT 0, affiliate_link TEXT);`);
  const adapter = {
    prepare(sql) {
      return { bind(...args) { return {
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; }
      }; } };
    },
    async batch(statements) { return Promise.all(statements.map((s) => s.run())); }
  };
  const puts = [];
  const env = {
    ORCHESTRATOR_DB: adapter,
    IMAGE_BUCKET: { async put(key, bytes, options) { puts.push({ key, bytes, options }); } },
    IMAGE_PUBLIC_BASE_URL: 'https://images.example',
    API_HUB_BASE_URL: 'https://hub.example',
    HUB_API_KEY: 'test',
    API_HUB_SERVICE: { async fetch() { assert.fail('KIE must not be called while a stored real photo is still waiting to be attached'); } }
  };
  return { env, db, puts };
}

function pngResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'image/png' : null) },
    async arrayBuffer() { return new Uint8Array([1, 2, 3, 4]).buffer; }
  };
}

test('a TourAPI-grounded new_article job fills body images from real photos instead of calling KIE, and attaches them the same tick', async (t) => {
  const { env, db, puts } = fixture(t);
  const result = JSON.stringify({
    status: 'READY',
    article: { title: 'Gyeongbokgung Palace Guide', topic: 'Gyeongbokgung Palace', html: '<h2>History</h2><p>Answer.</p><h2>Visiting</h2><p>Answer.</p>' },
    attractionImages: ['https://tour.example/a.jpg', 'https://tour.example/b.jpg']
  });
  db.prepare("INSERT INTO jobs VALUES (1, 'new_article', 'smileatlas', ?, '2026-09-19 00:00:00', 'ready', NULL)").run(result);

  const candidate = { job_id: 1, mode: 'new_article', blog_id: 'smileatlas', result_json: result };
  const effective = { enabled: true, imagesEnabled: true, bodyImageCount: 2 };

  const fetchCalls = [];
  const item = await completeReadyJobImages(env, candidate, effective, {
    maxImages: 3,
    fetchImpl: async (url) => { fetchCalls.push(url); return pngResponse(); }
  });

  assert.deepEqual(fetchCalls, ['https://tour.example/a.jpg', 'https://tour.example/b.jpg']);
  assert.equal(puts.length, 2);

  const rows = db.prepare('SELECT role, position, status, provider FROM job_images ORDER BY position').all();
  const thumbnail = rows.find((row) => row.role === 'thumbnail');
  const bodies = rows.filter((row) => row.role === 'body');
  assert.equal(thumbnail.status, 'planned');
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.equal(body.status, 'attached');
    assert.equal(body.provider, 'tour-api');
  }
  // The thumbnail still needs a real KIE-generated hook image; this tick only attaches
  // the durable real photos it already had, exactly like the existing stored->attached
  // priority rule for any other provider's in-flight batch.
  assert.equal(item.complete, false);
});

test('a job with no attractionImages behaves exactly as before (KIE handles every slot)', async (t) => {
  const { env, db } = fixture(t);
  const result = JSON.stringify({
    status: 'READY',
    article: { title: 'Generic guide', topic: 'Generic guide', html: '<h2>Neighborhoods</h2><p>Answer.</p>' }
  });
  db.prepare("INSERT INTO jobs VALUES (1, 'new_article', 'smileatlas', ?, '2026-09-19 00:00:00', 'ready', NULL)").run(result);
  const candidate = { job_id: 1, mode: 'new_article', blog_id: 'smileatlas', result_json: result };
  const effective = { enabled: true, imagesEnabled: true, bodyImageCount: 2 };

  env.API_HUB_SERVICE.fetch = async () => new Response(JSON.stringify({ error: 'CLOUDFLARE_AI_ACCOUNT_LIMITED' }), { status: 429 });
  const item = await completeReadyJobImages(env, candidate, effective, { maxImages: 1 });
  assert.equal(item.retrying, 1);
  const rows = db.prepare("SELECT status FROM job_images WHERE status = 'attached'").all();
  assert.equal(rows.length, 0);
});

const SMILEATLAS_BLOG_ID = '4712699686222371580';

test('a smileatlas job with no tourApiContentId falls back to Klook city photos when the article names a known city', async (t) => {
  const { env, db } = fixture(t);
  db.prepare(`INSERT INTO klook_products
      (activity_id, country_name, city_name, product_name, product_image, currency, sell_price, commission_rate, instant_confirmation, affiliate_link)
    VALUES
      ('1', '대한민국', '서울', 'Seoul City Tour Bus', 'https://klook.example/seoul-1.jpg', 'USD', 19.45, 0.05, 1, 'https://klook.example/aff/1'),
      ('2', '대한민국', '서울', 'Gyeongbokgung Hanbok Rental', 'https://klook.example/seoul-2.jpg', 'USD', 4.99, 0.05, 1, 'https://klook.example/aff/2')`).run();

  const result = JSON.stringify({
    status: 'READY',
    article: { title: 'Best neighborhoods to stay in Seoul for first-time visitors', topic: 'Best neighborhoods to stay in Seoul', html: '<h2>Areas</h2><p>Answer.</p>' }
  });
  db.prepare("INSERT INTO jobs VALUES (1, 'new_article', ?, ?, '2026-09-19 00:00:00', 'ready', NULL)").run(SMILEATLAS_BLOG_ID, result);

  const candidate = { job_id: 1, mode: 'new_article', blog_id: SMILEATLAS_BLOG_ID, result_json: result };
  const effective = { enabled: true, imagesEnabled: true, bodyImageCount: 2 };
  const fetchCalls = [];
  await completeReadyJobImages(env, candidate, effective, {
    maxImages: 3,
    fetchImpl: async (url) => { fetchCalls.push(url); return pngResponse(); }
  });

  // Same commission rate on both rows, so findKlookProductsForAttraction's own tiebreak
  // (lowest sell_price first) decides order -- seoul-2 (4.99) before seoul-1 (19.45).
  assert.deepEqual(fetchCalls, ['https://klook.example/seoul-2.jpg', 'https://klook.example/seoul-1.jpg']);
  const bodies = db.prepare("SELECT status, provider FROM job_images WHERE role = 'body' ORDER BY position").all();
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.equal(body.status, 'attached');
    assert.equal(body.provider, 'tour-api');
  }
});

test('the Klook fallback never fires for a different blog, even if its topic names a known city', async (t) => {
  const { env, db } = fixture(t);
  db.prepare(`INSERT INTO klook_products
      (activity_id, country_name, city_name, product_name, product_image, currency, sell_price, commission_rate, instant_confirmation, affiliate_link)
    VALUES ('1', '대한민국', '서울', 'Seoul City Tour Bus', 'https://klook.example/seoul-1.jpg', 'USD', 19.45, 0.05, 1, 'https://klook.example/aff/1')`).run();

  const result = JSON.stringify({
    status: 'READY',
    article: { title: 'How Seoul startups scaled in 2026', topic: 'Seoul startups', html: '<h2>Growth</h2><p>Answer.</p>' }
  });
  db.prepare("INSERT INTO jobs VALUES (1, 'new_article', 'some-other-blog', ?, '2026-09-19 00:00:00', 'ready', NULL)").run(result);
  const candidate = { job_id: 1, mode: 'new_article', blog_id: 'some-other-blog', result_json: result };
  const effective = { enabled: true, imagesEnabled: true, bodyImageCount: 1 };

  env.API_HUB_SERVICE.fetch = async () => new Response(JSON.stringify({ error: 'CLOUDFLARE_AI_ACCOUNT_LIMITED' }), { status: 429 });
  const item = await completeReadyJobImages(env, candidate, effective, { maxImages: 1 });
  assert.equal(item.retrying, 1);
  const rows = db.prepare("SELECT status FROM job_images WHERE status = 'attached'").all();
  assert.equal(rows.length, 0);
});

test('a smileatlas job whose topic names no known city gets no Klook fallback and proceeds to KIE as usual', async (t) => {
  const { env, db } = fixture(t);
  const result = JSON.stringify({
    status: 'READY',
    article: { title: 'Key factors when choosing an AI subscription plan', topic: 'AI subscription plans', html: '<h2>Cost</h2><p>Answer.</p>' }
  });
  db.prepare("INSERT INTO jobs VALUES (1, 'new_article', ?, ?, '2026-09-19 00:00:00', 'ready', NULL)").run(SMILEATLAS_BLOG_ID, result);
  const candidate = { job_id: 1, mode: 'new_article', blog_id: SMILEATLAS_BLOG_ID, result_json: result };
  const effective = { enabled: true, imagesEnabled: true, bodyImageCount: 1 };

  env.API_HUB_SERVICE.fetch = async () => new Response(JSON.stringify({ error: 'CLOUDFLARE_AI_ACCOUNT_LIMITED' }), { status: 429 });
  const item = await completeReadyJobImages(env, candidate, effective, { maxImages: 1 });
  assert.equal(item.retrying, 1);
});
