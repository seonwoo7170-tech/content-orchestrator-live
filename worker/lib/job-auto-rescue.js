import { MAX_JOB_RETRIES, classifyFailureCode, safeFailureCode } from './job-recovery.js';

const SAFE_STALE_STATES = Object.freeze([
  'queued',
  'writing',
  'critic_review',
  'repairing',
  'final_critic'
]);

const NEVER_AUTO_RETRY_CODES = Object.freeze([
  'DUPLICATE_TOPIC_PUBLICATION_BLOCKED',
  'BLOGGER_WRITE_OUTCOME_UNKNOWN',
  'STALE_PUBLICATION_CLAIM',
  'MANUAL_RETRY_REQUIRES_PUBLICATION_REVIEW'
]);

const REVIEW_CONTINUE_CODE = 'CRITIC_REVIEW_CONTINUE';
const LEGACY_REVIEW_RETRY_CODE = 'CRITIC_REVIEW_RETRY';
const STALE_PIPELINE_CODE = 'STALE_PIPELINE_EXECUTION';
const LEGACY_ROUTE_RECHECK_CODE = 'LEGACY_API_HUB_ROUTE_RECHECK';
const MAX_REVIEW_CONTINUATIONS = 4;
const LEGACY_ROUTE_CODES = new Set(['API_HUB_404', 'API_HUB_405']);
const LEGACY_REVIEW_HOLD_CODES = new Set([LEGACY_REVIEW_RETRY_CODE, STALE_PIPELINE_CODE]);

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('JOB_AUTO_RESCUE_TIME_INVALID');
  return date;
}

function normalizeLimit(value, fallback = 20) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 100) throw new Error('JOB_AUTO_RESCUE_LIMIT_INVALID');
  return number;
}

function normalizeStaleMinutes(value, fallback = 20) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 5 || number > 1440) throw new Error('JOB_AUTO_RESCUE_STALE_MINUTES_INVALID');
  return number;
}

function normalizedCode(row, fallback) {
  return safeFailureCode(row?.last_error_code || row?.error || fallback);
}

function neverAutoRetry(code) {
  const value = String(code || '').toUpperCase();
  return NEVER_AUTO_RETRY_CODES.some((blocked) => value.includes(blocked));
}

function parseSavedResult(row) {
  if (!row?.result_json) return null;
  try {
    const result = JSON.parse(row.result_json);
    return result && typeof result === 'object' ? result : null;
  } catch {
    return null;
  }
}

function hasSavedReviewContinuation(row) {
  const result = parseSavedResult(row);
  return result?.status === 'NEEDS_REVIEW'
    && Boolean(result?.article)
    && typeof result.article === 'object';
}

function reviewContinuationAttempt(row) {
  const result = parseSavedResult(row);
  const value = Number(result?.continuationAttempt || 0);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function isReviewContinuationRetry(row) {
  return String(row?.status || '') === 'failed'
    && ['retry_wait', 'held', 'none'].includes(String(row?.recovery_state || 'none'))
    && String(row?.last_error_code || '') === REVIEW_CONTINUE_CODE
    && hasSavedReviewContinuation(row);
}

function isLegacyReviewHold(row) {
  return String(row?.recovery_state || '') === 'held'
    && String(row?.hold_reason || '') === 'RETRY_LIMIT_REACHED'
    && LEGACY_REVIEW_HOLD_CODES.has(String(row?.last_error_code || ''))
    && hasSavedReviewContinuation(row);
}

function isLegacyRouteFailure(row) {
  return String(row?.mode || '') === 'repair_existing'
    && String(row?.status || '') === 'failed'
    && ['retry_wait', 'held'].includes(String(row?.recovery_state || ''))
    && LEGACY_ROUTE_CODES.has(String(row?.last_error_code || ''))
    && Boolean(String(row?.blogger_post_id || '').trim());
}

async function hasUnsafePublication(db, jobId) {
  const row = await db.prepare(
    `SELECT status, blogger_post_id, error
       FROM job_publications
      WHERE job_id = ?
      LIMIT 1`
  ).bind(Number(jobId)).first();
  if (!row) return false;
  const error = String(row.error || '').toUpperCase();
  return ['claimed', 'published'].includes(String(row.status || ''))
    || Boolean(row.blogger_post_id)
    || error.includes('BLOGGER_WRITE_OUTCOME_UNKNOWN')
    || error.includes('STALE_PUBLICATION_CLAIM');
}

async function holdJob(db, row, reason, now) {
  const jobId = Number(row.id);
  const status = String(row.status || '');
  const normalizedStatus = SAFE_STALE_STATES.includes(status) ? 'failed' : status;
  const result = await db.prepare(
    `UPDATE jobs
        SET status = ?,
            recovery_state = 'held',
            next_retry_at = NULL,
            hold_reason = ?,
            last_error_code = COALESCE(NULLIF(last_error_code, ''), ?),
            last_failure_at = COALESCE(last_failure_at, ?),
            updated_at = datetime('now')
      WHERE id = ? AND archived_at IS NULL AND status = ?`
  ).bind(normalizedStatus, reason, reason, now.toISOString(), jobId, status).run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function makeDueRetry(db, row, code, now, options = {}) {
  const jobId = Number(row.id);
  const retryCount = Number(row.retry_count || 0);
  if (retryCount >= MAX_JOB_RETRIES) {
    const held = await holdJob(db, row, 'RETRY_LIMIT_REACHED', now);
    return { jobId, action: held ? 'held' : 'skipped', reason: 'RETRY_LIMIT_REACHED' };
  }

  const nextRetryAt = String(options.nextRetryAt || now.toISOString());
  const result = await db.prepare(
    `UPDATE jobs
        SET status = 'failed',
            error = ?,
            retry_count = retry_count + 1,
            recovery_state = 'retry_wait',
            next_retry_at = ?,
            hold_reason = NULL,
            last_error_code = ?,
            last_failure_at = ?,
            updated_at = datetime('now')
      WHERE id = ? AND archived_at IS NULL AND status = ?`
  ).bind(code, nextRetryAt, code, now.toISOString(), jobId, String(row.status)).run();
  return {
    jobId,
    action: Number(result?.meta?.changes || 0) === 1 ? 'retry_due' : 'skipped',
    reason: code,
    nextRetryAt
  };
}

async function reviveLegacyReviewHold(db, row, now) {
  const jobId = Number(row.id);
  const priorStatus = String(row.status || '');
  const priorCode = String(row.last_error_code || '');
  if (!isLegacyReviewHold(row)) {
    return { jobId, action: 'skipped', reason: 'LEGACY_REVIEW_RESULT_UNSAFE' };
  }
  if (neverAutoRetry(priorCode) || await hasUnsafePublication(db, jobId)) {
    const reason = neverAutoRetry(priorCode) ? priorCode : 'MANUAL_RETRY_REQUIRES_PUBLICATION_REVIEW';
    const held = await holdJob(db, row, reason, now);
    return { jobId, action: held ? 'held' : 'skipped', reason };
  }

  const result = await db.prepare(
    `UPDATE jobs
        SET status = 'failed',
            error = ?,
            retry_count = 0,
            recovery_state = 'retry_wait',
            next_retry_at = ?,
            hold_reason = NULL,
            last_error_code = ?,
            last_failure_at = ?,
            updated_at = datetime('now')
      WHERE id = ?
        AND archived_at IS NULL
        AND status = ?
        AND recovery_state = 'held'
        AND hold_reason = 'RETRY_LIMIT_REACHED'
        AND last_error_code = ?
        AND result_json IS NOT NULL`
  ).bind(
    REVIEW_CONTINUE_CODE,
    now.toISOString(),
    REVIEW_CONTINUE_CODE,
    now.toISOString(),
    jobId,
    priorStatus,
    priorCode
  ).run();
  return {
    jobId,
    action: Number(result?.meta?.changes || 0) === 1 ? 'revived' : 'skipped',
    reason: priorCode
  };
}

async function reviveLegacyRouteFailure(db, row, now) {
  const jobId = Number(row.id);
  const priorCode = String(row.last_error_code || '');
  if (!isLegacyRouteFailure(row)) {
    return { jobId, action: 'skipped', reason: 'LEGACY_ROUTE_RECHECK_UNSAFE' };
  }
  if (await hasUnsafePublication(db, jobId)) {
    const reason = 'MANUAL_RETRY_REQUIRES_PUBLICATION_REVIEW';
    const held = await holdJob(db, row, reason, now);
    return { jobId, action: held ? 'held' : 'skipped', reason };
  }

  const result = await db.prepare(
    `UPDATE jobs
        SET status = 'failed',
            error = ?,
            retry_count = 0,
            recovery_state = 'retry_wait',
            next_retry_at = ?,
            hold_reason = NULL,
            last_error_code = ?,
            last_failure_at = ?,
            updated_at = datetime('now')
      WHERE id = ?
        AND archived_at IS NULL
        AND mode = 'repair_existing'
        AND status = 'failed'
        AND recovery_state IN ('retry_wait','held')
        AND last_error_code = ?
        AND blogger_post_id IS NOT NULL`
  ).bind(
    LEGACY_ROUTE_RECHECK_CODE,
    now.toISOString(),
    LEGACY_ROUTE_RECHECK_CODE,
    now.toISOString(),
    jobId,
    priorCode
  ).run();
  return {
    jobId,
    action: Number(result?.meta?.changes || 0) === 1 ? 'revived_route' : 'skipped',
    reason: priorCode
  };
}

async function rescueNeedsReview(db, row, now) {
  const code = normalizedCode(row, REVIEW_CONTINUE_CODE);
  if (!hasSavedReviewContinuation(row)) {
    const held = await holdJob(db, row, 'QUALITY_REVIEW_RESULT_MISSING', now);
    return { jobId: Number(row.id), action: held ? 'held' : 'skipped', reason: 'QUALITY_REVIEW_RESULT_MISSING' };
  }
  if (reviewContinuationAttempt(row) >= MAX_REVIEW_CONTINUATIONS) {
    const held = await holdJob(db, row, 'QUALITY_REVIEW_LIMIT_REACHED', now);
    return { jobId: Number(row.id), action: held ? 'held' : 'skipped', reason: 'QUALITY_REVIEW_LIMIT_REACHED' };
  }
  if (neverAutoRetry(code) || await hasUnsafePublication(db, row.id)) {
    const reason = neverAutoRetry(code) ? code : 'MANUAL_RETRY_REQUIRES_PUBLICATION_REVIEW';
    const held = await holdJob(db, row, reason, now);
    return { jobId: Number(row.id), action: held ? 'held' : 'skipped', reason };
  }

  const jobId = Number(row.id);
  const status = String(row.status || '');
  const nextRetryAt = now.toISOString();
  const result = await db.prepare(
    `UPDATE jobs
        SET status = 'failed',
            error = ?,
            retry_count = 0,
            recovery_state = 'retry_wait',
            next_retry_at = ?,
            hold_reason = NULL,
            last_error_code = ?,
            last_failure_at = ?,
            updated_at = datetime('now')
      WHERE id = ? AND archived_at IS NULL AND status = ?`
  ).bind(REVIEW_CONTINUE_CODE, nextRetryAt, REVIEW_CONTINUE_CODE, now.toISOString(), jobId, status).run();
  return {
    jobId,
    action: Number(result?.meta?.changes || 0) === 1 ? 'retry_due' : 'skipped',
    reason: REVIEW_CONTINUE_CODE,
    nextRetryAt
  };
}

async function rescueOrphanFailure(db, row, now) {
  const code = normalizedCode(row, 'UNKNOWN_FAILURE');
  if (neverAutoRetry(code) || await hasUnsafePublication(db, row.id)) {
    const reason = neverAutoRetry(code) ? code : 'MANUAL_RETRY_REQUIRES_PUBLICATION_REVIEW';
    const held = await holdJob(db, row, reason, now);
    return { jobId: Number(row.id), action: held ? 'held' : 'skipped', reason };
  }
  const classification = classifyFailureCode(code).classification;
  if (classification === 'held') {
    const held = await holdJob(db, row, code, now);
    return { jobId: Number(row.id), action: held ? 'held' : 'skipped', reason: code };
  }
  return makeDueRetry(db, row, code, now);
}

export async function primeAutomaticJobRescue(env, options = {}) {
  const db = requireDb(env);
  const now = asDate(options.now || new Date());
  const limit = normalizeLimit(options.limit, 20);
  const staleMinutes = normalizeStaleMinutes(options.staleMinutes, 20);
  const staleCutoff = new Date(now.getTime() - staleMinutes * 60_000).toISOString();

  const rows = await db.prepare(
    `SELECT id, mode, blog_id, blogger_post_id, target_url, status, error, result_json,
            retry_count, recovery_state, next_retry_at, hold_reason, last_error_code,
            last_failure_at, updated_at
       FROM jobs
      WHERE archived_at IS NULL
        AND (
          (status = 'needs_review' AND recovery_state <> 'held')
          OR (
            status = 'failed'
            AND recovery_state IN ('retry_wait','held','none')
            AND last_error_code = ?
            AND result_json IS NOT NULL
          )
          OR (
            recovery_state = 'held'
            AND hold_reason = 'RETRY_LIMIT_REACHED'
            AND last_error_code IN (?, ?)
            AND result_json IS NOT NULL
          )
          OR (
            mode = 'repair_existing'
            AND status = 'failed'
            AND recovery_state IN ('retry_wait','held')
            AND last_error_code IN ('API_HUB_404','API_HUB_405')
            AND blogger_post_id IS NOT NULL
          )
          OR (status = 'failed' AND recovery_state = 'none')
          OR (status IN ('queued','writing','critic_review','repairing','final_critic') AND datetime(updated_at) <= datetime(?))
        )
      ORDER BY updated_at ASC, id ASC
      LIMIT ?`
  ).bind(REVIEW_CONTINUE_CODE, LEGACY_REVIEW_RETRY_CODE, STALE_PIPELINE_CODE, staleCutoff, limit).all();

  const items = [];
  for (const row of rows.results || []) {
    const status = String(row.status || '');
    if (isLegacyReviewHold(row)) {
      items.push(await reviveLegacyReviewHold(db, row, now));
      continue;
    }
    if (isLegacyRouteFailure(row)) {
      items.push(await reviveLegacyRouteFailure(db, row, now));
      continue;
    }
    if (isReviewContinuationRetry(row)) {
      items.push(await rescueNeedsReview(db, row, now));
      continue;
    }
    if (status === 'needs_review') {
      items.push(await rescueNeedsReview(db, row, now));
      continue;
    }
    if (status === 'failed') {
      items.push(await rescueOrphanFailure(db, row, now));
      continue;
    }
    if (SAFE_STALE_STATES.includes(status)) {
      items.push(await makeDueRetry(db, row, STALE_PIPELINE_CODE, now));
    }
  }

  return {
    ok: true,
    checked: (rows.results || []).length,
    revived: items.filter((item) => item.action === 'revived').length,
    revivedRoutes: items.filter((item) => item.action === 'revived_route').length,
    retryDue: items.filter((item) => item.action === 'retry_due').length,
    held: items.filter((item) => item.action === 'held').length,
    skipped: items.filter((item) => item.action === 'skipped').length,
    items
  };
}
