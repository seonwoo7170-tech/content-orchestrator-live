const STANDARD_RETRY_MINUTES = Object.freeze([1, 3, 10]);
const IMAGE_RETRY_MINUTES = Object.freeze([1, 3, 10]);
const QUOTA_RETRY_MINUTES = Object.freeze([30, 120, 360]);
export const MAX_JOB_RETRIES = 3;

const HELD_CODES = new Set([
  'KIE_AUTH_FAILED',
  'KIE_INSUFFICIENT_CREDITS',
  'GOOGLE_OAUTH_NOT_CONFIGURED',
  'BLOGGER_WRITES_DISABLED',
  'BLOGGER_POST_ID_REQUIRED',
  'BLOGGER_POST_ID_MISMATCH',
  'MASTER_V45_HASH_MISMATCH',
  'MASTER_V45_RUNTIME_INVALID',
  'DB_NOT_BOUND',
  'RECOVERY_AUTOMATION_SETTINGS_MISSING',
  'NO_ELIGIBLE_REPAIR_POST'
]);

const IMAGE_RETRY_CODES = new Set([
  'AUTO_WORK_IMAGE_GENERATION_FAILED',
  'AUTO_WORK_IMAGES_UNRESOLVED',
  'AUTO_WORK_THUMBNAIL_MISSING'
]);

const LEGACY_ROUTE_RETRY_CODES = new Set([
  'API_HUB_404',
  'API_HUB_405'
]);

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function normalizeId(id, code) {
  const value = Number(id);
  if (!Number.isInteger(value) || value <= 0) throw new Error(code);
  return value;
}

function normalizeRetryCount(value) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < 0 || number > MAX_JOB_RETRIES) throw new Error('JOB_RETRY_COUNT_INVALID');
  return number;
}

function normalizeLimit(value, fallback = 3) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 20) throw new Error('JOB_RECOVERY_LIMIT_INVALID');
  return number;
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  if (Number.isNaN(date.getTime())) throw new Error('JOB_RECOVERY_TIME_INVALID');
  return date;
}

function sanitizedToken(value) {
  const text = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return text.slice(0, 80) || null;
}

export function safeFailureCode(error) {
  const explicit = sanitizedToken(error && typeof error === 'object' ? error.code : null);
  if (explicit) return explicit;
  const raw = typeof error === 'string' ? error : String(error?.message || '');
  const first = raw.split(':', 1)[0];
  return sanitizedToken(first) || 'UNKNOWN_FAILURE';
}

export function classifyFailureCode(input) {
  const code = safeFailureCode(input);
  if (HELD_CODES.has(code)) return { code, classification: 'held' };
  if (IMAGE_RETRY_CODES.has(code)) return { code, classification: 'image_transient' };

  const quota = code === 'RESOURCE_EXHAUSTED'
    || code.includes('ACCOUNT_LIMITED')
    || code.includes('DAILY_ALLOCATION')
    || code.includes('DAILY_QUOTA');
  if (quota) return { code, classification: 'quota' };

  const transient = code === 'JOB_EXECUTION_ALREADY_CLAIMED'
    || code === 'FETCH_FAILED'
    || code === 'NETWORK_ERROR'
    || code === 'ECONNRESET'
    || code === 'ETIMEDOUT'
    || code === 'API_HUB_429'
    || code.startsWith('API_HUB_50')
    || LEGACY_ROUTE_RETRY_CODES.has(code)
    || code.includes('RATE_LIMIT')
    || code.includes('TIMEOUT')
    || code.includes('UNAVAILABLE')
    || code.includes('UPSTREAM')
    || code.includes('PROVIDER_ERROR')
    || code.endsWith('_JSON_INVALID');
  if (transient) return { code, classification: 'transient' };

  return { code, classification: 'held' };
}

export function decideJobRecovery({ error, retryCount = 0, now = new Date() } = {}) {
  const currentRetryCount = normalizeRetryCount(retryCount);
  const timestamp = asDate(now);
  const { code, classification } = classifyFailureCode(error);

  if (classification === 'held') {
    return {
      code,
      classification,
      recoveryState: 'held',
      retryCount: currentRetryCount,
      nextRetryAt: null,
      holdReason: code
    };
  }

  if (currentRetryCount >= MAX_JOB_RETRIES) {
    return {
      code,
      classification,
      recoveryState: 'held',
      retryCount: currentRetryCount,
      nextRetryAt: null,
      holdReason: 'RETRY_LIMIT_REACHED'
    };
  }

  const schedule = classification === 'quota'
    ? QUOTA_RETRY_MINUTES
    : classification === 'image_transient'
      ? IMAGE_RETRY_MINUTES
      : STANDARD_RETRY_MINUTES;
  const delayMinutes = schedule[currentRetryCount];
  const nextRetryAt = new Date(timestamp.getTime() + delayMinutes * 60_000).toISOString();
  return {
    code,
    classification,
    recoveryState: 'retry_wait',
    retryCount: currentRetryCount + 1,
    delayMinutes,
    nextRetryAt,
    holdReason: null
  };
}

export function isDailySlotRecoveryEligible(slot, now = new Date()) {
  if (!slot || String(slot.status || '') !== 'pending') return false;
  const state = String(slot.recovery_state ?? slot.recoveryState ?? 'none');
  if (!state || state === 'none') return true;
  if (state === 'held') {
    const retryCount = normalizeRetryCount(slot.retry_count ?? slot.retryCount ?? 0);
    const code = safeFailureCode(slot.last_error_code ?? slot.lastErrorCode ?? slot.hold_reason ?? slot.holdReason ?? '');
    return retryCount < MAX_JOB_RETRIES && LEGACY_ROUTE_RETRY_CODES.has(code);
  }
  if (state !== 'retry_wait') return false;
  const nextRetryAt = slot.next_retry_at ?? slot.nextRetryAt;
  if (!nextRetryAt) return false;
  const dueAt = new Date(nextRetryAt);
  if (Number.isNaN(dueAt.getTime())) return false;
  return dueAt.getTime() <= asDate(now).getTime();
}

export async function registerJobFailure(env, id, error, options = {}) {
  const db = requireDb(env);
  const jobId = normalizeId(id, 'JOB_ID_INVALID');
  const row = await db.prepare(
    'SELECT id, status, retry_count FROM jobs WHERE id = ? LIMIT 1'
  ).bind(jobId).first();
  if (!row) throw new Error('JOB_NOT_FOUND');
  if (String(row.status) !== 'failed') throw new Error(`JOB_RECOVERY_REQUIRES_FAILED:${row.status || 'unknown'}`);

  const now = asDate(options.now || new Date());
  const decision = decideJobRecovery({ error, retryCount: row.retry_count, now });
  const result = await db.prepare(
    `UPDATE jobs
     SET retry_count = ?,
         recovery_state = ?,
         next_retry_at = ?,
         hold_reason = ?,
         last_error_code = ?,
         last_failure_at = ?,
         updated_at = datetime('now')
     WHERE id = ? AND status = 'failed'`
  ).bind(
    decision.retryCount,
    decision.recoveryState,
    decision.nextRetryAt,
    decision.holdReason,
    decision.code,
    now.toISOString(),
    jobId
  ).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('JOB_RECOVERY_WRITE_FAILED');
  return { jobId, ...decision };
}

export async function registerDailySlotFailure(env, id, error, options = {}) {
  const db = requireDb(env);
  const slotId = normalizeId(id, 'DAILY_SLOT_ID_INVALID');
  const row = await db.prepare(
    'SELECT id, status, retry_count FROM daily_plan_slots WHERE id = ? LIMIT 1'
  ).bind(slotId).first();
  if (!row) throw new Error('DAILY_SLOT_NOT_FOUND');
  if (String(row.status) !== 'pending') throw new Error(`DAILY_SLOT_RECOVERY_REQUIRES_PENDING:${row.status || 'unknown'}`);

  const now = asDate(options.now || new Date());
  const decision = decideJobRecovery({ error, retryCount: row.retry_count, now });
  const result = await db.prepare(
    `UPDATE daily_plan_slots
     SET retry_count = ?,
         recovery_state = ?,
         next_retry_at = ?,
         hold_reason = ?,
         last_error_code = ?,
         last_failure_at = ?,
         updated_at = datetime('now')
     WHERE id = ? AND status = 'pending'`
  ).bind(
    decision.retryCount,
    decision.recoveryState,
    decision.nextRetryAt,
    decision.holdReason,
    decision.code,
    now.toISOString(),
    slotId
  ).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('DAILY_SLOT_RECOVERY_WRITE_FAILED');
  return { slotId, ...decision };
}

export async function listDueRetryJobs(env, options = {}) {
  const db = requireDb(env);
  const limit = normalizeLimit(options.limit, 3);
  const now = asDate(options.now || new Date()).toISOString();
  const candidateLimit = Math.min(100, Math.max(limit, limit * 6));
  const rows = await db.prepare(
    `SELECT id, mode, blog_id, blogger_post_id, target_url, topic, status, payload_json,
            retry_count, recovery_state, next_retry_at, hold_reason, last_error_code, last_failure_at, updated_at
     FROM jobs
     WHERE status = 'failed'
       AND (
         (recovery_state = 'retry_wait' AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
         OR (recovery_state = 'none' AND updated_at >= datetime('now', '-1 day'))
         OR (recovery_state = 'held' AND retry_count < ? AND last_error_code IN ('API_HUB_404', 'API_HUB_405'))
       )
     ORDER BY
       CASE recovery_state WHEN 'retry_wait' THEN 0 WHEN 'none' THEN 1 ELSE 2 END,
       COALESCE(next_retry_at, last_failure_at, updated_at) ASC,
       id ASC
     LIMIT ?`
  ).bind(now, MAX_JOB_RETRIES, candidateLimit).all();
  return (rows.results || []).slice(0, limit);
}

export async function requeueDueRetryJobs(env, options = {}) {
  const db = requireDb(env);
  const now = asDate(options.now || new Date());
  const due = options.jobs || await listDueRetryJobs(env, { now, limit: options.limit });
  const requeued = [];

  for (const row of due) {
    const jobId = normalizeId(row.id, 'JOB_ID_INVALID');
    const state = String(row.recovery_state || 'none');
    let statement;
    if (state === 'retry_wait') {
      statement = db.prepare(
        `UPDATE jobs
         SET status = 'queued', recovery_state = 'none', next_retry_at = NULL, hold_reason = NULL, error = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'failed' AND recovery_state = 'retry_wait' AND next_retry_at IS NOT NULL AND next_retry_at <= ?`
      ).bind(jobId, now.toISOString());
    } else if (state === 'held') {
      statement = db.prepare(
        `UPDATE jobs
         SET status = 'queued', recovery_state = 'none', next_retry_at = NULL, hold_reason = NULL, error = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'failed' AND recovery_state = 'held' AND retry_count < ? AND last_error_code IN ('API_HUB_404', 'API_HUB_405')`
      ).bind(jobId, MAX_JOB_RETRIES);
    } else {
      statement = db.prepare(
        `UPDATE jobs
         SET status = 'queued', recovery_state = 'none', next_retry_at = NULL, hold_reason = NULL, error = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'failed' AND recovery_state = 'none' AND updated_at >= datetime('now', '-1 day')`
      ).bind(jobId);
    }
    const result = await statement.run();
    if (Number(result?.meta?.changes ?? 0) === 1) requeued.push(jobId);
  }

  return { attempted: due.length, requeued: requeued.length, jobIds: requeued };
}

export async function readRecoverySummary(env) {
  const db = requireDb(env);
  const [jobs, slots] = await Promise.all([
    db.prepare(
      `SELECT
         SUM(CASE WHEN recovery_state = 'retry_wait' THEN 1 ELSE 0 END) AS retry_wait,
         SUM(CASE WHEN recovery_state = 'held' THEN 1 ELSE 0 END) AS held,
         SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready
       FROM jobs`
    ).first(),
    db.prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' AND recovery_state = 'retry_wait' THEN 1 ELSE 0 END) AS retry_wait,
         SUM(CASE WHEN status = 'pending' AND recovery_state = 'held' THEN 1 ELSE 0 END) AS held,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM daily_plan_slots`
    ).first()
  ]);
  return {
    jobs: {
      retryWait: Number(jobs?.retry_wait || 0),
      held: Number(jobs?.held || 0),
      needsReview: Number(jobs?.needs_review || 0),
      failed: Number(jobs?.failed || 0),
      ready: Number(jobs?.ready || 0)
    },
    slots: {
      retryWait: Number(slots?.retry_wait || 0),
      held: Number(slots?.held || 0),
      pending: Number(slots?.pending || 0)
    }
  };
}

export async function listHeldRecoveryItems(env, options = {}) {
  const db = requireDb(env);
  const limit = normalizeLimit(options.limit, 10);
  const [jobs, slots] = await Promise.all([
    db.prepare(
      `SELECT id, mode, blog_id, blogger_post_id, topic, retry_count, hold_reason, last_error_code, last_failure_at
       FROM jobs
       WHERE recovery_state = 'held'
       ORDER BY COALESCE(last_failure_at, updated_at) DESC, id DESC
       LIMIT ?`
    ).bind(limit).all(),
    db.prepare(
      `SELECT id, plan_date, blog_id, blog_name, kind, slot_no, retry_count, hold_reason, last_error_code, last_failure_at
       FROM daily_plan_slots
       WHERE status = 'pending' AND recovery_state = 'held'
       ORDER BY COALESCE(last_failure_at, updated_at) DESC, id DESC
       LIMIT ?`
    ).bind(limit).all()
  ]);
  const items = [
    ...(jobs.results || []).map((row) => ({ type: 'job', ...row })),
    ...(slots.results || []).map((row) => ({ type: 'slot', ...row }))
  ];
  return items
    .sort((a, b) => String(b.last_failure_at || '').localeCompare(String(a.last_failure_at || '')) || Number(b.id) - Number(a.id))
    .slice(0, limit);
}
