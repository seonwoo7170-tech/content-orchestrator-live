import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { listReadyImageCandidates, completeReadyJobImages, runScheduledImageCompletion } from '../worker/lib/image-completion.js';

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

test('planned provider retries use durable image activity to stop an old job starving Job 105', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY, mode TEXT, blog_id TEXT, result_json TEXT, updated_at TEXT, status TEXT, archived_at TEXT);
    CREATE TABLE daily_plan_slots (job_id INTEGER, plan_date TEXT, kind TEXT, status TEXT);
    CREATE TABLE job_images (job_id INTEGER, status TEXT, updated_at TEXT, provider TEXT, provider_task_id TEXT, provider_status TEXT, provider_checked_at TEXT);`);
  const job = db.prepare("INSERT INTO jobs VALUES (?, 'repair_existing', 'blog', '{}', ?, 'ready', NULL)");
  job.run(127, '2026-09-06 17:18:56');
  job.run(105, '2026-09-10 00:37:05');
  const image = db.prepare("INSERT INTO job_images VALUES (?, 'planned', ?, 'kie-ai', NULL, 'retrying', ?)");
  image.run(127, '2026-09-10T05:21:55.000Z', '2026-09-10T05:21:55.000Z');
  image.run(105, '2026-09-10 00:37:04', '2026-09-10 00:37:04');
  const env = { ORCHESTRATOR_DB: { prepare(sql) { return { bind(...args) { return { async all() { return { results: db.prepare(sql.replaceAll("'now'", "'2026-09-10 05:22:00'")).all(...args) }; } }; } }; } } };
  let rows = await listReadyImageCandidates(env, { maxJobs: 1, staleMinutes: 0 });
  assert.deepEqual(rows.map(row => row.job_id), [105, 127]);
  assert.equal(rows[0].has_failed_images, 1);
  // Even when every image is in cooldown, the oldest provider attempt wins.
  db.prepare('UPDATE job_images SET updated_at = ? WHERE job_id = 105').run('2026-09-10 05:21:50');
  rows = await listReadyImageCandidates(env, { maxJobs: 1, staleMinutes: 0 });
  assert.deepEqual(rows.map(row => row.job_id), [105, 127]);
});

test('a provider retry without any attached image yields to the next job in the same bounded batch', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY, mode TEXT, blog_id TEXT, result_json TEXT, updated_at TEXT, status TEXT, archived_at TEXT);
    CREATE TABLE daily_plan_slots (job_id INTEGER, plan_date TEXT, kind TEXT, status TEXT);
    CREATE TABLE job_images (id INTEGER PRIMARY KEY, job_id INTEGER, role TEXT, position INTEGER, status TEXT,
      prompt TEXT, alt_text TEXT, hook_text TEXT, provider TEXT, model TEXT, mime_type TEXT, storage_key TEXT, public_url TEXT,
      error TEXT, provider_task_id TEXT, provider_status TEXT, provider_attempt_count INTEGER DEFAULT 3,
      provider_error_code TEXT, provider_error_message TEXT, provider_checked_at TEXT, puter_attempted INTEGER DEFAULT 1,
      created_at TEXT, updated_at TEXT, UNIQUE(job_id,role,position));`);
  const result = JSON.stringify({status:'READY_TO_UPDATE_EXISTING',article:{title:'Garden tools',topic:'Garden tools',html:'<h2>Tools</h2><p>Useful tools.</p>'}});
  for (const id of [105,127]) db.prepare("INSERT INTO jobs VALUES (?, 'repair_existing', 'blog', ?, '2026-09-06 00:00:00', 'ready', NULL)").run(id,result);
  const adapter = {prepare(sql) {return {bind(...args) {return {
    async all() {return {results:db.prepare(sql).all(...args)};},
    async run() {return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}
  };}};}, async batch(statements) {return Promise.all(statements.map(s=>s.run()));}};
  let calls = 0;
  const env = {ORCHESTRATOR_DB:adapter,DAILY_WORK_EXECUTION_ENABLED:'true',IMAGE_BUCKET:{async put(){assert.fail('No bytes should be stored');}},
    IMAGE_PUBLIC_BASE_URL:'https://images.example',API_HUB_BASE_URL:'https://hub.example',HUB_API_KEY:'test',
    API_HUB_SERVICE:{async fetch(){calls++;return new Response(JSON.stringify({error:'CLOUDFLARE_AI_ACCOUNT_LIMITED'}),{status:429});}}};
  const work = await runScheduledImageCompletion(env,{maxJobs:2,maxImages:1,staleMinutes:0,articleCooldownMs:0,
    automation:{global:{enabled:true,imagesEnabled:true,bodyImageCount:0},blogs:[]}});
  assert.equal(work.attempted,2);
  assert.deepEqual(work.items.map(i=>i.jobId),[105,127]);
  assert.ok(work.items.every(i=>i.retrying===1 && !i.complete));
  assert.equal(calls,2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_images WHERE provider_status='retrying'").get().n,2);
});
