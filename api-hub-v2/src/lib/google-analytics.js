import { getGoogleAccessToken } from './google-oauth.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const ALLOWED_DIMENSIONS = new Set(['hostName', 'landingPagePlusQueryString', 'sessionSourceMedium', 'pagePathPlusQueryString', 'sessionDefaultChannelGroup']);
const ALLOWED_METRICS = new Set(['activeUsers', 'totalUsers', 'sessions', 'engagedSessions', 'engagementRate', 'averageSessionDuration', 'screenPageViews']);
const DEFAULT_METRICS = Object.freeze(['activeUsers', 'totalUsers', 'sessions', 'engagedSessions', 'engagementRate', 'averageSessionDuration', 'screenPageViews']);

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw Object.assign(new Error(code), { status: 400 });
  return text;
}

function validDate(value, code) {
  const text = requiredText(value, code);
  if (!DATE_PATTERN.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw Object.assign(new Error(code), { status: 400 });
  return text;
}

function propertyIdOf(value) {
  const text = requiredText(value, 'ANALYTICS_PROPERTY_REQUIRED');
  const id = text.replace(/^properties\//, '');
  if (!/^\d+$/.test(id)) throw Object.assign(new Error('ANALYTICS_PROPERTY_INVALID'), { status: 400 });
  return id;
}

function normalizeHostFilter(value) {
  if (value === undefined || value === null || value === '') return null;
  const host = String(value).trim().toLowerCase().replace(/^www\./, '');
  if (!HOST_PATTERN.test(host)) throw Object.assign(new Error('ANALYTICS_HOST_FILTER_INVALID'), { status: 400 });
  return host;
}

function safeProviderError(code, response) {
  const error = new Error(code);
  error.status = response?.status === 401 || response?.status === 403 ? 403 : 502;
  error.providerStatus = Number(response?.status || 0) || null;
  return error;
}

async function googleJson(url, init, accessToken, fetchImpl, code) {
  const response = await fetchImpl(url, {
    ...init,
    headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers || {}) }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) throw safeProviderError(code, response);
  return data || {};
}

async function accountSummaries(accessToken, fetchImpl) {
  const rows = [];
  let pageToken = '';
  do {
    const url = new URL('https://analyticsadmin.googleapis.com/v1beta/accountSummaries');
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await googleJson(url.toString(), { method: 'GET' }, accessToken, fetchImpl, 'ANALYTICS_ADMIN_REQUEST_FAILED');
    rows.push(...(Array.isArray(data.accountSummaries) ? data.accountSummaries : []));
    pageToken = String(data.nextPageToken || '');
  } while (pageToken);
  return rows;
}

async function webDataStreams(property, accessToken, fetchImpl) {
  const streams = [];
  let pageToken = '';
  do {
    const url = new URL(`https://analyticsadmin.googleapis.com/v1beta/${property}/dataStreams`);
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await googleJson(url.toString(), { method: 'GET' }, accessToken, fetchImpl, 'ANALYTICS_ADMIN_REQUEST_FAILED');
    for (const stream of Array.isArray(data.dataStreams) ? data.dataStreams : []) {
      if (String(stream?.type || '') !== 'WEB_DATA_STREAM') continue;
      const name = String(stream?.name || '');
      streams.push({ name, dataStreamId: name.split('/').pop() || '', displayName: String(stream?.displayName || ''), defaultUri: String(stream?.webStreamData?.defaultUri || ''), measurementId: String(stream?.webStreamData?.measurementId || ''), type: 'WEB_DATA_STREAM' });
    }
    pageToken = String(data.nextPageToken || '');
  } while (pageToken);
  return streams;
}

export async function listAnalyticsProperties(env, fetchImpl = fetch) {
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const summaries = await accountSummaries(accessToken, fetchImpl);
  const properties = [];
  for (const account of summaries) for (const property of Array.isArray(account?.propertySummaries) ? account.propertySummaries : []) {
    const propertyName = String(property?.property || '');
    if (!/^properties\/\d+$/.test(propertyName)) continue;
    properties.push({ property: propertyName, propertyId: propertyName.replace('properties/', ''), displayName: String(property?.displayName || ''), account: String(account?.account || ''), accountDisplayName: String(account?.displayName || ''), dataStreams: await webDataStreams(propertyName, accessToken, fetchImpl) });
  }
  return { ok: true, properties, count: properties.length, webStreamCount: properties.reduce((sum, item) => sum + item.dataStreams.length, 0) };
}

export function normalizeAnalyticsReportQuery(input = {}) {
  const propertyId = propertyIdOf(input.propertyId || input.property);
  const startDate = validDate(input.startDate, 'ANALYTICS_START_DATE_INVALID');
  const endDate = validDate(input.endDate, 'ANALYTICS_END_DATE_INVALID');
  if (startDate > endDate) throw Object.assign(new Error('ANALYTICS_DATE_RANGE_INVALID'), { status: 400 });
  const dimensions = Array.isArray(input.dimensions) ? input.dimensions.map(String) : [];
  if (dimensions.length > 2 || dimensions.some((name) => !ALLOWED_DIMENSIONS.has(name))) throw Object.assign(new Error('ANALYTICS_DIMENSIONS_INVALID'), { status: 400 });
  const metrics = Array.isArray(input.metrics) && input.metrics.length ? input.metrics.map(String) : [...DEFAULT_METRICS];
  if (metrics.length > DEFAULT_METRICS.length || metrics.some((name) => !ALLOWED_METRICS.has(name))) throw Object.assign(new Error('ANALYTICS_METRICS_INVALID'), { status: 400 });
  const limit = Number(input.limit ?? (dimensions.length ? 500 : 1));
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw Object.assign(new Error('ANALYTICS_LIMIT_INVALID'), { status: 400 });
  const offset = Number(input.offset ?? 0);
  if (!Number.isInteger(offset) || offset < 0) throw Object.assign(new Error('ANALYTICS_OFFSET_INVALID'), { status: 400 });
  const hostNameFilter = normalizeHostFilter(input.hostNameFilter);
  return { propertyId, startDate, endDate, dimensions, metrics, limit, offset, hostNameFilter };
}

export async function queryAnalyticsReport(env, input, fetchImpl = fetch) {
  const query = normalizeAnalyticsReportQuery(input);
  const body = {
    dateRanges: [{ startDate: query.startDate, endDate: query.endDate }],
    dimensions: query.dimensions.map((name) => ({ name })),
    metrics: query.metrics.map((name) => ({ name })),
    limit: String(query.limit), offset: String(query.offset), keepEmptyRows: false
  };
  if (query.hostNameFilter) body.dimensionFilter = { filter: { fieldName: 'hostName', stringFilter: { matchType: 'EXACT', value: query.hostNameFilter, caseSensitive: false } } };
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const data = await googleJson(`https://analyticsdata.googleapis.com/v1beta/properties/${query.propertyId}:runReport`, { method: 'POST', body: JSON.stringify(body) }, accessToken, fetchImpl, 'ANALYTICS_DATA_REQUEST_FAILED');
  const dimensionHeaders = (Array.isArray(data.dimensionHeaders) ? data.dimensionHeaders : []).map((header) => String(header?.name || ''));
  const metricHeaders = (Array.isArray(data.metricHeaders) ? data.metricHeaders : []).map((header) => String(header?.name || ''));
  const rows = (Array.isArray(data.rows) ? data.rows : []).map((row) => ({ dimensions: Object.fromEntries(dimensionHeaders.map((name, index) => [name, String(row?.dimensionValues?.[index]?.value || '')])), metrics: Object.fromEntries(metricHeaders.map((name, index) => [name, Number(row?.metricValues?.[index]?.value || 0)])) }));
  return { ok: true, propertyId: query.propertyId, startDate: query.startDate, endDate: query.endDate, dimensions: query.dimensions, metrics: query.metrics, hostNameFilter: query.hostNameFilter, rows, count: rows.length, rowCount: Number(data.rowCount || rows.length) };
}
