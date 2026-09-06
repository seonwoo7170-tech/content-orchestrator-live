import test from 'node:test';
import assert from 'node:assert/strict';
import { listPerformancePriorities } from '../worker/lib/performance-priority-store.js';

function dbWithTables(tables) {
  return {
    prepare(sql) {
      const table = sql.includes('FROM gsc_snapshots')
        ? 'gsc'
        : sql.includes('FROM ga4_snapshots')
          ? 'ga4'
          : sql.includes('FROM adsense_snapshots')
            ? 'adsense'
            : null;
      assert.ok(table, `unexpected SQL: ${sql}`);
      assert.match(sql, /window_days IN \(7, 28\)/);
      return {
        async all() { return { results: tables[table] || [] }; }
      };
    }
  };
}

test('D1-backed priorities rank managed Blogger blogs and preserve GA4 unmapped coverage', async () => {
  const env = {
    ORCHESTRATOR_DB: dbWithTables({
      gsc: [
        { blog_id: 'a', window_days: 7, snapshot_date: '2026-08-31', status: 'ok', clicks: 40, impressions: 400, ctr: 0.10 },
        { blog_id: 'a', window_days: 28, snapshot_date: '2026-08-31', status: 'ok', clicks: 100, impressions: 1000, ctr: 0.10 },
        { blog_id: 'b', window_days: 7, snapshot_date: '2026-08-31', status: 'ok', clicks: 4, impressions: 80, ctr: 0.05 },
        { blog_id: 'b', window_days: 28, snapshot_date: '2026-08-31', status: 'ok', clicks: 40, impressions: 400, ctr: 0.10 }
      ],
      ga4: [
        { blog_id: 'a', window_days: 7, snapshot_date: '2026-08-31', status: 'ok', sessions: 140 },
        { blog_id: 'a', window_days: 28, snapshot_date: '2026-08-31', status: 'ok', sessions: 400 },
        { blog_id: 'b', window_days: 7, snapshot_date: '2026-08-31', status: 'unmapped', sessions: 0 },
        { blog_id: 'b', window_days: 28, snapshot_date: '2026-08-31', status: 'unmapped', sessions: 0 }
      ],
      adsense: [
        { blog_id: 'a', window_days: 7, snapshot_date: '2026-08-31', status: 'ok', estimated_earnings: 14 },
        { blog_id: 'a', window_days: 28, snapshot_date: '2026-08-31', status: 'ok', estimated_earnings: 40 },
        { blog_id: 'b', window_days: 7, snapshot_date: '2026-08-31', status: 'ok', estimated_earnings: 1 },
        { blog_id: 'b', window_days: 28, snapshot_date: '2026-08-31', status: 'ok', estimated_earnings: 16 }
      ]
    })
  };

  const result = await listPerformancePriorities(env, [
    { blogId: 'a', name: 'A', url: 'https://a.blogspot.com' },
    { blogId: 'b', name: 'B', url: 'https://b.example.com' },
    { blogId: 'legacy', name: 'Legacy', url: 'https://legacy.tistory.com' }
  ]);

  assert.deepEqual(result.evidenceCounts, { gsc: 4, ga4: 4, adsense: 4 });
  assert.deepEqual(result.rows.map((row) => row.blogId), ['a', 'b']);
  assert.equal(result.rows[0].priority.action, 'new');
  assert.equal(result.rows[0].priority.confidence, 'high');
  assert.equal(result.rows[1].sources.ga4.status, 'unmapped');
  assert.equal(result.rows[1].priority.action, 'repair');
  assert.equal(result.rows[1].priority.confidence, 'medium');
});

test('priority store fails closed when D1 is not bound', async () => {
  await assert.rejects(() => listPerformancePriorities({}, []), /DB_NOT_BOUND/);
});
