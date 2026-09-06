import phase4Entry from './phase4-entry.js';
import { requireAdmin } from './lib/admin-auth.js';
import { loadConnectedBlogs } from './lib/connected-blogs.js';
import { readAutomationSettings } from './lib/automation-settings.js';
import { hasDailyOperationStarted, isDailyOperationDue } from './lib/daily-operation-schedule.js';
import { ensureDailyPlan, operationsPlanDate } from './lib/daily-operations.js';
import { listAdaptiveWorkloadDecisions } from './lib/adaptive-workload.js';
import { collectAnalyticsForBlogs } from './lib/ga4-collector.js';
import { listGa4Coverage } from './lib/ga4-coverage.js';
import { runScheduledImageCompletion } from './lib/image-completion.js';
import { listImageDiagnostics } from './lib/image-diagnostics.js';
import { adoptManualReadyArticles } from './lib/manual-ready-adoption.js';
import { listTopicCandidates, refreshTopicCandidatesFromGsc } from './lib/topic-candidates.js';
import { applyIdeaToCandidates, createIdea, listContentStrategy, strategyLinksForTopic } from './lib/content-strategy.js';
import { refreshContentStrategyAtomic } from './lib/content-strategy-refresh.js';
import { buildSeoBrief } from './lib/seo-brief.js';
import { listContentDecay } from './lib/content-decay.js';
import { runPublishTick } from './phase5-ops-tick.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

async function requireAdminOr401(request, env) {
  return await requireAdmin(request, env);
}

export function dailyPlanCoverageComplete(blogs = [], decisions = []) {
  const expected = new Set((blogs || []).map((blog) => String(blog?.blogId || blog?.id || '').trim()).filter(Boolean));
  if (expected.size === 0) return true;
  const planned = new Set((decisions || []).map((item) => String(item?.blogId || '').trim()).filter(Boolean));
  for (const blogId of expected) if (!planned.has(blogId)) return false;
  return true;
}

export async function runDailyPlanSelfHeal(env, now = new Date()) {
  const automation = await readAutomationSettings(env, []);
  const settings = automation?.global || {};

  if (!hasDailyOperationStarted(settings, now)) {
    return { ok: true, checked: false, reason: 'BEFORE_DAILY_OPERATION_START' };
  }
  if (isDailyOperationDue(settings, now, 5)) {
    return { ok: true, checked: false, reason: 'CORE_DAILY_PLAN_WINDOW' };
  }

  const blogs = await loadConnectedBlogs(env);
  const planDate = operationsPlanDate(env, now);
  const existing = await listAdaptiveWorkloadDecisions(env, planDate);
  const coverageBefore = dailyPlanCoverageComplete(blogs, existing.decisions);
  const result = await ensureDailyPlan(env, blogs, { now });
  const repaired = !coverageBefore || Number(result.insertedSlots || 0) > 0 || Number(result.reactivatedSlots || 0) > 0;

  return {
    ...result,
    checked: true,
    refreshed: true,
    repaired,
    recoveredAfterStartWindow: true,
    decisionCountBefore: existing.count,
    coverageBefore
  };
}

export function isStrategyRefreshDue(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.hour === '03' && values.minute === '20';
}

export async function runStrategyRefresh(env) {
  const candidates = await refreshTopicCandidatesFromGsc(env);
  const strategy = await refreshContentStrategyAtomic(env);
  return { ok: true, refreshedCount: candidates.refreshedCount, strategy };
}

async function manualGa4Collect(request, env) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const blogs = await loadConnectedBlogs(env);
  const result = await collectAnalyticsForBlogs(env, blogs, { now: new Date() });
  const coverage = await listGa4Coverage(env, blogs);
  return json({ ...result, coverage }, result.failedCount > 0 ? 207 : 200);
}

async function topicCandidates(request, env) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const url = new URL(request.url);
  return json(await listTopicCandidates(env, {
    blogId: url.searchParams.get('blogId') || '',
    intent: url.searchParams.get('intent') || '',
    status: url.searchParams.get('status') || '',
    limit: url.searchParams.get('limit') || 50
  }));
}

async function refreshTopicCandidates(request, env) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  return json(await runStrategyRefresh(env));
}

async function strategyOverview(request, env) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const url = new URL(request.url);
  return json(await listContentStrategy(env, {
    blogId: url.searchParams.get('blogId') || '',
    limit: url.searchParams.get('limit') || 30
  }));
}

async function seoBriefPreview(request, env) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const url = new URL(request.url);
  const blogId = url.searchParams.get('blogId') || '';
  const topic = url.searchParams.get('topic') || '';
  const language = url.searchParams.get('language') || 'ko';
  const topicCandidateId = Number(url.searchParams.get('topicCandidateId') || 0) || null;
  const links = blogId && topic ? await strategyLinksForTopic(env, blogId, topic, 5).catch(() => []) : [];
  return json({ ok: true, brief: await buildSeoBrief(env, { blogId, topic, language, topicCandidateId, strategyLinks: links }) });
}

async function contentDecay(request, env) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const url = new URL(request.url);
  return json(await listContentDecay(env, {
    blogId: url.searchParams.get('blogId') || '',
    limit: url.searchParams.get('limit') || 30
  }));
}

async function addIdea(request, env) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const body = await request.json().catch(() => ({}));
  return json(await createIdea(env, body), 201);
}

async function applyIdea(request, env, ideaId) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const result = await applyIdeaToCandidates(env, ideaId);
  return json(result, result.ok ? 200 : 409);
}

async function resumeImages(request, env, ctx) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  // KIE can legitimately take close to two minutes for a single image. Keep the
  // synchronous admin endpoint to one provider-bound job so an HTTP request can
  // never aggregate multiple long-running image tasks into a platform timeout.
  const result = await runScheduledImageCompletion(env, {
    maxJobs: 1,
    maxImages: 1,
    staleMinutes: 0,
    executionContext: ctx
  });
  return json(result, result.ok ? 200 : 207);
}

async function imageDiagnostics(request, env) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  return json(await listImageDiagnostics(env));
}

async function publishTick(request, env, ctx) {
  if (!await requireAdminOr401(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
  const url = new URL(request.url);
  const skipImages = ['0', 'false', 'off'].includes(String(url.searchParams.get('images') || '').toLowerCase());
  const result = await runPublishTick(env, ctx, { maxJobs: 1, skipImages, now: new Date() });
  return json(result, result.ok ? 200 : 207);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/api/performance/ga4/collect') {
        return await manualGa4Collect(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/strategy/topic-candidates') {
        return await topicCandidates(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/strategy/topic-candidates/refresh') {
        return await refreshTopicCandidates(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/strategy/overview') {
        return await strategyOverview(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/strategy/seo-brief') {
        return await seoBriefPreview(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/strategy/decay') {
        return await contentDecay(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/strategy/ideas') {
        return await addIdea(request, env);
      }
      const ideaApply = url.pathname.match(/^\/api\/strategy\/ideas\/(\d+)\/apply$/);
      if (request.method === 'POST' && ideaApply) {
        return await applyIdea(request, env, ideaApply[1]);
      }
      if (request.method === 'GET' && url.pathname === '/api/operations/images/diagnostics') {
        return await imageDiagnostics(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/operations/images/resume') {
        return await resumeImages(request, env, ctx);
      }
      if (request.method === 'POST' && url.pathname === '/api/operations/publish-tick') {
        return await publishTick(request, env, ctx);
      }
      return phase4Entry.fetch(request, env, ctx);
    } catch (error) {
      return json({ error: String(error?.message || 'PHASE5_REQUEST_FAILED').split(/[:\s]/)[0].slice(0, 80) }, error?.status || 500);
    }
  },

  scheduled(event, env, ctx) {
    if (event?.cron === '*/5 * * * *') {
      const now = new Date(event?.scheduledTime || Date.now());
      ctx.waitUntil((async () => {
        await runDailyPlanSelfHeal(env, now);
        await adoptManualReadyArticles(env, { now });
      })());
      ctx.waitUntil(runScheduledImageCompletion(env, {
        maxJobs: env?.IMAGE_COMPLETION_MAX_ITEMS || 1,
        maxImages: 1,
        staleMinutes: 2,
        executionContext: ctx
      }));
      if (isStrategyRefreshDue(now)) ctx.waitUntil(runStrategyRefresh(env));
    }
    return phase4Entry.scheduled(event, env, ctx);
  }
};
