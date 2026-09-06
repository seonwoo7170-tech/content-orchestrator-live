import { callHub } from './api-hub.js';
import { dateInTimeZone } from './daily-plan.js';

const SUMMARY_WINDOWS = Object.freeze([7, 28]);

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function safeCode(error) {
  return String(error?.message || error || 'ADSENSE_COLLECTION_FAILED')
    .split(/[:\s]/)[0]
    .replace(/[^A-Z0-9_]/gi, '_')
    .toUpperCase()
    .slice(0, 80) || 'ADSENSE_COLLECTION_FAILED';
}

function hostOf(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; }
}

function isTistory(value) {
  const host = hostOf(value);
  return host === 'tistory.com' || host.endsWith('.tistory.com');
}

function shiftIsoDate(dateText, offsetDays) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function adsenseDateRange(now = new Date(), windowDays = 28, lagDays = 1, timezone = 'Asia/Seoul') {
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 90) throw new Error('ADSENSE_WINDOW_INVALID');
  if (!Number.isInteger(lagDays) || lagDays < 0 || lagDays > 7) throw new Error('ADSENSE_LAG_INVALID');
  const today = dateInTimeZone(now, timezone);
  const endDate = shiftIsoDate(today, -lagDays);
  const startDate = shiftIsoDate(endDate, -(windowDays - 1));
  return { startDate, endDate };
}

async function persistDomain(env, blog) {
  const db = requireDb(env);
  await db.prepare(
    `INSERT INTO adsense_blog_domains (blog_id, blog_name, blog_url, domain, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(blog_id) DO UPDATE SET
       blog_name=excluded.blog_name, blog_url=excluded.blog_url, domain=excluded.domain, updated_at=datetime('now')`
  ).bind(String(blog.blogId), blog.name || null, blog.url || null, hostOf(blog.url)).run();
}

async function persistSnapshot(env, row) {
  const db = requireDb(env);
  await db.prepare(
    `INSERT INTO adsense_snapshots
      (snapshot_date, blog_id, window_days, domain, start_date, end_date, status, error_code,
       page_views, impressions, clicks, estimated_earnings, page_views_rpm, currency_code, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(snapshot_date, blog_id, window_days) DO UPDATE SET
       domain=excluded.domain, start_date=excluded.start_date, end_date=excluded.end_date,
       status=excluded.status, error_code=excluded.error_code, page_views=excluded.page_views,
       impressions=excluded.impressions, clicks=excluded.clicks, estimated_earnings=excluded.estimated_earnings,
       page_views_rpm=excluded.page_views_rpm, currency_code=excluded.currency_code, collected_at=datetime('now')`
  ).bind(
    row.snapshotDate, row.blogId, row.windowDays, row.domain || null, row.startDate || null, row.endDate || null,
    row.status, row.errorCode || null, Number(row.pageViews || 0), Number(row.impressions || 0),
    Number(row.clicks || 0), Number(row.estimatedEarnings || 0), Number(row.pageViewsRpm || 0), row.currencyCode || null
  ).run();
}

function blankMetric() {
  return { pageViews: 0, impressions: 0, clicks: 0, estimatedEarnings: 0, rpmWeighted: 0, rpmWeight: 0, currencies: new Set() };
}

function addRow(target, row) {
  const metrics = row?.metrics || {};
  const pageViews = Number(metrics.PAGE_VIEWS || 0);
  const rpm = Number(metrics.PAGE_VIEWS_RPM || 0);
  target.pageViews += pageViews;
  target.impressions += Number(metrics.IMPRESSIONS || 0);
  target.clicks += Number(metrics.CLICKS || 0);
  target.estimatedEarnings += Number(metrics.ESTIMATED_EARNINGS || 0);
  target.rpmWeighted += rpm * pageViews;
  target.rpmWeight += pageViews;
  for (const code of Object.values(row?.currencyCodes || {})) if (code) target.currencies.add(String(code));
}

export async function collectAdsenseForBlogs(env, blogs, options = {}) {
  if (!Array.isArray(blogs)) throw new Error('BLOG_LIST_INVALID');
  const normalizedBlogs = blogs
    .map((blog) => ({ ...blog, blogId: String(blog?.blogId || '').trim(), domain: hostOf(blog?.url) }))
    .filter((blog) => blog.blogId && blog.domain && !isTistory(blog.url));
  const now = options.now || new Date();
  const timezone = options.timezone || env.OPERATIONS_TIMEZONE || 'Asia/Seoul';
  const snapshotDate = options.snapshotDate || dateInTimeZone(now, timezone);
  const callHubFn = options.callHubFn || callHub;
  const persistDomainFn = options.persistDomainFn || persistDomain;
  const persistSnapshotFn = options.persistSnapshotFn || persistSnapshot;

  for (const blog of normalizedBlogs) await persistDomainFn(env, blog);

  const accountsPayload = await callHubFn(env, env.HUB_ADSENSE_ACCOUNTS_PATH || '/api/adsense/accounts', {});
  const accounts = Array.isArray(accountsPayload?.accounts) ? accountsPayload.accounts.filter((row) => row?.name) : [];
  if (!accounts.length) throw new Error('ADSENSE_ACCOUNT_NOT_FOUND');

  const byDomain = new Map(normalizedBlogs.map((blog) => [blog.domain, blog]));
  const items = new Map(normalizedBlogs.map((blog) => [blog.blogId, {
    blogId: blog.blogId, blogName: blog.name || null, domain: blog.domain, status: 'ok', windows: []
  }]));
  let reportRequestCount = 0;
  let reportFailureCount = 0;

  for (const windowDays of SUMMARY_WINDOWS) {
    const range = adsenseDateRange(now, windowDays, 1, timezone);
    const totals = new Map(normalizedBlogs.map((blog) => [blog.blogId, blankMetric()]));
    const errors = [];

    for (const account of accounts) {
      try {
        const report = await callHubFn(env, env.HUB_ADSENSE_REPORT_PATH || '/api/adsense/report', {
          account: account.name,
          ...range,
          dimensions: ['DOMAIN_CODE'],
          metrics: ['PAGE_VIEWS', 'IMPRESSIONS', 'CLICKS', 'ESTIMATED_EARNINGS', 'PAGE_VIEWS_RPM'],
          limit: 10000
        });
        reportRequestCount += 1;
        for (const row of Array.isArray(report?.rows) ? report.rows : []) {
          const blog = byDomain.get(hostOf(row?.dimensions?.DOMAIN_CODE));
          if (!blog) continue;
          addRow(totals.get(blog.blogId), row);
        }
      } catch (error) {
        reportRequestCount += 1;
        reportFailureCount += 1;
        errors.push(safeCode(error));
      }
    }

    for (const blog of normalizedBlogs) {
      const metric = totals.get(blog.blogId);
      const currencyCodes = [...metric.currencies].sort();
      let status = 'ok';
      let errorCode = null;
      if (errors.length === accounts.length) {
        status = 'failed';
        errorCode = errors[0] || 'ADSENSE_REPORT_REQUEST_FAILED';
      } else if (errors.length > 0) {
        status = 'partial';
        errorCode = errors[0];
      } else if (currencyCodes.length > 1) {
        status = 'partial';
        errorCode = 'ADSENSE_CURRENCY_AMBIGUOUS';
      }
      const pageViewsRpm = metric.rpmWeight > 0 ? metric.rpmWeighted / metric.rpmWeight : 0;
      const row = {
        snapshotDate, blogId: blog.blogId, windowDays, domain: blog.domain, ...range,
        status, errorCode, pageViews: metric.pageViews, impressions: metric.impressions,
        clicks: metric.clicks, estimatedEarnings: metric.estimatedEarnings,
        pageViewsRpm, currencyCode: currencyCodes.length === 1 ? currencyCodes[0] : null
      };
      await persistSnapshotFn(env, row);
      items.get(blog.blogId).windows.push(row);
      if (status !== 'ok') items.get(blog.blogId).status = status;
    }
  }

  const resultItems = [...items.values()];
  const failedCount = resultItems.filter((item) => item.status === 'failed').length;
  const partialCount = resultItems.filter((item) => item.status === 'partial').length;
  return {
    ok: failedCount === 0 && partialCount === 0,
    snapshotDate,
    accountCount: accounts.length,
    blogCount: resultItems.length,
    okCount: resultItems.filter((item) => item.status === 'ok').length,
    partialCount,
    failedCount,
    reportRequestCount,
    reportFailureCount,
    items: resultItems
  };
}

export async function listAdsenseStatus(env, snapshotDate) {
  const db = requireDb(env);
  const [domains, snapshots] = await Promise.all([
    db.prepare(`SELECT blog_id, blog_name, blog_url, domain, updated_at FROM adsense_blog_domains ORDER BY blog_name COLLATE NOCASE, blog_id`).all(),
    db.prepare(`SELECT snapshot_date, blog_id, window_days, domain, start_date, end_date, status, error_code,
      page_views, impressions, clicks, estimated_earnings, page_views_rpm, currency_code, collected_at
      FROM adsense_snapshots WHERE snapshot_date = ? ORDER BY blog_id, window_days`).bind(snapshotDate).all()
  ]);
  return { snapshotDate, domains: domains.results || [], snapshots: snapshots.results || [] };
}
