import { executeJob } from './job-runner.js';
import { claimStoredJobExecution } from './job-store.js';
import { safeFailureCode } from './job-recovery.js';
import { assertTransition } from './state-machine.js';

const REVIEW_CONTINUE_CODE = 'CRITIC_REVIEW_CONTINUE';
const EXISTING_REWRITE_MODE = 'full_article_same_post_id';

function parseStoredResult(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { throw new Error('STORED_JOB_RESULT_INVALID'); }
}

export function normalizeStoredJob(row) {
  if (!row || typeof row !== 'object') throw new Error('STORED_JOB_REQUIRED');
  let payload = {};
  try { payload = row.payload_json ? JSON.parse(row.payload_json) : {}; } catch { throw new Error('STORED_JOB_PAYLOAD_INVALID'); }
  return {
    ...payload,
    id: Number(row.id),
    mode: row.mode,
    blogId: row.blog_id ?? payload.blogId ?? null,
    bloggerPostId: row.blogger_post_id ?? payload.bloggerPostId ?? null,
    targetUrl: row.target_url ?? payload.targetUrl ?? null,
    topic: row.topic ?? payload.topic ?? null,
    status: row.status,
    recoveryCode: String(row.last_error_code || ''),
    resumeResult: parseStoredResult(row.result_json)
  };
}

function normalizePipelineStage(stage) {
  if (stage === 'style_repairing') return 'repairing';
  if (stage === 'candidate_regenerating') return 'writing';
  return stage;
}

function isReviewContinuation(job) {
  return job?.recoveryCode === REVIEW_CONTINUE_CODE && Boolean(job?.resumeResult?.article);
}

function resumesAtCritic(job) {
  if (!isReviewContinuation(job)) return false;
  if (job?.mode !== 'repair_existing') return true;
  return job?.resumeResult?.rewriteMode === EXISTING_REWRITE_MODE;
}

export async function processStoredJob(env, row, options = {}) {
  const job = normalizeStoredJob(row);
  if (job.status !== 'queued') throw new Error(`JOB_NOT_RUNNABLE:${job.status}`);
  const fetchImpl = options.fetchImpl || fetch;
  const saveState = typeof options.saveState === 'function' ? options.saveState : async () => {};
  const initial = resumesAtCritic(job) ? 'critic_review' : 'writing';
  let current = 'queued';

  if (env?.ORCHESTRATOR_DB) {
    const claimFn = options.claimExecutionFn || claimStoredJobExecution;
    const claimed = await claimFn(env, job.id, initial);
    if (!claimed) throw Object.assign(new Error('JOB_EXECUTION_ALREADY_CLAIMED'), { status: 409 });
    current = initial;
  }

  const transition = async (next, patch = {}) => {
    const normalizedNext = normalizePipelineStage(next);
    if (normalizedNext === current) return;
    assertTransition(current, normalizedNext);
    current = normalizedNext;
    await saveState(normalizedNext, patch);
  };

  try {
    if (current === 'queued') await transition(initial);
    const result = await executeJob(env, job, fetchImpl, {
      onStage: async (stage) => transition(stage)
    });

    if (result.status === 'NO_CHANGE_NEEDED') {
      await transition('ready');
      await transition('completed', { result });
      return { state: current, result };
    }
    if (result.status === 'READY' || result.status === 'READY_TO_UPDATE_EXISTING') {
      await transition('ready', { result });
      return { state: current, result };
    }
    if (result.status === 'NEEDS_REVIEW') {
      await transition('needs_review', { result });
      return { state: current, result };
    }
    throw new Error(`PIPELINE_RESULT_INVALID:${result.status}`);
  } catch (error) {
    if (current !== 'failed') {
      const errorCode = safeFailureCode(error);
      try { await transition('failed', { error: errorCode }); } catch { /* keep original error */ }
    }
    throw error;
  }
}