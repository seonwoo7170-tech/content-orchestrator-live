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

export function geminiRequestTimeoutMs(env) {
  const configured = Number(env?.GEMINI_REQUEST_TIMEOUT_MS ?? 30000);
  if (!Number.isFinite(configured)) return 30000;
  return Math.max(1000, Math.min(60000, Math.trunc(configured)));
}

function thinkingLevel(value) {
  const level = String(value || 'minimal').trim().toLowerCase();
  if (!['minimal', 'low', 'medium', 'high'].includes(level)) {
    const error = new Error('GEMINI_THINKING_LEVEL_INVALID');
    error.status = 500;
    throw error;
  }
  return level;
}

function validateResponseSchema(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('GEMINI_RESPONSE_SCHEMA_INVALID');
    error.status = 500;
    throw error;
  }
  return value;
}

function validateInlineImage(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('GEMINI_INLINE_IMAGE_INVALID');
    error.status = 500;
    throw error;
  }
  const mimeType = String(value.mimeType || '').split(';')[0].trim().toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
    const error = new Error('GEMINI_INLINE_IMAGE_MIME_INVALID');
    error.status = 400;
    throw error;
  }
  const data = String(value.data || '').trim();
  if (!data) {
    const error = new Error('GEMINI_INLINE_IMAGE_DATA_REQUIRED');
    error.status = 400;
    throw error;
  }
  if (data.length > 20 * 1024 * 1024) {
    const error = new Error('GEMINI_INLINE_IMAGE_TOO_LARGE');
    error.status = 413;
    throw error;
  }
  return { mimeType, data };
}

export function assertAllowedGeminiModel(model) {
  const id = required(model, 'GEMINI_MODEL');
  if (!/^gemini-[a-z0-9.-]+$/i.test(id)) {
    const error = new Error('GEMINI_MODEL_NOT_ALLOWED');
    error.status = 400;
    throw error;
  }
  return id;
}

function classifyHttpFailure(status) {
  if (status === 400) return { message: 'GEMINI_REQUEST_REJECTED', status: 400 };
  if (status === 401 || status === 403) return { message: 'GEMINI_AUTH_FAILED', status };
  if (status === 408) return { message: 'GEMINI_TIMEOUT', status: 408 };
  if (status === 429) return { message: 'GEMINI_RATE_LIMITED', status: 429 };
  if (status >= 500 && status <= 599) return { message: 'GEMINI_UNAVAILABLE', status: 503 };
  return { message: 'GEMINI_API_FAILED', status: 502 };
}

function candidateText(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  const parts = [];
  for (const candidate of candidates) {
    const contentParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of contentParts) {
      if (typeof part?.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('\n').trim();
}

function normalizeUsage(data) {
  const usage = data?.usageMetadata;
  if (!usage || typeof usage !== 'object') return null;
  return {
    promptTokenCount: Number(usage.promptTokenCount || 0),
    candidatesTokenCount: Number(usage.candidatesTokenCount || 0),
    thoughtsTokenCount: Number(usage.thoughtsTokenCount || 0),
    totalTokenCount: Number(usage.totalTokenCount || 0),
    cachedContentTokenCount: Number(usage.cachedContentTokenCount || 0)
  };
}

export async function runGeminiAi(
  env,
  {
    model = 'gemini-3.5-flash-lite',
    systemInstruction,
    userContent,
    inlineImage,
    maxOutputTokens = 4096,
    responseSchema,
    thinking = 'minimal'
  },
  fetchImpl = fetch
) {
  const apiKey = required(env?.GEMINI_API_KEY, 'GEMINI_API_KEY');
  const id = assertAllowedGeminiModel(model);
  const system = required(systemInstruction, 'GEMINI_SYSTEM_INSTRUCTION');
  const user = required(userContent, 'GEMINI_USER_CONTENT');
  const image = validateInlineImage(inlineImage);
  const maxTokens = positiveInteger(maxOutputTokens, 'GEMINI_MAX_OUTPUT_TOKENS');
  const level = thinkingLevel(thinking);
  const schema = validateResponseSchema(responseSchema);
  const timeoutMs = geminiRequestTimeoutMs(env);

  const generationConfig = {
    maxOutputTokens: maxTokens,
    thinkingConfig: { thinkingLevel: level }
  };
  const jsonOnly = /\breturn\s+json\s+only\b/i.test(system);
  if (schema || jsonOnly) generationConfig.responseMimeType = 'application/json';
  if (schema) generationConfig.responseSchema = schema;

  const parts = [];
  if (image) parts.push({ inlineData: image });
  parts.push({ text: user });

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig
  };

  let response;
  try {
    response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(id)}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (cause) {
    const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
    const error = new Error(timedOut ? 'GEMINI_TIMEOUT' : 'GEMINI_REQUEST_FAILED');
    error.status = timedOut ? 408 : 502;
    error.cause = cause;
    throw error;
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const classified = classifyHttpFailure(response.status);
    const error = new Error(classified.message);
    error.status = classified.status;
    throw error;
  }

  const text = candidateText(data);
  if (!text) {
    const blocked = Boolean(data?.promptFeedback?.blockReason) || (Array.isArray(data?.candidates) && data.candidates.some((candidate) => candidate?.finishReason === 'SAFETY'));
    const error = new Error(blocked ? 'GEMINI_BLOCKED' : 'GEMINI_EMPTY_RESPONSE');
    error.status = blocked ? 422 : 502;
    throw error;
  }

  return {
    model: id,
    response: text,
    usage: normalizeUsage(data)
  };
}
