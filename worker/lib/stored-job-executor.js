import { executeJob } from './job-runner.js';
import { claimStoredJobExecution } from './job-store.js';
import { appendJobEvent } from './job-events.js';
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

function stageEvent(stage, counters, maxRepairs) {
  if (stage === 'writing') return { eventType: 'writer', stage, message: 'Writer 시작', level: 'info' };
  if (stage === 'candidate_regenerating') return { eventType: 'writer_retry', stage: 'writing', message: 'Writer 후보 재작성 시작', level: 'warn' };
  if (stage === 'critic_review') {
    counters.critic += 1;
    return { eventType: 'critic', stage, message: counters.critic === 1 ? '딴지 1차 검사 시작' : `딴지 재검사 ${counters.critic}회차 시작`, level: 'info', meta: { criticCheck: counters.critic } };
  }
  if (stage === 'final_critic') {
    counters.critic += 1;
    return { eventType: 'critic', stage, message: `최종 딴지 검사 시작 (${counters.critic}회차)`, level: 'info', meta: { criticCheck: counters.critic } };
  }
  if (stage === 'repairing' || stage === 'style_repairing') {
    counters.repair += 1;
    const label = stage === 'style_repairing' ? '문체 부분보완' : '부분보완';
    return {
      eventType: 'repair',
      stage: 'repairing',
      message: `${label} ${counters.repair}/${maxRepairs} 시작`,
      level: 'warn',
      meta: { repairAttempt: counters.repair, maxRepairAttempts: maxRepairs }
    };
  }
  return { eventType: 'stage', stage: normalizePipelineStage(stage), message: `${stage} 단계 시작`, level: 'info' };
}

function resultEvent(result, counters) {
  const critic = result?.finalCritic || result?.initialCritic || null;
  const score = critic?.score ?? critic?.totalScore ?? null;
  const status = String(critic?.status || '');
  const issueCount = Array.isArray(critic?.issues) ? critic.issues.length : 0;
  const scoreText = score === null ? '' : ` · ${score}점`;
  if (result?.status === 'NEEDS_REVIEW') {
    return {
      eventType: 'quality_result', stage: 'final_critic', level: 'warn',
      message: `최종 딴지 ${status || 'FAIL'}${scoreText} · 확인 필요`,
      meta: { status, score, issueCount, repairAttempts: counters.repair }
    };
  }
  return {
    eventType: 'quality_result', stage: 'final_critic', level: 'success',
    message: `최종 딴지 ${status || 'PASS'}${scoreText} · 품질검사 완료`,
    meta: { status, score, issueCount, repairAttempts: counters.repair }
  };
}

export async function processStoredJob(env, row, options = {}) {
  const job = normalizeStoredJob(row);
  if (job.status !== 'queued') throw new Error(`JOB_NOT_RUNNABLE:${job.status}`);
  const fetchImpl = options.fetchImpl || fetch;
  const saveState = typeof options.saveState === 'function' ? options.saveState : async () => {};
  const initial = resumesAtCritic(job) ? 'critic_review' : 'writing';
  const maxRepairs = Math.min(3, Math.max(2, Number.parseInt(String(env?.TARGETED_REPAIR_MAX_ATTEMPTS ?? 2), 10) || 2));
  const counters = { repair: 0, critic: 0 };
  let current = 'queued';

  if (env?.ORCHESTRATOR_DB) {
    const claimFn = options.claimExecutionFn || claimStoredJobExecution;
    const claimed = await claimFn(env, job.id, initial);
    if (!claimed) throw Object.assign(new Error('JOB_EXECUTION_ALREADY_CLAIMED'), { status: 409 });
    current = initial;
    await appendJobEvent(env, job.id, {
      eventType: 'job_start', stage: initial, level: 'info',
      message: `#${job.id} 작업 시작 · ${job.mode === 'repair_existing' ? '기존글 리페어' : '신규 글'}`,
      meta: { mode: job.mode, maxRepairAttempts: maxRepairs }
    });
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
      onStage: async (stage) => {
        await appendJobEvent(env, job.id, stageEvent(stage, counters, maxRepairs));
        return transition(stage);
      }
    });

    await appendJobEvent(env, job.id, resultEvent(result, counters));

    if (result.status === 'NO_CHANGE_NEEDED') {
      await transition('ready');
      await transition('completed', { result });
      await appendJobEvent(env, job.id, { eventType: 'done', stage: 'completed', level: 'success', message: `#${job.id} 완료 · 변경 필요 없음` });
      return { state: current, result };
    }
    if (result.status === 'READY' || result.status === 'READY_TO_UPDATE_EXISTING') {
      await transition('ready', { result });
      await appendJobEvent(env, job.id, {
        eventType: 'article_ready', stage: 'ready', level: 'success',
        message: `본문 준비 완료 · 이미지 단계 대기`,
        meta: { repairAttempts: counters.repair, maxRepairAttempts: maxRepairs }
      });
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
      try {
        await appendJobEvent(env, job.id, {
          eventType: 'error', stage: current, level: 'error',
          message: `작업 오류 · ${errorCode}`,
          meta: { errorCode }
        });
      } catch { /* logging must not hide original failure */ }
    }
    throw error;
  }
}