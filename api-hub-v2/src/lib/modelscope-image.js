const DEFAULT_MODELSCOPE_BASE_URL = 'https://api-inference.modelscope.ai';
const DEFAULT_MODELSCOPE_MODEL = 'Tongyi-MAI/Z-Image-Turbo';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DEFAULT_RESULT_DOWNLOAD_RETRY_MAX = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredToken(env = {}) {
  const token = String(env?.MODELSCOPE_TOKEN || '').trim();
  if (!token) throw Object.assign(new Error('MODELSCOPE_TOKEN_REQUIRED'), { status: 503 });
  return token;
}

function safeBaseUrl(env = {}) {
  const raw = String(env?.MODELSCOPE_API_BASE_URL || DEFAULT_MODELSCOPE_BASE_URL).trim();
  let url;
  try { url = new URL(raw); } catch {
    throw Object.assign(new Error('MODELSCOPE_API_BASE_URL_INVALID'), { status: 500 });
  }
  if (url.protocol !== 'https:' || url.hostname !== 'api-inference.modelscope.ai') {
    throw Object.assign(new Error('MODELSCOPE_API_BASE_URL_NOT_ALLOWED'), { status: 500 });
  }
  return url.origin;
}

export function modelScopeModel(env = {}) {
  const model = String(env?.MODELSCOPE_IMAGE_MODEL || DEFAULT_MODELSCOPE_MODEL).trim();
  if (model !== DEFAULT_MODELSCOPE_MODEL) {
    throw Object.assign(new Error('MODELSCOPE_IMAGE_MODEL_NOT_ALLOWED'), { status: 500 });
  }
  return model;
}

export function modelScopeConfigured(env = {}) {
  return Boolean(String(env?.MODELSCOPE_TOKEN || '').trim());
}

export function modelScopeSize(aspectRatio, role = 'body') {
  const ratio = String(aspectRatio || '').trim();
  if (ratio === '16:9') return '1024x576';
  if (ratio === '9:16') return '576x1024';
  if (ratio === '3:4') return '768x1024';
  if (ratio === '1:1') return '1024x1024';
  if (ratio === '4:3') return '1024x768';
  return role === 'thumbnail' ? '1024x576' : '1024x768';
}

function downloadRetryMax(env = {}) {
  const configured = Number(env?.MODELSCOPE_IMAGE_RESULT_DOWNLOAD_RETRY_MAX ?? DEFAULT_RESULT_DOWNLOAD_RETRY_MAX);
  if (!Number.isInteger(configured) || configured < 1 || configured > 5) return DEFAULT_RESULT_DOWNLOAD_RETRY_MAX;
  return configured;
}

function responseError(status, payload) {
  const text = JSON.stringify(payload || {}).toLowerCase();
  let message = 'MODELSCOPE_REQUEST_FAILED';
  let safeStatus = 502;
  if (status === 401 || status === 403) {
    message = 'MODELSCOPE_AUTH_FAILED';
    safeStatus = 401;
  } else if (status === 429 || /quota|rate.?limit|too many|magicube|balance|credit|limit exceeded/.test(text)) {
    message = 'MODELSCOPE_RATE_LIMITED';
    safeStatus = 429;
  } else if (status === 400 || status === 422) {
    message = 'MODELSCOPE_VALIDATION_FAILED';
    safeStatus = 422;
  } else if (status >= 500) {
    message = 'MODELSCOPE_PROVIDER_ERROR';
  }
  return Object.assign(new Error(message), { status: safeStatus, providerHttpStatus: Number(status || 0) });
}

async function jsonRequest(fetchImpl, url, init = {}) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw Object.assign(new Error('MODELSCOPE_NETWORK_ERROR'), { status: 502 });
  }

  let payload = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw responseError(response.status, payload);
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('MODELSCOPE_RESPONSE_INVALID'), { status: 502 });
  }
  return payload;
}

function resultUrl(payload) {
  const urls = Array.isArray(payload?.output_images) ? payload.output_images : [];
  const value = String(urls[0] || '').trim();
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { return ''; }
  return url.protocol === 'https:' ? url.href : '';
}

function classifyMimeType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  if (['image/jpeg', 'image/png', 'image/webp'].includes(type)) return type;
  return 'image/jpeg';
}

function looksLikeImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return false;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const webp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  return jpeg || png || webp;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function downloadResult(env, url, fetchImpl) {
  const attempts = downloadRetryMax(env);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        headers: {
          accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'user-agent': 'Mozilla/5.0 (compatible; SmileseonModelScopeFetcher/1.0)'
        }
      });
      if (!response.ok) {
        lastError = Object.assign(new Error('MODELSCOPE_RESULT_DOWNLOAD_FAILED'), {
          status: 502,
          providerHttpStatus: Number(response.status || 0)
        });
      } else {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !looksLikeImage(bytes)) {
          throw Object.assign(new Error('MODELSCOPE_RESULT_IMAGE_INVALID'), { status: 502 });
        }
        return {
          mimeType: classifyMimeType(response.headers?.get?.('content-type')),
          imageBase64: bytesToBase64(bytes)
        };
      }
    } catch (error) {
      if (String(error?.message || '') === 'MODELSCOPE_RESULT_IMAGE_INVALID') throw error;
      lastError = error?.status ? error : Object.assign(new Error('MODELSCOPE_RESULT_DOWNLOAD_FAILED'), { status: 502 });
    }
    if (attempt < attempts) await sleep(1000 * (2 ** (attempt - 1)));
  }
  throw lastError || Object.assign(new Error('MODELSCOPE_RESULT_DOWNLOAD_FAILED'), { status: 502 });
}

export async function startModelScopeImageTask(env, { role, prompt, aspectRatio }, fetchImpl = fetch) {
  const token = requiredToken(env);
  const baseUrl = safeBaseUrl(env);
  const model = modelScopeModel(env);
  const payload = await jsonRequest(fetchImpl, `${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'X-ModelScope-Async-Mode': 'true'
    },
    body: JSON.stringify({
      model,
      prompt: String(prompt || '').trim(),
      size: modelScopeSize(aspectRatio, role)
    })
  });
  const taskId = String(payload?.task_id || '').trim();
  if (!taskId) throw Object.assign(new Error('MODELSCOPE_TASK_ID_MISSING'), { status: 502 });
  return {
    ok: true,
    provider: 'modelscope',
    model,
    taskId,
    state: 'pending',
    pending: true,
    complete: false
  };
}

export async function pollModelScopeImageTask(env, taskId, fetchImpl = fetch) {
  const token = requiredToken(env);
  const baseUrl = safeBaseUrl(env);
  const model = modelScopeModel(env);
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) throw Object.assign(new Error('MODELSCOPE_TASK_ID_REQUIRED'), { status: 400 });

  const payload = await jsonRequest(
    fetchImpl,
    `${baseUrl}/v1/tasks/${encodeURIComponent(normalizedTaskId)}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'X-ModelScope-Task-Type': 'image_generation'
      }
    }
  );

  const rawState = String(payload?.task_status || '').trim().toUpperCase();
  if (!rawState) throw Object.assign(new Error('MODELSCOPE_TASK_STATUS_MISSING'), { status: 502 });
  if (rawState === 'FAILED') {
    throw Object.assign(new Error('MODELSCOPE_IMAGE_GENERATION_FAILED'), { status: 502 });
  }
  if (rawState !== 'SUCCEED') {
    return {
      ok: true,
      provider: 'modelscope',
      model,
      taskId: normalizedTaskId,
      state: rawState.toLowerCase(),
      pending: true,
      complete: false
    };
  }

  const sourceUrl = resultUrl(payload);
  if (!sourceUrl) throw Object.assign(new Error('MODELSCOPE_RESULT_URL_MISSING'), { status: 502 });
  const downloaded = await downloadResult(env, sourceUrl, fetchImpl);
  return {
    ok: true,
    provider: 'modelscope',
    model,
    taskId: normalizedTaskId,
    state: 'success',
    pending: false,
    complete: true,
    sourceUrl,
    ...downloaded
  };
}

export async function generateModelScopeImage(env, input = {}, fetchImpl = fetch) {
  const taskId = String(input?.taskId || '').trim();
  return taskId
    ? pollModelScopeImageTask(env, taskId, fetchImpl)
    : startModelScopeImageTask(env, input, fetchImpl);
}
