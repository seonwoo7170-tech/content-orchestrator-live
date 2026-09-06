import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const imageCompletion = fs.readFileSync('worker/lib/image-completion.js', 'utf8');
const jobStore = fs.readFileSync('worker/lib/job-store.js', 'utf8');
const connectedBlogs = fs.readFileSync('worker/lib/connected-blogs.js', 'utf8');
const workerIndex = fs.readFileSync('worker/index.js', 'utf8');

test('manual unslotted new articles remain eligible for scheduled image completion', () => {
  assert.match(imageCompletion, /j\.mode = 'new_article'/);
  assert.match(imageCompletion, /s\.job_id IS NULL/);
  assert.match(imageCompletion, /s\.kind = 'new_article' AND s\.status = 'resolved'/);
});

test('successful ready and completed transitions clear stale recovery metadata', () => {
  assert.match(jobStore, /\['ready', 'completed'\]\.includes/);
  assert.match(jobStore, /retry_count = CASE WHEN \? = 1 THEN 0 ELSE retry_count END/);
  assert.match(jobStore, /recovery_state = CASE WHEN \? = 1 THEN 'none' ELSE recovery_state END/);
  assert.match(jobStore, /last_error_code = CASE WHEN \? = 1 THEN NULL ELSE last_error_code END/);
  assert.match(jobStore, /UPDATE daily_plan_slots/);
});

test('read-only today dashboard falls back to the managed blog snapshot without weakening write paths', () => {
  assert.match(connectedBlogs, /export async function loadManagedBlogsSnapshot/);
  assert.match(workerIndex, /async function connectedBlogsForReadOnlyDashboard/);
  assert.match(workerIndex, /loadManagedBlogsSnapshot\(env\)/);
  assert.match(workerIndex, /connectedBlogsForReadOnlyDashboard\(env\)/);
  assert.match(workerIndex, /const blogs = await connectedBlogs\(env\);\n\s+const automation = await readAutomationSettings\(env, blogs\);\n\s+const planned = await ensureDailyPlan/);
});