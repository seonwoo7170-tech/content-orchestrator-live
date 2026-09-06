import test from 'node:test';
import assert from 'node:assert/strict';
import { adsenseDateRange, collectAdsenseForBlogs } from '../worker/lib/adsense-collector.js';

test('AdSense daily windows end one local day behind collection day', () => {
  assert.deepEqual(adsenseDateRange(new Date('2026-08-31T00:00:00Z'), 7, 1, 'Asia/Seoul'), { startDate: '2026-08-24', endDate: '2026-08-30' });
  assert.deepEqual(adsenseDateRange(new Date('2026-08-31T00:00:00Z'), 28, 1, 'Asia/Seoul'), { startDate: '2026-08-03', endDate: '2026-08-30' });
});

test('AdSense collector aggregates exact Blogger domains and preserves zero-data blogs', async () => {
  const snapshots = [];
  const domains = [];
  const calls = [];
  const result = await collectAdsenseForBlogs({}, [
    { blogId: '1', name: 'Root', url: 'https://example.com/' },
    { blogId: '2', name: 'Sub', url: 'https://sub.example.com/' }
  ], {
    now: new Date('2026-08-31T00:00:00Z'),
    callHubFn: async (_env, path, body) => {
      calls.push({ path, body });
      if (path === '/api/adsense/accounts') return { accounts: [{ name: 'accounts/abc' }] };
      if (path === '/api/adsense/report') return {
        rows: [{
          dimensions: { DOMAIN_CODE: 'example.com' },
          metrics: { PAGE_VIEWS: 100, IMPRESSIONS: 80, CLICKS: 2, ESTIMATED_EARNINGS: 1.5, PAGE_VIEWS_RPM: 15 },
          currencyCodes: { ESTIMATED_EARNINGS: 'USD', PAGE_VIEWS_RPM: 'USD' }
        }]
      };
      throw new Error('UNEXPECTED');
    },
    persistDomainFn: async (_env, blog) => domains.push(blog),
    persistSnapshotFn: async (_env, row) => snapshots.push(row)
  });
  assert.equal(result.ok, true);
  assert.equal(result.blogCount, 2);
  assert.equal(result.okCount, 2);
  assert.equal(result.reportRequestCount, 2);
  assert.equal(domains.length, 2);
  assert.equal(snapshots.length, 4);
  const root28 = snapshots.find((row) => row.blogId === '1' && row.windowDays === 28);
  assert.equal(root28.pageViews, 100);
  assert.equal(root28.estimatedEarnings, 1.5);
  assert.equal(root28.pageViewsRpm, 15);
  assert.equal(root28.currencyCode, 'USD');
  const sub28 = snapshots.find((row) => row.blogId === '2' && row.windowDays === 28);
  assert.equal(sub28.status, 'ok');
  assert.equal(sub28.pageViews, 0);
  assert.equal(sub28.estimatedEarnings, 0);
  const reports = calls.filter((call) => call.path === '/api/adsense/report');
  assert.ok(reports.every((call) => call.body.dimensions[0] === 'DOMAIN_CODE'));
});

test('AdSense collector excludes Tistory and does not leak provider error text', async () => {
  const snapshots = [];
  const result = await collectAdsenseForBlogs({}, [
    { blogId: '1', name: 'Blogger', url: 'https://example.com/' },
    { blogId: '2', name: 'Old Tistory', url: 'https://old.tistory.com/' }
  ], {
    now: new Date('2026-08-31T00:00:00Z'),
    callHubFn: async (_env, path) => {
      if (path === '/api/adsense/accounts') return { accounts: [{ name: 'accounts/abc' }] };
      throw new Error('ADSENSE_REPORT_REQUEST_FAILED: private provider payload');
    },
    persistDomainFn: async () => {},
    persistSnapshotFn: async (_env, row) => snapshots.push(row)
  });
  assert.equal(result.blogCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(result.reportFailureCount, 2);
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots.every((row) => row.errorCode === 'ADSENSE_REPORT_REQUEST_FAILED'));
  assert.equal(JSON.stringify(result).includes('private provider payload'), false);
  assert.equal(JSON.stringify(result).includes('tistory'), false);
});

test('AdSense collector fails closed when multiple account currencies would be combined', async () => {
  const snapshots = [];
  const result = await collectAdsenseForBlogs({}, [{ blogId: '1', name: 'Blog', url: 'https://example.com/' }], {
    now: new Date('2026-08-31T00:00:00Z'),
    callHubFn: async (_env, path, body) => {
      if (path === '/api/adsense/accounts') return { accounts: [{ name: 'accounts/a' }, { name: 'accounts/b' }] };
      if (path === '/api/adsense/report') {
        const currency = body.account === 'accounts/a' ? 'USD' : 'EUR';
        return { rows: [{ dimensions: { DOMAIN_CODE: 'example.com' }, metrics: { PAGE_VIEWS: 1, ESTIMATED_EARNINGS: 1, PAGE_VIEWS_RPM: 1 }, currencyCodes: { ESTIMATED_EARNINGS: currency, PAGE_VIEWS_RPM: currency } }] };
      }
      throw new Error('UNEXPECTED');
    },
    persistDomainFn: async () => {},
    persistSnapshotFn: async (_env, row) => snapshots.push(row)
  });
  assert.equal(result.ok, false);
  assert.equal(result.partialCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots.every((row) => row.errorCode === 'ADSENSE_CURRENCY_AMBIGUOUS'));
  assert.ok(snapshots.every((row) => row.currencyCode === null));
});
