import { callHub } from './api-hub.js';
import { lintNaturalWriting } from './natural-writing-linter.js';
import { dateInTimeZone } from './daily-plan.js';
import { deterministicPublishJitter, readAutomationSettings, scheduledMinuteForPublish } from './automation-settings.js';
import { persistJobResult, persistJobTransition } from './job-store.js';
import { assertExistingIdentity } from './publisher.js';
import { validateImagePolicy } from './image-policy.js';
import { runDeterministicQualityGate, deterministicQaAllowsPublish } from './deterministic-quality-gate.js';
import { deliveryEvidenceComplete, validateBloggerReadback } from './delivery-evidence.js';
import { buildSchemaAwareDelivery } from './schema-delivery.js';

const MIN_SCHEDULE_LEAD_MINUTES = 10;
const REPAIR_CARRYOVER_LOOKBACK_DAYS = 2;
const STALE_UPDATE_CLAIM_MINUTES = 15;
const MAX_UPDATE_CLAIM_RECOVERIES = 3;

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
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
  if (!Number.isFinite(date.getTime())) throw new Error('REPAIR_SCHEDULE_TIMESTAMP_INVALID');
  return new Date(date.getTime() + Number(minutes) * 60000).toISOString();
}

function safeResult(value) {
  try { return JSON.parse(String(value || '')); } catch { return null; }
}

function validateRepairResult(result, settings = {}) {
  if (!result || result.status !== 'READY_TO_UPDATE_EXISTING') return { ok: false, reason: 'REPAIR_RESULT_NOT_READY' };
  if (!result.article || typeof result.article !== 'object') return { ok: false, reason: 'REPAIR_ARTICLE_MISSING' };
  if (!result.identity?.blogId || !result.identity?.bloggerPostId) return { ok: false, reason: 'REPAIR_IDENTITY_MISSING' };
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
  const imagePolicy = validateImagePolicy('repair_existing', result.article, settings);
  if (!imagePolicy.ok) {
    return {
      ok: false,
      reason: 'REPAIR_IMAGES_INCOMPLETE',
      missingImages: imagePolicy.missing,
      currentImages: imagePolicy.currentCount,
      targetImages: imagePolicy.policy?.targetTotal || 0,
      deterministicQa,
      lint
    };
  }
  return {
    ok: true,
    imagePolicy,
    deterministicQa,
    lint,
    imagesEvidence: {
      passed: true,
      required: Boolean(imagePolicy.policy?.targetTotal),
      expected: Number(imagePolicy.policy?.targetTotal || 0),
      attached: Number(imagePolicy.currentCount || 0),
      missing: Number(imagePolicy.missing || 0)
    }
  };
}

async function listReadyRepairCandidates(env, planDate) {
  const db = requireDb(env);
  const slotted = await db.prepare(
    `SELECT s.plan_date, s.blog_id, s.slot_no, s.job_id,
            j.blogger_post_id, j.target_url, j.status AS job_status, j.result_json,
            'daily_slot' AS candidate_source
     FROM daily_plan_slots s
     JOIN jobs j ON j.id = s.job_id
     LEFT JOIN job_publications p ON p.job_id = j.id
     WHERE s.plan_date BETWEEN date(?, ?) AND ?
       AND s.kind = 'repair_existing'
       AND s.status = 'resolved'
       AND j.mode = 'repair_existing'
       AND j.status = 'ready'
       AND j.archived_at IS NULL
       AND p.job_id IS NULL
     ORDER BY s.plan_date, s.slot_no, s.blog_id, s.job_id`
  ).bind(planDate, `-${REPAIR_CARRYOVER_LOOKBACK_DAYS} days`, planDate).all();

  const orphan = await db.prepare(
    `SELECT ? AS plan_date, j.blog_id, NULL AS slot_no, j.id AS job_id,
            j.blogger_post_id, j.target_url, j.status AS job_status, j.result_json,
            'orphan_ready' AS candidate_source
     FROM jobs j
     LEFT JOIN job_publications p ON p.job_id = j.id
     WHERE j.mode = 'repair_existing'
       AND j.status = 'ready'
       AND j.archived_at IS NULL
       AND j.daily_slot_id IS NULL
       AND p.job_id IS NULL
     ORDER BY j.updated_at, j.id`
  ).bind(planDate).all();

  const rows = [...(slotted.results || [])];
  const nextSlotByBlog = new Map();
  for (const row of rows) {
    const blogId = String(row.blog_id);
    nextSlotByBlog.set(blogId, Math.max(nextSlotByBlog.get(blogId) || 0, Number(row.slot_no || 0)));
  }
  for (const row of orphan.results || []) {
    const blogId = String(row.blog_id);
    const nextSlot = (nextSlotByBlog.get(blogId) || 0) + 1;
    nextSlotByBlog.set(blogId, nextSlot);
    rows.push({ ...row, slot_no: nextSlot });
  }
  return rows;
}

async function previousScheduledAction(env, candidate, position) {
  return requireDb(env).prepare(
    `SELECT scheduled_time, slot_no
     FROM job_publications
     WHERE plan_date = ? AND blog_id = ?
       AND status IN ('scheduled', 'published', 'scheduled_update', 'updated')
       AND slot_no < ?
     ORDER BY slot_no DESC LIMIT 1`
  ).bind(String(candidate.plan_date), String(candidate.blog_id), Number(position)).first();
}

async function resolveRepairPosition(env, candidate, settings) {
  const reservedNew = Number(settings.newArticlesEnabled ? settings.newArticlesPerDay : 0);
  const plannedPosition = reservedNew + Math.max(1, Number(candidate.slot_no || 1));
  const current = await requireDb(env).prepare(
    `SELECT COALESCE(MAX(slot_no), 0) AS max_slot
     FROM job_publications
     WHERE plan_date = ? AND blog_id = ?
       AND status IN ('scheduled', 'published', 'scheduled_update', 'updated', 'claimed', 'verification_pending')`
  ).bind(String(candidate.plan_date), String(candidate.blog_id)).first();
  return Math.max(plannedPosition, Number(current?.max_slot || 0) + 1, reservedNew + 1);
}

async function resolveScheduledAt(env, candidate, settings, position, now) {
  const plannedMinute = scheduledMinuteForPublish(settings, candidate.plan_date, candidate.blog_id, position);
  let scheduledAt = kstTimestamp(candidate.plan_date, plannedMinute);
  const previous = await previousScheduledAction(env, candidate, position);
  if (previous?.scheduled_time) {
    const gap = Number(settings.publishIntervalMinutes || 30)
      + deterministicPublishJitter(candidate.plan_date, candidate.blog_id, `gap:${position}`, settings.publishJitterMinutes || 0);
    scheduledAt = addMinutes(previous.scheduled_time, gap);
  }
  const minimum = new Date(now.getTime() + MIN_SCHEDULE_LEAD_MINUTES * 60000);
  const scheduledDate = new Date(scheduledAt);
  if (!Number.isFinite(scheduledDate.getTime()) || scheduledDate <= minimum) scheduledAt = minimum.toISOString();
  return scheduledAt;
}

async function scheduleRepairCandidate(env, candidate, settings, now) {
  const result = safeResult(candidate.result_json);
  const eligibility = validateRepairResult(result, settings);
  if (!eligibility.ok) {
    return {
      jobId: Number(candidate.job_id),
      status: 'blocked',
      reason: eligibility.reason,
      ...(eligibility.reason === 'REPAIR_IMAGES_INCOMPLETE' ? {
        missingImages: eligibility.missingImages,
        currentImages: eligibility.currentImages,
        targetImages: eligibility.targetImages
      } : {})
    };
  }
  assertExistingIdentity(
    { blogId: String(candidate.blog_id), bloggerPostId: String(candidate.blogger_post_id) },
    result.identity
  );
  const position = await resolveRepairPosition(env, candidate, settings);
  if (position > Number(settings.maxPublishesPerDay || 0)) {
    return {
      jobId: Number(candidate.job_id),
      status: 'blocked',
      reason: 'REPAIR_POSITION_EXCEEDS_DAILY_LIMIT',
      source: candidate.candidate_source || 'daily_slot'
    };
  }
  const scheduledAt = await resolveScheduledAt(env, candidate, settings, position, now);
  const inserted = await requireDb(env).prepare(
    `INSERT OR IGNORE INTO job_publications
      (job_id, blog_id, plan_date, slot_no, scheduled_time, status, attempts, blogger_post_id, url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'scheduled_update', 1, ?, ?, datetime('now'), datetime('now'))`
  ).bind(
    Number(candidate.job_id),
    String(candidate.blog_id),
    String(candidate.plan_date),
    position,
    scheduledAt,
    String(candidate.blogger_post_id),
    candidate.target_url || result.identity?.permalink || null
  ).run();
  if (Number(inserted?.meta?.changes || 0) !== 1) return { jobId: Number(candidate.job_id), status: 'already_scheduled' };
  return {
    jobId: Number(candidate.job_id),
    status: 'scheduled_update',
    source: candidate.candidate_source || 'daily_slot',
    planDate: String(candidate.plan_date),
    bloggerPostId: String(candidate.blogger_post_id),
    url: candidate.target_url || result.identity?.permalink || null,
    scheduledAt,
    position
  };
}

async function recoverStaleClaimedUpdates(env, now) {
  const cutoff = new Date(now.getTime() - STALE_UPDATE_CLAIM_MINUTES * 60000).toISOString();
  const retry = await requireDb(env).prepare(
    `UPDATE job_publications
     SET status = 'scheduled_update', attempts = attempts + 1, error = 'STALE_UPDATE_CLAIM_RECOVERED', updated_at = datetime('now')
     WHERE status = 'claimed' AND blogger_post_id IS NOT NULL AND blogger_post_id <> ''
       AND updated_at <= ? AND attempts < ?`
  ).bind(cutoff, MAX_UPDATE_CLAIM_RECOVERIES).run();
  const held = await requireDb(env).prepare(
    `UPDATE job_publications
     SET status = 'failed', error = 'STALE_UPDATE_CLAIM_HELD', updated_at = datetime('now')
     WHERE status = 'claimed' AND blogger_post_id IS NOT NULL AND blogger_post_id <> ''
       AND updated_at <= ? AND attempts >= ?`
  ).bind(cutoff, MAX_UPDATE_CLAIM_RECOVERIES).run();
  return {
    recovered: Number(retry?.meta?.changes || 0),
    held: Number(held?.meta?.changes || 0)
  };
}

async function listScheduledUpdates(env, planDate) {
  const result = await requireDb(env).prepare(
    `SELECT p.job_id, p.blog_id, p.plan_date, p.slot_no, p.scheduled_time, p.blogger_post_id, p.url,
            j.status AS job_status, j.result_json
     FROM job_publications p
     JOIN jobs j ON j.id = p.job_id
     WHERE p.plan_date BETWEEN date(?, ?) AND ?
       AND p.status = 'scheduled_update'
     ORDER BY p.scheduled_time, p.plan_date, p.blog_id, p.slot_no`
  ).bind(planDate, `-${REPAIR_CARRYOVER_LOOKBACK_DAYS} days`, planDate).all();
  return result.results || [];
}

async function claimScheduledUpdate(env, jobId) {
  const result = await requireDb(env).prepare(
    `UPDATE job_publications SET status = 'claimed', updated_at = datetime('now')
     WHERE job_id = ? AND status = 'scheduled_update'`
  ).bind(Number(jobId)).run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function markUpdated(env, action, updated, readback) {
  await requireDb(env).prepare(
    `UPDATE job_publications
     SET status = 'updated', blogger_post_id = ?, url = ?, error = NULL, updated_at = datetime('now')
     WHERE job_id = ? AND status IN ('claimed', 'verification_pending')`
  ).bind(
    String(updated?.bloggerPostId || action.blogger_post_id),
    readback?.identity?.permalink || updated?.url || action.url || null,
    Number(action.job_id)
  ).run();
}

async function markVerificationPending(env, action, updated) {
  await requireDb(env).prepare(
    `UPDATE job_publications
     SET status = 'verification_pending', blogger_post_id = ?, url = ?, error = 'BLOGGER_READBACK_PENDING', updated_at = datetime('now')
     WHERE job_id = ? AND status = 'claimed'`
  ).bind(String(updated?.bloggerPostId || action.blogger_post_id), updated?.url || action.url || null, Number(action.job_id)).run();
}

async function markFailed(env, jobId, error) {
  await requireDb(env).prepare(
    `UPDATE job_publications SET status = 'failed', error = ?, updated_at = datetime('now')
     WHERE job_id = ? AND status = 'claimed'`
  ).bind(String(error || 'AUTO_REPAIR_UPDATE_FAILED').slice(0, 300), Number(jobId)).run();
}

function repairResultWithEvidence(result, eligibility, publication, readback = null) {
  const schemaDelivery = buildSchemaAwareDelivery({
    mode: 'repair_existing',
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

async function executeScheduledUpdate(env, action, settings, now, callHubFn, readbackFn) {
  const scheduled = new Date(action.scheduled_time);
  if (!Number.isFinite(scheduled.getTime()) || scheduled > now) return null;
  if (!settings?.enabled || !settings?.autoPublishEnabled || settings?.approvalMode !== 'auto') {
    return { jobId: Number(action.job_id), status: 'blocked', reason: 'REPAIR_AUTOMATION_DISABLED' };
  }
  const result = safeResult(action.result_json);
  const eligibility = validateRepairResult(result, settings);
  if (!eligibility.ok) {
    return {
      jobId: Number(action.job_id),
      status: 'blocked',
      reason: eligibility.reason,
      ...(eligibility.reason === 'REPAIR_IMAGES_INCOMPLETE' ? {
        missingImages: eligibility.missingImages,
        currentImages: eligibility.currentImages,
        targetImages: eligibility.targetImages
      } : {})
    };
  }
  assertExistingIdentity(
    { blogId: String(action.blog_id), bloggerPostId: String(action.blogger_post_id) },
    result.identity
  );
  if (!await claimScheduledUpdate(env, action.job_id)) return null;
  try {
    await persistJobTransition(env, action.job_id, 'updating_existing');
    const updated = await callHubFn(env, env.HUB_BLOGGER_POST_PATH || '/api/blogger/post', {
      operation: 'update',
      publishMode: 'published',
      blogId: String(action.blog_id),
      bloggerPostId: String(action.blogger_post_id),
      article: result.article
    });
    if (!updated?.ok || String(updated.bloggerPostId || '') !== String(action.blogger_post_id)) {
      throw new Error('BLOGGER_REPAIR_UPDATE_RESULT_INVALID');
    }
    const publication = { mode: 'scheduled_update', updatedAt: new Date().toISOString(), ...updated };

    let readback = null;
    let readbackError = null;
    try {
      readback = await readbackFn(env, {
        blogId: String(action.blog_id),
        bloggerPostId: String(action.blogger_post_id)
      });
    } catch (error) {
      readbackError = error;
    }
    const check = readback
      ? validateBloggerReadback({ blogId: String(action.blog_id), bloggerPostId: String(action.blogger_post_id) }, readback)
      : { passed: false };
    if (!check.passed) {
      await markVerificationPending(env, action, updated);
      const pendingResult = repairResultWithEvidence(result, eligibility, publication, readback);
      await persistJobResult(env, action.job_id, {
        ...pendingResult,
        publicationVerification: {
          status: 'PENDING',
          reason: String(readbackError?.message || 'BLOGGER_READBACK_UNCONFIRMED').slice(0, 180),
          checkedAt: new Date().toISOString()
        }
      });
      return {
        jobId: Number(action.job_id),
        status: 'verification_pending',
        bloggerPostId: String(updated.bloggerPostId),
        url: updated.url || action.url || null,
        scheduledAt: action.scheduled_time
      };
    }

    const completedResult = repairResultWithEvidence(result, eligibility, publication, readback);
    if (!deliveryEvidenceComplete(completedResult.deliveryEvidence)) {
      await persistJobResult(env, action.job_id, completedResult);
      throw new Error('DELIVERY_EVIDENCE_INCOMPLETE');
    }
    await markUpdated(env, action, updated, readback);
    await persistJobTransition(env, action.job_id, 'completed', { result: completedResult });
    return {
      jobId: Number(action.job_id),
      status: 'updated',
      bloggerPostId: String(updated.bloggerPostId),
      url: readback?.identity?.permalink || updated.url || action.url || null,
      scheduledAt: action.scheduled_time,
      evidence: completedResult.deliveryEvidence
    };
  } catch (error) {
    await markFailed(env, action.job_id, error?.message || 'AUTO_REPAIR_UPDATE_FAILED');
    try { await persistJobTransition(env, action.job_id, 'failed', { error: error?.message || 'AUTO_REPAIR_UPDATE_FAILED' }); } catch { /* preserve primary failure */ }
    return { jobId: Number(action.job_id), status: 'failed', reason: String(error?.message || 'AUTO_REPAIR_UPDATE_FAILED') };
  }
}

export async function runScheduledRepairUpdates(env, blogs, options = {}) {
  if (env?.AUTO_PUBLISH_EXECUTION_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'AUTO_PUBLISH_EXECUTION_DISABLED', scheduled: 0, updated: 0 };
  }
  if (env?.BLOGGER_WRITES_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'BLOGGER_WRITES_DISABLED', scheduled: 0, updated: 0 };
  }
  const now = options.now || new Date();
  const planDate = dateInTimeZone(now, env.OPERATIONS_TIMEZONE || 'Asia/Seoul');
  const staleClaims = await recoverStaleClaimedUpdates(env, now);
  const automation = options.automation || await readAutomationSettings(env, blogs);
  const settingsByBlog = new Map((automation.blogs || []).map((item) => [String(item.blogId), item.effective]));
  const scheduledOutcomes = [];
  for (const candidate of await listReadyRepairCandidates(env, planDate)) {
    const settings = settingsByBlog.get(String(candidate.blog_id));
    if (!settings?.enabled || !settings?.autoPublishEnabled || settings?.approvalMode !== 'auto') continue;
    scheduledOutcomes.push(await scheduleRepairCandidate(env, candidate, settings, now));
  }

  const updateOutcomes = [];
  const callHubFn = options.callHubFn || callHub;
  const readbackFn = options.readbackFn || ((runtimeEnv, input) => callHubFn(
    runtimeEnv,
    runtimeEnv.HUB_BLOGGER_GET_PATH || '/api/blogger/post/get',
    input
  ));
  for (const action of await listScheduledUpdates(env, planDate)) {
    const settings = settingsByBlog.get(String(action.blog_id));
    const outcome = await executeScheduledUpdate(env, action, settings, now, callHubFn, readbackFn);
    if (outcome) updateOutcomes.push(outcome);
  }

  return {
    ok: [...scheduledOutcomes, ...updateOutcomes].every((item) => item.status !== 'failed') && staleClaims.held === 0,
    enabled: true,
    planDate,
    staleClaims,
    scheduled: scheduledOutcomes.filter((item) => item.status === 'scheduled_update').length,
    updated: updateOutcomes.filter((item) => item.status === 'updated').length,
    verificationPending: updateOutcomes.filter((item) => item.status === 'verification_pending').length,
    blocked: [...scheduledOutcomes, ...updateOutcomes].filter((item) => item.status === 'blocked').length,
    failed: updateOutcomes.filter((item) => item.status === 'failed').length,
    outcomes: [...scheduledOutcomes, ...updateOutcomes]
  };
}