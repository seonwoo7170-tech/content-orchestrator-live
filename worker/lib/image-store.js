function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function normalizeId(value, code) {
  const id = Number(value);
  if (!Number.isInteger(value) && !Number.isInteger(id)) throw new Error(code);
  if (!Number.isInteger(id) || id <= 0) throw new Error(code);
  return id;
}

function safeProviderError(value) {
  return String(value || '').replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 120);
}

function isMissingEventTable(error) {
  return /no such table:\s*job_events/i.test(String(error?.message || error || ''));
}

async function appendImageEvent(env, imageId, event = {}) {
  const db = requireDb(env);
  const id = normalizeId(imageId, 'IMAGE_ID_INVALID');
  const level = ['success', 'warn', 'error'].includes(String(event.level)) ? String(event.level) : 'info';
  const eventType = String(event.eventType || 'image').slice(0, 64);
  const stage = String(event.stage || 'images').slice(0, 64);
  const message = String(event.message || '').slice(0, 500);
  const metaJson = event.meta ? JSON.stringify(event.meta).slice(0, 3000) : null;
  if (!message) return;
  try {
    await db.prepare(
      `INSERT INTO job_events (job_id, level, event_type, stage, message, meta_json)
       SELECT job_id, ?, ?, ?, ?, ? FROM job_images WHERE id = ?`
    ).bind(level, eventType, stage, message, metaJson, id).run();
  } catch (error) {
    if (!isMissingEventTable(error)) throw error;
  }
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
  if (inserted > 0) {
    try {
      await db.prepare(
        `INSERT INTO job_events (job_id, level, event_type, stage, message, meta_json)
         VALUES (?, 'info', 'image_plan', 'images', ?, ?)`
      ).bind(normalizedJobId, `이미지 계획 생성 · ${images.length}장`, JSON.stringify({ requested: images.length, inserted })).run();
    } catch (error) {
      if (!isMissingEventTable(error)) throw error;
    }
  }
  return { requested: images.length, inserted };
}

export async function listJobImages(env, jobId) {
  const db = requireDb(env);
  const rows = await db.prepare(
    `SELECT id, job_id, role, position, status, prompt, alt_text, hook_text, provider, model, mime_type,
            storage_key, public_url, error, provider_task_id, provider_status, provider_attempt_count,
            provider_error_code, provider_error_message, provider_checked_at, puter_attempted,
            created_at, updated_at
     FROM job_images
     WHERE job_id = ?
     ORDER BY CASE role WHEN 'thumbnail' THEN 0 ELSE 1 END, position, id`
  ).bind(normalizeId(jobId, 'JOB_ID_INVALID')).all();
  return rows.results || [];
}

export async function markImagePuterAttempted(env, imageId, meta = {}) {
  const db = requireDb(env);
  const id = normalizeId(imageId, 'IMAGE_ID_INVALID');
  const result = await db.prepare(
    `UPDATE job_images
        SET puter_attempted = 1,
            provider = 'puter',
            provider_task_id = COALESCE(NULLIF(?, ''), provider_task_id),
            provider_status = ?,
            provider_error_code = NULL,
            provider_error_message = NULL,
            error = NULL,
            provider_checked_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ?`
  ).bind(String(meta.taskId || ''), String(meta.state || 'checkpointed'), id).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('IMAGE_STATE_WRITE_FAILED');
  await appendImageEvent(env, id, {
    eventType: 'image_provider', level: 'info',
    message: `이미지 #${id} Puter 요청 · 중복방지 체크포인트 사용`,
    meta: { provider: 'puter', state: String(meta.state || 'checkpointed') }
  });
}

export async function markImageProviderPending(env, imageId, meta = {}) {
  const db = requireDb(env);
  const id = normalizeId(imageId, 'IMAGE_ID_INVALID');
  const provider = String(meta.provider || 'kie-ai');
  const taskId = String(meta.taskId || '');
  const result = await db.prepare(
    `UPDATE job_images
        SET status = 'planned', provider = ?, model = ?, provider_task_id = ?, provider_status = ?,
            provider_attempt_count = COALESCE(provider_attempt_count, 0) + 1,
            provider_error_code = NULL, provider_error_message = NULL, error = NULL,
            provider_checked_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?`
  ).bind(provider, String(meta.model || ''), taskId, String(meta.state || 'waiting'), id).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('IMAGE_STATE_WRITE_FAILED');
  await appendImageEvent(env, id, {
    eventType: 'image_provider', level: 'info',
    message: `이미지 #${id} ${provider} 작업 대기 · task ${taskId ? '저장됨' : '없음'}`,
    meta: { provider, taskId: taskId ? `${taskId.slice(0, 12)}…` : null, state: String(meta.state || 'waiting') }
  });
}

export async function markImageProviderProgress(env, imageId, meta = {}) {
  const db = requireDb(env);
  const result = await db.prepare(
    `UPDATE job_images SET provider_status = ?, provider_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).bind(String(meta.state || 'generating'), normalizeId(imageId, 'IMAGE_ID_INVALID')).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('IMAGE_STATE_WRITE_FAILED');
}

export async function markImageProviderRetry(env, imageId, error, meta = {}) {
  const db = requireDb(env);
  const id = normalizeId(imageId, 'IMAGE_ID_INVALID');
  const safeError = String(error || 'IMAGE_PROVIDER_RETRY').slice(0, 300);
  const providerCode = safeProviderError(safeError);
  const result = await db.prepare(
    `UPDATE job_images
        SET status = 'planned', provider_task_id = NULL, provider_status = 'retrying',
            provider_attempt_count = COALESCE(provider_attempt_count, 0) + ?, provider = COALESCE(?, provider),
            provider_error_code = ?, provider_error_message = ?, error = NULL,
            provider_checked_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?`
  ).bind(meta.countAttempt === true ? 1 : 0, meta.provider || null, providerCode, safeError, id).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('IMAGE_STATE_WRITE_FAILED');
  await appendImageEvent(env, id, {
    eventType: 'image_retry', level: 'warn',
    message: `이미지 #${id} ${String(meta.provider || 'provider')} 실패 → 다음 공급자/재시도 · ${providerCode}`,
    meta: { provider: meta.provider || null, errorCode: providerCode }
  });
}

export async function markImageGenerated(env, imageId, meta) {
  const db = requireDb(env);
  const id = normalizeId(imageId, 'IMAGE_ID_INVALID');
  const fallbackCode = meta?.fallbackFrom ? safeProviderError(meta?.fallbackReason || 'PRIMARY_IMAGE_FAILED') : '';
  const result = await db.prepare(
    `UPDATE job_images
     SET status = 'generated', provider = ?, model = ?, mime_type = ?, provider_status = 'success',
         provider_error_code = CASE WHEN ? <> '' THEN ? ELSE provider_error_code END,
         provider_error_message = CASE WHEN ? <> '' THEN ? ELSE provider_error_message END,
         provider_checked_at = datetime('now'), error = NULL, updated_at = datetime('now')
     WHERE id = ?`
  ).bind(String(meta.provider || ''), String(meta.model || ''), String(meta.mimeType || 'image/jpeg'), fallbackCode, fallbackCode, fallbackCode, fallbackCode, id).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('IMAGE_STATE_WRITE_FAILED');
  await appendImageEvent(env, id, {
    eventType: 'image_generated', level: 'success',
    message: `이미지 #${id} 생성 완료 · ${String(meta.provider || 'provider')} / ${String(meta.model || 'model')}`,
    meta: { provider: meta.provider || null, model: meta.model || null, fallbackFrom: meta.fallbackFrom || null }
  });
}

export async function markImageStored(env, imageId, meta) {
  const db = requireDb(env);
  const id = normalizeId(imageId, 'IMAGE_ID_INVALID');
  const mimeType = String(meta.mimeType || '').trim();
  const result = await db.prepare(
    `UPDATE job_images
     SET status = 'stored', storage_key = ?, public_url = ?, mime_type = CASE WHEN ? <> '' THEN ? ELSE mime_type END,
         error = NULL, updated_at = datetime('now') WHERE id = ?`
  ).bind(String(meta.storageKey || ''), String(meta.publicUrl || ''), mimeType, mimeType, id).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('IMAGE_STATE_WRITE_FAILED');
  await appendImageEvent(env, id, { eventType: 'image_stored', level: 'success', message: `이미지 #${id} R2 저장 완료` });
}

export async function markImageAttached(env, imageId) {
  const db = requireDb(env);
  const id = normalizeId(imageId, 'IMAGE_ID_INVALID');
  const result = await db.prepare(
    `UPDATE job_images SET status = 'attached', error = NULL, updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('IMAGE_STATE_WRITE_FAILED');
  await appendImageEvent(env, id, { eventType: 'image_attached', level: 'success', message: `이미지 #${id} 본문 첨부 완료` });
}

export async function markImageFailed(env, imageId, error) {
  const db = requireDb(env);
  const id = normalizeId(imageId, 'IMAGE_ID_INVALID');
  const safeError = String(error || 'IMAGE_FAILED').slice(0, 300);
  const providerCode = safeProviderError(safeError);
  const result = await db.prepare(
    `UPDATE job_images
        SET status = 'failed', error = ?, provider_status = 'fail', provider_error_code = ?, provider_error_message = ?,
            provider_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).bind(safeError, providerCode, safeError, id).run();
  if (Number(result?.meta?.changes ?? 0) !== 1) throw new Error('IMAGE_STATE_WRITE_FAILED');
  await appendImageEvent(env, id, {
    eventType: 'image_failed', level: 'error', message: `이미지 #${id} 실패 · ${providerCode}`,
    meta: { errorCode: providerCode }
  });
}