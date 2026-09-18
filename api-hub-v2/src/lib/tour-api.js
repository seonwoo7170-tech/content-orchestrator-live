const DEFAULT_TOUR_API_BASE_URL = 'https://apis.data.go.kr/B551011/EngService2';
const DEFAULT_MOBILE_OS = 'ETC';
const DEFAULT_MOBILE_APP = 'SmileAtlas';
export const DEFAULT_ATTRACTION_CONTENT_TYPE_ID = '12';

// data.go.kr's own error codes for this API family. Non-"0000" codes are returned with
// HTTP 200 inside the JSON body, not as an HTTP error status, so the header must always
// be checked even on a successful fetch.
const RESULT_CODE_MESSAGES = Object.freeze({
  '01': 'TOUR_API_APPLICATION_ERROR',
  '02': 'TOUR_API_DB_ERROR',
  '03': 'TOUR_API_NODATA_ERROR',
  '04': 'TOUR_API_HTTP_ERROR',
  '05': 'TOUR_API_SERVICETIME_OUT',
  '10': 'TOUR_API_INVALID_REQUEST_PARAMETER_ERROR',
  '11': 'TOUR_API_NO_MANDATORY_REQUEST_PARAMETERS_ERROR',
  '12': 'TOUR_API_NO_OPENAPI_SERVICE_ERROR',
  '20': 'TOUR_API_SERVICE_ACCESS_DENIED_ERROR',
  '22': 'TOUR_API_LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR',
  '30': 'TOUR_API_SERVICE_KEY_IS_NOT_REGISTERED_ERROR',
  '31': 'TOUR_API_DEADLINE_HAS_EXPIRED_ERROR',
  '32': 'TOUR_API_UNREGISTERED_IP_ERROR',
  '33': 'TOUR_API_UNSIGNED_CALL_ERROR',
  '99': 'TOUR_API_UNKNOWN_ERROR'
});

function httpError(code, status = 502) {
  return Object.assign(new Error(code), { status });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// apis.data.go.kr (and any CDN in front of it) is known to intermittently return a bare
// gateway-timeout status with no body under load, especially on EngService2. These are
// transient, not a configuration problem, so retry a couple of times before giving up.
const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504, 522, 524]);

async function fetchWithRetry(url, fetchImpl, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url);
      if (response.ok || !TRANSIENT_HTTP_STATUSES.has(response.status)) return response;
      lastError = httpError(`TOUR_API_HTTP_${response.status}`, 502);
    } catch (cause) {
      lastError = Object.assign(httpError('TOUR_API_NETWORK_ERROR', 502), { cause });
    }
    if (attempt < attempts) await sleep(300 * attempt);
  }
  throw lastError;
}

export function tourApiConfigured(env) {
  return Boolean(String(env?.TOUR_API_KEY || '').trim());
}

function requiredKey(env) {
  const key = String(env?.TOUR_API_KEY || '').trim();
  if (!key) throw httpError('TOUR_API_KEY_REQUIRED', 503);
  return key;
}

function safeBaseUrl(env) {
  const raw = String(env?.TOUR_API_BASE_URL || DEFAULT_TOUR_API_BASE_URL).trim();
  let url;
  try { url = new URL(raw); } catch { throw httpError('TOUR_API_BASE_URL_INVALID', 500); }
  if (url.protocol !== 'https:' || url.hostname !== 'apis.data.go.kr') {
    throw httpError('TOUR_API_BASE_URL_NOT_ALLOWED', 500);
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function resultCodeError(resultCode, resultMsg) {
  const code = String(resultCode || '').trim();
  if (!code || code === '0000' || code === '00') return null;
  const mapped = RESULT_CODE_MESSAGES[code] || `TOUR_API_ERROR_${code}`;
  const error = new Error(mapped);
  error.status = code === '30' || code === '32' ? 401 : code === '22' ? 429 : 502;
  error.tourApiResultCode = code;
  error.tourApiResultMsg = String(resultMsg || '').slice(0, 200);
  return error;
}

// data.go.kr's gateway rejects a request (bad/unregistered key, quota, IP allowlist, etc.)
// *before* it reaches the actual service, and reports that using a completely different
// envelope than a normal service-level result: { cmmMsgHeader: { returnReasonCode,
// returnAuthMsg, errMsg } } instead of { response: { header: { resultCode, resultMsg } } }.
// Both use the same 01-99 reason-code table, so route it through the same classifier.
function gatewayFailure(data) {
  const header = data?.cmmMsgHeader;
  if (!header) return null;
  return resultCodeError(header.returnReasonCode, header.returnAuthMsg || header.errMsg);
}

async function callTourApi(env, operation, params = {}, fetchImpl = fetch) {
  const key = requiredKey(env);
  const base = safeBaseUrl(env);
  const query = new URLSearchParams({
    serviceKey: key,
    MobileOS: String(env?.TOUR_API_MOBILE_OS || DEFAULT_MOBILE_OS),
    MobileApp: String(env?.TOUR_API_MOBILE_APP || DEFAULT_MOBILE_APP),
    _type: 'json'
  });
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(name, String(value));
  }

  const response = await fetchWithRetry(`${base}/${operation}?${query.toString()}`, fetchImpl);
  const text = await response.text();
  if (!response.ok) throw httpError(`TOUR_API_HTTP_${response.status}`, 502);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // A malformed service key or an upstream fault can return a bare XML/SOAP body even
    // when _type=json was requested; treat that as an auth failure rather than a parse bug.
    throw httpError('TOUR_API_RESPONSE_NOT_JSON', 502);
  }

  const header = data?.response?.header;
  if (header) {
    const failure = resultCodeError(header.resultCode, header.resultMsg);
    if (failure) throw failure;
    return data?.response?.body || {};
  }

  const gwFailure = gatewayFailure(data);
  if (gwFailure) throw gwFailure;

  // Neither the normal { response: { header } } shape nor the gateway { cmmMsgHeader }
  // fault shape was present. Rather than collapsing to another opaque "UNKNOWN", report
  // the top-level keys we actually got so a real fix can follow instead of another guess.
  const keys = Object.keys(data || {}).slice(0, 10).join(',') || 'EMPTY_OBJECT';
  throw httpError(`TOUR_API_UNEXPECTED_RESPONSE_SHAPE:keys=${keys}`, 502);
}

export function normalizeTourApiItems(body) {
  const item = body?.items?.item;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

function cleanOverview(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

// detailCommon2's homepage field is commonly an <a href="...">label</a> snippet rather than
// a bare URL. Pull the href out before any tag-stripping cleanup discards it.
function extractHomepageUrl(value) {
  const raw = String(value || '');
  const hrefMatch = raw.match(/href\s*=\s*"([^"]+)"/i) || raw.match(/href\s*=\s*'([^']+)'/i);
  const candidate = hrefMatch ? hrefMatch[1] : cleanOverview(raw);
  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function normalizeAttractionSummary(item = {}) {
  const contentId = String(item?.contentid || '').trim();
  if (!contentId) return null;
  return {
    contentId,
    contentTypeId: String(item?.contenttypeid || '').trim() || null,
    title: cleanOverview(item?.title),
    address: firstNonEmpty(item?.addr1, item?.addr2),
    areaCode: String(item?.areacode || '').trim() || null,
    sigunguCode: String(item?.sigungucode || '').trim() || null,
    firstImage: firstNonEmpty(item?.firstimage, item?.firstimage2) || null,
    mapX: item?.mapx ? Number(item.mapx) : null,
    mapY: item?.mapy ? Number(item.mapy) : null,
    modifiedTime: String(item?.modifiedtime || '').trim() || null
  };
}

export function normalizeAttractionImages(items = []) {
  return items
    .map((item) => firstNonEmpty(item?.originimgurl, item?.smallimageurl))
    .filter(Boolean)
    .filter((url, index, all) => all.indexOf(url) === index);
}

export function buildTourApiSourceUrl(contentId) {
  return `https://apis.data.go.kr/B551011/EngService2/detailCommon2?contentId=${encodeURIComponent(contentId)}`;
}

export function buildTourApiResearch(attraction) {
  const facts = [
    attraction.title && `Name: ${attraction.title}`,
    attraction.address && `Address: ${attraction.address}`,
    attraction.overview && `Official overview: ${attraction.overview}`,
    attraction.homepage && `Official homepage: ${attraction.homepage}`,
    attraction.telephone && `Contact: ${attraction.telephone}`
  ].filter(Boolean).join('\n');

  return {
    requested: true,
    used: true,
    provider: 'tour-api',
    retrievedAt: new Date().toISOString(),
    resultCount: 1,
    results: [{
      title: `${attraction.title} — Korea Tourism Organization official listing`,
      url: buildTourApiSourceUrl(attraction.contentId),
      content: facts.slice(0, 3000),
      score: null,
      publishedDate: attraction.modifiedTime || null
    }]
  };
}

export async function listAreaBasedAttractions(env, {
  areaCode,
  sigunguCode,
  contentTypeId = DEFAULT_ATTRACTION_CONTENT_TYPE_ID,
  numOfRows = 20,
  pageNo = 1
} = {}, fetchImpl = fetch) {
  const body = await callTourApi(env, 'areaBasedList2', {
    areaCode, sigunguCode, contentTypeId, numOfRows, pageNo,
    arrange: 'A', listYN: 'Y'
  }, fetchImpl);
  return normalizeTourApiItems(body).map(normalizeAttractionSummary).filter(Boolean);
}

export async function getAttractionDetail(env, { contentId, contentTypeId } = {}, fetchImpl = fetch) {
  const id = String(contentId || '').trim();
  if (!id) throw httpError('TOUR_API_CONTENT_ID_REQUIRED', 400);

  const commonBody = await callTourApi(env, 'detailCommon2', {
    contentId: id,
    contentTypeId,
    defaultYN: 'Y',
    firstImageYN: 'Y',
    areacodeYN: 'Y',
    addrinfoYN: 'Y',
    mapinfoYN: 'Y',
    overviewYN: 'Y'
  }, fetchImpl);
  const common = normalizeTourApiItems(commonBody)[0] || {};

  let images = [];
  try {
    const imageBody = await callTourApi(env, 'detailImage2', { contentId: id, imageYN: 'Y' }, fetchImpl);
    images = normalizeAttractionImages(normalizeTourApiItems(imageBody));
  } catch {
    images = [];
  }

  const summary = normalizeAttractionSummary(common);
  if (!summary) throw httpError('TOUR_API_ATTRACTION_NOT_FOUND', 404);

  return {
    ...summary,
    overview: cleanOverview(common?.overview),
    homepage: extractHomepageUrl(common?.homepage),
    telephone: firstNonEmpty(common?.tel),
    images: [summary.firstImage, ...images].filter(Boolean).filter((url, index, all) => all.indexOf(url) === index)
  };
}
