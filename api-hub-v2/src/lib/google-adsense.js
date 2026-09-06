import { getGoogleAccessToken } from './google-oauth.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_PATTERN = /^accounts\/[A-Za-z0-9_-]+$/;
const ALLOWED_DIMENSIONS = new Set(['DATE', 'OWNED_SITE_DOMAIN_NAME', 'DOMAIN_CODE', 'PAGE_URL']);
const ALLOWED_METRICS = new Set(['PAGE_VIEWS', 'AD_REQUESTS', 'MATCHED_AD_REQUESTS', 'IMPRESSIONS', 'CLICKS', 'ESTIMATED_EARNINGS', 'PAGE_VIEWS_RPM']);
const DEFAULT_METRICS = Object.freeze(['PAGE_VIEWS', 'IMPRESSIONS', 'CLICKS', 'ESTIMATED_EARNINGS', 'PAGE_VIEWS_RPM']);

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw Object.assign(new Error(code), { status: 400 });
  return text;
}

function accountNameOf(value) {
  const raw = requiredText(value, 'ADSENSE_ACCOUNT_REQUIRED');
  const name = raw.startsWith('accounts/') ? raw : `accounts/${raw}`;
  if (!ACCOUNT_PATTERN.test(name)) throw Object.assign(new Error('ADSENSE_ACCOUNT_INVALID'), { status: 400 });
  return name;
}

function validDate(value, code) {
  const text = requiredText(value, code);
  if (!DATE_PATTERN.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw Object.assign(new Error(code), { status: 400 });
  return text;
}

function dateParts(text) {
  const [year, month, day] = text.split('-').map(Number);
  return { year, month, day };
}

function safeProviderError(code, response) {
  const error = new Error(code);
  error.status = response?.status === 401 || response?.status === 403 ? 403 : 502;
  error.providerStatus = Number(response?.status || 0) || null;
  return error;
}

async function googleJson(url, accessToken, fetchImpl, code) {
  const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` } });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) throw safeProviderError(code, response);
  return data || {};
}

export async function listAdsenseAccounts(env, fetchImpl = fetch) {
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const accounts = [];
  let pageToken = '';
  do {
    const url = new URL('https://adsense.googleapis.com/v2/accounts');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await googleJson(url.toString(), accessToken, fetchImpl, 'ADSENSE_ACCOUNTS_REQUEST_FAILED');
    for (const account of Array.isArray(data.accounts) ? data.accounts : []) {
      const name = String(account?.name || '');
      if (!ACCOUNT_PATTERN.test(name)) continue;
      accounts.push({
        name,
        displayName: String(account?.displayName || ''),
        state: String(account?.state || ''),
        timeZone: String(account?.timeZone?.id || account?.timeZone || ''),
        createTime: String(account?.createTime || '')
      });
    }
    pageToken = String(data.nextPageToken || '');
  } while (pageToken);
  return { ok: true, accounts, count: accounts.length };
}

export async function listAdsenseSites(env, input = {}, fetchImpl = fetch) {
  const account = accountNameOf(input.account);
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const sites = [];
  let pageToken = '';
  do {
    const url = new URL(`https://adsense.googleapis.com/v2/${account}/sites`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await googleJson(url.toString(), accessToken, fetchImpl, 'ADSENSE_SITES_REQUEST_FAILED');
    for (const site of Array.isArray(data.sites) ? data.sites : []) {
      sites.push({
        name: String(site?.name || ''),
        reportingDimensionId: String(site?.reportingDimensionId || ''),
        domain: String(site?.domain || '').toLowerCase().replace(/^www\./, ''),
        state: String(site?.state || ''),
        autoAdsEnabled: Boolean(site?.autoAdsEnabled)
      });
    }
    pageToken = String(data.nextPageToken || '');
  } while (pageToken);
  return { ok: true, account, sites, count: sites.length };
}

export function normalizeAdsenseReportQuery(input = {}) {
  const account = accountNameOf(input.account);
  const startDate = validDate(input.startDate, 'ADSENSE_START_DATE_INVALID');
  const endDate = validDate(input.endDate, 'ADSENSE_END_DATE_INVALID');
  if (startDate > endDate) throw Object.assign(new Error('ADSENSE_DATE_RANGE_INVALID'), { status: 400 });
  const dimensions = Array.isArray(input.dimensions) ? input.dimensions.map(String) : [];
  if (dimensions.length > 2 || dimensions.some((name) => !ALLOWED_DIMENSIONS.has(name))) throw Object.assign(new Error('ADSENSE_DIMENSIONS_INVALID'), { status: 400 });
  const metrics = Array.isArray(input.metrics) && input.metrics.length ? input.metrics.map(String) : [...DEFAULT_METRICS];
  if (metrics.length > ALLOWED_METRICS.size || metrics.some((name) => !ALLOWED_METRICS.has(name))) throw Object.assign(new Error('ADSENSE_METRICS_INVALID'), { status: 400 });
  const limit = Number(input.limit ?? 1000);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw Object.assign(new Error('ADSENSE_LIMIT_INVALID'), { status: 400 });
  return { account, startDate, endDate, dimensions, metrics, limit };
}

function parseRow(headers, row) {
  const dimensions = {};
  const metrics = {};
  const currencyCodes = {};
  const cells = Array.isArray(row?.cells) ? row.cells : [];
  headers.forEach((header, index) => {
    const value = String(cells[index]?.value ?? '');
    if (header.type === 'DIMENSION') dimensions[header.name] = value;
    else {
      metrics[header.name] = Number(value || 0);
      if (header.currencyCode) currencyCodes[header.name] = header.currencyCode;
    }
  });
  return { dimensions, metrics, currencyCodes };
}

export async function queryAdsenseReport(env, input = {}, fetchImpl = fetch) {
  const query = normalizeAdsenseReportQuery(input);
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const start = dateParts(query.startDate);
  const end = dateParts(query.endDate);
  const url = new URL(`https://adsense.googleapis.com/v2/${query.account}/reports:generate`);
  url.searchParams.set('dateRange', 'CUSTOM');
  url.searchParams.set('reportingTimeZone', 'ACCOUNT_TIME_ZONE');
  url.searchParams.set('startDate.year', String(start.year));
  url.searchParams.set('startDate.month', String(start.month));
  url.searchParams.set('startDate.day', String(start.day));
  url.searchParams.set('endDate.year', String(end.year));
  url.searchParams.set('endDate.month', String(end.month));
  url.searchParams.set('endDate.day', String(end.day));
  for (const dimension of query.dimensions) url.searchParams.append('dimensions', dimension);
  for (const metric of query.metrics) url.searchParams.append('metrics', metric);
  url.searchParams.set('limit', String(query.limit));
  const data = await googleJson(url.toString(), accessToken, fetchImpl, 'ADSENSE_REPORT_REQUEST_FAILED');
  const headers = (Array.isArray(data.headers) ? data.headers : []).map((header) => ({
    name: String(header?.name || ''),
    type: String(header?.type || ''),
    currencyCode: String(header?.currencyCode || '')
  }));
  const rows = (Array.isArray(data.rows) ? data.rows : []).map((row) => parseRow(headers, row));
  return {
    ok: true,
    account: query.account,
    startDate: query.startDate,
    endDate: query.endDate,
    dimensions: query.dimensions,
    metrics: query.metrics,
    rows,
    totals: data.totals ? parseRow(headers, data.totals) : { dimensions: {}, metrics: {}, currencyCodes: {} },
    count: rows.length,
    totalMatchedRows: Number(data.totalMatchedRows || rows.length),
    warningCount: Array.isArray(data.warnings) ? data.warnings.length : 0
  };
}
