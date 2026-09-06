function positiveId(value, code = 'DAILY_SLOT_ID_INVALID') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(code);
  return id;
}

export function normalizeDailySlotAssignment(slot, input = {}) {
  if (!slot || typeof slot !== 'object') throw new Error('DAILY_SLOT_REQUIRED');
  const slotId = positiveId(slot.id);
  const blogId = String(slot.blog_id || '').trim();
  if (!blogId) throw new Error('BLOG_ID_REQUIRED');
  if (slot.status === 'skipped') throw new Error('DAILY_SLOT_SKIPPED');

  if (slot.kind === 'new_article') {
    const topic = String(input.topic || '').trim();
    const language = String(input.language || 'ko').trim().toLowerCase();
    if (!topic) throw new Error('TOPIC_REQUIRED');
    if (!['ko', 'en'].includes(language)) throw new Error('LANGUAGE_INVALID');
    const candidateId = Number(input.topicCandidateId || 0);
    const topicSource = input.topicSource ? String(input.topicSource).trim().slice(0, 40) : '';
    return {
      mode: 'new_article',
      blogId,
      topic,
      language,
      ...(Number.isInteger(candidateId) && candidateId > 0 ? { topicCandidateId: candidateId } : {}),
      ...(topicSource ? { topicSource } : {}),
      dailySlotId: slotId
    };
  }

  if (slot.kind === 'repair_existing') {
    const bloggerPostId = String(input.bloggerPostId || '').trim();
    if (!bloggerPostId) throw new Error('BLOGGER_POST_ID_REQUIRED');
    return {
      mode: 'repair_existing',
      blogId,
      bloggerPostId,
      targetUrl: input.targetUrl ? String(input.targetUrl).trim() : null,
      instructions: input.instructions ? String(input.instructions).trim() : null,
      dailySlotId: slotId
    };
  }

  throw new Error('DAILY_SLOT_KIND_INVALID');
}

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

export async function materializeDailySlot(env, slotId, input = {}, options = {}) {
  const db = requireDb(env);
  const id = positiveId(slotId);
  const slot = await db.prepare(
    `SELECT id, plan_date, blog_id, blog_name, kind, slot_no, status, job_id
     FROM daily_plan_slots WHERE id = ? LIMIT 1`
  ).bind(id).first();
  if (!slot) throw new Error('DAILY_SLOT_NOT_FOUND');

  if (slot.status === 'resolved' && slot.job_id) {
    return { jobId: Number(slot.job_id), alreadyResolved: true, slot };
  }

  let assignmentInput = input || {};
  if (slot.kind === 'new_article') {
    const requested = String(assignmentInput.language || '').trim().toLowerCase();
    if (!requested || requested === 'auto') {
      const resolved = typeof options.resolveLanguage === 'function'
        ? await options.resolveLanguage(String(slot.blog_id), assignmentInput)
        : 'ko';
      assignmentInput = { ...assignmentInput, language: resolved || 'ko' };
    }
  }

  const job = normalizeDailySlotAssignment(slot, assignmentInput);
  await db.prepare(
    `INSERT OR IGNORE INTO jobs
      (mode, blog_id, blogger_post_id, target_url, topic, status, payload_json, daily_slot_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, datetime('now'), datetime('now'))`
  ).bind(
    job.mode,
    job.blogId,
    job.bloggerPostId || null,
    job.targetUrl || null,
    job.topic || null,
    JSON.stringify(job),
    id
  ).run();

  const storedJob = await db.prepare('SELECT id FROM jobs WHERE daily_slot_id = ? LIMIT 1').bind(id).first();
  if (!storedJob?.id) throw new Error('DAILY_SLOT_JOB_CREATE_FAILED');

  await db.prepare(
    `UPDATE daily_plan_slots
     SET status = 'resolved',
         job_id = ?,
         recovery_state = 'none',
         next_retry_at = NULL,
         hold_reason = NULL,
         last_error_code = NULL,
         updated_at = datetime('now')
     WHERE id = ? AND status = 'pending'`
  ).bind(storedJob.id, id).run();

  const updatedSlot = await db.prepare(
    `SELECT id, plan_date, blog_id, blog_name, kind, slot_no, status, job_id
     FROM daily_plan_slots WHERE id = ? LIMIT 1`
  ).bind(id).first();

  if (updatedSlot?.status !== 'resolved' || Number(updatedSlot?.job_id) !== Number(storedJob.id)) {
    throw new Error('DAILY_SLOT_RESOLVE_FAILED');
  }

  return {
    jobId: Number(storedJob.id),
    alreadyResolved: false,
    slot: updatedSlot,
    job
  };
}
