import app from './index.js';
import { callHub } from './lib/api-hub.js';
import { normalizeBlogList } from './lib/blog-registry.js';
import { readAutomationSettings } from './lib/automation-settings.js';
import { isDailyOperationDue } from './lib/daily-operation-schedule.js';
import { ensureDailyPlan, operationsPlanDate } from './lib/daily-operations.js';
import { runAutomaticWork } from './lib/daily-auto-work.js';
import { runDueAutoPublications } from './lib/auto-publisher.js';
import { runDueJobRecoveries } from './lib/job-recovery-runner.js';
import { listDueRetryJobs, listHeldRecoveryItems, readRecoverySummary, safeFailureCode } from './lib/job-recovery.js';
import { claimStoredJobExecution, getStoredJob, persistJobTransition, resetStoredJobForManualRetry } from './lib/job-store.js';
import { processStoredJob } from './lib/stored-job-executor.js';
import { requireAdmin } from './lib/admin-auth.js';
import {
  collectSearchConsoleForBlogs,
  listSearchConsoleStatus,
  listSearchConsoleTopRows
} from './lib/gsc-collector.js';
import {
  collectAnalyticsForBlogs,
  listAnalyticsStatus,
  listAnalyticsTopRows
} from './lib/ga4-collector.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

async function connectedBlogs(env) {
  const data = await callHub(
    env,
    env.HUB_BLOGGER_BLOGS_PATH || '/api/blogger/blogs',
    { action: 'list' }
  );
  return normalizeBlogList(data);
}

function publicDueRetryItem(row) {
  return {
    id: Number(row.id),
    mode: row.mode,
    blogId: row.blog_id,
    bloggerPostId: row.blogger_post_id || null,
    topic: row.topic || null,
    retryCount: Number(row.retry_count || 0),
    nextRetryAt: row.next_retry_at || null,
    lastErrorCode: row.last_error_code || null,
    lastFailureAt: row.last_failure_at || null
  };
}

function positiveTickLimit(value, fallback = 1) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 10) throw Object.assign(new Error('WORK_TICK_LIMIT_INVALID'), { status: 400 });
  return number;
}

function matchManualJobPath(pathname, action) {
  const match = String(pathname || '').match(new RegExp(`^/api/jobs/(\\d+)/${action}$`));
  return match ? Number(match[1]) : null;
}

async function manualRetry(request, env, jobId) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  try {
    const result = await resetStoredJobForManualRetry(env, jobId);
    return json({ accepted: true, ...result }, 202);
  } catch (error) {
    return json({ ok: false, error: safeFailureCode(error) }, error?.status || 500);
  }
}

async function runManualJob(request, env, ctx, jobId) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  try {
    const row = await getStoredJob(env, jobId);
    if (String(row.status || '') !== 'queued') {
      return json({ ok: false, error: `JOB_NOT_RUNNABLE_${String(row.status || 'unknown').toUpperCase()}` }, 409);
    }
    const initialStatus = String(row.mode || '') === 'new_article' ? 'writing' : 'critic_review';
    const claimed = await claimStoredJobExecution(env, jobId, initialStatus);
    if (!claimed) return json({ ok: false, error: 'JOB_EXECUTION_ALREADY_CLAIMED' }, 409);

    const execution = processStoredJob(env, row, {
      claimExecutionFn: async () => true,
      saveState: (state, patch) => persistJobTransition(env, jobId, state, patch)
    }).catch((error) => {
      console.error('MANUAL_JOB_BACKGROUND_FAILED', JSON.stringify({ jobId, errorCode: safeFailureCode(error) }));
    });
    ctx.waitUntil(execution);
    return json({ accepted: true, ok: true, jobId, status: initialStatus }, 202);
  } catch (error) {
    return json({ ok: false, error: safeFailureCode(error) }, error?.status || 500);
  }
}

export async function runScheduledDailyPlan(env, now = new Date()) {
  return ensureDailyPlan(env, await connectedBlogs(env), { now });
}

export async function runScheduledDailyPlanIfDue(env, now = new Date()) {
  const automation = await readAutomationSettings(env, []);
  const settings = automation?.global || {};
  if (!isDailyOperationDue(settings, now, 5)) {
    return { ok: true, due: false, startTime: settings.dailyOperationStartTime || '03:00', timezone: settings.timezone || 'Asia/Seoul' };
  }
  const result = await runScheduledDailyPlan(env, now);
  return { ...result, due: true, startTime: settings.dailyOperationStartTime || '03:00', timezone: settings.timezone || 'Asia/Seoul' };
}

export async function runScheduledAutomaticWork(env, now = new Date(), options = {}) {
  if (env?.DAILY_WORK_EXECUTION_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'DAILY_WORK_EXECUTION_DISABLED', attempted: 0, completed: 0, items: [] };
  }
  const blogs = options.blogs || await connectedBlogs(env);
  const automation = options.automation || await readAutomationSettings(env, blogs);
  const runner = options.runner || runAutomaticWork;
  return runner(env, blogs, automation, {
    planDate: operationsPlanDate(env, now),
    maxItems: options.maxItems ?? env?.DAILY_WORK_MAX_ITEMS,
    now,
    executionContext: options.executionContext
  });
}

export async function runScheduledJobRecovery(env, now = new Date(), options = {}) {
  if (env?.JOB_RECOVERY_EXECUTION_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'JOB_RECOVERY_EXECUTION_DISABLED', attempted: 0, completed: 0, items: [] };
  }
  const blogs = options.blogs || await connectedBlogs(env);
  const automation = options.automation || await readAutomationSettings(env, blogs);
  const runner = options.runner || runDueJobRecoveries;
  return runner(env, {
    now,
    maxItems: env?.JOB_RECOVERY_MAX_ITEMS,
    automation,
    executionContext: options.executionContext
  });
}

export async function runScheduledAutoPublish(env, now = new Date()) {
  if (env?.AUTO_PUBLISH_EXECUTION_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'AUTO_PUBLISH_EXECUTION_DISABLED', attempted: 0, published: 0 };
  }
  if (env?.BLOGGER_WRITES_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'BLOGGER_WRITES_DISABLED', attempted: 0, published: 0 };
  }
  return runDueAutoPublications(env, await connectedBlogs(env), { now });
}

export async function runScheduledSearchConsoleCollection(env, now = new Date(), options = {}) {
  if (env?.GSC_COLLECTION_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'GSC_COLLECTION_DISABLED', blogCount: 0 };
  }
  const schedule = {
    dailyOperationStartTime: String(env?.GSC_COLLECTION_TIME || '03:15'),
    timezone: String(env?.OPERATIONS_TIMEZONE || 'Asia/Seoul')
  };
  if (!isDailyOperationDue(schedule, now, 5)) {
    return { ok: true, enabled: true, due: false, startTime: schedule.dailyOperationStartTime, timezone: schedule.timezone };
  }
  const blogs = options.blogs || await connectedBlogs(env);
  const runner = options.runner || collectSearchConsoleForBlogs;
  const result = await runner(env, blogs, { now });
  return { ...result, enabled: true, due: true, startTime: schedule.dailyOperationStartTime, timezone: schedule.timezone };
}

export async function runScheduledAnalyticsCollection(env, now = new Date(), options = {}) {
  if (env?.GA4_COLLECTION_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'GA4_COLLECTION_DISABLED', blogCount: 0 };
  }
  const schedule = {
    dailyOperationStartTime: String(env?.GA4_COLLECTION_TIME || '03:25'),
    timezone: String(env?.OPERATIONS_TIMEZONE || 'Asia/Seoul')
  };
  if (!isDailyOperationDue(schedule, now, 5)) {
    return { ok: true, enabled: true, due: false, startTime: schedule.dailyOperationStartTime, timezone: schedule.timezone };
  }
  const blogs = options.blogs || await connectedBlogs(env);
  const runner = options.runner || collectAnalyticsForBlogs;
  const result = await runner(env, blogs, { now });
  return { ...result, enabled: true, due: true, startTime: schedule.dailyOperationStartTime, timezone: schedule.timezone };
}

function safeTaskResult(name, value) {
  return {
    name,
    ok: value?.ok !== false,
    enabled: value?.enabled,
    due: value?.due,
    attempted: Number(value?.attempted || 0),
    completed: Number(value?.completed || 0),
    failed: Number(value?.failed || 0),
    skipped: Number(value?.skipped || 0),
    published: Number(value?.published || 0)
  };
}

async function settleTask(name, fn) {
  try {
    return safeTaskResult(name, await fn());
  } catch (error) {
    return { name, ok: false, errorCode: safeFailureCode(error) };
  }
}

export async function runScheduledCoreTick(env, now = new Date(), options = {}) {
  const tasks = options.tasks || {};
  const plan = await settleTask('dailyPlan', () => (tasks.dailyPlan || runScheduledDailyPlanIfDue)(env, now));
  const rest = await Promise.all([
    settleTask('automaticWork', () => (tasks.automaticWork || runScheduledAutomaticWork)(env, now, { executionContext: options.executionContext })),
    settleTask('jobRecovery', () => (tasks.jobRecovery || runScheduledJobRecovery)(env, now, { executionContext: options.executionContext })),
    settleTask('autoPublish', () => (tasks.autoPublish || runScheduledAutoPublish)(env, now)),
    settleTask('gsc', () => (tasks.gsc || runScheduledSearchConsoleCollection)(env, now)),
    settleTask('ga4', () => (tasks.ga4 || runScheduledAnalyticsCollection)(env, now))
  ]);
  const results = [plan, ...rest];
  const summary = {
    ok: results.every((item) => item.ok),
    at: now.toISOString(),
    failures: results.filter((item) => !item.ok).map((item) => ({ name: item.name, errorCode: item.errorCode || 'UNKNOWN' })),
    tasks: results
  };
  console.log('SCHEDULED_CORE_TICK', JSON.stringify(summary));
  return summary;
}

async function recoveryStatus(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const now = new Date();
  const [summary, due, held] = await Promise.all([
    readRecoverySummary(env),
    listDueRetryJobs(env, { now, limit: 10 }),
    listHeldRecoveryItems(env, { limit: 10 })
  ]);
  return json({
    ok: true,
    executionEnabled: env?.JOB_RECOVERY_EXECUTION_ENABLED === 'true',
    dailyWorkExecutionEnabled: env?.DAILY_WORK_EXECUTION_ENABLED === 'true',
    maxRetryItems: Number(env?.JOB_RECOVERY_MAX_ITEMS || 1),
    summary,
    dueRetries: due.map(publicDueRetryItem),
    heldItems: held
  });
}

async function workTick(request, env, ctx) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const url = new URL(request.url);
  const maxItems = positiveTickLimit(url.searchParams.get('maxItems') || env?.DAILY_WORK_MAX_ITEMS || 1);
  try {
    const result = await runScheduledAutomaticWork(env, new Date(), { maxItems, executionContext: ctx });
    return json({ ...result, maxItems }, result.ok === false ? 207 : 200);
  } catch (error) {
    return json({ ok: false, error: safeFailureCode(error), maxItems }, error?.status || 500);
  }
}

async function gscStatus(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const snapshotDate = operationsPlanDate(env, new Date());
  const status = await listSearchConsoleStatus(env, snapshotDate);
  return json({ ok: true, collectionEnabled: env?.GSC_COLLECTION_ENABLED === 'true', collectionTime: String(env?.GSC_COLLECTION_TIME || '03:15'), ...status });
}

async function gscCollect(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const result = await collectSearchConsoleForBlogs(env, await connectedBlogs(env), { now: new Date() });
  return json({ ...result, collectionEnabled: env?.GSC_COLLECTION_ENABLED === 'true', collectionTime: String(env?.GSC_COLLECTION_TIME || '03:15') }, result.failedCount > 0 ? 207 : 200);
}

async function gscBlogRows(request, env, blogId) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const url = new URL(request.url);
  const snapshotDate = operationsPlanDate(env, new Date());
  const rows = await listSearchConsoleTopRows(env, snapshotDate, blogId, url.searchParams.get('limit') || 50);
  return json({ ok: true, snapshotDate, blogId: String(blogId), rows, count: rows.length });
}

async function ga4Status(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const snapshotDate = operationsPlanDate(env, new Date());
  const status = await listAnalyticsStatus(env, snapshotDate);
  return json({ ok: true, collectionEnabled: env?.GA4_COLLECTION_ENABLED === 'true', collectionTime: String(env?.GA4_COLLECTION_TIME || '03:25'), ...status });
}

async function ga4Collect(request, env) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const result = await collectAnalyticsForBlogs(env, await connectedBlogs(env), { now: new Date() });
  return json({ ...result, collectionEnabled: env?.GA4_COLLECTION_ENABLED === 'true', collectionTime: String(env?.GA4_COLLECTION_TIME || '03:25') }, result.failedCount > 0 ? 207 : 200);
}

async function ga4BlogRows(request, env, blogId) {
  if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const url = new URL(request.url);
  const snapshotDate = operationsPlanDate(env, new Date());
  const rows = await listAnalyticsTopRows(env, snapshotDate, blogId, url.searchParams.get('limit') || 50);
  return json({ ok: true, snapshotDate, blogId: String(blogId), rows, count: rows.length });
}

function matchGscBlogPath(pathname) {
  const match = pathname.match(/^\/api\/performance\/gsc\/blogs\/([^/]+)$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function matchGa4BlogPath(pathname) {
  const match = pathname.match(/^\/api\/performance\/ga4\/blogs\/([^/]+)$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const retryJobId = matchManualJobPath(url.pathname, 'retry');
    if (request.method === 'POST' && retryJobId !== null) {
      return manualRetry(request, env, retryJobId);
    }
    const runJobId = matchManualJobPath(url.pathname, 'run');
    if (request.method === 'POST' && runJobId !== null) {
      return runManualJob(request, env, ctx, runJobId);
    }
    if (request.method === 'GET' && url.pathname === '/api/operations/recovery') {
      try { return await recoveryStatus(request, env); } catch (error) { return json({ error: safeFailureCode(error) }, error?.status || 500); }
    }
    if (request.method === 'POST' && url.pathname === '/api/operations/work-tick') {
      return workTick(request, env, ctx);
    }
    if (request.method === 'GET' && url.pathname === '/api/performance/gsc/today') {
      try { return await gscStatus(request, env); } catch (error) { return json({ error: safeFailureCode(error) }, error?.status || 500); }
    }
    if (request.method === 'POST' && url.pathname === '/api/performance/gsc/collect') {
      try { return await gscCollect(request, env); } catch (error) { return json({ error: safeFailureCode(error) }, error?.status || 500); }
    }
    const gscBlogId = matchGscBlogPath(url.pathname);
    if (request.method === 'GET' && gscBlogId !== null) {
      try { return await gscBlogRows(request, env, gscBlogId); } catch (error) { return json({ error: safeFailureCode(error) }, error?.status || 500); }
    }
    if (request.method === 'GET' && url.pathname === '/api/performance/ga4/today') {
      try { return await ga4Status(request, env); } catch (error) { return json({ error: safeFailureCode(error) }, error?.status || 500); }
    }
    if (request.method === 'POST' && url.pathname === '/api/performance/ga4/collect') {
      try { return await ga4Collect(request, env); } catch (error) { return json({ error: safeFailureCode(error) }, error?.status || 500); }
    }
    const ga4BlogId = matchGa4BlogPath(url.pathname);
    if (request.method === 'GET' && ga4BlogId !== null) {
      try { return await ga4BlogRows(request, env, ga4BlogId); } catch (error) { return json({ error: safeFailureCode(error) }, error?.status || 500); }
    }
    return app.fetch(request, env, ctx);
  },

  scheduled(event, env, ctx) {
    const now = new Date(event?.scheduledTime || Date.now());
    if (event?.cron === '*/5 * * * *') {
      ctx.waitUntil(runScheduledCoreTick(env, now, { executionContext: ctx }));
    }
  }
};