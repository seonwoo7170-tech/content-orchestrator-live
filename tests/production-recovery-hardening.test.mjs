import test from 'node:test';
import assert from 'node:assert/strict';
import { primeAutomaticJobRescue } from '../worker/lib/job-auto-rescue.js';
import { humanReadableJobError } from '../worker/lib/job-store.js';

function savedReview() {
  return JSON.stringify({
    status: 'NEEDS_REVIEW',
    article: { title: 'saved', html: '<p>saved</p>' }
  });
}

function fakeDb(rows) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async all() {
          if (!sql.includes('FROM jobs')) throw new Error(`UNEXPECTED_ALL:${sql}`);
          return { results: rows };
        },
        async first() {
          if (sql.includes('FROM job_publications')) return null;
          throw new Error(`UNEXPECTED_FIRST:${sql}`);
        },
        async run() {
          writes.push({ sql, args: this.args });
          return { meta: { changes: 1 } };
        }
      };
      return statement;
    }
  };
}

test('legacy review holds resume from saved NEEDS_REVIEW results and route-labelled repairs get one clean recheck', async () => {
  const rows = [
    {
      id: 45,
      mode: 'repair_existing',
      blogger_post_id: '4716515176341668196',
      status: 'critic_review',
      retry_count: 3,
      recovery_state: 'held',
      hold_reason: 'RETRY_LIMIT_REACHED',
      last_error_code: 'CRITIC_REVIEW_RETRY',
      result_json: savedReview()
    },
    {
      id: 69,
      mode: 'repair_existing',
      blogger_post_id: '895989422065742453',
      status: 'needs_review',
      retry_count: 3,
      recovery_state: 'held',
      hold_reason: 'RETRY_LIMIT_REACHED',
      last_error_code: 'STALE_PIPELINE_EXECUTION',
      result_json: savedReview()
    },
    {
      id: 73,
      mode: 'repair_existing',
      blogger_post_id: '3139280144556558729',
      status: 'failed',
      retry_count: 3,
      recovery_state: 'retry_wait',
      hold_reason: null,
      last_error_code: 'API_HUB_404',
      result_json: null
    }
  ];
  const db = fakeDb(rows);
  const result = await primeAutomaticJobRescue(
    { ORCHESTRATOR_DB: db },
    { now: new Date('2026-09-04T11:00:00Z'), staleMinutes: 20, limit: 20 }
  );

  assert.equal(result.revived, 2);
  assert.equal(result.revivedRoutes, 1);
  assert.deepEqual(result.items.map((item) => item.action), ['revived', 'revived', 'revived_route']);

  const reviewWrites = db.writes.filter((write) => write.args.includes('CRITIC_REVIEW_CONTINUE'));
  assert.equal(reviewWrites.length, 2);
  assert.ok(reviewWrites.every((write) => write.args[2] === 'CRITIC_REVIEW_CONTINUE'));

  const routeWrite = db.writes.find((write) => write.args.includes('LEGACY_API_HUB_ROUTE_RECHECK'));
  assert.ok(routeWrite);
  assert.equal(routeWrite.args[0], 'LEGACY_API_HUB_ROUTE_RECHECK');
});

test('retry-limit hold normalizes a stale active state to failed instead of leaving critic_review held forever', async () => {
  const rows = [{
    id: 90,
    mode: 'repair_existing',
    blogger_post_id: 'p90',
    status: 'critic_review',
    retry_count: 3,
    recovery_state: 'none',
    hold_reason: null,
    last_error_code: null,
    result_json: null
  }];
  const db = fakeDb(rows);
  const result = await primeAutomaticJobRescue(
    { ORCHESTRATOR_DB: db },
    { now: new Date('2026-09-04T11:00:00Z'), staleMinutes: 20, limit: 20 }
  );

  assert.equal(result.held, 1);
  const hold = db.writes.find((write) => write.sql.includes("recovery_state = 'held'"));
  assert.ok(hold);
  assert.equal(hold.args[0], 'failed');
  assert.equal(hold.args[1], 'RETRY_LIMIT_REACHED');
});

test('precise Blogger lookup failures have a distinct user-facing message', () => {
  assert.match(humanReadableJobError('BLOGGER_API_404'), /Blogger에서 대상 글을 찾지 못했습니다/);
  assert.match(humanReadableJobError('BLOGGER_POST_ID_MISMATCH'), /식별 정보/);
  assert.match(humanReadableJobError('API_HUB_404'), /API Hub/);
});
