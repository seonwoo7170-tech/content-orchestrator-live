import { callHub } from './api-hub.js';
import { adsenseDateRange } from './adsense-collector.js';
import { dateInTimeZone } from './daily-plan.js';

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function hostOf(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; }
}

function isTistory(value) {
  const host = hostOf(value);
  return host === 'tistory.com' || host.endsWith('.tistory.com');
}

function safeCode(error) {
  return String(error?.message || error || 'ADSENSE_PAGE_COLLECTION_FAILED')
    .split(/[:\s]/)[0]
    .replace(/[^A-Z0-9_]/gi, '_')
    .toUpperCase()
    .slice(0, 80) || 'ADSENSE_PAGE_COLLECTION_FAILED';
}

export function canonicalPageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function pagePath(value) {
  try { return new URL(value).pathname || '/'; }
  catch { return '/'; }
}

function blankMetric() {
  return { pageViews: 0, impressions: 0, clicks: 0, earnings: 0, rpmWeighted: 0, rpmWeight: 0, currencies: new Set() };
}

function addRow(target, row) {
  const metrics = row?.metrics || {};
  const pageViews = Number(metrics.PAGE_VIEWS || 0);
  const rpm = Number(metrics.PAGE_VIEWS_RPM || 0);
  target.pageViews += pageViews;
  target.impressions += Number(metrics.IMPRESSIONS || 0);
  target.clicks += Number(metrics.CLICKS || 0);
  target.earnings += Number(metrics.ESTIMATED_EARNINGS || 0);
  target.rpmWeighted += rpm * pageViews;
  target.rpmWeight += pageViews;
  for (const code of Object.values(row?.currencyCodes || {})) if (code) target.currencies.add(String(code));
}

async function persistPage(env, row) {
  const db = requireDb(env);
  await db.prepare(
    `INSERT INTO adsense_page_snapshots
      (snapshot_date, blog_id, page_url, page_path, status, error_code,
       page_views, impressions, clicks, estimated_earnings, page_views_rpm, currency_code, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(snapshot_date, blog_id, page_url) DO UPDATE SET
       page_path=excluded.page_path, status=excluded.status, error_code=excluded.error_code,
       page_views=excluded.page_views, impressions=excluded.impressions, clicks=excluded.clicks,
       estimated_earnings=excluded.estimated_earnings, page_views_rpm=excluded.page_views_rpm,
       currency_code=excluded.currency_code, collected_at=datetime('now')`
  ).bind(
    row.snapshotDate, row.blogId, row.pageUrl, row.pagePath, row.status, row.errorCode || null,
    row.pageViews, row.impressions, row.clicks, row.estimatedEarnings, row.pageViewsRpm, row.currencyCode || null
  ).run();
}

export async function collectAdsensePagePerformance(env, blogs, options = {}) {
  if (!Array.isArray(blogs)) throw new Error('BLOG_LIST_INVALID');
  const normalized = blogs
    .map((blog) => ({ ...blog, blogId: String(blog?.blogId || '').trim(), domain: hostOf(blog?.url) }))
    .filter((blog) => blog.blogId && blog.domain && !isTistory(blog.url));
  const now = options.now || new Date();
  const timezone = options.timezone || env?.OPERATIONS_TIMEZONE || 'Asia/Seoul';
  const snapshotDate = options.snapshotDate || dateInTimeZone(now, timezone);
  const lagDays = Number.isInteger(options.lagDays) ? options.lagDays : 0;
  const range = adsenseDateRange(now, 1, lagDays, timezone);
  const callHubFn = options.callHubFn || callHub;
  const persistPageFn = options.persistPageFn || persistPage;
  const accountsPayload = await callHubFn(env, env?.HUB_ADSENSE_ACCOUNTS_PATH || '/api/adsense/accounts', {});
  const accounts = Array.isArray(accountsPayload?.accounts) ? accountsPayload.accounts.filter((row) => row?.name) : [];
  if (!accounts.length) throw new Error('ADSENSE_ACCOUNT_NOT_FOUND');

  const byDomain = new Map(normalized.map((blog) => [blog.domain, blog]));
  const totals = new Map();
  const errors = [];
  let reportRequestCount = 0;

  for (const account of accounts) {
    try {
      const report = await callHubFn(env, env?.HUB_ADSENSE_REPORT_PATH || '/api/adsense/report', {
        account: account.name,
        ...range,
        dimensions: ['PAGE_URL'],
        metrics: ['PAGE_VIEWS', 'IMPRESSIONS', 'CLICKS', 'ESTIMATED_EARNINGS', 'PAGE_VIEWS_RPM'],
        orderBy: ['-ESTIMATED_EARNINGS'],
        limit: 10000
      });
      reportRequestCount += 1;
      for (const row of Array.isArray(report?.rows) ? report.rows : []) {
        const rawUrl = row?.dimensions?.PAGE_URL;
        const pageUrl = canonicalPageUrl(rawUrl);
        if (!pageUrl) continue;
        const blog = byDomain.get(hostOf(pageUrl));
        if (!blog) continue;
        const key = `${blog.blogId}\n${pageUrl}`;
        if (!totals.has(key)) totals.set(key, { blog, pageUrl, metric: blankMetric() });
        addRow(totals.get(key).metric, row);
      }
    } catch (error) {
      reportRequestCount += 1;
      errors.push(safeCode(error));
    }
  }

  const rows = [];
  for (const { blog, pageUrl, metric } of totals.values()) {
    const currencyCodes = [...metric.currencies].sort();
    let status = 'ok';
    let errorCode = null;
    if (errors.length === accounts.length) {
      status = 'failed';
      errorCode = errors[0] || 'ADSENSE_PAGE_REPORT_REQUEST_FAILED';
    } else if (errors.length > 0) {
      status = 'partial';
      errorCode = errors[0];
    } else if (currencyCodes.length > 1) {
      status = 'partial';
      errorCode = 'ADSENSE_CURRENCY_AMBIGUOUS';
    }
    const item = {
      snapshotDate,
      blogId: blog.blogId,
      blogName: blog.name || null,
      pageUrl,
      pagePath: pagePath(pageUrl),
      status,
      errorCode,
      pageViews: metric.pageViews,
      impressions: metric.impressions,
      clicks: metric.clicks,
      estimatedEarnings: metric.earnings,
      pageViewsRpm: metric.rpmWeight > 0 ? metric.rpmWeighted / metric.rpmWeight : 0,
      currencyCode: currencyCodes.length === 1 ? currencyCodes[0] : null
    };
    await persistPageFn(env, item);
    rows.push(item);
  }

  rows.sort((a, b) => b.estimatedEarnings - a.estimatedEarnings || b.pageViewsRpm - a.pageViewsRpm || a.pageUrl.localeCompare(b.pageUrl));
  return {
    ok: errors.length === 0,
    snapshotDate,
    startDate: range.startDate,
    endDate: range.endDate,
    preliminary: lagDays === 0,
    blogCount: normalized.length,
    pageCount: rows.length,
    accountCount: accounts.length,
    reportRequestCount,
    reportFailureCount: errors.length,
    rows
  };
}

export async function listAdsensePagePerformance(env, snapshotDate, blogId, limit = 10) {
  const db = requireDb(env);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
  const result = await db.prepare(
    `SELECT snapshot_date, blog_id, page_url, page_path, status, error_code,
      page_views, impressions, clicks, estimated_earnings, page_views_rpm, currency_code, collected_at
     FROM adsense_page_snapshots
     WHERE snapshot_date = ? AND blog_id = ?
     ORDER BY estimated_earnings DESC, page_views_rpm DESC, page_url ASC
     LIMIT ?`
  ).bind(String(snapshotDate), String(blogId), safeLimit).all();
  return result?.results || [];
}
