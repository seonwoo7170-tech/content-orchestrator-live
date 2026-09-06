import test from 'node:test';
import assert from 'node:assert/strict';
import { listSearchConsoleSites, normalizeSearchConsoleQuery, querySearchConsolePerformance } from '../src/lib/search-console.js';

const ENV = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REFRESH_TOKEN: 'refresh-token'
};

function googleFetch(routes) {
  return async (url, init = {}) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
    }
    return routes(String(url), init);
  };
}

test('Search Console query validation is bounded and read-only shaped', () => {
  assert.deepEqual(normalizeSearchConsoleQuery({
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-28'
  }), {
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-28',
    dimensions: ['query', 'page'],
    rowLimit: 2500,
    startRow: 0,
    aggregateOnly: false
  });
  assert.throws(() => normalizeSearchConsoleQuery({ siteUrl: 'x', startDate: '2026-08-30', endDate: '2026-08-01' }), /SEARCH_CONSOLE_DATE_RANGE_INVALID/);
  assert.throws(() => normalizeSearchConsoleQuery({ siteUrl: 'x', startDate: '2026-08-01', endDate: '2026-08-30', dimensions: ['secret'] }), /SEARCH_CONSOLE_DIMENSIONS_INVALID/);
  assert.throws(() => normalizeSearchConsoleQuery({ siteUrl: 'x', startDate: '2026-08-01', endDate: '2026-08-30', rowLimit: 25001 }), /SEARCH_CONSOLE_ROW_LIMIT_INVALID/);
});

test('Search Console aggregate query intentionally omits dimensions and defaults to one row', () => {
  assert.deepEqual(normalizeSearchConsoleQuery({
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-28',
    aggregateOnly: true
  }), {
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-28',
    dimensions: [],
    rowLimit: 1,
    startRow: 0,
    aggregateOnly: true
  });
});

test('Search Console site inventory returns only site URL and permission level', async () => {
  const result = await listSearchConsoleSites(ENV, googleFetch(async (url, init) => {
    assert.equal(url, 'https://www.googleapis.com/webmasters/v3/sites');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.authorization, 'Bearer access-token');
    return new Response(JSON.stringify({ siteEntry: [
      { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner', extra: 'discard-me' }
    ] }), { status: 200 });
  }));
  assert.deepEqual(result, {
    ok: true,
    sites: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }],
    count: 1
  });
});

test('Search Console performance normalizes dimensions and metrics without provider payload leakage', async () => {
  const result = await querySearchConsolePerformance(ENV, {
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-28',
    dimensions: ['query', 'page'],
    rowLimit: 100
  }, googleFetch(async (url, init) => {
    assert.equal(url, 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.dimensions, ['query', 'page']);
    assert.equal(body.rowLimit, 100);
    assert.equal(body.dataState, 'final');
    return new Response(JSON.stringify({ rows: [{
      keys: ['how to fix sink', 'https://example.com/sink'],
      clicks: 12,
      impressions: 300,
      ctr: 0.04,
      position: 8.2,
      internal: 'discard-me'
    }] }), { status: 200 });
  }));
  assert.deepEqual(result.rows[0], {
    dimensions: { query: 'how to fix sink', page: 'https://example.com/sink' },
    clicks: 12,
    impressions: 300,
    ctr: 0.04,
    position: 8.2
  });
  assert.equal(result.count, 1);
});

test('Search Console aggregate request sends no dimensions', async () => {
  const result = await querySearchConsolePerformance(ENV, {
    siteUrl: 'sc-domain:example.com',
    startDate: '2026-08-01',
    endDate: '2026-08-28',
    aggregateOnly: true
  }, googleFetch(async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(Object.hasOwn(body, 'dimensions'), false);
    assert.equal(body.rowLimit, 1);
    return new Response(JSON.stringify({ rows: [{ clicks: 30, impressions: 600, ctr: 0.05, position: 7.1 }] }), { status: 200 });
  }));
  assert.deepEqual(result.rows[0], {
    dimensions: {},
    clicks: 30,
    impressions: 600,
    ctr: 0.05,
    position: 7.1
  });
  assert.equal(result.aggregateOnly, true);
});

test('Search Console authorization failures fail closed with a safe code', async () => {
  await assert.rejects(
    () => listSearchConsoleSites(ENV, googleFetch(async () => new Response('private provider error', { status: 403 }))),
    /SEARCH_CONSOLE_REQUEST_FAILED/
  );
});
