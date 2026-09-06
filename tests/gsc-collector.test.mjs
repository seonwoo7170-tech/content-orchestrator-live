import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSearchConsoleForBlogs, gscDateRange, resolveSearchConsoleProperty } from '../worker/lib/gsc-collector.js';

test('GSC property resolver prefers the most specific URL-prefix match over a domain fallback', () => {
  const match = resolveSearchConsoleProperty({
    blogId: '1',
    url: 'https://www.example.com/blog/'
  }, [
    { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://www.example.com/', permissionLevel: 'siteFullUser' },
    { siteUrl: 'https://www.example.com/blog/', permissionLevel: 'siteOwner' }
  ]);
  assert.deepEqual(match, {
    siteUrl: 'https://www.example.com/blog/',
    permissionLevel: 'siteOwner',
    matchType: 'url_prefix'
  });
});

test('GSC property resolver matches a custom subdomain to a domain property and ignores unrelated properties', () => {
  const match = resolveSearchConsoleProperty({
    blogId: '1',
    url: 'https://help.example.com/'
  }, [
    { siteUrl: 'sc-domain:other.com', permissionLevel: 'siteOwner' },
    { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }
  ]);
  assert.equal(match.siteUrl, 'sc-domain:example.com');
  assert.equal(match.matchType, 'domain');
});

test('GSC date windows end two local days behind the collection date', () => {
  const range7 = gscDateRange(new Date('2026-08-31T03:00:00+09:00'), 7, 2, 'Asia/Seoul');
  assert.deepEqual(range7, { startDate: '2026-08-23', endDate: '2026-08-29' });
  const range28 = gscDateRange(new Date('2026-08-31T03:00:00+09:00'), 28, 2, 'Asia/Seoul');
  assert.deepEqual(range28, { startDate: '2026-08-02', endDate: '2026-08-29' });
});

test('GSC collection isolates one blog failure and never stores raw provider text', async () => {
  const properties = [];
  const snapshots = [];
  const details = [];
  const calls = [];
  const blogs = [
    { blogId: '1', name: 'One', url: 'https://one.example.com/' },
    { blogId: '2', name: 'Two', url: 'https://two.example.net/' }
  ];

  const callHubFn = async (_env, path, body) => {
    calls.push({ path, body });
    if (path === '/api/gsc/sites') {
      return { sites: [
        { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
        { siteUrl: 'sc-domain:example.net', permissionLevel: 'siteOwner' }
      ] };
    }
    if (body.siteUrl === 'sc-domain:example.net' && body.aggregateOnly === true) {
      throw new Error('SEARCH_CONSOLE_REQUEST_FAILED:private provider explanation');
    }
    if (body.aggregateOnly === true) {
      return { rows: [{ clicks: body.startDate === '2026-08-23' ? 7 : 28, impressions: 100, ctr: 0.07, position: 8 }] };
    }
    return { rows: [{ dimensions: { page: 'https://one.example.com/a', query: 'safe query' }, clicks: 5, impressions: 50, ctr: 0.1, position: 4 }] };
  };

  const result = await collectSearchConsoleForBlogs({}, blogs, {
    now: new Date('2026-08-31T03:00:00+09:00'),
    callHubFn,
    persistPropertyFn: async (_env, blog, match) => properties.push({ blogId: blog.blogId, match }),
    persistSnapshotFn: async (_env, snapshot) => snapshots.push(snapshot),
    replaceDetailRowsFn: async (_env, snapshotDate, blogId, siteUrl, startDate, endDate, rows) => {
      details.push({ snapshotDate, blogId, siteUrl, startDate, endDate, rows });
      return rows.length;
    }
  });

  assert.equal(result.blogCount, 2);
  assert.equal(result.mappedCount, 2);
  assert.equal(result.okCount, 1);
  assert.equal(result.partialCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(properties.length, 2);
  assert.equal(snapshots.length, 4);
  assert.equal(details.length, 1);
  const failedSnapshots = snapshots.filter((item) => item.status === 'failed');
  assert.equal(failedSnapshots.length, 2);
  assert.equal(failedSnapshots.every((item) => item.errorCode === 'SEARCH_CONSOLE_REQUEST_FAILED'), true);
  assert.equal(JSON.stringify(result).includes('private provider explanation'), false);
  assert.equal(calls.some((call) => call.body?.aggregateOnly === true), true);
  assert.equal(calls.some((call) => Array.isArray(call.body?.dimensions) && call.body.dimensions.join(',') === 'page,query'), true);
});

test('unmapped blog produces bounded unmapped snapshots without any performance API call', async () => {
  const snapshots = [];
  const calls = [];
  const result = await collectSearchConsoleForBlogs({}, [
    { blogId: '9', name: 'Unmapped', url: 'https://unmapped.test/' }
  ], {
    now: new Date('2026-08-31T03:00:00+09:00'),
    callHubFn: async (_env, path, body) => {
      calls.push({ path, body });
      if (path === '/api/gsc/sites') return { sites: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] };
      throw new Error('SHOULD_NOT_CALL_PERFORMANCE');
    },
    persistPropertyFn: async () => {},
    persistSnapshotFn: async (_env, snapshot) => snapshots.push(snapshot)
  });
  assert.equal(result.items[0].status, 'unmapped');
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.every((item) => item.errorCode === 'GSC_PROPERTY_UNMAPPED'), true);
  assert.equal(calls.length, 1);
});
