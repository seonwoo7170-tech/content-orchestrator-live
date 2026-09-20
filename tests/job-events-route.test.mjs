import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

// job-log-panel.js (the "작업 로그" UI panel) and the production diagnostics workflow both
// call GET /api/jobs/:id/events, but worker/index.js never wired listJobEvents (job-events.js)
// into a route -- the endpoint has always 404'd in production, so the log panel silently
// showed nothing and diagnostics reads of job_events always failed. Added the missing route.

function fakeDb(rows) {
  return {
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async all() {
          if (!sql.includes('FROM job_events')) throw new Error(`UNEXPECTED_ALL:${sql}`);
          return { results: rows };
        }
      };
      return statement;
    }
  };
}

const ADMIN_API_KEY = 'test-admin-key';

test('GET /api/jobs/:id/events requires admin auth', async () => {
  const env = { ADMIN_API_KEY, ORCHESTRATOR_DB: fakeDb([]) };
  const response = await worker.fetch(new Request('https://worker.test/api/jobs/42/events'), env, {});
  assert.equal(response.status, 401);
});

test('GET /api/jobs/:id/events returns stored job_events rows including meta_json, parsed', async () => {
  const rows = [
    {
      id: 5, job_id: 42, level: 'warn', event_type: 'repair', stage: 'repairing',
      message: '부분보완 1/2 시작',
      meta_json: JSON.stringify({ repairAttempt: 1, wordCountBefore: 40, wordCountAfter: 22 }),
      created_at: '2026-09-20 03:41:00'
    }
  ];
  const env = { ADMIN_API_KEY, ORCHESTRATOR_DB: fakeDb(rows) };
  const response = await worker.fetch(
    new Request('https://worker.test/api/jobs/42/events?after=0&limit=60', {
      headers: { 'x-admin-api-key': ADMIN_API_KEY }
    }),
    env,
    {}
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.jobId, 42);
  assert.equal(body.events.length, 1);
  assert.deepEqual(body.events[0].meta, { repairAttempt: 1, wordCountBefore: 40, wordCountAfter: 22 });
  assert.equal(body.lastEventId, 5);
});

test('GET /api/jobs/:id/events falls back lastEventId to the requested cursor when there are no new rows', async () => {
  const env = { ADMIN_API_KEY, ORCHESTRATOR_DB: fakeDb([]) };
  const response = await worker.fetch(
    new Request('https://worker.test/api/jobs/42/events?after=17&limit=60', {
      headers: { 'x-admin-api-key': ADMIN_API_KEY }
    }),
    env,
    {}
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.events, []);
  assert.equal(body.lastEventId, 17);
});
