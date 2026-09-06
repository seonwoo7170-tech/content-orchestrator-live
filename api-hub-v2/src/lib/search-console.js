import { getGoogleAccessToken } from './google-oauth.js';

const ALLOWED_DIMENSIONS = new Set(['query', 'page', 'country', 'device', 'date', 'searchAppearance']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw Object.assign(new Error(code), { status: 400 });
  return text;
}

function validDate(value, code) {
  const text = requiredText(value, code);
  if (!DATE_PATTERN.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw Object.assign(new Error(code), { status: 400 });
  }
  return text;
}

function safeProviderError(code, response) {
  const error = new Error(code);
  error.status = response?.status === 401 || response?.status === 403 ? 403 : 502;
  error.providerStatus = Number(response?.status || 0) || null;
  return error;
}

async function googleJson(url, init, accessToken, fetchImpl) {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) throw safeProviderError('SEARCH_CONSOLE_REQUEST_FAILED', response);
  return data || {};
}

export function normalizeSearchConsoleQuery(input = {}) {
  const siteUrl = requiredText(input.siteUrl, 'SEARCH_CONSOLE_SITE_URL_REQUIRED');
  const startDate = validDate(input.startDate, 'SEARCH_CONSOLE_START_DATE_INVALID');
  const endDate = validDate(input.endDate, 'SEARCH_CONSOLE_END_DATE_INVALID');
  if (startDate > endDate) throw Object.assign(new Error('SEARCH_CONSOLE_DATE_RANGE_INVALID'), { status: 400 });

  const aggregateOnly = input.aggregateOnly === true;
  const dimensions = aggregateOnly
    ? []
    : (Array.isArray(input.dimensions) && input.dimensions.length ? input.dimensions.map(String) : ['query', 'page']);
  if (dimensions.length > 5 || dimensions.some((dimension) => !ALLOWED_DIMENSIONS.has(dimension))) {
    throw Object.assign(new Error('SEARCH_CONSOLE_DIMENSIONS_INVALID'), { status: 400 });
  }

  const rowLimit = Number(input.rowLimit ?? (aggregateOnly ? 1 : 2500));
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 25000) {
    throw Object.assign(new Error('SEARCH_CONSOLE_ROW_LIMIT_INVALID'), { status: 400 });
  }

  const startRow = Number(input.startRow ?? 0);
  if (!Number.isInteger(startRow) || startRow < 0) throw Object.assign(new Error('SEARCH_CONSOLE_START_ROW_INVALID'), { status: 400 });

  return { siteUrl, startDate, endDate, dimensions, rowLimit, startRow, aggregateOnly };
}

export async function listSearchConsoleSites(env, fetchImpl = fetch) {
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const data = await googleJson('https://www.googleapis.com/webmasters/v3/sites', { method: 'GET' }, accessToken, fetchImpl);
  const sites = (Array.isArray(data.siteEntry) ? data.siteEntry : [])
    .map((entry) => ({ siteUrl: String(entry?.siteUrl || ''), permissionLevel: String(entry?.permissionLevel || '') }))
    .filter((entry) => entry.siteUrl);
  return { ok: true, sites, count: sites.length };
}

export async function querySearchConsolePerformance(env, input, fetchImpl = fetch) {
  const query = normalizeSearchConsoleQuery(input);
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(query.siteUrl)}/searchAnalytics/query`;
  const data = await googleJson(url, {
    method: 'POST',
    body: JSON.stringify({
      startDate: query.startDate,
      endDate: query.endDate,
      ...(query.dimensions.length ? { dimensions: query.dimensions } : {}),
      rowLimit: query.rowLimit,
      startRow: query.startRow,
      dataState: 'final'
    })
  }, accessToken, fetchImpl);

  const rows = (Array.isArray(data.rows) ? data.rows : []).map((row) => {
    const keys = Array.isArray(row?.keys) ? row.keys : [];
    return {
      dimensions: Object.fromEntries(query.dimensions.map((dimension, index) => [dimension, String(keys[index] ?? '')])),
      clicks: Number(row?.clicks || 0),
      impressions: Number(row?.impressions || 0),
      ctr: Number(row?.ctr || 0),
      position: Number(row?.position || 0)
    };
  });

  return {
    ok: true,
    siteUrl: query.siteUrl,
    startDate: query.startDate,
    endDate: query.endDate,
    dimensions: query.dimensions,
    aggregateOnly: query.aggregateOnly,
    rowLimit: query.rowLimit,
    startRow: query.startRow,
    rows,
    count: rows.length
  };
}
