import baseEntry from './entry.js';
import { loadConnectedBlogs } from './lib/connected-blogs.js';
import { isDailyOperationDue } from './lib/daily-operation-schedule.js';
import { operationsPlanDate } from './lib/daily-operations.js';
import { requireAdmin } from './lib/admin-auth.js';
import { collectAdsenseForBlogs, listAdsenseStatus } from './lib/adsense-collector.js';
import { collectAdsensePagePerformance } from './lib/adsense-page-performance.js';
import { listRankedAdsensePages } from './lib/adsense-page-ranking.js';
import { listPerformancePriorities } from './lib/performance-priority-store.js';
import { listGa4Coverage } from './lib/ga4-coverage.js';
import { runScheduledRepairUpdates } from './lib/auto-repair-updater.js';
import { cleanupSupersededReadyRepairs } from './lib/repair-ready-dedupe.js';
import { listPublicationStatus } from './lib/publication-status.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function connectedBlogs(env) {
  return loadConnectedBlogs(env);
}

export async function runScheduledBlogRegistrySync(env, options = {}) {
  const blogs = await loadConnectedBlogs(env, options);
  return { ok: true, blogCount: blogs.length, blogIds: blogs.map((blog) => blog.blogId) };
}

export async function runScheduledAdsenseCollection(env, now = new Date(), options = {}) {
  if (env?.ADSENSE_COLLECTION_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'ADSENSE_COLLECTION_DISABLED', blogCount: 0 };
  }
  const schedule = {
    dailyOperationStartTime: String(env?.ADSENSE_COLLECTION_TIME || '03:35'),
    timezone: String(env?.OPERATIONS_TIMEZONE || 'Asia/Seoul')
  };
  if (!isDailyOperationDue(schedule, now, 5)) {
    return { ok: true, enabled: true, due: false, startTime: schedule.dailyOperationStartTime, timezone: schedule.timezone };
  }
  const blogs = options.blogs || await connectedBlogs(env);
  const runner = options.runner || collectAdsenseForBlogs;
  const result = await runner(env, blogs, { now });
  return { ...result, enabled: true, due: true, startTime: schedule.dailyOperationStartTime, timezone: schedule.timezone };
}

async function performancePriorities(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const result = await listPerformancePriorities(env, await connectedBlogs(env));
  return json({ ok: true, count: result.rows.length, evidenceCounts: result.evidenceCounts, rows: result.rows });
}

async function ga4Coverage(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const result = await listGa4Coverage(env, await connectedBlogs(env));
  return json({ ok: true, collectionEnabled: env?.GA4_COLLECTION_ENABLED === 'true', collectionTime: String(env?.GA4_COLLECTION_TIME || '03:25'), ...result });
}

async function adsenseStatus(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const snapshotDate = operationsPlanDate(env, new Date());
  const status = await listAdsenseStatus(env, snapshotDate);
  return json({ ok: true, collectionEnabled: env?.ADSENSE_COLLECTION_ENABLED === 'true', collectionTime: String(env?.ADSENSE_COLLECTION_TIME || '03:35'), ...status });
}

async function adsenseCollect(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const result = await collectAdsenseForBlogs(env, await connectedBlogs(env), { now: new Date() });
  return json({ ...result, collectionEnabled: env?.ADSENSE_COLLECTION_ENABLED === 'true', collectionTime: String(env?.ADSENSE_COLLECTION_TIME || '03:35') }, result.failedCount > 0 ? 207 : 200);
}

async function adsensePageCollect(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const result = await collectAdsensePagePerformance(env, await connectedBlogs(env), { now: new Date(), lagDays: 0 });
  return json(result, result.ok ? 200 : 207);
}

function matchAdsenseBlogPagesPath(pathname) {
  const match = pathname.match(/^\/api\/performance\/adsense\/blogs\/([^/]+)\/pages$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

async function adsenseBlogPages(request, env, blogId) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const url = new URL(request.url);
  const snapshotDate = url.searchParams.get('date') || operationsPlanDate(env, new Date());
  const result = await listRankedAdsensePages(env, snapshotDate, blogId, {
    limit: url.searchParams.get('limit') || 10,
    order: url.searchParams.get('order') || 'earnings',
    minPageViews: url.searchParams.get('minPageViews') || 1
  });
  return json({
    ok: true,
    snapshotDate,
    blogId: String(blogId),
    preliminary: snapshotDate === operationsPlanDate(env, new Date()),
    count: result.rows.length,
    order: result.order,
    minPageViews: result.minPageViews,
    rows: result.rows
  });
}

async function publicationStatus(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const blogs = await connectedBlogs(env);
  const result = await listPublicationStatus(env, operationsPlanDate(env, new Date()), {
    blogIds: blogs.map((blog) => blog.blogId)
  });
  return json({ ok: true, ...result });
}

async function repairPublishTick(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const dedupe = await cleanupSupersededReadyRepairs(env);
  const repairs = await runScheduledRepairUpdates(env, await connectedBlogs(env), { now: new Date() });
  return json({ ok: repairs.ok !== false, dedupe, repairs }, repairs.ok === false ? 207 : 200);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/operations/publications/today') {
      try { return await publicationStatus(request, env); }
      catch (error) { return json({ error: error?.message || 'PUBLICATION_STATUS_FAILED' }, error?.status || 500); }
    }
    if (request.method === 'POST' && url.pathname === '/api/operations/repair-publish-tick') {
      try { return await repairPublishTick(request, env); }
      catch (error) { return json({ error: error?.message || 'REPAIR_PUBLISH_TICK_FAILED' }, error?.status || 500); }
    }
    if (request.method === 'GET' && url.pathname === '/api/performance/priorities') {
      try { return await performancePriorities(request, env); }
      catch (error) { return json({ error: error?.message || 'PERFORMANCE_PRIORITY_FAILED' }, error?.status || 500); }
    }
    if (request.method === 'GET' && url.pathname === '/api/performance/ga4/coverage') {
      try { return await ga4Coverage(request, env); }
      catch (error) { return json({ error: error?.message || 'GA4_COVERAGE_FAILED' }, error?.status || 500); }
    }
    if (request.method === 'GET' && url.pathname === '/api/performance/adsense/today') {
      try { return await adsenseStatus(request, env); }
      catch (error) { return json({ error: error?.message || 'ADSENSE_STATUS_FAILED' }, error?.status || 500); }
    }
    if (request.method === 'POST' && url.pathname === '/api/performance/adsense/collect') {
      try { return await adsenseCollect(request, env); }
      catch (error) { return json({ error: error?.message || 'ADSENSE_COLLECTION_FAILED' }, error?.status || 500); }
    }
    if (request.method === 'POST' && url.pathname === '/api/performance/adsense/pages/collect') {
      try { return await adsensePageCollect(request, env); }
      catch (error) { return json({ error: error?.message || 'ADSENSE_PAGE_COLLECTION_FAILED' }, error?.status || 500); }
    }
    const adsenseBlogId = matchAdsenseBlogPagesPath(url.pathname);
    if (request.method === 'GET' && adsenseBlogId !== null) {
      try { return await adsenseBlogPages(request, env, adsenseBlogId); }
      catch (error) { return json({ error: error?.message || 'ADSENSE_PAGE_STATUS_FAILED' }, error?.status || 500); }
    }
    return baseEntry.fetch(request, env, ctx);
  },

  scheduled(event, env, ctx) {
    baseEntry.scheduled(event, env, ctx);
    const now = new Date(event?.scheduledTime || Date.now());
    if (event?.cron === '*/5 * * * *') {
      ctx.waitUntil(runScheduledBlogRegistrySync(env));
      ctx.waitUntil(runScheduledAdsenseCollection(env, now));
      ctx.waitUntil((async () => {
        await cleanupSupersededReadyRepairs(env);
        return runScheduledRepairUpdates(env, await connectedBlogs(env), { now });
      })());
    }
  }
};
