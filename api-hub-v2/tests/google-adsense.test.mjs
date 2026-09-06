import test from 'node:test';
import assert from 'node:assert/strict';
import { listAdsenseAccounts, listAdsenseSites, normalizeAdsenseReportQuery, queryAdsenseReport } from '../src/lib/google-adsense.js';

const ENV = { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', GOOGLE_REFRESH_TOKEN: 'refresh-token' };
function googleFetch(routes) {
  return async (url, init = {}) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
    return routes(String(url), init);
  };
}

test('AdSense report validation allows only bounded read-only dimensions and metrics', () => {
  assert.deepEqual(normalizeAdsenseReportQuery({ account: 'pub-123', startDate: '2026-08-01', endDate: '2026-08-28', dimensions: ['DOMAIN_CODE'], metrics: ['PAGE_VIEWS', 'ESTIMATED_EARNINGS'] }), {
    account: 'accounts/pub-123', startDate: '2026-08-01', endDate: '2026-08-28', dimensions: ['DOMAIN_CODE'], metrics: ['PAGE_VIEWS', 'ESTIMATED_EARNINGS'], limit: 1000
  });
  assert.deepEqual(normalizeAdsenseReportQuery({ account: 'pub-123', startDate: '2026-08-31', endDate: '2026-08-31', dimensions: ['PAGE_URL'], metrics: ['PAGE_VIEWS', 'ESTIMATED_EARNINGS', 'PAGE_VIEWS_RPM'], limit: 10000 }), {
    account: 'accounts/pub-123', startDate: '2026-08-31', endDate: '2026-08-31', dimensions: ['PAGE_URL'], metrics: ['PAGE_VIEWS', 'ESTIMATED_EARNINGS', 'PAGE_VIEWS_RPM'], limit: 10000
  });
  assert.throws(() => normalizeAdsenseReportQuery({ account: '../bad', startDate: '2026-08-01', endDate: '2026-08-02' }), /ADSENSE_ACCOUNT_INVALID/);
  assert.throws(() => normalizeAdsenseReportQuery({ account: 'pub-1', startDate: '2026-08-02', endDate: '2026-08-01' }), /ADSENSE_DATE_RANGE_INVALID/);
  assert.throws(() => normalizeAdsenseReportQuery({ account: 'pub-1', startDate: '2026-08-01', endDate: '2026-08-02', dimensions: ['COUNTRY_CODE'] }), /ADSENSE_DIMENSIONS_INVALID/);
  assert.throws(() => normalizeAdsenseReportQuery({ account: 'pub-1', startDate: '2026-08-01', endDate: '2026-08-02', metrics: ['TOTAL_EARNINGS'] }), /ADSENSE_METRICS_INVALID/);
});

test('AdSense accounts and sites are normalized without provider payload leakage', async () => {
  const accounts = await listAdsenseAccounts(ENV, googleFetch(async (url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.authorization, 'Bearer access-token');
    assert.match(url, /^https:\/\/adsense\.googleapis\.com\/v2\/accounts\?/);
    return new Response(JSON.stringify({ accounts: [{ name:'accounts/pub-123', displayName:'Main', state:'READY', timeZone:{id:'Asia/Seoul'}, createTime:'2020-01-01T00:00:00Z', private:'discard' }] }), { status: 200 });
  }));
  assert.deepEqual(accounts, { ok:true, accounts:[{ name:'accounts/pub-123', displayName:'Main', state:'READY', timeZone:'Asia/Seoul', createTime:'2020-01-01T00:00:00Z' }], count:1 });

  const sites = await listAdsenseSites(ENV, { account:'accounts/pub-123' }, googleFetch(async (url) => {
    assert.match(url, /^https:\/\/adsense\.googleapis\.com\/v2\/accounts\/pub-123\/sites\?/);
    return new Response(JSON.stringify({ sites:[{ name:'accounts/pub-123/sites/1', reportingDimensionId:'ca-site-1', domain:'WWW.Example.com', state:'READY', autoAdsEnabled:true, private:'discard' }] }), { status:200 });
  }));
  assert.deepEqual(sites.sites[0], { name:'accounts/pub-123/sites/1', reportingDimensionId:'ca-site-1', domain:'example.com', state:'READY', autoAdsEnabled:true });
});

test('AdSense report generates custom account-timezone query and parses numeric cells', async () => {
  const result = await queryAdsenseReport(ENV, {
    account:'accounts/pub-123', startDate:'2026-08-01', endDate:'2026-08-28', dimensions:['DOMAIN_CODE'], metrics:['PAGE_VIEWS','CLICKS','ESTIMATED_EARNINGS','PAGE_VIEWS_RPM'], limit:50
  }, googleFetch(async (raw, init) => {
    const url = new URL(raw);
    assert.equal(init.method, 'GET');
    assert.equal(url.pathname, '/v2/accounts/pub-123/reports:generate');
    assert.equal(url.searchParams.get('dateRange'), 'CUSTOM');
    assert.equal(url.searchParams.get('reportingTimeZone'), 'ACCOUNT_TIME_ZONE');
    assert.equal(url.searchParams.get('startDate.year'), '2026');
    assert.deepEqual(url.searchParams.getAll('dimensions'), ['DOMAIN_CODE']);
    assert.deepEqual(url.searchParams.getAll('metrics'), ['PAGE_VIEWS','CLICKS','ESTIMATED_EARNINGS','PAGE_VIEWS_RPM']);
    return new Response(JSON.stringify({
      totalMatchedRows:'1',
      headers:[
        {name:'DOMAIN_CODE',type:'DIMENSION'},
        {name:'PAGE_VIEWS',type:'METRIC_TALLY'},
        {name:'CLICKS',type:'METRIC_TALLY'},
        {name:'ESTIMATED_EARNINGS',type:'METRIC_CURRENCY',currencyCode:'USD'},
        {name:'PAGE_VIEWS_RPM',type:'METRIC_CURRENCY',currencyCode:'USD'}
      ],
      rows:[{cells:[{value:'example.com'},{value:'100'},{value:'3'},{value:'1.25'},{value:'12.5'}]}],
      totals:{cells:[{value:''},{value:'100'},{value:'3'},{value:'1.25'},{value:'12.5'}]},
      warnings:['safe warning ignored']
    }), { status:200 });
  }));
  assert.deepEqual(result.rows[0], {
    dimensions:{DOMAIN_CODE:'example.com'},
    metrics:{PAGE_VIEWS:100,CLICKS:3,ESTIMATED_EARNINGS:1.25,PAGE_VIEWS_RPM:12.5},
    currencyCodes:{ESTIMATED_EARNINGS:'USD',PAGE_VIEWS_RPM:'USD'}
  });
  assert.equal(result.warningCount, 1);
  assert.equal(result.totals.metrics.ESTIMATED_EARNINGS, 1.25);
});

test('AdSense PAGE_URL report is forwarded as a read-only dimension', async () => {
  const result = await queryAdsenseReport(ENV, {
    account:'accounts/pub-123', startDate:'2026-08-31', endDate:'2026-08-31', dimensions:['PAGE_URL'], metrics:['PAGE_VIEWS','ESTIMATED_EARNINGS','PAGE_VIEWS_RPM'], limit:10
  }, googleFetch(async (raw) => {
    const url = new URL(raw);
    assert.deepEqual(url.searchParams.getAll('dimensions'), ['PAGE_URL']);
    return new Response(JSON.stringify({
      headers:[
        {name:'PAGE_URL',type:'DIMENSION'},
        {name:'PAGE_VIEWS',type:'METRIC_TALLY'},
        {name:'ESTIMATED_EARNINGS',type:'METRIC_CURRENCY',currencyCode:'USD'},
        {name:'PAGE_VIEWS_RPM',type:'METRIC_CURRENCY',currencyCode:'USD'}
      ],
      rows:[{cells:[{value:'https://example.com/post'},{value:'10'},{value:'2.5'},{value:'250'}]}]
    }), { status:200 });
  }));
  assert.equal(result.rows[0].dimensions.PAGE_URL, 'https://example.com/post');
  assert.equal(result.rows[0].metrics.PAGE_VIEWS_RPM, 250);
});

test('AdSense provider errors fail closed with safe codes', async () => {
  await assert.rejects(() => listAdsenseAccounts(ENV, googleFetch(async () => new Response('private', {status:403}))), /ADSENSE_ACCOUNTS_REQUEST_FAILED/);
  await assert.rejects(() => queryAdsenseReport(ENV, {account:'pub-1',startDate:'2026-08-01',endDate:'2026-08-02'}, googleFetch(async () => new Response('private', {status:500}))), /ADSENSE_REPORT_REQUEST_FAILED/);
});
