import { generatePlannedImages as generateBaseImages, imageExecutionPriority, isResumableImageStatus } from './image-executor.js';
import { listJobImages } from './image-store.js';

export function kieGenerationRetryMax(env = {}) {
  const configured = Number(env?.KIE_IMAGE_GENERATION_RETRY_MAX ?? 3);
  if (!Number.isInteger(configured) || configured < 1 || configured > 5) return 3;
  return configured;
}

export function modelScopeImageEnabled(env = {}) {
  return String(env?.MODELSCOPE_IMAGE_ENABLED || 'false').trim().toLowerCase() === 'true';
}

function orderedCandidates(rows = [], retryFailed = true) {
  return rows
    .filter((row) => isResumableImageStatus(row.status, retryFailed))
    .map((row, index) => ({ row, index }))
    .sort((a, b) => imageExecutionPriority(a.row) - imageExecutionPriority(b.row) || a.index - b.index)
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

export function scheduledProviderModeForImage(image = {}, env = {}) {
  const taskId = String(image?.provider_task_id || '').trim();
  const provider = normalizedProvider(image);
  if (taskId) return provider === 'modelscope' ? 'modelscope' : 'kie';

  // A finished/failed ModelScope task gets one immediate handoff to KIE.
  if (provider === 'modelscope') return 'kie';

  const attempts = Math.max(0, Math.trunc(Number(image?.provider_attempt_count || 0) || 0));
  if (attempts === 0 && modelScopeImageEnabled(env)) return 'modelscope';

  // provider_attempt_count is shared across async providers. Reserve one slot for
  // the optional ModelScope attempt, then preserve the configured KIE retry budget.
  const asyncAttemptCeiling = kieGenerationRetryMax(env) + (modelScopeImageEnabled(env) ? 1 : 0);
  return attempts < asyncAttemptCeiling ? 'kie' : 'cloudflare';
}

function needsImmediateCloudflareFallback(outcome = {}) {
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

async function runOneImage(env, jobId, image, options = {}) {
  const providerMode = scheduledProviderModeForImage(image, env);
  const imageOptions = {
    ...options,
    imageIds: [image.id],
    maxImages: 1,
    localFallback: false
  };

  const first = await generateBaseImages(
    { ...env, IMAGE_PROVIDER_MODE: providerMode },
    jobId,
    imageOptions
  );

  const firstOutcome = Array.isArray(first?.outcomes) ? first.outcomes[0] : null;

  if (providerMode === 'modelscope' && firstOutcome?.status === 'retrying') {
    return generateBaseImages(
      { ...env, IMAGE_PROVIDER_MODE: 'kie' },
      jobId,
      imageOptions
    );
  }

  if (providerMode === 'kie' && firstOutcome?.status === 'retrying') {
    const current = await refreshedImage(env, jobId, image.id);
    const retryBudgetExhausted = scheduledProviderModeForImage(current || image, env) === 'cloudflare';
    if (needsImmediateCloudflareFallback(firstOutcome) || retryBudgetExhausted) {
      return generateBaseImages(
        { ...env, IMAGE_PROVIDER_MODE: 'cloudflare' },
        jobId,
        imageOptions
      );
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
 * - ModelScope Z-Image Turbo is the free-first provider when explicitly enabled;
 * - an active async task always resumes on the provider that created it;
 * - ModelScope terminal failure hands off immediately to KIE;
 * - KIE keeps its bounded retry budget, then Cloudflare is the final provider;
 * - once the final KIE retry is persisted, Cloudflare runs in the same invocation;
 * - up to three images for the same post are submitted/polled concurrently;
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
