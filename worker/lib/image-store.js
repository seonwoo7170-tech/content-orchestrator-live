function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function normalizeId(value, code) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(code);
  return id;
}

function safeProviderError(value) {
  return String(value || '').replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 120);
}

export async function persistImagePlan(env, jobId, images) {
  const db = requireDb(env);
  const normalizedJobId = normalizeId(jobId, 'JOB_ID_INVALID');
  if (!Array.isArray(images) || !images.length) throw new Error('IMAGE_PLAN_REQUIRED');

  const statements = images.map((image) => db.prepare(
    `INSERT OR IGNORE INTO job_images
      (job_id, role, position, status, prompt, alt_text, hook_text, created_at, updated_at)
     VALUES (?, ?, ?, 'planned', ?, ?, ?, datetime('now'), datetime('now'))`
  ).bind(
    normalizedJobId,
    String(image.role),
    Number(image.position),
    String(image.prompt),
    String(image.altText),
    image.hookText ? String(image.hookText) : null
  ));
  const results = await db.batch(statements);
  const inserted = (results || []).reduce((sum, result) => sum + Number(result?.meta?.changes ?? 0), 0);
  return { requested: images.length, inserted };
}

export async function listJobImages(env, jobId) {
  const db = requireDb(env);
  const rows = await db.prepare(
    `SELECT id, job_id, role, position, status, prompt, alt_text, hook_text, provider, model, mime_type,
            storage_key, public_url, error, provider_task_id, provider_status, provider_attempt_count,
            provider_error_code, provider_error_message, provider_checked_at,
            created_at, updated_at
     FROM job_images
     WHERE job_id = ?
     ORDER BY CASE role WHEN 'thumbnail' THEN 0 ELSE 1 END, position, id`
  ).bind(normalizeId(jobId, 'JOB_ID_INVALID')).all();
  return rows.results || [];
}

export async function markImageProviderPending(env, imageId, meta = {}) {
  const db = requireDb(env);
  // Keep the durable image lifecycle status inside the original D1 CHECK domain.
  // Provider-side async progress lives in provider_status/provider_task_id.
  const result = await db.prepare(
    `UPDATE job_images
        SET status = 'planned',
            provider = ?,
            model = ?,
            provider_task_id = ?,
            provider_status = ?,
            provider_attempt_count = COALESCE(provider_attempt_count, 0) + 1,
            provider_error_code = NULL,
            provider_error_message = NULL,
            error = NULL,
            provider_checked_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ?`
  ).bind(
    String(meta.provider || 'kie-ai'),
    String(meta.model || ''),
    String(meta.taskId || ''),
    String(meta.state || 'waiting'),
    normalizeId(imageId, 'IMAGE_ID_INVALID')
  ).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('IMAGE_STATE_WRITE_FAILED');
}

export async function markImageProviderProgress(env, imageId, meta = {}) {
  const db = requireDb(env);
  const result = await db.prepare(
    `UPDATE job_images
        SET provider_status = ?,
            provider_checked_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ?`
  ).bind(
    String(meta.state || 'generating'),
    normalizeId(imageId, 'IMAGE_ID_INVALID')
  ).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('IMAGE_STATE_WRITE_FAILED');
}

export async function markImageGenerated(env, imageId, meta) {
  const db = requireDb(env);
  const fallbackCode = meta?.fallbackFrom ? safeProviderError(meta?.fallbackReason || 'PRIMARY_IMAGE_FAILED') : '';
  const result = await db.prepare(
    `UPDATE job_images
     SET status = 'generated', provider = ?, model = ?, mime_type = ?,
         provider_status = 'success',
         provider_error_code = CASE WHEN ? <> '' THEN ? ELSE provider_error_code END,
         provider_error_message = CASE WHEN ? <> '' THEN ? ELSE provider_error_message END,
         provider_checked_at = datetime('now'),
         error = NULL, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    String(meta.provider || ''),
    String(meta.model || ''),
    String(meta.mimeType || 'image/jpeg'),
    fallbackCode,
    fallbackCode,
    fallbackCode,
    fallbackCode,
    normalizeId(imageId, 'IMAGE_ID_INVALID')
  ).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('IMAGE_STATE_WRITE_FAILED');
}

export async function markImageStored(env, imageId, meta) {
  const db = requireDb(env);
  const mimeType = String(meta.mimeType || '').trim();
  const result = await db.prepare(
    `UPDATE job_images
     SET status = 'stored', storage_key = ?, public_url = ?,
         mime_type = CASE WHEN ? <> '' THEN ? ELSE mime_type END,
         error = NULL, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(
    String(meta.storageKey || ''),
    String(meta.publicUrl || ''),
    mimeType,
    mimeType,
    normalizeId(imageId, 'IMAGE_ID_INVALID')
  ).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('IMAGE_STATE_WRITE_FAILED');
}

export async function markImageAttached(env, imageId) {
  const db = requireDb(env);
  const result = await db.prepare(
    `UPDATE job_images SET status = 'attached', error = NULL, updated_at = datetime('now') WHERE id = ?`
  ).bind(normalizeId(imageId, 'IMAGE_ID_INVALID')).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('IMAGE_STATE_WRITE_FAILED');
}

export async function markImageFailed(env, imageId, error) {
  const db = requireDb(env);
  const safeError = String(error || 'IMAGE_FAILED').slice(0, 300);
  const providerCode = safeProviderError(safeError);
  const result = await db.prepare(
    `UPDATE job_images
        SET status = 'failed',
            error = ?,
            provider_status = 'fail',
            provider_error_code = ?,
            provider_error_message = ?,
            provider_checked_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ?`
  ).bind(
    safeError,
    providerCode,
    safeError,
    normalizeId(imageId, 'IMAGE_ID_INVALID')
  ).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('IMAGE_STATE_WRITE_FAILED');
}
