const DEFAULT_BASE_URL = 'https://api.free.ai';
const DEFAULT_MODEL = 'qwen7b';
const DEFAULT_TIMEOUT_MS = 60000;

function required(value, name) {
  const text = String(value || '').trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 500;
    throw error;
  }
  return text;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return number;
}

export function freeAiConfigured(env = {}) {
  return Boolean(String(env?.FREE_AI_API_KEY || '').trim());
}

export function freeAiFallbackEnabled(env = {}) {
  return String(env?.FREE_AI_FALLBACK_ENABLED || 'false').trim().toLowerCase() === 'true';
}

export function freeAiRequestTimeoutMs(env = {}) {
  const configured = Number(env?.FREE_AI_REQUEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TIMEOUT_MS;
  return Math.max(10000, Math.min(120000, Math.trunc(configured)));
}

export function freeAiModel(env = {}, role = '') {
  const normalizedRole = String(role || '').trim().toUpperCase();
  const roleValue = normalizedRole ? env?.[`FREE_AI_${normalizedRole}_MODEL`] : '';
  return String(roleValue || env?.FREE_AI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function endpoint(env = {}) {
  const base = String(env?.FREE_AI_API_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  return `${base}/v1/chat/`;
}

function responseText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  const direct = data?.response ?? data?.result?.response ?? data?.text;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  return '';
}

function providerMessage(data) {
  const raw = data?.error?.message ?? data?.message ?? data?.detail ?? '';
  return String(raw || '').slice(0, 240);
}

export function classifyFreeAiFailure(status, data = {}) {
  const message = providerMessage(data).toLowerCase();
  if (status === 401 || status === 403) return { message: 'FREE_AI_AUTH_FAILED', status };
  if (status === 402) return { message: 'FREE_AI_QUOTA_EXHAUSTED', status: 429 };
  if (status === 408 || status === 504) return { message: 'FREE_AI_TIMEOUT', status: 408 };
  if (status === 429) {
    if (message.includes('daily') || message.includes('pool') || message.includes('token')) {
      return { message: 'FREE_AI_QUOTA_EXHAUSTED', status: 429 };
    }
    return { message: 'FREE_AI_RATE_LIMITED', status: 429 };
  }
  if (status === 400 || status === 422) return { message: 'FREE_AI_REQUEST_REJECTED', status: 400 };
  if (status >= 500) return { message: 'FREE_AI_UNAVAILABLE', status: 503 };
  return { message: 'FREE_AI_REQUEST_FAILED', status: 502 };
}

export function shouldFallbackFromFreeAi(error) {
  return new Set([
    'FREE_AI_AUTH_FAILED',
    'FREE_AI_QUOTA_EXHAUSTED',
    'FREE_AI_RATE_LIMITED',
    'FREE_AI_TIMEOUT',
    'FREE_AI_REQUEST_REJECTED',
    'FREE_AI_UNAVAILABLE',
    'FREE_AI_REQUEST_FAILED',
    'FREE_AI_EMPTY_RESPONSE'
  ]).has(String(error?.message || ''));
}

export async function runFreeAi(
  env,
  {
    model,
    messages,
    maxTokens,
    temperature,
    responseFormat
  },
  fetchImpl = fetch
) {
  const apiKey = required(env?.FREE_AI_API_KEY, 'FREE_AI_API_KEY');
  const id = String(model || freeAiModel(env)).trim() || DEFAULT_MODEL;
  if (!Array.isArray(messages) || messages.length === 0) {
    const error = new Error('FREE_AI_MESSAGES_REQUIRED');
    error.status = 500;
    throw error;
  }

  const body = {
    model: id,
    messages,
    stream: false
  };
  if (maxTokens !== undefined) body.max_tokens = positiveInteger(maxTokens, 4096);
  if (temperature !== undefined && Number.isFinite(Number(temperature))) body.temperature = Number(temperature);
  if (responseFormat) body.response_format = responseFormat;

  let response;
  try {
    response = await fetchImpl(endpoint(env), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(freeAiRequestTimeoutMs(env))
    });
  } catch (cause) {
    const timeout = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
    const error = new Error(timeout ? 'FREE_AI_TIMEOUT' : 'FREE_AI_REQUEST_FAILED');
    error.status = timeout ? 408 : 502;
    error.cause = cause;
    throw error;
  }

  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) {
    const classified = classifyFreeAiFailure(response.status, data);
    const error = new Error(classified.message);
    error.status = classified.status;
    error.providerHttpStatus = response.status;
    throw error;
  }

  const output = responseText(data);
  if (!output) {
    const error = new Error('FREE_AI_EMPTY_RESPONSE');
    error.status = 502;
    throw error;
  }

  return {
    model: String(data?.model || id),
    response: output,
    usage: data?.usage ?? data?.free_ai_usage ?? null,
    freeAiUsage: data?.free_ai_usage ?? null
  };
}
