import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPageUrl, collectAdsensePagePerformance } from '../worker/lib/adsense-page-performance.js';

test('canonicalPageUrl strips query and hash for article aggregation', () => {
  assert.equal(canonicalPageUrl('https://example.com/post?a=1#x'), 'https://example.com/post');
});

test('AdSense PAGE_URL collector returns Blogger article earnings and excludes Tistory', async () => {
  const persisted = [];
  const calls = [];
  const result = await collectAdsensePagePerformance({}, [
    { blogId: 'life', name: 'Life Saver', url: 'https://example.com/' },
    { blogId: 'old', name: 'Old', url: 'https://old.tistory.com/' }
  ], {
    now: new Date('2026-08-31T03:00:00Z'),
    callHubFn: async (_env, path, body) => {
      calls.push({ path, body });
      if (path === '/api/adsense/accounts') return { accounts: [{ name: 'accounts/a' }] };
      if (path === '/api/adsense/report') return {
        rows: [
          {
            dimensions: { PAGE_URL: 'https://example.com/2026/08/good-post.html?utm_source=x' },
            metrics: { PAGE_VIEWS: 20, IMPRESSIONS: 18, CLICKS: 2, ESTIMATED_EARNINGS: 3, PAGE_VIEWS_RPM: 150 },
            currencyCodes: { ESTIMATED_EARNINGS: 'USD', PAGE_VIEWS_RPM: 'USD' }
          },
          {
            dimensions: { PAGE_URL: 'https://old.tistory.com/entry/ignored' },
            metrics: { PAGE_VIEWS: 999, ESTIMATED_EARNINGS: 99, PAGE_VIEWS_RPM: 99 },
            currencyCodes: { ESTIMATED_EARNINGS: 'USD', PAGE_VIEWS_RPM: 'USD' }
          }
        ]
      };
      throw new Error('UNEXPECTED');
    },
    persistPageFn: async (_env, row) => persisted.push(row)
  });

  assert.equal(result.ok, true);
  assert.equal(result.blogCount, 1);
  assert.equal(result.pageCount, 1);
  assert.equal(result.preliminary, true);
  assert.equal(result.rows[0].blogId, 'life');
  assert.equal(result.rows[0].pageUrl, 'https://example.com/2026/08/good-post.html');
  assert.equal(result.rows[0].estimatedEarnings, 3);
  assert.equal(result.rows[0].pageViewsRpm, 150);
  assert.equal(persisted.length, 1);
  const reportCall = calls.find((call) => call.path === '/api/adsense/report');
  assert.deepEqual(reportCall.body.dimensions, ['PAGE_URL']);
  assert.equal(reportCall.body.startDate, '2026-08-31');
  assert.equal(reportCall.body.endDate, '2026-08-31');
});

test('PAGE_URL variants aggregate to one canonical article with weighted RPM', async () => {
  const persisted = [];
  const result = await collectAdsensePagePerformance({}, [{ blogId: '1', name: 'Blog', url: 'https://example.com/' }], {
    now: new Date('2026-08-31T03:00:00Z'),
    callHubFn: async (_env, path) => {
      if (path === '/api/adsense/accounts') return { accounts: [{ name: 'accounts/a' }] };
      return {
        rows: [
          { dimensions: { PAGE_URL: 'https://example.com/post?x=1' }, metrics: { PAGE_VIEWS: 10, ESTIMATED_EARNINGS: 1, PAGE_VIEWS_RPM: 100 }, currencyCodes: { ESTIMATED_EARNINGS: 'USD', PAGE_VIEWS_RPM: 'USD' } },
          { dimensions: { PAGE_URL: 'https://example.com/post?x=2' }, metrics: { PAGE_VIEWS: 30, ESTIMATED_EARNINGS: 6, PAGE_VIEWS_RPM: 200 }, currencyCodes: { ESTIMATED_EARNINGS: 'USD', PAGE_VIEWS_RPM: 'USD' } }
        ]
      };
    },
    persistPageFn: async (_env, row) => persisted.push(row)
  });
  assert.equal(result.pageCount, 1);
  assert.equal(result.rows[0].pageViews, 40);
  assert.equal(result.rows[0].estimatedEarnings, 7);
  assert.equal(result.rows[0].pageViewsRpm, 175);
  assert.equal(persisted.length, 1);
});

test('provider error text is reduced to safe code', async () => {
  const result = await collectAdsensePagePerformance({}, [{ blogId: '1', name: 'Blog', url: 'https://example.com/' }], {
    callHubFn: async (_env, path) => {
      if (path === '/api/adsense/accounts') return { accounts: [{ name: 'accounts/a' }] };
      throw new Error('ADSENSE_REPORT_REQUEST_FAILED: private provider payload');
    },
    persistPageFn: async () => {}
  });
  assert.equal(result.ok, false);
  assert.equal(result.reportFailureCount, 1);
  assert.equal(JSON.stringify(result).includes('private provider payload'), false);
});
