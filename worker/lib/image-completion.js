import { readAutomationSettings } from './automation-settings.js';
import { attachStoredImages } from './image-plan.js';
import { buildSupplementalImagePlan, validateImagePolicy } from './image-policy.js';
import { generatePlannedImages } from './image-executor.js';
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

export function imagePollIntervalMs(env = {}, options = {}) {
  return boundedMs(options.pollIntervalMs ?? env?.SERIAL_IMAGE_POLL_INTERVAL_MS, 5000, 500, 5000);
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
            ), j.updated_at) AS image_activity_at
       FROM jobs j
       LEFT JOIN daily_plan_slots s ON s.job_id = j.id
      WHERE j.status = 'ready'
        AND j.archived_at IS NULL
        AND j.mode IN ('new_article', 'repair_existing')
        AND j.updated_at <= datetime('now', ?)
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
      -- Failed work gets a real retry, but only after a cooldown. This prevents one
      -- provider-chain failure from monopolizing the serial lane while also ensuring
      -- it cannot starve forever behind a continuously growing healthy backlog.
      ORDER BY CASE
                 WHEN has_failed_images = 1 AND image_activity_at <= datetime('now', ?) THEN 0
                 WHEN has_failed_images = 0 THEN 1
                 ELSE 2
               END,
               CASE WHEN has_failed_images = 1 THEN image_activity_at ELSE j.updated_at END,
               j.id
      LIMIT ?`
  ).bind(`-${staleMinutes} minutes`, `-${failedRetryCooldownMinutes} minutes`, maxJobs * 6).all();
  return result.results || [];
}

function candidateBlogs(candidates = []) {
  const ids = [...new Set(candidates
    .map((candidate) => String(candidate?.blog_id || '').trim())
    .filter(Boolean))];
  return ids.map((blogId) => ({ blogId, name: `Blog ${blogId}` }));
}

function imagePipelineMeta(candidate, plan, images, verification, extra = {}) {
  const providers = [...new Set((images || []).map((image) => String(image.provider || '').trim()).filter(Boolean))];
  return {
    version: 'image-pipeline-v2',
    mode: String(candidate.mode || 'new_article'),
    targetTotal: Number(plan.targetTotal || 0),
    existingBefore: Number(plan.existingCount || 0),
    generatedRequired: Number(plan.generatedCount || 0),
    bodyTarget: Number(plan.bodyNeeded || 0),
    currentCount: Number(verification?.currentCount ?? plan.existingCount ?? 0),
    providers,
    qa: verification?.ok === true ? 'passed' : 'pending',
    updatedAt: new Date().toISOString(),
    ...extra
  };
}

export async function completeReadyJobImages(env, candidate, effective, options = {}) {
  const jobId = Number(candidate.job_id);
  if (effective?.imagesEnabled === false) {
    return { jobId, blogId: String(candidate.blog_id), mode: String(candidate.mode), complete: true, skipped: true, reason: 'IMAGES_DISABLED', pending: 0 };
  }

  const result = readyResult(candidate);
  const plan = buildSupplementalImagePlan(candidate.mode, result.article, effective);

  if (plan.generatedCount === 0) {
    const verification = validateImagePolicy(candidate.mode, result.article, effective);
    const nextResult = {
      ...result,
      imagePipeline: imagePipelineMeta(candidate, plan, [], verification, { generated: 0, reusedExisting: true })
    };
    await persistJobResult(env, jobId, nextResult);
    return {
      jobId,
      blogId: String(candidate.blog_id),
      mode: String(candidate.mode),
      complete: verification.ok,
      skipped: true,
      reason: verification.ok ? 'EXISTING_IMAGES_SUFFICIENT' : 'IMAGE_POLICY_INCOMPLETE',
      targetTotal: plan.targetTotal,
      existingCount: plan.existingCount,
      generated: 0,
      pending: 0,
      failed: 0
    };
  }

  await persistImagePlan(env, jobId, plan.images);
  let images = await listJobImages(env, jobId);
  let state = imageCompletionState(images, plan.generatedCount);
  let generated = { requested: 0, stored: 0, pending: 0, failed: 0, outcomes: [] };

  if (!state.complete) {
    generated = await generatePlannedImages(env, jobId, {
      retryFailed: true,
      maxImages: positiveLimit(options.maxImages, 1, 3),
      localFallback: env?.LOCAL_IMAGE_FALLBACK_ENABLED === 'true',
      executionContext: options.executionContext
    });
    images = await listJobImages(env, jobId);
    state = imageCompletionState(images, plan.generatedCount);
  }

  const attachableImages = images.filter((image) => String(image.status) === 'stored');
  const article = attachStoredImages(result.article, images);
  const verification = validateImagePolicy(candidate.mode, article, effective);
  const visibleImages = images.filter((image) => ['stored', 'attached'].includes(String(image.status)) && /^https:\/\//i.test(String(image.public_url || '')));

  if (visibleImages.length > 0) {
    const nextResult = {
      ...result,
      article,
      images: visibleImages.map((image) => ({
        id: image.id,
        role: image.role,
        position: image.position,
        url: image.public_url,
        altText: image.alt_text,
        provider: image.provider || null
      })),
      imagePipeline: imagePipelineMeta(candidate, plan, images, verification, {
        complete: verification.ok,
        generated: visibleImages.length,
        attachedThisRun: attachableImages.length,
        reusedExisting: plan.existingCount > 0,
        lastAttachedAt: new Date().toISOString()
      })
    };
    await persistJobResult(env, jobId, nextResult);
    for (const image of attachableImages) await markImageAttached(env, image.id);
    images = await listJobImages(env, jobId);
    state = imageCompletionState(images, plan.generatedCount);
  }

  if (!verification.ok) {
    return {
      jobId,
      blogId: String(candidate.blog_id),
      mode: String(candidate.mode),
      complete: false,
      generated: generated.stored,
      pending: generated.pending,
      failed: generated.failed,
      attachedThisRun: attachableImages.length,
      targetTotal: plan.targetTotal,
      existingCount: plan.existingCount,
      currentCount: verification.currentCount,
      missing: verification.missing,
      ...state
    };
  }

  return {
    jobId,
    blogId: String(candidate.blog_id),
    mode: String(candidate.mode),
    complete: true,
    generated: generated.stored,
    pending: generated.pending,
    failed: generated.failed,
    attachedThisRun: attachableImages.length,
    targetTotal: plan.targetTotal,
    existingCount: plan.existingCount,
    currentCount: verification.currentCount,
    ...state
  };
}

export async function runScheduledImageCompletion(env, options = {}) {
  if (env?.DAILY_WORK_EXECUTION_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'DAILY_WORK_EXECUTION_DISABLED', attempted: 0, completed: 0, items: [] };
  }

  // Image completion must remain independent from API Hub/Blogger inventory.
  // The ready jobs already carry stable blog IDs, and automation settings live in D1.
  // A transient Blogger/API Hub outage must never strand image work at READY.
  const candidates = await listReadyImageCandidates(env, options);
  const blogs = options.blogs || candidateBlogs(candidates);
  const automation = options.automation || await readAutomationSettings(env, blogs);
  const settingsByBlog = new Map((automation.blogs || []).map((item) => [String(item.blogId), item.effective || {}]));
  const items = [];
  const maxJobs = positiveLimit(options.maxJobs, env?.IMAGE_COMPLETION_MAX_ITEMS || 1);
  const pollIntervalMs = imagePollIntervalMs(env, options);
  const articleCooldownMs = articleImageCooldownMs(env, options);
  const jobBudgetMs = imageJobBudgetMs(env, options);
  const chainBudgetMs = imageChainBudgetMs(env, options);
  const chainStartedAt = Date.now();

  for (const candidate of candidates) {
    if (items.length >= maxJobs) break;
    if (Date.now() - chainStartedAt >= chainBudgetMs) break;
    const effective = settingsByBlog.get(String(candidate.blog_id)) || automation.global;
    if (!effective?.enabled) continue;

    const jobStartedAt = Date.now();
    let item = null;
    try {
      // Keep one article in the image lane until it either completes, fails, or
      // exhausts its bounded execution budget. Each provider call handles exactly
      // one image, so image N+1 starts immediately after image N is actually stored.
      // While KIE is still processing the current image, poll that same task instead
      // of starting an image for another article.
      while (Date.now() - jobStartedAt < jobBudgetMs && Date.now() - chainStartedAt < chainBudgetMs) {
        item = await completeReadyJobImages(env, candidate, effective, { ...options, maxImages: 1 });
        if (item?.complete || Number(item?.failed || 0) > 0) break;
        if (Number(item?.pending || 0) > 0) {
          await sleep(pollIntervalMs);
          continue;
        }
        if (Number(item?.generated || 0) > 0 || Number(item?.attachedThisRun || 0) > 0) continue;
        break;
      }

      if (item && !item.complete && Number(item?.failed || 0) === 0 && Date.now() - jobStartedAt >= jobBudgetMs) {
        item = { ...item, reason: 'IMAGE_JOB_BUDGET_EXHAUSTED' };
      }
      if (item) items.push(item);
    } catch (error) {
      item = {
        jobId: Number(candidate.job_id),
        blogId: String(candidate.blog_id),
        mode: String(candidate.mode),
        complete: false,
        errorCode: String(error?.message || 'IMAGE_COMPLETION_FAILED').split(/[:\s]/)[0].slice(0, 80)
      };
      items.push(item);
    }

    // Never interleave articles. If this article is still incomplete, leave it at
    // the head of the next watchdog run rather than starting another article now.
    if (!item?.complete) break;
    if (items.length >= maxJobs) break;

    // The fixed 10-second safety gap belongs at the article boundary, not between
    // images in the same article. Keep enough time in reserve for the image-lane
    // lease instead of sleeping and starting work that cannot finish safely.
    if (articleCooldownMs > 0) {
      if (Date.now() - chainStartedAt + articleCooldownMs >= chainBudgetMs) break;
      await sleep(articleCooldownMs);
    }
  }
  return {
    ok: items.every((item) => !item.errorCode),
    enabled: true,
    attempted: items.length,
    completed: items.filter((item) => item.complete).length,
    repairAttempted: items.filter((item) => item.mode === 'repair_existing').length,
    newAttempted: items.filter((item) => item.mode === 'new_article').length,
    pollIntervalMs,
    articleCooldownMs,
    items
  };
}