import { getStoredJob, persistJobTransition } from './job-store.js';
import { processStoredJob } from './stored-job-executor.js';
import { cleanupSupersededLegacyRouteFailures } from './legacy-route-cleanup.js';
import { cleanupReadyDuplicateNewArticles } from './topic-dedupe.js';
import { primeAutomaticJobRescue } from './job-auto-rescue.js';
import { recoverAmbiguousPublications } from './publication-ambiguity-recovery.js';
import { reconcilePendingPublicationReadbacks } from './publication-readback-recovery.js';
import {
  listDueRetryJobs,
  readRecoverySummary,
  registerJobFailure,
  requeueDueRetryJobs,
  safeFailureCode
} from './job-recovery.js';

function positiveLimit(value, fallback = 2) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 20) throw new Error('JOB_RECOVERY_LIMIT_INVALID');
  return number;
}

function settingsByBlog(automation) {
  return new Map((automation?.blogs || []).map((item) => [String(item.blogId), item.effective || {}]));
}

function safeRecoveryView(value) {
  if (!value) return null;
  return {
    recoveryState: value.recoveryState || null,
    retryCount: Number(value.retryCount || 0),
    nextRetryAt: value.nextRetryAt || null,
    holdReason: value.holdReason || null,
    code: value.code || null
  };
}

export async function runDueJobRecoveries(env, options = {}) {
  if (env?.JOB_RECOVERY_EXECUTION_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'JOB_RECOVERY_EXECUTION_DISABLED', attempted: 0, completed: 0, items: [] };
  }

  const now = options.now || new Date();
  const maxItems = positiveLimit(options.maxItems ?? env?.JOB_RECOVERY_MAX_ITEMS, 2);
  const staleMinutes = Number(options.staleMinutes ?? 20);
  const listDueFn = options.listDueFn || listDueRetryJobs;
  const requeueFn = options.requeueFn || requeueDueRetryJobs;
  const processFn = options.processFn || processStoredJob;
  const persistFn = options.persistTransitionFn || persistJobTransition;
  const getJobFn = options.getJobFn || getStoredJob;
  const registerFailureFn = options.registerFailureFn || registerJobFailure;
  const summaryFn = options.summaryFn || readRecoverySummary;
  const cleanupLegacyFn = options.cleanupLegacyFn || cleanupSupersededLegacyRouteFailures;
  const cleanupDuplicateFn = options.cleanupDuplicateFn || cleanupReadyDuplicateNewArticles;
  const autoRescueFn = options.autoRescueFn || primeAutomaticJobRescue;
  const ambiguityRecoveryFn = options.ambiguityRecoveryFn || recoverAmbiguousPublications;
  const readbackRecoveryFn = options.readbackRecoveryFn || reconcilePendingPublicationReadbacks;
  const effectiveByBlog = settingsByBlog(options.automation);

  // Unknown Blogger write outcomes are reconciled first. A confirmed existing post is
  // adopted before exact-ID read-back runs; a confirmed no-match is returned to the
  // ready/publish lane with its final article and attached images untouched.
  const ambiguityRecovery = await ambiguityRecoveryFn(env, {
    now,
    limit: maxItems,
    ...(options.callHubFn ? { callHubFn: options.callHubFn } : {})
  });
  const readbackRecovery = await readbackRecoveryFn(env, {
    limit: maxItems,
    ...(options.callHubFn ? { callHubFn: options.callHubFn } : {})
  });
  const [legacyCleanup, duplicateCleanup, autoRescue] = await Promise.all([
    cleanupLegacyFn(env),
    cleanupDuplicateFn(env),
    env?.ORCHESTRATOR_DB
      ? autoRescueFn(env, { now, limit: 20, staleMinutes })
      : Promise.resolve({ ok: true, checked: 0, revived: 0, retryDue: 0, held: 0, skipped: 0, items: [] })
  ]);
  const due = await listDueFn(env, { now, limit: maxItems });
  const items = [];

  for (const candidate of due.slice(0, maxItems)) {
    const jobId = Number(candidate.id);
    const claim = await requeueFn(env, { now, jobs: [candidate] });
    if (!claim?.jobIds?.includes(jobId)) {
      items.push({ jobId, status: 'skipped', reason: 'RETRY_CLAIM_NOT_ACQUIRED' });
      continue;
    }

    try {
      const stored = env?.ORCHESTRATOR_DB ? await getJobFn(env, jobId) : null;
      const row = { ...candidate, ...(stored || {}), status: 'queued' };
      const outcome = await processFn(env, row, {
        saveState: (state, patch) => persistFn(env, jobId, state, patch),
        fetchImpl: options.fetchImpl
      });

      let images = null;
      if (String(candidate.mode) === 'new_article' && outcome.state === 'ready') {
        const effective = effectiveByBlog.get(String(candidate.blog_id));
        if (!effective) throw new Error('RECOVERY_AUTOMATION_SETTINGS_MISSING');
        images = effective?.imagesEnabled === false
          ? { enabled: false, reason: 'IMAGES_DISABLED' }
          : { enabled: true, deferred: true, reason: 'SCHEDULED_IMAGE_COMPLETION' };
      }

      items.push({ jobId, status: 'completed', jobState: outcome.state, images });
    } catch (error) {
      const errorCode = safeFailureCode(error);
      let recovery = null;
      let registrationError = null;
      try {
        let row = await getJobFn(env, jobId);
        if (String(row?.status || '') === 'ready') {
          await persistFn(env, jobId, 'failed', { error: errorCode });
          row = await getJobFn(env, jobId);
        }
        if (String(row?.status || '') !== 'failed') throw new Error(`JOB_RECOVERY_NOT_FAILED:${row?.status || 'unknown'}`);
        recovery = await registerFailureFn(env, jobId, errorCode, { now });
      } catch (recoveryError) {
        registrationError = safeFailureCode(recoveryError);
      }
      items.push({
        jobId,
        status: recovery?.recoveryState || 'failed',
        errorCode,
        recovery: safeRecoveryView(recovery),
        recoveryRegistrationError: registrationError
      });
    }
  }

  const attentionRequired = items.filter((item) => ['failed', 'held'].includes(item.status)).length
    + Number(readbackRecovery?.failed || 0)
    + Number(ambiguityRecovery?.held || 0);
  return {
    ok: attentionRequired === 0,
    health: attentionRequired > 0 ? 'attention_required' : 'ok',
    attentionRequired,
    enabled: true,
    ambiguityRecovery,
    readbackRecovery,
    legacyCleanup,
    duplicateCleanup,
    autoRescue,
    attempted: items.filter((item) => item.status !== 'skipped').length,
    completed: items.filter((item) => item.status === 'completed').length,
    retryWait: items.filter((item) => item.status === 'retry_wait').length,
    held: items.filter((item) => item.status === 'held').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    items,
    summary: await summaryFn(env)
  };
}
