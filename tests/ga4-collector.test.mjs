import test from 'node:test';
import assert from 'node:assert/strict';
import { bloggerOnlyAnalyticsProperties, collectAnalyticsForBlogs, ga4DateRange, resolveAnalyticsProperty } from '../worker/lib/ga4-collector.js';

test('GA4 property resolver matches Blogger host to the exact web data stream URI', () => {
  const properties = [{
    propertyId: '100', displayName: 'Main', dataStreams: [
      { dataStreamId: '1', defaultUri: 'https://www.example.com/', measurementId: 'G-ONE' },
      { dataStreamId: '2', defaultUri: 'https://other.example.com/', measurementId: 'G-TWO' }
    ]
  }];
  assert.deepEqual(resolveAnalyticsProperty({ url: 'https://example.com/' }, properties), {
    propertyId: '100', propertyName: 'Main', dataStreamId: '1', defaultUri: 'https://www.example.com/', measurementId: 'G-ONE', matchType: 'exact_url'
  });
  assert.equal(resolveAnalyticsProperty({ url: 'https://unrelated.test/' }, properties), null);
});

test('GA4 Blogger inventory excludes Tistory properties and streams', () => {
  const filtered = bloggerOnlyAnalyticsProperties([
    { propertyId: '1', displayName: 'smileseon tistory', dataStreams: [{ defaultUri: 'https://smileseon.tistory.com' }] },
    { propertyId: '2', displayName: 'Blogger shared', dataStreams: [
      { dataStreamId: '20', displayName: 'Blogger', defaultUri: 'https://example.com' },
      { dataStreamId: '21', displayName: 'old tistory stream', defaultUri: 'https://other.tistory.com' }
    ] }
  ]);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].propertyId, '2');
  assert.equal(filtered[0].dataStreams.length, 1);
  assert.equal(filtered[0].dataStreams[0].dataStreamId, '20');
});

test('GA4 daily windows end one local day behind collection day', () => {
  assert.deepEqual(ga4DateRange(new Date('2026-08-31T00:00:00Z'), 7, 1, 'Asia/Seoul'), { startDate: '2026-08-24', endDate: '2026-08-30' });
  assert.deepEqual(ga4DateRange(new Date('2026-08-31T00:00:00Z'), 28, 1, 'Asia/Seoul'), { startDate: '2026-08-03', endDate: '2026-08-30' });
});

test('GA4 collection isolates an unmapped blog and filters every mapped report by hostname', async () => {
  const properties = [{ propertyId: '100', displayName: 'Example', dataStreams: [{ dataStreamId: '1', defaultUri: 'https://example.com', measurementId: 'G-X' }] }];
  const persistedProperties = [];
  const persistedSnapshots = [];
  const detailRows = [];
  const calls = [];
  const result = await collectAnalyticsForBlogs({}, [
    { blogId: '1', name: 'Mapped', url: 'https://example.com/' },
    { blogId: '2', name: 'Unmapped', url: 'https://missing.example/' }
  ], {
    now: new Date('2026-08-31T00:00:00Z'),
    callHubFn: async (_env, path, body) => {
      calls.push({ path, body });
      if (path === '/api/ga4/properties') return { properties, webStreamCount: 1 };
      if (path === '/api/ga4/report' && body.dimensions?.[0] === 'hostName') return { rows: [] };
      if (path === '/api/ga4/report' && body.dimensions) return { rows: [{ dimensions: { landingPagePlusQueryString: '/', sessionSourceMedium: 'google / organic' }, metrics: { activeUsers: 4, sessions: 5, engagedSessions: 3, engagementRate: 0.6, screenPageViews: 7 } }] };
      if (path === '/api/ga4/report') return { rows: [{ metrics: { activeUsers: 10, totalUsers: 12, sessions: 15, engagedSessions: 9, engagementRate: 0.6, averageSessionDuration: 42, screenPageViews: 30 } }] };
      throw new Error('PRIVATE_PROVIDER_TEXT');
    },
    persistPropertyFn: async (_env, blog, match) => persistedProperties.push({ blogId: blog.blogId, match }),
    persistSnapshotFn: async (_env, row) => persistedSnapshots.push(row),
    replaceDetailRowsFn: async (_env, ...args) => { detailRows.push(args); return 1; }
  });
  assert.equal(result.ok, true);
  assert.equal(result.coverageComplete, false);
  assert.equal(result.blogCount, 2);
  assert.equal(result.mappedCount, 1);
  assert.equal(result.directMappedCount, 1);
  assert.equal(result.hostnameMappedCount, 0);
  assert.equal(result.unmappedCount, 1);
  assert.equal(persistedProperties.length, 2);
  assert.equal(persistedSnapshots.length, 4);
  assert.equal(detailRows.length, 1);
  const reportCalls = calls.filter((call) => call.path === '/api/ga4/report');
  assert.equal(reportCalls.length, 4);
  const mappedCollectionCalls = reportCalls.filter((call) => call.body.dimensions?.[0] !== 'hostName');
  assert.ok(mappedCollectionCalls.every((call) => call.body.hostNameFilter === 'example.com'));
  assert.equal(JSON.stringify(result).includes('PRIVATE_PROVIDER_TEXT'), false);
  assert.ok(result.items.find((item) => item.blogId === '2').windows.every((window) => window.status === 'unmapped'));
});

test('GA4 collection discovers a shared property from unique hostname data and keeps blogs isolated', async () => {
  const properties = [{ propertyId: '100', displayName: 'Shared', dataStreams: [{ dataStreamId: '1', defaultUri: 'https://5minutes-info.com', measurementId: 'G-X' }] }];
  const calls = [];
  const propertiesPersisted = [];
  const result = await collectAnalyticsForBlogs({}, [
    { blogId: '1', name: 'Root', url: 'https://5minutes-info.com/' },
    { blogId: '2', name: 'Soul', url: 'https://soulquiz.5minutes-info.com/' }
  ], {
    now: new Date('2026-08-31T00:00:00Z'),
    callHubFn: async (_env, path, body) => {
      calls.push({ path, body });
      if (path === '/api/ga4/properties') return { properties, webStreamCount: 1 };
      if (path === '/api/ga4/report' && body.dimensions?.[0] === 'hostName') return { rows: [{ dimensions: { hostName: 'soulquiz.5minutes-info.com' }, metrics: { sessions: 22 } }] };
      if (path === '/api/ga4/report' && body.dimensions) return { rows: [] };
      if (path === '/api/ga4/report') return { rows: [{ metrics: { sessions: body.hostNameFilter === 'soulquiz.5minutes-info.com' ? 2 : 20 } }] };
      throw new Error('UNEXPECTED');
    },
    persistPropertyFn: async (_env, blog, match) => propertiesPersisted.push({ blogId: blog.blogId, match }),
    persistSnapshotFn: async () => {},
    replaceDetailRowsFn: async () => 0
  });
  assert.equal(result.mappedCount, 2);
  assert.equal(result.directMappedCount, 1);
  assert.equal(result.hostnameMappedCount, 1);
  assert.equal(result.unmappedCount, 0);
  assert.equal(result.items.find((item) => item.blogId === '2').matchType, 'hostname_data');
  const summaries = calls.filter((call) => call.path === '/api/ga4/report' && !call.body.dimensions);
  assert.ok(summaries.some((call) => call.body.hostNameFilter === '5minutes-info.com'));
  assert.ok(summaries.some((call) => call.body.hostNameFilter === 'soulquiz.5minutes-info.com'));
  assert.equal(propertiesPersisted.find((item) => item.blogId === '2').match.matchType, 'hostname_data');
});

test('GA4 ambiguous hostname discovery remains unmapped instead of guessing a property', async () => {
  const properties = [
    { propertyId: '100', displayName: 'A', dataStreams: [{ defaultUri: 'https://legacy-a.example' }] },
    { propertyId: '200', displayName: 'B', dataStreams: [{ defaultUri: 'https://legacy-b.example' }] }
  ];
  const persisted = [];
  const result = await collectAnalyticsForBlogs({}, [{ blogId: '9', name: 'Target', url: 'https://target.example/' }], {
    now: new Date('2026-08-31T00:00:00Z'),
    callHubFn: async (_env, path, body) => {
      if (path === '/api/ga4/properties') return { properties, webStreamCount: 2 };
      if (body.dimensions?.[0] === 'hostName') return { rows: [{ dimensions: { hostName: 'target.example' }, metrics: { sessions: body.propertyId === '100' ? 20 : 10 } }] };
      throw new Error('UNMAPPED_BLOG_MUST_NOT_BE_QUERIED');
    },
    persistPropertyFn: async (_env, blog, match) => persisted.push({ blog, match }),
    persistSnapshotFn: async () => {},
    replaceDetailRowsFn: async () => 0
  });
  assert.equal(result.ok, true);
  assert.equal(result.coverageComplete, false);
  assert.equal(result.mappedCount, 0);
  assert.equal(result.unmappedCount, 1);
  assert.equal(persisted[0].match, null);
});

test('GA4 Tistory properties and blogs are ignored during Blogger collection', async () => {
  const queried = [];
  const result = await collectAnalyticsForBlogs({}, [
    { blogId: '1', name: 'Blog', url: 'https://example.com/' },
    { blogId: '2', name: 'Old Tistory', url: 'https://old.tistory.com/' }
  ], {
    now: new Date('2026-08-31T00:00:00Z'),
    callHubFn: async (_env, path, body) => {
      if (path === '/api/ga4/properties') return { properties: [
        { propertyId: '100', displayName: 'Blogger', dataStreams: [{ defaultUri: 'https://example.com' }] },
        { propertyId: '999', displayName: 'smileseon tistory', dataStreams: [{ defaultUri: 'https://smileseon.tistory.com' }] }
      ], webStreamCount: 2 };
      queried.push(String(body.propertyId));
      if (body.dimensions?.[0] === 'hostName') return { rows: [] };
      return { rows: [] };
    },
    persistPropertyFn: async () => {}, persistSnapshotFn: async () => {}, replaceDetailRowsFn: async () => 0
  });
  assert.equal(result.blogCount, 1);
  assert.equal(result.ignoredPropertyCount, 1);
  assert.equal(result.propertyCount, 1);
  assert.equal(queried.includes('999'), false);
});

test('GA4 report failure becomes a bounded safe code', async () => {
  const snapshots = [];
  const result = await collectAnalyticsForBlogs({}, [{ blogId: '1', name: 'Mapped', url: 'https://example.com/' }], {
    now: new Date('2026-08-31T00:00:00Z'),
    callHubFn: async (_env, path) => {
      if (path === '/api/ga4/properties') return { properties: [{ propertyId: '100', displayName: 'Example', dataStreams: [{ dataStreamId: '1', defaultUri: 'https://example.com', measurementId: 'G-X' }] }] };
      throw new Error('ANALYTICS_DATA_REQUEST_FAILED: private payload');
    },
    persistPropertyFn: async () => {},
    persistSnapshotFn: async (_env, row) => snapshots.push(row),
    replaceDetailRowsFn: async () => 0
  });
  assert.equal(result.ok, false);
  assert.equal(result.partialCount, 1);
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots.every((row) => row.errorCode === 'ANALYTICS_DATA_REQUEST_FAILED'));
  assert.equal(JSON.stringify(result).includes('private payload'), false);
});
