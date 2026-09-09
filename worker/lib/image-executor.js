import { callHub } from './api-hub.js';
import {
  listJobImages,
  markImageGenerated,
  markImageProviderPending,
  markImageProviderProgress,
  markImageProviderRetry,
  markImageStored
} from './image-store.js';
import { generateLocalFallbackImage } from './local-image-fallback.js';
import { postprocessThumbnail } from './thumbnail-postprocess.js';

const IMAGE_PROVIDER_MODES = new Set(['auto', 'cloudflare', 'kie', 'modelscope']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireBucket(env, bucketOverride) {
  const bucket = bucketOverride || env?.IMAGE_BUCKET;
  if (!bucket || typeof bucket.put !== 'function') throw new Error('IMAGE_BUCKET_NOT_BOUND');
  return bucket;
}

function publicBaseUrl(env) {
  const value = String(env?.IMAGE_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(value)) throw new Error('IMAGE_PUBLIC_BASE_URL_REQUIRED');
  return value;
}

function decodeBase64(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('IMAGE_BASE64_REQUIRED');
  try {
    const binary = atob(text);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new Error('IMAGE_BASE64_INVALID');
  }
}

function sourceImageMimeType(value) {
  const mimeType = String(value || 'image/jpeg').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new Error('IMAGE_MIME_TYPE_UNSUPPORTED');
  return mimeType;
}

export function imageExtensionForMimeType(mimeType) {
  const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  return 'jpg';
}

export function imageStorageKey(jobId, image, mimeType = 'image/jpeg') {
  const role = image.role === 'thumbnail' ? 'thumbnail' : 'body';
  const extension = imageExtensionForMimeType(mimeType);
  return `jobs/${Number(jobId)}/${role}-${Number(image.position)}.${extension}`;
}

function kieRecoveryLevelForImage(image = {}) {
  const taskExists = Boolean(String(image?.provider_task_id || '').trim());
  const storedAttempts = Number(image?.provider_attempt_count || 0);
  const attempts = Math.max(Number.isFinite(storedAttempts) ? Math.trunc(storedAttempts) : 0, taskExists ? 1 : 0);
  return attempts >= 2 ? 3 : 2;
}

function isComputerTechPrompt(prompt) {
  return /(?:\bpc\b|컴퓨터|윈도우|windows|노트북|laptop|desktop|블루스크린|blue\s*screen|작업\s*관리자|task\s*manager|렉\s*걸림|버벅|느려|slow\s*(?:pc|computer)|\bcpu\b|\bgpu\b|\bram\b|메모리|드라이버|driver)/i.test(String(prompt || ''));
}

export function retryPromptForImage(image) {
  const prompt = String(image?.prompt || '').trim();
  const error = String(image?.error || image?.provider_error_message || image?.provider_error_code || '');
  if (!prompt || !/IMAGE_QA_REJECTED/i.test(error)) return prompt;

  const recoveryLevel = kieRecoveryLevelForImage(image);
  const recoveryMarker = `KIE_RECOVERY_LEVEL_${recoveryLevel}.`;
  const monitorTopic = /(모니터|화면\s*깜빡|monitor|display|screen\s*flicker)/i.test(prompt);
  const cableTopic = /(케이블|물리적\s*연결|연결\s*상태|cable|connector|connection|port)/i.test(prompt);

  if (isComputerTechPrompt(prompt)) {
    if (recoveryLevel >= 3) {
      return `${prompt} ${recoveryMarker} Recovery visual rule: use an extreme tight close-up of a single plain black computer cooling fan housing inside a smooth unbranded metal desktop case with one sleeved cable and only fingertips or one simple tool visible. Keep monitors, keyboards, circuit boards, stickers, labels, packaging, documents, and decorative electronics completely out of frame. Use only broad unlabeled unmarked surfaces. No visible text, letters, numbers, logos, icons, UI, signs, or watermarks.`;
    }
    return `${prompt} ${recoveryMarker} Recovery visual rule: show an open unbranded desktop computer case on a clean workbench with a person's hands checking one plain cooling fan and one sleeved cable connection. Keep every monitor and keyboard out of frame, minimize exposed circuit boards, and use only unlabeled unmarked components. No visible text, letters, numbers, logos, icons, UI, packaging, documents, signs, or watermarks.`;
  }

  if (monitorTopic && cableTopic) {
    return `${prompt} ${recoveryMarker} Recovery visual rule: show only the rear or lower edge of one monitor and one plain unbranded cable connection. Keep the screen out of frame or fully blank. Use unlabeled, unmarked connectors and surfaces. No visible text, letters, numbers, logos, icons, UI, packaging, documents, signs, or watermarks.`;
  }
  if (monitorTopic) {
    return `${prompt} ${recoveryMarker} Recovery visual rule: show one monitor with a completely blank uniform dark screen and a simple visible cable, with no UI or text-bearing objects nearby. Use plain unbranded, unlabeled, unmarked surfaces. No visible text, letters, numbers, logos, icons, UI, packaging, documents, signs, or watermarks.`;
  }
  return `${prompt} ${recoveryMarker} Recovery visual rule: remove text-bearing props and use only plain unbranded, unlabeled, unmarked physical surfaces. No visible text, letters, numbers, logos, icons, UI, packaging, documents, signs, or watermarks.`;
}

export function imageStagePacingMs(env = {}) {
  const configured = Number(env?.IMAGE_STAGE_PACING_MS ?? 0);
  if (!Number.isFinite(configured) || configured <= 0) return 0;
  return Math.max(3000, Math.min(5000, Math.trunc(configured)));
}

export function kieQaRetryMax(env = {}) {
  const configured = Number(env?.KIE_IMAGE_QA_RETRY_MAX ?? 3);
  if (!Number.isInteger(configured) || configured < 1 || configured > 4) return 3;
  return configured;
}

export function kieQaRetryCooldownMs(env = {}) {
  const configured = Number(env?.SERIAL_IMAGE_COOLDOWN_MS ?? 0);
  if (!Number.isInteger(configured) || configured < 0 || configured > 30_000) return 0;
  return configured;
}

export function shouldRestartKieAfterQa(image, error, env = {}) {
  if (!/IMAGE_QA_REJECTED/i.test(String(error?.message || error || ''))) return false;
  const taskExists = Boolean(String(image?.provider_task_id || '').trim());
  const storedAttempts = Number(image?.provider_attempt_count || 0);
  const attempts = Math.max(Number.isFinite(storedAttempts) ? storedAttempts : 0, taskExists ? 1 : 0);
  return attempts < kieQaRetryMax(env);
}

export function imageProviderMode(env = {}) {
  const explicit = String(env?.IMAGE_PROVIDER_MODE || '').trim().toLowerCase();
  if (explicit) {
    if (!IMAGE_PROVIDER_MODES.has(explicit)) throw new Error('IMAGE_PROVIDER_MODE_INVALID');
    return explicit;
  }

  // The resilient scheduled wrapper chooses free-first production ordering.
  // The deterministic local renderer is diagnostics-only and requires explicit opt-in.
  return 'auto';
}

export function imageProviderSequence(providerMode = 'auto') {
  const mode = String(providerMode || 'auto').trim().toLowerCase();
  if (!IMAGE_PROVIDER_MODES.has(mode)) throw new Error('IMAGE_PROVIDER_MODE_INVALID');
  if (mode === 'auto') return ['kie', 'cloudflare'];
  return [mode];
}

async function callImageProvider(env, image, prompt, providerMode, callHubFn) {
  const payload = {
    role: image.role,
    prompt,
    providerMode
  };
  if ((providerMode === 'kie' || providerMode === 'modelscope') && String(image?.provider_task_id || '').trim()) {
    payload.taskId = String(image.provider_task_id).trim();
  }
  return callHubFn(env, env.HUB_IMAGE_GENERATE_PATH || '/api/hub/image/generate', payload);
}

async function restartKieAfterQa(env, image, callHubFn) {
  const cooldownMs = kieQaRetryCooldownMs(env);
  if (cooldownMs > 0) await sleep(cooldownMs);
  const retryImage = {
    ...image,
    provider_task_id: null,
    error: 'IMAGE_QA_REJECTED'
  };
  const prompt = retryPromptForImage(retryImage);
  return callImageProvider(env, retryImage, prompt, 'kie', callHubFn);
}

async function generateSourceImage(env, image, options, callHubFn) {
  const prompt = retryPromptForImage(image);
  const providerMode = imageProviderMode(env);
  const providers = imageProviderSequence(providerMode);
  const pacingMs = imageStagePacingMs(env);
  let firstError = null;
  let lastError = null;

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    if (index > 0 && pacingMs > 0) await sleep(pacingMs);
    try {
      const generated = await callImageProvider(env, image, prompt, provider, callHubFn);
      if (generated?.pending === true || generated?.complete === false) return generated;
      if (index === 0) return generated;
      return {
        ...generated,
        fallbackFrom: providers[0] === 'kie' ? 'kie-ai' : providers[0],
        fallbackReason: String(firstError?.message || 'PRIMARY_IMAGE_FAILED')
      };
    } catch (error) {
      // A transport/QA-service/storage failure does not mean the paid task failed.
      // Keep polling that task instead of generating another image or falling back.
      if (shouldPreserveImageTask(image, error)) throw error;
      if (provider === 'kie' && shouldRestartKieAfterQa(image, error, env)) {
        try {
          const regenerated = await restartKieAfterQa(env, image, callHubFn);
          if (regenerated?.pending === true || regenerated?.complete === false) return regenerated;
          return regenerated;
        } catch (retryError) {
          if (!firstError) firstError = error;
          lastError = retryError;
          continue;
        }
      }
      if (!firstError) firstError = error;
      lastError = error;
    }
  }

  if (options.localFallback !== true) {
    const error = new Error(`IMAGE_PROVIDER_CHAIN_RETRY:${String(firstError?.message || 'PRIMARY_IMAGE_FAILED')}:${String(lastError?.message || 'SECONDARY_IMAGE_FAILED')}`);
    error.cause = lastError || firstError;
    throw error;
  }

  try {
    const local = await generateLocalFallbackImage(prompt, image.role, {
      imageResponse: options.localImageResponse
    });
    return {
      ...local,
      fallbackFrom: providers.join('->'),
      fallbackReason: String(lastError?.message || firstError?.message || 'PRIMARY_IMAGE_FAILED')
    };
  } catch (localError) {
    const error = new Error(`IMAGE_PROVIDER_CHAIN_RETRY:${String(firstError?.message || 'PRIMARY_IMAGE_FAILED')}:${String(lastError?.message || 'SECONDARY_IMAGE_FAILED')}:${String(localError?.message || 'LOCAL_IMAGE_FAILED')}`);
    error.cause = localError;
    throw error;
  }
}

function positiveLimit(value, fallback = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error('IMAGE_EXECUTION_LIMIT_INVALID');
  return number;
}

async function storeImageBytes(env, bucket, baseUrl, jobId, image, bytes, mimeType, generated, metadata = {}) {
  const key = imageStorageKey(jobId, image, mimeType);
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: {
      jobId: String(jobId),
      imageId: String(image.id),
      role: String(image.role),
      position: String(image.position),
      provider: String(generated?.provider || ''),
      model: String(generated?.model || ''),
      sourceMimeType: String(metadata.sourceMimeType || mimeType),
      postprocessed: String(metadata.postprocessed || 'none'),
      hookText: String(metadata.hookText || '')
    }
  });
  const url = `${baseUrl}/media/${key}`;
  await markImageStored(env, image.id, { storageKey: key, publicUrl: url, mimeType });
  return { key, url };
}

async function preserveRejectedPreview(env, bucket, baseUrl, jobId, image, error) {
  const data = error?.rejectedImageData || error?.data || null;
  const url = String(data?.rejectedImageUrl || '').trim();
  if (!/^https:\/\//i.test(url)) return null;
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 12 * 1024 * 1024) return null;
  const mimeType = sourceImageMimeType(response.headers.get('content-type') || data?.rejectedImageMimeType || 'image/jpeg');
  const generated = { provider: 'kie-ai', model: String(data?.rejectedModel || 'z-image'), mimeType };
  await markImageGenerated(env, image.id, generated);
  const stored = await storeImageBytes(env, bucket, baseUrl, jobId, image, bytes, mimeType, generated, { sourceMimeType: mimeType, postprocessed: 'qa-rejected-preview' });
  return stored.url;
}

export function isResumableImageStatus(status, retryFailed = true) {
  const value = String(status || '');
  return value === 'planned'
    || value === 'generating'
    || value === 'generated'
    || (retryFailed && value === 'failed');
}

const ACTIVE_PROVIDER_STATES = new Set(['waiting', 'queuing', 'generating', 'pending', 'processing', 'running', 'query_retry', 'result_pending', 'result_download_retry']);

export function shouldPreserveImageTask(image, error) {
  if (!String(image?.provider_task_id || '').trim()) return false;
  const message = String(error?.message || error || '');
  // Only explicit terminal provider outcomes or a genuine QA rejection retire a task.
  return !/(?:KIE_(?:TASK_TIMEOUT|IMAGE_GENERATION_FAILED|PROVIDER_GENERATION_FAILED|CONTENT_REJECTED|AUTH_FAILED|INSUFFICIENT_CREDITS|VALIDATION_FAILED)|MODELSCOPE_(?:IMAGE_GENERATION_FAILED|TASK_FAILED|TASK_TIMEOUT|AUTH_FAILED)|IMAGE_QA_REJECTED)/i.test(message);
}

export function imageExecutionPriority(image = {}) {
  const status = String(image?.status || '');
  const providerState = String(image?.provider_status || '').trim().toLowerCase();
  const active = Boolean(String(image?.provider_task_id || '').trim()) && ACTIVE_PROVIDER_STATES.has(providerState);
  if (active) return 0;
  if (status === 'planned' && Number(image?.provider_attempt_count || 0) === 0) return 1;
  if (status === 'generated') return 2;
  if (status === 'planned') return 3;
  if (status === 'failed') return 4;
  return 5;
}

function orderedImageCandidates(rows = [], retryFailed = true) {
  return rows.filter((row) => isResumableImageStatus(row.status, retryFailed)).map((row, index) => ({ row, index })).sort((a, b) => imageExecutionPriority(a.row) - imageExecutionPriority(b.row) || a.index - b.index).map((item) => item.row);
}

export async function generatePlannedImages(env, jobId, options = {}) {
  const callHubFn = options.callHubFn || callHub;
  const bucket = requireBucket(env, options.bucket);
  const baseUrl = publicBaseUrl(env);
  const retryFailed = options.retryFailed !== false;
  const maxImages = positiveLimit(options.maxImages);
  const rows = await listJobImages(env, jobId);
  const candidates = orderedImageCandidates(rows, retryFailed).slice(0, maxImages);
  const outcomes = [];
  const pacingMs = imageStagePacingMs(env);

  for (let index = 0; index < candidates.length; index += 1) {
    const image = candidates[index];
    if (index > 0 && pacingMs > 0) await sleep(pacingMs);
    try {
      const generated = await generateSourceImage(env, image, options, callHubFn);
      if (generated?.pending === true || generated?.complete === false) {
        const taskId = String(generated?.taskId || image?.provider_task_id || '').trim();
        if (!taskId) throw new Error('IMAGE_PROVIDER_TASK_ID_MISSING');
        const previousTaskId = String(image?.provider_task_id || '').trim();
        if (previousTaskId && previousTaskId === taskId) {
          await markImageProviderProgress(env, image.id, { state: generated?.state || 'generating' });
        } else {
          await markImageProviderPending(env, image.id, {
            provider: generated?.provider || 'kie-ai',
            model: generated?.model || 'z-image',
            taskId,
            state: generated?.state || 'waiting'
          });
        }
        outcomes.push({
          imageId: image.id,
          status: 'pending',
          provider: generated?.provider || 'kie-ai',
          model: generated?.model || 'z-image',
          taskId,
          providerState: generated?.state || 'generating'
        });
        continue;
      }

      const sourceMimeType = sourceImageMimeType(generated.mimeType);
      const sourceBytes = decodeBase64(generated.imageBase64);
      await markImageGenerated(env, image.id, { ...generated, mimeType: sourceMimeType });

      const raw = await storeImageBytes(env, bucket, baseUrl, jobId, image, sourceBytes, sourceMimeType, generated, {
        sourceMimeType,
        postprocessed: 'source-checkpoint'
      });

      let finalMimeType = sourceMimeType;
      let finalUrl = raw.url;
      let hookText = null;
      let postprocessed = false;
      let postprocessFallback = false;

      if (image.role === 'thumbnail') {
        try {
          const processed = await postprocessThumbnail(
            image,
            { ...generated, mimeType: sourceMimeType },
            {
              executionContext: options.executionContext,
              imageResponse: options.imageResponse,
              fontClass: options.fontClass
            }
          );
          const stored = await storeImageBytes(env, bucket, baseUrl, jobId, image, processed.bytes, processed.mimeType, generated, {
            sourceMimeType,
            postprocessed: 'thumbnail-hook-png',
            hookText: processed.hookText || ''
          });
          finalMimeType = processed.mimeType;
          finalUrl = stored.url;
          hookText = processed.hookText;
          postprocessed = true;
        } catch {
          postprocessFallback = true;
        }
      }

      outcomes.push({
        imageId: image.id,
        status: 'stored',
        publicUrl: finalUrl,
        provider: generated.provider,
        model: generated.model,
        mimeType: finalMimeType,
        sourceMimeType,
        postprocessed,
        postprocessFallback,
        hookText,
        fallbackFrom: generated.fallbackFrom || null,
        fallbackReason: generated.fallbackReason || null
      });
    } catch (error) {
      if (shouldPreserveImageTask(image, error)) {
        await markImageProviderProgress(env, image.id, { state: 'query_retry' });
        outcomes.push({ imageId: image.id, status: 'pending', taskId: image.provider_task_id,
          provider: image.provider || 'kie-ai', providerState: 'query_retry',
          error: String(error?.message || 'IMAGE_TASK_RESUME_RETRY') });
        continue;
      }
      const rejectedPreviewUrl = await preserveRejectedPreview(env, bucket, baseUrl, jobId, image, error).catch(() => null);
      const mode = imageProviderMode(env);
      const countAttempt = !String(image?.provider_task_id || '').trim() && mode !== 'cloudflare';
      await markImageProviderRetry(env, image.id, error?.message || 'IMAGE_GENERATION_RETRY', {
        countAttempt,
        provider: countAttempt ? (mode === 'modelscope' ? 'modelscope' : 'kie-ai') : null
      });
      outcomes.push({ imageId: image.id, status: 'retrying', error: String(error?.message || 'IMAGE_GENERATION_RETRY'), rejectedPreviewUrl });
    }
  }

  const finalRows = await listJobImages(env, jobId);
  return {
    requested: candidates.length,
    stored: outcomes.filter((item) => item.status === 'stored').length,
    pending: outcomes.filter((item) => item.status === 'pending').length,
    retrying: outcomes.filter((item) => item.status === 'retrying').length,
    failed: 0,
    outcomes,
    images: finalRows
  };
}
