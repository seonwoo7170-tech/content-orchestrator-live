import { callHub } from './api-hub.js';
import { dateInTimeZone } from './daily-plan.js';

const SUMMARY_WINDOWS = Object.freeze([7, 28]);
const DETAIL_ROW_LIMIT = 500;
const HOST_DISCOVERY_DAYS = 365;

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function safeCode(error) {
  return String(error?.message || error || 'GA4_COLLECTION_FAILED')
    .split(/[:\s]/)[0]
    .replace(/[^A-Z0-9_]/gi, '_')
    .toUpperCase()
    .slice(0, 80) || 'GA4_COLLECTION_FAILED';
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    url.hash = '';
    url.search = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return { host: url.hostname, path, text: `${url.hostname}${path}` };
  } catch {
    return null;
  }
}

function normalizeHost(value) {
  const direct = normalizeUrl(value);
  if (direct?.host) return direct.host;
  return String(value || '').trim().toLowerCase().replace(/^www\./, '');
}

function isTistoryHost(value) {
  const host = normalizeHost(value);
  return host === 'tistory.com' || host.endsWith('.tistory.com');
}

function includesTistory(value) {
  return String(value || '').toLowerCase().includes('tistory');
}

export function bloggerOnlyAnalyticsProperties(properties = []) {
  return (Array.isArray(properties) ? properties : [])
    .filter((property) => !includesTistory(property?.displayName))
    .map((property) => ({
      ...property,
      dataStreams: (Array.isArray(property?.dataStreams) ? property.dataStreams : []).filter((stream) => {
        if (includesTistory(stream?.displayName) || includesTistory(stream?.defaultUri)) return false;
        return !isTistoryHost(stream?.defaultUri);
      })
    }));
}

export function resolveAnalyticsProperty(blog, properties = []) {
  const target = normalizeUrl(blog?.url);
  if (!target || isTistoryHost(target.host)) return null;
  const candidates = [];
  for (const property of bloggerOnlyAnalyticsProperties(properties)) {
    for (const stream of Array.isArray(property?.dataStreams) ? property.dataStreams : []) {
      const source = normalizeUrl(stream?.defaultUri);
      if (!source || source.host !== target.host) continue;
      let score = 2000;
      let matchType = 'host';
      if (target.path === source.path) {
        score = 3000 + source.path.length;
        matchType = 'exact_url';
      } else if (target.path.startsWith(source.path === '/' ? '/' : `${source.path}/`) || source.path.startsWith(target.path === '/' ? '/' : `${target.path}/`)) {
        score = 2500 + Math.min(target.path.length, source.path.length);
        matchType = 'url_prefix';
      }
      candidates.push({
        propertyId: String(property?.propertyId || String(property?.property || '').replace(/^properties\//, '')),
        propertyName: String(property?.displayName || ''),
        dataStreamId: String(stream?.dataStreamId || ''),
        defaultUri: String(stream?.defaultUri || ''),
        measurementId: String(stream?.measurementId || ''),
        matchType,
        score
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.propertyId.localeCompare(b.propertyId));
  const winner = candidates[0];
  if (!winner?.propertyId) return null;
  const { score, ...match } = winner;
  return match;
}

function shiftIsoDate(dateText, offsetDays) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function ga4DateRange(now = new Date(), windowDays = 28, lagDays = 1, timezone = 'Asia/Seoul') {
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 90) throw new Error('GA4_WINDOW_INVALID');
  if (!Number.isInteger(lagDays) || lagDays < 0 || lagDays > 7) throw new Error('GA4_LAG_INVALID');
  const today = dateInTimeZone(now, timezone);
  const endDate = shiftIsoDate(today, -lagDays);
  const startDate = shiftIsoDate(endDate, -(windowDays - 1));
  return { startDate, endDate };
}

function hostDiscoveryRange(now, timezone) {
  const today = dateInTimeZone(now, timezone);
  const endDate = shiftIsoDate(today, -1);
  const startDate = shiftIsoDate(endDate, -(HOST_DISCOVERY_DAYS - 1));
  return { startDate, endDate };
}

async function discoverHostProperties(env, blogs, properties, callHubFn, now, timezone) {
  const targets = new Map();
  for (const blog of blogs) {
    const host = normalizeUrl(blog?.url)?.host;
    if (host && !isTistoryHost(host)) targets.set(host, []);
  }
  if (!targets.size || !properties.length) return { winners: new Map(), failedPropertyCount: 0 };
  const range = hostDiscoveryRange(now, timezone);
  let failedPropertyCount = 0;
  for (const property of properties) {
    const propertyId = String(property?.propertyId || String(property?.property || '').replace(/^properties\//, ''));
    if (!/^\d+$/.test(propertyId)) continue;
    try {
      const report = await callHubFn(env, env.HUB_GA4_REPORT_PATH || '/api/ga4/report', {
        propertyId,
        ...range,
        dimensions: ['hostName'],
        metrics: ['sessions'],
        limit: 1000
      });
      for (const row of Array.isArray(report?.rows) ? report.rows : []) {
        const host = normalizeHost(row?.dimensions?.hostName);
        const sessions = Number(row?.metrics?.sessions || 0);
        if (!targets.has(host) || isTistoryHost(host) || sessions <= 0) continue;
        targets.get(host).push({
          propertyId,
          propertyName: String(property?.displayName || ''),
          dataStreamId: '',
          defaultUri: '',
          measurementId: '',
          matchType: 'hostname_data',
          sessions
        });
      }
    } catch {
      failedPropertyCount += 1;
    }
  }
  const winners = new Map();
  for (const [host, candidates] of targets.entries()) {
    const uniqueByProperty = [...new Map(candidates.map((candidate) => [candidate.propertyId, candidate])).values()];
    if (uniqueByProperty.length !== 1) continue;
    const { sessions, ...match } = uniqueByProperty[0];
    winners.set(host, match);
  }
  return { winners, failedPropertyCount };
}

async function persistProperty(env, blog, match) {
  const db = requireDb(env);
  await db.prepare(
    `INSERT INTO ga4_blog_properties
      (blog_id, blog_name, blog_url, property_id, property_name, data_stream_id, default_uri, measurement_id, match_type, matched_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(blog_id) DO UPDATE SET
       blog_name=excluded.blog_name, blog_url=excluded.blog_url, property_id=excluded.property_id,
       property_name=excluded.property_name, data_stream_id=excluded.data_stream_id,
       default_uri=excluded.default_uri, measurement_id=excluded.measurement_id,
       match_type=excluded.match_type, updated_at=datetime('now')`
  ).bind(
    String(blog.blogId), blog.name || null, blog.url || null,
    match?.propertyId || null, match?.propertyName || null, match?.dataStreamId || null,
    match?.defaultUri || null, match?.measurementId || null, match?.matchType || 'unmapped'
  ).run();
}

async function persistSnapshot(env, row) {
  const db = requireDb(env);
  await db.prepare(
    `INSERT INTO ga4_snapshots
      (snapshot_date, blog_id, window_days, property_id, start_date, end_date, status, error_code,
       active_users, total_users, sessions, engaged_sessions, engagement_rate, average_session_duration,
       screen_page_views, detail_row_count, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(snapshot_date, blog_id, window_days) DO UPDATE SET
       property_id=excluded.property_id, start_date=excluded.start_date, end_date=excluded.end_date,
       status=excluded.status, error_code=excluded.error_code, active_users=excluded.active_users,
       total_users=excluded.total_users, sessions=excluded.sessions, engaged_sessions=excluded.engaged_sessions,
       engagement_rate=excluded.engagement_rate, average_session_duration=excluded.average_session_duration,
       screen_page_views=excluded.screen_page_views, detail_row_count=excluded.detail_row_count,
       collected_at=datetime('now')`
  ).bind(
    row.snapshotDate, row.blogId, row.windowDays, row.propertyId || null, row.startDate || null, row.endDate || null,
    row.status, row.errorCode || null, Number(row.activeUsers || 0), Number(row.totalUsers || 0),
    Number(row.sessions || 0), Number(row.engagedSessions || 0), Number(row.engagementRate || 0),
    Number(row.averageSessionDuration || 0), Number(row.screenPageViews || 0), Number(row.detailRowCount || 0)
  ).run();
}

async function replaceDetailRows(env, snapshotDate, blogId, propertyId, startDate, endDate, rows = []) {
  const db = requireDb(env);
  await db.prepare('DELETE FROM ga4_landing_source_rows WHERE snapshot_date = ? AND blog_id = ?').bind(snapshotDate, blogId).run();
  const statements = rows.slice(0, DETAIL_ROW_LIMIT).map((row) => db.prepare(
    `INSERT OR REPLACE INTO ga4_landing_source_rows
      (snapshot_date, blog_id, property_id, start_date, end_date, landing_page, source_medium,
       active_users, sessions, engaged_sessions, engagement_rate, screen_page_views, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).bind(
    snapshotDate, blogId, propertyId, startDate, endDate,
    String(row?.dimensions?.landingPagePlusQueryString || ''), String(row?.dimensions?.sessionSourceMedium || ''),
    Number(row?.metrics?.activeUsers || 0), Number(row?.metrics?.sessions || 0),
    Number(row?.metrics?.engagedSessions || 0), Number(row?.metrics?.engagementRate || 0),
    Number(row?.metrics?.screenPageViews || 0)
  ));
  for (let index = 0; index < statements.length; index += 50) await db.batch(statements.slice(index, index + 50));
  return statements.length;
}

function summaryMetrics(data) {
  const metrics = data?.rows?.[0]?.metrics || {};
  return {
    activeUsers: Number(metrics.activeUsers || 0),
    totalUsers: Number(metrics.totalUsers || 0),
    sessions: Number(metrics.sessions || 0),
    engagedSessions: Number(metrics.engagedSessions || 0),
    engagementRate: Number(metrics.engagementRate || 0),
    averageSessionDuration: Number(metrics.averageSessionDuration || 0),
    screenPageViews: Number(metrics.screenPageViews || 0)
  };
}

async function collectOne(env, blog, match, snapshotDate, now, options) {
  const timezone = options.timezone || env.OPERATIONS_TIMEZONE || 'Asia/Seoul';
  const callHubFn = options.callHubFn || callHub;
  const persistPropertyFn = options.persistPropertyFn || persistProperty;
  const persistSnapshotFn = options.persistSnapshotFn || persistSnapshot;
  const replaceDetailRowsFn = options.replaceDetailRowsFn || replaceDetailRows;
  const hostNameFilter = normalizeUrl(blog?.url)?.host || null;
  const result = { blogId: String(blog.blogId), blogName: blog.name || null, propertyId: match?.propertyId || null, mapped: Boolean(match), matchType: match?.matchType || 'unmapped', status: match ? 'ok' : 'unmapped', windows: [] };
  await persistPropertyFn(env, blog, match);

  if (!match || !hostNameFilter || isTistoryHost(hostNameFilter)) {
    for (const windowDays of SUMMARY_WINDOWS) {
      const range = ga4DateRange(now, windowDays, 1, timezone);
      await persistSnapshotFn(env, { snapshotDate, blogId: result.blogId, windowDays, ...range, status: 'unmapped', errorCode: 'GA4_PROPERTY_UNMAPPED' });
      result.windows.push({ windowDays, ...range, status: 'unmapped' });
    }
    result.status = 'unmapped';
    result.mapped = false;
    return result;
  }

  for (const windowDays of SUMMARY_WINDOWS) {
    const range = ga4DateRange(now, windowDays, 1, timezone);
    try {
      const summary = await callHubFn(env, env.HUB_GA4_REPORT_PATH || '/api/ga4/report', { propertyId: match.propertyId, ...range, hostNameFilter });
      const metrics = summaryMetrics(summary);
      let detailRowCount = 0;
      let status = 'ok';
      let errorCode = null;
      if (windowDays === 28) {
        try {
          const detail = await callHubFn(env, env.HUB_GA4_REPORT_PATH || '/api/ga4/report', {
            propertyId: match.propertyId, ...range, hostNameFilter,
            dimensions: ['landingPagePlusQueryString', 'sessionSourceMedium'],
            metrics: ['activeUsers', 'sessions', 'engagedSessions', 'engagementRate', 'screenPageViews'],
            limit: DETAIL_ROW_LIMIT
          });
          detailRowCount = await replaceDetailRowsFn(env, snapshotDate, result.blogId, match.propertyId, range.startDate, range.endDate, detail?.rows || []);
        } catch (error) {
          status = 'partial';
          errorCode = safeCode(error);
        }
      }
      await persistSnapshotFn(env, { snapshotDate, blogId: result.blogId, windowDays, propertyId: match.propertyId, ...range, status, errorCode, ...metrics, detailRowCount });
      result.windows.push({ windowDays, ...range, status, errorCode, ...metrics, detailRowCount });
      if (status !== 'ok') result.status = 'partial';
    } catch (error) {
      const errorCode = safeCode(error);
      await persistSnapshotFn(env, { snapshotDate, blogId: result.blogId, windowDays, propertyId: match.propertyId, ...range, status: 'failed', errorCode });
      result.windows.push({ windowDays, ...range, status: 'failed', errorCode });
      result.status = 'partial';
    }
  }
  return result;
}

export async function collectAnalyticsForBlogs(env, blogs, options = {}) {
  if (!Array.isArray(blogs)) throw new Error('BLOG_LIST_INVALID');
  const normalizedBlogs = blogs
    .map((blog) => ({ ...blog, blogId: String(blog?.blogId || '').trim() }))
    .filter((blog) => blog.blogId && !isTistoryHost(blog?.url));
  const now = options.now || new Date();
  const timezone = options.timezone || env.OPERATIONS_TIMEZONE || 'Asia/Seoul';
  const snapshotDate = options.snapshotDate || dateInTimeZone(now, timezone);
  const callHubFn = options.callHubFn || callHub;
  const inventory = await callHubFn(env, env.HUB_GA4_PROPERTIES_PATH || '/api/ga4/properties', {});
  const inventoryProperties = Array.isArray(inventory?.properties) ? inventory.properties : [];
  const properties = bloggerOnlyAnalyticsProperties(inventoryProperties);
  const directMatches = new Map(normalizedBlogs.map((blog) => [blog.blogId, resolveAnalyticsProperty(blog, properties)]));
  const unresolved = normalizedBlogs.filter((blog) => !directMatches.get(blog.blogId));
  const discovery = unresolved.length
    ? await discoverHostProperties(env, unresolved, properties, callHubFn, now, timezone)
    : { winners: new Map(), failedPropertyCount: 0 };
  const items = [];
  for (const blog of normalizedBlogs) {
    const host = normalizeUrl(blog?.url)?.host || '';
    const match = directMatches.get(blog.blogId) || discovery.winners.get(host) || null;
    try {
      items.push(await collectOne(env, blog, match, snapshotDate, now, options));
    } catch (error) {
      items.push({ blogId: blog.blogId, blogName: blog?.name || null, propertyId: match?.propertyId || null, mapped: Boolean(match), matchType: match?.matchType || 'unmapped', status: 'failed', errorCode: safeCode(error), windows: [] });
    }
  }
  const partialCount = items.filter((item) => item.status === 'partial').length;
  const failedCount = items.filter((item) => item.status === 'failed').length;
  const unmappedCount = items.filter((item) => item.status === 'unmapped').length;
  return {
    ok: partialCount === 0 && failedCount === 0,
    coverageComplete: unmappedCount === 0,
    snapshotDate,
    propertyCount: properties.length,
    ignoredPropertyCount: Math.max(0, inventoryProperties.length - properties.length),
    webStreamCount: properties.reduce((sum, property) => sum + (Array.isArray(property?.dataStreams) ? property.dataStreams.length : 0), 0),
    blogCount: items.length,
    mappedCount: items.filter((item) => item.mapped).length,
    directMappedCount: items.filter((item) => ['exact_url', 'url_prefix', 'host'].includes(item.matchType)).length,
    hostnameMappedCount: items.filter((item) => item.matchType === 'hostname_data').length,
    okCount: items.filter((item) => item.status === 'ok').length,
    partialCount,
    failedCount,
    unmappedCount,
    hostnameDiscoveryFailedPropertyCount: discovery.failedPropertyCount,
    items
  };
}

export async function listAnalyticsStatus(env, snapshotDate) {
  const db = requireDb(env);
  const [properties, snapshots] = await Promise.all([
    db.prepare(`SELECT blog_id, blog_name, blog_url, property_id, property_name, data_stream_id, default_uri, measurement_id, match_type, updated_at FROM ga4_blog_properties ORDER BY blog_name COLLATE NOCASE, blog_id`).all(),
    db.prepare(`SELECT snapshot_date, blog_id, window_days, property_id, start_date, end_date, status, error_code, active_users, total_users, sessions, engaged_sessions, engagement_rate, average_session_duration, screen_page_views, detail_row_count, collected_at FROM ga4_snapshots WHERE snapshot_date = ? ORDER BY blog_id, window_days`).bind(snapshotDate).all()
  ]);
  return { snapshotDate, properties: properties.results || [], snapshots: snapshots.results || [] };
}

export async function listAnalyticsTopRows(env, snapshotDate, blogId, limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 50)));
  const db = requireDb(env);
  const rows = await db.prepare(`SELECT landing_page, source_medium, active_users, sessions, engaged_sessions, engagement_rate, screen_page_views FROM ga4_landing_source_rows WHERE snapshot_date = ? AND blog_id = ? ORDER BY sessions DESC, active_users DESC LIMIT ?`).bind(snapshotDate, String(blogId), safeLimit).all();
  return rows.results || [];
}
