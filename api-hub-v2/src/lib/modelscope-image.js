const DEFAULT_MODELSCOPE_BASE_URL = 'https://api-inference.modelscope.ai';
const DEFAULT_MODELSCOPE_MODEL = 'Qwen/Qwen-Image';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['api-inference.modelscope.ai', 'api-inference.modelscope.cn']);
const PENDING_STATES = new Set(['pending', 'waiting', 'queued', 'queuing', 'running', 'processing', 'generating', 'created']);

function requiredToken(env) {
  const token = String(env?.MODELSCOPE_TOKEN || '').trim();
  if (!token) throw Object.assign(new Error('MODELSCOPE_TOKEN_REQUIRED'), { status: 503 });
  return token;
}

function safeBaseUrl(env) {
  const raw = String(env?.MODELSCOPE_API_BASE_URL || DEFAULT_MODELSCOPE_BASE_URL).trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(raw); } catch { throw Object.assign(new Error('MODELSCOPE_API_BASE_URL_INVALID'), { status: 500 }); }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password || url.hash || (url.pathname && url.pathname !== '/')) {
    throw Object.assign(new Error('MODELSCOPE_API_BASE_URL_NOT_ALLOWED'), { status: 500 });
  }
  return url.origin;
}

function safeModel(env) {
  const model = String(env?.MODELSCOPE_IMAGE_MODEL || DEFAULT_MODELSCOPE_MODEL).trim();
  if (model !== DEFAULT_MODELSCOPE_MODEL) throw Object.assign(new Error('MODELSCOPE_IMAGE_MODEL_NOT_ALLOWED'), { status: 500 });
  return model;
}

function classifyMimeType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  if (['image/jpeg', 'image/png', 'image/webp'].includes(type)) return type;
  return 'image/jpeg';
}

function numericStatus(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function providerFailure(response, data, fallback = 'MODELSCOPE_REQUEST_FAILED') {
  const providerHttpStatus = numericStatus(response?.status);
  let message = fallback;
  let status = 502;
  if (providerHttpStatus === 401 || providerHttpStatus === 403) {
    message = 'MODELSCOPE_AUTH_FAILED';
    status = 401;
  } else if (providerHttpStatus === 429) {
    message = 'MODELSCOPE_RATE_LIMITED';
    status = 429;
  } else if (providerHttpStatus === 400 || providerHttpStatus === 404 || providerHttpStatus === 422) {
    message = 'MODELSCOPE_VALIDATION_FAILED';
    status = 422;
  } else if (providerHttpStatus !== null && providerHttpStatus >= 500) {
    message = 'MODELSCOPE_PROVIDER_ERROR';
  }
  const error = Object.assign(new Error(message), { status, providerHttpStatus });
  const providerMessage = String(data?.message || data?.error || data?.detail || '').trim();
  if (providerMessage) error.providerMessage = providerMessage.slice(0, 300);
  return error;
}

async function jsonRequest(fetchImpl, url, init, fallback) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw Object.assign(new Error('MODELSCOPE_NETWORK_ERROR'), { status: 502 });
  }
  let data = null;
  try { data = await response.json(); } catch { /* generic failure below */ }
  if (!response.ok || !data) throw providerFailure(response, data, fallback);
  return data;
}

function safeResultUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { return ''; }
  if (url.protocol !== 'https:' || url.username || url.password) return '';
  return url.href;
}

async function downloadResult(fetchImpl, resultUrl) {
  let response;
  try { response = await fetchImpl(resultUrl, { redirect: 'follow' }); } catch {
    throw Object.assign(new Error('MODELSCOPE_RESULT_DOWNLOAD_FAILED'), { status: 502 });
  }
  if (!response.ok) throw Object.assign(new Error('MODELSCOPE_RESULT_DOWNLOAD_FAILED'), { status: 502 });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error(bytes.length ? 'MODELSCOPE_IMAGE_TOO_LARGE' : 'MODELSCOPE_IMAGE_EMPTY'), { status: 502 });
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return {
    mimeType: classifyMimeType(response.headers?.get?.('content-type')),
    imageBase64: btoa(binary)
  };
}

export async function startModelScopeImageTask(env, { prompt }, fetchImpl = fetch) {
  const token = requiredToken(env);
  const baseUrl = safeBaseUrl(env);
  const model = safeModel(env);
  const data = await jsonRequest(
    fetchImpl,
    `${baseUrl}/v1/images/generations`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'X-ModelScope-Async-Mode': 'true'
      },
      body: JSON.stringify({ model, prompt: String(prompt || '').trim() })
    },
    'MODELSCOPE_SUBMIT_FAILED'
  );
  const taskId = String(data?.task_id || '').trim();
  if (!taskId) throw Object.assign(new Error('MODELSCOPE_TASK_ID_MISSING'), { status: 502 });
  return {
    ok: true,
    provider: 'modelscope-ai',
    model,
    taskId,
    state: 'pending',
    pending: true,
    complete: false
  };
}

export async function pollModelScopeImageTask(env, taskId, fetchImpl = fetch) {
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) throw Object.assign(new Error('MODELSCOPE_TASK_ID_REQUIRED'), { status: 400 });
  const token = requiredToken(env);
  const baseUrl = safeBaseUrl(env);
  const model = safeModel(env);
  const data = await jsonRequest(
    fetchImpl,
    `${baseUrl}/v1/tasks/${encodeURIComponent(normalizedTaskId)}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'X-ModelScope-Task-Type': 'image_generation'
      }
    },
    'MODELSCOPE_POLL_FAILED'
  );

  const rawState = String(data?.task_status || '').trim();
  const state = rawState.toLowerCase();
  if (rawState.toUpperCase() === 'FAILED' || state === 'fail' || state === 'failed') {
    const error = Object.assign(new Error('MODELSCOPE_IMAGE_GENERATION_FAILED'), { status: 502, taskId: normalizedTaskId });
    const detail = String(data?.message || data?.error || data?.task_message || '').trim();
    if (detail) error.providerMessage = detail.slice(0, 300);
    throw error;
  }

  if (rawState.toUpperCase() !== 'SUCCEED' && state !== 'success' && state !== 'succeeded') {
    return {
      ok: true,
      provider: 'modelscope-ai',
      model,
      taskId: normalizedTaskId,
      state: PENDING_STATES.has(state) ? state : (state || 'pending'),
      pending: true,
      complete: false
    };
  }

  const resultUrl = safeResultUrl(Array.isArray(data?.output_images) ? data.output_images[0] : '');
  if (!resultUrl) throw Object.assign(new Error('MODELSCOPE_RESULT_URL_MISSING'), { status: 502 });
  const downloaded = await downloadResult(fetchImpl, resultUrl);
  return {
    ok: true,
    provider: 'modelscope-ai',
    model,
    taskId: normalizedTaskId,
    state: 'success',
    pending: false,
    complete: true,
    sourceUrl: resultUrl,
    ...downloaded
  };
}

export async function generateModelScopeImage(env, { prompt, taskId }, fetchImpl = fetch) {
  if (String(taskId || '').trim()) return pollModelScopeImageTask(env, taskId, fetchImpl);
  return startModelScopeImageTask(env, { prompt }, fetchImpl);
}
