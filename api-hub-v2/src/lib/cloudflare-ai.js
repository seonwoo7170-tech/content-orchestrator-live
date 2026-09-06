import { parseModelText } from './contracts.js';

function required(value, name) {
  const text = String(value || '').trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 500;
    throw error;
  }
  return text;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    const error = new Error(`${name}_INVALID`);
    error.status = 500;
    throw error;
  }
  return number;
}

function integer(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    const error = new Error(`${name}_INVALID`);
    error.status = 500;
    throw error;
  }
  return number;
}

function boundedNumber(value, name, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    const error = new Error(`${name}_INVALID`);
    error.status = 500;
    throw error;
  }
  return number;
}

function validateChatTemplateKwargs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('CHAT_TEMPLATE_KWARGS_INVALID');
    error.status = 500;
    throw error;
  }
  const output = {};
  for (const key of ['enable_thinking', 'clear_thinking']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') {
        const error = new Error('CHAT_TEMPLATE_KWARGS_INVALID');
        error.status = 500;
        throw error;
      }
      output[key] = value[key];
    }
  }
  if (!Object.keys(output).length) {
    const error = new Error('CHAT_TEMPLATE_KWARGS_INVALID');
    error.status = 500;
    throw error;
  }
  return output;
}

function validateResponseFormat(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('RESPONSE_FORMAT_INVALID');
    error.status = 500;
    throw error;
  }
  const type = String(value.type || '').trim();
  if (!['json_object', 'json_schema'].includes(type)) {
    const error = new Error('RESPONSE_FORMAT_INVALID');
    error.status = 500;
    throw error;
  }
  if (type === 'json_object') return { type };
  if (!value.json_schema || typeof value.json_schema !== 'object' || Array.isArray(value.json_schema)) {
    const error = new Error('RESPONSE_FORMAT_INVALID');
    error.status = 500;
    throw error;
  }
  return { type, json_schema: value.json_schema };
}

function structuredResponseText(data, responseFormat) {
  if (!responseFormat) return '';
  const direct = data?.result?.response ?? data?.response;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return JSON.stringify(direct);
  }
  const parsed = data?.result?.choices?.[0]?.message?.parsed ?? data?.choices?.[0]?.message?.parsed;
  if (parsed && typeof parsed === 'object') return JSON.stringify(parsed);
  return '';
}

const SAFE_PROVIDER_FAILURES = Object.freeze({
  '5007': { message: 'CLOUDFLARE_AI_MODEL_NOT_FOUND', status: 400 },
  '5006': { message: 'CLOUDFLARE_AI_BAD_INPUT', status: 400 },
  '5004': { message: 'CLOUDFLARE_AI_INVALID_DATA', status: 400 },
  '3039': { message: 'CLOUDFLARE_AI_FINETUNE_FILES_MISSING', status: 400 },
  '3030': { message: 'CLOUDFLARE_AI_CONTENT_FILTERED', status: 400 },
  '3003': { message: 'CLOUDFLARE_AI_INCOMPLETE_REQUEST', status: 400 },
  '5018': { message: 'CLOUDFLARE_AI_MODEL_ACCESS_DENIED', status: 403 },
  '5016': { message: 'CLOUDFLARE_AI_MODEL_AGREEMENT_REQUIRED', status: 403 },
  '3023': { message: 'CLOUDFLARE_AI_ACCOUNT_BLOCKED', status: 403 },
  '3041': { message: 'CLOUDFLARE_AI_PRIVATE_MODEL_DENIED', status: 403 },
  '5035': { message: 'CLOUDFLARE_AI_PAID_PLAN_REQUIRED', status: 403 },
  '5019': { message: 'CLOUDFLARE_AI_SDK_DEPRECATED', status: 405 },
  '5005': { message: 'CLOUDFLARE_AI_LORA_UNSUPPORTED', status: 405 },
  '3042': { message: 'CLOUDFLARE_AI_MODEL_ID_INVALID', status: 404 },
  '3006': { message: 'CLOUDFLARE_AI_REQUEST_TOO_LARGE', status: 413 },
  '3007': { message: 'CLOUDFLARE_AI_TIMEOUT', status: 408 },
  '3008': { message: 'CLOUDFLARE_AI_ABORTED', status: 408 },
  '3036': { message: 'CLOUDFLARE_AI_ACCOUNT_LIMITED', status: 429 },
  '3040': { message: 'CLOUDFLARE_AI_OUT_OF_CAPACITY', status: 429 }
});

const WORKERS_AI_SIGNAL_KEYS = new Set([
  'code', 'errorCode', 'error_code', 'internalCode', 'internal_code',
  'name', 'message', 'stack', 'status', 'statusCode', 'status_code',
  'httpStatus', 'http_status'
]);
const WORKERS_AI_NESTED_KEYS = new Set([
  'cause', 'error', 'errors', 'detail', 'details', 'response', 'result', 'data'
]);

function workersAiSignals(cause) {
  const values = [];
  const statuses = [];
  const seen = new Set();
  const queue = [{ value: cause, depth: 0 }];
  let visited = 0;

  while (queue.length && visited < 48) {
    const { value, depth } = queue.shift();
    if (value === undefined || value === null || depth > 5) continue;
    if (typeof value !== 'object') {
      if (typeof value === 'string' || typeof value === 'number') values.push(String(value));
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    visited += 1;

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 12)) queue.push({ value: item, depth: depth + 1 });
      continue;
    }

    for (const key of WORKERS_AI_SIGNAL_KEYS) {
      const signal = value[key];
      if (signal === undefined || signal === null) continue;
      if (['status', 'statusCode', 'status_code', 'httpStatus', 'http_status'].includes(key)) {
        const status = Number(signal);
        if (Number.isInteger(status) && status >= 100 && status <= 599) statuses.push(status);
      }
      if (typeof signal === 'string' || typeof signal === 'number') values.push(String(signal));
    }

    for (const key of WORKERS_AI_NESTED_KEYS) {
      const nested = value[key];
      if (nested !== undefined && nested !== null) queue.push({ value: nested, depth: depth + 1 });
    }
  }

  return { values, statuses };
}

function safeSchemaToken(value, max = 80) {
  const text = String(value || '').trim();
  if (!text || text.length > max || !/^[A-Za-z0-9_./, -]+$/.test(text)) return '';
  return text.replace(/\s+/g, ' ');
}

function workersAiValidationHint(candidates) {
  const hints = [];
  const add = (hint) => {
    if (hint && !hints.includes(hint) && hints.length < 3) hints.push(hint);
  };

  for (const raw of candidates) {
    const text = String(raw || '');
    let match;

    const requiredPattern = /required propert(?:y|ies) at ['"]([^'"]{1,80})['"] (?:is|are) ['"]([^'"]{1,120})['"]/gi;
    while ((match = requiredPattern.exec(text))) {
      const path = safeSchemaToken(match[1], 80);
      const fields = safeSchemaToken(match[2], 120);
      if (path && fields) add(`required:${path}:${fields}`);
    }

    const mismatchPattern = /type mismatch of ['"]([^'"]{1,80})['"]/gi;
    while ((match = mismatchPattern.exec(text))) {
      const path = safeSchemaToken(match[1], 80);
      if (path) add(`type-mismatch:${path}`);
    }

    const oneOfPattern = /(?:oneOf|anyOf) at ['"]([^'"]{1,80})['"] not met/gi;
    while ((match = oneOfPattern.exec(text))) {
      const path = safeSchemaToken(match[1], 80);
      if (path) add(`schema-choice:${path}`);
    }
  }

  return hints.join(';').slice(0, 240);
}

export function classifyWorkersAiFailure(cause) {
  const { values: candidates, statuses } = workersAiSignals(cause);
  const validationHint = workersAiValidationHint(candidates);

  for (const [code, info] of Object.entries(SAFE_PROVIDER_FAILURES)) {
    const codePattern = new RegExp(`(^|\\D)${code}(\\D|$)`);
    if (candidates.some((value) => codePattern.test(value))) {
      const result = { ...info, providerCode: Number(code) };
      if (code === '5006' && validationHint) result.validationHint = validationHint;
      return result;
    }
  }

  const message = candidates.join(' ').toLowerCase();
  if (message.includes('nsfw') || message.includes('content filter') || message.includes('content policy')) {
    return { ...SAFE_PROVIDER_FAILURES['3030'], providerCode: 3030 };
  }
  if (message.includes('daily free allocation') || message.includes('daily allocation')) {
    return { ...SAFE_PROVIDER_FAILURES['3036'], providerCode: 3036 };
  }
  if (message.includes('out of capacity')) return { ...SAFE_PROVIDER_FAILURES['3040'], providerCode: 3040 };
  if (message.includes('workers paid') || message.includes('paid plan')) {
    return { ...SAFE_PROVIDER_FAILURES['5035'], providerCode: 5035 };
  }
  if (message.includes('rate limit') || message.includes('too many requests') || message.includes('quota exceeded')) {
    return { message: 'CLOUDFLARE_AI_RATE_LIMITED', status: 429, providerCode: null };
  }

  if (statuses.includes(429)) return { message: 'CLOUDFLARE_AI_RATE_LIMITED', status: 429, providerCode: null };
  if (statuses.some((status) => status === 408 || status === 504)) {
    return { message: 'CLOUDFLARE_AI_TIMEOUT', status: 408, providerCode: null };
  }
  if (statuses.includes(403)) return { message: 'CLOUDFLARE_AI_ACCESS_DENIED', status: 403, providerCode: null };
  if (statuses.includes(400)) return { message: 'CLOUDFLARE_AI_REQUEST_REJECTED', status: 400, providerCode: null };
  if (statuses.some((status) => status >= 500)) {
    return { message: 'CLOUDFLARE_AI_UPSTREAM_FAILED', status: 502, providerCode: null };
  }

  for (const candidate of candidates) {
    const match = candidate.match(/(^|\D)([3-5]\d{3})(\D|$)/);
    if (match) {
      return { message: 'CLOUDFLARE_AI_PROVIDER_REJECTED', status: 502, providerCode: Number(match[2]) };
    }
  }

  return { message: 'CLOUDFLARE_AI_BINDING_FAILED', status: 502, providerCode: null };
}

export function assertAllowedModel(model) {
  const id = required(model, 'MODEL');
  if (!id.startsWith('@cf/')) {
    const error = new Error('MODEL_NOT_ALLOWED');
    error.status = 400;
    throw error;
  }
  return id;
}

export async function runWorkersAi(
  env,
  {
    model,
    messages,
    prompt,
    maxTokens,
    maxCompletionTokens,
    reasoningEffort,
    chatTemplateKwargs,
    responseFormat,
    temperature,
    seed
  },
  aiBinding = env?.AI
) {
  const id = assertAllowedModel(model);
  if (!aiBinding || typeof aiBinding.run !== 'function') {
    const error = new Error('CLOUDFLARE_AI_BINDING_REQUIRED');
    error.status = 500;
    throw error;
  }

  const body = messages ? { messages } : { prompt: String(prompt || '') };
  if (maxTokens !== undefined) body.max_tokens = positiveInteger(maxTokens, 'MAX_TOKENS');
  if (maxCompletionTokens !== undefined) {
    body.max_completion_tokens = positiveInteger(maxCompletionTokens, 'MAX_COMPLETION_TOKENS');
  }
  if (reasoningEffort !== undefined) {
    if (reasoningEffort === null) {
      body.reasoning_effort = null;
    } else {
      const effort = String(reasoningEffort || '').trim();
      if (!['low', 'medium', 'high'].includes(effort)) {
        const error = new Error('REASONING_EFFORT_INVALID');
        error.status = 500;
        throw error;
      }
      body.reasoning_effort = effort;
    }
  }
  if (chatTemplateKwargs !== undefined) {
    body.chat_template_kwargs = validateChatTemplateKwargs(chatTemplateKwargs);
  }
  if (responseFormat !== undefined) {
    body.response_format = validateResponseFormat(responseFormat);
  }
  if (temperature !== undefined) body.temperature = boundedNumber(temperature, 'TEMPERATURE', 0, 2);
  if (seed !== undefined) body.seed = integer(seed, 'SEED');

  let data;
  try {
    data = await aiBinding.run(id, body);
  } catch (cause) {
    const classified = classifyWorkersAiFailure(cause);
    const error = new Error(classified.message);
    error.status = classified.status;
    if (Number.isInteger(classified.providerCode)) error.providerCode = classified.providerCode;
    if (classified.validationHint) error.providerValidationHint = classified.validationHint;
    error.cause = cause;
    throw error;
  }

  const response = structuredResponseText(data, responseFormat) || parseModelText(data);
  if (!response) {
    const error = new Error('CLOUDFLARE_AI_EMPTY_RESPONSE');
    error.status = 502;
    throw error;
  }

  return {
    model: id,
    response,
    usage: data?.usage ?? data?.result?.usage ?? null
  };
}
