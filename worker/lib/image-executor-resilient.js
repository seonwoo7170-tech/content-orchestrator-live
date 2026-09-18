import { generatePlannedImages as generateBaseImages, imageExecutionPriority, isResumableImageStatus } from './image-executor.js';
import { listJobImages, markImageFailed, markImageProviderRetry } from './image-store.js';

const ACTIVE_PROVIDER_STATES = new Set(['waiting', 'queuing', 'generating', 'pending', 'processing', 'running', 'query_retry', 'result_pending', 'result_download_retry']);
const EXPLICIT_PROVIDER_MODES = new Set(['puter', 'modelscope', 'cloudflare', 'kie']);

export function kieGenerationRetryMax(env = {}) {
  const configured = Number(env?.KIE_IMAGE_GENERATION_RETRY_MAX ?? 3);
  if (!Number.isInteger(configured) || configured < 1 || configured > 5) return 3;
  return configured;
}

export function kieActiveTaskStaleMs(env = {}) {
  const configured = Number(env?.KIE_ACTIVE_TASK_STALE_MS ?? 30 * 60_000);
  if (!Number.isFinite(configured) || configured < 5 * 60_000 || configured > 6 * 60 * 60_000) return 30 * 60_000;
  return Math.trunc(configured);
}

export function modelScopeImageEnabled(env = {}) {
  return String(env?.MODELSCOPE_IMAGE_ENABLED || 'false').trim().toLowerCase() === 'true';
}

function retryAge(image = {}) {
  const value = timestampMs(image?.provider_checked_at || image?.updated_at || image?.created_at);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

export function orderedCandidates(rows = [], retryFailed = true) {
  return rows
    .filter((row) => isResumableImageStatus(row.status, retryFailed))
    .map((row, index) => ({ row, index }))
    .sort((a, b) => imageExecutionPriority(a.row) - imageExecutionPriority(b.row)
      || retryAge(a.row) - retryAge(b.row)
      || a.index - b.index)
    .map((item) => item.row);
}

function normalizedProvider(image = {}) {
  return String(image?.provider || '').trim().toLowerCase();
}

function batchLimit(value, fallback = 3) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return Math.min(3, number);
}

function timestampMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return NaN;
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

function explicitProviderMode(env = {}) {
  const mode = String(env?.IMAGE_PROVIDER_MODE || '').trim().toLowerCase();
  return EXPLICIT_PROVIDER_MODES.has(mode) ? mode : null;
}

function asyncAttemptCeiling(env = {}) {
  return kieGenerationRetryMax(env) + (modelScopeImageEnabled(env) ? 1 : 0);
}

function asyncAttempts(image = {}) {
  return Math.max(0, Math.trunc(Number(image?.provider_attempt_count || 0) || 0));
}

export function modelScopeAlreadyAttempted(image = {}) {
  const provider = normalizedProvider(image);
  const error = String(image?.provider_error_code || image?.provider_error_message || image?.error || '').toUpperCase();
  return (provider === 'modelscope' && asyncAttempts(image) > 0)
    || error.includes('MODELSCOPE_ATTEMPTED');
}

export function isAmbiguousKieSubmission(image = {}) {
  const provider = normalizedProvider(image);
  const taskId = String(image?.provider_task_id || '').trim();
  const error = String(image?.provider_error_code || image?.provider_error_message || image?.error || '').toUpperCase();
  return ['kie', 'kie-ai'].includes(provider)
    && !taskId
    && asyncAttempts(image) > 0
    && (error.includes('API_HUB_TIMEOUT') || error.includes('KIE_SUBMISSION_OUTCOME_UNKNOWN'));
}

function kieRetryAvailable(image = {}, env = {}) {
  if (isAmbiguousKieSubmission(image)) return false;
  return asyncAttempts(image) < asyncAttemptCeiling(env);
}

export function isStaleKieActiveTask(image = {}, env = {}, nowMs = Date.now()) {
  const provider = normalizedProvider(image);
  const taskId = String(image?.provider_task_id || '').trim();
  const providerStatus = String(image?.provider_status || '').trim().toLowerCase();
  if (!taskId || !['kie', 'kie-ai'].includes(provider) || !ACTIVE_PROVIDER_STATES.has(providerStatus)) return false;
  // job_images rows are created immediately before the image provider stage, so created_at
  // is a conservative lower bound for legacy task age even though old rows predate the
  // provider_task_id columns. A task must still be active after a final poll before this
  // stale guard is allowed to retire it.
  // provider_checked_at is written when a task id is first persisted and on every
  // subsequent poll. An old image row can receive a brand-new KIE task, so created_at
  // is only a legacy fallback when no provider timestamp exists.
  const startedAt = timestampMs(image?.provider_checked_at || image?.created_at);
  if (!Number.isFinite(startedAt)) return false;
  return Math.max(0, Number(nowMs) - startedAt) >= kieActiveTaskStaleMs(env);
}

export function isSuccessfulPaidImageCheckpoint(image = {}) {
  const provider = normalizedProvider(image);
  const status = String(image?.status || '').trim().toLowerCase();
  const providerStatus = String(image?.provider_status || '').trim().toLowerCase();
  return (provider === 'kie' || provider === 'kie-ai')
    && (status === 'generated' || status === 'stored' || status === 'attached')
    && providerStatus === 'success';
}

export function scheduledProviderModeForImage(image = {}, env = {}) {
  const taskId = String(image?.provider_task_id || '').trim();
  const provider = normalizedProvider(image);
  const providerStatus = String(image?.provider_status || '').trim().toLowerCase();
  if (taskId) {
    if (provider === 'puter') return 'puter';
    return provider === 'modelscope' ? 'modelscope' : 'kie';
  }

  if (provider === 'puter' && providerStatus === 'success') return 'puter';

  // Never submit another paid task after KIE has already reported success.
  // A missing taskId here is a recovery/data-integrity problem, not a reason to charge again.
  if (isSuccessfulPaidImageCheckpoint(image)) return 'paid-success-checkpoint';

  // A timed-out KIE create request may already have consumed a paid submission even
  // though no task id reached D1. Never submit another paid task blindly for it.
  if (isAmbiguousKieSubmission(image)) return 'kie-ambiguous-blocked';

  // Explicit diagnostic/operator modes still win when no durable async task exists.
  const explicit = explicitProviderMode(env);
  if (explicit) return explicit;

  // Cloudflare Workers AI hit an account-wide rate limit under normal scheduled load
  // and got stuck retrying forever with no way out; Puter/ModelScope add no value once
  // KIE is the standard path. Every fresh image now goes straight to KIE. In-flight
  // Puter/ModelScope tasks above are still resumed to completion; new ones never start.
  return 'kie';
}

function isFatalKieError(outcome = {}) {
  const error = String(outcome?.error || '').toUpperCase();
  return error.includes('KIE_AUTH_FAILED')
    || error.includes('KIE_INSUFFICIENT_CREDITS')
    || error.includes('KIE_VALIDATION_FAILED')
    || error.includes('KIE_CONTENT_REJECTED');
}

async function refreshedImage(env, jobId, imageId) {
  const rows = await listJobImages(env, jobId);
  return rows.find((row) => Number(row?.id) === Number(imageId)) || null;
}

function protectedCheckpointResult(image) {
  return {
    requested: 1,
    stored: 0,
    pending: 1,
    retrying: 0,
    failed: 0,
    outcomes: [{
      imageId: image.id,
      status: 'pending',
      provider: image.provider || 'kie-ai',
      providerState: 'success_checkpoint',
      taskId: null,
      error: 'KIE_SUCCESS_CHECKPOINT_TASK_ID_MISSING_NO_REGEN'
    }],
    images: [image]
  };
}

async function kieOnlyTerminalFailure(env, image, reason) {
  await markImageFailed(env, image.id, reason);
  return {
    requested: 1,
    stored: 0,
    pending: 0,
    retrying: 0,
    failed: 1,
    outcomes: [{ imageId: image.id, status: 'failed', provider: 'kie-ai', taskId: null, error: reason }],
    images: [{ ...image, status: 'failed', error: reason }]
  };
}

// KIE is the only image provider left in the scheduled pipeline (Cloudflare Workers AI
// and Puter/ModelScope are no longer started fresh; see scheduledProviderModeForImage).
// This is the single place a retrying/stalled KIE attempt escalates to: either a fresh
// KIE submission, or a terminal stop when there is nothing safe left to retry.
async function escalateToKie(env, jobId, image, imageOptions) {
  if (isAmbiguousKieSubmission(image)) {
    return kieOnlyTerminalFailure(env, image, 'KIE_SUBMISSION_OUTCOME_UNKNOWN');
  }

  const current = await refreshedImage(env, jobId, image.id);
  if (isSuccessfulPaidImageCheckpoint(current || image)) {
    return protectedCheckpointResult(current || image);
  }
  if (!kieRetryAvailable(current || image, env)) {
    return kieOnlyTerminalFailure(env, current || image, 'KIE_RETRY_BUDGET_EXHAUSTED');
  }

  return generateBaseImages(
    { ...env, IMAGE_PROVIDER_MODE: 'kie' },
    jobId,
    imageOptions
  );
}

async function recoverStaleKieTask(env, jobId, image, imageOptions) {
  const taskId = String(image?.provider_task_id || '').trim();
  await markImageProviderRetry(env, image.id, `KIE_STALE_TASK_ABANDONED:${taskId}`, {
    countAttempt: false,
    provider: 'kie-ai'
  });

  // KIE is the only provider left, so this submits a fresh KIE task for the abandoned
  // slot. That carries a small risk of double-billing if the orphaned task later turns
  // out to have actually completed; there is no free provider left to divert to instead.
  return generateBaseImages(
    { ...env, IMAGE_PROVIDER_MODE: 'kie' },
    jobId,
    imageOptions
  );
}

async function runOneImage(env, jobId, image, options = {}) {
  const providerMode = scheduledProviderModeForImage(image, env);

  // Credit-safety invariant: once KIE succeeded, never create a replacement image.
  // If the durable task id exists, generateBaseImages will only poll that same task.
  // If it is missing, stop here and preserve the checkpoint for operator/data recovery.
  if (providerMode === 'paid-success-checkpoint') {
    return protectedCheckpointResult(image);
  }

  if (providerMode === 'kie-ambiguous-blocked') {
    return kieOnlyTerminalFailure(env, image, 'KIE_SUBMISSION_OUTCOME_UNKNOWN');
  }

  const imageOptions = {
    ...options,
    imageIds: [image.id],
    maxImages: 1,
    localFallback: false
  };

  const staleKieBeforePoll = providerMode === 'kie' && isStaleKieActiveTask(image, env);
  const first = await generateBaseImages(
    { ...env, IMAGE_PROVIDER_MODE: providerMode },
    jobId,
    imageOptions
  );

  const firstOutcome = Array.isArray(first?.outcomes) ? first.outcomes[0] : null;

  // These three only ever fire for a legacy Puter/ModelScope/Cloudflare task that was
  // already in flight before the pipeline moved to KIE-only; nothing starts fresh on
  // these providers anymore (see scheduledProviderModeForImage).
  if (providerMode === 'puter' && firstOutcome?.status === 'pending') {
    return first;
  }

  if (providerMode === 'puter' && firstOutcome?.status === 'retrying') {
    const current = await refreshedImage(env, jobId, image.id);
    return escalateToKie(env, jobId, current || image, imageOptions);
  }

  if (providerMode === 'modelscope' && firstOutcome?.status === 'retrying') {
    return escalateToKie(env, jobId, image, imageOptions);
  }

  if (providerMode === 'cloudflare' && firstOutcome?.status === 'retrying') {
    return escalateToKie(env, jobId, image, imageOptions);
  }

  if (providerMode === 'kie' && firstOutcome?.status === 'pending' && staleKieBeforePoll) {
    // We have just performed a final status query for a KIE task that is already well
    // past the normal generation window. Only retire it if the durable row still says
    // it is active after that query; a success checkpoint must always win instead.
    const current = await refreshedImage(env, jobId, image.id);
    if (isSuccessfulPaidImageCheckpoint(current || image)) return first;
    const refreshed = current || image;
    const stillActive = String(refreshed?.provider_task_id || '').trim() === String(image?.provider_task_id || '').trim()
      && ['kie', 'kie-ai'].includes(normalizedProvider(refreshed))
      && ACTIVE_PROVIDER_STATES.has(String(refreshed?.provider_status || '').trim().toLowerCase());
    if (stillActive) {
      return recoverStaleKieTask(env, jobId, current || image, imageOptions);
    }
  }

  if (providerMode === 'kie' && firstOutcome?.status === 'retrying') {
    const current = await refreshedImage(env, jobId, image.id);

    // If the KIE task actually reached success during this invocation, never fall
    // through into another generation provider. Resume/store/attach that exact image.
    if (isSuccessfulPaidImageCheckpoint(current || image)) {
      const taskId = String((current || image)?.provider_task_id || '').trim();
      if (!taskId) return protectedCheckpointResult(current || image);
      return first;
    }

    const retryBudgetExhausted = !kieRetryAvailable(current || image, env);
    if (isFatalKieError(firstOutcome) || retryBudgetExhausted) {
      // KIE-only pipeline: nothing left to hand off to. A fatal KIE error (auth/
      // credits/validation/content) or an exhausted retry budget stops here instead
      // of looping forever against a provider that will never succeed for this image.
      const reason = retryBudgetExhausted ? 'KIE_RETRY_BUDGET_EXHAUSTED' : String(firstOutcome?.error || 'KIE_FATAL_ERROR');
      return kieOnlyTerminalFailure(env, current || image, reason);
    }
  }

  return first;
}

function combineExecutionResults(results = [], images = []) {
  const outcomes = results.flatMap((result) => Array.isArray(result?.outcomes) ? result.outcomes : []);
  return {
    requested: results.reduce((sum, result) => sum + Number(result?.requested || 0), 0),
    stored: outcomes.filter((item) => item.status === 'stored').length,
    pending: outcomes.filter((item) => item.status === 'pending').length,
    retrying: outcomes.filter((item) => item.status === 'retrying').length,
    failed: results.reduce((sum, result) => sum + Number(result?.failed || 0), 0),
    outcomes,
    images
  };
}

/**
 * Scheduled publishing policy:
 * - KIE is the only provider a fresh image ever starts on (Cloudflare Workers AI hit an
 *   account-wide rate limit with no way out; Puter/ModelScope add no value once KIE is
 *   the standard path);
 * - an active async task always resumes on the provider that created it, so an in-flight
 *   Puter/ModelScope/Cloudflare task from before this policy is still finished, not abandoned;
 * - a KIE task that remains non-terminal beyond the stale window gets one final poll, then
 *   a fresh KIE submission for that slot (never a second paid task while the original still
 *   might complete);
 * - a successful KIE checkpoint is never regenerated or replaced;
 * - a fatal KIE error (auth/credits/validation/content) or an exhausted KIE retry budget
 *   stops that image as failed instead of retrying forever;
 * - explicit operator provider modes remain respected;
 * - up to three images for the same post may be selected, while the scheduled watchdog can cap this to one;
 * - provider-chain failure stays retryable/planned;
 * - the local renderer is never enabled here.
 */
export async function generatePlannedImages(env, jobId, options = {}) {
  const retryFailed = options.retryFailed !== false;
  const rows = await listJobImages(env, jobId);
  const maxImages = batchLimit(options.maxImages, 3);
  const images = orderedCandidates(rows, retryFailed).slice(0, maxImages);

  if (images.length === 0) {
    return generateBaseImages(env, jobId, { ...options, maxImages, localFallback: false });
  }

  const results = await Promise.all(images.map((image) => runOneImage(env, jobId, image, options)));
  const finalRows = await listJobImages(env, jobId);
  return combineExecutionResults(results, finalRows);
}
