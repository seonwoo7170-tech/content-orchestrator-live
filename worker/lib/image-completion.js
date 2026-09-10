import { readAutomationSettings } from './automation-settings.js';
import { attachStoredImages } from './image-plan.js';
import { buildSupplementalImagePlan, validateImagePolicy } from './image-policy.js';
import { generatePlannedImages } from './image-executor-resilient.js';
import { listJobImages, markImageAttached, persistImagePlan } from './image-store.js';
import { persistJobResult } from './job-store.js';

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function positiveLimit(value, fallback = 1, max = 10) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return Math.min(max, number);
}

function boundedMs(value, fallback, min, max) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function kieImageCallbackEnabled(env = {}) {
  return String(env?.KIE_IMAGE_CALLBACK_ENABLED || 'false').trim().toLowerCase() === 'true';
}

export function kieImageCallbackRecoveryMinutes(env = {}) {
  const configured = Number(env?.KIE_IMAGE_CALLBACK_RECOVERY_MINUTES ?? 3);
  if (!Number.isInteger(configured) || configured < 2 || configured > 15) return 3;
  return configured;
}

export function imagePollIntervalMs(env = {}, options = {}) {
  return boundedMs(options.pollIntervalMs ?? env?.SERIAL_IMAGE_POLL_INTERVAL_MS, 3000, 500, 5000);
}

export function articleImageCooldownMs(env = {}, options = {}) {
  return boundedMs(options.articleCooldownMs ?? env?.SERIAL_ARTICLE_IMAGE_COOLDOWN_MS, 10_000, 0, 30_000);
}

export function imageJobBudgetMs(env = {}, options = {}) {
  return boundedMs(options.jobBudgetMs ?? env?.SERIAL_IMAGE_JOB_BUDGET_MS, 120_000, 10_000, 180_000);
}

export function imageChainBudgetMs(env = {}, options = {}) {
  return boundedMs(options.chainBudgetMs ?? env?.SERIAL_IMAGE_CHAIN_BUDGET_MS, 130_000, 30_000, 190_000);
}

function safeResult(value) {
  try { return JSON.parse(String(value || '')); } catch { return null; }
}

function readyResult(candidate) {
  const result = safeResult(candidate?.result_json);
  const mode = String(candidate?.mode || 'new_article');
  const expectedStatus = mode === 'repair_existing' ? 'READY_TO_UPDATE_EXISTING' : 'READY';
  if (!result?.article || result.status !== expectedStatus) {
    throw new Error(mode === 'repair_existing' ? 'REPAIR_IMAGE_READY_RESULT_INVALID' : 'IMAGE_COMPLETION_READY_RESULT_INVALID');
  }
  return result;
}

const ACTIVE_PROVIDER_STATES = new Set(['waiting', 'queuing', 'generating', 'pending', 'processing', 'running', 'query_retry', 'result_pending', 'result_download_retry']);

function pendingProvider(images = []) {
  const image = images.find((row) => {
    const taskId = String(row?.provider_task_id || '').trim();
    const providerState = String(row?.provider_status || '').trim().toLowerCase();
    return Boolean(taskId) && ACTIVE_PROVIDER_STATES.has(providerState);
  });
  return image ? String(image.provider || '').trim().toLowerCase() || null : null;
}

export function imageCompletionState(images = [], expectedCount = 0) {
  const expected = Math.max(0, Number(expectedCount) || 0);
  const attached = images.filter((image) => String(image.status) === 'attached').length;
  const stored = images.filter((image) => ['stored', 'attached'].includes(String(image.status))).length;
  const unresolved = images.filter((image) => !['stored', 'attached'].includes(String(image.status))).length;
  return {
    complete: images.length >= expected && stored >= expected && unresolved === 0,
    attached,
    stored,
    unresolved,
    count: images.length,
    expected
  };
}

async function listReadyImageCandidates(env, options = {}) {
  const maxJobs = positiveLimit(options.maxJobs, 1);
  const staleMinutes = Math.max(0, Math.min(60, Number(options.staleMinutes ?? 2) || 0));
  const failedRetryCooldownMinutes = Math.max(3, Math.min(60, Number(options.failedRetryCooldownMinutes ?? 10) || 10));
  const callbackMode = kieImageCallbackEnabled(env);
  const callbackRecoveryMinutes = kieImageCallbackRecoveryMinutes(env);
  const result = await requireDb(env).prepare(
    `SELECT DISTINCT j.id AS job_id, j.mode, j.blog_id, j.result_json, j.updated_at,
            COALESCE(s.plan_date, date('now')) AS plan_date,
            EXISTS(
              SELECT 1
                FROM job_images fi
               WHERE fi.job_id = j.id
                 AND fi.status = 'failed'
            ) AS has_failed_images,
            COALESCE((
              SELECT MAX(ai.updated_at)
                FROM job_images ai
               WHERE ai.job_id = j.id
            ), j.updated_at) AS image_activity_at,
            EXISTS(
              SELECT 1
                FROM job_images pi
               WHERE pi.job_id = j.id
                 AND pi.provider_task_id IS NOT NULL
                 AND pi.provider_status IN ('waiting', 'queuing', 'generating', 'pending', 'processing', 'running', 'query_retry', 'result_pending', 'result_download_retry')
            ) AS has_active_provider_task,
            COALESCE((
              SELECT MIN(COALESCE(pi.provider_checked_at, pi.updated_at))
                FROM job_images pi
               WHERE pi.job_id = j.id
                 AND pi.provider_task_id IS NOT NULL
                 AND pi.provider_status IN ('waiting', 'queuing', 'generating', 'pending', 'processing', 'running', 'query_retry', 'result_pending', 'result_download_retry')
            ), j.updated_at) AS active_provider_checked_at
       FROM jobs j
       LEFT JOIN daily_plan_slots s ON s.job_id = j.id
      WHERE j.status = 'ready'
        AND j.archived_at IS NULL
        AND j.mode IN ('new_article', 'repair_existing')
        AND datetime(j.updated_at) <= datetime('now', ?)
        AND (
          ? = 0
          OR NOT EXISTS (
            SELECT 1
              FROM job_images ci
             WHERE ci.job_id = j.id
               AND COALESCE(ci.provider, 'kie-ai') = 'kie-ai'
               AND ci.provider_task_id IS NOT NULL
               AND ci.provider_status IN ('waiting', 'queuing', 'generating', 'pending', 'processing', 'running', 'query_retry', 'result_pending', 'result_download_retry')
               AND datetime(COALESCE(ci.provider_checked_at, ci.updated_at)) > datetime('now', ?)
          )
        )
        AND (
          j.mode = 'repair_existing'
          OR (
            j.mode = 'new_article'
            AND (
              s.job_id IS NULL
              OR (s.kind = 'new_article' AND s.status = 'resolved')
            )
          )
        )
      ORDER BY CASE
                 WHEN has_active_provider_task = 1 THEN 0
                 WHEN has_failed_images = 1 AND datetime(image_activity_at) <= datetime('now', ?) THEN 1
                 WHEN has_failed_images = 0 THEN 2
                 ELSE 3
               END,
               CASE
                 WHEN has_active_provider_task = 1 THEN datetime(active_provider_checked_at)
                 WHEN has_failed_images = 1 THEN datetime(image_activity_at)
                 ELSE datetime(j.updated_at)
               END,
               j.id
      LIMIT ?`
  ).bind(
    `-${staleMinutes} minutes`,
    callbackMode ? 1 : 0,
    `-${callbackRecoveryMinutes} minutes`,
    `-${failedRetryCooldownMinutes} minutes`,
    maxJobs * 6
  ).all();
  return result.results || [];
}

function candidateBlogs(candidates = []) {
  return [...new Set(candidates.map((candidate) => String(candidate.blog_id || '')).filter(Boolean))];
}

async function settingsForCandidates(candidates, env) {
  const blogs = candidateBlogs(candidates);
  const settings = new Map();
  for (const blogId of blogs) {
    settings.set(blogId, await readAutomationSettings(env, blogId));
  }
  return settings;
}

function candidateEnabled(candidate, settingsByBlog) {
  const settings = settingsByBlog.get(String(candidate.blog_id || ''));
  if (!settings?.enabled || !settings?.imagesEnabled) return false;
  if (candidate.mode === 'repair_existing') return settings.repairsEnabled !== false;
  return settings.newArticlesEnabled !== false;
}

async function ensureImagePlan(candidate, env, options = {}) {
  const result = readyResult(candidate);
  const current = await listJobImages(candidate.job_id, env);
  const expectedBodyCount = Math.max(0, Number(result?.imagePipeline?.bodyTarget ?? result?.imagePipeline?.body_target ?? options.bodyImageCount ?? 2) || 0);
  const expectedTotal = 1 + expectedBodyCount;
  if (current.length >= expectedTotal) return { result, images: current, expectedTotal };

  const plan = buildSupplementalImagePlan({
    article: result.article,
    currentImages: current,
    targetBodyImages: expectedBodyCount
  });
  if (plan.length) await persistImagePlan(candidate.job_id, plan, env);
  return { result, images: await listJobImages(candidate.job_id, env), expectedTotal };
}

async function attachCompletedImages(candidate, result, env) {
  const latest = await listJobImages(candidate.job_id, env);
  const stored = latest.filter((image) => image.status === 'stored');
  if (!stored.length) return latest;

  const attachedResult = await attachStoredImages(result, stored, env);
  for (const image of stored) await markImageAttached(image.id, env);
  await persistJobResult(candidate.job_id, attachedResult, env);
  return listJobImages(candidate.job_id, env);
}

async function completeCandidate(candidate, env, options = {}) {
  const { result, images, expectedTotal } = await ensureImagePlan(candidate, env, options);
  const before = imageCompletionState(images, expectedTotal);
  if (before.complete) {
    const attached = await attachCompletedImages(candidate, result, env);
    return { jobId: candidate.job_id, complete: imageCompletionState(attached, expectedTotal).complete };
  }

  const provider = pendingProvider(images);
  const generated = await generatePlannedImages(candidate.job_id, env, {
    limit: positiveLimit(options.maxImages, 1),
    provider,
    executionContext: options.executionContext
  });
  let latest = generated?.images || await listJobImages(candidate.job_id, env);
  latest = await attachCompletedImages(candidate, result, env);
  const after = imageCompletionState(latest, expectedTotal);
  return {
    jobId: candidate.job_id,
    complete: after.complete,
    generated: Number(generated?.generated || 0),
    provider: generated?.provider || provider || null,
    state: after
  };
}

export async function runScheduledImageCompletion(env, options = {}) {
  const candidates = await listReadyImageCandidates(env, options);
  if (!candidates.length) return { processed: 0, completed: 0, results: [] };
  const settingsByBlog = await settingsForCandidates(candidates, env);
  const maxJobs = positiveLimit(options.maxJobs, 1);
  const selected = candidates.filter((candidate) => candidateEnabled(candidate, settingsByBlog)).slice(0, maxJobs);
  const results = [];
  const started = Date.now();
  const budget = imageChainBudgetMs(env, options);

  for (const candidate of selected) {
    if (Date.now() - started >= budget) break;
    const completion = await completeCandidate(candidate, env, options);
    results.push(completion);
    if (!completion.complete) break;
    const cooldown = articleImageCooldownMs(env, options);
    if (cooldown > 0 && results.length < selected.length) await sleep(cooldown);
  }

  return {
    processed: results.length,
    completed: results.filter((result) => result.complete).length,
    results
  };
}

export async function runImageCompletionForJob(jobId, env, options = {}) {
  const candidates = await listReadyImageCandidates(env, {
    ...options,
    maxJobs: Math.max(positiveLimit(options.maxJobs, 1), 10)
  });
  const candidate = candidates.find((row) => Number(row.job_id) === Number(jobId));
  if (!candidate) return { processed: 0, completed: 0, results: [] };
  const settingsByBlog = await settingsForCandidates([candidate], env);
  if (!candidateEnabled(candidate, settingsByBlog)) return { processed: 0, completed: 0, results: [] };
  const result = await completeCandidate(candidate, env, options);
  return { processed: 1, completed: result.complete ? 1 : 0, results: [result] };
}

export function validateCompletionPolicy(result, images = []) {
  const validation = validateImagePolicy(result?.article, images);
  return {
    ok: validation.ok,
    violations: validation.violations || [],
    expected: validation.expected || null,
    actual: validation.actual || null
  };
}
