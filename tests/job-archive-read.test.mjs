import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listArchivedJobs } from '../worker/lib/job-store.js';

const workerIndex = fs.readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
const todayCompletions = fs.readFileSync(new URL('../web/today-completions.js', import.meta.url), 'utf8');

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
          if (!sql.includes('FROM jobs')) throw new Error(`UNEXPECTED_ALL:${sql}`);
          statement.lastSql = sql;
          return { results: rows };
        }
      };
      return statement;
    }
  };
}

// persistJobTransition sets archived_at in the exact same UPDATE that sets
// status='completed' (work-queue-archive.test.mjs), so a completed job never has
// archived_at IS NULL. listStoredJobs's "status = ? AND archived_at IS NULL" filter can
// therefore never return a completed job -- the "오늘 완료" UI panel queried exactly that
// and always got zero rows back, regardless of how much actually published today.
test('listArchivedJobs reads the preserved history listStoredJobs can never see', async () => {
  const rows = [{ id: 42, status: 'completed', archived_at: '2026-09-20 01:00:00' }];
  const db = fakeDb(rows);
  const result = await listArchivedJobs({ ORCHESTRATOR_DB: db }, { status: 'completed', limit: 50 });
  assert.deepEqual(result, rows);
});

test('listArchivedJobs queries archived_at IS NOT NULL, the inverse of the active-queue filter', async () => {
  let capturedSql = '';
  const spyDb = {
    prepare(sql) {
      capturedSql = sql;
      return { bind: () => ({ all: async () => ({ results: [] }) }) };
    }
  };
  await listArchivedJobs({ ORCHESTRATOR_DB: spyDb }, { status: 'completed' });
  assert.match(capturedSql, /archived_at IS NOT NULL/);
  assert.doesNotMatch(capturedSql, /archived_at IS NULL/);
  assert.match(capturedSql, /ORDER BY archived_at DESC/);
});

test('listArchivedJobs can scope the preserved history to one blog', async () => {
  let capturedSql = '';
  let capturedArgs = [];
  const spyDb = {
    prepare(sql) {
      capturedSql = sql;
      return {
        bind: (...args) => {
          capturedArgs = args;
          return { all: async () => ({ results: [] }) };
        }
      };
    }
  };
  await listArchivedJobs({ ORCHESTRATOR_DB: spyDb }, { status: 'completed', blogId: '123456' });
  assert.match(capturedSql, /blog_id = \?/);
  assert.deepEqual(capturedArgs, ['completed', '123456', 30]);
});

test('the /api/jobs route exposes archived history behind an explicit ?archived=true switch', () => {
  assert.match(workerIndex, /listArchivedJobs/);
  assert.match(workerIndex, /searchParams\.get\('archived'\)/);
  assert.match(workerIndex, /blogId: url\.searchParams\.get\('blogId'\)/);
});

test('the "오늘 완료" panel actually requests the archived history instead of a query that can never return one', () => {
  assert.match(todayCompletions, /\/api\/jobs\?status=completed&archived=true&limit=100/);
});
