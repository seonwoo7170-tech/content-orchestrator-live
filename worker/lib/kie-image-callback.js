import { readAutomationSettings } from './automation-settings.js';
import { completeReadyJobImages } from './image-completion.js';

export const KIE_IMAGE_CALLBACK_PATH = '/api/kie/image-callback';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function callbackTaskId(payload) {
  const data = payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object'
    ? payload.data
    : payload;
  return String(data?.taskId || payload?.taskId || '').trim();
}

async function findCallbackCandidate(env, taskId) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  const row = await env.ORCHESTRATOR_DB.prepare(
    `SELECT j.id AS job_id, j.mode, j.blog_id, j.result_json, j.updated_at,
            ji.id AS image_id, ji.provider_task_id, ji.provider_status
       FROM job_images ji
       JOIN jobs j ON j.id = ji.job_id
      WHERE ji.provider_task_id = ?
        AND ji.status IN ('planned', 'generating', 'generated')
        AND j.status = 'ready'
        AND j.archived_at IS NULL
      ORDER BY ji.id
      LIMIT 1`
  ).bind(taskId).first();
  return row || null;
}

async function findCallbackCandidateWithRaceGuard(env, taskId) {
  const delays = [0, 250, 750, 1500];
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    const row = await findCallbackCandidate(env, taskId);
    if (row) return row;
  }
  return null;
}

async function resumeCallbackJob(env, candidate, executionContext) {
  const blogId = String(candidate.blog_id || '').trim();
  if (!blogId) return { ok: false, reason: 'BLOG_ID_MISSING' };

  const automation = await readAutomationSettings(env, [{ blogId, name: `Blog ${blogId}` }]);
  const effective = (automation.blogs || []).find((item) => String(item.blogId) === blogId)?.effective || automation.global;
  if (!effective?.enabled) return { ok: true, skipped: true, reason: 'AUTOMATION_DISABLED' };

  let item = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    item = await completeReadyJobImages(env, candidate, effective, {
      maxImages: 1,
      executionContext
    });

    if (item?.complete) return { ok: true, item };
    if (Number(item?.pending || 0) > 0) return { ok: true, item, reason: 'AWAITING_NEXT_CALLBACK' };
    if (Number(item?.failed || 0) > 0) return { ok: false, item, reason: 'PROVIDER_FAILURE' };
    if (Number(item?.generated || 0) > 0 || Number(item?.attachedThisRun || 0) > 0) continue;
    return { ok: true, item, reason: 'NO_FURTHER_PROGRESS' };
  }

  return { ok: true, item, reason: 'CALLBACK_RESUME_STEP_LIMIT' };
}

export async function handleKieImageCallback(request, env, ctx) {
  if (request.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'CALLBACK_JSON_INVALID' }, 400);
  }

  const taskId = callbackTaskId(payload);
  if (!taskId || taskId.length > 180) return json({ ok: false, error: 'CALLBACK_TASK_ID_INVALID' }, 400);

  const candidate = await findCallbackCandidateWithRaceGuard(env, taskId);
  if (!candidate) {
    // Callback input is treated only as a wake-up signal. Unknown task IDs cannot
    // mutate state, and returning 200 avoids provider retry storms for stale callbacks.
    return json({ ok: true, accepted: false, reason: 'TASK_NOT_ACTIVE' }, 200);
  }

  const work = resumeCallbackJob(env, candidate, ctx).catch((error) => {
    console.error('KIE_IMAGE_CALLBACK_RESUME_FAILED', String(error?.message || 'UNKNOWN').slice(0, 120));
    return { ok: false, reason: 'CALLBACK_RESUME_FAILED' };
  });

  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
  else await work;

  return json({
    ok: true,
    accepted: true,
    taskId,
    jobId: Number(candidate.job_id),
    imageId: Number(candidate.image_id)
  }, 200);
}