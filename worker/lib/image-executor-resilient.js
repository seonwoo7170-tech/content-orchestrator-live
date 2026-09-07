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

/**
 * Scheduled publishing policy:
 * - ModelScope Z-Image Turbo is the free-first provider when explicitly enabled;
 * - an active async task always resumes on the provider that created it;
 * - ModelScope terminal failure hands off immediately to KIE;
 * - KIE keeps its bounded retry budget, then Cloudflare is the final provider;
 * - provider-chain failure stays retryable/planned;
 * - the local renderer is never enabled here.
 */
export async function generatePlannedImages(env, jobId, options = {}) {
  const retryFailed = options.retryFailed !== false;
  const rows = await listJobImages(env, jobId);
  const image = orderedCandidates(rows, retryFailed)[0] || null;
  if (!image) return generateBaseImages(env, jobId, { ...options, maxImages: 1, localFallback: false });

  const providerMode = scheduledProviderModeForImage(image, env);
  const first = await generateBaseImages(
    { ...env, IMAGE_PROVIDER_MODE: providerMode },
    jobId,
    { ...options, maxImages: 1, localFallback: false }
  );

  const firstOutcome = Array.isArray(first?.outcomes) ? first.outcomes[0] : null;

  if (providerMode === 'modelscope' && firstOutcome?.status === 'retrying') {
    return generateBaseImages(
      { ...env, IMAGE_PROVIDER_MODE: 'kie' },
      jobId,
      { ...options, maxImages: 1, localFallback: false }
    );
  }

  if (providerMode === 'kie' && firstOutcome?.status === 'retrying' && needsImmediateCloudflareFallback(firstOutcome)) {
    return generateBaseImages(
      { ...env, IMAGE_PROVIDER_MODE: 'cloudflare' },
      jobId,
      { ...options, maxImages: 1, localFallback: false }
    );
  }

  return first;
}
