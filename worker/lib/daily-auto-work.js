import { callHub } from './api-hub.js';
import { materializeDailySlot } from './daily-slot-materializer.js';
import { listDailySlots } from './daily-plan-store.js';
import { getStoredJob, persistJobResult, persistJobTransition } from './job-store.js';
import { processStoredJob } from './stored-job-executor.js';
import { attachStoredImages, buildImagePlan } from './image-plan.js';
import { generatePlannedImages } from './image-executor.js';
import { listJobImages, markImageAttached, persistImagePlan } from './image-store.js';
import {
  listStrategyAvoidTopics,
  markTopicCandidateUsed,
  releaseTopicCandidate,
  reserveBestNewTopicCandidate,
  strategyLinksForTopic
} from './content-strategy.js';
import {
  findNewArticleTopicConflict,
  rejectDuplicateTopicCandidate,
  reservePlannerTopicCandidate
} from './topic-dedupe.js';
import {
  isDailySlotRecoveryEligible,
  registerDailySlotFailure,
  registerJobFailure,
  safeFailureCode
} from './job-recovery.js';

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function positiveLimit(value, fallback = 1) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 20) throw new Error('DAILY_WORK_LIMIT_INVALID');
  return number;
}

function normalizePosts(data) {
  return Array.isArray(data?.posts) ? data.posts.filter((post) => String(post?.bloggerPostId || '').trim()) : [];
}

function byOldest(left, right) {
  const a = Date.parse(left?.published || left?.updated || '') || 0;
  const b = Date.parse(right?.published || right?.updated || '') || 0;
  return a - b || String(left?.bloggerPostId || '').localeCompare(String(right?.bloggerPostId || ''));
}

export function selectOldestRepairCandidate(posts = [], claimedPostIds = []) {
  const claimed = new Set((claimedPostIds || []).map(String));
  return [...posts]
    .filter((post) => post?.bloggerPostId && !claimed.has(String(post.bloggerPostId)))
    .sort(byOldest)[0] || null;
}

export function orderPendingWork(slots = [], now = new Date(), blogOrder = []) {
  const blogIndex = new Map((blogOrder || []).map((blogId, index) => [String(blogId), index]));
  const kindRank = new Map([['new_article', 0], ['repair_existing', 1]]);
  return [...slots]
    .filter((slot) => isDailySlotRecoveryEligible(slot, now))
    .sort((left, right) => {
      const kind = (kindRank.get(String(left.kind)) ?? 9) - (kindRank.get(String(right.kind)) ?? 9);
      if (kind) return kind;
      const round = Number(left.slot_no || 0) - Number(right.slot_no || 0);
      if (round) return round;
      const leftBlog = String(left.blog_id || '');
      const rightBlog = String(right.blog_id || '');
      const blog = (blogIndex.get(leftBlog) ?? Number.MAX_SAFE_INTEGER) - (blogIndex.get(rightBlog) ?? Number.MAX_SAFE_INTEGER);
      if (blog) return blog;
      const priority = Number(right.priority_score || 0) - Number(left.priority_score || 0);
      if (priority) return priority;
      return Number(left.id || 0) - Number(right.id || 0);
    });
}

async function claimedRepairIds(env, blogId) {
  const rows = await requireDb(env).prepare(
    `SELECT DISTINCT blogger_post_id
     FROM jobs
     WHERE mode = 'repair_existing' AND blog_id = ? AND blogger_post_id IS NOT NULL AND blogger_post_id <> ''`
  ).bind(String(blogId)).all();
  return (rows.results || []).map((row) => String(row.blogger_post_id));
}

function settingsByBlog(automation) {
  return new Map((automation?.blogs || []).map((item) => [String(item.blogId), item]));
}

function blogsById(blogs) {
  return new Map((blogs || []).map((blog) => [String(blog.blogId || blog.id), blog]));
}

async function inventory(env, blogId, limit, callHubFn) {
  return normalizePosts(await callHubFn(env, env.HUB_BLOGGER_POSTS_PATH || '/api/blogger/posts', {
    blogId: String(blogId),
    limit
  }));
}

async function advisory(call, fallback = null) {
  try { return await call(); } catch { return fallback; }
}

function strategyRecentPosts(avoidTopics = []) {
  return (avoidTopics || []).map((item) => ({
    title: String(item?.query || '').trim(),
    url: item?.targetPage || null,
    strategyOnly: true
  })).filter((item) => item.title);
}

function safeRecoveryView(value) {
  if (!value) return null;
  return {
    recoveryState: value.recoveryState || null,
    retryCount: Number(value.retryCount || 0),
    nextRetryAt: value.nextRetryAt || null,
    holdReason: value.holdReason || null,
    code: value.code || null
  };
}

async function markNoRepairCandidateSkipped(env, slotId) {
  const result = await requireDb(env).prepare(
    `UPDATE daily_plan_slots
     SET status = 'skipped', last_error_code = NULL, recovery_state = 'none', next_retry_at = NULL,
         hold_reason = NULL, updated_at = datetime('now')
     WHERE id = ? AND kind = 'repair_existing' AND status = 'pending'`
  ).bind(Number(slotId)).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function previewAutomaticWork(env, blogs, automation, options = {}) {
  const planDate = String(options.planDate || '').trim();
  if (!planDate) throw new Error('DAILY_WORK_PLAN_DATE_REQUIRED');
  const maxItems = positiveLimit(options.maxItems, 20);
  const now = options.now || new Date();
  const slots = options.slots || await listDailySlots(env, planDate);
  const pending = orderPendingWork(slots, now, (blogs || []).map((blog) => String(blog?.blogId || blog?.id || '')));
  const blogMap = blogsById(blogs);
  const settingMap = settingsByBlog(automation);
  const callHubFn = options.callHubFn || callHub;
  const selections = [];

  for (const slot of pending) {
    if (selections.length >= maxItems) break;
    const blogId = String(slot.blog_id || '');
    const blog = blogMap.get(blogId) || null;
    const configured = settingMap.get(blogId) || null;
    const effective = configured?.effective || automation?.global || {};
    if (!blog || effective.enabled === false) continue;

    if (slot.kind === 'new_article') {
      selections.push({
        slotId: Number(slot.id),
        blogId,
        blogName: slot.blog_name || blog.name || null,
        kind: slot.kind,
        priorityScore: Number(slot.priority_score || 0),
        language: configured?.resolvedLanguage || 'ko',
        operationMode: effective.operationMode || 'validation',
        action: 'plan_topic_then_run'
      });
      continue;
    }

    if (slot.kind === 'repair_existing') {
      try {
        const [posts, claimed] = await Promise.all([
          inventory(env, blogId, 2000, callHubFn),
          claimedRepairIds(env, blogId)
        ]);
        const candidate = selectOldestRepairCandidate(posts, claimed);
        selections.push({
          slotId: Number(slot.id),
          blogId,
          blogName: slot.blog_name || blog.name || null,
          kind: slot.kind,
          priorityScore: Number(slot.priority_score || 0),
          operationMode: effective.operationMode || 'validation',
          action: candidate ? 'repair_oldest_unclaimed' : 'no_candidate',
          candidate: candidate ? {
            bloggerPostId: String(candidate.bloggerPostId),
            title: candidate.title || null,
            targetUrl: candidate.url || null,
            published: candidate.published || null
          } : null
        });
      } catch (error) {
        selections.push({
          slotId: Number(slot.id),
          blogId,
          blogName: slot.blog_name || blog.name || null,
          kind: slot.kind,
          priorityScore: Number(slot.priority_score || 0),
          operationMode: effective.operationMode || 'validation',
          action: 'selection_failed',
          errorCode: safeFailureCode(error),
          candidate: null
        });
      }
    }
  }

  return { planDate, pendingCount: pending.length, selections };
}

async function runStoredJob(env, jobId, options = {}) {
  const row = await (options.getStoredJobFn || getStoredJob)(env, jobId);
  return (options.processStoredJobFn || processStoredJob)(env, row, {
    saveState: (state, patch) => (options.persistTransitionFn || persistJobTransition)(env, jobId, state, patch),
    fetchImpl: options.fetchImpl
  });
}

function parseReadyResult(row) {
  if (String(row?.status || '') !== 'ready') throw new Error(`AUTO_WORK_JOB_NOT_READY:${row?.status || 'unknown'}`);
  let result;
  try { result = JSON.parse(String(row.result_json || '')); } catch { throw new Error('AUTO_WORK_RESULT_JSON_INVALID'); }
  if (!result?.article) throw new Error('AUTO_WORK_READY_ARTICLE_MISSING');
  return result;
}

export async function prepareNewArticleImages(env, jobId, effective, options = {}) {
  if (effective?.imagesEnabled === false) return { enabled: false, reason: 'IMAGES_DISABLED' };
  const row = await (options.getStoredJobFn || getStoredJob)(env, jobId);
  const result = parseReadyResult(row);
  const strategyLinks = await advisory(
    () => (options.strategyLinksForTopicFn || strategyLinksForTopic)(env, String(row.blog_id || ''), String(row.topic || ''), 3),
    []
  );
  const bodyCount = Math.max(0, Math.min(3, Number(effective?.bodyImageCount ?? 2)));
  const plan = buildImagePlan(result.article, { bodyCount });
  await (options.persistImagePlanFn || persistImagePlan)(env, jobId, plan.images);
  const generated = await (options.generatePlannedImagesFn || generatePlannedImages)(env, jobId, {
    retryFailed: true,
    executionContext: options.executionContext
  });
  if (generated.failed > 0) throw new Error(`AUTO_WORK_IMAGE_GENERATION_FAILED:${generated.failed}`);
  const images = await (options.listJobImagesFn || listJobImages)(env, jobId);
  const unresolved = images.filter((image) => !['stored', 'attached'].includes(String(image.status)));
  if (unresolved.length) throw new Error(`AUTO_WORK_IMAGES_UNRESOLVED:${unresolved.length}`);
  if (!images.some((image) => image.role === 'thumbnail' && ['stored', 'attached'].includes(String(image.status)))) {
    throw new Error('AUTO_WORK_THUMBNAIL_MISSING');
  }
  const article = attachStoredImages(result.article, images);
  const nextResult = {
    ...result,
    article,
    strategy: {
      ...(result.strategy || {}),
      internalLinks: strategyLinks.map((item) => ({ query: item.query, url: item.url, similarity: item.similarity }))
    },
    images: images.map((image) => ({ id: image.id, role: image.role, position: image.position, url: image.public_url, altText: image.alt_text }))
  };
  await (options.persistJobResultFn || persistJobResult)(env, jobId, nextResult);
  for (const image of images) {
    if (image.status === 'stored') await (options.markImageAttachedFn || markImageAttached)(env, image.id);
  }
  return { enabled: true, bodyCount, count: images.length, internalLinkSuggestions: strategyLinks.length };
}

async function registerSelectionFailure(env, selection, error, now, options = {}) {
  const errorCode = safeFailureCode(error);
  try {
    const recovery = await (options.registerDailySlotFailureFn || registerDailySlotFailure)(env, selection.slotId, errorCode, { now });
    return { errorCode, recovery: safeRecoveryView(recovery), recoveryRegistrationError: null };
  } catch (recoveryError) {
    return { errorCode, recovery: null, recoveryRegistrationError: safeFailureCode(recoveryError) };
  }
}

async function registerMaterializedFailure(env, selection, materialized, error, now, options = {}) {
  const errorCode = safeFailureCode(error);
  try {
    const getFn = options.getStoredJobFn || getStoredJob;
    const persistFn = options.persistTransitionFn || persistJobTransition;
    let row = await getFn(env, materialized.jobId);
    if (selection.kind === 'new_article' && String(row?.status || '') === 'ready') {
      await persistFn(env, materialized.jobId, 'failed', { error: errorCode });
      row = await getFn(env, materialized.jobId);
    }
    if (String(row?.status || '') !== 'failed') {
      return { errorCode, recovery: null, recoveryRegistrationError: `JOB_RECOVERY_NOT_FAILED_${safeFailureCode(row?.status || 'UNKNOWN')}` };
    }
    const recovery = await (options.registerJobFailureFn || registerJobFailure)(env, materialized.jobId, errorCode, { now });
    return { errorCode, recovery: safeRecoveryView(recovery), recoveryRegistrationError: null };
  } catch (recoveryError) {
    return { errorCode, recovery: null, recoveryRegistrationError: safeFailureCode(recoveryError) };
  }
}

async function planUniqueTopic(env, selection, blog, recentPosts, callHubFn, options = {}) {
  const findConflictFn = options.findTopicConflictFn || findNewArticleTopicConflict;
  const reservePlannerFn = options.reservePlannerTopicFn || reservePlannerTopicCandidate;
  let avoid = [...recentPosts];
  let lastConflict = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const topicPlan = await callHubFn(env, env.HUB_TOPIC_PLANNER_PATH || '/api/hub/ai/topic', {
      blogId: selection.blogId,
      blogName: selection.blogName || blog.name || `Blog ${selection.blogId}`,
      blogUrl: blog.url || null,
      language: selection.language,
      operationMode: selection.operationMode,
      recentPosts: avoid
    });
    const topic = String(topicPlan?.topic || '').trim();
    if (!topic) throw new Error('AUTO_WORK_TOPIC_MISSING');

    const conflict = await findConflictFn(env, {
      blogId: selection.blogId,
      topic,
      threshold: 0.74
    });
    if (conflict) {
      lastConflict = conflict;
      avoid = [{ title: topic, strategyOnly: true }, ...avoid].slice(0, 90);
      continue;
    }

    const reservation = await reservePlannerFn(env, { blogId: selection.blogId, topic });
    if (!reservation?.ok || !reservation?.candidateId) {
      avoid = [{ title: topic, strategyOnly: true }, ...avoid].slice(0, 90);
      continue;
    }
    return { topic, reservation };
  }

  const error = new Error('AUTO_WORK_UNIQUE_TOPIC_UNAVAILABLE');
  error.data = lastConflict;
  throw error;
}

export async function runAutomaticWork(env, blogs, automation, options = {}) {
  if (env?.DAILY_WORK_EXECUTION_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'DAILY_WORK_EXECUTION_DISABLED', attempted: 0, completed: 0, items: [] };
  }
  const planDate = String(options.planDate || '').trim();
  if (!planDate) throw new Error('DAILY_WORK_PLAN_DATE_REQUIRED');
  const maxItems = positiveLimit(options.maxItems ?? env?.DAILY_WORK_MAX_ITEMS, 1);
  const callHubFn = options.callHubFn || callHub;
  const now = options.now || new Date();
  const preview = await previewAutomaticWork(env, blogs, automation, { ...options, now, planDate, maxItems, callHubFn });
  const settingMap = settingsByBlog(automation);
  const blogMap = blogsById(blogs);
  const items = [];

  for (const selection of preview.selections) {
    if (items.length >= maxItems) break;

    if (selection.action === 'selection_failed') {
      const failure = await registerSelectionFailure(env, selection, selection.errorCode, now, options);
      items.push({ ...selection, status: 'failed', ...failure });
      continue;
    }

    if (selection.action === 'no_candidate') {
      const skipped = await markNoRepairCandidateSkipped(env, selection.slotId);
      items.push({ ...selection, status: 'skipped', reason: 'NO_ELIGIBLE_REPAIR_POST', cleanSkip: skipped });
      continue;
    }

    const configured = settingMap.get(selection.blogId) || null;
    const effective = configured?.effective || automation?.global || {};
    const blog = blogMap.get(selection.blogId) || {};
    let materialized = null;
    let reservedTopic = null;
    let topicSource = null;

    try {
      if (selection.kind === 'new_article') {
        reservedTopic = await advisory(
          () => (options.reserveTopicCandidateFn || reserveBestNewTopicCandidate)(env, selection.blogId),
          null
        );

        if (reservedTopic?.query) {
          const conflict = await (options.findTopicConflictFn || findNewArticleTopicConflict)(env, {
            blogId: selection.blogId,
            topic: String(reservedTopic.query),
            excludeCandidateId: Number(reservedTopic.id),
            threshold: 0.74
          });
          if (conflict) {
            await advisory(
              () => (options.rejectDuplicateTopicCandidateFn || rejectDuplicateTopicCandidate)(env, Number(reservedTopic.id)),
              false
            );
            reservedTopic = null;
          }
        }

        if (reservedTopic?.query) {
          topicSource = String(reservedTopic.source || 'idea');
          materialized = await (options.materializeFn || materializeDailySlot)(env, selection.slotId, {
            topic: String(reservedTopic.query),
            language: selection.language,
            topicCandidateId: Number(reservedTopic.id),
            topicSource
          });
          await advisory(() => (options.markTopicCandidateUsedFn || markTopicCandidateUsed)(env, Number(reservedTopic.id), materialized.jobId), false);
        } else {
          const posts = await inventory(env, selection.blogId, 40, callHubFn);
          const avoidTopics = await advisory(
            () => (options.listStrategyAvoidTopicsFn || listStrategyAvoidTopics)(env, selection.blogId, 30),
            []
          );
          const recentPosts = [...posts.slice(-40).reverse(), ...strategyRecentPosts(avoidTopics)].slice(0, 70);
          const planned = await planUniqueTopic(env, selection, blog, recentPosts, callHubFn, options);
          topicSource = 'planner';
          reservedTopic = { id: planned.reservation.candidateId, query: planned.topic, source: 'planner' };
          materialized = await (options.materializeFn || materializeDailySlot)(env, selection.slotId, {
            topic: planned.topic,
            language: selection.language,
            topicCandidateId: Number(planned.reservation.candidateId),
            topicSource
          });
          await advisory(
            () => (options.markTopicCandidateUsedFn || markTopicCandidateUsed)(env, Number(planned.reservation.candidateId), materialized.jobId),
            false
          );
        }
      } else {
        materialized = await (options.materializeFn || materializeDailySlot)(env, selection.slotId, {
          bloggerPostId: selection.candidate.bloggerPostId,
          targetUrl: selection.candidate.targetUrl
        });
      }

      const outcome = await runStoredJob(env, materialized.jobId, options);
      let images = null;
      if (selection.kind === 'new_article' && outcome.state === 'ready') {
        images = effective?.imagesEnabled === false
          ? { enabled: false, reason: 'IMAGES_DISABLED' }
          : { enabled: true, deferred: true, reason: 'SCHEDULED_IMAGE_COMPLETION' };
      }
      items.push({ ...selection, status: 'completed', jobId: materialized.jobId, jobState: outcome.state, images, topicSource });
    } catch (error) {
      if (reservedTopic?.id && !materialized?.jobId) {
        await advisory(() => (options.releaseTopicCandidateFn || releaseTopicCandidate)(env, Number(reservedTopic.id)), false);
      }
      const failure = materialized?.jobId
        ? await registerMaterializedFailure(env, selection, materialized, error, now, options)
        : await registerSelectionFailure(env, selection, error, now, options);
      items.push({ ...selection, status: 'failed', jobId: materialized?.jobId || null, ...failure, topicSource });
    }
  }

  return {
    ok: items.every((item) => item.status !== 'failed' || item.recovery?.recoveryState),
    enabled: true,
    attempted: items.length,
    completed: items.filter((item) => item.status === 'completed').length,
    failed: items.filter((item) => item.status === 'failed').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    items
  };
}
