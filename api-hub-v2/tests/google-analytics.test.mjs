import test from 'node:test';
import assert from 'node:assert/strict';
import { listAnalyticsProperties, normalizeAnalyticsReportQuery, queryAnalyticsReport } from '../src/lib/google-analytics.js';

const ENV = { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', GOOGLE_REFRESH_TOKEN: 'refresh-token' };

function googleFetch(routes) {
  return async (url, init = {}) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
    return routes(String(url), init);
  };
}

test('GA4 report validation stays inside allowlisted read-only dimensions, metrics and hostname filter', () => {
  assert.deepEqual(normalizeAnalyticsReportQuery({ propertyId: '1234', startDate: '2026-08-01', endDate: '2026-08-28' }), {
    propertyId: '1234', startDate: '2026-08-01', endDate: '2026-08-28', dimensions: [],
    metrics: ['activeUsers', 'totalUsers', 'sessions', 'engagedSessions', 'engagementRate', 'averageSessionDuration', 'screenPageViews'],
    limit: 1, offset: 0, hostNameFilter: null
  });
  assert.deepEqual(normalizeAnalyticsReportQuery({ propertyId: '1234', startDate: '2026-08-01', endDate: '2026-08-28', dimensions: ['hostName'], metrics: ['sessions'], hostNameFilter: 'WWW.Example.com' }), {
    propertyId: '1234', startDate: '2026-08-01', endDate: '2026-08-28', dimensions: ['hostName'], metrics: ['sessions'], limit: 500, offset: 0, hostNameFilter: 'example.com'
  });
  assert.throws(() => normalizeAnalyticsReportQuery({ propertyId: 'abc', startDate: '2026-08-01', endDate: '2026-08-02' }), /ANALYTICS_PROPERTY_INVALID/);
  assert.throws(() => normalizeAnalyticsReportQuery({ propertyId: '1', startDate: '2026-08-02', endDate: '2026-08-01' }), /ANALYTICS_DATE_RANGE_INVALID/);
  assert.throws(() => normalizeAnalyticsReportQuery({ propertyId: '1', startDate: '2026-08-01', endDate: '2026-08-02', dimensions: ['userEmail'] }), /ANALYTICS_DIMENSIONS_INVALID/);
  assert.throws(() => normalizeAnalyticsReportQuery({ propertyId: '1', startDate: '2026-08-01', endDate: '2026-08-02', metrics: ['secretMetric'] }), /ANALYTICS_METRICS_INVALID/);
  assert.throws(() => normalizeAnalyticsReportQuery({ propertyId: '1', startDate: '2026-08-01', endDate: '2026-08-02', hostNameFilter: 'https://bad.example/' }), /ANALYTICS_HOST_FILTER_INVALID/);
});

test('GA4 property inventory returns normalized web stream URIs only', async () => {
  const calls = [];
  const result = await listAnalyticsProperties(ENV, googleFetch(async (url, init) => {
    calls.push(url); assert.equal(init.method, 'GET'); assert.equal(init.headers.authorization, 'Bearer access-token');
    if (url.startsWith('https://analyticsadmin.googleapis.com/v1beta/accountSummaries')) return new Response(JSON.stringify({ accountSummaries: [{ account: 'accounts/10', displayName: 'Main', propertySummaries: [{ property: 'properties/1234', displayName: 'Site GA4' }] }] }), { status: 200 });
    if (url.startsWith('https://analyticsadmin.googleapis.com/v1beta/properties/1234/dataStreams')) return new Response(JSON.stringify({ dataStreams: [
      { name: 'properties/1234/dataStreams/77', type: 'WEB_DATA_STREAM', displayName: 'Web', webStreamData: { defaultUri: 'https://example.com', measurementId: 'G-TEST' }, internal: 'discard' },
      { name: 'properties/1234/dataStreams/88', type: 'ANDROID_APP_DATA_STREAM' }
    ] }), { status: 200 });
    throw new Error(`unexpected:${url}`);
  }));
  assert.equal(calls.length, 2);
  assert.deepEqual(result, { ok: true, properties: [{ property: 'properties/1234', propertyId: '1234', displayName: 'Site GA4', account: 'accounts/10', accountDisplayName: 'Main', dataStreams: [{ name: 'properties/1234/dataStreams/77', dataStreamId: '77', displayName: 'Web', defaultUri: 'https://example.com', measurementId: 'G-TEST', type: 'WEB_DATA_STREAM' }] }], count: 1, webStreamCount: 1 });
});

test('GA4 runReport applies an exact hostName dimension filter and returns numeric metrics', async () => {
  const result = await queryAnalyticsReport(ENV, {
    property: 'properties/1234', startDate: '2026-08-01', endDate: '2026-08-28',
    dimensions: ['landingPagePlusQueryString', 'sessionSourceMedium'], metrics: ['sessions', 'engagedSessions', 'engagementRate'], limit: 50, hostNameFilter: 'blog.example.com'
  }, googleFetch(async (url, init) => {
    assert.equal(url, 'https://analyticsdata.googleapis.com/v1beta/properties/1234:runReport');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.dimensions, [{ name: 'landingPagePlusQueryString' }, { name: 'sessionSourceMedium' }]);
    assert.deepEqual(body.metrics, [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'engagementRate' }]);
    assert.deepEqual(body.dimensionFilter, { filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: 'blog.example.com', caseSensitive: false } } });
    assert.equal(body.limit, '50');
    return new Response(JSON.stringify({ dimensionHeaders: [{ name: 'landingPagePlusQueryString' }, { name: 'sessionSourceMedium' }], metricHeaders: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'engagementRate' }], rows: [{ dimensionValues: [{ value: '/guide' }, { value: 'google / organic' }], metricValues: [{ value: '20' }, { value: '15' }, { value: '0.75' }] }], rowCount: 1 }), { status: 200 });
  }));
  assert.deepEqual(result.rows[0], { dimensions: { landingPagePlusQueryString: '/guide', sessionSourceMedium: 'google / organic' }, metrics: { sessions: 20, engagedSessions: 15, engagementRate: 0.75 } });
  assert.equal(result.hostNameFilter, 'blog.example.com');
  assert.equal(result.count, 1);
});

test('GA4 provider errors fail closed with safe codes', async () => {
  await assert.rejects(() => listAnalyticsProperties(ENV, googleFetch(async () => new Response('private error', { status: 403 }))), /ANALYTICS_ADMIN_REQUEST_FAILED/);
  await assert.rejects(() => queryAnalyticsReport(ENV, { propertyId: '1', startDate: '2026-08-01', endDate: '2026-08-02' }, googleFetch(async () => new Response('private error', { status: 500 }))), /ANALYTICS_DATA_REQUEST_FAILED/);
});
