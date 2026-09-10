import { generatePlannedImages as generateBaseImages, imageExecutionPriority, isResumableImageStatus } from './image-executor.js';
import { listJobImages, markImageProviderRetry } from './image-store.js';
import { puterImageConfigured } from './puter-image-provider.js';

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
  const startedAt = timestampMs(image?.created_at);
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

  // Explicit diagnostic/operator modes still win when no durable async task exists.
  // Production leaves IMAGE_PROVIDER_MODE unset/auto and follows the free/fast chain below.
  const explicit = explicitProviderMode(env);
  if (explicit) return explicit;

  const attempts = asyncAttempts(image);
  const puterAttempted = Number(image?.puter_attempted || 0) === 1;
  if (!puterAttempted && puterImageConfigured(env)) return 'puter';
  if (modelScopeImageEnabled(env) && !modelScopeAlreadyAttempted(image)) return 'modelscope';

  // Cloudflare Workers AI is synchronous and free-first for scheduled production.
  // Try it before creating a paid/slow KIE task. If it cannot produce an acceptable
  // image, runOneImage immediately hands off to the existing bounded KIE retry path.
  return 'cloudflare';
}

function needsImmediateCloudflareFallback(outcome = {}) {
  const error = String(outcome?.error || '').toUpperCase();
  return error.includes('KIE_AUTH_FAILED')
    || error.includes('KIE_INSUFFICIENT_CREDITS')
    || error.includes('KIE_VALIDATION_FAILED')
    || error.includes('KIE_CONTENT_REJECTED');
}

export function imageFallbackFailureCode(primary = {}, fallback = {}) {
  const codes = [primary.error, fallback.error].flatMap(value =>
    String(value || '').match(/\b(?:KIE|CLOUDFLARE|PUTER|MODELSCOPE)_[A-Z0-9_]+\b/g) || []);
  return `IMAGE_FALLBACK_FAILED:${[...new Set(codes)].slice(0, 4).join(':') || 'PROVIDER_ERROR'}`.slice(0, 300);
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

async function recoverStaleKieTask(env, jobId, image, imageOptions) {
  const taskId = String(image?.provider_task_id || '').trim();
  await markImageProviderRetry(env, image.id, `KIE_STALE_TASK_ABANDONED:${taskId}`, {
    countAttempt: false,
    provider: 'kie-ai'
  });

  // Never create a second paid KIE task for a legacy task that already consumed a
  // submission. Prefer Puter when its runtime secret is actually present; otherwise
  // use the free Cloudflare provider so the article can continue.
  const nextMode = puterImageConfigured(env) ? 'puter' : 'cloudflare';
  return generateBaseImages(
    { ...env, IMAGE_PROVIDER_MODE: nextMode },
    jobId,
    imageOptions
  );
}

async function runCloudflareThenKie(env, jobId, image, imageOptions, cloudflareResult = null) {
  const cloudflare = cloudflareResult || await generateBaseImages(
    { ...env, IMAGE_PROVIDER_MODE: 'cloudflare' },
    jobId,
    imageOptions
  );
  const cloudflareOutcome = Array.isArray(cloudflare?.outcomes) ? cloudflare.outcomes[0] : null;
  if (cloudflareOutcome?.status !== 'retrying') return cloudflare;
  // A timed-out KIE create request may already have consumed a paid submission even
  // though no task id reached D1. Do not submit another paid task blindly.
  if (isAmbiguousKieSubmission(image)) {
    const error = imageFallbackFailureCode({ error: 'KIE_SUBMISSION_OUTCOME_UNKNOWN' }, cloudflareOutcome);
    await markImageProviderRetry(env, image.id, error, { countAttempt: false, provider: 'kie-ai' });
    cloudflareOutcome.error = error;
    return cloudflare;
  }

  const current = await refreshedImage(env, jobId, image.id);
  if (isSuccessfulPaidImageCheckpoint(current || image)) return cloudflare;
  if (!kieRetryAvailable(current || image, env)) return cloudflare;

  const kie = await generateBaseImages(
    { ...env, IMAGE_PROVIDER_MODE: 'kie' },
    jobId,
    imageOptions
  );
  const kieOutcome = Array.isArray(kie?.outcomes) ? kie.outcomes[0] : null;
  if (kieOutcome?.status === 'retrying') {
    // Preserve both failure families for diagnostics while keeping the durable KIE
    // retry counter written by the base executor intact.
    const error = imageFallbackFailureCode(cloudflareOutcome, kieOutcome);
    await markImageProviderRetry(env, image.id, error, { countAttempt: false, provider: 'kie-ai' });
    kieOutcome.error = error;
  }
  return kie;
}

async function runOneImage(env, jobId, image, options = {}) {
  const providerMode = scheduledProviderModeForImage(image, env);

  // Credit-safety invariant: once KIE succeeded, never create a replacement image.
  // If the durable task id exists, generateBaseImages will only poll that same task.
  // If it is missing, stop here and preserve the checkpoint for operator/data recovery.
  if (providerMode === 'paid-success-checkpoint') {
    return protectedCheckpointResult(image);
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

  if (providerMode === 'puter' && firstOutcome?.status === 'pending') {
    return first;
  }

  if (providerMode === 'puter' && firstOutcome?.status === 'retrying') {
    const current = await refreshedImage(env, jobId, image.id);
    const attempts = asyncAttempts(current || image);
    if (attempts === 0 && modelScopeImageEnabled(env)) {
      const modelScope = await generateBaseImages(
        { ...env, IMAGE_PROVIDER_MODE: 'modelscope' },
        jobId,
        imageOptions
      );
      const modelScopeOutcome = Array.isArray(modelScope?.outcomes) ? modelScope.outcomes[0] : null;
      if (modelScopeOutcome?.status !== 'retrying') return modelScope;
      return runCloudflareThenKie(env, jobId, current || image, imageOptions);
    }
    return runCloudflareThenKie(env, jobId, current || image, imageOptions);
  }

  if (providerMode === 'modelscope' && firstOutcome?.status === 'retrying') {
    const fallback = await runCloudflareThenKie(env, jobId, image, imageOptions);
    const fallbackOutcome = Array.isArray(fallback?.outcomes) ? fallback.outcomes[0] : null;
    if (fallbackOutcome?.status === 'retrying') {
      const error = imageFallbackFailureCode(firstOutcome, { error: `MODELSCOPE_ATTEMPTED:${fallbackOutcome.error || 'PROVIDER_ERROR'}` });
      await markImageProviderRetry(env, image.id, error, { countAttempt: false, provider: 'modelscope' });
      fallbackOutcome.error = error;
    }
    return fallback;
  }

  if (providerMode === 'cloudflare' && firstOutcome?.status === 'retrying') {
    return runCloudflareThenKie(env, jobId, image, imageOptions, first);
  }

  if (providerMode === 'kie' && firstOutcome?.status === 'pending' && staleKieBeforePoll) {
    // We have just performed a final status query for a KIE task that is already well
    // past the normal generation window. Only retire it if the durable row still says
    // it is active after that query; a success checkpoint must always win instead.
    const current = await refreshedImage(env, jobId, image.id);
    if (isSuccessfulPaidImageCheckpoint(current || image)) return first;
    if (isStaleKieActiveTask(current || image, env)) {
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
    if (needsImmediateCloudflareFallback(firstOutcome) || retryBudgetExhausted) {
      const fallback = await generateBaseImages(
        { ...env, IMAGE_PROVIDER_MODE: 'cloudflare' },
        jobId,
        imageOptions
      );
      const fallbackOutcome = fallback?.outcomes?.[0];
      if (fallbackOutcome?.status === 'retrying') {
        // The fallback writes its own error. Retain the original KIE failure too,
        // so an authentication/credit/input problem is not hidden by a free quota error.
        const error = imageFallbackFailureCode(firstOutcome, fallbackOutcome);
        await markImageProviderRetry(env, image.id, error, { countAttempt: false });
        fallbackOutcome.error = error;
      }
      return fallback;
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
 * - Puter is the free/user-allowance-first provider when configured;
 * - ModelScope Z-Image Turbo remains optional when explicitly enabled;
 * - Cloudflare Workers AI is the synchronous free/fast provider before KIE;
 * - an active async task always resumes on the provider that created it;
 * - a KIE task that remains non-terminal beyond the stale window gets one final poll,
 *   then exits to Puter/Cloudflare without submitting another paid KIE task;
 * - a successful KIE checkpoint is never regenerated or replaced;
 * - Cloudflare failure hands off immediately to the bounded KIE retry path;
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
