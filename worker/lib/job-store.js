const PROTECTED_JOB_IDS = new Set([36, 37, 38, 39, 40, 41, 42]);
const ACTIVE_AI_STATUSES = ['writing', 'critic_review', 'repairing', 'final_critic'];
const EXISTING_REWRITE_MODE = 'full_article_same_post_id';

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function normalizeId(id) {
  const value = Number(id);
  if (!Number.isInteger(value) || value <= 0) throw new Error('JOB_ID_INVALID');
  return value;
}

function normalizeMutableId(id) {
  const value = normalizeId(id);
  if (PROTECTED_JOB_IDS.has(value)) throw Object.assign(new Error(`PROTECTED_JOB_${value}`), { status: 409 });
  return value;
}

function parseResult(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function hasContinuationResult(row) {
  if (String(row?.last_error_code || row?.error || '').toUpperCase() !== 'CRITIC_REVIEW_CONTINUE') return false;
  const result = parseResult(row?.result_json);
  return Boolean(result?.article && typeof result.article === 'object');
}

function executionInitialStatus(row) {
  if (String(row?.last_error_code || '').toUpperCase() !== 'CRITIC_REVIEW_CONTINUE') return 'writing';
  const result = parseResult(row?.result_json);
  if (!result?.article || typeof result.article !== 'object') return 'writing';
  if (String(row?.mode || '') === 'repair_existing' && result?.rewriteMode !== EXISTING_REWRITE_MODE) return 'writing';
  return 'critic_review';
}

export function normalizeJobListLimit(value) {
  if (value === undefined || value === null || value === '') return 30;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error('JOB_LIST_LIMIT_INVALID');
  return Math.min(number, 100);
}

export function humanReadableJobError(code) {
  const value = String(code || '').trim().toUpperCase();
  if (!value) return null;

  if (value === 'API_HUB_404' || value === 'API_HUB_405') {
    return 'API Hub의 현재 경로를 찾지 못했습니다. 저장된 예전 경로가 있으면 정식 경로로 전환해 다시 확인합니다.';
  }
  if (value === 'LEGACY_API_HUB_ROUTE_RECHECK') {
    return '이전 배포에서 404로 기록된 작업을 현재 API 경로에서 다시 확인하고 있습니다.';
  }
  if (value === 'BLOGGER_API_404' || value === 'BLOGGER_POST_URL_NOT_FOUND') {
    return 'Blogger에서 대상 글을 찾지 못했습니다. 저장된 Post ID와 글 주소를 확인해야 합니다.';
  }
  if (value === 'BLOGGER_POST_ID_MISMATCH' || value === 'BLOGGER_POST_URL_MISMATCH') {
    return 'Blogger의 대상 글 식별 정보가 저장된 작업과 일치하지 않아 안전을 위해 업데이트를 중단했습니다.';
  }
  if (value.includes('DUPLICATE_TOPIC_PUBLICATION_BLOCKED')) {
    return '동일하거나 매우 유사한 주제의 더 앞선 글이 있어 중복 발행을 차단했습니다.';
  }
  if (value.includes('AUTO_WORK_UNIQUE_TOPIC_UNAVAILABLE')) {
    return '중복되지 않는 새 주제를 찾지 못했습니다. 다음 자동 실행에서 다른 주제로 다시 시도합니다.';
  }
  if (value === 'API_HUB_502' || value.startsWith('API_HUB_5')) {
    return '외부 연결이 일시적으로 불안정해 작업을 완료하지 못했습니다. 자동으로 다시 시도합니다.';
  }
  if (value.includes('ACCOUNT_LIMITED') || value.includes('QUOTA') || value.includes('RATE_LIMIT')) {
    return 'AI 사용 한도에 잠시 걸렸습니다. 한도가 풀리면 자동으로 다시 시도합니다.';
  }
  if (value.includes('IMAGE') && (value.includes('FAILED') || value.includes('UNRESOLVED') || value.includes('MISSING'))) {
    return '이미지 생성 또는 첨부가 끝나지 않았습니다. 자동으로 다시 시도합니다.';
  }
  if (value.includes('AUTH') || value.includes('UNAUTHORIZED') || value.includes('FORBIDDEN')) {
    return '연결 권한을 확인해야 합니다. 관리 연결 상태를 확인해 주세요.';
  }
  if (value.includes('BLOGGER_WRITE_OUTCOME_UNKNOWN') || value.includes('STALE_PUBLICATION_CLAIM')) {
    return 'Blogger 쓰기 결과를 확정할 수 없어 중복 발행 방지를 위해 자동 재시도를 멈췄습니다. 발행 상태 확인이 필요합니다.';
  }
  if (value.includes('BLOGGER') && (value.includes('WRITE') || value.includes('UPDATE') || value.includes('PUBLISH'))) {
    return 'Blogger에 글을 저장하는 과정에서 문제가 생겼습니다. 자동 재시도 후에도 계속되면 연결 상태를 확인해 주세요.';
  }
  if (value.includes('CRITIC') || value.includes('REVIEW')) {
    return '글 최종 검사에서 확인할 내용이 발견됐습니다. 마지막 수정본을 이어서 보완한 뒤 다시 검사합니다.';
  }
  if (value === 'STALE_PIPELINE_EXECUTION') {
    return '이전 실행이 중간 단계에서 멈춘 기록입니다. 저장된 결과가 있으면 그 지점부터 안전하게 복구합니다.';
  }
  if (value.includes('JSON') || value.includes('MODEL_RESPONSE')) {
    return 'AI 응답 형식이 올바르지 않아 작업을 마치지 못했습니다. 자동으로 다시 시도합니다.';
  }
  if (value.includes('DB_') || value.includes('DATABASE')) {
    return '작업 내용을 저장하는 과정에서 문제가 생겼습니다. 잠시 후 다시 시도합니다.';
  }

  return '작업 중 문제가 발생했습니다. 자동 복구를 시도하며, 계속 실패하면 결과에서 상세 내용을 확인해 주세요.';
}

export async function listStoredJobs(env, options = {}) {
  const db = requireDb(env);
  const limit = normalizeJobListLimit(options.limit);
  const status = String(options.status || '').trim();
  const columns = `id, mode, blog_id, blogger_post_id, target_url, topic, status,
    CASE WHEN result_json IS NULL THEN 0 ELSE 1 END AS has_result,
    CASE WHEN error IS NULL OR error = '' THEN 0 ELSE 1 END AS has_error,
    CASE
      WHEN last_error_code IS NOT NULL AND last_error_code <> '' THEN last_error_code
      WHEN error IS NULL OR error = '' THEN NULL
      ELSE 'JOB_FAILED'
    END AS error,
    retry_count, recovery_state, next_retry_at, hold_reason, last_error_code, last_failure_at,
    created_at, updated_at, archived_at`;

  const statement = status
    ? db.prepare(`SELECT ${columns} FROM jobs WHERE status = ? AND archived_at IS NULL ORDER BY id DESC LIMIT ?`).bind(status, limit)
    : db.prepare(`SELECT ${columns}
                  FROM jobs
                  WHERE archived_at IS NULL
                    AND status <> 'completed'
                    AND NOT (
                      status IN ('failed', 'needs_review')
                      AND updated_at < datetime('now', '-1 day')
                    )
                  ORDER BY id DESC
                  LIMIT ?`).bind(limit);
  const rows = await statement.all();
  const normalizedRows = (rows.results || []).map((row) => {
    const unresolved = ['failed', 'needs_review'].includes(String(row.status || ''))
      || ['retry_wait', 'held'].includes(String(row.recovery_state || ''));
    const errorCode = unresolved ? (row.error || row.last_error_code || null) : null;
    return {
      ...row,
      has_error: unresolved ? row.has_error : 0,
      error_code: errorCode,
      error: humanReadableJobError(errorCode)
    };
  });
  const ids = normalizedRows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return normalizedRows;
  const placeholders = ids.map(() => '?').join(',');
  const imageRows = await db.prepare(`SELECT id, job_id, role, position, alt_text, provider, status, public_url, provider_status, provider_task_id, updated_at FROM job_images WHERE job_id IN (${placeholders}) ORDER BY job_id DESC, CASE role WHEN 'thumbnail' THEN 0 ELSE 1 END, position, id`).bind(...ids).all();
  const byJob = new Map();
  for (const image of imageRows.results || []) {
    const key = Number(image.job_id);
    if (!byJob.has(key)) byJob.set(key, []);
    if (byJob.get(key).length < 12) byJob.get(key).push(image);
  }
  return normalizedRows.map((row) => ({ ...row, _images: byJob.get(Number(row.id)) || [] }));
}

export async function getStoredJob(env, id) {
  const db = requireDb(env);
  const row = await db.prepare('SELECT * FROM jobs WHERE id = ? LIMIT 1').bind(normalizeId(id)).first();
  if (!row) throw new Error('JOB_NOT_FOUND');
  return row;
}

export async function claimStoredJobExecution(env, id, initialStatus) {
  const db = requireDb(env);
  const jobId = normalizeMutableId(id);
  const requested = String(initialStatus || '').trim();
  if (!['writing', 'critic_review'].includes(requested)) throw new Error('JOB_EXECUTION_INITIAL_STATUS_INVALID');

  // Resolve the real first stage from stored continuation state. This prevents a
  // full existing-post rewrite from appearing as Critic before Writer has run.
  const row = await db.prepare(
    'SELECT mode, last_error_code, result_json FROM jobs WHERE id = ? AND archived_at IS NULL LIMIT 1'
  ).bind(jobId).first();
  if (!row) throw new Error('JOB_NOT_FOUND');
  const status = executionInitialStatus(row);

  // One atomic UPDATE is the global AI lane. SQLite/D1 serializes competing writes,
  // so two different jobs cannot both pass NOT EXISTS and become active together.
  const result = await db.prepare(
    `UPDATE jobs
     SET status = ?,
         error = NULL,
         recovery_state = 'none',
         next_retry_at = NULL,
         hold_reason = NULL,
         last_error_code = NULL,
         last_failure_at = NULL,
         updated_at = datetime('now')
     WHERE id = ?
       AND status = 'queued'
       AND archived_at IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM jobs AS active
         WHERE active.id <> ?
           AND active.archived_at IS NULL
           AND active.status IN ('writing', 'critic_review', 'repairing', 'final_critic')
       )`
  ).bind(status, jobId, jobId).run();
  return Number(result?.meta?.changes ?? 0) === 1;
}

export async function resetStoredJobForManualRetry(env, id) {
  const db = requireDb(env);
  const jobId = normalizeMutableId(id);
  const row = await getStoredJob(env, jobId);
  if (row.archived_at) {
    throw Object.assign(new Error('JOB_ARCHIVED'), { status: 409 });
  }
  if (!['failed', 'needs_review'].includes(String(row.status || ''))) {
    throw Object.assign(new Error('JOB_NOT_RETRYABLE'), { status: 409 });
  }

  const publication = await db.prepare(
    `SELECT status, blogger_post_id, error
     FROM job_publications
     WHERE job_id = ?
     LIMIT 1`
  ).bind(jobId).first();
  const lastError = String(row.last_error_code || row.error || '').toUpperCase();
  if (lastError.includes('DUPLICATE_TOPIC_PUBLICATION_BLOCKED')) {
    throw Object.assign(new Error('DUPLICATE_TOPIC_RETRY_NOT_ALLOWED'), { status: 409 });
  }
  const publicationError = String(publication?.error || '').toUpperCase();
  const ambiguousWrite = [lastError, publicationError].some((value) =>
    value.includes('BLOGGER_WRITE_OUTCOME_UNKNOWN') || value.includes('STALE_PUBLICATION_CLAIM')
  );
  const publicationUnsafe = publication && (
    ['claimed', 'published'].includes(String(publication.status || '')) ||
    Boolean(publication.blogger_post_id) ||
    ambiguousWrite
  );
  if (publicationUnsafe) {
    throw Object.assign(new Error('MANUAL_RETRY_REQUIRES_PUBLICATION_REVIEW'), { status: 409 });
  }

  const preserveContinuation = hasContinuationResult(row);
  const statements = [];
  if (publication?.status === 'failed') {
    statements.push(db.prepare(
      `DELETE FROM job_publications
       WHERE job_id = ? AND status = 'failed' AND blogger_post_id IS NULL`
    ).bind(jobId));
  }
  if (!preserveContinuation) {
    statements.push(db.prepare('DELETE FROM job_images WHERE job_id = ?').bind(jobId));
  }

  const jobStatementIndex = statements.length;
  statements.push(preserveContinuation
    ? db.prepare(
      `UPDATE jobs
       SET status = 'queued',
           error = NULL,
           retry_count = 0,
           recovery_state = 'none',
           next_retry_at = NULL,
           hold_reason = NULL,
           last_error_code = 'CRITIC_REVIEW_CONTINUE',
           last_failure_at = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND archived_at IS NULL AND status IN ('failed', 'needs_review')`
    ).bind(jobId)
    : db.prepare(
      `UPDATE jobs
       SET status = 'queued',
           result_json = NULL,
           error = NULL,
           retry_count = 0,
           recovery_state = 'none',
           next_retry_at = NULL,
           hold_reason = NULL,
           last_error_code = NULL,
           last_failure_at = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND archived_at IS NULL AND status IN ('failed', 'needs_review')`
    ).bind(jobId));

  statements.push(db.prepare(
    `UPDATE daily_plan_slots
     SET retry_count = 0,
         recovery_state = 'none',
         next_retry_at = NULL,
         hold_reason = NULL,
         last_error_code = ?,
         last_failure_at = NULL,
         updated_at = datetime('now')
     WHERE job_id = ?`
  ).bind(preserveContinuation ? 'CRITIC_REVIEW_CONTINUE' : null, jobId));

  const results = await db.batch(statements);
  const jobReset = results[jobStatementIndex];
  if (Number(jobReset?.meta?.changes ?? 0) !== 1) {
    throw Object.assign(new Error('JOB_RETRY_ALREADY_CLAIMED'), { status: 409 });
  }
  return {
    ok: true,
    jobId,
    status: 'queued',
    continuation: preserveContinuation,
    preserveResult: preserveContinuation,
    preserveImages: preserveContinuation
  };
}

export async function persistJobTransition(env, id, status, patch = {}) {
  const db = requireDb(env);
  const jobId = normalizeId(id);
  const resultJson = Object.prototype.hasOwnProperty.call(patch, 'result') ? JSON.stringify(patch.result) : null;
  const error = Object.prototype.hasOwnProperty.call(patch, 'error') ? String(patch.error || '') : null;
  const successful = ['ready', 'completed'].includes(String(status));
  const successFlag = successful ? 1 : 0;
  const statements = [db.prepare(
    `UPDATE jobs
     SET status = ?,
         result_json = CASE WHEN ? IS NULL THEN result_json ELSE ? END,
         error = CASE WHEN ? = 1 THEN NULL WHEN ? IS NULL THEN error ELSE ? END,
         retry_count = CASE WHEN ? = 1 THEN 0 ELSE retry_count END,
         recovery_state = CASE WHEN ? = 1 THEN 'none' ELSE recovery_state END,
         next_retry_at = CASE WHEN ? = 1 THEN NULL ELSE next_retry_at END,
         hold_reason = CASE WHEN ? = 1 THEN NULL ELSE hold_reason END,
         last_error_code = CASE WHEN ? = 1 THEN NULL ELSE last_error_code END,
         last_failure_at = CASE WHEN ? = 1 THEN NULL ELSE last_failure_at END,
         archived_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE archived_at END,
         updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    status,
    resultJson, resultJson,
    successFlag, error, error,
    successFlag, successFlag, successFlag, successFlag, successFlag, successFlag,
    status,
    jobId
  )];
  if (successful) {
    statements.push(db.prepare(
      `UPDATE daily_plan_slots
       SET retry_count = 0,
           recovery_state = 'none',
           next_retry_at = NULL,
           hold_reason = NULL,
           last_error_code = NULL,
           last_failure_at = NULL,
           updated_at = datetime('now')
       WHERE job_id = ?`
    ).bind(jobId));
  }
  const results = await db.batch(statements);
  if (Number(results?.[0]?.meta?.changes ?? 0) !== 1) throw new Error('JOB_STATE_WRITE_FAILED');
  return true;
}

export async function persistJobResult(env, id, resultValue) {
  const db = requireDb(env);
  const resultJson = JSON.stringify(resultValue ?? null);
  const result = await db.prepare(
    `UPDATE jobs SET result_json = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(resultJson, normalizeId(id)).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('JOB_RESULT_WRITE_FAILED');
  return true;
}
