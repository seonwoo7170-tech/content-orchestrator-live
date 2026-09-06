import { callHub } from './api-hub.js';
import { dateInTimeZone } from './daily-plan.js';

const DETAIL_ROW_LIMIT = 500;
const SUMMARY_WINDOWS = Object.freeze([7, 28]);

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function safeCode(error) {
  return String(error?.message || error || 'GSC_COLLECTION_FAILED')
    .split(/[:\s]/)[0]
    .replace(/[^A-Z0-9_]/gi, '_')
    .toUpperCase()
    .slice(0, 80) || 'GSC_COLLECTION_FAILED';
}

function hostOf(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function normalizedUrlPrefix(value) {
  try {
    const url = new URL(String(value || ''));
    url.hash = '';
    url.search = '';
    const text = url.toString();
    return text.endsWith('/') ? text : `${text}/`;
  } catch {
    return '';
  }
}

export function resolveSearchConsoleProperty(blog, sites = []) {
  const blogUrl = String(blog?.url || '').trim();
  const blogHost = hostOf(blogUrl);
  const normalizedBlogUrl = normalizedUrlPrefix(blogUrl);
  if (!blogHost || !normalizedBlogUrl) return null;

  const candidates = [];
  for (const site of sites || []) {
    const siteUrl = String(site?.siteUrl || '').trim();
    if (!siteUrl) continue;
    if (siteUrl.startsWith('sc-domain:')) {
      const domain = siteUrl.slice('sc-domain:'.length).toLowerCase().replace(/^www\./, '');
      if (domain && (blogHost === domain || blogHost.endsWith(`.${domain}`))) {
        candidates.push({
          siteUrl,
          permissionLevel: String(site?.permissionLevel || ''),
          matchType: 'domain',
          score: 1000 + domain.length
        });
      }
      continue;
    }
    const prefix = normalizedUrlPrefix(siteUrl);
    if (prefix && normalizedBlogUrl.startsWith(prefix)) {
      candidates.push({
        siteUrl,
        permissionLevel: String(site?.permissionLevel || ''),
        matchType: 'url_prefix',
        score: 2000 + prefix.length
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.siteUrl.length - a.siteUrl.length || a.siteUrl.localeCompare(b.siteUrl));
  const winner = candidates[0];
  if (!winner) return null;
  return {
    siteUrl: winner.siteUrl,
    permissionLevel: winner.permissionLevel,
    matchType: winner.matchType
  };
}

function shiftIsoDate(dateText, offsetDays) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function gscDateRange(now = new Date(), windowDays = 28, lagDays = 2, timezone = 'Asia/Seoul') {
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 90) throw new Error('GSC_WINDOW_INVALID');
  if (!Number.isInteger(lagDays) || lagDays < 0 || lagDays > 7) throw new Error('GSC_LAG_INVALID');
  const today = dateInTimeZone(now, timezone);
  const endDate = shiftIsoDate(today, -lagDays);
  const startDate = shiftIsoDate(endDate, -(windowDays - 1));
  return { startDate, endDate };
}

async function persistProperty(env, blog, match) {
  const db = requireDb(env);
  await db.prepare(
    `INSERT INTO gsc_blog_properties
      (blog_id, blog_name, blog_url, site_url, permission_level, match_type, matched_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(blog_id) DO UPDATE SET
       blog_name=excluded.blog_name,
       blog_url=excluded.blog_url,
       site_url=excluded.site_url,
       permission_level=excluded.permission_level,
       match_type=excluded.match_type,
       updated_at=datetime('now')`
  ).bind(
    String(blog.blogId),
    blog.name || null,
    blog.url || null,
    match?.siteUrl || null,
    match?.permissionLevel || null,
    match?.matchType || 'unmapped'
  ).run();
}

async function persistSnapshot(env, snapshot) {
  const db = requireDb(env);
  await db.prepare(
    `INSERT INTO gsc_snapshots
      (snapshot_date, blog_id, window_days, site_url, start_date, end_date, status, error_code,
       clicks, impressions, ctr, position, detail_row_count, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(snapshot_date, blog_id, window_days) DO UPDATE SET
       site_url=excluded.site_url,
       start_date=excluded.start_date,
       end_date=excluded.end_date,
       status=excluded.status,
       error_code=excluded.error_code,
       clicks=excluded.clicks,
       impressions=excluded.impressions,
       ctr=excluded.ctr,
       position=excluded.position,
       detail_row_count=excluded.detail_row_count,
       collected_at=datetime('now')`
  ).bind(
    snapshot.snapshotDate,
    snapshot.blogId,
    snapshot.windowDays,
    snapshot.siteUrl || null,
    snapshot.startDate || null,
    snapshot.endDate || null,
    snapshot.status,
    snapshot.errorCode || null,
    Number(snapshot.clicks || 0),
    Number(snapshot.impressions || 0),
    Number(snapshot.ctr || 0),
    Number(snapshot.position || 0),
    Number(snapshot.detailRowCount || 0)
  ).run();
}

async function replaceDetailRows(env, snapshotDate, blogId, siteUrl, startDate, endDate, rows = []) {
  const db = requireDb(env);
  await db.prepare('DELETE FROM gsc_query_page_rows WHERE snapshot_date = ? AND blog_id = ?')
    .bind(snapshotDate, blogId).run();
  if (!rows.length) return 0;

  const statements = rows.slice(0, DETAIL_ROW_LIMIT).map((row) => db.prepare(
    `INSERT OR REPLACE INTO gsc_query_page_rows
      (snapshot_date, blog_id, site_url, start_date, end_date, query, page, clicks, impressions, ctr, position, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).bind(
    snapshotDate,
    blogId,
    siteUrl,
    startDate,
    endDate,
    String(row?.dimensions?.query || ''),
    String(row?.dimensions?.page || ''),
    Number(row?.clicks || 0),
    Number(row?.impressions || 0),
    Number(row?.ctr || 0),
    Number(row?.position || 0)
  ));

  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
  return statements.length;
}

function aggregateRow(data) {
  const row = Array.isArray(data?.rows) ? data.rows[0] : null;
  return {
    clicks: Number(row?.clicks || 0),
    impressions: Number(row?.impressions || 0),
    ctr: Number(row?.ctr || 0),
    position: Number(row?.position || 0)
  };
}

async function collectOneBlog(env, blog, match, snapshotDate, now, options) {
  const callHubFn = options.callHubFn || callHub;
  const timezone = options.timezone || env.OPERATIONS_TIMEZONE || 'Asia/Seoul';
  const result = {
    blogId: String(blog.blogId),
    blogName: blog.name || null,
    siteUrl: match?.siteUrl || null,
    mapped: Boolean(match),
    status: match ? 'ok' : 'unmapped',
    windows: []
  };

  await (options.persistPropertyFn || persistProperty)(env, blog, match);
  if (!match) {
    for (const windowDays of SUMMARY_WINDOWS) {
      const range = gscDateRange(now, windowDays, 2, timezone);
      await (options.persistSnapshotFn || persistSnapshot)(env, {
        snapshotDate,
        blogId: result.blogId,
        windowDays,
        siteUrl: null,
        ...range,
        status: 'unmapped',
        errorCode: 'GSC_PROPERTY_UNMAPPED'
      });
      result.windows.push({ windowDays, ...range, status: 'unmapped' });
    }
    return result;
  }

  for (const windowDays of SUMMARY_WINDOWS) {
    const range = gscDateRange(now, windowDays, 2, timezone);
    try {
      const summaryData = await callHubFn(env, env.HUB_GSC_PERFORMANCE_PATH || '/api/gsc/performance', {
        siteUrl: match.siteUrl,
        ...range,
        aggregateOnly: true,
        rowLimit: 1
      });
      const metrics = aggregateRow(summaryData);
      let detailRowCount = 0;
      let detailStatus = 'ok';
      let detailErrorCode = null;

      if (windowDays === 28) {
        try {
          const detail = await callHubFn(env, env.HUB_GSC_PERFORMANCE_PATH || '/api/gsc/performance', {
            siteUrl: match.siteUrl,
            ...range,
            dimensions: ['page', 'query'],
            rowLimit: DETAIL_ROW_LIMIT
          });
          detailRowCount = await (options.replaceDetailRowsFn || replaceDetailRows)(
            env, snapshotDate, result.blogId, match.siteUrl, range.startDate, range.endDate, Array.isArray(detail?.rows) ? detail.rows : []
          );
        } catch (error) {
          detailStatus = 'partial';
          detailErrorCode = safeCode(error);
        }
      }

      const status = detailStatus;
      await (options.persistSnapshotFn || persistSnapshot)(env, {
        snapshotDate,
        blogId: result.blogId,
        windowDays,
        siteUrl: match.siteUrl,
        ...range,
        status,
        errorCode: detailErrorCode,
        ...metrics,
        detailRowCount
      });
      result.windows.push({ windowDays, ...range, status, ...metrics, detailRowCount, errorCode: detailErrorCode });
      if (status !== 'ok') result.status = 'partial';
    } catch (error) {
      const errorCode = safeCode(error);
      await (options.persistSnapshotFn || persistSnapshot)(env, {
        snapshotDate,
        blogId: result.blogId,
        windowDays,
        siteUrl: match.siteUrl,
        ...range,
        status: 'failed',
        errorCode
      });
      result.windows.push({ windowDays, ...range, status: 'failed', errorCode });
      result.status = 'partial';
    }
  }
  return result;
}

export async function collectSearchConsoleForBlogs(env, blogs, options = {}) {
  if (!Array.isArray(blogs)) throw new Error('BLOG_LIST_INVALID');
  const now = options.now || new Date();
  const timezone = options.timezone || env.OPERATIONS_TIMEZONE || 'Asia/Seoul';
  const snapshotDate = options.snapshotDate || dateInTimeZone(now, timezone);
  const callHubFn = options.callHubFn || callHub;
  const sitesData = await callHubFn(env, env.HUB_GSC_SITES_PATH || '/api/gsc/sites', {});
  const sites = Array.isArray(sitesData?.sites) ? sitesData.sites : [];
  const items = [];

  for (const blog of blogs) {
    const blogId = String(blog?.blogId || '').trim();
    if (!blogId) continue;
    const match = resolveSearchConsoleProperty(blog, sites);
    try {
      items.push(await collectOneBlog(env, { ...blog, blogId }, match, snapshotDate, now, options));
    } catch (error) {
      items.push({
        blogId,
        blogName: blog?.name || null,
        siteUrl: match?.siteUrl || null,
        mapped: Boolean(match),
        status: 'failed',
        errorCode: safeCode(error),
        windows: []
      });
    }
  }

  return {
    ok: items.every((item) => item.status !== 'failed'),
    snapshotDate,
    siteCount: sites.length,
    blogCount: items.length,
    mappedCount: items.filter((item) => item.mapped).length,
    okCount: items.filter((item) => item.status === 'ok').length,
    partialCount: items.filter((item) => item.status === 'partial').length,
    failedCount: items.filter((item) => item.status === 'failed').length,
    items
  };
}

export async function listSearchConsoleStatus(env, snapshotDate) {
  const db = requireDb(env);
  const [properties, snapshots] = await Promise.all([
    db.prepare(
      `SELECT blog_id, blog_name, blog_url, site_url, permission_level, match_type, updated_at
       FROM gsc_blog_properties ORDER BY blog_name COLLATE NOCASE, blog_id`
    ).all(),
    db.prepare(
      `SELECT snapshot_date, blog_id, window_days, site_url, start_date, end_date, status, error_code,
              clicks, impressions, ctr, position, detail_row_count, collected_at
       FROM gsc_snapshots WHERE snapshot_date = ?
       ORDER BY blog_id, window_days`
    ).bind(snapshotDate).all()
  ]);
  return {
    snapshotDate,
    properties: properties.results || [],
    snapshots: snapshots.results || []
  };
}

export async function listSearchConsoleTopRows(env, snapshotDate, blogId, limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 50)));
  const db = requireDb(env);
  const rows = await db.prepare(
    `SELECT query, page, clicks, impressions, ctr, position
     FROM gsc_query_page_rows
     WHERE snapshot_date = ? AND blog_id = ?
     ORDER BY impressions DESC, clicks DESC
     LIMIT ?`
  ).bind(snapshotDate, String(blogId), safeLimit).all();
  return rows.results || [];
}
