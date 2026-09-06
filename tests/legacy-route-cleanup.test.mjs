import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cleanupSupersededLegacyRouteFailures } from '../worker/lib/legacy-route-cleanup.js';

const source = fs.readFileSync(new URL('../worker/lib/legacy-route-cleanup.js', import.meta.url), 'utf8');

function fakeDb(rows) {
  const batches = [];
  return {
    batches,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            sql,
            args,
            async all() { return { results: rows }; }
          };
        }
      };
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };
}

test('pre-fix route failure without newer success is revived once instead of left permanently held', async () => {
  const db = fakeDb([{
    id: 73,
    mode: 'repair_existing',
    blog_id: 'b1',
    last_error_code: 'API_HUB_404',
    retry_count: 3,
    recovery_state: 'held',
    last_failure_at: '2026-09-04T05:21:00.000Z',
    updated_at: '2026-09-04 05:21:00',
    superseded: 0
  }]);

  const result = await cleanupSupersededLegacyRouteFailures({ ORCHESTRATOR_DB: db });
  assert.equal(result.archived, 0);
  assert.equal(result.revived, 1);
  assert.deepEqual(result.revivedJobIds, [73]);
  assert.match(db.batches[0][0].sql, /retry_count = 0/);
  assert.match(db.batches[0][0].sql, /recovery_state = 'retry_wait'/);
  assert.match(db.batches[0][0].sql, /next_retry_at = datetime\('now'\)/);
});

test('pre-fix route failure is archived when a newer same-blog same-mode success already superseded it', async () => {
  const db = fakeDb([{
    id: 69,
    mode: 'repair_existing',
    blog_id: 'b1',
    last_error_code: 'API_HUB_405',
    retry_count: 3,
    recovery_state: 'held',
    last_failure_at: '2026-09-04T04:55:00.000Z',
    updated_at: '2026-09-04 04:55:00',
    superseded: 1
  }]);

  const result = await cleanupSupersededLegacyRouteFailures({ ORCHESTRATOR_DB: db });
  assert.equal(result.archived, 1);
  assert.equal(result.revived, 0);
  assert.deepEqual(result.jobIds, [69]);
  assert.match(db.batches[0][0].sql, /SUPERSEDED_LEGACY_ROUTE_FAILURE/);
});

test('legacy route reset is permanently bounded to failures before the fixed production deployment', () => {
  assert.match(source, /LEGACY_ROUTE_FIX_CUTOFF = '2026-09-04T07:40:20\.000Z'/);
  assert.match(source, /datetime\(COALESCE\(failed\.last_failure_at, failed\.updated_at\)\) < datetime\(\?\)/);
  assert.match(source, /recovery_state <> 'retry_wait'/);
});
