import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdsensePageOrder, listRankedAdsensePages } from '../worker/lib/adsense-page-ranking.js';

test('AdSense page ranking only accepts known sort modes', () => {
  assert.equal(normalizeAdsensePageOrder('earnings'), 'earnings');
  assert.equal(normalizeAdsensePageOrder('rpm'), 'rpm');
  assert.equal(normalizeAdsensePageOrder('views'), 'views');
  assert.equal(normalizeAdsensePageOrder('estimated_earnings DESC; DROP TABLE x'), 'earnings');
});

test('RPM ranking applies a minimum page-view floor and clamps limit', async () => {
  const calls = [];
  const env = {
    ORCHESTRATOR_DB: {
      prepare(sql) {
        calls.push({ sql, values: null });
        return {
          bind(...values) {
            calls.at(-1).values = values;
            return { all: async () => ({ results: [{ page_url: 'https://example.com/a' }] }) };
          }
        };
      }
    }
  };
  const result = await listRankedAdsensePages(env, '2026-08-31', 'life', { order: 'rpm', minPageViews: 3, limit: 999 });
  assert.equal(result.order, 'rpm');
  assert.equal(result.minPageViews, 3);
  assert.equal(result.rows.length, 1);
  assert.match(calls[0].sql, /ORDER BY page_views_rpm DESC/);
  assert.deepEqual(calls[0].values, ['2026-08-31', 'life', 3, 100]);
});

test('earnings ranking ignores RPM minimum page-view filter', async () => {
  let values;
  const env = {
    ORCHESTRATOR_DB: {
      prepare() {
        return {
          bind(...args) {
            values = args;
            return { all: async () => ({ results: [] }) };
          }
        };
      }
    }
  };
  const result = await listRankedAdsensePages(env, '2026-08-31', 'life', { order: 'earnings', minPageViews: 50, limit: 10 });
  assert.equal(result.minPageViews, 0);
  assert.deepEqual(values, ['2026-08-31', 'life', 0, 10]);
});
