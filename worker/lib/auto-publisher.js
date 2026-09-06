import { callHub } from './api-hub.js';
import { validateCriticResult } from './contracts.js';
import { lintNaturalWriting } from './natural-writing-linter.js';
import { dateInTimeZone } from './daily-plan.js';
import { deterministicPublishJitter, readAutomationSettings, scheduledMinuteForPublish } from './automation-settings.js';
import { persistJobResult, persistJobTransition } from './job-store.js';
import { applyInternalLinksToArticle } from './internal-link-injector.js';
import { findNewArticleTopicConflict } from './topic-dedupe.js';
import { runDeterministicQualityGate, deterministicQaAllowsPublish } from './deterministic-quality-gate.js';
import { deliveryEvidenceComplete, validateBloggerReadback } from './delivery-evidence.js';
import { buildSchemaAwareDelivery } from './schema-delivery.js';

const MAX_PUBLICATION_ATTEMPTS = 3;
const MIN_SCHEDULE_LEAD_MINUTES = 10;
const CARRYOVER_LOOKBACK_DAYS = 2;
const STALE_PUBLICATION_CLAIM_MINUTES = 15;

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function timeInTimeZone(date, timeZone = 'Asia/Seoul') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return { hour, minute, totalMinutes: hour * 60 + minute };
}

function hhmm(totalMinutes) {
  const normalized = ((Number(totalMinutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function kstTimestamp(planDate, totalMinutes) {
  const dayOffset = Math.floor(Number(totalMinutes) / 1440);
  const base = new Date(`${planDate}T00:00:00+09:00`);
  base.setUTCDate(base.getUTCDate() + dayOffset);
  const date = base.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  return `${date}T${hhmm(totalMinutes)}:00+09:00`;
}

function addMinutes(timestamp, minutes) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error('PUBLICATION_SCHEDULE_TIMESTAMP_INVALID');
  return new Date(date.getTime() + Number(minutes) * 60000).toISOString();
}

export function scheduledMinuteForSlot(settings, slotNo, planDate = '1970-01-01', blogId = 'preview') {
  return scheduledMinuteForPublish(settings, planDate, blogId, slotNo);
}

export function isPublicationDue(settings, slotNo) {
  if (!settings?.enabled || !settings?.autoPublishEnabled || settings?.approvalMode !== 'auto') return false;
  return Number(slotNo) <= Number(settings.maxPublishesPerDay || 0);
}

function imageEvidence(settings, images = []) {
  if (!settings?.imagesEnabled) {
    return { passed: true, required: false, expected: 0, attached: 0, thumbnailReady: true };
  }
  const expected = 1 + Number(settings.bodyImageCount || 0);
  const attachedRows = images.filter((image) => String(image.status) === 'attached');
  const thumbnailReady = attachedRows.some((image) => image.role === 'thumbnail');
  return {
    passed: thumbnailReady && attachedRows.length >= expected,
    required: true,
    expected,
    attached: attachedRows.length,
    thumbnailReady
  };
}

export function validatePublicationResult(result, settings, images = []) {
  if (!result || result.status !== 'READY') return { ok: false, reason: 'JOB_RESULT_NOT_READY' };
  if (!result.article || typeof result.article !== 'object') return { ok: false, reason: 'ARTICLE_MISSING' };
  const critic = result.finalCritic;
  if (!critic || critic.status !== 'PASS' || Number(critic.score) < 95 || (critic.issues || []).length !== 0) {
    return { ok: false, reason: 'FINAL_CRITIC_NOT_CLEAN' };
  }
  const lint = lintNaturalWriting(result.article);
  if (lint.status === 'BLOCK') return { ok: false, reason: 'NATURAL_WRITING_BLOCKED' };
  const deterministicQa = runDeterministicQualityGate(result.article);
  if (!deterministicQaAllowsPublish(deterministicQa)) {
    return { ok: false, reason: 'DETERMINISTIC_QA_BLOCKED', deterministicQa, lint };
  }

  const imagesEvidence = imageEvidence(settings, images);
  if (settings?.imagesEnabled && !imagesEvidence.thumbnailReady) {
    return { ok: false, reason: 'THUMBNAIL_NOT_ATTACHED', deterministicQa, lint, imagesEvidence };
  }
  if (settings?.imagesEnabled && !imagesEvidence.passed) {
    return { ok: false, reason: 'IMAGES_NOT_ATTACHED', deterministicQa, lint, imagesEvidence };
  }
  return { ok: true, lint, deterministicQa, imagesEvidence };
}

async function listCandidates(env, planDate) {
  const result = await requireDb(env).prepare(
    `SELECT s.plan_date, s.blog_id, s.slot_no, s.job_id, j.status AS job_status, j.topic AS job_topic, j.result_json
     FROM daily_plan_slots s
     JOIN jobs j ON j.id = s.job_id
     WHERE s.plan_date BETWEEN date(?, ?) AND ?
       AND s.kind = 'new_article'
       AND s.status = 'resolved'
       AND j.mode = 'new_article'
       AND j.status = 'ready'
     ORDER BY s.plan_date, s.slot_no, s.blog_id, s.job_id`
  ).bind(planDate, `-${CARRYOVER_LOOKBACK_DAYS} days`, planDate).all();
  return result.results || [];
}

async function listImages(env, jobId) {
  const result = await requireDb(env).prepare(
    `SELECT id, role, position, status, public_url
     FROM job_images WHERE job_id = ? ORDER BY position, id`
  ).bind(Number(jobId)).all();
  return result.results || [];
}

async function previousScheduledPublication(env, candidate) {
  if (Number(candidate.slot_no) <= 1) return null;
  return requireDb(env).prepare(
    `SELECT scheduled_time, slot_no
     FROM job_publications
     WHERE plan_date = ? AND blog_id = ? AND status IN ('scheduled', 'published') AND slot_no < ?
     ORDER BY slot_no DESC LIMIT 1`
  ).bind(String(candidate.plan_date), String(candidate.blog_id), Number(candidate.slot_no)).first();
}

async function resolveScheduledAt(env, candidate, settings, now) {
  const plannedMinute = scheduledMinuteForPublish(settings, candidate.plan_date, candidate.blog_id, candidate.slot_no);
  let scheduledAt = kstTimestamp(candidate.plan_date, plannedMinute);
  const previous = await previousScheduledPublication(env, candidate);
  if (previous?.scheduled_time) {
    const gap = Number(settings.publishIntervalMinutes || 30)
      + deterministicPublishJitter(candidate.plan_date, candidate.blog_id, `gap:${candidate.slot_no}`, settings.publishJitterMinutes || 0);
    scheduledAt = addMinutes(previous.scheduled_time, gap);
  }
  const minimum = new Date(now.getTime() + MIN_SCHEDULE_LEAD_MINUTES * 60000);
  const scheduledDate = new Date(scheduledAt);
  if (!Number.isFinite(scheduledDate.getTime()) || scheduledDate <= minimum) {
    scheduledAt = minimum.toISOString();
  }
  return scheduledAt;
}

async function holdStalePublicationClaims(env, now) {
  const cutoff = new Date(now.getTime() - STALE_PUBLICATION_CLAIM_MINUTES * 60000).toISOString();
  const result = await requireDb(env).prepare(
    `UPDATE job_publications
     SET status = 'failed', attempts = ?, error = 'STALE_PUBLICATION_CLAIM_HELD', updated_at = datetime('now')
     WHERE status = 'claimed' AND updated_at <= ?
       AND job_id IN (SELECT id FROM jobs WHERE mode = 'new_article')`
  ).bind(MAX_PUBLICATION_ATTEMPTS, cutoff).run();
  return Number(result?.meta?.changes || 0);
}

async function claimPublication(env, candidate, scheduledTime) {
  const db = requireDb(env);
  const existing = await db.prepare(
    `SELECT status, attempts FROM job_publications WHERE job_id = ? LIMIT 1`
  ).bind(Number(candidate.job_id)).first();
  if (['scheduled', 'published', 'claimed', 'verification_pending'].includes(String(existing?.status || ''))) return false;
  if (existing?.status === 'failed') {
    if (Number(existing.attempts || 0) >= MAX_PUBLICATION_ATTEMPTS) return false;
    const retry = await db.prepare(
      `UPDATE job_publications
       SET status = 'claimed', attempts = attempts + 1, scheduled_time = ?, error = NULL, updated_at = datetime('now')
       WHERE job_id = ? AND status = 'failed' AND blogger_post_id IS NULL AND attempts < ?`
    ).bind(String(scheduledTime), Number(candidate.job_id), MAX_PUBLICATION_ATTEMPTS).run();
    return Number(retry?.meta?.changes ?? 0) === 1;
  }
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO job_publications
      (job_id, blog_id, plan_date, slot_no, scheduled_time, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'claimed', 1, datetime('now'), datetime('now'))`
  ).bind(
    Number(candidate.job_id),
    String(candidate.blog_id),
    String(candidate.plan_date),
    Number(candidate.slot_no),
    String(scheduledTime)
  ).run();
  return Number(inserted?.meta?.changes ?? 0) === 1;
}

async function markScheduled(env, jobId, published, scheduledAt, readback) {
  const verifiedUrl = readback?.identity?.permalink || published?.url || null;
  await requireDb(env).prepare(
    `UPDATE job_publications
     SET status = 'scheduled', scheduled_time = ?, blogger_post_id = ?, url = ?, error = NULL, updated_at = datetime('now')
     WHERE job_id = ? AND status IN ('claimed', 'verification_pending')`
  ).bind(String(scheduledAt), String(published?.bloggerPostId || ''), verifiedUrl, Number(jobId)).run();
}

async function markVerificationPending(env, jobId, published, scheduledAt) {
  await requireDb(env).prepare(
    `UPDATE job_publications
     SET status = 'verification_pending', scheduled_time = ?, blogger_post_id = ?, url = ?, error = 'BLOGGER_READBACK_PENDING', updated_at = datetime('now')
     WHERE job_id = ? AND status = 'claimed'`
  ).bind(String(scheduledAt), String(published?.bloggerPostId || ''), published?.url || null, Number(jobId)).run();
}

async function markFailed(env, jobId, error) {
  await requireDb(env).prepare(
    `UPDATE job_publications
     SET status = 'failed', error = ?, updated_at = datetime('now')
     WHERE job_id = ? AND status = 'claimed'`
  ).bind(String(error || 'AUTO_PUBLISH_FAILED').slice(0, 300), Number(jobId)).run();
}

async function markAmbiguousWriteHeld(env, jobId) {
  await requireDb(env).prepare(
    `UPDATE job_publications
     SET status = 'failed', attempts = ?, error = 'BLOGGER_WRITE_OUTCOME_UNKNOWN', updated_at = datetime('now')
     WHERE job_id = ? AND status = 'claimed'`
  ).bind(MAX_PUBLICATION_ATTEMPTS, Number(jobId)).run();
}

function isAmbiguousWriteError(error) {
  const code = String(error?.code || error?.message || '').toUpperCase();
  const status = Number(error?.status || 0);
  return code.includes('API_HUB_TIMEOUT') || code.includes('NETWORK') || status >= 500 || /^API_HUB_5/.test(code);
}

function safeResult(value) {
  try { return JSON.parse(String(value || '')); } catch { return null; }
}

async function prepareInternalLinks(env, candidate, result, fetchImpl) {
  const links = result?.strategy?.internalLinks || [];
  if (!Array.isArray(links) || links.length === 0) return result;
  const injected = applyInternalLinksToArticle(result.article, links);
  if (injected.appliedCount === 0) return result;

  const critic = validateCriticResult(await callHub(
    env,
    env.HUB_CRITIC_PATH || '/api/hub/ai/critic',
    { article: injected.article, stage: 'post_internal_links', ...(result?.seoBrief ? { seoBrief: result.seoBrief } : {}) },
    fetchImpl
  ));
  if (critic.status !== 'PASS' || Number(critic.score) < 95 || (critic.issues || []).length !== 0) {
    throw Object.assign(new Error('INTERNAL_LINK_FINAL_CRITIC_BLOCKED'), { status: 409 });
  }
  const lint = lintNaturalWriting(injected.article);
  if (lint.status === 'BLOCK') throw Object.assign(new Error('INTERNAL_LINK_NATURAL_WRITING_BLOCKED'), { status: 409 });

  const nextResult = {
    ...result,
    article: injected.article,
    finalCritic: critic,
    strategy: {
      ...(result.strategy || {}),
      internalLinksApplied: injected.appliedCount,
      internalLinksAppliedAt: new Date().toISOString()
    }
  };
  await persistJobResult(env, candidate.job_id, nextResult);
  return nextResult;
}

function resultWithQualityAndEvidence(result, eligibility, publication, readback = null) {
  const schemaDelivery = buildSchemaAwareDelivery({
    mode: 'new_article',
    result,
    deterministicQa: eligibility.deterministicQa,
    naturalWritingStatus: eligibility.lint?.status,
    images: eligibility.imagesEvidence,
    imagesRequired: Boolean(eligibility.imagesEvidence?.required),
    publication,
    readback
  });
  return {
    ...result,
    qualityGates: {
      ...(result?.qualityGates || {}),
      deterministic: eligibility.deterministicQa,
      naturalWriting: eligibility.lint,
      images: eligibility.imagesEvidence,
      schema: schemaDelivery.schema
    },
    publication,
    structuredData: schemaDelivery.structuredData,
    deliveryEvidence: schemaDelivery.deliveryEvidence
  };
}

export async function runDueAutoPublications(env, blogs, options = {}) {
  if (env?.AUTO_PUBLISH_EXECUTION_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'AUTO_PUBLISH_EXECUTION_DISABLED', attempted: 0, published: 0, scheduled: 0 };
  }
  if (env?.BLOGGER_WRITES_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'BLOGGER_WRITES_DISABLED', attempted: 0, published: 0, scheduled: 0 };
  }

  const now = options.now || new Date();
  const timeZone = env.OPERATIONS_TIMEZONE || 'Asia/Seoul';
  timeInTimeZone(now, timeZone);
  const planDate = dateInTimeZone(now, timeZone);
  const automation = options.automation || await readAutomationSettings(env, blogs);
  const settingsByBlog = new Map((automation.blogs || []).map((item) => [String(item.blogId), item.effective]));
  const staleClaimsHeld = await holdStalePublicationClaims(env, now);
  const candidates = await listCandidates(env, planDate);
  const outcomes = [];
  const fetchImpl = options.fetchImpl || fetch;
  const findConflictFn = options.findTopicConflictFn || findNewArticleTopicConflict;
  const callHubFn = options.callHubFn || callHub;
  const readbackFn = options.readbackFn || ((runtimeEnv, input) => callHubFn(
    runtimeEnv,
    runtimeEnv.HUB_BLOGGER_GET_PATH || '/api/blogger/post/get',
    input
  ));

  for (const candidate of candidates) {
    const settings = settingsByBlog.get(String(candidate.blog_id));
    if (!settings || !isPublicationDue(settings, candidate.slot_no)) continue;
    let result = safeResult(candidate.result_json);

    const duplicate = await findConflictFn(env, {
      blogId: String(candidate.blog_id),
      topic: String(candidate.job_topic || ''),
      title: String(result?.article?.title || ''),
      excludeJobId: Number(candidate.job_id),
      maxJobId: Number(candidate.job_id),
      publishedCandidatesOnly: true,
      threshold: 0.74
    });
    if (duplicate) {
      await persistJobTransition(env, candidate.job_id, 'needs_review', { error: 'DUPLICATE_TOPIC_PUBLICATION_BLOCKED' });
      outcomes.push({
        jobId: Number(candidate.job_id),
        planDate: String(candidate.plan_date),
        status: 'blocked',
        reason: 'DUPLICATE_TOPIC_PUBLICATION_BLOCKED',
        duplicate
      });
      continue;
    }

    try {
      result = await prepareInternalLinks(env, candidate, result, fetchImpl);
    } catch (error) {
      outcomes.push({ jobId: Number(candidate.job_id), planDate: String(candidate.plan_date), status: 'blocked', reason: String(error?.message || 'INTERNAL_LINK_PREPARE_FAILED') });
      continue;
    }
    const images = settings.imagesEnabled ? await listImages(env, candidate.job_id) : [];
    const eligibility = validatePublicationResult(result, settings, images);
    if (!eligibility.ok) {
      outcomes.push({ jobId: Number(candidate.job_id), planDate: String(candidate.plan_date), status: 'blocked', reason: eligibility.reason });
      continue;
    }
    const scheduledAt = await resolveScheduledAt(env, candidate, settings, now);
    if (!await claimPublication(env, candidate, scheduledAt)) continue;

    try {
      await persistJobTransition(env, candidate.job_id, 'publishing_new');
      const published = await callHubFn(
        env,
        env.HUB_BLOGGER_POST_PATH || '/api/blogger/post',
        {
          operation: 'create',
          publishMode: 'scheduled',
          publishDate: scheduledAt,
          blogId: String(candidate.blog_id),
          article: result.article
        }
      );
      if (!published?.ok || !published?.bloggerPostId) throw new Error('BLOGGER_SCHEDULE_RESULT_INVALID');
      const publication = { mode: 'scheduled', scheduledAt, ...published };

      let readback = null;
      let readbackError = null;
      try {
        readback = await readbackFn(env, {
          blogId: String(candidate.blog_id),
          bloggerPostId: String(published.bloggerPostId)
        });
      } catch (error) {
        readbackError = error;
      }
      const readbackCheck = readback
        ? validateBloggerReadback({ blogId: String(candidate.blog_id), bloggerPostId: String(published.bloggerPostId) }, readback)
        : { passed: false };

      if (!readbackCheck.passed) {
        await markVerificationPending(env, candidate.job_id, published, scheduledAt);
        const pendingResult = resultWithQualityAndEvidence(result, eligibility, publication, readback);
        await persistJobResult(env, candidate.job_id, {
          ...pendingResult,
          publicationVerification: {
            status: 'PENDING',
            reason: String(readbackError?.message || 'BLOGGER_READBACK_UNCONFIRMED').slice(0, 180),
            checkedAt: new Date().toISOString()
          }
        });
        outcomes.push({
          jobId: Number(candidate.job_id),
          planDate: String(candidate.plan_date),
          status: 'verification_pending',
          bloggerPostId: String(published.bloggerPostId),
          url: published.url || null,
          scheduledAt
        });
        continue;
      }

      const completedResult = resultWithQualityAndEvidence(result, eligibility, publication, readback);
      if (!deliveryEvidenceComplete(completedResult.deliveryEvidence)) {
        await persistJobResult(env, candidate.job_id, completedResult);
        throw new Error('DELIVERY_EVIDENCE_INCOMPLETE');
      }
      await markScheduled(env, candidate.job_id, published, scheduledAt, readback);
      await persistJobTransition(env, candidate.job_id, 'completed', { result: completedResult });
      outcomes.push({
        jobId: Number(candidate.job_id),
        planDate: String(candidate.plan_date),
        status: 'scheduled',
        bloggerPostId: String(published.bloggerPostId),
        url: readback?.identity?.permalink || published.url || null,
        scheduledAt,
        evidence: completedResult.deliveryEvidence
      });
    } catch (error) {
      if (isAmbiguousWriteError(error)) {
        await markAmbiguousWriteHeld(env, candidate.job_id);
        try { await persistJobTransition(env, candidate.job_id, 'failed', { error: 'BLOGGER_WRITE_OUTCOME_UNKNOWN' }); } catch { /* preserve primary failure */ }
        outcomes.push({ jobId: Number(candidate.job_id), planDate: String(candidate.plan_date), status: 'held', reason: 'BLOGGER_WRITE_OUTCOME_UNKNOWN' });
      } else {
        await markFailed(env, candidate.job_id, error?.message || 'AUTO_PUBLISH_FAILED');
        try { await persistJobTransition(env, candidate.job_id, 'failed', { error: error?.message || 'AUTO_PUBLISH_FAILED' }); } catch { /* preserve primary failure */ }
        outcomes.push({ jobId: Number(candidate.job_id), planDate: String(candidate.plan_date), status: 'failed', reason: String(error?.message || 'AUTO_PUBLISH_FAILED') });
      }
    }
  }

  return {
    ok: outcomes.every((item) => !['failed', 'held'].includes(item.status)),
    enabled: true,
    planDate,
    staleClaimsHeld,
    attempted: outcomes.filter((item) => ['scheduled', 'verification_pending', 'failed', 'held'].includes(item.status)).length,
    published: 0,
    scheduled: outcomes.filter((item) => item.status === 'scheduled').length,
    verificationPending: outcomes.filter((item) => item.status === 'verification_pending').length,
    blocked: outcomes.filter((item) => item.status === 'blocked').length,
    held: outcomes.filter((item) => item.status === 'held').length,
    outcomes
  };
}
