const DEFAULT_KIE_BASE_URL = 'https://api.kie.ai';
const DEFAULT_KIE_MODEL = 'z-image';
export const GPT4O_IMAGE_MODEL = 'gpt4o-image';
const DEFAULT_KIE_THUMBNAIL_MODEL = 'z-image';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DEFAULT_KIE_TASK_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_KIE_TASK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_KIE_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_KIE_QUERY_RETRY_MAX = 4;
const DEFAULT_KIE_QUERY_RETRY_BASE_MS = 1000;
const DEFAULT_KIE_RESULT_DOWNLOAD_RETRY_MAX = 3;
const PENDING_STATES = new Set(['waiting', 'queuing', 'generating', 'pending', 'processing', 'running']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredKey(env) {
  const key = String(env?.KIE_API_KEY || '').trim();
  if (!key) throw Object.assign(new Error('KIE_API_KEY_REQUIRED'), { status: 503 });
  return key;
}

function safeBaseUrl(env) {
  const raw = String(env?.KIE_API_BASE_URL || DEFAULT_KIE_BASE_URL).trim();
  let url;
  try { url = new URL(raw); } catch { throw Object.assign(new Error('KIE_API_BASE_URL_INVALID'), { status: 500 }); }
  if (url.protocol !== 'https:' || url.hostname !== 'api.kie.ai') {
    throw Object.assign(new Error('KIE_API_BASE_URL_NOT_ALLOWED'), { status: 500 });
  }
  return url.origin;
}

function safeModel(env) {
  const model = String(env?.KIE_IMAGE_MODEL || DEFAULT_KIE_MODEL).trim();
  if (model !== DEFAULT_KIE_MODEL) throw Object.assign(new Error('KIE_IMAGE_MODEL_NOT_ALLOWED'), { status: 500 });
  return model;
}

// Thumbnails are the one image per article that drives click-through, so they are allowed to use
// the premium gpt4o-image model; body images stay on z-image. Locked to an explicit allowlist like
// safeModel() above so a stray env value can never silently switch production to a costlier model.
function safeThumbnailModel(env) {
  const model = String(env?.KIE_THUMBNAIL_MODEL || DEFAULT_KIE_THUMBNAIL_MODEL).trim();
  if (model !== DEFAULT_KIE_THUMBNAIL_MODEL && model !== GPT4O_IMAGE_MODEL) {
    throw Object.assign(new Error('KIE_THUMBNAIL_MODEL_NOT_ALLOWED'), { status: 500 });
  }
  return model;
}

export function resolveModelForRole(env, role) {
  return role === 'thumbnail' ? safeThumbnailModel(env) : safeModel(env);
}

export function kieCallbackUrl(env = {}) {
  const raw = String(env?.KIE_IMAGE_CALLBACK_URL || '').trim();
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { throw Object.assign(new Error('KIE_IMAGE_CALLBACK_URL_INVALID'), { status: 500 }); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw Object.assign(new Error('KIE_IMAGE_CALLBACK_URL_INVALID'), { status: 500 });
  }
  return url.href;
}

export function kieTaskTimeoutMs(env = {}) {
  const configured = Number(env?.KIE_IMAGE_TASK_TIMEOUT_MS ?? DEFAULT_KIE_TASK_TIMEOUT_MS);
  if (!Number.isInteger(configured) || configured < MIN_KIE_TASK_TIMEOUT_MS || configured > MAX_KIE_TASK_TIMEOUT_MS) {
    return DEFAULT_KIE_TASK_TIMEOUT_MS;
  }
  return configured;
}

export function kieQueryRetryMax(env = {}) {
  const configured = Number(env?.KIE_IMAGE_QUERY_RETRY_MAX ?? DEFAULT_KIE_QUERY_RETRY_MAX);
  if (!Number.isInteger(configured) || configured < 1 || configured > 5) return DEFAULT_KIE_QUERY_RETRY_MAX;
  return configured;
}

export function kieQueryRetryBaseMs(env = {}) {
  const configured = Number(env?.KIE_IMAGE_QUERY_RETRY_BASE_MS ?? DEFAULT_KIE_QUERY_RETRY_BASE_MS);
  if (!Number.isInteger(configured) || configured < 250 || configured > 5000) return DEFAULT_KIE_QUERY_RETRY_BASE_MS;
  return configured;
}

export function kieResultDownloadRetryMax(env = {}) {
  const configured = Number(env?.KIE_IMAGE_RESULT_DOWNLOAD_RETRY_MAX ?? DEFAULT_KIE_RESULT_DOWNLOAD_RETRY_MAX);
  if (!Number.isInteger(configured) || configured < 1 || configured > 5) return DEFAULT_KIE_RESULT_DOWNLOAD_RETRY_MAX;
  return configured;
}

function providerTimestampMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 1_000_000_000_000 ? Math.trunc(number * 1000) : Math.trunc(number);
}

export function kieTaskAgeMs(task, nowMs = Date.now()) {
  const createdAt = providerTimestampMs(task?.createTime);
  if (!createdAt) return 0;
  return Math.max(0, Number(nowMs) - createdAt);
}

export function kieTaskTimedOut(task, env = {}, nowMs = Date.now()) {
  const ageMs = kieTaskAgeMs(task, nowMs);
  return ageMs > 0 && ageMs >= kieTaskTimeoutMs(env);
}

export function normalizeAspectRatio(value, role) {
  const ratio = String(value || '').trim();
  const fallback = role === 'thumbnail' ? '16:9' : '4:3';
  const allowed = new Set(['1:1', '4:3', '3:4', '16:9', '9:16']);
  if (allowed.has(ratio)) return ratio;
  if (ratio === '3:2') return '4:3';
  if (ratio === '2:3') return '3:4';
  return fallback;
}

// KIE's gpt4o-image endpoint does NOT mirror OpenAI's gpt-image-1 pixel-dimension contract
// (a literal size string like "1024x1024") despite wrapping the same underlying model.
// KIE's own `size` field only accepts its own aspect-ratio enum: "1:1", "3:2", "2:3" — a
// narrower set than z-image's ratios and in a different shape than OpenAI's own API.
// Sending a pixel dimension, or a z-image-style ratio like "16:9"/"4:3" verbatim, is
// rejected with a generic "size error" every single time (confirmed live: this collapsed
// every thumbnail retry into KIE_RETRY_BUDGET_EXHAUSTED, since a deterministic validation
// rejection can never succeed no matter how many times it's retried). Map every ratio
// normalizeAspectRatio can produce onto KIE's actual enum instead.
const GPT4O_IMAGE_SIZE_BY_ASPECT_RATIO = Object.freeze({
  '1:1': '1:1',
  '4:3': '3:2',
  '16:9': '3:2',
  '3:4': '2:3',
  '9:16': '2:3'
});

export function gpt4oImageSize(aspectRatio, role) {
  const ratio = normalizeAspectRatio(aspectRatio, role);
  return GPT4O_IMAGE_SIZE_BY_ASPECT_RATIO[ratio] || '1:1';
}

export function safePromptForKie(value) {
  const prompt = String(value || '').replace(/\s+/g, ' ').trim();
  if (!prompt) return prompt;

  // Preserve the planner's subject and action. Safety shaping may suppress text-bearing
  // details, but must never replace the requested scene with a generic recovery scene.
  const commonSafety = 'Preserve the exact subject, action, problem context, objects, and scene requested above. Photorealistic real-world image. Use plain unbranded objects and surfaces. If a screen is visible, keep it blank or featureless unless the requested concept absolutely requires a screen; never invent UI. No visible text, letters, numbers, logos, icons, UI, packaging, labels, documents, signs, or watermarks. Do not substitute a different troubleshooting action, component, or generic cleaning scene.';
  return `${prompt}. ${commonSafety}`;
}

function numericCode(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

// KIE's own reason (data.msg, e.g. "prompt is required" or "invalid aspect_ratio") was
// previously discarded entirely in favor of the generic KIE_VALIDATION_FAILED bucket,
// leaving no way to tell why a specific request was rejected. Sanitized and length-capped
// the same way cloudflare-ai.js's providerValidationHint is, so it is safe to log/surface.
function kieValidationHint(data) {
  const raw = String(data?.msg || '').trim();
  if (!raw || raw.toLowerCase() === 'success') return null;
  const safe = raw.replace(/[^A-Za-z0-9_./,:; -]/g, ' ').replace(/\s+/g, ' ').trim();
  return safe ? safe.slice(0, 200) : null;
}

function kieFailure(response, data, safeError) {
  const providerHttpStatus = numericCode(response?.status);
  const providerCode = numericCode(data?.code);
  const signals = new Set([providerHttpStatus, providerCode].filter((value) => value !== null));
  const validationHint = kieValidationHint(data);

  let message = safeError;
  let status = 502;
  if (signals.has(401) || signals.has(403)) {
    message = 'KIE_AUTH_FAILED';
    status = 401;
  } else if (signals.has(402)) {
    message = 'KIE_INSUFFICIENT_CREDITS';
    status = 402;
  } else if (signals.has(429)) {
    message = 'KIE_RATE_LIMITED';
    status = 429;
  } else if (signals.has(400) || signals.has(422)) {
    message = 'KIE_VALIDATION_FAILED';
    status = 422;
  } else if ([...signals].some((value) => value >= 500)) {
    message = 'KIE_PROVIDER_ERROR';
    status = 502;
  }

  const error = Object.assign(new Error(message), {
    status,
    providerHttpStatus,
    providerCode
  });
  if (message === 'KIE_VALIDATION_FAILED' && validationHint) error.providerValidationHint = validationHint;
  return error;
}

function kieTaskFailure(task) {
  const providerCode = numericCode(task?.failCode);
  const detail = String(task?.failMsg || '').trim().toLowerCase();
  let message = 'KIE_IMAGE_GENERATION_FAILED';
  let status = 502;

  if (providerCode === 429 || /rate.?limit|too many|concurrent/.test(detail)) {
    message = 'KIE_RATE_LIMITED';
    status = 429;
  } else if (/(moderator|content policy|policy violation|nsfw|inappropriate content)/.test(detail)) {
    message = 'KIE_CONTENT_REJECTED';
    status = 422;
  } else if (providerCode === 500 || providerCode === 501 || /internal error|try again later|generation failed|generate failed/.test(detail)) {
    message = 'KIE_PROVIDER_GENERATION_FAILED';
  }

  const error = Object.assign(new Error(message), { status });
  if (providerCode !== null) error.providerCode = providerCode;
  return error;
}

function kieResponseSucceeded(response, data) {
  if (!response?.ok || !data) return false;
  if (Number(data.code) === 200) return true;
  return Boolean(data.data) && String(data.msg || '').trim().toLowerCase() === 'success';
}

async function jsonRequest(fetchImpl, url, init, safeError) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw Object.assign(new Error('KIE_NETWORK_ERROR'), { status: 502 });
  }
  let data = null;
  try { data = await response.json(); } catch { /* safe generic failure below */ }
  if (!kieResponseSucceeded(response, data)) throw kieFailure(response, data, safeError);
  return data;
}

function transientQueryError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || '');
  return message === 'KIE_NETWORK_ERROR'
    || message === 'KIE_RATE_LIMITED'
    || message === 'KIE_PROVIDER_ERROR'
    || status === 429
    || status >= 500;
}

async function queryTaskDetail(env, url, apiKey, fetchImpl) {
  const maxAttempts = kieQueryRetryMax(env);
  const baseDelay = kieQueryRetryBaseMs(env);
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return {
        data: await jsonRequest(
          fetchImpl,
          url,
          { headers: { authorization: `Bearer ${apiKey}` } },
          'KIE_TASK_QUERY_FAILED'
        ),
        transientError: null,
        attempts: attempt + 1
      };
    } catch (error) {
      if (!transientQueryError(error)) throw error;
      lastError = error;
      if (attempt + 1 >= maxAttempts) break;
      await sleep(Math.min(8000, baseDelay * (2 ** attempt)));
    }
  }

  return { data: null, transientError: lastError, attempts: maxAttempts };
}

function queryKieTaskDetail(env, baseUrl, apiKey, taskId, fetchImpl) {
  return queryTaskDetail(env, `${baseUrl}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, apiKey, fetchImpl);
}

function queryGpt4oImageDetail(env, baseUrl, apiKey, taskId, fetchImpl) {
  return queryTaskDetail(env, `${baseUrl}/api/v1/gpt4o-image/record-info?taskId=${encodeURIComponent(taskId)}`, apiKey, fetchImpl);
}

function parseResultUrl(task) {
  let parsed;
  try { parsed = JSON.parse(String(task?.resultJson || '{}')); } catch { return ''; }
  const url = Array.isArray(parsed?.resultUrls) ? String(parsed.resultUrls[0] || '').trim() : '';
  if (!url) return '';
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return ''; }
  if (parsedUrl.protocol !== 'https:') return '';
  return parsedUrl.href;
}

function parseGpt4oResultUrl(task) {
  const urls = task?.response?.resultUrls;
  const url = Array.isArray(urls) ? String(urls[0] || '').trim() : '';
  if (!url) return '';
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { return ''; }
  if (parsedUrl.protocol !== 'https:') return '';
  return parsedUrl.href;
}

function gpt4oTaskFailure(task) {
  const providerCode = numericCode(task?.errorCode);
  const detail = String(task?.errorMessage || '').trim().toLowerCase();
  let message = 'KIE_IMAGE_GENERATION_FAILED';
  let status = 502;

  if (providerCode === 429 || /rate.?limit|too many|concurrent/.test(detail)) {
    message = 'KIE_RATE_LIMITED';
    status = 429;
  } else if (/(moderator|content policy|policy violation|nsfw|inappropriate content)/.test(detail)) {
    message = 'KIE_CONTENT_REJECTED';
    status = 422;
  } else if ((providerCode !== null && providerCode >= 500) || /internal error|try again later|generation failed|generate failed/.test(detail)) {
    message = 'KIE_PROVIDER_GENERATION_FAILED';
  }

  const error = Object.assign(new Error(message), { status });
  if (providerCode !== null) error.providerCode = providerCode;
  return error;
}

function classifyMimeType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  if (['image/jpeg', 'image/png', 'image/webp'].includes(type)) return type;
  return 'image/jpeg';
}

async function downloadKieResult(env, fetchImpl, resultUrl) {
  const maxAttempts = kieResultDownloadRetryMax(env);
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let imageResponse;
    try {
      imageResponse = await fetchImpl(resultUrl, {
        redirect: 'follow',
        headers: {
          accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'user-agent': 'Mozilla/5.0 (compatible; SmileseonImageFetcher/1.0)'
        }
      });
    } catch {
      lastError = Object.assign(new Error('KIE_RESULT_DOWNLOAD_FAILED'), { status: 502, transient: true });
      imageResponse = null;
    }

    if (imageResponse?.ok) {
      const bytes = new Uint8Array(await imageResponse.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
        throw Object.assign(new Error(bytes.length ? 'KIE_IMAGE_TOO_LARGE' : 'KIE_IMAGE_EMPTY'), { status: 502 });
      }

      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      return {
        mimeType: classifyMimeType(imageResponse.headers?.get?.('content-type')),
        imageBase64: btoa(binary)
      };
    }

    if (imageResponse && !imageResponse.ok) {
      lastError = Object.assign(new Error('KIE_RESULT_DOWNLOAD_FAILED'), {
        status: 502,
        providerHttpStatus: Number(imageResponse.status || 0),
        transient: true
      });
    }

    if (attempt + 1 < maxAttempts) await sleep(1000 * (2 ** attempt));
  }

  throw lastError || Object.assign(new Error('KIE_RESULT_DOWNLOAD_FAILED'), { status: 502, transient: true });
}

async function startGpt4oImageTask(env, { role, prompt, aspectRatio, hookText }, apiKey, baseUrl, callbackUrl, fetchImpl) {
  const hook = String(hookText || '').trim();
  // When a hook is being baked in, `prompt` (built by the caller with a hook-render
  // instruction instead of the usual "no visible text" tail) must reach KIE verbatim.
  // Re-applying safePromptForKie's own "no visible text" line here would directly
  // contradict the instruction to render this exact headline.
  const finalPrompt = hook ? String(prompt || '').replace(/\s+/g, ' ').trim() : safePromptForKie(prompt);
  const body = {
    filesUrl: [],
    prompt: finalPrompt,
    size: gpt4oImageSize(aspectRatio, role)
  };
  if (callbackUrl) body.callBackUrl = callbackUrl;

  const create = await jsonRequest(
    fetchImpl,
    `${baseUrl}/api/v1/gpt4o-image/generate`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    },
    'KIE_CREATE_TASK_FAILED'
  );

  const taskId = String(create?.data?.taskId || '').trim();
  if (!taskId) throw Object.assign(new Error('KIE_TASK_ID_MISSING'), { status: 502 });
  return {
    ok: true,
    provider: 'kie-ai',
    model: GPT4O_IMAGE_MODEL,
    taskId,
    state: 'waiting',
    pending: true,
    complete: false,
    callback: Boolean(callbackUrl),
    hookBaked: Boolean(hook)
  };
}

export async function startKieImageTask(env, { role, prompt, aspectRatio, hookText }, fetchImpl = fetch) {
  const apiKey = requiredKey(env);
  const baseUrl = safeBaseUrl(env);
  const model = resolveModelForRole(env, role);
  const callbackUrl = kieCallbackUrl(env);

  if (model === GPT4O_IMAGE_MODEL) {
    return startGpt4oImageTask(env, { role, prompt, aspectRatio, hookText }, apiKey, baseUrl, callbackUrl, fetchImpl);
  }

  // z-image cannot reliably render legible text, so hookText is intentionally ignored on
  // this path — thumbnails on this model always use the standard "no visible text" prompt
  // plus the separate HTML-overlay post-processing step.
  const body = {
    model,
    input: {
      prompt: safePromptForKie(prompt),
      aspect_ratio: normalizeAspectRatio(aspectRatio, role),
      nsfw_checker: true
    }
  };
  if (callbackUrl) body.callBackUrl = callbackUrl;

  const create = await jsonRequest(
    fetchImpl,
    `${baseUrl}/api/v1/jobs/createTask`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    },
    'KIE_CREATE_TASK_FAILED'
  );

  const taskId = String(create?.data?.taskId || '').trim();
  if (!taskId) throw Object.assign(new Error('KIE_TASK_ID_MISSING'), { status: 502 });
  return {
    ok: true,
    provider: 'kie-ai',
    model,
    taskId,
    state: 'waiting',
    pending: true,
    complete: false,
    callback: Boolean(callbackUrl)
  };
}

async function pollGpt4oImageTask(env, taskId, apiKey, baseUrl, fetchImpl) {
  const queried = await queryGpt4oImageDetail(env, baseUrl, apiKey, taskId, fetchImpl);

  if (queried.transientError) {
    return {
      ok: true,
      provider: 'kie-ai',
      model: GPT4O_IMAGE_MODEL,
      taskId,
      state: 'query_retry',
      pending: true,
      complete: false,
      queryAttempts: queried.attempts,
      recoveryReason: String(queried.transientError?.message || 'KIE_TASK_QUERY_RETRY')
    };
  }

  const task = queried.data?.data || {};
  const successFlag = Number(task.successFlag);
  if (successFlag === 2 || successFlag === 3) throw gpt4oTaskFailure(task);
  if (successFlag !== 1) {
    if (kieTaskTimedOut(task, env)) {
      const error = Object.assign(new Error('KIE_TASK_TIMEOUT'), {
        status: 504,
        taskId,
        taskState: 'waiting',
        taskAgeMs: kieTaskAgeMs(task),
        taskTimeoutMs: kieTaskTimeoutMs(env)
      });
      const progress = Number(task?.progress);
      if (Number.isFinite(progress)) error.progress = progress;
      throw error;
    }
    return {
      ok: true,
      provider: 'kie-ai',
      model: GPT4O_IMAGE_MODEL,
      taskId,
      state: 'waiting',
      pending: true,
      complete: false
    };
  }

  const resultUrl = parseGpt4oResultUrl(task);
  if (!resultUrl) {
    return {
      ok: true,
      provider: 'kie-ai',
      model: GPT4O_IMAGE_MODEL,
      taskId,
      state: 'result_pending',
      pending: true,
      complete: false,
      recoveryReason: 'KIE_RESULT_URL_MISSING'
    };
  }

  let downloaded;
  try {
    downloaded = await downloadKieResult(env, fetchImpl, resultUrl);
  } catch (error) {
    if (error?.transient === true || String(error?.message || '') === 'KIE_RESULT_DOWNLOAD_FAILED') {
      return {
        ok: true,
        provider: 'kie-ai',
        model: GPT4O_IMAGE_MODEL,
        taskId,
        state: 'result_download_retry',
        pending: true,
        complete: false,
        sourceUrl: resultUrl,
        recoveryReason: 'KIE_RESULT_DOWNLOAD_FAILED'
      };
    }
    throw error;
  }

  return {
    ok: true,
    provider: 'kie-ai',
    model: GPT4O_IMAGE_MODEL,
    taskId,
    state: 'success',
    pending: false,
    complete: true,
    sourceUrl: resultUrl,
    ...downloaded
  };
}

// `role` is appended last (rather than replacing fetchImpl's position) so every existing
// 3-argument call site (tests included) keeps resolving to the z-image path unchanged.
export async function pollKieImageTask(env, taskId, fetchImpl = fetch, role) {
  const normalizedTaskId = String(taskId || '').trim();
  if (!normalizedTaskId) throw Object.assign(new Error('KIE_TASK_ID_REQUIRED'), { status: 400 });
  const apiKey = requiredKey(env);
  const baseUrl = safeBaseUrl(env);
  const model = resolveModelForRole(env, role);
  if (model === GPT4O_IMAGE_MODEL) {
    return pollGpt4oImageTask(env, normalizedTaskId, apiKey, baseUrl, fetchImpl);
  }
  const queried = await queryKieTaskDetail(env, baseUrl, apiKey, normalizedTaskId, fetchImpl);

  if (queried.transientError) {
    return {
      ok: true,
      provider: 'kie-ai',
      model,
      taskId: normalizedTaskId,
      state: 'query_retry',
      pending: true,
      complete: false,
      queryAttempts: queried.attempts,
      recoveryReason: String(queried.transientError?.message || 'KIE_TASK_QUERY_RETRY')
    };
  }

  const task = queried.data?.data || {};
  const state = String(task.state || '').trim().toLowerCase();
  if (state === 'fail') throw kieTaskFailure(task);
  if (state !== 'success') {
    if (kieTaskTimedOut(task, env)) {
      const error = Object.assign(new Error('KIE_TASK_TIMEOUT'), {
        status: 504,
        taskId: normalizedTaskId,
        taskState: PENDING_STATES.has(state) ? state : (state || 'waiting'),
        taskAgeMs: kieTaskAgeMs(task),
        taskTimeoutMs: kieTaskTimeoutMs(env)
      });
      const progress = Number(task?.progress);
      if (Number.isFinite(progress)) error.progress = progress;
      throw error;
    }
    return {
      ok: true,
      provider: 'kie-ai',
      model,
      taskId: normalizedTaskId,
      state: PENDING_STATES.has(state) ? state : (state || 'waiting'),
      pending: true,
      complete: false
    };
  }

  const resultUrl = parseResultUrl(task);
  if (!resultUrl) {
    return {
      ok: true,
      provider: 'kie-ai',
      model,
      taskId: normalizedTaskId,
      state: 'result_pending',
      pending: true,
      complete: false,
      recoveryReason: 'KIE_RESULT_URL_MISSING'
    };
  }

  let downloaded;
  try {
    downloaded = await downloadKieResult(env, fetchImpl, resultUrl);
  } catch (error) {
    if (error?.transient === true || String(error?.message || '') === 'KIE_RESULT_DOWNLOAD_FAILED') {
      return {
        ok: true,
        provider: 'kie-ai',
        model,
        taskId: normalizedTaskId,
        state: 'result_download_retry',
        pending: true,
        complete: false,
        sourceUrl: resultUrl,
        recoveryReason: 'KIE_RESULT_DOWNLOAD_FAILED'
      };
    }
    throw error;
  }

  return {
    ok: true,
    provider: 'kie-ai',
    model,
    taskId: normalizedTaskId,
    state: 'success',
    pending: false,
    complete: true,
    sourceUrl: resultUrl,
    ...downloaded
  };
}

export async function generateKieImage(env, { role, prompt, aspectRatio, taskId, hookText }, fetchImpl = fetch) {
  if (String(taskId || '').trim()) return pollKieImageTask(env, taskId, fetchImpl, role);
  return startKieImageTask(env, { role, prompt, aspectRatio, hookText }, fetchImpl);
}