import { createPhase1Snapshot, normalizeExistingRepairRequest } from './lib/contracts.js';
import { callHub } from './lib/api-hub.js';
import { normalizeBlogList } from './lib/blog-registry.js';
import { loadManagedBlogsSnapshot } from './lib/connected-blogs.js';
import { dateInTimeZone } from './lib/daily-plan.js';
import { listDailySlots, persistDailySlots } from './lib/daily-plan-store.js';
import { materializeDailySlot } from './lib/daily-slot-materializer.js';
import { ensureDailyPlan } from './lib/daily-operations.js';
import { listDailyDiagnostics } from './lib/daily-diagnostics.js';
import { listAdaptiveWorkloadDecisions } from './lib/adaptive-workload.js';
import {
  buildAutomationPreview,
  buildDailySlotsFromAutomation,
  readAutomationSettings,
  resolveContentLanguage,
  saveBlogAutomationSettings,
  saveGlobalAutomationSettings
} from './lib/automation-settings.js';
import {
  ADMIN_SESSION,
  adminSessionCookie,
  clearAdminSessionCookie,
  createAdminSessionToken,
  requireAdmin
} from './lib/admin-auth.js';
import { attachStoredImages, buildImagePlan } from './lib/image-plan.js';
import { generatePlannedImages } from './lib/image-executor.js';
import { listJobImages, markImageAttached, persistImagePlan } from './lib/image-store.js';
import { diagnoseCloudflareViaHub } from './lib/provider-diagnostics.js';
import { getStoredJob, listStoredJobs, persistJobResult, persistJobTransition } from './lib/job-store.js';
import { processStoredJob } from './lib/stored-job-executor.js';

function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  for (const [name, value] of Object.entries(extraHeaders || {})) headers.set(name, value);
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}

async function readJson(request) {
  try { return await request.json(); } catch { throw new Error('INVALID_JSON'); }
}

async function phase1Snapshot(env) {
  if (!env.ORCHESTRATOR_DB) return createPhase1Snapshot([]);
  const rows = await env.ORCHESTRATOR_DB.prepare(
    `SELECT requirement_key FROM verification_events WHERE verified = 1 GROUP BY requirement_key`
  ).all();
  return createPhase1Snapshot((rows.results || []).map((row) => row.requirement_key));
}

async function connectedBlogs(env) {
  const data = await callHub(
    env,
    env.HUB_BLOGGER_BLOGS_PATH || '/api/blogger/blogs',
    { action: 'list' }
  );
  return normalizeBlogList(data);
}

async function connectedBlogsForReadOnlyDashboard(env) {
  try {
    return await connectedBlogs(env);
  } catch (error) {
    const snapshot = await loadManagedBlogsSnapshot(env).catch(() => []);
    if (snapshot.length) return snapshot;
    throw error;
  }
}

function operationDate(env, now = new Date()) {
  return dateInTimeZone(now, env.OPERATIONS_TIMEZONE || 'Asia/Seoul');
}

function dailyPolicy(env) {
  return {
    newArticlesPerBlog: Number(env.DAILY_NEW_PER_BLOG ?? 1),
    repairsPerBlog: Number(env.DAILY_REPAIR_PER_BLOG ?? 1)
  };
}

async function createJob(env, job) {
  if (!env.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  const result = await env.ORCHESTRATOR_DB.prepare(
    `INSERT INTO jobs (mode, blog_id, blogger_post_id, target_url, topic, status, payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, datetime('now'), datetime('now'))`
  ).bind(
    job.mode,
    job.blogId || null,
    job.bloggerPostId || null,
    job.targetUrl || null,
    job.topic || null,
    JSON.stringify(job)
  ).run();
  return result.meta?.last_row_id ?? null;
}

function matchJobPath(pathname, suffix = '') {
  const pattern = suffix ? new RegExp(`^/api/jobs/(\\d+)/${suffix}$`) : /^\/api\/jobs\/(\d+)$/;
  const match = pathname.match(pattern);
  return match ? Number(match[1]) : null;
}

function matchOperationSlotPath(pathname, suffix) {
  const match = pathname.match(new RegExp(`^/api/operations/slots/(\\d+)/${suffix}$`));
  return match ? Number(match[1]) : null;
}

function matchJobImagePath(pathname, suffix = '') {
  const end = suffix ? `/${suffix}` : '';
  const match = pathname.match(new RegExp(`^/api/jobs/(\\d+)/images${end}$`));
  return match ? Number(match[1]) : null;
}

function matchAutomationBlogPath(pathname) {
  const match = pathname.match(/^\/api\/automation\/settings\/blogs\/([^/]+)$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

function readyJobResult(row) {
  if (String(row?.status || '') !== 'ready') {
    throw Object.assign(new Error(`JOB_IMAGES_REQUIRE_READY:${row?.status || 'unknown'}`), { status: 409 });
  }
  let result;
  try { result = JSON.parse(String(row.result_json || '')); } catch {
    throw Object.assign(new Error('JOB_RESULT_INVALID'), { status: 409 });
  }
  if (!result?.article || typeof result.article !== 'object') {
    throw Object.assign(new Error('JOB_ARTICLE_MISSING'), { status: 409 });
  }
  return result;
}

function safeMediaKey(pathname) {
  const encoded = pathname.slice('/media/'.length);
  let key;
  try { key = decodeURIComponent(encoded); } catch { return null; }
  if (!key.startsWith('jobs/') || key.includes('..') || key.startsWith('/') || key.includes('\\')) return null;
  return key;
}

function normalizeRequestedLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  if (!language || language === 'auto') return null;
  if (!['ko', 'en'].includes(language)) {
    throw Object.assign(new Error('LANGUAGE_INVALID'), { status: 400 });
  }
  return language;
}

async function resolveNewArticleLanguage(env, blogId, requestedLanguage = null) {
  const explicit = normalizeRequestedLanguage(requestedLanguage);
  if (explicit) return explicit;
  const normalizedBlogId = String(blogId || '').trim();
  const blogs = await connectedBlogs(env);
  const blog = blogs.find((item) => String(item.blogId) === normalizedBlogId) || null;
  const automation = await readAutomationSettings(env, blogs);
  const blogSettings = automation.blogs.find((item) => String(item.blogId) === normalizedBlogId) || null;
  if (blogSettings?.resolvedLanguage) return blogSettings.resolvedLanguage;
  return resolveContentLanguage(blogSettings?.effective?.contentLanguage || 'auto', blog?.language || null);
}

function languageMap(automation) {
  return Object.fromEntries((automation?.blogs || []).map((blog) => [String(blog.blogId), blog.resolvedLanguage || 'ko']));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        return json({
          ok: true,
          service: 'content-orchestrator',
          bloggerWritesEnabled: env.BLOGGER_WRITES_ENABLED === 'true',
          apiHubConfigured: Boolean(env.API_HUB_BASE_URL && env.HUB_API_KEY),
          cloudflareDiagnosticPath: env.HUB_CLOUDFLARE_DIAGNOSTIC_PATH || '/api/hub/ai/diagnostics/cloudflare',
          operationsTimezone: env.OPERATIONS_TIMEZONE || 'Asia/Seoul',
          dailyPolicy: dailyPolicy(env),
          phase2Automation: {
            settingsStore: Boolean(env.ORCHESTRATOR_DB),
            autoPublishExecutionEnabled: env.AUTO_PUBLISH_EXECUTION_ENABLED === 'true',
            adminSessionDays: Math.round(ADMIN_SESSION.maxAgeSeconds / 86400)
          },
          phase2Images: {
            bucketBound: Boolean(env.IMAGE_BUCKET),
            publicBaseUrlConfigured: /^https:\/\//i.test(String(env.IMAGE_PUBLIC_BASE_URL || '')),
            hubPath: env.HUB_IMAGE_GENERATE_PATH || '/api/hub/image/generate'
          }
        });
      }

      if (request.method === 'GET' && url.pathname.startsWith('/media/')) {
        if (!env.IMAGE_BUCKET || typeof env.IMAGE_BUCKET.get !== 'function') return new Response('Not found', { status: 404 });
        const key = safeMediaKey(url.pathname);
        if (!key) return new Response('Not found', { status: 404 });
        const object = await env.IMAGE_BUCKET.get(key);
        if (!object) return new Response('Not found', { status: 404 });
        const headers = new Headers();
        object.writeHttpMetadata?.(headers);
        headers.set('cache-control', 'public, max-age=31536000, immutable');
        headers.set('x-content-type-options', 'nosniff');
        return new Response(object.body, { headers });
      }

      if (request.method === 'GET' && url.pathname === '/api/phase1') {
        return json(await phase1Snapshot(env));
      }

      if (url.pathname === '/api/admin/session') {
        if (request.method === 'GET') {
          return json({ connected: await requireAdmin(request, env) });
        }
        if (request.method === 'POST') {
          if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
          const token = await createAdminSessionToken(env.ADMIN_API_KEY);
          return json(
            { ok: true, connected: true, expiresInSeconds: ADMIN_SESSION.maxAgeSeconds },
            200,
            { 'set-cookie': adminSessionCookie(token) }
          );
        }
        if (request.method === 'DELETE') {
          return json({ ok: true, connected: false }, 200, { 'set-cookie': clearAdminSessionCookie() });
        }
        return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
      }

      if (request.method === 'GET' && url.pathname === '/api/blogs') {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const blogs = await connectedBlogs(env);
        return json({ blogs, count: blogs.length });
      }

      if (request.method === 'GET' && url.pathname === '/api/automation/settings') {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const blogs = await connectedBlogs(env);
        return json(await readAutomationSettings(env, blogs));
      }

      if (request.method === 'PUT' && url.pathname === '/api/automation/settings/global') {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const settings = await saveGlobalAutomationSettings(env, await readJson(request));
        return json({ ok: true, settings });
      }

      const automationBlogId = matchAutomationBlogPath(url.pathname);
      if (request.method === 'PUT' && automationBlogId !== null) {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const saved = await saveBlogAutomationSettings(env, automationBlogId, await readJson(request));
        return json({ ok: true, ...saved });
      }

      if (request.method === 'GET' && url.pathname === '/api/automation/preview') {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const blogs = await connectedBlogs(env);
        const settings = await readAutomationSettings(env, blogs);
        return json(buildAutomationPreview(settings, operationDate(env)));
      }

      if (request.method === 'GET' && url.pathname === '/api/operations/diagnostics/today') {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        return json(await listDailyDiagnostics(env, operationDate(env)));
      }

      if (request.method === 'GET' && url.pathname === '/api/operations/workload/today') {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        return json(await listAdaptiveWorkloadDecisions(env, operationDate(env)));
      }

      if (request.method === 'GET' && url.pathname === '/api/operations/today') {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const planDate = operationDate(env);
        const [slots, blogs, diagnostic, workload] = await Promise.all([
          listDailySlots(env, planDate),
          connectedBlogsForReadOnlyDashboard(env),
          listDailyDiagnostics(env, planDate),
          listAdaptiveWorkloadDecisions(env, planDate)
        ]);
        const automation = await readAutomationSettings(env, blogs);
        return json({
          planDate,
          policySource: 'adaptive-workload-v1',
          slots,
          count: slots.length,
          languages: languageMap(automation),
          diagnostics: diagnostic.diagnostics,
          diagnosticSummary: diagnostic.summary,
          workload
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/operations/plan-today') {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const blogs = await connectedBlogs(env);
        const automation = await readAutomationSettings(env, blogs);
        const planned = await ensureDailyPlan(env, blogs, { automation });
        return json({ ...planned, languages: languageMap(automation) });
      }

      const materializeSlotId = matchOperationSlotPath(url.pathname, 'materialize');
      if (request.method === 'POST' && materializeSlotId !== null) {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const input = await readJson(request);
        const outcome = await materializeDailySlot(env, materializeSlotId, input, {
          resolveLanguage: (blogId) => resolveNewArticleLanguage(env, blogId, input.language)
        });
        return json({
          ok: true,
          slotId: materializeSlotId,
          jobId: outcome.jobId,
          alreadyResolved: outcome.alreadyResolved,
          slot: outcome.slot,
          job: outcome.job || null
        }, outcome.alreadyResolved ? 200 : 201);
      }

      if (request.method === 'GET' && url.pathname === '/api/jobs') {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const jobs = await listStoredJobs(env, {
          limit: url.searchParams.get('limit'),
          status: url.searchParams.get('status')
        });
        return json({ jobs, count: jobs.length });
      }

      if (request.method === 'POST' && url.pathname === '/api/jobs/new') {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const input = await readJson(request);
        const blogId = String(input.blogId || '').trim();
        if (!blogId) return json({ error: 'BLOG_ID_REQUIRED' }, 400);
        if (!String(input.topic || '').trim()) return json({ error: 'TOPIC_REQUIRED' }, 400);
        const language = await resolveNewArticleLanguage(env, blogId, input.language);
        const job = { mode: 'new_article', blogId, topic: String(input.topic), language };
        return json({ accepted: true, jobId: await createJob(env, job), job }, 202);
      }

      if (request.method === 'POST' && url.pathname === '/api/jobs/repair-existing') {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const job = normalizeExistingRepairRequest(await readJson(request));
        return json({ accepted: true, jobId: await createJob(env, job), job }, 202);
      }

      const runJobId = matchJobPath(url.pathname, 'run');
      if (request.method === 'POST' && runJobId !== null) {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const row = await getStoredJob(env, runJobId);
        const outcome = await processStoredJob(env, row, {
          saveState: (state, patch) => persistJobTransition(env, runJobId, state, patch)
        });
        return json({ ok: true, jobId: runJobId, state: outcome.state, result: outcome.result });
      }

      const planImagesJobId = matchJobImagePath(url.pathname, 'plan');
      if (request.method === 'POST' && planImagesJobId !== null) {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const row = await getStoredJob(env, planImagesJobId);
        const result = readyJobResult(row);
        const input = await readJson(request);
        const plan = buildImagePlan(result.article, { bodyCount: input.bodyCount });
        const persistence = await persistImagePlan(env, planImagesJobId, plan.images);
        return json({ ok: true, jobId: planImagesJobId, requested: plan.images.length, inserted: persistence.inserted, images: await listJobImages(env, planImagesJobId) }, 201);
      }

      const listImagesJobId = matchJobImagePath(url.pathname);
      if (request.method === 'GET' && listImagesJobId !== null) {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const images = await listJobImages(env, listImagesJobId);
        return json({ jobId: listImagesJobId, images, count: images.length });
      }

      const generateImagesJobId = matchJobImagePath(url.pathname, 'generate');
      if (request.method === 'POST' && generateImagesJobId !== null) {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        readyJobResult(await getStoredJob(env, generateImagesJobId));
        const input = await readJson(request);
        const outcome = await generatePlannedImages(env, generateImagesJobId, {
          retryFailed: input.retryFailed !== false,
          executionContext: ctx
        });
        return json({ ok: outcome.failed === 0, jobId: generateImagesJobId, ...outcome }, outcome.failed === 0 ? 200 : 207);
      }

      const attachImagesJobId = matchJobImagePath(url.pathname, 'attach');
      if (request.method === 'POST' && attachImagesJobId !== null) {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const row = await getStoredJob(env, attachImagesJobId);
        const result = readyJobResult(row);
        const images = await listJobImages(env, attachImagesJobId);
        const unresolved = images.filter((image) => !['stored', 'attached'].includes(String(image.status)));
        if (!images.some((image) => image.role === 'thumbnail' && ['stored', 'attached'].includes(String(image.status)))) {
          return json({ error: 'THUMBNAIL_NOT_READY' }, 409);
        }
        if (unresolved.length) return json({ error: 'IMAGES_NOT_READY', unresolved }, 409);
        const article = attachStoredImages(result.article, images);
        const nextResult = { ...result, article, images: images.map((image) => ({ id: image.id, role: image.role, position: image.position, url: image.public_url, altText: image.alt_text })) };
        await persistJobResult(env, attachImagesJobId, nextResult);
        for (const image of images) if (image.status === 'stored') await markImageAttached(env, image.id);
        return json({ ok: true, jobId: attachImagesJobId, article, images: await listJobImages(env, attachImagesJobId) });
      }

      const readJobId = matchJobPath(url.pathname);
      if (request.method === 'GET' && readJobId !== null) {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        return json({ job: await getStoredJob(env, readJobId) });
      }

      if (request.method === 'POST' && url.pathname === '/api/diagnostics/cloudflare-ai') {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        const result = await diagnoseCloudflareViaHub(env);
        return json(result, result.ok ? 200 : (result.status || 502));
      }

      if (request.method === 'POST' && url.pathname === '/api/blogger/publish') {
        if (!await requireAdmin(request, env)) return json({ error: 'UNAUTHORIZED' }, 401);
        if (env.BLOGGER_WRITES_ENABLED !== 'true') return json({ error: 'BLOGGER_WRITES_DISABLED' }, 403);
        const input = await readJson(request);
        return json(await callHub(env, env.HUB_BLOGGER_POST_PATH || '/api/blogger/post', input));
      }

      return json({ error: 'NOT_FOUND' }, 404);
    } catch (error) {
      return json({
        error: error.message || 'INTERNAL_ERROR',
        details: env.DEBUG_ERRORS === 'true' ? (error.data ?? null) : null
      }, error.status || 500);
    }
  },

  async scheduled(controller, env, ctx) {
    const task = (async () => {
      const blogs = await connectedBlogs(env);
      return ensureDailyPlan(env, blogs, { now: new Date(controller?.scheduledTime || Date.now()) });
    })();
    ctx?.waitUntil?.(task);
    return task;
  }
};
