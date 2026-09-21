import { callHub } from './api-hub.js';
import { validateCriticResult } from './contracts.js';
import { lintNaturalWriting } from './natural-writing-linter.js';
import { dateInTimeZone } from './daily-plan.js';
import { deterministicPublishJitter, readAutomationSettings, scheduledMinuteForPublish } from './automation-settings.js';
import { persistJobResult, persistJobTransition } from './job-store.js';
import { appendJobEvent } from './job-events.js';
import { applyInternalLinksToArticle } from './internal-link-injector.js';
import { findNewArticleTopicConflict } from './topic-dedupe.js';
import { runDeterministicQualityGate, deterministicQaAllowsPublish } from './deterministic-quality-gate.js';
import { deliveryEvidenceComplete, validateBloggerReadback } from './delivery-evidence.js';
import { buildSchemaAwareDelivery } from './schema-delivery.js';

const MAX_PUBLICATION_ATTEMPTS = 3;
const MIN_SCHEDULE_LEAD_MINUTES = 10;
// A 2-day window silently dropped any ready new_article job that didn't get published within
// 2 days of its own daily-plan slot: listCandidates() simply stops returning it, with zero
// error or event, so it sits in 'ready' forever with no publication row at all (confirmed on
// production jobs #137-#157, ready for 8-9 days from plan dates 2026-09-11/12, still with zero
// job_publications rows). 14 days gives real backlog (e.g. a temporary publish-capacity crunch)
// room to clear before a job is permanently excluded, while still bounding how old a
// "carried over" article can be before it's dropped from consideration.
const CARRYOVER_LOOKBACK_DAYS = 14;
const STALE_PUBLICATION_CLAIM_MINUTES = 15;
// Blogger answers 429 when several posts are written in the same minute, which is exactly what
// a shared plan minute across blogs produces (six of the eight jobs freed on 2026-09-20 were
// all scheduled for 20:30:11 and three of them were rejected). A 429 says "not now", not "never",
// so it must not burn one of the three publication attempts, and the retry has to wait out the
// window instead of re-hitting Blogger on the next five-minute tick.
const PUBLISH_RATE_LIMIT_COOLDOWN_MINUTES = 30;

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

// One-time, fixed allowlist: new_article jobs whose image plan was fully executed under an
// earlier, lower bodyImageCount and which now fall short of imageEvidence()'s raised
// expectation of 1 + bodyImageCount. Confirmed on 2026-09-20 that all eight are
// result.status READY, finalCritic PASS at score 100 with zero issues, and hold exactly 3
// attached images (thumbnail + 2 body) with no failed or missing row -- nothing is wrong with
// them except that the policy moved after they were built. Generating a 4th image would be a
// new paid KIE call for an article that already satisfies the plan it was written under, which
// the no-duplicate-generation rule forbids. This mirrors REPAIR_IMAGE_COUNT_EXCEPTION_JOB_IDS
// in auto-repair-updater.js for the repair path. It exempts only these exact ids, only while
// they still hold their thumbnail plus at least three attached images, and must never be
// widened into a general relaxation of the image requirement.
const PUBLISH_IMAGE_COUNT_EXCEPTION_JOB_IDS = new Set([137, 139, 149, 151, 153, 154, 156, 157]);
const PUBLISH_IMAGE_COUNT_EXCEPTION_MIN_IMAGES = 3;

// runDueAutoPublications collects a per-candidate outcome and returns it, but nothing persists
// it: a job blocked by validatePublicationResult stays 'ready' with error and hold_reason both
// NULL, so it is indistinguishable from a job that is simply waiting its turn. That is how
// jobs #137-#157 sat blocked for nine days on an image-count policy change with nothing on
// screen to show it (confirmed 2026-09-20). Record the reason as a job event rather than a
// status change: this block is routinely transient (a freshly-ready job whose images are still
// generating fails it for a few minutes), so moving the job out of 'ready' would derail
// articles that were about to publish normally. Deduped on (job, reason) so a block that
// persists for days logs once instead of once per five-minute tick, and never allowed to throw
// -- logging must not be able to stop a publish.
async function recordPublishBlock(env, jobId, reason) {
  const message = `발행 보류 · ${reason}`;
  try {
    const existing = await requireDb(env).prepare(
      `SELECT 1 FROM job_events
       WHERE job_id = ? AND event_type = 'publish_blocked' AND message = ?
       LIMIT 1`
    ).bind(Number(jobId), message).first();
    if (existing) return false;
  } catch {
    // A missing job_events table (or any read failure) must not suppress the attempt below;
    // appendJobEvent already no-ops safely when the table does not exist.
  }
  try {
    return await appendJobEvent(env, jobId, {
      eventType: 'publish_blocked',
      stage: 'ready',
      level: 'warn',
      message,
      meta: { reason }
    });
  } catch {
    return false;
  }
}

export function validatePublicationResult(result, settings, images = [], jobId = null) {
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
    const exempt = jobId !== null
      && PUBLISH_IMAGE_COUNT_EXCEPTION_JOB_IDS.has(Number(jobId))
      && Number(imagesEvidence.attached || 0) >= PUBLISH_IMAGE_COUNT_EXCEPTION_MIN_IMAGES;
    if (!exempt) {
      return { ok: false, reason: 'IMAGES_NOT_ATTACHED', deterministicQa, lint, imagesEvidence };
    }
    return {
      ok: true,
      lint,
      deterministicQa,
      imageCountException: true,
      imagesEvidence: { ...imagesEvidence, passed: true, exception: 'PUBLISH_IMAGE_COUNT_EXCEPTION' }
    };
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
  const db = requireDb(env);
  const cutoff = new Date(now.getTime() - STALE_PUBLICATION_CLAIM_MINUTES * 60000).toISOString();
  const result = await db.prepare(
    `UPDATE job_publications
     SET status = 'failed', attempts = ?, error = 'STALE_PUBLICATION_CLAIM_HELD', updated_at = datetime('now')
     WHERE status = 'claimed' AND updated_at <= ?
       AND job_id IN (SELECT id FROM jobs WHERE mode = 'new_article')`
  ).bind(MAX_PUBLICATION_ATTEMPTS, cutoff).run();

  // Repairing the publication row was not enough. The publish loop sets the job to
  // publishing_new before calling Blogger, so a worker that dies mid-write never runs its
  // own catch: the row goes stale here, attempts is pushed to the maximum so claimPublication()
  // will never re-claim it, and the job is left in publishing_new with recovery_state 'none'.
  // Nothing owns that combination -- publication-ambiguity-recovery.js exists for exactly this
  // error but only lists jobs in failed/needs_review, so the orphan is invisible to its own
  // rescue. Jobs 164 and 176 sat there from 2026-09-19 until this was found on 2026-09-21.
  //
  // Demoting the job to failed hands it to that recovery, which searches Blogger for the
  // article's exact title before doing anything: it adopts a post that did go live and only
  // re-publishes when none exists, so this cannot duplicate a post. STALE_PUBLICATION_CLAIM is
  // in job-auto-rescue's NEVER_AUTO_RETRY_CODES, so no other path will retry it blindly either.
  // A live publish is never caught here: an in-flight attempt holds a 'claimed' row, not a
  // stale-held one.
  const demoted = await db.prepare(
    `UPDATE jobs
        SET status = 'failed', error = 'STALE_PUBLICATION_CLAIM_HELD',
            last_error_code = 'STALE_PUBLICATION_CLAIM_HELD', recovery_state = 'held',
            hold_reason = 'STALE_PUBLICATION_CLAIM_HELD', next_retry_at = NULL,
            last_failure_at = datetime('now'), updated_at = datetime('now')
      WHERE status = 'publishing_new'
        AND archived_at IS NULL
        AND id IN (
          SELECT job_id FROM job_publications
           WHERE status = 'failed'
             AND error = 'STALE_PUBLICATION_CLAIM_HELD'
             AND (blogger_post_id IS NULL OR blogger_post_id = '')
        )`
  ).run();
  return { claims: Number(result?.meta?.changes || 0), orphans: Number(demoted?.meta?.changes || 0) };
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
       WHERE job_id = ? AND status = 'failed' AND blogger_post_id IS NULL AND attempts < ?
         AND (error IS NULL OR error NOT LIKE '%429%'
              OR updated_at <= datetime('now', '-${PUBLISH_RATE_LIMIT_COOLDOWN_MINUTES} minutes'))`
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

// A rate limit refunds the attempt this claim consumed, so a busy hour cannot exhaust the
// three-attempt budget a real publishing failure is meant to spend. The 429 stays in `error`
// because claimPublication() reads it back to enforce the cooldown above.
async function markRateLimited(env, jobId, error) {
  await requireDb(env).prepare(
    `UPDATE job_publications
     SET status = 'failed', attempts = MAX(attempts - 1, 0), error = ?, updated_at = datetime('now')
     WHERE job_id = ? AND status = 'claimed'`
  ).bind(String(error || 'BLOGGER_API_429').slice(0, 300), Number(jobId)).run();
}

export function isPublishRateLimitError(error) {
  const code = String(error?.code || error?.message || '').toUpperCase();
  if (Number(error?.status || 0) === 429) return true;
  // Not \b429\b: the real code is API_HUB_429:BLOGGER_API_429, and an underscore is a word
  // character, so a word boundary never matches before the 4. Digit lookaround is what keeps
  // this off a longer number such as API_HUB_4290.
  return /(?<!\d)429(?!\d)/.test(code) || code.includes('RATE_LIMIT') || code.includes('TOO_MANY_REQUESTS');
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
  const stale = await holdStalePublicationClaims(env, now);
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
      const reason = String(error?.message || 'INTERNAL_LINK_PREPARE_FAILED');
      await recordPublishBlock(env, candidate.job_id, reason);
      outcomes.push({ jobId: Number(candidate.job_id), planDate: String(candidate.plan_date), status: 'blocked', reason });
      continue;
    }
    const images = settings.imagesEnabled ? await listImages(env, candidate.job_id) : [];
    const eligibility = validatePublicationResult(result, settings, images, candidate.job_id);
    if (!eligibility.ok) {
      await recordPublishBlock(env, candidate.job_id, eligibility.reason);
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
      if (isPublishRateLimitError(error)) {
        await markRateLimited(env, candidate.job_id, error?.message || 'BLOGGER_API_429');
        try { await persistJobTransition(env, candidate.job_id, 'failed', { error: error?.message || 'BLOGGER_API_429' }); } catch { /* preserve primary failure */ }
        outcomes.push({ jobId: Number(candidate.job_id), planDate: String(candidate.plan_date), status: 'rate_limited', reason: String(error?.message || 'BLOGGER_API_429') });
      } else if (isAmbiguousWriteError(error)) {
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
    ok: outcomes.every((item) => !['failed', 'held', 'rate_limited'].includes(item.status)),
    enabled: true,
    planDate,
    staleClaimsHeld: stale.claims,
    orphanedPublishJobsDemoted: stale.orphans,
    attempted: outcomes.filter((item) => ['scheduled', 'verification_pending', 'failed', 'held', 'rate_limited'].includes(item.status)).length,
    published: 0,
    scheduled: outcomes.filter((item) => item.status === 'scheduled').length,
    verificationPending: outcomes.filter((item) => item.status === 'verification_pending').length,
    blocked: outcomes.filter((item) => item.status === 'blocked').length,
    held: outcomes.filter((item) => item.status === 'held').length,
    outcomes
  };
}
