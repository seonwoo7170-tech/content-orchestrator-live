var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/lib/auth.js
function isAuthorized(request, env) {
  const expected = String(env.ORCHESTRATOR_API_KEY || "");
  if (!expected) return false;
  return request.headers.get("x-hub-api-key") === expected;
}
__name(isAuthorized, "isAuthorized");
function requireAuthorized(request, env) {
  if (!isAuthorized(request, env)) {
    const error = new Error("UNAUTHORIZED");
    error.status = 401;
    throw error;
  }
}
__name(requireAuthorized, "requireAuthorized");

// src/lib/contracts.js
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
__name(json, "json");
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    const error = new Error("INVALID_JSON");
    error.status = 400;
    throw error;
  }
}
__name(readJson, "readJson");
function responseApiText(container) {
  if (!container || typeof container !== "object") return "";
  if (typeof container.output_text === "string") return container.output_text.trim();
  if (!Array.isArray(container.output)) return "";
  const parts = [];
  for (const item of container.output) {
    if (typeof item?.text === "string") parts.push(item.text);
    if (!Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      if (typeof content?.text === "string") parts.push(content.text);
      else if (typeof content?.output_text === "string") parts.push(content.output_text);
    }
  }
  return parts.join("\n").trim();
}
__name(responseApiText, "responseApiText");
function parseModelText(data) {
  const direct = data?.result?.response ?? data?.response ?? data?.result?.text ?? data?.text;
  if (typeof direct === "string") return direct.trim();
  const choice = data?.result?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice.trim();
  const responsesText = responseApiText(data?.result) || responseApiText(data);
  if (responsesText) return responsesText;
  return "";
}
__name(parseModelText, "parseModelText");
function balancedJsonCandidate(text, start) {
  const opener = text[start];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : null;
  if (!closer) return null;
  const stack = [closer];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") {
      if (stack[stack.length - 1] !== char) return null;
      stack.pop();
      if (stack.length === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}
__name(balancedJsonCandidate, "balancedJsonCandidate");
function parseEmbeddedJson(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{" && text[index] !== "[") continue;
    const candidate = balancedJsonCandidate(text, index);
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
    }
  }
  return null;
}
__name(parseEmbeddedJson, "parseEmbeddedJson");
function parseJsonText(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const embedded = parseEmbeddedJson(cleaned);
    if (embedded !== null) return embedded;
    const error = new Error("AI_PROVIDER_JSON_INVALID");
    error.status = 502;
    throw error;
  }
}
__name(parseJsonText, "parseJsonText");
var MASTER_V45 = Object.freeze({
  fileName: "universal_blog_master_prompt_ko_en_verified_v4_5_final.md",
  size: 93282,
  sha256: "0df7c83bb3874c4802ca7c02306beee7cd7032366930d66abfc7fa1bdb6cda66"
});

// src/lib/cloudflare-ai.js
function required(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 500;
    throw error;
  }
  return text;
}
__name(required, "required");
function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    const error = new Error(`${name}_INVALID`);
    error.status = 500;
    throw error;
  }
  return number;
}
__name(positiveInteger, "positiveInteger");
function integer(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    const error = new Error(`${name}_INVALID`);
    error.status = 500;
    throw error;
  }
  return number;
}
__name(integer, "integer");
function boundedNumber(value, name, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    const error = new Error(`${name}_INVALID`);
    error.status = 500;
    throw error;
  }
  return number;
}
__name(boundedNumber, "boundedNumber");
function validateChatTemplateKwargs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("CHAT_TEMPLATE_KWARGS_INVALID");
    error.status = 500;
    throw error;
  }
  const output = {};
  for (const key of ["enable_thinking", "clear_thinking"]) {
    if (value[key] !== void 0) {
      if (typeof value[key] !== "boolean") {
        const error = new Error("CHAT_TEMPLATE_KWARGS_INVALID");
        error.status = 500;
        throw error;
      }
      output[key] = value[key];
    }
  }
  if (!Object.keys(output).length) {
    const error = new Error("CHAT_TEMPLATE_KWARGS_INVALID");
    error.status = 500;
    throw error;
  }
  return output;
}
__name(validateChatTemplateKwargs, "validateChatTemplateKwargs");
function validateResponseFormat(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("RESPONSE_FORMAT_INVALID");
    error.status = 500;
    throw error;
  }
  const type = String(value.type || "").trim();
  if (!["json_object", "json_schema"].includes(type)) {
    const error = new Error("RESPONSE_FORMAT_INVALID");
    error.status = 500;
    throw error;
  }
  if (type === "json_object") return { type };
  if (!value.json_schema || typeof value.json_schema !== "object" || Array.isArray(value.json_schema)) {
    const error = new Error("RESPONSE_FORMAT_INVALID");
    error.status = 500;
    throw error;
  }
  return { type, json_schema: value.json_schema };
}
__name(validateResponseFormat, "validateResponseFormat");
function structuredResponseText(data, responseFormat) {
  if (!responseFormat) return "";
  const direct = data?.result?.response ?? data?.response;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return JSON.stringify(direct);
  }
  const parsed = data?.result?.choices?.[0]?.message?.parsed ?? data?.choices?.[0]?.message?.parsed;
  if (parsed && typeof parsed === "object") return JSON.stringify(parsed);
  return "";
}
__name(structuredResponseText, "structuredResponseText");
var SAFE_PROVIDER_FAILURES = Object.freeze({
  "5007": { message: "CLOUDFLARE_AI_MODEL_NOT_FOUND", status: 400 },
  "5006": { message: "CLOUDFLARE_AI_BAD_INPUT", status: 400 },
  "5004": { message: "CLOUDFLARE_AI_INVALID_DATA", status: 400 },
  "3039": { message: "CLOUDFLARE_AI_FINETUNE_FILES_MISSING", status: 400 },
  "3030": { message: "CLOUDFLARE_AI_CONTENT_FILTERED", status: 400 },
  "3003": { message: "CLOUDFLARE_AI_INCOMPLETE_REQUEST", status: 400 },
  "5018": { message: "CLOUDFLARE_AI_MODEL_ACCESS_DENIED", status: 403 },
  "5016": { message: "CLOUDFLARE_AI_MODEL_AGREEMENT_REQUIRED", status: 403 },
  "3023": { message: "CLOUDFLARE_AI_ACCOUNT_BLOCKED", status: 403 },
  "3041": { message: "CLOUDFLARE_AI_PRIVATE_MODEL_DENIED", status: 403 },
  "5035": { message: "CLOUDFLARE_AI_PAID_PLAN_REQUIRED", status: 403 },
  "5019": { message: "CLOUDFLARE_AI_SDK_DEPRECATED", status: 405 },
  "5005": { message: "CLOUDFLARE_AI_LORA_UNSUPPORTED", status: 405 },
  "3042": { message: "CLOUDFLARE_AI_MODEL_ID_INVALID", status: 404 },
  "3006": { message: "CLOUDFLARE_AI_REQUEST_TOO_LARGE", status: 413 },
  "3007": { message: "CLOUDFLARE_AI_TIMEOUT", status: 408 },
  "3008": { message: "CLOUDFLARE_AI_ABORTED", status: 408 },
  "3036": { message: "CLOUDFLARE_AI_ACCOUNT_LIMITED", status: 429 },
  "3040": { message: "CLOUDFLARE_AI_OUT_OF_CAPACITY", status: 429 }
});
var WORKERS_AI_SIGNAL_KEYS = /* @__PURE__ */ new Set([
  "code",
  "errorCode",
  "error_code",
  "internalCode",
  "internal_code",
  "name",
  "message",
  "stack",
  "status",
  "statusCode",
  "status_code",
  "httpStatus",
  "http_status"
]);
var WORKERS_AI_NESTED_KEYS = /* @__PURE__ */ new Set([
  "cause",
  "error",
  "errors",
  "detail",
  "details",
  "response",
  "result",
  "data"
]);
function workersAiSignals(cause) {
  const values = [];
  const statuses = [];
  const seen = /* @__PURE__ */ new Set();
  const queue = [{ value: cause, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < 48) {
    const { value, depth } = queue.shift();
    if (value === void 0 || value === null || depth > 5) continue;
    if (typeof value !== "object") {
      if (typeof value === "string" || typeof value === "number") values.push(String(value));
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
      if (signal === void 0 || signal === null) continue;
      if (["status", "statusCode", "status_code", "httpStatus", "http_status"].includes(key)) {
        const status = Number(signal);
        if (Number.isInteger(status) && status >= 100 && status <= 599) statuses.push(status);
      }
      if (typeof signal === "string" || typeof signal === "number") values.push(String(signal));
    }
    for (const key of WORKERS_AI_NESTED_KEYS) {
      const nested = value[key];
      if (nested !== void 0 && nested !== null) queue.push({ value: nested, depth: depth + 1 });
    }
  }
  return { values, statuses };
}
__name(workersAiSignals, "workersAiSignals");
function safeSchemaToken(value, max = 80) {
  const text = String(value || "").trim();
  if (!text || text.length > max || !/^[A-Za-z0-9_./, -]+$/.test(text)) return "";
  return text.replace(/\s+/g, " ");
}
__name(safeSchemaToken, "safeSchemaToken");
function workersAiValidationHint(candidates) {
  const hints = [];
  const add = /* @__PURE__ */ __name((hint) => {
    if (hint && !hints.includes(hint) && hints.length < 3) hints.push(hint);
  }, "add");
  for (const raw of candidates) {
    const text = String(raw || "");
    let match;
    const requiredPattern = /required propert(?:y|ies) at ['"]([^'"]{1,80})['"] (?:is|are) ['"]([^'"]{1,120})['"]/gi;
    while (match = requiredPattern.exec(text)) {
      const path = safeSchemaToken(match[1], 80);
      const fields = safeSchemaToken(match[2], 120);
      if (path && fields) add(`required:${path}:${fields}`);
    }
    const mismatchPattern = /type mismatch of ['"]([^'"]{1,80})['"]/gi;
    while (match = mismatchPattern.exec(text)) {
      const path = safeSchemaToken(match[1], 80);
      if (path) add(`type-mismatch:${path}`);
    }
    const oneOfPattern = /(?:oneOf|anyOf) at ['"]([^'"]{1,80})['"] not met/gi;
    while (match = oneOfPattern.exec(text)) {
      const path = safeSchemaToken(match[1], 80);
      if (path) add(`schema-choice:${path}`);
    }
  }
  return hints.join(";").slice(0, 240);
}
__name(workersAiValidationHint, "workersAiValidationHint");
function classifyWorkersAiFailure(cause) {
  const { values: candidates, statuses } = workersAiSignals(cause);
  const validationHint = workersAiValidationHint(candidates);
  for (const [code, info] of Object.entries(SAFE_PROVIDER_FAILURES)) {
    const codePattern = new RegExp(`(^|\\D)${code}(\\D|$)`);
    if (candidates.some((value) => codePattern.test(value))) {
      const result = { ...info, providerCode: Number(code) };
      if (code === "5006" && validationHint) result.validationHint = validationHint;
      return result;
    }
  }
  const message = candidates.join(" ").toLowerCase();
  if (message.includes("nsfw") || message.includes("content filter") || message.includes("content policy")) {
    return { ...SAFE_PROVIDER_FAILURES["3030"], providerCode: 3030 };
  }
  if (message.includes("daily free allocation") || message.includes("daily allocation")) {
    return { ...SAFE_PROVIDER_FAILURES["3036"], providerCode: 3036 };
  }
  if (message.includes("out of capacity")) return { ...SAFE_PROVIDER_FAILURES["3040"], providerCode: 3040 };
  if (message.includes("workers paid") || message.includes("paid plan")) {
    return { ...SAFE_PROVIDER_FAILURES["5035"], providerCode: 5035 };
  }
  if (message.includes("rate limit") || message.includes("too many requests") || message.includes("quota exceeded")) {
    return { message: "CLOUDFLARE_AI_RATE_LIMITED", status: 429, providerCode: null };
  }
  if (statuses.includes(429)) return { message: "CLOUDFLARE_AI_RATE_LIMITED", status: 429, providerCode: null };
  if (statuses.some((status) => status === 408 || status === 504)) {
    return { message: "CLOUDFLARE_AI_TIMEOUT", status: 408, providerCode: null };
  }
  if (statuses.includes(403)) return { message: "CLOUDFLARE_AI_ACCESS_DENIED", status: 403, providerCode: null };
  if (statuses.includes(400)) return { message: "CLOUDFLARE_AI_REQUEST_REJECTED", status: 400, providerCode: null };
  if (statuses.some((status) => status >= 500)) {
    return { message: "CLOUDFLARE_AI_UPSTREAM_FAILED", status: 502, providerCode: null };
  }
  for (const candidate of candidates) {
    const match = candidate.match(/(^|\D)([3-5]\d{3})(\D|$)/);
    if (match) {
      return { message: "CLOUDFLARE_AI_PROVIDER_REJECTED", status: 502, providerCode: Number(match[2]) };
    }
  }
  return { message: "CLOUDFLARE_AI_BINDING_FAILED", status: 502, providerCode: null };
}
__name(classifyWorkersAiFailure, "classifyWorkersAiFailure");
function assertAllowedModel(model) {
  const id = required(model, "MODEL");
  if (!id.startsWith("@cf/")) {
    const error = new Error("MODEL_NOT_ALLOWED");
    error.status = 400;
    throw error;
  }
  return id;
}
__name(assertAllowedModel, "assertAllowedModel");
async function runWorkersAi(env, {
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
}, aiBinding = env?.AI) {
  const id = assertAllowedModel(model);
  if (!aiBinding || typeof aiBinding.run !== "function") {
    const error = new Error("CLOUDFLARE_AI_BINDING_REQUIRED");
    error.status = 500;
    throw error;
  }
  const body = messages ? { messages } : { prompt: String(prompt || "") };
  if (maxTokens !== void 0) body.max_tokens = positiveInteger(maxTokens, "MAX_TOKENS");
  if (maxCompletionTokens !== void 0) {
    body.max_completion_tokens = positiveInteger(maxCompletionTokens, "MAX_COMPLETION_TOKENS");
  }
  if (reasoningEffort !== void 0) {
    if (reasoningEffort === null) {
      body.reasoning_effort = null;
    } else {
      const effort = String(reasoningEffort || "").trim();
      if (!["low", "medium", "high"].includes(effort)) {
        const error = new Error("REASONING_EFFORT_INVALID");
        error.status = 500;
        throw error;
      }
      body.reasoning_effort = effort;
    }
  }
  if (chatTemplateKwargs !== void 0) {
    body.chat_template_kwargs = validateChatTemplateKwargs(chatTemplateKwargs);
  }
  if (responseFormat !== void 0) {
    body.response_format = validateResponseFormat(responseFormat);
  }
  if (temperature !== void 0) body.temperature = boundedNumber(temperature, "TEMPERATURE", 0, 2);
  if (seed !== void 0) body.seed = integer(seed, "SEED");
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
    const error = new Error("CLOUDFLARE_AI_EMPTY_RESPONSE");
    error.status = 502;
    throw error;
  }
  return {
    model: id,
    response,
    usage: data?.usage ?? data?.result?.usage ?? null
  };
}
__name(runWorkersAi, "runWorkersAi");

// src/lib/gemini-ai.js
function required2(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 500;
    throw error;
  }
  return text;
}
__name(required2, "required");
function positiveInteger2(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    const error = new Error(`${name}_INVALID`);
    error.status = 500;
    throw error;
  }
  return number;
}
__name(positiveInteger2, "positiveInteger");
function geminiRequestTimeoutMs(env) {
  const configured = Number(env?.GEMINI_REQUEST_TIMEOUT_MS ?? 3e4);
  if (!Number.isFinite(configured)) return 3e4;
  return Math.max(1e3, Math.min(6e4, Math.trunc(configured)));
}
__name(geminiRequestTimeoutMs, "geminiRequestTimeoutMs");
function thinkingLevel(value) {
  const level = String(value || "minimal").trim().toLowerCase();
  if (!["minimal", "low", "medium", "high"].includes(level)) {
    const error = new Error("GEMINI_THINKING_LEVEL_INVALID");
    error.status = 500;
    throw error;
  }
  return level;
}
__name(thinkingLevel, "thinkingLevel");
function validateResponseSchema(value) {
  if (value === void 0 || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("GEMINI_RESPONSE_SCHEMA_INVALID");
    error.status = 500;
    throw error;
  }
  return value;
}
__name(validateResponseSchema, "validateResponseSchema");
function validateInlineImage(value) {
  if (value === void 0 || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("GEMINI_INLINE_IMAGE_INVALID");
    error.status = 500;
    throw error;
  }
  const mimeType = String(value.mimeType || "").split(";")[0].trim().toLowerCase();
  if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
    const error = new Error("GEMINI_INLINE_IMAGE_MIME_INVALID");
    error.status = 400;
    throw error;
  }
  const data = String(value.data || "").trim();
  if (!data) {
    const error = new Error("GEMINI_INLINE_IMAGE_DATA_REQUIRED");
    error.status = 400;
    throw error;
  }
  if (data.length > 20 * 1024 * 1024) {
    const error = new Error("GEMINI_INLINE_IMAGE_TOO_LARGE");
    error.status = 413;
    throw error;
  }
  return { mimeType, data };
}
__name(validateInlineImage, "validateInlineImage");
function assertAllowedGeminiModel(model) {
  const id = required2(model, "GEMINI_MODEL");
  if (!/^gemini-[a-z0-9.-]+$/i.test(id)) {
    const error = new Error("GEMINI_MODEL_NOT_ALLOWED");
    error.status = 400;
    throw error;
  }
  return id;
}
__name(assertAllowedGeminiModel, "assertAllowedGeminiModel");
function classifyHttpFailure(status) {
  if (status === 400) return { message: "GEMINI_REQUEST_REJECTED", status: 400 };
  if (status === 401 || status === 403) return { message: "GEMINI_AUTH_FAILED", status };
  if (status === 408) return { message: "GEMINI_TIMEOUT", status: 408 };
  if (status === 429) return { message: "GEMINI_RATE_LIMITED", status: 429 };
  if (status >= 500 && status <= 599) return { message: "GEMINI_UNAVAILABLE", status: 503 };
  return { message: "GEMINI_API_FAILED", status: 502 };
}
__name(classifyHttpFailure, "classifyHttpFailure");
function geminiFailureHint(status, data) {
  if (status !== 400) return null;
  const detail = String(data?.error?.message || "").replace(/[\r\n]+/g, " ").trim();
  if (!detail) return null;
  return detail.replace(/[^A-Za-z0-9_./,:; -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || null;
}
__name(geminiFailureHint, "geminiFailureHint");
function candidateText(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  const parts = [];
  for (const candidate of candidates) {
    const contentParts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of contentParts) {
      if (typeof part?.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n").trim();
}
__name(candidateText, "candidateText");
function normalizeUsage(data) {
  const usage = data?.usageMetadata;
  if (!usage || typeof usage !== "object") return null;
  return {
    promptTokenCount: Number(usage.promptTokenCount || 0),
    candidatesTokenCount: Number(usage.candidatesTokenCount || 0),
    thoughtsTokenCount: Number(usage.thoughtsTokenCount || 0),
    totalTokenCount: Number(usage.totalTokenCount || 0),
    cachedContentTokenCount: Number(usage.cachedContentTokenCount || 0)
  };
}
__name(normalizeUsage, "normalizeUsage");
async function runGeminiAi(env, {
  model = "gemini-3.5-flash-lite",
  systemInstruction,
  userContent,
  inlineImage,
  maxOutputTokens = 4096,
  responseSchema,
  thinking = "minimal"
}, fetchImpl = fetch) {
  const apiKey = required2(env?.GEMINI_API_KEY, "GEMINI_API_KEY");
  const id = assertAllowedGeminiModel(model);
  const system = required2(systemInstruction, "GEMINI_SYSTEM_INSTRUCTION");
  const user = required2(userContent, "GEMINI_USER_CONTENT");
  const image = validateInlineImage(inlineImage);
  const maxTokens = positiveInteger2(maxOutputTokens, "GEMINI_MAX_OUTPUT_TOKENS");
  const level = thinkingLevel(thinking);
  const schema = validateResponseSchema(responseSchema);
  const timeoutMs = geminiRequestTimeoutMs(env);
  const generationConfig = {
    maxOutputTokens: maxTokens,
    thinkingConfig: { thinkingLevel: level }
  };
  const jsonOnly = /\breturn\s+json\s+only\b/i.test(system);
  if (schema || jsonOnly) generationConfig.responseMimeType = "application/json";
  if (schema) generationConfig.responseSchema = schema;
  const parts = [];
  if (image) parts.push({ inlineData: image });
  parts.push({ text: user });
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig
  };
  let response;
  try {
    response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(id)}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (cause) {
    const timedOut = cause?.name === "TimeoutError" || cause?.name === "AbortError";
    const error = new Error(timedOut ? "GEMINI_TIMEOUT" : "GEMINI_REQUEST_FAILED");
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
    const hint = geminiFailureHint(response.status, data);
    if (hint) error.providerValidationHint = hint;
    throw error;
  }
  const text = candidateText(data);
  if (!text) {
    const blocked = Boolean(data?.promptFeedback?.blockReason) || Array.isArray(data?.candidates) && data.candidates.some((candidate) => candidate?.finishReason === "SAFETY");
    const error = new Error(blocked ? "GEMINI_BLOCKED" : "GEMINI_EMPTY_RESPONSE");
    error.status = blocked ? 422 : 502;
    throw error;
  }
  return {
    model: id,
    response: text,
    usage: normalizeUsage(data)
  };
}
__name(runGeminiAi, "runGeminiAi");

// src/lib/free-ai.js
var DEFAULT_BASE_URL = "https://api.free.ai";
var DEFAULT_MODEL = "qwen7b";
var DEFAULT_TIMEOUT_MS = 6e4;
function required3(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 500;
    throw error;
  }
  return text;
}
__name(required3, "required");
function positiveInteger3(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return number;
}
__name(positiveInteger3, "positiveInteger");
function freeAiConfigured(env = {}) {
  return Boolean(String(env?.FREE_AI_API_KEY || "").trim());
}
__name(freeAiConfigured, "freeAiConfigured");
function freeAiFallbackEnabled(env = {}) {
  return String(env?.FREE_AI_FALLBACK_ENABLED || "false").trim().toLowerCase() === "true";
}
__name(freeAiFallbackEnabled, "freeAiFallbackEnabled");
function freeAiRequestTimeoutMs(env = {}) {
  const configured = Number(env?.FREE_AI_REQUEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1e4, Math.min(12e4, Math.trunc(configured)));
}
__name(freeAiRequestTimeoutMs, "freeAiRequestTimeoutMs");
function freeAiModel(env = {}, role = "") {
  const normalizedRole = String(role || "").trim().toUpperCase();
  const roleValue = normalizedRole ? env?.[`FREE_AI_${normalizedRole}_MODEL`] : "";
  return String(roleValue || env?.FREE_AI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}
__name(freeAiModel, "freeAiModel");
function endpoint(env = {}) {
  const base = String(env?.FREE_AI_API_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  return `${base}/v1/chat/`;
}
__name(endpoint, "endpoint");
function responseText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  const direct = data?.response ?? data?.result?.response ?? data?.text;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return "";
}
__name(responseText, "responseText");
function providerMessage(data) {
  const raw = data?.error?.message ?? data?.message ?? data?.detail ?? "";
  return String(raw || "").slice(0, 240);
}
__name(providerMessage, "providerMessage");
function classifyFreeAiFailure(status, data = {}) {
  const message = providerMessage(data).toLowerCase();
  if (status === 401 || status === 403) return { message: "FREE_AI_AUTH_FAILED", status };
  if (status === 402) return { message: "FREE_AI_QUOTA_EXHAUSTED", status: 429 };
  if (status === 408 || status === 504) return { message: "FREE_AI_TIMEOUT", status: 408 };
  if (status === 429) {
    if (message.includes("daily") || message.includes("pool") || message.includes("token")) {
      return { message: "FREE_AI_QUOTA_EXHAUSTED", status: 429 };
    }
    return { message: "FREE_AI_RATE_LIMITED", status: 429 };
  }
  if (status === 400 || status === 422) return { message: "FREE_AI_REQUEST_REJECTED", status: 400 };
  if (status >= 500) return { message: "FREE_AI_UNAVAILABLE", status: 503 };
  return { message: "FREE_AI_REQUEST_FAILED", status: 502 };
}
__name(classifyFreeAiFailure, "classifyFreeAiFailure");
function shouldFallbackFromFreeAi(error) {
  return (/* @__PURE__ */ new Set([
    "FREE_AI_AUTH_FAILED",
    "FREE_AI_QUOTA_EXHAUSTED",
    "FREE_AI_RATE_LIMITED",
    "FREE_AI_TIMEOUT",
    "FREE_AI_REQUEST_REJECTED",
    "FREE_AI_UNAVAILABLE",
    "FREE_AI_REQUEST_FAILED",
    "FREE_AI_EMPTY_RESPONSE"
  ])).has(String(error?.message || ""));
}
__name(shouldFallbackFromFreeAi, "shouldFallbackFromFreeAi");
async function runFreeAi(env, {
  model,
  messages,
  maxTokens,
  temperature,
  responseFormat
}, fetchImpl = fetch) {
  const apiKey = required3(env?.FREE_AI_API_KEY, "FREE_AI_API_KEY");
  const id = String(model || freeAiModel(env)).trim() || DEFAULT_MODEL;
  if (!Array.isArray(messages) || messages.length === 0) {
    const error = new Error("FREE_AI_MESSAGES_REQUIRED");
    error.status = 500;
    throw error;
  }
  const body = {
    model: id,
    messages,
    stream: false
  };
  if (maxTokens !== void 0) body.max_tokens = positiveInteger3(maxTokens, 4096);
  if (temperature !== void 0 && Number.isFinite(Number(temperature))) body.temperature = Number(temperature);
  if (responseFormat) body.response_format = responseFormat;
  let response;
  try {
    response = await fetchImpl(endpoint(env), {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(freeAiRequestTimeoutMs(env))
    });
  } catch (cause) {
    const timeout = cause?.name === "TimeoutError" || cause?.name === "AbortError";
    const error = new Error(timeout ? "FREE_AI_TIMEOUT" : "FREE_AI_REQUEST_FAILED");
    error.status = timeout ? 408 : 502;
    error.cause = cause;
    throw error;
  }
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    const classified = classifyFreeAiFailure(response.status, data);
    const error = new Error(classified.message);
    error.status = classified.status;
    error.providerHttpStatus = response.status;
    throw error;
  }
  const output = responseText(data);
  if (!output) {
    const error = new Error("FREE_AI_EMPTY_RESPONSE");
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
__name(runFreeAi, "runFreeAi");

// src/lib/ai-provider-router.js
var CLOUDFLARE_FALLBACK_ERRORS = /* @__PURE__ */ new Set([
  "CLOUDFLARE_AI_ACCOUNT_LIMITED",
  "CLOUDFLARE_AI_OUT_OF_CAPACITY",
  "CLOUDFLARE_AI_PAID_PLAN_REQUIRED",
  "CLOUDFLARE_AI_TIMEOUT",
  "CLOUDFLARE_AI_BINDING_FAILED",
  "CLOUDFLARE_AI_BINDING_REQUIRED",
  "CLOUDFLARE_AI_EMPTY_RESPONSE",
  "CLOUDFLARE_AI_JSON_INVALID"
]);
var GEMINI_FALLBACK_ERRORS = /* @__PURE__ */ new Set([
  "GEMINI_REQUEST_FAILED",
  "GEMINI_TIMEOUT",
  "GEMINI_RATE_LIMITED",
  "GEMINI_UNAVAILABLE",
  "GEMINI_API_FAILED",
  "GEMINI_EMPTY_RESPONSE",
  "GEMINI_JSON_INVALID"
]);
var ROLE_OUTPUT_TOKEN_CAP = 12288;
var HTML_BLOCK_RE = /<(p|h2|h3|li|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi;
var EXACT_HTML_LOCATION_RE = /^html\s+(p|h2|h3|li|blockquote)\s+(\d+)$/i;
var TARGETED_REPAIR_FIELDS = /* @__PURE__ */ new Set([
  "title",
  "searchDescription",
  "labels",
  "sources",
  "language",
  "topic"
]);
var TARGETED_REPAIR_PATCH_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    patches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          location: { type: "string" },
          value: { type: "string" }
        },
        required: ["location", "value"]
      }
    }
  },
  required: ["patches"]
});
function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
__name(sleep, "sleep");
function geminiRetryDelayMs(env = {}) {
  const configured = Number(env?.AI_PROVIDER_RETRY_DELAY_MS ?? 4e3);
  if (!Number.isFinite(configured)) return 4e3;
  if (configured <= 0) return 0;
  return Math.max(3e3, Math.min(5e3, Math.trunc(configured)));
}
__name(geminiRetryDelayMs, "geminiRetryDelayMs");
function requestSystemText(request = {}) {
  if (String(request?.systemInstruction || "").trim()) return String(request.systemInstruction);
  if (!Array.isArray(request?.messages)) return "";
  return request.messages.filter((message) => String(message?.role || "").toLowerCase() === "system").map((message) => String(message?.content || "")).join("\n");
}
__name(requestSystemText, "requestSystemText");
function requestRequiresJson(request = {}) {
  if (request?.responseSchema && typeof request.responseSchema === "object") return true;
  if (String(request?.responseFormat?.type || "").toLowerCase() === "json_object") return true;
  return /\breturn\s+json\s+only\b/i.test(requestSystemText(request));
}
__name(requestRequiresJson, "requestRequiresJson");
function assertJsonOnlyResponse(result, request, errorCode) {
  if (!requestRequiresJson(request)) return result;
  try {
    parseJsonText(result?.response);
    return result;
  } catch (cause) {
    const error = new Error(errorCode);
    error.status = 502;
    error.cause = cause;
    throw error;
  }
}
__name(assertJsonOnlyResponse, "assertJsonOnlyResponse");
function assertProviderSemanticResponse(result, validateResponse, errorCode) {
  if (typeof validateResponse !== "function") return result;
  try {
    validateResponse(parseJsonText(result?.response));
    return result;
  } catch (cause) {
    const error = new Error(errorCode);
    error.status = 502;
    error.cause = cause;
    throw error;
  }
}
__name(assertProviderSemanticResponse, "assertProviderSemanticResponse");
function isTargetedRepairFallback(request) {
  const system = String(request?.systemInstruction || "");
  return system.includes("MASTER V4.5 TARGETED REPAIR ADAPTER") || system.includes("targeted repair editor");
}
__name(isTargetedRepairFallback, "isTargetedRepairFallback");
function parseTargetedRepairInput(request) {
  if (!isTargetedRepairFallback(request)) return null;
  try {
    const parsed = JSON.parse(String(request?.userContent || ""));
    if (!parsed?.article || typeof parsed.article !== "object") return null;
    if (!Array.isArray(parsed?.issues) || parsed.issues.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}
__name(parseTargetedRepairInput, "parseTargetedRepairInput");
function htmlParts(value) {
  const source = String(value || "");
  const blocks = [];
  const gaps = [];
  let cursor = 0;
  let index = 0;
  let match;
  const re = new RegExp(HTML_BLOCK_RE.source, HTML_BLOCK_RE.flags);
  while (match = re.exec(source)) {
    gaps.push(source.slice(cursor, match.index));
    index += 1;
    blocks.push({ index, tag: String(match[1] || "").toLowerCase(), raw: match[0] });
    cursor = re.lastIndex;
  }
  gaps.push(source.slice(cursor));
  return { source, blocks, gaps };
}
__name(htmlParts, "htmlParts");
function normalizedLocation(value) {
  return String(value || "").trim();
}
__name(normalizedLocation, "normalizedLocation");
function targetForLocation(article, parts, location) {
  if (TARGETED_REPAIR_FIELDS.has(location)) {
    return { location, currentValue: article[location] };
  }
  const match = location.match(EXACT_HTML_LOCATION_RE);
  if (!match) return null;
  const tag = String(match[1] || "").toLowerCase();
  const index = Number(match[2]);
  const block = parts.blocks[index - 1];
  if (!block || block.index !== index || block.tag !== tag) return null;
  return {
    location,
    currentValue: block.raw,
    previousContext: parts.blocks[index - 2]?.raw || null,
    nextContext: parts.blocks[index]?.raw || null
  };
}
__name(targetForLocation, "targetForLocation");
function buildTargetedRepairRequest(request) {
  const input = parseTargetedRepairInput(request);
  if (!input) return { request, context: null };
  const article = input.article;
  const parts = htmlParts(article.html);
  const issuesByLocation = /* @__PURE__ */ new Map();
  for (const issue of input.issues) {
    const location = normalizedLocation(issue?.location);
    if (!location) continue;
    if (!issuesByLocation.has(location)) issuesByLocation.set(location, []);
    issuesByLocation.get(location).push(issue);
  }
  const targets = [];
  for (const [location, issues] of issuesByLocation.entries()) {
    const target = targetForLocation(article, parts, location);
    if (!target) continue;
    targets.push({ ...target, issues });
  }
  if (targets.length === 0) return { request, context: null };
  const systemInstruction = `${String(request.systemInstruction || "")}

--- TARGETED PATCH OUTPUT CONTRACT ---
Do NOT return the full Article. Return JSON only as {"patches":[{"location":"exact supplied location","value":"replacement"}]}. Return exactly one patch per distinct supplied target location and no other locations. For title, searchDescription, language, and topic, value is the replacement plain string. For labels and sources, value must itself be a valid JSON-array string. For an HTML target such as "html p 3", value must be exactly one complete replacement block with the same tag as the target, for example <p>...</p>. Preserve the requested language and do not add markdown fences or commentary.`;
  const compactUserContent = JSON.stringify({
    articleContext: {
      title: article.title,
      searchDescription: article.searchDescription,
      labels: article.labels,
      sources: article.sources,
      language: article.language,
      topic: article.topic
    },
    targets,
    strategy: input.strategy || null,
    repairAttempt: input.repairAttempt || null,
    maxRepairAttempts: input.maxRepairAttempts || null,
    sourcePost: input.sourcePost || null,
    preserve: input.preserve || null,
    seoBrief: input.seoBrief || null
  });
  return {
    request: {
      ...request,
      systemInstruction,
      userContent: compactUserContent,
      maxOutputTokens: Math.max(2048, Math.min(Number(request?.maxOutputTokens || 4096), ROLE_OUTPUT_TOKEN_CAP)),
      responseSchema: TARGETED_REPAIR_PATCH_SCHEMA,
      responseFormat: { type: "json_object" }
    },
    context: {
      article,
      parts,
      targetLocations: new Set(targets.map((target) => target.location))
    }
  };
}
__name(buildTargetedRepairRequest, "buildTargetedRepairRequest");
function targetedPatchError(reason) {
  const error = new Error("GEMINI_REQUEST_FAILED");
  error.status = 502;
  error.cause = new Error(reason);
  return error;
}
__name(targetedPatchError, "targetedPatchError");
function parseJsonArrayString(value, location) {
  try {
    const parsed = JSON.parse(String(value || ""));
    if (!Array.isArray(parsed)) throw new Error("not-array");
    if (location === "labels" && !parsed.every((item) => typeof item === "string")) throw new Error("labels-not-strings");
    return parsed;
  } catch {
    throw targetedPatchError(`REPAIR_PATCH_${location.toUpperCase()}_INVALID`);
  }
}
__name(parseJsonArrayString, "parseJsonArrayString");
function expandTargetedRepairResult(result, context) {
  if (!context) return result;
  let parsed;
  try {
    parsed = parseJsonText(String(result?.response || "").trim());
  } catch {
    throw targetedPatchError("REPAIR_PATCH_JSON_INVALID");
  }
  const patches = Array.isArray(parsed?.patches) ? parsed.patches : null;
  if (!patches) throw targetedPatchError("REPAIR_PATCHES_REQUIRED");
  const article = { ...context.article };
  const replacements = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  for (const patch of patches) {
    const location = normalizedLocation(patch?.location);
    if (!context.targetLocations.has(location) || seen.has(location)) {
      throw targetedPatchError("REPAIR_PATCH_LOCATION_INVALID");
    }
    if (typeof patch?.value !== "string") throw targetedPatchError("REPAIR_PATCH_VALUE_INVALID");
    seen.add(location);
    if (TARGETED_REPAIR_FIELDS.has(location)) {
      if (location === "labels" || location === "sources") {
        article[location] = parseJsonArrayString(patch.value, location);
      } else {
        const value = String(patch.value).trim();
        if (!value) throw targetedPatchError(`REPAIR_PATCH_${location.toUpperCase()}_EMPTY`);
        article[location] = value;
      }
      continue;
    }
    const match = location.match(EXACT_HTML_LOCATION_RE);
    if (!match) throw targetedPatchError("REPAIR_PATCH_HTML_LOCATION_INVALID");
    const tag = String(match[1] || "").toLowerCase();
    const index = Number(match[2]);
    const block = context.parts.blocks[index - 1];
    if (!block || block.index !== index || block.tag !== tag) throw targetedPatchError("REPAIR_PATCH_HTML_TARGET_MISSING");
    const replacement = String(patch.value).trim();
    const sameTag = new RegExp(`^<${tag}\\b[^>]*>[\\s\\S]*<\\/${tag}>$`, "i");
    if (!sameTag.test(replacement)) throw targetedPatchError("REPAIR_PATCH_HTML_BLOCK_INVALID");
    replacements.set(index, replacement);
  }
  for (const location of context.targetLocations) {
    if (!seen.has(location)) throw targetedPatchError("REPAIR_PATCH_INCOMPLETE");
  }
  if (replacements.size > 0) {
    let html = context.parts.gaps[0] || "";
    for (let index = 0; index < context.parts.blocks.length; index += 1) {
      const block = context.parts.blocks[index];
      html += replacements.get(block.index) || block.raw;
      html += context.parts.gaps[index + 1] || "";
    }
    article.html = html;
  }
  return { ...result, response: JSON.stringify(article) };
}
__name(expandTargetedRepairResult, "expandTargetedRepairResult");
function shouldFallbackFromCloudflare(error) {
  return CLOUDFLARE_FALLBACK_ERRORS.has(String(error?.message || ""));
}
__name(shouldFallbackFromCloudflare, "shouldFallbackFromCloudflare");
function shouldFallbackFromGemini(error) {
  return GEMINI_FALLBACK_ERRORS.has(String(error?.message || ""));
}
__name(shouldFallbackFromGemini, "shouldFallbackFromGemini");
async function runGeminiWithRetry(env, request, fetchImpl, validateResponse = null) {
  const hardened = buildTargetedRepairRequest(request);
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const raw = await runGeminiAi(env, hardened.request, fetchImpl);
      const expanded = expandTargetedRepairResult(raw, hardened.context);
      const result = assertProviderSemanticResponse(assertJsonOnlyResponse(expanded, hardened.request, "GEMINI_JSON_INVALID"), validateResponse, "GEMINI_JSON_INVALID");
      return {
        ...result,
        geminiAttempts: attempt,
        geminiRetryUsed: attempt > 1
      };
    } catch (error) {
      lastError = error;
      if (attempt >= 2 || !shouldFallbackFromGemini(error)) throw error;
      await sleep(geminiRetryDelayMs(env));
    }
  }
  throw lastError || new Error("GEMINI_REQUEST_FAILED");
}
__name(runGeminiWithRetry, "runGeminiWithRetry");
function freeAiRoleForRequest(request = {}) {
  const system = String(request?.systemInstruction || "");
  if (system.includes("MASTER V4.5 CRITIC ADAPTER") || system.includes("publication critic")) return "critic";
  if (system.includes("MASTER V4.5 REPAIR ADAPTER") || system.includes("targeted repair editor")) return "repair";
  return "writer";
}
__name(freeAiRoleForRequest, "freeAiRoleForRequest");
function compactFreeAiSystem(systemInstruction) {
  const system = String(systemInstruction || "");
  for (const marker of [
    "--- SERVER AUTOMATION ADAPTER ---",
    "--- MASTER V4.5 CRITIC ADAPTER ---",
    "--- MASTER V4.5 REPAIR ADAPTER ---"
  ]) {
    const index = system.indexOf(marker);
    if (index >= 0) return system.slice(index);
  }
  return system.length > 12e3 ? system.slice(-12e3) : system;
}
__name(compactFreeAiSystem, "compactFreeAiSystem");
function defaultFreeAiRequest(env, request) {
  if (!request) return null;
  const role = freeAiRoleForRequest(request);
  return {
    ...request,
    model: freeAiModel(env, role),
    systemInstruction: compactFreeAiSystem(request.systemInstruction),
    maxOutputTokens: Math.max(512, Math.min(Number(request?.maxOutputTokens || 4096), ROLE_OUTPUT_TOKEN_CAP)),
    responseFormat: { type: "json_object" }
  };
}
__name(defaultFreeAiRequest, "defaultFreeAiRequest");
async function runFreeAiFallback(env, request, fetchImpl, validateResponse = null) {
  const hardened = buildTargetedRepairRequest(request);
  const messages = [
    ...String(hardened.request?.systemInstruction || "").trim() ? [{ role: "system", content: String(hardened.request.systemInstruction) }] : [],
    { role: "user", content: String(hardened.request?.userContent || "") }
  ];
  const raw = await runFreeAi(env, {
    model: hardened.request?.model,
    messages,
    maxTokens: Math.max(256, Math.min(Number(hardened.request?.maxOutputTokens || 4096), ROLE_OUTPUT_TOKEN_CAP)),
    temperature: hardened.request?.temperature,
    responseFormat: hardened.request?.responseFormat || (hardened.request?.responseSchema ? { type: "json_object" } : void 0)
  }, fetchImpl);
  try {
    const expanded = expandTargetedRepairResult(raw, hardened.context);
    return assertProviderSemanticResponse(assertJsonOnlyResponse(expanded, hardened.request, "FREE_AI_REQUEST_FAILED"), validateResponse, "FREE_AI_REQUEST_FAILED");
  } catch (error) {
    if (String(error?.message || "") === "GEMINI_REQUEST_FAILED") {
      const wrapped = new Error("FREE_AI_REQUEST_FAILED");
      wrapped.status = 502;
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}
__name(runFreeAiFallback, "runFreeAiFallback");
async function runPrimaryWithGeminiFallback(env, { cloudflare, gemini, freeai = null }, aiBinding = env?.AI, fetchImpl = fetch, validateResponse = null) {
  const primaryProvider = String(env?.TEXT_PRIMARY_PROVIDER || "cloudflare").trim().toLowerCase();
  if (primaryProvider === "gemini") {
    try {
      const result = await runGeminiWithRetry(env, gemini, fetchImpl, validateResponse);
      return {
        ...result,
        provider: "google-gemini",
        fallbackUsed: false,
        primaryError: null
      };
    } catch (error) {
      if (!shouldFallbackFromGemini(error)) throw error;
      const freeAiRequest = freeai || defaultFreeAiRequest(env, gemini);
      const freeAiEnabled = Boolean(freeAiRequest) && freeAiFallbackEnabled(env) && freeAiConfigured(env);
      let freeAiError = null;
      if (freeAiEnabled) {
        await sleep(geminiRetryDelayMs(env));
        try {
          const result = await runFreeAiFallback(env, freeAiRequest, fetchImpl, validateResponse);
          return {
            ...result,
            provider: "free-ai",
            fallbackUsed: true,
            primaryError: String(error?.message || "GEMINI_PRIMARY_FAILED")
          };
        } catch (fallbackError) {
          freeAiError = fallbackError;
          if (!shouldFallbackFromFreeAi(fallbackError)) throw fallbackError;
        }
      }
      const cloudflareEnabled = String(env?.TEXT_CLOUDFLARE_FALLBACK_ENABLED || "false") === "true";
      if (!cloudflareEnabled) throw freeAiError || error;
      if (freeAiEnabled) await sleep(geminiRetryDelayMs(env));
      try {
        const raw = await runWorkersAi(env, cloudflare, aiBinding);
        const result = assertProviderSemanticResponse(assertJsonOnlyResponse(raw, cloudflare, "CLOUDFLARE_AI_JSON_INVALID"), validateResponse, "CLOUDFLARE_AI_JSON_INVALID");
        return {
          ...result,
          provider: "cloudflare-workers-ai",
          fallbackUsed: true,
          primaryError: String(error?.message || "GEMINI_PRIMARY_FAILED"),
          secondaryError: freeAiError ? String(freeAiError?.message || "FREE_AI_FAILED") : null
        };
      } catch (fallbackError) {
        throw fallbackError;
      }
    }
  }
  try {
    const raw = await runWorkersAi(env, cloudflare, aiBinding);
    const result = assertProviderSemanticResponse(assertJsonOnlyResponse(raw, cloudflare, "CLOUDFLARE_AI_JSON_INVALID"), validateResponse, "CLOUDFLARE_AI_JSON_INVALID");
    return {
      ...result,
      provider: "cloudflare-workers-ai",
      fallbackUsed: false,
      primaryError: null
    };
  } catch (error) {
    if (!shouldFallbackFromCloudflare(error) || !String(env?.GEMINI_API_KEY || "").trim()) throw error;
    const result = await runGeminiWithRetry(env, gemini, fetchImpl, validateResponse);
    return {
      ...result,
      provider: "google-gemini",
      fallbackUsed: true,
      primaryError: String(error.message)
    };
  }
}
__name(runPrimaryWithGeminiFallback, "runPrimaryWithGeminiFallback");

// src/master-v45/chunk-01.js
var chunk_01_default = "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";

// src/master-v45/chunk-02.js
var chunk_02_default = "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";

// src/master-v45/chunk-03.js
var chunk_03_default = "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";

// src/master-v45/chunk-04.js
var chunk_04_default = "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";

// src/master-v45/chunk-05.js
var chunk_05_default = "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";

// src/master-v45/chunk-06.js
var chunk_06_default = "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";

// src/master-v45/chunk-07.js
var chunk_07_default = "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";

// src/master-v45/chunk-08.js
var chunk_08_default = "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";

// src/master-v45/chunk-09.js
var chunk_09_default = "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";

// src/master-v45/chunk-10.js
var chunk_10_default = "Jer1nknsVzNxbmjglcmP/u5CoXKuNDE0eGjyo+TA371XroyBSTYAf0yVx0tjyUtjY2NyNF+BuZmeGho4ALf1HM0liaqXJyY44iqL+Fq/qp1wCeqcCfwfqpyvFWgWXu95CdtN5Md84LjnaBxKfq2/cPS1ftRT03e/X7yYxyKPqZ6jPh0Gq5U0Dm9vfq2f1N5+UpRNVpWUvPRQzS7j8/A893DfuCh13BfypTPVZIW5ag3X+C0kO/b/2LAErTfBh2+Ga32oz3TpdnF6PWLqp9UkpGY6xC4Dpcy3YPaOSGskDrmUKH4Qh1kOffwKFekxKlJwypUPoqoFgtG7Acl+W7JtMQIfsx88YUp280+BQL7RSIIvtfmnDhn0KkKWHQDCQ92B+hfA368c+P9vvYxwqdRQg3IgnyUDR4ZedVXvKVhxjufApJEydeVTZPXXdhSU3Kv2aue6RSGvdIsvpN6ipKoztHzU5sDnUfYoPCTb1d7/gtu1x0ZC6iZy4zVAzbfuMhDWilK9yPBCcmgnI2TZjVgvtWcXRD1OPwn8AlJlRIxjZGQELTMyEpOpyujrPb8dPnbmV8MnkxNvD//8OI7ndz0J8Ouj9pJ9zk2OF0aL58vjY9gWmc7BK5w7232oAIMGH9kFGNdrUQN2H7GCgkiLVxD9QyJFPh7vVkOUao75aIpkQL/xkxzyKY1ZIhYue5miCDL3zC1YnrpxDqaH6QJfdrDtb+eCbOyM9by80l59JMNhIYDh6hWVRFT8ihtXw/Wxa88t7/+Tz9tB0ZAlnD+U/JaRCijVSJ3UrqzE38Rgskk+L2t6MPhOAjUI+kn3JsMnz/Qm4nXo1Z0NTJTMOfGQdJ4toTMPXdmYAX+TOHWzgY2qO+vcgcNhSeh+yvR3jZwYH58G0VSgLLbSBbB6CSS3UiSaTN4rni1Xiskk5XVTcteIopBZjubJyAcnpaeUlPKxYcWQhZx3szAjoa0sP0hgvUTyfKWu3cVG/BbqOTpiZYLE3qnH1Q0CB3WkzdwCu7+SipGyNw4dBpWpWCknJ3A2OEM5ZsqoPbCrSBWIUGfAJLp8Ybx0bmJolOqIRTmA4ZLs7sY06GRhvAonf1GoTleoyZ9LNZDzVdR64QqXhAArR8fk/Ielser513tQGPCB80WsYXu9BwQDHxgvk0r3ek+xgJ3Y6djZYnX0/GSlVK6Uqhdf7zkPt/AJ+UB6Kig6B/7q7/h5Q4XpajnWgwadHuRdZ/qEs6DH5qdK/1ocGoBZ+rvR8ni5MvTSkSNHROHKV8uTQ6/oA5Lkzze3k9+iIjMN0yDP+l3yN5wNDRtwmM9wHevv/pb0msBh16/evFwsK8gF5ko4lEt5r0Jd25dvNExctrt5t1ojUtO3+NwTIJQfvMNAB+je2du5OZCG2X7vrNzQtJ9uCpoAjWXoaUT0f5npCfZw1xlK6RXCMJBPr5p+EpzJEDd9SLHwHzHbf9FpzuS6wGQQSFUMUP3w/0t4ynjhXy/+X8Q5snUwbRaUrv5TB6zLPNmn9a0InJf7KN37TOH9YuHDwsUpn/FM5ktGwsKLmq6u2GHopbNHzr589pXn2q3BQLpareSL2N+WzNpL3fdNKg0xOwHvEBYganmJybSLq5/5kox58zGc7E3mJvMITIzM1XjxbHXokDf/Dx8+LHM2efTPM41/1C54+FhiKTA7f55ZIWcNXESRIuRBAdW91i8RpH4bVsoFJf5aQrMv8bzaR8Z+cgxbXUa58inonR9JRj/KA+JHFZDR5FG9gOoRhtzJRB1cwUVSqvC8y9TLkXHdf5M0OZcCk/rEgd9c2v3PmUzqPHzAAPt74LgbjbiEgcmWFFoKIGZU39ulQZi5s+PlD/MfMecMV4cnnZ6TwXFllYBljhcmp4pD+kNZpUYuk4T/quhPOnX0WKFaPFeuXHytH4OZ9sxw+tDP7CH4Lc/Co+4dGiHNfN/Y0RPV4gW4fiw8Skv5nIPB+/Qd8FMCtEIEulII425xlRwvcU5cVsEk";

// src/master-v45/chunk-11.js
var chunk_11_default = "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";

// src/master-v45/chunk-12.js
var chunk_12_default = "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";

// src/master-v45/chunk-13.js
var chunk_13_default = "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";

// src/master-v45/chunk-14.js
var chunk_14_default = "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";

// src/master-v45/chunk-15.js
var chunk_15_default = "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";

// src/master-v45/chunk-16.js
var chunk_16_default = "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";

// src/master-v45/chunk-17.js
var chunk_17_default = "uB6cz9QoEil/ppcG1mX5wn7SLK20ixkg/sI8644CY1Q3cH5GMJGdSU1hUXlAtV+6s5BDQrIxXFBb8hwwX5h0exYWoNzTy1qoP3Gs9dqOtAOTz3lz+Je+TpRVFvjRzRsb+xkl1JtL+bhNcrxPsSKC0OyVlG2Xt8oVptK2uEBC54ZLcHCArK7eFi0/VtE4F8KqaLK9N4PZhDnoppGFvHRjQyEn5hsO/s8VS6zWXMEZ0AMi4jT2Ppujnx4xVfPadrjUhqMATncPjDROM0GVXQwB0fA8UlxtFeF6pc42G1NBdGuZIK21oTgDlcFsSRv0m1xe8p+LaqAjMYajaTlF4AdbYSEPIWZFRodYgSYGvQnsZSZbAU9ZmXnSZXEjAJNmwkLOgIWoTALiseDwZefbZVCzcB5jKyEfK5vKZo/0dWmg2tm4gb4MTV1WvAFR+2vwcsyE+Q9fvGXKw32YXVVYRJ1nAs9WUDPHMJQMYAlCvlsb1yEMU8CmTLD2XrP1TcpQelypiEQwuTKX5ALs6jph9Vw/jGs4Od+EAWHk0PxaZ/tr+V2fw11U99WW7jela7A04pLWR1vtjfWEayupNJGfwHWWwQvArL9XD4cB4mYNvWZSPGOey9E3zIAO37ZImsc8gnApj+LrKYUFHgU8fTsc4t7tOqgXcOrxJtBa+BbiBjQdN2+EZ4BlfLEoyk145tYWxWCpn6McCjm4HKQkI8yObsFsyDGOfKNucnspeGocvqEqYME3zqjYlVbkBLoFl9fTLn1TauoJ2tgVTBU4PS6rwqh+Tm5lSEmXCSHCMnTDiMpGta9cPcyNyZ8RU/1sHRu+u/bMa5H4ygXP4oeEYNUiuFL7Ip2agMtSNwjSyFmbf6IPAMm7uuCSqsSB7bSY4BKmb4JPg+3BOKfLz6RwlaSmexjRt7WCdcb9JeL0rzVwJ11bZ7NGcU7Dp7EDXpUaThvjglrVuC0kgHmNY5Qv92UFnVG2BjFnZQYObIjCLVm3cm5+BJQqgEQEdUd+mnTjvS6PMtQsqU1CFcEaSoIcc8rbMxZujuGA8o631z5XHxrYV5dn2XEWuN2yhSM+VTBWJNDpXXxkTXptkHAGMwF/Qw9snuWpQw7VPDXnnSRnpNFmuqyUd14EooE2ZGTjshJgV5YiYA9bFH60E7/3BfZRkcH0sm6FiRWmlyUxemXM8C9xV8oKMa1vN+612SYXAGLxpX/adHNiaCAuSchql4TZeUsZ0laKiHgNaEWuLgjWm2vPGgLgq4qWGWmKWnti7tlXV2DI4VQoyHOvhndZcbV1OOkg0St9UWUko81yHfGK32O8kW0AyvEoQQohx6zJI3TBNlKH9am091DRJG+dJuy5snHV4jObl8U7Wb159GxanwyeypVJEiMVRLinZp9SZE0Pof4mv6nujH/joDJYKsFq1gJcDyzFgVtCKBZi+grEfZULAzhg0DAp+0H9jcQi4w7CAVEQv/3+MQIubyPl31na3UGlAb5xrg4PxUOYEei2BI1aNRjWMZwSQmoFaxXwF6kSzMKx8k2ZP2nAOg2st1D32PY9LDmu7dD7YfR7t+q08wKiiYBmXJMEv3p7154Ql/zyKekHXFORjv8L4WLFiPeKcn4yMSB2Uyg4VVAawUWMDdFMwCAkc8LV43fmsPmVC2uoA9oIDBj1vOvup8AWP4BU/bsyExvY6ntYM+nWtIRcxuX8DNi6C7Wc8ErQPT6bUzqgXGtYg92dT8KrSBENDmE6zBeLVDOmJchU+RbeV9/kMmako3VMf5but+4CgSshqiQjVLYAqwVynWTQEOWTo5yuJFYTKoloIdwPnTh1hqzRBaW6TPHRD9MyCeq2y7gLXJxoQRKxMybKGmg6EsX5GYUtPl0yAd3Y8R08CikH4+6Wf1ifokKcBEume8gkuMw3jJfMVG2E1pDQuIbfMJK+Q+4DaWcWuLB8UwHQzJdbDjOQbXF28RtxyHFxRanb0laLqb326oE+hehw6ZaUCIjZTsw8GjaD";

// src/master-v45/chunk-18.js
var chunk_18_default = "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";

// src/master-v45/chunk-19.js
var chunk_19_default = "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";

// src/master-v45/chunk-20.js
var chunk_20_default = "WZRj0tZ08bKNaosoLC3hZFeLhehTiiIZ1Wd5RNH2Vmu3xYG02hMskLZjJzv5+8coKkDnVqMy8NqgwkJ8Sp2B7k3sqRHftILMcwX85VmPD+80c9rFNhmD+6OR1SxPl8LEE294cpTCTzykb+7moJHEizwZmM4kjTHbDP1oFZqHBIDZ4uw4VnFadmNmirBsrkFcS2rtmpsIaq1J5y0TcrNN7skyEF+HsB0Opxi1KBC5XGjmTT5TzGzlbppnvtoXIjBy1jDySGmI9EXNwcmImp5qNGaisxanktSIbrCOPi3MIztlFN6nlVb9YEs4yfCpEyymv5FW8vPr4rnChCfvVGFI/P20kLQJmY1P+ULwZG+dOXPKrYmbAsU2INdoBgijK7QSIMP9GCvXuxhoMPT/Mg9yB+E6IHTcTAJPGO8zHxREuSyNT8QPplr5sTPDkpLqSi8Fdo+fsHojo4TXHe1W8GxasDFAILdRT6GDahN4SVCse0xRe3kuXqRM5IksoKqe/UEMFQ9gX0hF3lADBw70aUUDxdI4VVXhrD2+rdpnrnTW5Z+ZQiDchx6EsDtwg2H1DvGbO6hy+zwkgSBXLk5+bd9DD4SfuMfowHj31NtcnYh54QS2zWCEUj6x8ojTvhiWUHyYDtUQHxfBGoqQwkWn4ni6mPASfSCFUkJBzJprEOiYYCJ93iM5Am5QkkKte29ZeTgnmKYAE/dFmfPJ6aCWCs4O7AXUUTOxhNV46fEYkMmrB+BHjy9oMWP4PDu/0w03+CREcLmp286+AP0XNc73aNTUx3hnyfXmIt7ZE2bU5oQHMokaqLauQLe9djKIWnvT40M/riifWdNjtofBId9qaYWG6DrbCxxYdpq5KSyXJiHsvHTeEg3TuubeApNNWfxplgwvZ1dW2DpphQBBwK5ndG10KhhBS45wJN9Be3fQtYnUuajJk1TQuexKwlIkTwg+62Dc5cRbmFYccGKo0k33oR3q644rJ0Urd7WdK5oufNfhPg+THrYm8NhF8Z5AUuS7j/Rl0oFLD9B9S31GySrjmlhcTSJCj3yY8iW6D3vZ6SekU7Z8TEukGyZBaox4cvq98dLU+cJ740UOceJyeoedeygYiuKpoannCY9w5vuPlS9cAEkVOnCkfwRFcqOHgiY18ltjlf8Ou8+IHwJ/kWuBi6G884ZcNmrciy/Fub3wqQO+Cw2OJOhBRUDtoRPHlDUhmIMvIXXDxAZPGY0i6dusmSYplcfHSjArpcJ4cqZYuEBBSs63Zd82GRGcNxf5SeF7Uq/GjD1+bPBeDz2FBfp+bOSqIzOTNRpeClYw9vnAg31dslIsN722RLWeCgOEtsQ+MFJ8gWflKVHs3455hCm8DBFujoqAQ2ImEGzkW7qbsL1Uyn7guuzQ1+aSCW5LHhUWKgZOA7dDc7L1GZGIWyPYzcrQdcJvRC74xKOA44pzmp0xxqwRa+hBZANF+pbcAAr9yJ/vrP3XzvXQRBlxUQtrzRAZuey87axECKI8lRpcj7GKwRX1+HPLH9RoNxjW5BOJumBC4hMk3PYDLJJlV3bkxdfIieRrqY/LQarXyZrebmpRQhwi/V+QjwoIYmwBAA==";

// src/lib/master-v45-bundle.js
var MASTER_V45_GZIP_BASE64 = [
  chunk_01_default,
  chunk_02_default,
  chunk_03_default,
  chunk_04_default,
  chunk_05_default,
  chunk_06_default,
  chunk_07_default,
  chunk_08_default,
  chunk_09_default,
  chunk_10_default,
  chunk_11_default,
  chunk_12_default,
  chunk_13_default,
  chunk_14_default,
  chunk_15_default,
  chunk_16_default,
  chunk_17_default,
  chunk_18_default,
  chunk_19_default,
  chunk_20_default
].join("");
function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
__name(base64ToBytes, "base64ToBytes");
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
__name(gunzip, "gunzip");
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
var cachedMaster = null;
async function loadMasterV45() {
  if (cachedMaster) return cachedMaster;
  const bytes = await gunzip(base64ToBytes(MASTER_V45_GZIP_BASE64));
  if (bytes.byteLength !== MASTER_V45.size) {
    throw Object.assign(new Error("MASTER_V45_SIZE_MISMATCH"), { status: 500, meta: MASTER_V45 });
  }
  const digest = await sha256Hex(bytes);
  if (digest !== MASTER_V45.sha256) {
    throw Object.assign(new Error("MASTER_V45_SHA256_MISMATCH"), { status: 500, meta: MASTER_V45 });
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  cachedMaster = text;
  return text;
}
__name(loadMasterV45, "loadMasterV45");
async function masterV45RuntimeStatus() {
  await loadMasterV45();
  return { bundled: true, sha256: MASTER_V45.sha256, size: MASTER_V45.size };
}
__name(masterV45RuntimeStatus, "masterV45RuntimeStatus");

// src/lib/master-v45-role-prompts.js
var ROLES = Object.freeze(["writer", "critic", "repair"]);
var ROLE_SET = new Set(ROLES);
var cache = /* @__PURE__ */ new Map();
function utf8Bytes(value) {
  return new TextEncoder().encode(String(value || ""));
}
__name(utf8Bytes, "utf8Bytes");
async function sha256Hex2(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex2, "sha256Hex");
function topLevelSectionCount(text) {
  return [...String(text || "").matchAll(/^# .+$/gm)].length;
}
__name(topLevelSectionCount, "topLevelSectionCount");
function rolePromptDefinition(role) {
  const key = String(role || "").trim();
  if (!ROLE_SET.has(key)) {
    throw Object.assign(new Error("MASTER_V45_ROLE_INVALID"), { status: 500 });
  }
  return Object.freeze({
    role: key,
    fileName: MASTER_V45.fileName,
    size: MASTER_V45.size,
    sha256: MASTER_V45.sha256,
    integratedMaster: true,
    exactFullMaster: true
  });
}
__name(rolePromptDefinition, "rolePromptDefinition");
async function loadMasterV45RolePrompt(role) {
  const key = String(role || "").trim();
  if (cache.has(key)) return cache.get(key);
  const definition = rolePromptDefinition(key);
  const sourceText = await loadMasterV45();
  const sourceBytes = utf8Bytes(sourceText);
  if (sourceBytes.byteLength !== MASTER_V45.size) {
    throw Object.assign(new Error("MASTER_V45_ROLE_SIZE_MISMATCH"), {
      status: 500,
      meta: { role: key, expected: MASTER_V45.size, actual: sourceBytes.byteLength }
    });
  }
  const sourceDigest = await sha256Hex2(sourceBytes);
  if (sourceDigest !== MASTER_V45.sha256) {
    throw Object.assign(new Error("MASTER_V45_ROLE_SHA256_MISMATCH"), {
      status: 500,
      meta: { role: key }
    });
  }
  const result = Object.freeze({
    text: sourceText,
    sourceText,
    meta: Object.freeze({
      role: key,
      fileName: definition.fileName,
      size: MASTER_V45.size,
      sha256: MASTER_V45.sha256,
      sectionCount: topLevelSectionCount(sourceText),
      exactSourceSections: true,
      exactFullMaster: true,
      integratedMaster: true,
      sourceMasterSha256: MASTER_V45.sha256,
      sourceMasterSize: MASTER_V45.size,
      runtimeClarification: null,
      effectiveSize: MASTER_V45.size,
      effectiveSha256: MASTER_V45.sha256
    })
  });
  cache.set(key, result);
  return result;
}
__name(loadMasterV45RolePrompt, "loadMasterV45RolePrompt");
async function masterV45RolePromptRuntimeStatus() {
  const output = {};
  for (const role of ROLES) {
    output[role] = (await loadMasterV45RolePrompt(role)).meta;
  }
  return output;
}
__name(masterV45RolePromptRuntimeStatus, "masterV45RolePromptRuntimeStatus");

// src/lib/tavily-search.js
var TAVILY_SEARCH_URL = "https://api.tavily.com/search";
var ALLOWED_TOPICS = /* @__PURE__ */ new Set(["general", "news"]);
var ALLOWED_TIME_RANGES = /* @__PURE__ */ new Set(["day", "week", "month", "year"]);
var FRESHNESS_PATTERNS = [
  /\b20\d{2}\b/i,
  /\b(latest|current|today|recent|newest|update|updated|release|released|version|price|pricing|policy|law|regulation|support|benefit|deadline|schedule|availability|recall|security|vulnerability|ai model)\b/i,
  /\bAI\b/i,
  /(최신|현재|오늘|최근|업데이트|출시|버전|가격|정책|지원금|법률|규정|마감|일정|보안|취약점|리콜|인공지능)/i
];
var EVERGREEN_RESEARCH_PATTERNS = [
  /\b(repair|restore|restoration|replace|replacement|install|installation|troubleshoot|diagnos(?:e|is|tic)?|maintenance|fix|clean|remove|prevent|compare|comparison|versus|\bvs\b|best|guide|checklist|material|tool|floor|threshold|plumb|electric|roof|foundation|hvac|appliance)\b/i,
  /(수리|복원|교체|설치|진단|점검|유지보수|고장|해결|청소|제거|예방|비교|선택|가이드|체크리스트|재료|공구|바닥|문턱|배관|전기|지붕|기초|가전)/i
];
function freshnessSensitive(topic) {
  const text = String(topic || "").trim();
  return Boolean(text) && FRESHNESS_PATTERNS.some((pattern) => pattern.test(text));
}
__name(freshnessSensitive, "freshnessSensitive");
function substantiveEvergreen(topic) {
  const text = String(topic || "").trim();
  return Boolean(text) && EVERGREEN_RESEARCH_PATTERNS.some((pattern) => pattern.test(text));
}
__name(substantiveEvergreen, "substantiveEvergreen");
function httpError(code, status = 502) {
  return Object.assign(new Error(code), { status });
}
__name(httpError, "httpError");
function normalizeDomains(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean).filter((item, index, all) => all.indexOf(item) === index).slice(0, 10);
}
__name(normalizeDomains, "normalizeDomains");
function normalizeResult(result) {
  if (!result || typeof result !== "object") return null;
  const title = String(result.title || "").trim();
  const url = String(result.url || "").trim();
  const content = String(result.content || "").trim();
  if (!title || !url || !content) return null;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
  } catch {
    return null;
  }
  return {
    title: title.slice(0, 300),
    url,
    content: content.slice(0, 3e3),
    score: Number.isFinite(Number(result.score)) ? Number(result.score) : null,
    publishedDate: result.published_date ? String(result.published_date).slice(0, 64) : null
  };
}
__name(normalizeResult, "normalizeResult");
function tavilyConfigured(env) {
  return Boolean(String(env?.TAVILY_API_KEY || "").trim());
}
__name(tavilyConfigured, "tavilyConfigured");
function shouldUseTavilyResearch(topic, mode = "auto") {
  const normalizedMode = String(mode || "auto").trim().toLowerCase();
  if (normalizedMode === "off") return false;
  if (normalizedMode === "always") return true;
  if (normalizedMode !== "auto") throw httpError("TAVILY_RESEARCH_MODE_INVALID", 400);
  const text = String(topic || "").trim();
  if (!text) return false;
  return freshnessSensitive(text) || substantiveEvergreen(text);
}
__name(shouldUseTavilyResearch, "shouldUseTavilyResearch");
async function tavilySearch(env, input = {}, fetchImpl = fetch) {
  if (!tavilyConfigured(env)) throw httpError("TAVILY_NOT_CONFIGURED", 503);
  const query = String(input.query || "").trim();
  if (!query) throw httpError("TAVILY_QUERY_REQUIRED", 400);
  if (query.length > 1200) throw httpError("TAVILY_QUERY_TOO_LONG", 400);
  const maxResults = Math.max(1, Math.min(5, Number(input.maxResults || 5) || 5));
  const topic = ALLOWED_TOPICS.has(String(input.topic || "").trim()) ? String(input.topic).trim() : "general";
  const timeRangeRaw = String(input.timeRange || "").trim();
  const timeRange = ALLOWED_TIME_RANGES.has(timeRangeRaw) ? timeRangeRaw : null;
  const includeDomains = normalizeDomains(input.includeDomains);
  let response;
  try {
    response = await fetchImpl(TAVILY_SEARCH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${String(env.TAVILY_API_KEY).trim()}`
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        topic,
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
        ...timeRange ? { time_range: timeRange } : {},
        ...includeDomains.length ? { include_domains: includeDomains } : {}
      })
    });
  } catch {
    throw httpError("TAVILY_NETWORK_ERROR", 502);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw httpError("TAVILY_AUTH_FAILED", 502);
    if (response.status === 429) throw httpError("TAVILY_RATE_LIMITED", 503);
    if (response.status === 402) throw httpError("TAVILY_CREDITS_EXHAUSTED", 503);
    throw httpError(`TAVILY_SEARCH_FAILED_${response.status}`, 502);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw httpError("TAVILY_RESPONSE_INVALID", 502);
  }
  const results = (Array.isArray(payload?.results) ? payload.results : []).map(normalizeResult).filter(Boolean).slice(0, maxResults);
  return {
    ok: true,
    provider: "tavily",
    searchDepth: "basic",
    query,
    resultCount: results.length,
    results
  };
}
__name(tavilySearch, "tavilySearch");
async function collectWriterResearch(env, { topic, language, researchMode = "auto" } = {}, fetchImpl = fetch) {
  const mode = String(researchMode || "auto").trim().toLowerCase();
  const requested = shouldUseTavilyResearch(topic, mode);
  if (!requested) {
    return { requested: false, used: false, provider: "tavily", resultCount: 0, results: [] };
  }
  if (!tavilyConfigured(env)) {
    if (mode === "always") throw httpError("TAVILY_REQUIRED_BUT_NOT_CONFIGURED", 503);
    return { requested: true, used: false, provider: "tavily", resultCount: 0, results: [], unavailableReason: "not_configured" };
  }
  const fresh = freshnessSensitive(topic);
  const query = language === "ko" ? fresh ? `${String(topic).trim()} \uCD5C\uC2E0 \uC815\uBCF4 \uACF5\uC2DD \uCD9C\uCC98` : `${String(topic).trim()} \uACF5\uC2DD \uC790\uB8CC \uC2E4\uBB34 \uAC00\uC774\uB4DC \uD310\uB2E8 \uAE30\uC900` : fresh ? `${String(topic).trim()} latest official information` : `${String(topic).trim()} official guidance practical decision criteria`;
  try {
    const searched = await tavilySearch(env, {
      query,
      maxResults: 5,
      topic: /\b(news|announcement|launch|released?|today)\b/i.test(String(topic)) || /(뉴스|발표|출시|오늘)/.test(String(topic)) ? "news" : "general",
      ...fresh ? { timeRange: "month" } : {}
    }, fetchImpl);
    if (!searched.results.length) {
      if (mode === "always") throw httpError("TAVILY_NO_RESULTS", 502);
      return { requested: true, used: false, provider: "tavily", resultCount: 0, results: [], unavailableReason: "no_results" };
    }
    return {
      requested: true,
      used: true,
      provider: "tavily",
      retrievedAt: (/* @__PURE__ */ new Date()).toISOString(),
      resultCount: searched.results.length,
      results: searched.results
    };
  } catch (error) {
    if (mode === "always") throw error;
    return {
      requested: true,
      used: false,
      provider: "tavily",
      resultCount: 0,
      results: [],
      unavailableReason: String(error?.message || "TAVILY_UNAVAILABLE")
    };
  }
}
__name(collectWriterResearch, "collectWriterResearch");

// src/lib/tour-api.js
var DEFAULT_TOUR_API_BASE_URL = "https://apis.data.go.kr/B551011/EngService2";
var DEFAULT_MOBILE_OS = "ETC";
var DEFAULT_MOBILE_APP = "SmileAtlas";
var DEFAULT_ATTRACTION_CONTENT_TYPE_ID = "76";
var RESULT_CODE_MESSAGES = Object.freeze({
  "01": "TOUR_API_APPLICATION_ERROR",
  "02": "TOUR_API_DB_ERROR",
  "03": "TOUR_API_NODATA_ERROR",
  "04": "TOUR_API_HTTP_ERROR",
  "05": "TOUR_API_SERVICETIME_OUT",
  "10": "TOUR_API_INVALID_REQUEST_PARAMETER_ERROR",
  "11": "TOUR_API_NO_MANDATORY_REQUEST_PARAMETERS_ERROR",
  "12": "TOUR_API_NO_OPENAPI_SERVICE_ERROR",
  "20": "TOUR_API_SERVICE_ACCESS_DENIED_ERROR",
  "22": "TOUR_API_LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR",
  "30": "TOUR_API_SERVICE_KEY_IS_NOT_REGISTERED_ERROR",
  "31": "TOUR_API_DEADLINE_HAS_EXPIRED_ERROR",
  "32": "TOUR_API_UNREGISTERED_IP_ERROR",
  "33": "TOUR_API_UNSIGNED_CALL_ERROR",
  "99": "TOUR_API_UNKNOWN_ERROR"
});
function httpError2(code, status = 502) {
  return Object.assign(new Error(code), { status });
}
__name(httpError2, "httpError");
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
__name(sleep2, "sleep");
var TRANSIENT_HTTP_STATUSES = /* @__PURE__ */ new Set([502, 503, 504, 522, 524]);
async function fetchWithRetry(url, fetchImpl, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url);
      if (response.ok || !TRANSIENT_HTTP_STATUSES.has(response.status)) return response;
      lastError = httpError2(`TOUR_API_HTTP_${response.status}`, 502);
    } catch (cause) {
      lastError = Object.assign(httpError2("TOUR_API_NETWORK_ERROR", 502), { cause });
    }
    if (attempt < attempts) await sleep2(300 * attempt);
  }
  throw lastError;
}
__name(fetchWithRetry, "fetchWithRetry");
function tourApiConfigured(env) {
  return Boolean(String(env?.TOUR_API_KEY || "").trim());
}
__name(tourApiConfigured, "tourApiConfigured");
function requiredKey(env) {
  const key = String(env?.TOUR_API_KEY || "").trim();
  if (!key) throw httpError2("TOUR_API_KEY_REQUIRED", 503);
  return key;
}
__name(requiredKey, "requiredKey");
function safeBaseUrl(env) {
  const raw = String(env?.TOUR_API_BASE_URL || DEFAULT_TOUR_API_BASE_URL).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw httpError2("TOUR_API_BASE_URL_INVALID", 500);
  }
  if (url.protocol !== "https:" || url.hostname !== "apis.data.go.kr") {
    throw httpError2("TOUR_API_BASE_URL_NOT_ALLOWED", 500);
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}
__name(safeBaseUrl, "safeBaseUrl");
function resultCodeError(resultCode, resultMsg) {
  const code = String(resultCode || "").trim();
  if (!code || code === "0000" || code === "00") return null;
  const mapped = RESULT_CODE_MESSAGES[code] || `TOUR_API_ERROR_${code}`;
  const error = new Error(mapped);
  error.status = code === "30" || code === "32" ? 401 : code === "22" ? 429 : 502;
  error.tourApiResultCode = code;
  error.tourApiResultMsg = String(resultMsg || "").slice(0, 200);
  return error;
}
__name(resultCodeError, "resultCodeError");
function gatewayFailure(data) {
  const header = data?.cmmMsgHeader;
  if (!header) return null;
  return resultCodeError(header.returnReasonCode, header.returnAuthMsg || header.errMsg);
}
__name(gatewayFailure, "gatewayFailure");
function flatGatewayFailure(data) {
  if (!data || typeof data !== "object" || data.response || data.cmmMsgHeader) return null;
  if (!("resultCode" in data)) return null;
  return resultCodeError(data.resultCode, data.resultMsg);
}
__name(flatGatewayFailure, "flatGatewayFailure");
async function callTourApi(env, operation, params = {}, fetchImpl = fetch) {
  const key = requiredKey(env);
  const base = safeBaseUrl(env);
  const query = new URLSearchParams({
    serviceKey: key,
    MobileOS: String(env?.TOUR_API_MOBILE_OS || DEFAULT_MOBILE_OS),
    MobileApp: String(env?.TOUR_API_MOBILE_APP || DEFAULT_MOBILE_APP),
    _type: "json"
  });
  for (const [name, value] of Object.entries(params)) {
    if (value === void 0 || value === null || value === "") continue;
    query.set(name, String(value));
  }
  const response = await fetchWithRetry(`${base}/${operation}?${query.toString()}`, fetchImpl);
  const text = await response.text();
  if (!response.ok) throw httpError2(`TOUR_API_HTTP_${response.status}`, 502);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw httpError2("TOUR_API_RESPONSE_NOT_JSON", 502);
  }
  const header = data?.response?.header;
  if (header) {
    const failure = resultCodeError(header.resultCode, header.resultMsg);
    if (failure) throw failure;
    return data?.response?.body || {};
  }
  const gwFailure = gatewayFailure(data);
  if (gwFailure) throw gwFailure;
  const flatFailure = flatGatewayFailure(data);
  if (flatFailure) throw flatFailure;
  const keys = Object.keys(data || {}).slice(0, 10).join(",") || "EMPTY_OBJECT";
  throw httpError2(`TOUR_API_UNEXPECTED_RESPONSE_SHAPE:keys=${keys}`, 502);
}
__name(callTourApi, "callTourApi");
function normalizeTourApiItems(body) {
  const item = body?.items?.item;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}
__name(normalizeTourApiItems, "normalizeTourApiItems");
function cleanOverview(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}
__name(cleanOverview, "cleanOverview");
function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}
__name(firstNonEmpty, "firstNonEmpty");
function extractHomepageUrl(value) {
  const raw = String(value || "");
  const hrefMatch = raw.match(/href\s*=\s*"([^"]+)"/i) || raw.match(/href\s*=\s*'([^']+)'/i);
  const candidate = hrefMatch ? hrefMatch[1] : cleanOverview(raw);
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
__name(extractHomepageUrl, "extractHomepageUrl");
function normalizeAttractionSummary(item = {}) {
  const contentId = String(item?.contentid || "").trim();
  if (!contentId) return null;
  return {
    contentId,
    contentTypeId: String(item?.contenttypeid || "").trim() || null,
    title: cleanOverview(item?.title),
    address: firstNonEmpty(item?.addr1, item?.addr2),
    areaCode: String(item?.areacode || "").trim() || null,
    sigunguCode: String(item?.sigungucode || "").trim() || null,
    firstImage: firstNonEmpty(item?.firstimage, item?.firstimage2) || null,
    mapX: item?.mapx ? Number(item.mapx) : null,
    mapY: item?.mapy ? Number(item.mapy) : null,
    modifiedTime: String(item?.modifiedtime || "").trim() || null
  };
}
__name(normalizeAttractionSummary, "normalizeAttractionSummary");
function normalizeAttractionImages(items = []) {
  return items.map((item) => firstNonEmpty(item?.originimgurl, item?.smallimageurl)).filter(Boolean).filter((url, index, all) => all.indexOf(url) === index);
}
__name(normalizeAttractionImages, "normalizeAttractionImages");
function buildTourApiSourceUrl(contentId) {
  return `https://apis.data.go.kr/B551011/EngService2/detailCommon2?contentId=${encodeURIComponent(contentId)}`;
}
__name(buildTourApiSourceUrl, "buildTourApiSourceUrl");
function buildTourApiResearch(attraction) {
  const facts = [
    attraction.title && `Name: ${attraction.title}`,
    attraction.address && `Address: ${attraction.address}`,
    attraction.overview && `Official overview: ${attraction.overview}`,
    attraction.homepage && `Official homepage: ${attraction.homepage}`,
    attraction.telephone && `Contact: ${attraction.telephone}`
  ].filter(Boolean).join("\n");
  return {
    requested: true,
    used: true,
    provider: "tour-api",
    retrievedAt: (/* @__PURE__ */ new Date()).toISOString(),
    resultCount: 1,
    results: [{
      title: `${attraction.title} \u2014 Korea Tourism Organization official listing`,
      url: buildTourApiSourceUrl(attraction.contentId),
      content: facts.slice(0, 3e3),
      score: null,
      publishedDate: attraction.modifiedTime || null
    }]
  };
}
__name(buildTourApiResearch, "buildTourApiResearch");
function safeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
__name(safeCount, "safeCount");
async function fetchAreaBasedAttractionsPage(env, {
  lDongRegnCd,
  lDongSignguCd,
  contentTypeId = DEFAULT_ATTRACTION_CONTENT_TYPE_ID,
  numOfRows = 20,
  pageNo = 1
} = {}, fetchImpl = fetch) {
  const body = await callTourApi(env, "areaBasedList2", {
    lDongRegnCd,
    lDongSignguCd,
    contentTypeId,
    numOfRows,
    pageNo,
    arrange: "A"
  }, fetchImpl);
  return {
    attractions: normalizeTourApiItems(body).map(normalizeAttractionSummary).filter(Boolean),
    totalCount: safeCount(body?.totalCount),
    numOfRows: safeCount(body?.numOfRows),
    pageNo: safeCount(body?.pageNo)
  };
}
__name(fetchAreaBasedAttractionsPage, "fetchAreaBasedAttractionsPage");
async function getAttractionDetail(env, { contentId, contentTypeId } = {}, fetchImpl = fetch) {
  const id = String(contentId || "").trim();
  if (!id) throw httpError2("TOUR_API_CONTENT_ID_REQUIRED", 400);
  const commonBody = await callTourApi(env, "detailCommon2", {
    contentId: id,
    contentTypeId
  }, fetchImpl);
  const common = normalizeTourApiItems(commonBody)[0] || {};
  let images = [];
  try {
    const imageBody = await callTourApi(env, "detailImage2", { contentId: id }, fetchImpl);
    images = normalizeAttractionImages(normalizeTourApiItems(imageBody));
  } catch {
    images = [];
  }
  const summary = normalizeAttractionSummary(common);
  if (!summary) throw httpError2("TOUR_API_ATTRACTION_NOT_FOUND", 404);
  return {
    ...summary,
    overview: cleanOverview(common?.overview),
    homepage: extractHomepageUrl(common?.homepage),
    telephone: firstNonEmpty(common?.tel),
    images: [summary.firstImage, ...images].filter(Boolean).filter((url, index, all) => all.indexOf(url) === index)
  };
}
__name(getAttractionDetail, "getAttractionDetail");

// src/lib/article-length.js
function visibleText(html) {
  return String(html || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, " ").trim();
}
__name(visibleText, "visibleText");
function measureArticleLength(article) {
  const text = visibleText(article?.html);
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latinWords = (text.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || []).length;
  return {
    chars: text.length,
    hangulChars: hangul,
    latinWords,
    // Reported so a prompt can quote a familiar number, never used as the gate.
    approxWords: hangul > text.length * 0.15 ? Math.round(hangul / 2) + latinWords : latinWords
  };
}
__name(measureArticleLength, "measureArticleLength");
var BANDS = Object.freeze({
  ko: { floorChars: 3800, targetChars: 5500 },
  en: { floorChars: 8e3, targetChars: 11e3 }
});
var DEEP_DIVE_MULTIPLIER = 1.6;
function lengthContract(language, recommendedDepth = "standard-explainer") {
  const band = BANDS[String(language || "").trim()] || BANDS.ko;
  const deep = String(recommendedDepth || "") === "deep-dive";
  const scale = deep ? DEEP_DIVE_MULTIPLIER : 1;
  return {
    unit: "characters of visible text, excluding HTML tags",
    floorChars: Math.round(band.floorChars * scale),
    targetChars: Math.round(band.targetChars * scale),
    depth: deep ? "deep-dive" : "standard-explainer",
    note: "A floor is evidence of coverage, not a quota. Reaching it by repeating or padding is a worse failure than falling short."
  };
}
__name(lengthContract, "lengthContract");
function lengthVerdict(article, language, recommendedDepth) {
  const measured = measureArticleLength(article);
  const contract = lengthContract(language, recommendedDepth);
  return {
    ...measured,
    floorChars: contract.floorChars,
    targetChars: contract.targetChars,
    belowFloor: measured.chars < contract.floorChars,
    shortfallChars: Math.max(0, contract.floorChars - measured.chars)
  };
}
__name(lengthVerdict, "lengthVerdict");

// src/lib/ai-routes.js
var WRITER_ADAPTER = `AUTOMATION WRITER ADAPTER \u2014 this adapter overrides any interactive/questioning flow in the master prompt for this server call.
Platform is Google Blogger / Blogspot. Do not ask questions. Do not wait for user selection. Produce one complete publication-ready Article from the supplied topic and language.
Return JSON only with this exact top-level shape: {"article":{"title":"...","html":"...","searchDescription":"...","labels":["..."],"sources":[...],"language":"ko|en","topic":"...","thumbnailHook":"..."}}.
thumbnailHook is a short overlay caption rendered on top of the thumbnail image, separate from the title. It must be a short, concrete phrase in the article's language, clearly different from the title and from the topic string, not a restatement, truncation, or light rewording of either. Name the specific thing the reader gets, in the plainest words that still fit. Two things are forbidden outright. First, hype: never use \u201Cunlock\u201D, \u201Csecret\u201D, \u201Cinsider\u201D, \u201Cultimate\u201D, \u201Cguaranteed\u201D, \uC740\uBC00\uD55C \uBE44\uBC95, \uCD5C\uAC15, \uC644\uBCBD, \uAFC0\uD301 or any equivalent superlative, and no exclamation marks. Second, unsupported specifics: a figure may appear only when that exact figure is stated in the article body, so \u201CUnlock 30% Energy Savings!\u201D on an article that never measured 30%, or \u201C\uBC1C\uC5F4 10\uB3C4 \uB0AE\uCD94\uB294 \uBE44\uBC95\u201D on an article that never measured 10 degrees, is a fabricated claim printed on an image and is not acceptable. The server rejects a caption that breaks either rule and falls back to a section heading, so a plain honest phrase is always better than a rejected clever one. Keep it glanceable: at most 22 characters for Korean, at most 38 characters for other languages, no ellipsis, quotation marks, or trailing punctuation.
INTERNAL LINKS \u2014 internalLinkCandidates, when supplied, lists posts already published on this same blog, each with its real title and its real URL. Master v4.5 forbids inventing an internal URL and has you leave an HTML comment when you do not know one; these are the URLs, so use them and do not leave the comment in their place. Place two to four of them inside the body where a reader genuinely benefits, as ordinary <a href="..."> links with descriptive anchor text drawn from the sentence around them, never a bare "click here" and never a row of links bolted onto the end. Link only where the candidate is actually relevant to what the sentence is saying: three well-placed links are worth more than eight forced ones, and a candidate that fits nowhere should simply not be used. Use each URL at most once, exactly as given, and never modify it. Where no candidate is supplied or none is relevant, the Master v4.5 comment placeholder remains correct.
PUBLICATION METADATA \u2014 write the byline and closing blocks exactly as Master v4.5 requires, but leave every date in them as the literal token [DATE]. You do not know when this post will be published: publication is scheduled by the server well after you finish drafting, and the server substitutes the real date into those blocks before publishing. A date you write there is a guess and it will be wrong -- 12 of 14 published articles that carried one contradicted their own publication date, one of them by six months, and Blogger renders the true date beside it, so the page showed two dates that disagreed. Never write an actual month, day or year after Published:, Last updated:, Updated:, \uAC8C\uC2DC\uC77C: or \uC791\uC131\uC77C:. A date belongs in the body only when it is part of the subject matter -- the effective date of a regulation, the model year of a product, the date a cited document was issued.
The html field must contain only the Blogger post body, not <html>, <head>, or <body>. The title field is the Blogger post title and the Blogger theme/page template supplies the page-level heading; do not duplicate the title as an <h1> inside html. For language=en, write a natural search-oriented English title and do not default to "How to". Use "How to" only when the reader is genuinely looking for a procedural or step-by-step task. For explanation, diagnosis, comparison, selection, timing, cost, suitability, definition, or troubleshooting intent, choose the most natural title form for the query, including Why, What, Which, When, Can, Should, Is/Are, Does/Do, How Much, How Long, How Often, or a concise non-question title. Avoid formulaic repetition and preserve the supplied topic/search intent rather than forcing an awkward question word. Use <h2> for the first body section heading when a heading is needed. Do not use placeholders, invented URLs, invented quotations, invented first-hand experience, or unsupported current claims. Keep prose practical, answer-first, skimmable, and less academic/manual-like. If current facts cannot be verified from the supplied context, avoid asserting them as current facts. SearchDescription must be concise plain text. labels and sources must always be arrays.
CONTENT COMPLETENESS GATE \u2014 before producing the final JSON, silently identify the reader's primary decision or action and the essential subquestions that must be answered for that reader to act confidently. A valid structure is not enough. Cover every applicable core dimension with concrete, non-redundant substance: the direct answer or recommendation; why it works or what causes the problem when relevant; decision criteria and meaningful trade-offs; practical steps in the order they should be done; prerequisites, materials, cost/time factors or setup requirements when relevant; safety limits, exceptions and cases where the advice should not be used; common failure modes or mistakes; and at least one concrete example, checkpoint, or decision rule when it materially improves understanding. Omit only dimensions that are genuinely irrelevant to the topic. Do not pad to reach a word count. Use the available output budget for information gain, examples, boundaries and actionable detail rather than filler. Never omit a core answer merely to keep the article short. If a necessary current fact cannot be supported, state the limitation or use stable guidance instead of inventing it.
When a research object is supplied, treat it as the only web research performed for this request. Ground time-sensitive/current claims in those records, prefer primary or official sources when present, and never invent a source beyond the supplied research URLs. The Article.sources field must contain only sources actually used. When research was requested but unavailable, do not present unverifiable information as current fact; reframe the article around stable guidance or explicitly bounded information.
SOURCE ATTRIBUTION \u2014 name an external organisation, publication, standard, statute, or study, or state an attributed statistic, only when a supplied research record actually supports it. Where no supplied record supports it, write the guidance without the attribution or leave the claim out. Never reach for a plausible-sounding authority, a remembered study, a regulator whose remit does not cover the topic, or a wiki to make a sentence look sourced: naming a source that was not supplied is a fabrication even when the underlying fact happens to be true.
When seoBrief is supplied, use it as planning and search-intent context: follow its searchIntent, intentGoal, answerFirst, information-gain, freshness, internal-link and cannibalization guidance where applicable. SEO brief metrics are evidence for planning, not article facts to quote or invent. Never force keyword density or unsupported claims merely to satisfy the brief.
DEPTH EXPECTATION \u2014 lengthContract gives you the length this article is planned for, already counted for you in characters of visible text with HTML tags excluded. It is not a word estimate and you must not re-estimate it: floorChars is the minimum the finished body must reach and targetChars is where it should land. The same count is measured in code after you return and again when the article is reviewed, so a draft below floorChars is short as a matter of fact, not opinion. Treat that as a coverage test rather than a quota: a body below the floor means you skipped or compressed dimensions the CONTENT COMPLETENESS GATE requires, so go back and add the missing decision criteria, trade-offs, concrete examples and numbers, failure modes, exceptions and the cases where the advice does not apply. Never pad, repeat or restate to reach it -- reaching the floor with filler is a worse failure than falling short, and is treated as one. Korean runs roughly 2.4 characters per \uC5B4\uC808 and English roughly 6.3 per word, if you want a familiar check on your own draft.
When rewriteExisting is true, this is an in-place modernization of an existing Blogger post, not a patch and not a new post. Use rewriteSource only to preserve the same core subject, primary search intent, language, and important title terms. Rewrite the entire body from scratch under the current Master v4.5 and CONTENT COMPLETENESS GATE instead of imitating or lightly editing the old prose. The title may be improved modestly for clarity, natural wording, and search intent, but must remain recognizably about the same subject; do not pivot to a different angle merely to make it sound new. Do not copy old boilerplate. Do not output, alter, or invent Blogger identity fields, URLs, or post IDs; the caller preserves the existing post identity and will update that same post.
If candidateAttempt is greater than 1, this is a last-resort fresh candidate after targeted repairs were exhausted. Preserve the same topic and search intent, but produce a genuinely fresh candidate instead of echoing the failed wording. Use retryReason only as a failure signal to avoid repeating the same defect; do not mention retry mechanics in the article.`;
var CRITIC_SYSTEM = `You are a strict publication critic. Return JSON only. Evaluate factual reliability, source quality, search-intent fit, practical usefulness, substantive completeness (including whether the article's length is adequate for its content type), readability, platform-safe HTML, and whether the prose is overly academic or manual-like. Schema: {"status":"PASS|FAIL","score":0-100,"issues":[{"code":"UPPER_SNAKE_CASE","severity":"LOW|MEDIUM|HIGH|CRITICAL","location":"machine-targetable article field or html block","reason":"specific reason","repairInstruction":"specific minimal repair"}]}. PASS requires zero issues. FAIL requires at least one issue. Do not invent facts or sources.`;
var CRITIC_MASTER_ADAPTER = `AUTOMATION MASTER V4.5 COMPLIANCE CRITIC ADAPTER \u2014 this adapter overrides any article-writing, platform-selection, questioning, or interactive flow in the preceding master prompt for this server call.
Treat the entire preceding full integrated Master v4.5 as the governing publication requirements and reference checklist. This route selects the Critic role and overrides any conflicting Writer, platform-selection, questioning, or interactive execution flow from the integrated Master. Do NOT execute a writer workflow. Audit the supplied Article against every applicable publication-quality requirement in the integrated Master, not merely broad writing quality.

This server call is specifically for Google Blogger / Blogspot. The Article.title field is the Blogger post title and is rendered by the Blogger page/theme outside Article.html. Therefore absence of an <h1> element inside Article.html is NOT a defect and must never be reported as MISSING_H1_IN_HTML or an equivalent issue. A duplicate title <h1> inside the Blogger body is not required. Treat <h2> as the normal first section-heading level in Article.html.

Perform a strict compliance pass across all applicable areas, including article purpose and search intent, answer-first usefulness, factual reliability and unsupported claims, source/citation integrity, title and description quality, heading/section logic, readability and sentence density, repetition and filler, AI-like or overly academic/manual-like prose, practical usefulness, substantive completeness, tables/lists where appropriate, Blogger-safe HTML, labels, language consistency, prohibited fabrication, and every other applicable publication rule stated in the integrated Master v4.5.

CONTENT COMPLETENESS PASS \u2014 independently derive the reader's primary decision/action and the essential subquestions implied by the Article.title, topic, and seoBrief when supplied. Do not PASS an article merely because its headings and structure look complete. Verify that the body actually supplies enough concrete information for a reader to act or decide: the direct answer; applicable reasoning or cause; decision criteria/trade-offs; executable steps; relevant prerequisites/cost/time/material considerations; exceptions/safety/boundaries; common failure modes; and concrete examples/checkpoints where they materially improve the answer. Only require dimensions that are genuinely relevant to the topic. If a materially necessary core answer is missing or too vague to support action, emit code CORE_INFORMATION_MISSING. Point that issue to the single existing machine-targetable HTML block that should be expanded or replaced to supply the missing information, preferably the nearest relevant paragraph or heading block. Never use "article body" or another coarse location. The repair instruction must name the missing decision/action information, not ask for generic length or filler.

PUBLICATION DATE PLACEHOLDER \u2014 the byline and closing blocks carry the literal token [DATE] by design. The writer cannot know when the post will be published, so the server substitutes the real date at publication. [DATE] in those blocks is correct and finished work: never report it as a placeholder, an unresolved token, a missing date or an incomplete article, and never instruct anyone to replace it with a date. Reporting it wastes a repair attempt on something already handled and, because a rejected repair discards the whole batch, takes the real findings beside it with it. A [DATE] or similar token anywhere in the article body proper, outside those two blocks, is still a genuine defect.
ARTICLE LENGTH PASS \u2014 measuredLength is supplied with the Article and was counted in code, not estimated: chars is the visible text with HTML tags excluded, floorChars is the minimum this article was planned for, and belowFloor and shortfallChars state whether and by how much it falls short. Do not estimate the length yourself and do not dispute these numbers; they are measurements. When belowFloor is false the article has the planned depth and length is not a finding -- say nothing about it. When belowFloor is true the article is missing content, because the floor is set at the length the necessary coverage takes: identify which specific core decision or action dimension is thin or missing as a result and emit CORE_INFORMATION_MISSING against the block or blocks that should be expanded with concrete additional substance, naming what to add. Never emit a length finding on its own with no missing-content reason, and never instruct padding, filler or restatement to reach a number -- an article that reaches the floor by repeating itself has a worse defect than a short one, and that is the finding to emit instead.

When seoBrief is supplied, also audit the Article against applicable brief constraints such as search intent, answer-first usefulness, information gain, freshness/source requirements, internal-link intent and cannibalization avoidance. Treat brief metrics as planning evidence only, never as facts the Article was required to repeat. Do not invent a violation when the brief requirement is not applicable to the specific Article.

Run the audit as separate passes and do not collapse materially different violations into one issue. A distinct repair action must receive a distinct issue. Independently inspect at minimum: (1) title exaggeration, clickbait, guarantees, or unsupported certainty; (2) unsupported absolute claims in the body; (3) fabricated or unsupported statistics; (4) fabricated, placeholder, invalid, or unverifiable source names and URLs visible in the Article; (5) unsafe, destructive, or operationally risky instructions; (6) repetition and filler; (7) malformed or unsafe HTML; (8) misleading or overclaiming searchDescription; (9) substantive completeness and missing core decision/action information; (10) article length relative to the applicable Master v4.5 Section 26 band, reported only as CORE_INFORMATION_MISSING per the ARTICLE LENGTH PASS above, never as a standalone length defect; and (11) every other applicable Master v4.5 violation. Consolidate only exact duplicates of the same defect.

Do not reward fluent prose by assuming compliance. Actively look for concrete violations. Do not invent violations, facts, sources, or external verification. If a rule is genuinely not applicable, do not penalize it. If external verification is unavailable, never pretend that you browsed the web; judge whether the Article itself provides adequate support and whether claims are framed safely.

LOCATION CONTRACT \u2014 every issue.location must be machine-targetable. For Article.html, enumerate the supported top-level blocks <p>, <h2>, <h3>, <li>, and <blockquote> in one shared document-order sequence starting at 1, then use exactly: "html p N", "html h2 N", "html h3 N", "html li N", or "html blockquote N". N is the shared document-order block number, not a per-tag counter. For non-HTML fields use exactly one of: "title", "searchDescription", "labels", "sources", "language", or "topic". Never use only a heading title, prose fragment, "introduction", "conclusion", "section-1", "body", or another human-only location. If two different HTML blocks need changes, emit separate issues with their exact locations.

Return JSON only using exactly this schema: {"status":"PASS|FAIL","score":0-100,"issues":[{"code":"UPPER_SNAKE_CASE","severity":"LOW|MEDIUM|HIGH|CRITICAL","location":"machine-targetable location from the LOCATION CONTRACT","reason":"specific Master v4.5 compliance reason","repairInstruction":"specific minimal repair that preserves unaffected content"}]}.

PASS is allowed only when score is at least 95 AND issues is empty. Any concrete issue means FAIL, even if the numeric score is 95 or higher. FAIL must contain at least one issue. Each issue must identify a precise location and an actionable minimal repair. Return all concrete issues you can support from the supplied Article itself.`;
var REPAIR_SYSTEM = `You are a targeted repair editor. Return JSON only. Repair ONLY the exact locations identified by critic issues. Treat each issue.location as a hard edit boundary. Preserve unaffected content byte-for-byte whenever possible, preserve original meaning, Blogger identity fields, language, title unless explicitly flagged, thumbnailHook, and all verified sources. Never fabricate experience, facts, statistics, URLs, or citations. Return the complete repaired Article object.`;
var REPAIR_MASTER_ADAPTER = `AUTOMATION MASTER V4.5 TARGETED REPAIR ADAPTER \u2014 this adapter overrides any article-writing, platform-selection, questioning, or interactive flow in the preceding master prompt for this server call.
Treat the entire preceding full integrated Master v4.5 as governing publication constraints. This route selects the targeted Repair role and overrides any conflicting Writer, platform-selection, questioning, or interactive execution flow from the integrated Master. Apply every supplied critic issue, but change only the smallest affected sections necessary. Do not rewrite clean sections merely for style preference. A repair must not introduce a new Master v4.5 violation elsewhere.
The supplied issue.location values are hard edit boundaries. For HTML locations such as "html p 3" or "html h2 5", change only those exact document-order blocks. Do not reformat, reorder, normalize whitespace, change tags, or rewrite any unflagged HTML block. For field locations such as "title" or "searchDescription", change only that field. Return all unflagged Article fields and all unflagged HTML exactly as received.
For CORE_INFORMATION_MISSING, use the flagged block to add the specific missing decision rule, step, boundary, trade-off, prerequisite, or example named by the issue. Add concrete useful information, not generic filler or a longer restatement. Stay within the hard edit boundary and use only supplied/verified facts or stable guidance; if the missing fact cannot be supported, state the limitation rather than inventing it.
When seoBrief is supplied, preserve its applicable search-intent and information-gain goals while making only the flagged repair. Do not use the brief as permission to change unflagged sections or to invent unsupported facts.
This is Google Blogger / Blogspot: Article.title is rendered outside Article.html, so do not add a duplicate <h1> to the body merely because the body has no <h1>.
Return the complete repaired Article object as JSON only. Either a direct Article object or {"article": Article} is accepted by the server, but do not add prose outside JSON. Preserve title, topic, language, labels, sources, searchDescription, thumbnailHook, and unaffected HTML unless an issue specifically requires changing them. Never fabricate first-hand experience, facts, statistics, quotations, URLs, sources, or current claims.`;
var OUTPUT_TOKEN_BUDGET = Object.freeze({
  diagnostic: 256,
  writer: 12288,
  critic: 12288,
  repair: 12288
});
var GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite";
var CRITIC_PASS_MIN_SCORE = 95;
var CRITIC_SEVERITIES = /* @__PURE__ */ new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
function validateArticleShape(value, input, prefix) {
  const article = value?.article && typeof value.article === "object" ? value.article : value;
  if (!article || typeof article !== "object") throw Object.assign(new Error(`${prefix}_ARTICLE_REQUIRED`), { status: 502 });
  const requiredStrings = ["title", "html", "searchDescription", "language", "topic"];
  for (const key of requiredStrings) {
    if (typeof article[key] !== "string" || !article[key].trim()) {
      throw Object.assign(new Error(`${prefix}_ARTICLE_${key.toUpperCase()}_REQUIRED`), { status: 502 });
    }
  }
  if (!Array.isArray(article.labels)) throw Object.assign(new Error(`${prefix}_ARTICLE_LABELS_REQUIRED`), { status: 502 });
  if (!Array.isArray(article.sources)) throw Object.assign(new Error(`${prefix}_ARTICLE_SOURCES_REQUIRED`), { status: 502 });
  const requestedLanguage = String(input?.language || "").trim();
  if (requestedLanguage && article.language !== requestedLanguage) {
    throw Object.assign(new Error(`${prefix}_LANGUAGE_MISMATCH`), { status: 502 });
  }
  return article;
}
__name(validateArticleShape, "validateArticleShape");
function validateWriterArticle(value, input) {
  return validateArticleShape(value, input, "WRITER");
}
__name(validateWriterArticle, "validateWriterArticle");
function validateRepairArticle(value, input) {
  return validateArticleShape(value, { language: input?.article?.language }, "REPAIR");
}
__name(validateRepairArticle, "validateRepairArticle");
var REPAIR_TEXT_FIELDS = Object.freeze(["title", "html", "searchDescription", "language", "topic"]);
var REPAIR_ARRAY_FIELDS = Object.freeze(["labels", "sources"]);
function mergeRepairArticle(parsed, input) {
  const returned = parsed?.article && typeof parsed.article === "object" && !Array.isArray(parsed.article) ? parsed.article : parsed;
  if (!returned || typeof returned !== "object" || Array.isArray(returned)) {
    throw Object.assign(new Error("REPAIR_ARTICLE_REQUIRED"), { status: 502 });
  }
  const base = input?.article && typeof input.article === "object" && !Array.isArray(input.article) ? input.article : null;
  if (!base) return returned;
  const merged = { ...base, ...returned };
  for (const field of REPAIR_TEXT_FIELDS) {
    if (typeof merged[field] !== "string" || !merged[field].trim()) merged[field] = base[field];
  }
  for (const field of REPAIR_ARRAY_FIELDS) {
    if (!Array.isArray(merged[field])) merged[field] = base[field];
  }
  return merged;
}
__name(mergeRepairArticle, "mergeRepairArticle");
var CRITIC_STATUS_ALIASES = /* @__PURE__ */ new Map([
  ["PASS", "PASS"],
  ["PASSED", "PASS"],
  ["PASSES", "PASS"],
  ["OK", "PASS"],
  ["FAIL", "FAIL"],
  ["FAILED", "FAIL"],
  ["FAILS", "FAIL"]
]);
function normalizeCriticStatus(value) {
  return CRITIC_STATUS_ALIASES.get(String(value ?? "").trim().toUpperCase()) || null;
}
__name(normalizeCriticStatus, "normalizeCriticStatus");
function normalizeCriticSeverity(value) {
  const severity = String(value ?? "").trim().toUpperCase();
  return CRITIC_SEVERITIES.has(severity) ? severity : null;
}
__name(normalizeCriticSeverity, "normalizeCriticSeverity");
function validateCriticIssue(issue) {
  if (!issue || typeof issue !== "object") return false;
  if (typeof issue.code !== "string" || !issue.code.trim()) return false;
  if (!normalizeCriticSeverity(issue.severity)) return false;
  if (typeof issue.location !== "string" || !issue.location.trim()) return false;
  if (typeof issue.reason !== "string" || !issue.reason.trim()) return false;
  if (typeof issue.repairInstruction !== "string" || !issue.repairInstruction.trim()) return false;
  return true;
}
__name(validateCriticIssue, "validateCriticIssue");
function normalizeCriticResult(parsed) {
  const status = parsed && typeof parsed === "object" ? normalizeCriticStatus(parsed.status) : null;
  if (!status) {
    throw Object.assign(new Error("CRITIC_SCHEMA_INVALID"), { status: 502 });
  }
  const score = Number(parsed.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw Object.assign(new Error("CRITIC_SCORE_INVALID"), { status: 502 });
  }
  const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : [];
  if (!rawIssues.every(validateCriticIssue)) {
    throw Object.assign(new Error("CRITIC_ISSUE_SCHEMA_INVALID"), { status: 502 });
  }
  const issues = rawIssues.map((issue) => ({ ...issue, severity: normalizeCriticSeverity(issue.severity) }));
  if (status === "FAIL" && issues.length === 0) {
    throw Object.assign(new Error("CRITIC_FAIL_WITHOUT_ISSUES"), { status: 502 });
  }
  if (issues.length > 0) {
    return {
      ...parsed,
      score,
      status: "FAIL",
      issues,
      contractNormalized: status === "PASS" ? "PASS_WITH_ISSUES_TO_FAIL" : void 0
    };
  }
  if (score < CRITIC_PASS_MIN_SCORE) {
    throw Object.assign(new Error("CRITIC_PASS_SCORE_BELOW_THRESHOLD"), { status: 502 });
  }
  return { ...parsed, score, status: "PASS", issues };
}
__name(normalizeCriticResult, "normalizeCriticResult");
var CRITIC_CONTRACT_ERRORS = /* @__PURE__ */ new Set([
  "AI_PROVIDER_JSON_INVALID",
  "CRITIC_SCHEMA_INVALID",
  "CRITIC_SCORE_INVALID",
  "CRITIC_ISSUE_SCHEMA_INVALID",
  "CRITIC_FAIL_WITHOUT_ISSUES"
]);
function isCriticContractError(error) {
  return CRITIC_CONTRACT_ERRORS.has(String(error?.message || ""));
}
__name(isCriticContractError, "isCriticContractError");
function stripEvidence(article) {
  if (!article || typeof article !== "object" || !("evidence" in article)) return article;
  const { evidence: _dropped, ...rest } = article;
  return rest;
}
__name(stripEvidence, "stripEvidence");
function providerMetadata(result) {
  return {
    model: result.model,
    provider: result.provider,
    fallbackUsed: result.fallbackUsed,
    primaryError: result.primaryError,
    usage: result.usage
  };
}
__name(providerMetadata, "providerMetadata");
async function diagnostic(env, aiBinding = env?.AI) {
  const model = env.WRITER_MODEL || "@cf/openai/gpt-oss-120b";
  const result = await runWorkersAi(env, {
    model,
    messages: [{ role: "user", content: "Reply only with OK" }],
    maxTokens: OUTPUT_TOKEN_BUDGET.diagnostic
  }, aiBinding);
  return {
    ok: /^ok[.!]?$/i.test(String(result.response || "").trim()),
    model,
    response: String(result.response || "").trim(),
    usage: result.usage
  };
}
__name(diagnostic, "diagnostic");
async function writer(env, input, aiBinding = env?.AI, fetchImpl = fetch) {
  const language = String(input?.language || "").trim();
  if (!["ko", "en"].includes(language)) throw Object.assign(new Error("WRITER_LANGUAGE_INVALID"), { status: 400 });
  const tourApiContentId = String(input?.tourApiContentId || "").trim();
  const attraction = tourApiContentId ? await getAttractionDetail(env, { contentId: tourApiContentId }, fetchImpl) : null;
  const topic = String(input?.topic || attraction?.title || "").trim();
  if (!topic) throw Object.assign(new Error("WRITER_TOPIC_REQUIRED"), { status: 400 });
  const research = attraction ? buildTourApiResearch(attraction) : await collectWriterResearch(env, {
    topic,
    language,
    researchMode: input?.researchMode || "auto"
  }, fetchImpl);
  const rolePrompt = await loadMasterV45RolePrompt("writer");
  const cloudflareModel = env.WRITER_MODEL || "@cf/openai/gpt-oss-120b";
  const geminiModel = env.GEMINI_WRITER_MODEL || GEMINI_DEFAULT_MODEL;
  const systemInstruction = `${rolePrompt.text}

--- SERVER AUTOMATION ADAPTER ---
${WRITER_ADAPTER}`;
  const userContent = JSON.stringify({
    platform: "Blogger",
    blogId: String(input?.blogId || ""),
    topic,
    language,
    candidateAttempt: Number(input?.candidateAttempt || 1),
    retryReason: input?.retryReason ? String(input.retryReason) : null,
    rewriteExisting: input?.rewriteExisting === true,
    ...Array.isArray(input?.internalLinkCandidates) && input.internalLinkCandidates.length ? { internalLinkCandidates: input.internalLinkCandidates.slice(0, 12) } : {},
    // Counted in code so the writer is given the target rather than asked to estimate it.
    lengthContract: lengthContract(language, input?.seoBrief?.planning?.recommendedDepth),
    ...input?.rewriteExisting === true && input?.rewriteSource && typeof input.rewriteSource === "object" ? { rewriteSource: input.rewriteSource } : {},
    ...input?.seoBrief && typeof input.seoBrief === "object" ? { seoBrief: input.seoBrief } : {},
    research: research.used ? {
      provider: research.provider,
      retrievedAt: research.retrievedAt,
      results: research.results
    } : {
      provider: research.provider,
      requested: research.requested,
      unavailable: research.requested && !research.used
    }
  });
  const result = await runPrimaryWithGeminiFallback(env, {
    cloudflare: {
      model: cloudflareModel,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userContent }
      ],
      maxTokens: OUTPUT_TOKEN_BUDGET.writer
    },
    gemini: {
      model: geminiModel,
      systemInstruction,
      userContent,
      maxOutputTokens: OUTPUT_TOKEN_BUDGET.writer,
      thinking: "minimal"
    }
  }, aiBinding, fetchImpl, (parsed2) => validateWriterArticle(parsed2, { topic, language }));
  let parsed;
  try {
    parsed = parseJsonText(result.response);
  } catch {
    throw Object.assign(new Error("WRITER_JSON_INVALID"), { status: 502, meta: MASTER_V45 });
  }
  const article = validateWriterArticle(parsed, { topic, language });
  delete article.evidence;
  const attractionImages = Array.isArray(attraction?.images) ? attraction.images.filter((url) => /^https:\/\//i.test(String(url || ""))).slice(0, 8) : [];
  return {
    article,
    ...providerMetadata(result),
    ...attractionImages.length ? { attractionImages } : {},
    research: {
      requested: research.requested,
      used: research.used,
      provider: research.provider,
      resultCount: research.resultCount
    },
    masterV45: MASTER_V45,
    rolePrompt: rolePrompt.meta
  };
}
__name(writer, "writer");
async function critic(env, input, aiBinding = env?.AI, fetchImpl = fetch) {
  const rolePrompt = await loadMasterV45RolePrompt("critic");
  const cloudflareModel = env.CRITIC_MODEL || "@cf/openai/gpt-oss-120b";
  const article = input?.article && typeof input.article === "object" ? input.article : input;
  if (!article || typeof article !== "object" || Array.isArray(article)) {
    throw Object.assign(new Error("CRITIC_ARTICLE_REQUIRED"), { status: 400 });
  }
  const systemInstruction = `${rolePrompt.text}

--- MASTER V4.5 CRITIC ADAPTER ---
${CRITIC_SYSTEM}

${CRITIC_MASTER_ADAPTER}`;
  const measuredLength = lengthVerdict(
    article,
    article?.language,
    input?.seoBrief?.planning?.recommendedDepth
  );
  const userContent = JSON.stringify({
    article: stripEvidence(article),
    measuredLength,
    ...input?.seoBrief && typeof input.seoBrief === "object" ? { seoBrief: input.seoBrief } : {}
  });
  const messages = [
    { role: "system", content: systemInstruction },
    { role: "user", content: userContent }
  ];
  let result;
  let parsed;
  if (freeAiFallbackEnabled(env) && freeAiConfigured(env)) {
    try {
      const raw = await runFreeAi(env, {
        model: freeAiModel(env, "critic"),
        messages,
        maxTokens: OUTPUT_TOKEN_BUDGET.critic,
        responseFormat: { type: "json_object" }
      }, fetchImpl);
      parsed = normalizeCriticResult(parseJsonText(raw.response));
      result = { ...raw, provider: "free-ai", fallbackUsed: false, primaryError: null };
    } catch (error) {
      if (!shouldFallbackFromFreeAi(error) && !isCriticContractError(error)) throw error;
      const raw = await runWorkersAi(env, { model: cloudflareModel, messages, maxTokens: OUTPUT_TOKEN_BUDGET.critic }, aiBinding);
      parsed = normalizeCriticResult(parseJsonText(raw.response));
      result = { ...raw, provider: "cloudflare-workers-ai", fallbackUsed: true, primaryError: String(error.message) };
    }
  } else {
    const raw = await runWorkersAi(env, { model: cloudflareModel, messages, maxTokens: OUTPUT_TOKEN_BUDGET.critic }, aiBinding);
    result = { ...raw, provider: "cloudflare-workers-ai", fallbackUsed: false, primaryError: null };
    parsed = normalizeCriticResult(parseJsonText(result.response));
  }
  return {
    ...parsed,
    measuredLength,
    ...providerMetadata(result),
    masterV45: MASTER_V45,
    rolePrompt: rolePrompt.meta,
    auditMode: "master-v4.5-role-critic-free-ai-granular"
  };
}
__name(critic, "critic");
async function repair(env, input, aiBinding = env?.AI, fetchImpl = fetch) {
  const rolePrompt = await loadMasterV45RolePrompt("repair");
  const cloudflareModel = env.REPAIR_MODEL || "@cf/openai/gpt-oss-120b";
  const geminiModel = env.GEMINI_REPAIR_MODEL || GEMINI_DEFAULT_MODEL;
  const systemInstruction = `${rolePrompt.text}

--- MASTER V4.5 REPAIR ADAPTER ---
${REPAIR_SYSTEM}

${REPAIR_MASTER_ADAPTER}`;
  const repairArticle = input?.article && typeof input.article === "object" ? input.article : null;
  const userContent = JSON.stringify({
    ...input,
    strategy: "targeted_sections_only",
    ...repairArticle ? {
      measuredLength: lengthVerdict(repairArticle, repairArticle.language, input?.seoBrief?.planning?.recommendedDepth)
    } : {}
  });
  const result = await runPrimaryWithGeminiFallback(env, {
    cloudflare: {
      model: cloudflareModel,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userContent }
      ],
      maxTokens: OUTPUT_TOKEN_BUDGET.repair
    },
    gemini: {
      model: geminiModel,
      systemInstruction,
      userContent,
      maxOutputTokens: OUTPUT_TOKEN_BUDGET.repair,
      thinking: "medium"
    }
  }, aiBinding, fetchImpl);
  let parsed;
  try {
    parsed = parseJsonText(result.response);
  } catch {
    throw Object.assign(new Error("REPAIR_JSON_INVALID"), { status: 502, meta: MASTER_V45 });
  }
  const article = validateRepairArticle(mergeRepairArticle(parsed, input), input);
  return {
    article,
    ...providerMetadata(result),
    masterV45: MASTER_V45,
    rolePrompt: rolePrompt.meta,
    repairMode: "master-v4.5-role-targeted"
  };
}
__name(repair, "repair");

// src/lib/kie-image.js
var DEFAULT_KIE_BASE_URL = "https://api.kie.ai";
var DEFAULT_KIE_MODEL = "z-image";
var GPT4O_IMAGE_MODEL = "gpt4o-image";
var DEFAULT_KIE_THUMBNAIL_MODEL = "z-image";
var MAX_IMAGE_BYTES = 12 * 1024 * 1024;
var DEFAULT_KIE_TASK_TIMEOUT_MS = 15 * 60 * 1e3;
var MIN_KIE_TASK_TIMEOUT_MS = 5 * 60 * 1e3;
var MAX_KIE_TASK_TIMEOUT_MS = 30 * 60 * 1e3;
var DEFAULT_KIE_QUERY_RETRY_MAX = 4;
var DEFAULT_KIE_QUERY_RETRY_BASE_MS = 1e3;
var DEFAULT_KIE_RESULT_DOWNLOAD_RETRY_MAX = 3;
var PENDING_STATES = /* @__PURE__ */ new Set(["waiting", "queuing", "generating", "pending", "processing", "running"]);
function sleep3(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
__name(sleep3, "sleep");
function requiredKey2(env) {
  const key = String(env?.KIE_API_KEY || "").trim();
  if (!key) throw Object.assign(new Error("KIE_API_KEY_REQUIRED"), { status: 503 });
  return key;
}
__name(requiredKey2, "requiredKey");
function safeBaseUrl2(env) {
  const raw = String(env?.KIE_API_BASE_URL || DEFAULT_KIE_BASE_URL).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("KIE_API_BASE_URL_INVALID"), { status: 500 });
  }
  if (url.protocol !== "https:" || url.hostname !== "api.kie.ai") {
    throw Object.assign(new Error("KIE_API_BASE_URL_NOT_ALLOWED"), { status: 500 });
  }
  return url.origin;
}
__name(safeBaseUrl2, "safeBaseUrl");
function safeModel(env) {
  const model = String(env?.KIE_IMAGE_MODEL || DEFAULT_KIE_MODEL).trim();
  if (model !== DEFAULT_KIE_MODEL) throw Object.assign(new Error("KIE_IMAGE_MODEL_NOT_ALLOWED"), { status: 500 });
  return model;
}
__name(safeModel, "safeModel");
function safeThumbnailModel(env) {
  const model = String(env?.KIE_THUMBNAIL_MODEL || DEFAULT_KIE_THUMBNAIL_MODEL).trim();
  if (model !== DEFAULT_KIE_THUMBNAIL_MODEL && model !== GPT4O_IMAGE_MODEL) {
    throw Object.assign(new Error("KIE_THUMBNAIL_MODEL_NOT_ALLOWED"), { status: 500 });
  }
  return model;
}
__name(safeThumbnailModel, "safeThumbnailModel");
function resolveModelForRole(env, role) {
  return role === "thumbnail" ? safeThumbnailModel(env) : safeModel(env);
}
__name(resolveModelForRole, "resolveModelForRole");
function kieCallbackUrl(env = {}) {
  const raw = String(env?.KIE_IMAGE_CALLBACK_URL || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("KIE_IMAGE_CALLBACK_URL_INVALID"), { status: 500 });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw Object.assign(new Error("KIE_IMAGE_CALLBACK_URL_INVALID"), { status: 500 });
  }
  return url.href;
}
__name(kieCallbackUrl, "kieCallbackUrl");
function kieTaskTimeoutMs(env = {}) {
  const configured = Number(env?.KIE_IMAGE_TASK_TIMEOUT_MS ?? DEFAULT_KIE_TASK_TIMEOUT_MS);
  if (!Number.isInteger(configured) || configured < MIN_KIE_TASK_TIMEOUT_MS || configured > MAX_KIE_TASK_TIMEOUT_MS) {
    return DEFAULT_KIE_TASK_TIMEOUT_MS;
  }
  return configured;
}
__name(kieTaskTimeoutMs, "kieTaskTimeoutMs");
function kieQueryRetryMax(env = {}) {
  const configured = Number(env?.KIE_IMAGE_QUERY_RETRY_MAX ?? DEFAULT_KIE_QUERY_RETRY_MAX);
  if (!Number.isInteger(configured) || configured < 1 || configured > 5) return DEFAULT_KIE_QUERY_RETRY_MAX;
  return configured;
}
__name(kieQueryRetryMax, "kieQueryRetryMax");
function kieQueryRetryBaseMs(env = {}) {
  const configured = Number(env?.KIE_IMAGE_QUERY_RETRY_BASE_MS ?? DEFAULT_KIE_QUERY_RETRY_BASE_MS);
  if (!Number.isInteger(configured) || configured < 250 || configured > 5e3) return DEFAULT_KIE_QUERY_RETRY_BASE_MS;
  return configured;
}
__name(kieQueryRetryBaseMs, "kieQueryRetryBaseMs");
function kieResultDownloadRetryMax(env = {}) {
  const configured = Number(env?.KIE_IMAGE_RESULT_DOWNLOAD_RETRY_MAX ?? DEFAULT_KIE_RESULT_DOWNLOAD_RETRY_MAX);
  if (!Number.isInteger(configured) || configured < 1 || configured > 5) return DEFAULT_KIE_RESULT_DOWNLOAD_RETRY_MAX;
  return configured;
}
__name(kieResultDownloadRetryMax, "kieResultDownloadRetryMax");
function providerTimestampMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 1e12 ? Math.trunc(number * 1e3) : Math.trunc(number);
}
__name(providerTimestampMs, "providerTimestampMs");
function kieTaskAgeMs(task, nowMs = Date.now()) {
  const createdAt = providerTimestampMs(task?.createTime);
  if (!createdAt) return 0;
  return Math.max(0, Number(nowMs) - createdAt);
}
__name(kieTaskAgeMs, "kieTaskAgeMs");
function kieTaskTimedOut(task, env = {}, nowMs = Date.now()) {
  const ageMs = kieTaskAgeMs(task, nowMs);
  return ageMs > 0 && ageMs >= kieTaskTimeoutMs(env);
}
__name(kieTaskTimedOut, "kieTaskTimedOut");
function normalizeAspectRatio(value, role) {
  const ratio = String(value || "").trim();
  const fallback = role === "thumbnail" ? "16:9" : "4:3";
  const allowed = /* @__PURE__ */ new Set(["1:1", "4:3", "3:4", "16:9", "9:16"]);
  if (allowed.has(ratio)) return ratio;
  if (ratio === "3:2") return "4:3";
  if (ratio === "2:3") return "3:4";
  return fallback;
}
__name(normalizeAspectRatio, "normalizeAspectRatio");
var GPT4O_IMAGE_SIZE_BY_ASPECT_RATIO = Object.freeze({
  "1:1": "1:1",
  "4:3": "3:2",
  "16:9": "3:2",
  "3:4": "2:3",
  "9:16": "2:3"
});
function gpt4oImageSize(aspectRatio, role) {
  const ratio = normalizeAspectRatio(aspectRatio, role);
  return GPT4O_IMAGE_SIZE_BY_ASPECT_RATIO[ratio] || "1:1";
}
__name(gpt4oImageSize, "gpt4oImageSize");
function safePromptForKie(value) {
  const prompt = String(value || "").replace(/\s+/g, " ").trim();
  if (!prompt) return prompt;
  const commonSafety = "Preserve the exact subject, action, problem context, objects, and scene requested above. Photorealistic real-world image. Do not substitute a different troubleshooting action, component, or generic cleaning scene.";
  return `${prompt}. ${commonSafety}`;
}
__name(safePromptForKie, "safePromptForKie");
function numericCode(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}
__name(numericCode, "numericCode");
function kieValidationHint(data) {
  const raw = String(data?.msg || "").trim();
  if (!raw || raw.toLowerCase() === "success") return null;
  const safe = raw.replace(/[^A-Za-z0-9_./,:; -]/g, " ").replace(/\s+/g, " ").trim();
  return safe ? safe.slice(0, 200) : null;
}
__name(kieValidationHint, "kieValidationHint");
function kieFailure(response, data, safeError) {
  const providerHttpStatus = numericCode(response?.status);
  const providerCode = numericCode(data?.code);
  const signals = new Set([providerHttpStatus, providerCode].filter((value) => value !== null));
  const validationHint = kieValidationHint(data);
  let message = safeError;
  let status = 502;
  if (signals.has(401) || signals.has(403)) {
    message = "KIE_AUTH_FAILED";
    status = 401;
  } else if (signals.has(402)) {
    message = "KIE_INSUFFICIENT_CREDITS";
    status = 402;
  } else if (signals.has(429)) {
    message = "KIE_RATE_LIMITED";
    status = 429;
  } else if (signals.has(400) || signals.has(422)) {
    message = "KIE_VALIDATION_FAILED";
    status = 422;
  } else if ([...signals].some((value) => value >= 500)) {
    message = "KIE_PROVIDER_ERROR";
    status = 502;
  }
  const error = Object.assign(new Error(message), {
    status,
    providerHttpStatus,
    providerCode
  });
  if (message === "KIE_VALIDATION_FAILED" && validationHint) error.providerValidationHint = validationHint;
  return error;
}
__name(kieFailure, "kieFailure");
function kieTaskFailure(task) {
  const providerCode = numericCode(task?.failCode);
  const detail = String(task?.failMsg || "").trim().toLowerCase();
  let message = "KIE_IMAGE_GENERATION_FAILED";
  let status = 502;
  if (providerCode === 429 || /rate.?limit|too many|concurrent/.test(detail)) {
    message = "KIE_RATE_LIMITED";
    status = 429;
  } else if (/(moderator|content policy|policy violation|nsfw|inappropriate content)/.test(detail)) {
    message = "KIE_CONTENT_REJECTED";
    status = 422;
  } else if (providerCode === 500 || providerCode === 501 || /internal error|try again later|generation failed|generate failed/.test(detail)) {
    message = "KIE_PROVIDER_GENERATION_FAILED";
  }
  const error = Object.assign(new Error(message), { status });
  if (providerCode !== null) error.providerCode = providerCode;
  return error;
}
__name(kieTaskFailure, "kieTaskFailure");
function kieResponseSucceeded(response, data) {
  if (!response?.ok || !data) return false;
  if (Number(data.code) === 200) return true;
  return Boolean(data.data) && String(data.msg || "").trim().toLowerCase() === "success";
}
__name(kieResponseSucceeded, "kieResponseSucceeded");
async function jsonRequest(fetchImpl, url, init, safeError) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw Object.assign(new Error("KIE_NETWORK_ERROR"), { status: 502 });
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
  }
  if (!kieResponseSucceeded(response, data)) throw kieFailure(response, data, safeError);
  return data;
}
__name(jsonRequest, "jsonRequest");
function transientQueryError(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || "");
  return message === "KIE_NETWORK_ERROR" || message === "KIE_RATE_LIMITED" || message === "KIE_PROVIDER_ERROR" || status === 429 || status >= 500;
}
__name(transientQueryError, "transientQueryError");
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
          "KIE_TASK_QUERY_FAILED"
        ),
        transientError: null,
        attempts: attempt + 1
      };
    } catch (error) {
      if (!transientQueryError(error)) throw error;
      lastError = error;
      if (attempt + 1 >= maxAttempts) break;
      await sleep3(Math.min(8e3, baseDelay * 2 ** attempt));
    }
  }
  return { data: null, transientError: lastError, attempts: maxAttempts };
}
__name(queryTaskDetail, "queryTaskDetail");
function queryKieTaskDetail(env, baseUrl, apiKey, taskId, fetchImpl) {
  return queryTaskDetail(env, `${baseUrl}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, apiKey, fetchImpl);
}
__name(queryKieTaskDetail, "queryKieTaskDetail");
function queryGpt4oImageDetail(env, baseUrl, apiKey, taskId, fetchImpl) {
  return queryTaskDetail(env, `${baseUrl}/api/v1/gpt4o-image/record-info?taskId=${encodeURIComponent(taskId)}`, apiKey, fetchImpl);
}
__name(queryGpt4oImageDetail, "queryGpt4oImageDetail");
function parseResultUrl(task) {
  let parsed;
  try {
    parsed = JSON.parse(String(task?.resultJson || "{}"));
  } catch {
    return "";
  }
  const url = Array.isArray(parsed?.resultUrls) ? String(parsed.resultUrls[0] || "").trim() : "";
  if (!url) return "";
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return "";
  }
  if (parsedUrl.protocol !== "https:") return "";
  return parsedUrl.href;
}
__name(parseResultUrl, "parseResultUrl");
function parseGpt4oResultUrl(task) {
  const urls = task?.response?.resultUrls;
  const url = Array.isArray(urls) ? String(urls[0] || "").trim() : "";
  if (!url) return "";
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return "";
  }
  if (parsedUrl.protocol !== "https:") return "";
  return parsedUrl.href;
}
__name(parseGpt4oResultUrl, "parseGpt4oResultUrl");
function gpt4oTaskFailure(task) {
  const providerCode = numericCode(task?.errorCode);
  const detail = String(task?.errorMessage || "").trim().toLowerCase();
  let message = "KIE_IMAGE_GENERATION_FAILED";
  let status = 502;
  if (providerCode === 429 || /rate.?limit|too many|concurrent/.test(detail)) {
    message = "KIE_RATE_LIMITED";
    status = 429;
  } else if (/(moderator|content policy|policy violation|nsfw|inappropriate content)/.test(detail)) {
    message = "KIE_CONTENT_REJECTED";
    status = 422;
  } else if (providerCode !== null && providerCode >= 500 || /internal error|try again later|generation failed|generate failed/.test(detail)) {
    message = "KIE_PROVIDER_GENERATION_FAILED";
  }
  const error = Object.assign(new Error(message), { status });
  if (providerCode !== null) error.providerCode = providerCode;
  return error;
}
__name(gpt4oTaskFailure, "gpt4oTaskFailure");
function classifyMimeType(value) {
  const type = String(value || "").split(";")[0].trim().toLowerCase();
  if (["image/jpeg", "image/png", "image/webp"].includes(type)) return type;
  return "image/jpeg";
}
__name(classifyMimeType, "classifyMimeType");
async function downloadKieResult(env, fetchImpl, resultUrl2) {
  const maxAttempts = kieResultDownloadRetryMax(env);
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let imageResponse;
    try {
      imageResponse = await fetchImpl(resultUrl2, {
        redirect: "follow",
        headers: {
          accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "user-agent": "Mozilla/5.0 (compatible; SmileseonImageFetcher/1.0)"
        }
      });
    } catch {
      lastError = Object.assign(new Error("KIE_RESULT_DOWNLOAD_FAILED"), { status: 502, transient: true });
      imageResponse = null;
    }
    if (imageResponse?.ok) {
      const bytes = new Uint8Array(await imageResponse.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
        throw Object.assign(new Error(bytes.length ? "KIE_IMAGE_TOO_LARGE" : "KIE_IMAGE_EMPTY"), { status: 502 });
      }
      let binary = "";
      const chunk = 32768;
      for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      return {
        mimeType: classifyMimeType(imageResponse.headers?.get?.("content-type")),
        imageBase64: btoa(binary)
      };
    }
    if (imageResponse && !imageResponse.ok) {
      lastError = Object.assign(new Error("KIE_RESULT_DOWNLOAD_FAILED"), {
        status: 502,
        providerHttpStatus: Number(imageResponse.status || 0),
        transient: true
      });
    }
    if (attempt + 1 < maxAttempts) await sleep3(1e3 * 2 ** attempt);
  }
  throw lastError || Object.assign(new Error("KIE_RESULT_DOWNLOAD_FAILED"), { status: 502, transient: true });
}
__name(downloadKieResult, "downloadKieResult");
async function startGpt4oImageTask(env, { role, prompt, aspectRatio, hookText }, apiKey, baseUrl, callbackUrl, fetchImpl) {
  const hook = String(hookText || "").trim();
  const finalPrompt = hook ? String(prompt || "").replace(/\s+/g, " ").trim() : safePromptForKie(prompt);
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
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    },
    "KIE_CREATE_TASK_FAILED"
  );
  const taskId = String(create?.data?.taskId || "").trim();
  if (!taskId) throw Object.assign(new Error("KIE_TASK_ID_MISSING"), { status: 502 });
  return {
    ok: true,
    provider: "kie-ai",
    model: GPT4O_IMAGE_MODEL,
    taskId,
    state: "waiting",
    pending: true,
    complete: false,
    callback: Boolean(callbackUrl),
    hookBaked: Boolean(hook)
  };
}
__name(startGpt4oImageTask, "startGpt4oImageTask");
async function startKieImageTask(env, { role, prompt, aspectRatio, hookText }, fetchImpl = fetch) {
  const apiKey = requiredKey2(env);
  const baseUrl = safeBaseUrl2(env);
  const model = resolveModelForRole(env, role);
  const callbackUrl = kieCallbackUrl(env);
  if (model === GPT4O_IMAGE_MODEL) {
    return startGpt4oImageTask(env, { role, prompt, aspectRatio, hookText }, apiKey, baseUrl, callbackUrl, fetchImpl);
  }
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
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    },
    "KIE_CREATE_TASK_FAILED"
  );
  const taskId = String(create?.data?.taskId || "").trim();
  if (!taskId) throw Object.assign(new Error("KIE_TASK_ID_MISSING"), { status: 502 });
  return {
    ok: true,
    provider: "kie-ai",
    model,
    taskId,
    state: "waiting",
    pending: true,
    complete: false,
    callback: Boolean(callbackUrl)
  };
}
__name(startKieImageTask, "startKieImageTask");
async function pollGpt4oImageTask(env, taskId, apiKey, baseUrl, fetchImpl) {
  const queried = await queryGpt4oImageDetail(env, baseUrl, apiKey, taskId, fetchImpl);
  if (queried.transientError) {
    return {
      ok: true,
      provider: "kie-ai",
      model: GPT4O_IMAGE_MODEL,
      taskId,
      state: "query_retry",
      pending: true,
      complete: false,
      queryAttempts: queried.attempts,
      recoveryReason: String(queried.transientError?.message || "KIE_TASK_QUERY_RETRY")
    };
  }
  const task = queried.data?.data || {};
  const successFlag = Number(task.successFlag);
  if (successFlag === 2 || successFlag === 3) throw gpt4oTaskFailure(task);
  if (successFlag !== 1) {
    if (kieTaskTimedOut(task, env)) {
      const error = Object.assign(new Error("KIE_TASK_TIMEOUT"), {
        status: 504,
        taskId,
        taskState: "waiting",
        taskAgeMs: kieTaskAgeMs(task),
        taskTimeoutMs: kieTaskTimeoutMs(env)
      });
      const progress = Number(task?.progress);
      if (Number.isFinite(progress)) error.progress = progress;
      throw error;
    }
    return {
      ok: true,
      provider: "kie-ai",
      model: GPT4O_IMAGE_MODEL,
      taskId,
      state: "waiting",
      pending: true,
      complete: false
    };
  }
  const resultUrl2 = parseGpt4oResultUrl(task);
  if (!resultUrl2) {
    return {
      ok: true,
      provider: "kie-ai",
      model: GPT4O_IMAGE_MODEL,
      taskId,
      state: "result_pending",
      pending: true,
      complete: false,
      recoveryReason: "KIE_RESULT_URL_MISSING"
    };
  }
  let downloaded;
  try {
    downloaded = await downloadKieResult(env, fetchImpl, resultUrl2);
  } catch (error) {
    if (error?.transient === true || String(error?.message || "") === "KIE_RESULT_DOWNLOAD_FAILED") {
      return {
        ok: true,
        provider: "kie-ai",
        model: GPT4O_IMAGE_MODEL,
        taskId,
        state: "result_download_retry",
        pending: true,
        complete: false,
        sourceUrl: resultUrl2,
        recoveryReason: "KIE_RESULT_DOWNLOAD_FAILED"
      };
    }
    throw error;
  }
  return {
    ok: true,
    provider: "kie-ai",
    model: GPT4O_IMAGE_MODEL,
    taskId,
    state: "success",
    pending: false,
    complete: true,
    sourceUrl: resultUrl2,
    ...downloaded
  };
}
__name(pollGpt4oImageTask, "pollGpt4oImageTask");
async function pollKieImageTask(env, taskId, fetchImpl = fetch, role) {
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) throw Object.assign(new Error("KIE_TASK_ID_REQUIRED"), { status: 400 });
  const apiKey = requiredKey2(env);
  const baseUrl = safeBaseUrl2(env);
  const model = resolveModelForRole(env, role);
  if (model === GPT4O_IMAGE_MODEL) {
    return pollGpt4oImageTask(env, normalizedTaskId, apiKey, baseUrl, fetchImpl);
  }
  const queried = await queryKieTaskDetail(env, baseUrl, apiKey, normalizedTaskId, fetchImpl);
  if (queried.transientError) {
    return {
      ok: true,
      provider: "kie-ai",
      model,
      taskId: normalizedTaskId,
      state: "query_retry",
      pending: true,
      complete: false,
      queryAttempts: queried.attempts,
      recoveryReason: String(queried.transientError?.message || "KIE_TASK_QUERY_RETRY")
    };
  }
  const task = queried.data?.data || {};
  const state = String(task.state || "").trim().toLowerCase();
  if (state === "fail") throw kieTaskFailure(task);
  if (state !== "success") {
    if (kieTaskTimedOut(task, env)) {
      const error = Object.assign(new Error("KIE_TASK_TIMEOUT"), {
        status: 504,
        taskId: normalizedTaskId,
        taskState: PENDING_STATES.has(state) ? state : state || "waiting",
        taskAgeMs: kieTaskAgeMs(task),
        taskTimeoutMs: kieTaskTimeoutMs(env)
      });
      const progress = Number(task?.progress);
      if (Number.isFinite(progress)) error.progress = progress;
      throw error;
    }
    return {
      ok: true,
      provider: "kie-ai",
      model,
      taskId: normalizedTaskId,
      state: PENDING_STATES.has(state) ? state : state || "waiting",
      pending: true,
      complete: false
    };
  }
  const resultUrl2 = parseResultUrl(task);
  if (!resultUrl2) {
    return {
      ok: true,
      provider: "kie-ai",
      model,
      taskId: normalizedTaskId,
      state: "result_pending",
      pending: true,
      complete: false,
      recoveryReason: "KIE_RESULT_URL_MISSING"
    };
  }
  let downloaded;
  try {
    downloaded = await downloadKieResult(env, fetchImpl, resultUrl2);
  } catch (error) {
    if (error?.transient === true || String(error?.message || "") === "KIE_RESULT_DOWNLOAD_FAILED") {
      return {
        ok: true,
        provider: "kie-ai",
        model,
        taskId: normalizedTaskId,
        state: "result_download_retry",
        pending: true,
        complete: false,
        sourceUrl: resultUrl2,
        recoveryReason: "KIE_RESULT_DOWNLOAD_FAILED"
      };
    }
    throw error;
  }
  return {
    ok: true,
    provider: "kie-ai",
    model,
    taskId: normalizedTaskId,
    state: "success",
    pending: false,
    complete: true,
    sourceUrl: resultUrl2,
    ...downloaded
  };
}
__name(pollKieImageTask, "pollKieImageTask");
async function generateKieImage(env, { role, prompt, aspectRatio, taskId, hookText }, fetchImpl = fetch) {
  if (String(taskId || "").trim()) return pollKieImageTask(env, taskId, fetchImpl, role);
  return startKieImageTask(env, { role, prompt, aspectRatio, hookText }, fetchImpl);
}
__name(generateKieImage, "generateKieImage");

// src/lib/modelscope-image.js
var DEFAULT_MODELSCOPE_BASE_URL = "https://api-inference.modelscope.ai";
var DEFAULT_MODELSCOPE_MODEL = "Tongyi-MAI/Z-Image-Turbo";
var MAX_IMAGE_BYTES2 = 12 * 1024 * 1024;
var DEFAULT_RESULT_DOWNLOAD_RETRY_MAX = 3;
function sleep4(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
__name(sleep4, "sleep");
function requiredToken(env = {}) {
  const token = String(env?.MODELSCOPE_TOKEN || "").trim();
  if (!token) throw Object.assign(new Error("MODELSCOPE_TOKEN_REQUIRED"), { status: 503 });
  return token;
}
__name(requiredToken, "requiredToken");
function safeBaseUrl3(env = {}) {
  const raw = String(env?.MODELSCOPE_API_BASE_URL || DEFAULT_MODELSCOPE_BASE_URL).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("MODELSCOPE_API_BASE_URL_INVALID"), { status: 500 });
  }
  if (url.protocol !== "https:" || url.hostname !== "api-inference.modelscope.ai") {
    throw Object.assign(new Error("MODELSCOPE_API_BASE_URL_NOT_ALLOWED"), { status: 500 });
  }
  return url.origin;
}
__name(safeBaseUrl3, "safeBaseUrl");
function modelScopeModel(env = {}) {
  const model = String(env?.MODELSCOPE_IMAGE_MODEL || DEFAULT_MODELSCOPE_MODEL).trim();
  if (model !== DEFAULT_MODELSCOPE_MODEL) {
    throw Object.assign(new Error("MODELSCOPE_IMAGE_MODEL_NOT_ALLOWED"), { status: 500 });
  }
  return model;
}
__name(modelScopeModel, "modelScopeModel");
function modelScopeConfigured(env = {}) {
  return Boolean(String(env?.MODELSCOPE_TOKEN || "").trim());
}
__name(modelScopeConfigured, "modelScopeConfigured");
function modelScopeSize(aspectRatio, role = "body") {
  const ratio = String(aspectRatio || "").trim();
  if (ratio === "16:9") return "1024x576";
  if (ratio === "9:16") return "576x1024";
  if (ratio === "3:4") return "768x1024";
  if (ratio === "1:1") return "1024x1024";
  if (ratio === "4:3") return "1024x768";
  return role === "thumbnail" ? "1024x576" : "1024x768";
}
__name(modelScopeSize, "modelScopeSize");
function downloadRetryMax(env = {}) {
  const configured = Number(env?.MODELSCOPE_IMAGE_RESULT_DOWNLOAD_RETRY_MAX ?? DEFAULT_RESULT_DOWNLOAD_RETRY_MAX);
  if (!Number.isInteger(configured) || configured < 1 || configured > 5) return DEFAULT_RESULT_DOWNLOAD_RETRY_MAX;
  return configured;
}
__name(downloadRetryMax, "downloadRetryMax");
function responseError(status, payload) {
  const text = JSON.stringify(payload || {}).toLowerCase();
  let message = "MODELSCOPE_REQUEST_FAILED";
  let safeStatus = 502;
  if (status === 401 || status === 403) {
    message = "MODELSCOPE_AUTH_FAILED";
    safeStatus = 401;
  } else if (status === 429 || /quota|rate.?limit|too many|magicube|balance|credit|limit exceeded/.test(text)) {
    message = "MODELSCOPE_RATE_LIMITED";
    safeStatus = 429;
  } else if (status === 400 || status === 422) {
    message = "MODELSCOPE_VALIDATION_FAILED";
    safeStatus = 422;
  } else if (status >= 500) {
    message = "MODELSCOPE_PROVIDER_ERROR";
  }
  return Object.assign(new Error(message), { status: safeStatus, providerHttpStatus: Number(status || 0) });
}
__name(responseError, "responseError");
async function jsonRequest2(fetchImpl, url, init = {}) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw Object.assign(new Error("MODELSCOPE_NETWORK_ERROR"), { status: 502 });
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
  }
  if (!response.ok) throw responseError(response.status, payload);
  if (!payload || typeof payload !== "object") {
    throw Object.assign(new Error("MODELSCOPE_RESPONSE_INVALID"), { status: 502 });
  }
  return payload;
}
__name(jsonRequest2, "jsonRequest");
function resultUrl(payload) {
  const urls = Array.isArray(payload?.output_images) ? payload.output_images : [];
  const value = String(urls[0] || "").trim();
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  return url.protocol === "https:" ? url.href : "";
}
__name(resultUrl, "resultUrl");
function classifyMimeType2(value) {
  const type = String(value || "").split(";")[0].trim().toLowerCase();
  if (["image/jpeg", "image/png", "image/webp"].includes(type)) return type;
  return "image/jpeg";
}
__name(classifyMimeType2, "classifyMimeType");
function looksLikeImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return false;
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const webp = bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
  return jpeg || png || webp;
}
__name(looksLikeImage, "looksLikeImage");
function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
__name(bytesToBase64, "bytesToBase64");
async function downloadResult(env, url, fetchImpl) {
  const attempts = downloadRetryMax(env);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        redirect: "follow",
        headers: {
          accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          "user-agent": "Mozilla/5.0 (compatible; SmileseonModelScopeFetcher/1.0)"
        }
      });
      if (!response.ok) {
        lastError = Object.assign(new Error("MODELSCOPE_RESULT_DOWNLOAD_FAILED"), {
          status: 502,
          providerHttpStatus: Number(response.status || 0)
        });
      } else {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES2 || !looksLikeImage(bytes)) {
          throw Object.assign(new Error("MODELSCOPE_RESULT_IMAGE_INVALID"), { status: 502 });
        }
        return {
          mimeType: classifyMimeType2(response.headers?.get?.("content-type")),
          imageBase64: bytesToBase64(bytes)
        };
      }
    } catch (error) {
      if (String(error?.message || "") === "MODELSCOPE_RESULT_IMAGE_INVALID") throw error;
      lastError = error?.status ? error : Object.assign(new Error("MODELSCOPE_RESULT_DOWNLOAD_FAILED"), { status: 502 });
    }
    if (attempt < attempts) await sleep4(1e3 * 2 ** (attempt - 1));
  }
  throw lastError || Object.assign(new Error("MODELSCOPE_RESULT_DOWNLOAD_FAILED"), { status: 502 });
}
__name(downloadResult, "downloadResult");
async function startModelScopeImageTask(env, { role, prompt, aspectRatio }, fetchImpl = fetch) {
  const token = requiredToken(env);
  const baseUrl = safeBaseUrl3(env);
  const model = modelScopeModel(env);
  const payload = await jsonRequest2(fetchImpl, `${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "X-ModelScope-Async-Mode": "true"
    },
    body: JSON.stringify({
      model,
      prompt: String(prompt || "").trim(),
      size: modelScopeSize(aspectRatio, role)
    })
  });
  const taskId = String(payload?.task_id || "").trim();
  if (!taskId) throw Object.assign(new Error("MODELSCOPE_TASK_ID_MISSING"), { status: 502 });
  return {
    ok: true,
    provider: "modelscope",
    model,
    taskId,
    state: "pending",
    pending: true,
    complete: false
  };
}
__name(startModelScopeImageTask, "startModelScopeImageTask");
async function pollModelScopeImageTask(env, taskId, fetchImpl = fetch) {
  const token = requiredToken(env);
  const baseUrl = safeBaseUrl3(env);
  const model = modelScopeModel(env);
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) throw Object.assign(new Error("MODELSCOPE_TASK_ID_REQUIRED"), { status: 400 });
  const payload = await jsonRequest2(
    fetchImpl,
    `${baseUrl}/v1/tasks/${encodeURIComponent(normalizedTaskId)}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "X-ModelScope-Task-Type": "image_generation"
      }
    }
  );
  const rawState = String(payload?.task_status || "").trim().toUpperCase();
  if (!rawState) throw Object.assign(new Error("MODELSCOPE_TASK_STATUS_MISSING"), { status: 502 });
  if (rawState === "FAILED") {
    throw Object.assign(new Error("MODELSCOPE_IMAGE_GENERATION_FAILED"), { status: 502 });
  }
  if (rawState !== "SUCCEED") {
    return {
      ok: true,
      provider: "modelscope",
      model,
      taskId: normalizedTaskId,
      state: rawState.toLowerCase(),
      pending: true,
      complete: false
    };
  }
  const sourceUrl = resultUrl(payload);
  if (!sourceUrl) throw Object.assign(new Error("MODELSCOPE_RESULT_URL_MISSING"), { status: 502 });
  const downloaded = await downloadResult(env, sourceUrl, fetchImpl);
  return {
    ok: true,
    provider: "modelscope",
    model,
    taskId: normalizedTaskId,
    state: "success",
    pending: false,
    complete: true,
    sourceUrl,
    ...downloaded
  };
}
__name(pollModelScopeImageTask, "pollModelScopeImageTask");
async function generateModelScopeImage(env, input = {}, fetchImpl = fetch) {
  const taskId = String(input?.taskId || "").trim();
  return taskId ? pollModelScopeImageTask(env, taskId, fetchImpl) : startModelScopeImageTask(env, input, fetchImpl);
}
__name(generateModelScopeImage, "generateModelScopeImage");

// src/lib/image-routes.js
var DEFAULT_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
var DEFAULT_IMAGE_QA_MODEL = "gemini-3.1-flash-lite";
var ALLOWED_IMAGE_MODELS = /* @__PURE__ */ new Set([DEFAULT_IMAGE_MODEL]);
var IMAGE_ROLES = /* @__PURE__ */ new Set(["thumbnail", "body"]);
var PROVIDER_MODES = /* @__PURE__ */ new Set(["auto", "cloudflare", "kie", "modelscope"]);
var PLAIN_SURFACE_GUARD = "Favor simple generic real-world subjects with broad uniform surfaces, simple geometry, natural textures, and minimal decorative detail.";
var KIE_NO_TEXT_TAIL = "Every surface in the frame shows only its own bare material texture: plain metal, plastic, glass, fabric, wood, or painted wall, clean and free of markings.";
var IMAGE_QA_TRANSIENT_DELAYS_MS = [250, 750];
var IMAGE_QA_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    pass: { type: "boolean" },
    detectedText: { type: "array", items: { type: "string" } },
    violations: { type: "array", items: { type: "string" } },
    semanticMatch: { type: "boolean" },
    semanticReason: { type: "string" }
  },
  required: ["pass", "detectedText", "violations", "semanticMatch", "semanticReason"]
});
var HOOK_MATCH_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    detectedText: { type: "string" },
    matches: { type: "boolean" }
  },
  required: ["detectedText", "matches"]
});
function gpt4oHookRenderTail(hookText) {
  const hook = String(hookText || "").replace(/\s+/g, " ").trim();
  return `Render the exact headline text "${hook}" as a bold, highly legible caption near the bottom third of the image, in a clean modern sans-serif font with strong color contrast against the background. Spell it exactly as given, in that language, with no other letters, words, numbers, or logos anywhere else in the image.`;
}
__name(gpt4oHookRenderTail, "gpt4oHookRenderTail");
function sleep5(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
__name(sleep5, "sleep");
function isLegacyGuardLine(line) {
  const text = String(line || "").trim();
  return text.startsWith("STRICT VISUAL RULE:") || text.startsWith("No letters, words, numbers, labels, logos, watermarks, signs, UI,") || text.startsWith("Avoid products or screens that normally display text;") || text.startsWith("Show only the practical physical scene,") || /^Attempt \d+: keep every visible surface free of text-like marks\.$/i.test(text) || /^Editorial blog image\. No text, no letters, no captions, no logos, no watermark\.$/i.test(text);
}
__name(isLegacyGuardLine, "isLegacyGuardLine");
function normalizePrompt(value) {
  const raw = String(value || "").trim();
  if (!raw) throw Object.assign(new Error("IMAGE_PROMPT_REQUIRED"), { status: 400 });
  if (raw.length > 1900) throw Object.assign(new Error("IMAGE_PROMPT_TOO_LONG"), { status: 400 });
  const prompt = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !isLegacyGuardLine(line)).join(" ").replace(/\s+/g, " ").trim();
  if (!prompt) throw Object.assign(new Error("IMAGE_PROMPT_REQUIRED"), { status: 400 });
  return prompt;
}
__name(normalizePrompt, "normalizePrompt");
function kieRecoveryLevel(raw) {
  if (/KIE_RECOVERY_LEVEL_3|even tighter close-up|minimum physical elements/i.test(raw)) return 3;
  if (/KIE_RECOVERY_LEVEL_2|Recovery visual rule|simplify the composition to a closer view|closer view/i.test(raw)) return 2;
  return 1;
}
__name(kieRecoveryLevel, "kieRecoveryLevel");
function kieComposition(raw) {
  const level = kieRecoveryLevel(raw);
  if (level >= 3) return "Tight close-up, minimal scene elements, soft natural daylight, realistic editorial photography.";
  if (level === 2) return "Close-up view, very simple composition, soft natural daylight, realistic editorial photography.";
  return "Simple uncluttered composition, soft natural daylight, realistic editorial photography.";
}
__name(kieComposition, "kieComposition");
function prepareKiePrompt(value, tail = KIE_NO_TEXT_TAIL) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  const composition = kieComposition(raw);
  if (/\bshower\b[^.]*\bwater pressure\b|\bwater pressure\b[^.]*\bshower\b/i.test(raw)) return `A realistic editorial photograph of a residential chrome showerhead with a steady stream of water against a clean light-colored tiled bathroom wall. ${composition} ${tail}`;
  if (/\bwater shutoff\b|\bshutoff valve\b|\bmain water valve\b/i.test(raw)) return `A realistic editorial photograph of a residential main water shutoff valve connected to exposed household plumbing in a clean utility area. Slightly angled view with a clear focal subject. ${composition} ${tail}`;
  if (/\bartificial intelligence\b[^.]*\b(?:home|household)\b|\bai\b[^.]*\b(?:home|household)\b/i.test(raw)) return `A realistic editorial photograph of a household fixture with simple repair tools resting beside it in a clean residential setting. Slightly angled close view with one clear focal subject. ${composition} ${tail}`;
  const focused = raw.match(/focused on\s+([^.]+)/i)?.[1]?.replace(/\b(?:devices?|screens?|displays?|monitors?|interfaces?|gauges?|meters?)\b/gi, "").replace(/control panels?/gi, "").replace(/\s+/g, " ").trim();
  const subject = focused || "a practical everyday subject";
  return `A realistic editorial photograph of ${subject} as the only subject, filling most of the frame in its real everyday location. Show the object itself close enough to read its surface, material and condition. Quiet documentary still life of an object at rest in natural light. ${composition} ${tail}`;
}
__name(prepareKiePrompt, "prepareKiePrompt");
function normalizeSteps(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  const steps = Number(value);
  if (!Number.isInteger(steps) || steps < 1 || steps > 8) throw Object.assign(new Error("IMAGE_STEPS_INVALID"), { status: 400 });
  return steps;
}
__name(normalizeSteps, "normalizeSteps");
function normalizeSeed(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) throw Object.assign(new Error("IMAGE_SEED_INVALID"), { status: 400 });
  return seed;
}
__name(normalizeSeed, "normalizeSeed");
function normalizeProviderMode(value) {
  const mode = String(value || "auto").trim().toLowerCase();
  if (!PROVIDER_MODES.has(mode)) throw Object.assign(new Error("IMAGE_PROVIDER_MODE_INVALID"), { status: 400 });
  return mode;
}
__name(normalizeProviderMode, "normalizeProviderMode");
function imageQaRequired(env) {
  return String(env?.IMAGE_QA_REQUIRED || "false").trim().toLowerCase() === "true";
}
__name(imageQaRequired, "imageQaRequired");
function imageQaAttempts(env) {
  const attempts = Number(env?.IMAGE_QA_MAX_ATTEMPTS || 3);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 4) throw Object.assign(new Error("IMAGE_QA_MAX_ATTEMPTS_INVALID"), { status: 500 });
  return attempts;
}
__name(imageQaAttempts, "imageQaAttempts");
function isTransientImageQaFailure(error) {
  const message = String(error?.message || "");
  return ["GEMINI_UNAVAILABLE", "GEMINI_RATE_LIMITED", "GEMINI_TIMEOUT", "GEMINI_REQUEST_FAILED", "GEMINI_EMPTY_RESPONSE"].includes(message);
}
__name(isTransientImageQaFailure, "isTransientImageQaFailure");
function nextSeed(seed, attempt) {
  if (!Number.isInteger(seed)) return void 0;
  return (seed + Math.max(0, attempt - 1) * 104729) % 2147483647;
}
__name(nextSeed, "nextSeed");
function promptForAttempt(prompt, attempt) {
  if (attempt <= 1) return prompt;
  if (attempt === 2) return `${prompt} Simplify the composition to a closer view of only the essential physical subject and plain surroundings. Remove secondary props and decorative detail. Use fewer objects, broader uniform surfaces, and simple natural geometry.`;
  return `${prompt} Use an even tighter close-up with only the minimum physical elements needed to show the subject. Favor simple fixtures, tools, walls, tile, pipes, or materials with broad uniform surfaces and subdued detail.`;
}
__name(promptForAttempt, "promptForAttempt");
async function generateCloudflareImage(env, { role, prompt, steps, seed }, aiBinding) {
  if (!aiBinding || typeof aiBinding.run !== "function") throw Object.assign(new Error("IMAGE_AI_BINDING_REQUIRED"), { status: 500 });
  const model = String(env?.IMAGE_MODEL || DEFAULT_IMAGE_MODEL).trim();
  if (!ALLOWED_IMAGE_MODELS.has(model)) throw Object.assign(new Error("IMAGE_MODEL_NOT_ALLOWED"), { status: 500 });
  const providerInput = { prompt };
  if (Number.isInteger(steps)) providerInput.steps = steps;
  if (Number.isInteger(seed)) providerInput.seed = seed;
  let result;
  try {
    result = await aiBinding.run(model, providerInput);
  } catch (cause) {
    const classified = classifyWorkersAiFailure(cause);
    const error = Object.assign(new Error(classified.message), { status: classified.status });
    if (Number.isInteger(classified.providerCode)) error.providerCode = classified.providerCode;
    throw error;
  }
  const imageBase64 = String(result?.image || "").trim();
  if (!imageBase64) throw Object.assign(new Error("IMAGE_EMPTY_RESPONSE"), { status: 502 });
  return { ok: true, role, provider: "cloudflare-workers-ai", model, mimeType: "image/jpeg", imageBase64, steps, seed };
}
__name(generateCloudflareImage, "generateCloudflareImage");
function isLatinRenderableHookText(hookText) {
  return !/[가-힣ᄀ-ᇿ㄰-㆏]/.test(String(hookText || ""));
}
__name(isLatinRenderableHookText, "isLatinRenderableHookText");
async function generateProviderImage(env, { role, prompt, steps, seed, providerMode, aspectRatio, taskId, hookText }, aiBinding, fetchImpl) {
  const targetsGpt4o = role === "thumbnail" && Boolean(hookText) && isLatinRenderableHookText(hookText) && resolveModelForRole(env, role) === GPT4O_IMAGE_MODEL;
  const hookTail = targetsGpt4o ? gpt4oHookRenderTail(hookText) : KIE_NO_TEXT_TAIL;
  if (providerMode === "kie") {
    const result = await generateKieImage(env, { role, prompt: prepareKiePrompt(prompt, hookTail), aspectRatio, taskId, hookText: targetsGpt4o ? hookText : "" }, fetchImpl);
    return { ...result, role, providerMode: "kie" };
  }
  if (providerMode === "modelscope") {
    const result = await generateModelScopeImage(env, { role, prompt: prepareKiePrompt(prompt), aspectRatio, taskId }, fetchImpl);
    return { ...result, role, providerMode: "modelscope" };
  }
  try {
    return { ...await generateCloudflareImage(env, { role, prompt, steps, seed }, aiBinding), providerMode };
  } catch (cloudflareError) {
    if (providerMode === "cloudflare" || !String(env?.KIE_API_KEY || "").trim()) throw cloudflareError;
    const kie = await generateKieImage(env, { role, prompt: prepareKiePrompt(prompt, hookTail), aspectRatio, taskId, hookText: targetsGpt4o ? hookText : "" }, fetchImpl);
    return { ...kie, role, providerMode: "auto", fallbackFrom: "cloudflare-workers-ai", fallbackReason: String(cloudflareError?.message || "CLOUDFLARE_IMAGE_FAILED") };
  }
}
__name(generateProviderImage, "generateProviderImage");
async function inspectGeneratedImage(env, generated, expectedPrompt, fetchImpl) {
  if (!String(env?.GEMINI_API_KEY || "").trim()) throw Object.assign(new Error("IMAGE_QA_GEMINI_REQUIRED"), { status: 503 });
  const model = String(env?.GEMINI_IMAGE_QA_MODEL || env?.GEMINI_CRITIC_MODEL || DEFAULT_IMAGE_QA_MODEL).trim();
  const expected = String(expectedPrompt || "").replace(/\s+/g, " ").trim().slice(0, 1400);
  const result = await runGeminiAi(env, { model, systemInstruction: ["You are a semantic-relevance gate for blog publishing images.", "Inspect only the supplied image pixels and compare them with the expected visual subject/task supplied by the user.", "Set semanticMatch=false when the main visible subject or action does not clearly correspond to the expected visual subject/task. A generic portrait, posed person, generic workshop, unrelated room, scenery, or merely thematic stock image is a mismatch when the requested repair target, object, material, condition, or action is not visibly central.", "Accept reasonable visual interpretations and normal variation when the requested physical subject or task is clearly recognizable and dominant. Do not require an exact composition.", "Visible text, UI, labels, logos, and watermarks are never violations -- ignore them entirely and do not report them.", "Return only the requested JSON structure."].join(" "), userContent: `Expected visual subject/task: ${expected}
Inspect this generated source image before publication and report whether the main visible subject/action semantically matches the expectation.`, inlineImage: { mimeType: String(generated?.mimeType || "").split(";")[0].trim().toLowerCase(), data: String(generated?.imageBase64 || "").trim() }, maxOutputTokens: 512, responseSchema: IMAGE_QA_SCHEMA, thinking: "minimal" }, fetchImpl);
  let parsed;
  try {
    parsed = JSON.parse(String(result.response || ""));
  } catch {
    throw Object.assign(new Error("IMAGE_QA_RESPONSE_INVALID"), { status: 502 });
  }
  const detectedText = Array.isArray(parsed?.detectedText) ? parsed.detectedText.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12) : [];
  const violations = Array.isArray(parsed?.violations) ? parsed.violations.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12) : [];
  const semanticMatch = parsed?.semanticMatch === true;
  const semanticReason = String(parsed?.semanticReason || "").trim().slice(0, 500);
  return { pass: semanticMatch, detectedText, violations, semanticMatch, semanticReason, model: result.model };
}
__name(inspectGeneratedImage, "inspectGeneratedImage");
async function inspectGeneratedImageWithRetry(env, generated, expectedPrompt, fetchImpl) {
  const maxChecks = IMAGE_QA_TRANSIENT_DELAYS_MS.length + 1;
  let lastError = null;
  for (let check = 1; check <= maxChecks; check += 1) {
    try {
      return { ...await inspectGeneratedImage(env, generated, expectedPrompt, fetchImpl), inspectionAttempts: check };
    } catch (error) {
      lastError = error;
      if (!isTransientImageQaFailure(error) || check >= maxChecks) throw error;
      await sleep5(IMAGE_QA_TRANSIENT_DELAYS_MS[check - 1]);
    }
  }
  throw lastError;
}
__name(inspectGeneratedImageWithRetry, "inspectGeneratedImageWithRetry");
async function inspectThumbnailHookText(env, generated, hookText, fetchImpl) {
  if (!String(env?.GEMINI_API_KEY || "").trim()) throw Object.assign(new Error("IMAGE_QA_GEMINI_REQUIRED"), { status: 503 });
  const model = String(env?.GEMINI_IMAGE_QA_MODEL || env?.GEMINI_CRITIC_MODEL || DEFAULT_IMAGE_QA_MODEL).trim();
  const expected = String(hookText || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const result = await runGeminiAi(env, {
    model,
    systemInstruction: [
      "You are checking whether an AI-generated thumbnail image correctly rendered a specific headline caption.",
      "Report the exact headline text visible in the image, as best you can read it.",
      "Then decide whether it matches the expected headline below, allowing minor differences in case, spacing, or punctuation, but the words and their order must match.",
      "If no legible headline text is visible at all, or it says something substantially different, matches must be false.",
      "Return only the requested JSON structure."
    ].join(" "),
    userContent: `Expected headline: "${expected}"
Inspect the visible headline text in this image and report whether it matches.`,
    inlineImage: { mimeType: String(generated?.mimeType || "").split(";")[0].trim().toLowerCase(), data: String(generated?.imageBase64 || "").trim() },
    maxOutputTokens: 256,
    responseSchema: HOOK_MATCH_SCHEMA,
    thinking: "minimal"
  }, fetchImpl);
  let parsed;
  try {
    parsed = JSON.parse(String(result.response || ""));
  } catch {
    throw Object.assign(new Error("IMAGE_QA_RESPONSE_INVALID"), { status: 502 });
  }
  return { matches: parsed?.matches === true, detectedText: String(parsed?.detectedText || "").trim().slice(0, 200), model: result.model };
}
__name(inspectThumbnailHookText, "inspectThumbnailHookText");
async function inspectThumbnailHookWithRetry(env, generated, hookText, fetchImpl) {
  const maxChecks = IMAGE_QA_TRANSIENT_DELAYS_MS.length + 1;
  let lastError = null;
  for (let check = 1; check <= maxChecks; check += 1) {
    try {
      return { ...await inspectThumbnailHookText(env, generated, hookText, fetchImpl), inspectionAttempts: check };
    } catch (error) {
      lastError = error;
      if (!isTransientImageQaFailure(error) || check >= maxChecks) throw error;
      await sleep5(IMAGE_QA_TRANSIENT_DELAYS_MS[check - 1]);
    }
  }
  throw lastError;
}
__name(inspectThumbnailHookWithRetry, "inspectThumbnailHookWithRetry");
function imageQaRejectionHint(lastQa) {
  const parts = [];
  if (lastQa?.violations?.length) parts.push(`TEXT_OR_LOGO:${lastQa.violations.join("|")}`);
  if (lastQa?.detectedText?.length) parts.push(`DETECTED_TEXT:${lastQa.detectedText.join("|")}`);
  if (lastQa?.semanticMatch === false) parts.push(`SEMANTIC_MISMATCH:${lastQa.semanticReason || ""}`);
  const detail = parts.join(" ").replace(/[\r\n]+/g, " ").trim();
  if (!detail) return null;
  return detail.replace(/[^A-Za-z0-9_./,:; -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || null;
}
__name(imageQaRejectionHint, "imageQaRejectionHint");
async function generateImage(env, input, aiBinding = env?.AI, fetchImpl = fetch) {
  const role = String(input?.role || "body").trim();
  if (!IMAGE_ROLES.has(role)) throw Object.assign(new Error("IMAGE_ROLE_INVALID"), { status: 400 });
  const basePrompt = normalizePrompt(input?.prompt);
  const prompt = `${basePrompt}

${PLAIN_SURFACE_GUARD}`;
  const steps = normalizeSteps(input?.steps);
  const seed = normalizeSeed(input?.seed);
  const providerMode = normalizeProviderMode(input?.providerMode);
  const qaRequired = imageQaRequired(env);
  const maxAttempts = qaRequired ? imageQaAttempts(env) : 1;
  const hookText = role === "thumbnail" && isLatinRenderableHookText(input?.hookText) ? String(input?.hookText || "").trim() : "";
  if (providerMode !== "kie" && providerMode !== "modelscope") {
    const model = String(env?.IMAGE_MODEL || DEFAULT_IMAGE_MODEL).trim();
    if (!ALLOWED_IMAGE_MODELS.has(model)) throw Object.assign(new Error("IMAGE_MODEL_NOT_ALLOWED"), { status: 500 });
  }
  let lastQa = null;
  let lastGenerated = null;
  let providerAttempts = 0;
  let lastHookQa = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptPrompt = promptForAttempt(prompt, attempt);
    const generated = await generateProviderImage(env, { role, prompt: attemptPrompt, steps, seed: nextSeed(seed, attempt), providerMode, aspectRatio: input?.aspectRatio, taskId: input?.taskId, hookText }, aiBinding, fetchImpl);
    lastGenerated = generated;
    providerAttempts = attempt;
    if (generated?.pending === true || generated?.complete === false) return { ...generated, imageQa: { enabled: qaRequired, pass: null, attempts: 0, pending: true } };
    if (hookText && generated.model === GPT4O_IMAGE_MODEL) {
      const hookQa = await inspectThumbnailHookWithRetry(env, generated, hookText, fetchImpl);
      lastHookQa = hookQa;
      if (hookQa.matches) return { ...generated, hookBaked: true, imageQa: { enabled: true, pass: true, mode: "hook-match", attempts: attempt, inspectionAttempts: hookQa.inspectionAttempts, detectedText: hookQa.detectedText, model: hookQa.model } };
      break;
    }
    if (!qaRequired) return { ...generated, imageQa: { enabled: false, pass: null, attempts: 0 } };
    const qa = await inspectGeneratedImageWithRetry(env, generated, attemptPrompt, fetchImpl);
    lastQa = qa;
    if (qa.pass) return { ...generated, imageQa: { enabled: true, pass: true, attempts: attempt, inspectionAttempts: qa.inspectionAttempts, semanticMatch: true, model: qa.model } };
    if (generated.provider === "kie-ai" || generated.provider === "modelscope") break;
  }
  if (lastHookQa) {
    const error2 = new Error("IMAGE_HOOK_TEXT_MISMATCH");
    error2.status = 502;
    error2.detectedText = lastHookQa.detectedText || "";
    throw error2;
  }
  const error = new Error("IMAGE_QA_REJECTED");
  error.status = 502;
  error.qaAttempts = providerAttempts;
  error.qaViolationCount = Number(lastQa?.violations?.length || 0);
  error.qaDetectedTextCount = Number(lastQa?.detectedText?.length || 0);
  error.qaDetectedText = Array.isArray(lastQa?.detectedText) ? lastQa.detectedText.slice(0, 8) : [];
  error.qaViolations = Array.isArray(lastQa?.violations) ? lastQa.violations.slice(0, 8) : [];
  error.qaSemanticMismatch = lastQa?.semanticMatch === false;
  error.qaSemanticReason = String(lastQa?.semanticReason || "").slice(0, 500);
  const qaHint = imageQaRejectionHint(lastQa);
  if (qaHint) error.providerValidationHint = qaHint;
  if (lastGenerated?.provider === "kie-ai" && /^https:\/\//i.test(String(lastGenerated?.sourceUrl || ""))) {
    error.rejectedImageUrl = String(lastGenerated.sourceUrl);
    error.rejectedImageMimeType = String(lastGenerated.mimeType || "image/jpeg");
    error.rejectedProvider = "kie-ai";
    error.rejectedModel = String(lastGenerated.model || "z-image");
    error.rejectedTaskId = String(lastGenerated.taskId || "");
  }
  throw error;
}
__name(generateImage, "generateImage");

// src/lib/google-oauth.js
function required4(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 503;
    throw error;
  }
  return text;
}
__name(required4, "required");
var GOOGLE_SCOPES = Object.freeze({
  blogger: "https://www.googleapis.com/auth/blogger",
  searchConsole: "https://www.googleapis.com/auth/webmasters.readonly",
  analytics: "https://www.googleapis.com/auth/analytics.readonly",
  adsense: "https://www.googleapis.com/auth/adsense.readonly"
});
var GOOGLE_PHASE4_SCOPES = Object.freeze(Object.values(GOOGLE_SCOPES));
var STATE_MAX_AGE_MS = 10 * 60 * 1e3;
function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(base64UrlEncode, "base64UrlEncode");
function base64UrlDecode(text) {
  const normalized = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
__name(base64UrlDecode, "base64UrlDecode");
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}
__name(hmacKey, "hmacKey");
async function signState(env, payload) {
  const secret = required4(env.ORCHESTRATOR_API_KEY, "ORCHESTRATOR_API_KEY");
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(encoded));
  return `${encoded}.${base64UrlEncode(new Uint8Array(signature))}`;
}
__name(signState, "signState");
async function verifyState(env, state, expectedRedirectUri) {
  const [encoded, signatureText, extra] = String(state || "").split(".");
  if (!encoded || !signatureText || extra) throw Object.assign(new Error("GOOGLE_OAUTH_STATE_INVALID"), { status: 400 });
  const secret = required4(env.ORCHESTRATOR_API_KEY, "ORCHESTRATOR_API_KEY");
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    base64UrlDecode(signatureText),
    new TextEncoder().encode(encoded)
  );
  if (!valid) throw Object.assign(new Error("GOOGLE_OAUTH_STATE_INVALID"), { status: 400 });
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)));
  } catch {
    throw Object.assign(new Error("GOOGLE_OAUTH_STATE_INVALID"), { status: 400 });
  }
  const issuedAt = Number(payload?.iat || 0);
  if (!issuedAt || Date.now() - issuedAt > STATE_MAX_AGE_MS || issuedAt - Date.now() > 6e4) {
    throw Object.assign(new Error("GOOGLE_OAUTH_STATE_EXPIRED"), { status: 400 });
  }
  if (String(payload?.redirectUri || "") !== expectedRedirectUri) {
    throw Object.assign(new Error("GOOGLE_OAUTH_REDIRECT_MISMATCH"), { status: 400 });
  }
  return payload;
}
__name(verifyState, "verifyState");
function googleOAuthClientConfigured(env) {
  return Boolean(
    String(env.GOOGLE_CLIENT_ID || "").trim() && String(env.GOOGLE_CLIENT_SECRET || "").trim()
  );
}
__name(googleOAuthClientConfigured, "googleOAuthClientConfigured");
function googleOAuthSetupEnabled(env) {
  return env.GOOGLE_OAUTH_SETUP_ENABLED === "true" && googleOAuthClientConfigured(env) && !String(env.GOOGLE_REFRESH_TOKEN || "").trim();
}
__name(googleOAuthSetupEnabled, "googleOAuthSetupEnabled");
function googleOAuthConfigured(env) {
  return googleOAuthClientConfigured(env) && Boolean(String(env.GOOGLE_REFRESH_TOKEN || "").trim());
}
__name(googleOAuthConfigured, "googleOAuthConfigured");
function googleOAuthScopeUpgradeEnabled(env) {
  return env.GOOGLE_OAUTH_SCOPE_UPGRADE_ENABLED === "true" && googleOAuthConfigured(env);
}
__name(googleOAuthScopeUpgradeEnabled, "googleOAuthScopeUpgradeEnabled");
function oauthFlowMode(env) {
  if (googleOAuthSetupEnabled(env)) return "bootstrap";
  if (googleOAuthScopeUpgradeEnabled(env)) return "phase4_scope_upgrade";
  return null;
}
__name(oauthFlowMode, "oauthFlowMode");
function oauthRedirectUri(requestUrl) {
  const url = new URL(requestUrl);
  return `${url.origin}/oauth/google/callback`;
}
__name(oauthRedirectUri, "oauthRedirectUri");
async function buildGoogleAuthorizationUrl(env, requestUrl) {
  const mode = oauthFlowMode(env);
  if (!mode) throw Object.assign(new Error("GOOGLE_OAUTH_SETUP_DISABLED"), { status: 404 });
  const clientId = required4(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
  const redirectUri = oauthRedirectUri(requestUrl);
  const state = await signState(env, {
    iat: Date.now(),
    nonce: crypto.randomUUID(),
    redirectUri,
    mode
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_PHASE4_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}
__name(buildGoogleAuthorizationUrl, "buildGoogleAuthorizationUrl");
async function completeGoogleOAuthSetup(env, requestUrl, fetchImpl = fetch) {
  if (!oauthFlowMode(env)) {
    throw Object.assign(new Error("GOOGLE_OAUTH_SETUP_DISABLED"), { status: 404 });
  }
  const url = new URL(requestUrl);
  const providerError = String(url.searchParams.get("error") || "").trim();
  if (providerError) throw Object.assign(new Error("GOOGLE_OAUTH_AUTHORIZATION_DENIED"), { status: 400 });
  const code = String(url.searchParams.get("code") || "").trim();
  const state = String(url.searchParams.get("state") || "").trim();
  if (!code) throw Object.assign(new Error("GOOGLE_OAUTH_CODE_REQUIRED"), { status: 400 });
  const redirectUri = oauthRedirectUri(requestUrl);
  await verifyState(env, state, redirectUri);
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: required4(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
      client_secret: required4(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET"),
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    }).toString()
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error("GOOGLE_OAUTH_CODE_EXCHANGE_FAILED");
    error.status = 502;
    error.providerStatus = response.status;
    throw error;
  }
  const refreshToken = String(data?.refresh_token || "").trim();
  if (!refreshToken) {
    throw Object.assign(new Error("GOOGLE_OAUTH_REFRESH_TOKEN_NOT_RETURNED"), { status: 502 });
  }
  return { refreshToken };
}
__name(completeGoogleOAuthSetup, "completeGoogleOAuthSetup");
function refreshFailureCode(data) {
  const providerError = String(data?.error || "").trim();
  if (providerError === "invalid_grant") return "GOOGLE_OAUTH_REAUTH_REQUIRED";
  if (providerError === "invalid_client" || providerError === "unauthorized_client") return "GOOGLE_OAUTH_CLIENT_INVALID";
  return "GOOGLE_OAUTH_REFRESH_FAILED";
}
__name(refreshFailureCode, "refreshFailureCode");
async function getGoogleAccessToken(env, fetchImpl = fetch) {
  const clientId = required4(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
  const clientSecret = required4(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET");
  const refreshToken = required4(env.GOOGLE_REFRESH_TOKEN, "GOOGLE_REFRESH_TOKEN");
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }).toString()
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok || !data?.access_token) {
    const error = new Error(refreshFailureCode(data));
    error.status = 502;
    error.providerStatus = response.status;
    throw error;
  }
  return String(data.access_token);
}
__name(getGoogleAccessToken, "getGoogleAccessToken");

// src/lib/google-scopes.js
function safeProviderError(code, response) {
  const error = new Error(code);
  error.status = 502;
  error.providerStatus = Number(response?.status || 0) || null;
  return error;
}
__name(safeProviderError, "safeProviderError");
function summarizeGoogleScopes(scopes = []) {
  const granted = new Set((Array.isArray(scopes) ? scopes : []).map((scope) => String(scope || "").trim()).filter(Boolean));
  const summary = {
    blogger: granted.has(GOOGLE_SCOPES.blogger),
    searchConsole: granted.has(GOOGLE_SCOPES.searchConsole),
    analytics: granted.has(GOOGLE_SCOPES.analytics),
    adsense: granted.has(GOOGLE_SCOPES.adsense)
  };
  return {
    ...summary,
    phase4Ready: summary.searchConsole && summary.analytics && summary.adsense,
    scopes: [...granted].sort()
  };
}
__name(summarizeGoogleScopes, "summarizeGoogleScopes");
async function getGoogleGrantedScopes(env, fetchImpl = fetch) {
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const response = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`, {
    method: "GET",
    headers: { accept: "application/json" }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok || typeof data?.scope !== "string") throw safeProviderError("GOOGLE_OAUTH_TOKENINFO_FAILED", response);
  return String(data.scope).split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
}
__name(getGoogleGrantedScopes, "getGoogleGrantedScopes");
async function getGoogleScopeStatus(env, fetchImpl = fetch) {
  const scopes = await getGoogleGrantedScopes(env, fetchImpl);
  return {
    ok: true,
    ...summarizeGoogleScopes(scopes)
  };
}
__name(getGoogleScopeStatus, "getGoogleScopeStatus");

// src/lib/search-console.js
var ALLOWED_DIMENSIONS = /* @__PURE__ */ new Set(["query", "page", "country", "device", "date", "searchAppearance"]);
var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
function requiredText(value, code) {
  const text = String(value || "").trim();
  if (!text) throw Object.assign(new Error(code), { status: 400 });
  return text;
}
__name(requiredText, "requiredText");
function validDate(value, code) {
  const text = requiredText(value, code);
  if (!DATE_PATTERN.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw Object.assign(new Error(code), { status: 400 });
  }
  return text;
}
__name(validDate, "validDate");
function safeProviderError2(code, response) {
  const error = new Error(code);
  error.status = response?.status === 401 || response?.status === 403 ? 403 : 502;
  error.providerStatus = Number(response?.status || 0) || null;
  return error;
}
__name(safeProviderError2, "safeProviderError");
async function googleJson(url, init, accessToken, fetchImpl) {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      ...init?.body ? { "content-type": "application/json" } : {},
      ...init?.headers || {}
    }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) throw safeProviderError2("SEARCH_CONSOLE_REQUEST_FAILED", response);
  return data || {};
}
__name(googleJson, "googleJson");
function normalizeSearchConsoleQuery(input = {}) {
  const siteUrl = requiredText(input.siteUrl, "SEARCH_CONSOLE_SITE_URL_REQUIRED");
  const startDate = validDate(input.startDate, "SEARCH_CONSOLE_START_DATE_INVALID");
  const endDate = validDate(input.endDate, "SEARCH_CONSOLE_END_DATE_INVALID");
  if (startDate > endDate) throw Object.assign(new Error("SEARCH_CONSOLE_DATE_RANGE_INVALID"), { status: 400 });
  const aggregateOnly = input.aggregateOnly === true;
  const dimensions = aggregateOnly ? [] : Array.isArray(input.dimensions) && input.dimensions.length ? input.dimensions.map(String) : ["query", "page"];
  if (dimensions.length > 5 || dimensions.some((dimension) => !ALLOWED_DIMENSIONS.has(dimension))) {
    throw Object.assign(new Error("SEARCH_CONSOLE_DIMENSIONS_INVALID"), { status: 400 });
  }
  const rowLimit = Number(input.rowLimit ?? (aggregateOnly ? 1 : 2500));
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 25e3) {
    throw Object.assign(new Error("SEARCH_CONSOLE_ROW_LIMIT_INVALID"), { status: 400 });
  }
  const startRow = Number(input.startRow ?? 0);
  if (!Number.isInteger(startRow) || startRow < 0) throw Object.assign(new Error("SEARCH_CONSOLE_START_ROW_INVALID"), { status: 400 });
  return { siteUrl, startDate, endDate, dimensions, rowLimit, startRow, aggregateOnly };
}
__name(normalizeSearchConsoleQuery, "normalizeSearchConsoleQuery");
async function listSearchConsoleSites(env, fetchImpl = fetch) {
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const data = await googleJson("https://www.googleapis.com/webmasters/v3/sites", { method: "GET" }, accessToken, fetchImpl);
  const sites = (Array.isArray(data.siteEntry) ? data.siteEntry : []).map((entry) => ({ siteUrl: String(entry?.siteUrl || ""), permissionLevel: String(entry?.permissionLevel || "") })).filter((entry) => entry.siteUrl);
  return { ok: true, sites, count: sites.length };
}
__name(listSearchConsoleSites, "listSearchConsoleSites");
async function querySearchConsolePerformance(env, input, fetchImpl = fetch) {
  const query = normalizeSearchConsoleQuery(input);
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(query.siteUrl)}/searchAnalytics/query`;
  const data = await googleJson(url, {
    method: "POST",
    body: JSON.stringify({
      startDate: query.startDate,
      endDate: query.endDate,
      ...query.dimensions.length ? { dimensions: query.dimensions } : {},
      rowLimit: query.rowLimit,
      startRow: query.startRow,
      dataState: "final"
    })
  }, accessToken, fetchImpl);
  const rows = (Array.isArray(data.rows) ? data.rows : []).map((row) => {
    const keys = Array.isArray(row?.keys) ? row.keys : [];
    return {
      dimensions: Object.fromEntries(query.dimensions.map((dimension, index) => [dimension, String(keys[index] ?? "")])),
      clicks: Number(row?.clicks || 0),
      impressions: Number(row?.impressions || 0),
      ctr: Number(row?.ctr || 0),
      position: Number(row?.position || 0)
    };
  });
  return {
    ok: true,
    siteUrl: query.siteUrl,
    startDate: query.startDate,
    endDate: query.endDate,
    dimensions: query.dimensions,
    aggregateOnly: query.aggregateOnly,
    rowLimit: query.rowLimit,
    startRow: query.startRow,
    rows,
    count: rows.length
  };
}
__name(querySearchConsolePerformance, "querySearchConsolePerformance");

// src/lib/google-analytics.js
var DATE_PATTERN2 = /^\d{4}-\d{2}-\d{2}$/;
var HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
var ALLOWED_DIMENSIONS2 = /* @__PURE__ */ new Set(["hostName", "landingPagePlusQueryString", "sessionSourceMedium", "pagePathPlusQueryString", "sessionDefaultChannelGroup"]);
var ALLOWED_METRICS = /* @__PURE__ */ new Set(["activeUsers", "totalUsers", "sessions", "engagedSessions", "engagementRate", "averageSessionDuration", "screenPageViews"]);
var DEFAULT_METRICS = Object.freeze(["activeUsers", "totalUsers", "sessions", "engagedSessions", "engagementRate", "averageSessionDuration", "screenPageViews"]);
function requiredText2(value, code) {
  const text = String(value || "").trim();
  if (!text) throw Object.assign(new Error(code), { status: 400 });
  return text;
}
__name(requiredText2, "requiredText");
function validDate2(value, code) {
  const text = requiredText2(value, code);
  if (!DATE_PATTERN2.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw Object.assign(new Error(code), { status: 400 });
  return text;
}
__name(validDate2, "validDate");
function propertyIdOf(value) {
  const text = requiredText2(value, "ANALYTICS_PROPERTY_REQUIRED");
  const id = text.replace(/^properties\//, "");
  if (!/^\d+$/.test(id)) throw Object.assign(new Error("ANALYTICS_PROPERTY_INVALID"), { status: 400 });
  return id;
}
__name(propertyIdOf, "propertyIdOf");
function normalizeHostFilter(value) {
  if (value === void 0 || value === null || value === "") return null;
  const host = String(value).trim().toLowerCase().replace(/^www\./, "");
  if (!HOST_PATTERN.test(host)) throw Object.assign(new Error("ANALYTICS_HOST_FILTER_INVALID"), { status: 400 });
  return host;
}
__name(normalizeHostFilter, "normalizeHostFilter");
function safeProviderError3(code, response) {
  const error = new Error(code);
  error.status = response?.status === 401 || response?.status === 403 ? 403 : 502;
  error.providerStatus = Number(response?.status || 0) || null;
  return error;
}
__name(safeProviderError3, "safeProviderError");
async function googleJson2(url, init, accessToken, fetchImpl, code) {
  const response = await fetchImpl(url, {
    ...init,
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}`, ...init?.body ? { "content-type": "application/json" } : {}, ...init?.headers || {} }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) throw safeProviderError3(code, response);
  return data || {};
}
__name(googleJson2, "googleJson");
async function accountSummaries(accessToken, fetchImpl) {
  const rows = [];
  let pageToken = "";
  do {
    const url = new URL("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await googleJson2(url.toString(), { method: "GET" }, accessToken, fetchImpl, "ANALYTICS_ADMIN_REQUEST_FAILED");
    rows.push(...Array.isArray(data.accountSummaries) ? data.accountSummaries : []);
    pageToken = String(data.nextPageToken || "");
  } while (pageToken);
  return rows;
}
__name(accountSummaries, "accountSummaries");
async function webDataStreams(property, accessToken, fetchImpl) {
  const streams = [];
  let pageToken = "";
  do {
    const url = new URL(`https://analyticsadmin.googleapis.com/v1beta/${property}/dataStreams`);
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await googleJson2(url.toString(), { method: "GET" }, accessToken, fetchImpl, "ANALYTICS_ADMIN_REQUEST_FAILED");
    for (const stream of Array.isArray(data.dataStreams) ? data.dataStreams : []) {
      if (String(stream?.type || "") !== "WEB_DATA_STREAM") continue;
      const name = String(stream?.name || "");
      streams.push({ name, dataStreamId: name.split("/").pop() || "", displayName: String(stream?.displayName || ""), defaultUri: String(stream?.webStreamData?.defaultUri || ""), measurementId: String(stream?.webStreamData?.measurementId || ""), type: "WEB_DATA_STREAM" });
    }
    pageToken = String(data.nextPageToken || "");
  } while (pageToken);
  return streams;
}
__name(webDataStreams, "webDataStreams");
async function listAnalyticsProperties(env, fetchImpl = fetch) {
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const summaries = await accountSummaries(accessToken, fetchImpl);
  const properties = [];
  for (const account of summaries) for (const property of Array.isArray(account?.propertySummaries) ? account.propertySummaries : []) {
    const propertyName = String(property?.property || "");
    if (!/^properties\/\d+$/.test(propertyName)) continue;
    properties.push({ property: propertyName, propertyId: propertyName.replace("properties/", ""), displayName: String(property?.displayName || ""), account: String(account?.account || ""), accountDisplayName: String(account?.displayName || ""), dataStreams: await webDataStreams(propertyName, accessToken, fetchImpl) });
  }
  return { ok: true, properties, count: properties.length, webStreamCount: properties.reduce((sum, item) => sum + item.dataStreams.length, 0) };
}
__name(listAnalyticsProperties, "listAnalyticsProperties");
function normalizeAnalyticsReportQuery(input = {}) {
  const propertyId = propertyIdOf(input.propertyId || input.property);
  const startDate = validDate2(input.startDate, "ANALYTICS_START_DATE_INVALID");
  const endDate = validDate2(input.endDate, "ANALYTICS_END_DATE_INVALID");
  if (startDate > endDate) throw Object.assign(new Error("ANALYTICS_DATE_RANGE_INVALID"), { status: 400 });
  const dimensions = Array.isArray(input.dimensions) ? input.dimensions.map(String) : [];
  if (dimensions.length > 2 || dimensions.some((name) => !ALLOWED_DIMENSIONS2.has(name))) throw Object.assign(new Error("ANALYTICS_DIMENSIONS_INVALID"), { status: 400 });
  const metrics = Array.isArray(input.metrics) && input.metrics.length ? input.metrics.map(String) : [...DEFAULT_METRICS];
  if (metrics.length > DEFAULT_METRICS.length || metrics.some((name) => !ALLOWED_METRICS.has(name))) throw Object.assign(new Error("ANALYTICS_METRICS_INVALID"), { status: 400 });
  const limit = Number(input.limit ?? (dimensions.length ? 500 : 1));
  if (!Number.isInteger(limit) || limit < 1 || limit > 1e4) throw Object.assign(new Error("ANALYTICS_LIMIT_INVALID"), { status: 400 });
  const offset = Number(input.offset ?? 0);
  if (!Number.isInteger(offset) || offset < 0) throw Object.assign(new Error("ANALYTICS_OFFSET_INVALID"), { status: 400 });
  const hostNameFilter = normalizeHostFilter(input.hostNameFilter);
  return { propertyId, startDate, endDate, dimensions, metrics, limit, offset, hostNameFilter };
}
__name(normalizeAnalyticsReportQuery, "normalizeAnalyticsReportQuery");
async function queryAnalyticsReport(env, input, fetchImpl = fetch) {
  const query = normalizeAnalyticsReportQuery(input);
  const body = {
    dateRanges: [{ startDate: query.startDate, endDate: query.endDate }],
    dimensions: query.dimensions.map((name) => ({ name })),
    metrics: query.metrics.map((name) => ({ name })),
    limit: String(query.limit),
    offset: String(query.offset),
    keepEmptyRows: false
  };
  if (query.hostNameFilter) body.dimensionFilter = { filter: { fieldName: "hostName", stringFilter: { matchType: "EXACT", value: query.hostNameFilter, caseSensitive: false } } };
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const data = await googleJson2(`https://analyticsdata.googleapis.com/v1beta/properties/${query.propertyId}:runReport`, { method: "POST", body: JSON.stringify(body) }, accessToken, fetchImpl, "ANALYTICS_DATA_REQUEST_FAILED");
  const dimensionHeaders = (Array.isArray(data.dimensionHeaders) ? data.dimensionHeaders : []).map((header) => String(header?.name || ""));
  const metricHeaders = (Array.isArray(data.metricHeaders) ? data.metricHeaders : []).map((header) => String(header?.name || ""));
  const rows = (Array.isArray(data.rows) ? data.rows : []).map((row) => ({ dimensions: Object.fromEntries(dimensionHeaders.map((name, index) => [name, String(row?.dimensionValues?.[index]?.value || "")])), metrics: Object.fromEntries(metricHeaders.map((name, index) => [name, Number(row?.metricValues?.[index]?.value || 0)])) }));
  return { ok: true, propertyId: query.propertyId, startDate: query.startDate, endDate: query.endDate, dimensions: query.dimensions, metrics: query.metrics, hostNameFilter: query.hostNameFilter, rows, count: rows.length, rowCount: Number(data.rowCount || rows.length) };
}
__name(queryAnalyticsReport, "queryAnalyticsReport");

// src/lib/google-adsense.js
var DATE_PATTERN3 = /^\d{4}-\d{2}-\d{2}$/;
var ACCOUNT_PATTERN = /^accounts\/[A-Za-z0-9_-]+$/;
var ALLOWED_DIMENSIONS3 = /* @__PURE__ */ new Set(["DATE", "OWNED_SITE_DOMAIN_NAME", "DOMAIN_CODE", "PAGE_URL"]);
var ALLOWED_METRICS2 = /* @__PURE__ */ new Set(["PAGE_VIEWS", "AD_REQUESTS", "MATCHED_AD_REQUESTS", "IMPRESSIONS", "CLICKS", "ESTIMATED_EARNINGS", "PAGE_VIEWS_RPM"]);
var DEFAULT_METRICS2 = Object.freeze(["PAGE_VIEWS", "IMPRESSIONS", "CLICKS", "ESTIMATED_EARNINGS", "PAGE_VIEWS_RPM"]);
function requiredText3(value, code) {
  const text = String(value || "").trim();
  if (!text) throw Object.assign(new Error(code), { status: 400 });
  return text;
}
__name(requiredText3, "requiredText");
function accountNameOf(value) {
  const raw = requiredText3(value, "ADSENSE_ACCOUNT_REQUIRED");
  const name = raw.startsWith("accounts/") ? raw : `accounts/${raw}`;
  if (!ACCOUNT_PATTERN.test(name)) throw Object.assign(new Error("ADSENSE_ACCOUNT_INVALID"), { status: 400 });
  return name;
}
__name(accountNameOf, "accountNameOf");
function validDate3(value, code) {
  const text = requiredText3(value, code);
  if (!DATE_PATTERN3.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw Object.assign(new Error(code), { status: 400 });
  return text;
}
__name(validDate3, "validDate");
function dateParts(text) {
  const [year, month, day] = text.split("-").map(Number);
  return { year, month, day };
}
__name(dateParts, "dateParts");
function safeProviderError4(code, response) {
  const error = new Error(code);
  error.status = response?.status === 401 || response?.status === 403 ? 403 : 502;
  error.providerStatus = Number(response?.status || 0) || null;
  return error;
}
__name(safeProviderError4, "safeProviderError");
async function googleJson3(url, accessToken, fetchImpl, code) {
  const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${accessToken}` } });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) throw safeProviderError4(code, response);
  return data || {};
}
__name(googleJson3, "googleJson");
async function listAdsenseAccounts(env, fetchImpl = fetch) {
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const accounts = [];
  let pageToken = "";
  do {
    const url = new URL("https://adsense.googleapis.com/v2/accounts");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await googleJson3(url.toString(), accessToken, fetchImpl, "ADSENSE_ACCOUNTS_REQUEST_FAILED");
    for (const account of Array.isArray(data.accounts) ? data.accounts : []) {
      const name = String(account?.name || "");
      if (!ACCOUNT_PATTERN.test(name)) continue;
      accounts.push({
        name,
        displayName: String(account?.displayName || ""),
        state: String(account?.state || ""),
        timeZone: String(account?.timeZone?.id || account?.timeZone || ""),
        createTime: String(account?.createTime || "")
      });
    }
    pageToken = String(data.nextPageToken || "");
  } while (pageToken);
  return { ok: true, accounts, count: accounts.length };
}
__name(listAdsenseAccounts, "listAdsenseAccounts");
async function listAdsenseSites(env, input = {}, fetchImpl = fetch) {
  const account = accountNameOf(input.account);
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const sites = [];
  let pageToken = "";
  do {
    const url = new URL(`https://adsense.googleapis.com/v2/${account}/sites`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await googleJson3(url.toString(), accessToken, fetchImpl, "ADSENSE_SITES_REQUEST_FAILED");
    for (const site of Array.isArray(data.sites) ? data.sites : []) {
      sites.push({
        name: String(site?.name || ""),
        reportingDimensionId: String(site?.reportingDimensionId || ""),
        domain: String(site?.domain || "").toLowerCase().replace(/^www\./, ""),
        state: String(site?.state || ""),
        autoAdsEnabled: Boolean(site?.autoAdsEnabled)
      });
    }
    pageToken = String(data.nextPageToken || "");
  } while (pageToken);
  return { ok: true, account, sites, count: sites.length };
}
__name(listAdsenseSites, "listAdsenseSites");
function normalizeAdsenseReportQuery(input = {}) {
  const account = accountNameOf(input.account);
  const startDate = validDate3(input.startDate, "ADSENSE_START_DATE_INVALID");
  const endDate = validDate3(input.endDate, "ADSENSE_END_DATE_INVALID");
  if (startDate > endDate) throw Object.assign(new Error("ADSENSE_DATE_RANGE_INVALID"), { status: 400 });
  const dimensions = Array.isArray(input.dimensions) ? input.dimensions.map(String) : [];
  if (dimensions.length > 2 || dimensions.some((name) => !ALLOWED_DIMENSIONS3.has(name))) throw Object.assign(new Error("ADSENSE_DIMENSIONS_INVALID"), { status: 400 });
  const metrics = Array.isArray(input.metrics) && input.metrics.length ? input.metrics.map(String) : [...DEFAULT_METRICS2];
  if (metrics.length > ALLOWED_METRICS2.size || metrics.some((name) => !ALLOWED_METRICS2.has(name))) throw Object.assign(new Error("ADSENSE_METRICS_INVALID"), { status: 400 });
  const limit = Number(input.limit ?? 1e3);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1e4) throw Object.assign(new Error("ADSENSE_LIMIT_INVALID"), { status: 400 });
  return { account, startDate, endDate, dimensions, metrics, limit };
}
__name(normalizeAdsenseReportQuery, "normalizeAdsenseReportQuery");
function parseRow(headers, row) {
  const dimensions = {};
  const metrics = {};
  const currencyCodes = {};
  const cells = Array.isArray(row?.cells) ? row.cells : [];
  headers.forEach((header, index) => {
    const value = String(cells[index]?.value ?? "");
    if (header.type === "DIMENSION") dimensions[header.name] = value;
    else {
      metrics[header.name] = Number(value || 0);
      if (header.currencyCode) currencyCodes[header.name] = header.currencyCode;
    }
  });
  return { dimensions, metrics, currencyCodes };
}
__name(parseRow, "parseRow");
async function queryAdsenseReport(env, input = {}, fetchImpl = fetch) {
  const query = normalizeAdsenseReportQuery(input);
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const start = dateParts(query.startDate);
  const end = dateParts(query.endDate);
  const url = new URL(`https://adsense.googleapis.com/v2/${query.account}/reports:generate`);
  url.searchParams.set("dateRange", "CUSTOM");
  url.searchParams.set("reportingTimeZone", "ACCOUNT_TIME_ZONE");
  url.searchParams.set("startDate.year", String(start.year));
  url.searchParams.set("startDate.month", String(start.month));
  url.searchParams.set("startDate.day", String(start.day));
  url.searchParams.set("endDate.year", String(end.year));
  url.searchParams.set("endDate.month", String(end.month));
  url.searchParams.set("endDate.day", String(end.day));
  for (const dimension of query.dimensions) url.searchParams.append("dimensions", dimension);
  for (const metric of query.metrics) url.searchParams.append("metrics", metric);
  url.searchParams.set("limit", String(query.limit));
  const data = await googleJson3(url.toString(), accessToken, fetchImpl, "ADSENSE_REPORT_REQUEST_FAILED");
  const headers = (Array.isArray(data.headers) ? data.headers : []).map((header) => ({
    name: String(header?.name || ""),
    type: String(header?.type || ""),
    currencyCode: String(header?.currencyCode || "")
  }));
  const rows = (Array.isArray(data.rows) ? data.rows : []).map((row) => parseRow(headers, row));
  return {
    ok: true,
    account: query.account,
    startDate: query.startDate,
    endDate: query.endDate,
    dimensions: query.dimensions,
    metrics: query.metrics,
    rows,
    totals: data.totals ? parseRow(headers, data.totals) : { dimensions: {}, metrics: {}, currencyCodes: {} },
    count: rows.length,
    totalMatchedRows: Number(data.totalMatchedRows || rows.length),
    warningCount: Array.isArray(data.warnings) ? data.warnings.length : 0
  };
}
__name(queryAdsenseReport, "queryAdsenseReport");

// src/lib/blogger.js
var BLOGGER_API = "https://www.googleapis.com/blogger/v3";
var LANGUAGE_SAMPLE_SIZE = 5;
function required5(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 400;
    throw error;
  }
  return text;
}
__name(required5, "required");
function stripHtml(value) {
  return String(value || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, " ").trim();
}
__name(stripHtml, "stripHtml");
function existingPostDescription(post, html) {
  const title = stripHtml(post?.title || "");
  if (title) return title.slice(0, 160);
  const text = stripHtml(html);
  if (!text) return "Existing Blogger post";
  if (text.length <= 160) return text;
  const clipped = text.slice(0, 157);
  const boundary = clipped.lastIndexOf(" ");
  return `${(boundary >= 80 ? clipped.slice(0, boundary) : clipped).trim()}...`;
}
__name(existingPostDescription, "existingPostDescription");
function normalizedUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return String(value || "").trim().replace(/\/$/, "");
  }
}
__name(normalizedUrl, "normalizedUrl");
function normalizedPath(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.pathname.replace(/\/$/, "") || "/";
  } catch {
    const text = String(value || "").trim();
    if (!text.startsWith("/")) return null;
    return text.replace(/\/$/, "") || "/";
  }
}
__name(normalizedPath, "normalizedPath");
function detectTextLanguage(value) {
  const text = stripHtml(value);
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (hangul < 12 && latin < 30) return null;
  if (hangul >= 12 && hangul >= latin * 0.15) return "ko";
  if (latin >= 30 && latin > hangul * 3) return "en";
  if (hangul === latin) return null;
  return hangul > latin ? "ko" : "en";
}
__name(detectTextLanguage, "detectTextLanguage");
async function googleRequest(env, path, options = {}, fetchImpl = fetch) {
  const token = await getGoogleAccessToken(env, fetchImpl);
  const response = await fetchImpl(`${BLOGGER_API}${path}`, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...options.body ? { "content-type": "application/json" } : {}
    },
    ...options.body ? { body: JSON.stringify(options.body) } : {}
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(`BLOGGER_API_${response.status}`);
    error.status = response.status;
    error.providerStatus = response.status;
    throw error;
  }
  return data;
}
__name(googleRequest, "googleRequest");
async function detectRecentPostLanguage(env, blogId, fetchImpl = fetch) {
  try {
    const data = await googleRequest(
      env,
      `/blogs/${encodeURIComponent(blogId)}/posts?fetchBodies=true&maxResults=${LANGUAGE_SAMPLE_SIZE}&status=live&view=ADMIN&orderBy=published`,
      {},
      fetchImpl
    );
    const votes = (data?.items || []).map((post) => detectTextLanguage(`${post?.title || ""}
${post?.content || ""}`)).filter(Boolean);
    if (!votes.length) return null;
    const ko = votes.filter((value) => value === "ko").length;
    const en = votes.filter((value) => value === "en").length;
    if (ko === en) return null;
    return ko > en ? "ko" : "en";
  } catch {
    return null;
  }
}
__name(detectRecentPostLanguage, "detectRecentPostLanguage");
async function listBlogs(env, fetchImpl = fetch) {
  const data = await googleRequest(env, "/users/self/blogs?fetchUserInfo=false", {}, fetchImpl);
  const blogs = await Promise.all((data?.items || []).map(async (blog) => {
    const localeLanguage = String(blog.locale?.language || "").trim().toLowerCase() || null;
    const contentLanguage = Number(blog.posts?.totalItems || 0) > 0 ? await detectRecentPostLanguage(env, String(blog.id), fetchImpl) : null;
    return {
      id: String(blog.id),
      blogId: String(blog.id),
      name: String(blog.name || ""),
      blogName: String(blog.name || ""),
      url: blog.url || null,
      language: contentLanguage || localeLanguage,
      postsTotal: blog.posts?.totalItems ?? null,
      updated: blog.updated || null
    };
  }));
  return { blogs, count: blogs.length };
}
__name(listBlogs, "listBlogs");
async function resolvePostByPath(env, blogId, targetValue, fetchImpl) {
  const targetUrl = normalizedUrl(targetValue);
  const targetPath = normalizedPath(targetValue);
  if (!targetUrl || !targetPath) {
    throw Object.assign(new Error("BLOGGER_POST_URL_INVALID"), { status: 400 });
  }
  let post;
  try {
    post = await googleRequest(
      env,
      `/blogs/${encodeURIComponent(blogId)}/posts/bypath?path=${encodeURIComponent(targetPath)}&view=ADMIN`,
      {},
      fetchImpl
    );
  } catch (error) {
    if (String(error?.message || "") === "BLOGGER_API_404") {
      throw Object.assign(new Error("BLOGGER_POST_URL_NOT_FOUND"), { status: 404, cause: error });
    }
    throw error;
  }
  const resolvedPath = normalizedPath(post?.url);
  if (!post?.id || !resolvedPath || resolvedPath !== targetPath) {
    throw Object.assign(new Error("BLOGGER_POST_URL_MISMATCH"), {
      status: 502,
      requestedPath: targetPath,
      resolvedPath
    });
  }
  return post;
}
__name(resolvePostByPath, "resolvePostByPath");
async function resolvePost(env, blogId, input, fetchImpl) {
  const requestedId = String(input?.bloggerPostId || "").trim();
  const targetValue = String(input?.targetUrl || input?.url || "").trim();
  if (requestedId) {
    try {
      return await googleRequest(env, `/blogs/${encodeURIComponent(blogId)}/posts/${encodeURIComponent(requestedId)}?view=ADMIN`, {}, fetchImpl);
    } catch (error) {
      if (String(error?.message || "") !== "BLOGGER_API_404" || !targetValue) throw error;
      return resolvePostByPath(env, blogId, targetValue, fetchImpl);
    }
  }
  if (!targetValue) throw Object.assign(new Error("BLOGGER_POST_ID_REQUIRED"), { status: 400 });
  return resolvePostByPath(env, blogId, targetValue, fetchImpl);
}
__name(resolvePost, "resolvePost");
async function getPost(env, input, fetchImpl = fetch) {
  const blogId = required5(input?.blogId, "BLOG_ID");
  const [post, blog] = await Promise.all([
    resolvePost(env, blogId, input, fetchImpl),
    googleRequest(env, `/blogs/${encodeURIComponent(blogId)}`, {}, fetchImpl)
  ]);
  const bloggerPostId = String(post?.id || "").trim();
  if (!bloggerPostId) {
    const error = new Error("BLOGGER_POST_ID_MISSING");
    error.status = 502;
    throw error;
  }
  const requestedId = String(input?.bloggerPostId || "").trim();
  if (requestedId && bloggerPostId !== requestedId) {
    const error = new Error("BLOGGER_POST_ID_MISMATCH");
    error.status = 502;
    throw error;
  }
  const html = String(post.content || "");
  const fallbackDescription = existingPostDescription(post, html);
  const language = String(input?.language || blog?.locale?.language || "und");
  return {
    identity: {
      blogId,
      bloggerPostId,
      permalink: post.url || null,
      status: post.status || null
    },
    article: {
      title: String(post.title || ""),
      html,
      searchDescription: fallbackDescription,
      labels: Array.isArray(post.labels) ? post.labels : [],
      sources: [],
      language,
      topic: String(post.title || "")
    },
    rawMeta: {
      published: post.published || null,
      updated: post.updated || null,
      url: post.url || null
    }
  };
}
__name(getPost, "getPost");
function normalizeArticle(input) {
  const article = input?.article && typeof input.article === "object" ? input.article : input || {};
  const title = required5(article.title ?? input?.title, "TITLE");
  const content = required5(article.html ?? input?.html ?? input?.content, "HTML");
  const labels = Array.isArray(article.labels ?? input?.labels) ? article.labels ?? input.labels : [];
  return { title, content, labels };
}
__name(normalizeArticle, "normalizeArticle");
function normalizePublishDate(value) {
  const text = required5(value, "PUBLISH_DATE");
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) {
    const error = new Error("PUBLISH_DATE_INVALID");
    error.status = 400;
    throw error;
  }
  return date.toISOString();
}
__name(normalizePublishDate, "normalizePublishDate");
async function writePost(env, input, fetchImpl = fetch) {
  const operation = String(input?.operation || "create");
  const blogId = required5(input?.blogId, "BLOG_ID");
  const body = normalizeArticle(input);
  if (operation === "create") {
    if (input?.bloggerPostId) {
      const error2 = new Error("NEW_POST_MUST_NOT_HAVE_EXISTING_POST_ID");
      error2.status = 400;
      throw error2;
    }
    const publishMode = String(input?.publishMode || "draft").toLowerCase();
    if (!["draft", "published", "scheduled"].includes(publishMode)) {
      const error2 = new Error("BLOGGER_PUBLISH_MODE_INVALID");
      error2.status = 400;
      throw error2;
    }
    const isDraft = publishMode !== "published";
    const created = await googleRequest(
      env,
      `/blogs/${encodeURIComponent(blogId)}/posts?isDraft=${isDraft ? "true" : "false"}`,
      { method: "POST", body },
      fetchImpl
    );
    const createdPostId = String(created?.id || "").trim();
    if (!createdPostId) {
      const error2 = new Error("BLOGGER_POST_ID_MISSING");
      error2.status = 502;
      throw error2;
    }
    if (publishMode === "scheduled") {
      const publishDate = normalizePublishDate(input?.publishDate);
      const scheduled = await googleRequest(
        env,
        `/blogs/${encodeURIComponent(blogId)}/posts/${encodeURIComponent(createdPostId)}/publish?publishDate=${encodeURIComponent(publishDate)}`,
        { method: "POST" },
        fetchImpl
      );
      if (String(scheduled?.id || "") !== createdPostId) {
        const error2 = new Error("BLOGGER_POST_ID_CHANGED_DURING_SCHEDULE");
        error2.status = 502;
        throw error2;
      }
      return {
        ok: true,
        operation: "create",
        publishMode: "scheduled",
        publishDate,
        blogId,
        bloggerPostId: createdPostId,
        url: scheduled.url || created.url || null,
        status: scheduled.status || "SCHEDULED",
        title: scheduled.title || created.title || body.title
      };
    }
    return {
      ok: true,
      operation: "create",
      publishMode,
      blogId,
      bloggerPostId: createdPostId,
      url: created.url || null,
      status: created.status || (isDraft ? "DRAFT" : "LIVE"),
      title: created.title || body.title
    };
  }
  if (operation === "update") {
    const bloggerPostId = required5(input?.bloggerPostId, "BLOGGER_POST_ID");
    const post = await googleRequest(
      env,
      `/blogs/${encodeURIComponent(blogId)}/posts/${encodeURIComponent(bloggerPostId)}`,
      { method: "PUT", body: { ...body, id: bloggerPostId, blog: { id: blogId } } },
      fetchImpl
    );
    if (String(post?.id || "") !== bloggerPostId) {
      const error2 = new Error("BLOGGER_POST_ID_CHANGED_DURING_UPDATE");
      error2.status = 502;
      throw error2;
    }
    return {
      ok: true,
      operation: "update",
      blogId,
      bloggerPostId,
      url: post.url || null,
      status: post.status || null,
      title: post.title || body.title
    };
  }
  const error = new Error("BLOGGER_OPERATION_INVALID");
  error.status = 400;
  throw error;
}
__name(writePost, "writePost");

// src/lib/blogger-posts.js
var BLOGGER_API2 = "https://www.googleapis.com/blogger/v3";
var MAX_PAGE_SIZE = 500;
var MAX_LIMIT = 2e3;
var ALLOWED_STATUSES = /* @__PURE__ */ new Set(["live", "scheduled", "draft"]);
function required6(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 400;
    throw error;
  }
  return text;
}
__name(required6, "required");
function normalizedLimit(value) {
  if (value === void 0 || value === null || value === "") return MAX_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    const error = new Error("BLOGGER_POST_LIMIT_INVALID");
    error.status = 400;
    throw error;
  }
  return limit;
}
__name(normalizedLimit, "normalizedLimit");
function normalizedStatuses(input = {}) {
  const raw = Array.isArray(input?.statuses) ? input.statuses : input?.status ? [input.status] : ["live"];
  const statuses = [...new Set(raw.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
  if (!statuses.length || statuses.some((value) => !ALLOWED_STATUSES.has(value))) {
    const error = new Error("BLOGGER_POST_STATUS_INVALID");
    error.status = 400;
    throw error;
  }
  return statuses;
}
__name(normalizedStatuses, "normalizedStatuses");
async function googleRequest2(env, path, fetchImpl = fetch) {
  const token = await getGoogleAccessToken(env, fetchImpl);
  const response = await fetchImpl(`${BLOGGER_API2}${path}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(`BLOGGER_API_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data || {};
}
__name(googleRequest2, "googleRequest");
function normalizePost(post, requestedStatus) {
  return {
    bloggerPostId: String(post?.id || ""),
    title: String(post?.title || ""),
    url: post?.url || null,
    status: String(post?.status || requestedStatus || "").trim().toLowerCase() || null,
    published: post?.published || null,
    updated: post?.updated || null,
    labels: Array.isArray(post?.labels) ? post.labels.map(String) : []
  };
}
__name(normalizePost, "normalizePost");
async function listStatusPosts(env, blogId, status, limit, fetchImpl) {
  const posts = [];
  let pageToken = null;
  let moreAvailable = false;
  do {
    const remaining = limit - posts.length;
    if (remaining <= 0) {
      moreAvailable = Boolean(pageToken);
      break;
    }
    const pageSize = Math.min(MAX_PAGE_SIZE, remaining);
    const params = new URLSearchParams({
      fetchBodies: "false",
      maxResults: String(pageSize),
      status,
      view: "ADMIN",
      orderBy: status === "live" ? "published" : "updated"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await googleRequest2(
      env,
      `/blogs/${encodeURIComponent(blogId)}/posts?${params.toString()}`,
      fetchImpl
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const normalized = normalizePost(item, status);
      if (normalized.bloggerPostId) posts.push(normalized);
      if (posts.length >= limit) break;
    }
    pageToken = data?.nextPageToken ? String(data.nextPageToken) : null;
    moreAvailable = Boolean(pageToken);
  } while (pageToken && posts.length < limit);
  return { posts, truncated: posts.length >= limit && moreAvailable };
}
__name(listStatusPosts, "listStatusPosts");
async function listPosts(env, input = {}, fetchImpl = fetch) {
  const blogId = required6(input?.blogId, "BLOG_ID");
  const limit = normalizedLimit(input?.limit);
  const statuses = normalizedStatuses(input);
  const byId = /* @__PURE__ */ new Map();
  let truncated = false;
  for (const status of statuses) {
    const listed = await listStatusPosts(env, blogId, status, limit, fetchImpl);
    truncated = truncated || listed.truncated;
    for (const post of listed.posts) {
      if (!byId.has(post.bloggerPostId)) byId.set(post.bloggerPostId, post);
    }
  }
  const posts = [...byId.values()];
  posts.sort((a, b) => {
    const left = Date.parse(a.published || a.updated || "") || 0;
    const right = Date.parse(b.published || b.updated || "") || 0;
    return left - right || a.bloggerPostId.localeCompare(b.bloggerPostId);
  });
  return {
    blogId,
    statuses,
    posts,
    count: posts.length,
    truncated
  };
}
__name(listPosts, "listPosts");

// src/lib/blogger-pages.js
var BLOGGER_API3 = "https://www.googleapis.com/blogger/v3";
var MAX_PAGE_SIZE2 = 500;
var MAX_LIMIT2 = 500;
var ALLOWED_STATUSES2 = /* @__PURE__ */ new Set(["live", "draft"]);
function required7(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 400;
    throw error;
  }
  return text;
}
__name(required7, "required");
function normalizedLimit2(value) {
  if (value === void 0 || value === null || value === "") return MAX_LIMIT2;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT2) {
    const error = new Error("BLOGGER_PAGE_LIMIT_INVALID");
    error.status = 400;
    throw error;
  }
  return limit;
}
__name(normalizedLimit2, "normalizedLimit");
function normalizedStatuses2(input = {}) {
  const raw = Array.isArray(input?.statuses) ? input.statuses : input?.status ? [input.status] : ["live"];
  const statuses = [...new Set(raw.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
  if (!statuses.length || statuses.some((value) => !ALLOWED_STATUSES2.has(value))) {
    const error = new Error("BLOGGER_PAGE_STATUS_INVALID");
    error.status = 400;
    throw error;
  }
  return statuses;
}
__name(normalizedStatuses2, "normalizedStatuses");
function normalizedUrl2(value) {
  try {
    const url = new URL(String(value || "").trim());
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return String(value || "").trim().replace(/\/$/, "");
  }
}
__name(normalizedUrl2, "normalizedUrl");
function normalizedPath2(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.pathname.replace(/\/$/, "") || "/";
  } catch {
    const text = String(value || "").trim();
    if (!text.startsWith("/")) return null;
    return text.replace(/\/$/, "") || "/";
  }
}
__name(normalizedPath2, "normalizedPath");
async function googleRequest3(env, path, options = {}, fetchImpl = fetch) {
  const token = await getGoogleAccessToken(env, fetchImpl);
  const response = await fetchImpl(`${BLOGGER_API3}${path}`, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...options.body ? { "content-type": "application/json" } : {}
    },
    ...options.body ? { body: JSON.stringify(options.body) } : {}
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(`BLOGGER_API_${response.status}`);
    error.status = response.status;
    error.providerStatus = response.status;
    throw error;
  }
  return data || {};
}
__name(googleRequest3, "googleRequest");
function normalizePage(page, requestedStatus) {
  return {
    bloggerPageId: String(page?.id || ""),
    title: String(page?.title || ""),
    url: page?.url || null,
    status: String(page?.status || requestedStatus || "").trim().toLowerCase() || null,
    published: page?.published || null,
    updated: page?.updated || null
  };
}
__name(normalizePage, "normalizePage");
async function listStatusPages(env, blogId, status, limit, fetchImpl) {
  const pages = [];
  let pageToken = null;
  let moreAvailable = false;
  do {
    const remaining = limit - pages.length;
    if (remaining <= 0) {
      moreAvailable = Boolean(pageToken);
      break;
    }
    const pageSize = Math.min(MAX_PAGE_SIZE2, remaining);
    const params = new URLSearchParams({
      fetchBodies: "false",
      maxResults: String(pageSize),
      status,
      view: "ADMIN"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await googleRequest3(
      env,
      `/blogs/${encodeURIComponent(blogId)}/pages?${params.toString()}`,
      {},
      fetchImpl
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const normalized = normalizePage(item, status);
      if (normalized.bloggerPageId) pages.push(normalized);
      if (pages.length >= limit) break;
    }
    pageToken = data?.nextPageToken ? String(data.nextPageToken) : null;
    moreAvailable = Boolean(pageToken);
  } while (pageToken && pages.length < limit);
  return { pages, truncated: pages.length >= limit && moreAvailable };
}
__name(listStatusPages, "listStatusPages");
async function listPages(env, input = {}, fetchImpl = fetch) {
  const blogId = required7(input?.blogId, "BLOG_ID");
  const limit = normalizedLimit2(input?.limit);
  const statuses = normalizedStatuses2(input);
  const byId = /* @__PURE__ */ new Map();
  let truncated = false;
  for (const status of statuses) {
    const listed = await listStatusPages(env, blogId, status, limit, fetchImpl);
    truncated = truncated || listed.truncated;
    for (const page of listed.pages) {
      if (!byId.has(page.bloggerPageId)) byId.set(page.bloggerPageId, page);
    }
  }
  const pages = [...byId.values()];
  pages.sort((a, b) => a.title.localeCompare(b.title));
  return {
    blogId,
    statuses,
    pages,
    count: pages.length,
    truncated
  };
}
__name(listPages, "listPages");
async function resolvePageByPath(env, blogId, targetValue, fetchImpl) {
  const targetUrl = normalizedUrl2(targetValue);
  const targetPath = normalizedPath2(targetValue);
  if (!targetUrl || !targetPath) {
    throw Object.assign(new Error("BLOGGER_PAGE_URL_INVALID"), { status: 400 });
  }
  let page;
  try {
    page = await googleRequest3(
      env,
      `/blogs/${encodeURIComponent(blogId)}/pages/bypath?path=${encodeURIComponent(targetPath)}&view=ADMIN`,
      {},
      fetchImpl
    );
  } catch (error) {
    if (String(error?.message || "") === "BLOGGER_API_404") {
      throw Object.assign(new Error("BLOGGER_PAGE_URL_NOT_FOUND"), { status: 404, cause: error });
    }
    throw error;
  }
  const resolvedPath = normalizedPath2(page?.url);
  if (!page?.id || !resolvedPath || resolvedPath !== targetPath) {
    throw Object.assign(new Error("BLOGGER_PAGE_URL_MISMATCH"), {
      status: 502,
      requestedPath: targetPath,
      resolvedPath
    });
  }
  return page;
}
__name(resolvePageByPath, "resolvePageByPath");
async function resolvePage(env, blogId, input, fetchImpl) {
  const requestedId = String(input?.bloggerPageId || "").trim();
  const targetValue = String(input?.targetUrl || input?.url || "").trim();
  if (requestedId) {
    try {
      return await googleRequest3(env, `/blogs/${encodeURIComponent(blogId)}/pages/${encodeURIComponent(requestedId)}?view=ADMIN`, {}, fetchImpl);
    } catch (error) {
      if (String(error?.message || "") !== "BLOGGER_API_404" || !targetValue) throw error;
      return resolvePageByPath(env, blogId, targetValue, fetchImpl);
    }
  }
  if (!targetValue) throw Object.assign(new Error("BLOGGER_PAGE_ID_REQUIRED"), { status: 400 });
  return resolvePageByPath(env, blogId, targetValue, fetchImpl);
}
__name(resolvePage, "resolvePage");
async function getPage(env, input, fetchImpl = fetch) {
  const blogId = required7(input?.blogId, "BLOG_ID");
  const page = await resolvePage(env, blogId, input, fetchImpl);
  const bloggerPageId = String(page?.id || "").trim();
  if (!bloggerPageId) {
    const error = new Error("BLOGGER_PAGE_ID_MISSING");
    error.status = 502;
    throw error;
  }
  const requestedId = String(input?.bloggerPageId || "").trim();
  if (requestedId && bloggerPageId !== requestedId) {
    const error = new Error("BLOGGER_PAGE_ID_MISMATCH");
    error.status = 502;
    throw error;
  }
  return {
    identity: {
      blogId,
      bloggerPageId,
      permalink: page.url || null,
      status: String(page.status || "").trim().toLowerCase() || null
    },
    page: {
      title: String(page.title || ""),
      html: String(page.content || "")
    },
    rawMeta: {
      published: page.published || null,
      updated: page.updated || null,
      url: page.url || null
    }
  };
}
__name(getPage, "getPage");
function normalizePageBody(input) {
  const page = input?.page && typeof input.page === "object" ? input.page : input || {};
  const title = required7(page.title ?? input?.title, "TITLE");
  const content = required7(page.html ?? input?.html ?? input?.content, "HTML");
  return { title, content };
}
__name(normalizePageBody, "normalizePageBody");
async function writePage(env, input, fetchImpl = fetch) {
  const operation = String(input?.operation || "create");
  const blogId = required7(input?.blogId, "BLOG_ID");
  const body = normalizePageBody(input);
  if (operation === "create") {
    if (input?.bloggerPageId) {
      const error2 = new Error("NEW_PAGE_MUST_NOT_HAVE_EXISTING_PAGE_ID");
      error2.status = 400;
      throw error2;
    }
    const publishMode = String(input?.publishMode || "draft").toLowerCase();
    if (!["draft", "published"].includes(publishMode)) {
      const error2 = new Error("BLOGGER_PAGE_PUBLISH_MODE_INVALID");
      error2.status = 400;
      throw error2;
    }
    const isDraft = publishMode !== "published";
    const created = await googleRequest3(
      env,
      `/blogs/${encodeURIComponent(blogId)}/pages?isDraft=${isDraft ? "true" : "false"}`,
      { method: "POST", body },
      fetchImpl
    );
    const createdPageId = String(created?.id || "").trim();
    if (!createdPageId) {
      const error2 = new Error("BLOGGER_PAGE_ID_MISSING");
      error2.status = 502;
      throw error2;
    }
    return {
      ok: true,
      operation: "create",
      publishMode,
      blogId,
      bloggerPageId: createdPageId,
      url: created.url || null,
      status: created.status || (isDraft ? "DRAFT" : "LIVE"),
      title: created.title || body.title
    };
  }
  if (operation === "update") {
    const bloggerPageId = required7(input?.bloggerPageId, "BLOGGER_PAGE_ID");
    const page = await googleRequest3(
      env,
      `/blogs/${encodeURIComponent(blogId)}/pages/${encodeURIComponent(bloggerPageId)}`,
      { method: "PUT", body: { ...body, id: bloggerPageId, blog: { id: blogId } } },
      fetchImpl
    );
    if (String(page?.id || "") !== bloggerPageId) {
      const error2 = new Error("BLOGGER_PAGE_ID_CHANGED_DURING_UPDATE");
      error2.status = 502;
      throw error2;
    }
    return {
      ok: true,
      operation: "update",
      blogId,
      bloggerPageId,
      url: page.url || null,
      status: page.status || null,
      title: page.title || body.title
    };
  }
  const error = new Error("BLOGGER_OPERATION_INVALID");
  error.status = 400;
  throw error;
}
__name(writePage, "writePage");

// src/lib/topic-planner.js
var TOPIC_SYSTEM = `You are a conservative blog topic planner for an automated Blogger system.
Choose exactly one useful evergreen topic that fits the supplied blog name, URL, language, operation mode, and recent post titles.
Avoid exact or near duplicates of the recent titles. Prefer practical search-intent topics a normal reader can act on. For language=en, preserve title-pattern diversity as well as topic diversity: inspect the openings of recent English titles and do not default every English topic to "How to". Use "How to" only when the search intent is genuinely procedural or step-by-step. For explanation, diagnosis, comparison, selection, timing, cost, suitability, definition, or troubleshooting intent, prefer the most natural form for the query, including Why, What, Which, When, Can, Should, Is/Are, Does/Do, How Much, How Long, How Often, or a concise natural non-question title. Do not force an awkward question word merely for variety, and avoid repeating a dominant recent opening pattern when another natural search-oriented form fits. Do not choose breaking news, current prices, unsupported product claims, medical/legal/financial high-stakes advice, or a topic that would require invented first-hand experience. Do not mention automation or AI unless the blog itself is about AI.
Return JSON only with this exact shape: {"topic":"..."}. The topic must be a concise article topic, not an outline, instruction, explanation, title list, or commentary.`;
var TOPIC_SCHEMA = Object.freeze({
  type: "object",
  properties: { topic: { type: "string" } },
  required: ["topic"]
});
function normalizeRecentPosts(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).map((item) => ({
    title: String(item?.title || "").trim().slice(0, 240),
    labels: Array.isArray(item?.labels) ? item.labels.map(String).slice(0, 10) : []
  })).filter((item) => item.title);
}
__name(normalizeRecentPosts, "normalizeRecentPosts");
function normalizedTitle(value) {
  return String(value || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
__name(normalizedTitle, "normalizedTitle");
function validatePlannedTopic(value, input = {}) {
  const topic = String(value?.topic || value || "").replace(/\s+/g, " ").trim();
  if (topic.length < 12 || topic.length > 180) {
    const error = new Error("TOPIC_PLANNER_TOPIC_LENGTH_INVALID");
    error.status = 502;
    throw error;
  }
  const normalized = normalizedTitle(topic);
  const recent = normalizeRecentPosts(input?.recentPosts);
  if (recent.some((item) => normalizedTitle(item.title) === normalized)) {
    const error = new Error("TOPIC_PLANNER_DUPLICATE_TITLE");
    error.status = 502;
    throw error;
  }
  return topic;
}
__name(validatePlannedTopic, "validatePlannedTopic");
async function planTopic(env, input = {}, aiBinding = env?.AI, fetchImpl = fetch) {
  const blogId = String(input?.blogId || "").trim();
  const blogName = String(input?.blogName || "").trim();
  const blogUrl = String(input?.blogUrl || "").trim();
  const language = String(input?.language || "").trim().toLowerCase();
  const operationMode = String(input?.operationMode || "validation").trim().toLowerCase();
  if (!blogId) throw Object.assign(new Error("TOPIC_PLANNER_BLOG_ID_REQUIRED"), { status: 400 });
  if (!blogName) throw Object.assign(new Error("TOPIC_PLANNER_BLOG_NAME_REQUIRED"), { status: 400 });
  if (!["ko", "en"].includes(language)) throw Object.assign(new Error("TOPIC_PLANNER_LANGUAGE_INVALID"), { status: 400 });
  if (!["growth", "recovery", "validation"].includes(operationMode)) {
    throw Object.assign(new Error("TOPIC_PLANNER_OPERATION_MODE_INVALID"), { status: 400 });
  }
  const recentPosts = normalizeRecentPosts(input?.recentPosts);
  const userContent = JSON.stringify({
    blogId,
    blogName,
    blogUrl: blogUrl || null,
    language,
    operationMode,
    recentPosts
  });
  const cloudflareModel = env.WRITER_MODEL || "@cf/openai/gpt-oss-120b";
  const geminiModel = env.GEMINI_WRITER_MODEL || "gemini-3.5-flash-lite";
  const result = await runPrimaryWithGeminiFallback(env, {
    cloudflare: {
      model: cloudflareModel,
      messages: [
        { role: "system", content: TOPIC_SYSTEM },
        { role: "user", content: userContent }
      ],
      maxTokens: 512
    },
    gemini: {
      model: geminiModel,
      systemInstruction: TOPIC_SYSTEM,
      userContent,
      maxOutputTokens: 512,
      thinking: "minimal",
      responseSchema: TOPIC_SCHEMA
    }
  }, aiBinding, fetchImpl);
  let parsed;
  try {
    parsed = parseJsonText(result.response);
  } catch {
    throw Object.assign(new Error("TOPIC_PLANNER_JSON_INVALID"), { status: 502 });
  }
  const topic = validatePlannedTopic(parsed, { recentPosts });
  return {
    topic,
    provider: result.provider,
    model: result.model,
    fallbackUsed: result.fallbackUsed,
    primaryError: result.primaryError,
    usage: result.usage
  };
}
__name(planTopic, "planTopic");

// src/lib/required-pages.js
var GEMINI_DEFAULT_MODEL2 = "gemini-3.5-flash-lite";
var OUTPUT_TOKEN_BUDGET2 = 4096;
var ALLOWED_LANGUAGES = /* @__PURE__ */ new Set(["ko", "en"]);
function required8(value, name) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 400;
    throw error;
  }
  return text;
}
__name(required8, "required");
var REQUIRED_PAGES_ADAPTER = `AUTOMATION REQUIRED-PAGES ADAPTER \u2014 this adapter overrides any interactive/questioning flow in the master prompt for this server call.
Platform is Google Blogger / Blogspot. Do not ask questions. Produce content for exactly two static informational pages for the blog described below: "About" and "Contact". These are not blog posts; do not use a listicle or SEO-article structure, do not invent a search topic, and do not add headings that imply this is an article. Do not invent a title for either page; only write the body content described below.
Tailor both pages specifically to the supplied blog. You will be given one of: a short topic description, a sample of the blog's actual recent post titles, both, or neither (a brand-new blog with no signal yet). If given post titles, infer the common theme yourself and write about that specific theme \u2014 do not just repeat the titles. If given both, prefer the topic description but let the titles sharpen the detail. If given neither, write in general terms about a blog that shares practical, everyday tips and information, without inventing a specific fake niche. Do not write generic boilerplate that could apply to any blog when real signal was supplied \u2014 reference what this specific blog actually covers.
About page: 2-4 short paragraphs. State what the blog covers, who it is useful for, and the general approach or perspective the blog takes. Do not fabricate specific credentials, company history, awards, or team members that were not supplied. If no author/team detail was supplied, speak in terms of the blog's editorial focus and interest rather than inventing a biography.
Contact page: 1-2 short paragraphs inviting readers to reach out (feedback, corrections, inquiries), plus a short line noting the contact email will be inserted separately. Do not invent a physical address, phone number, or contact email yourself.
Also write ONE short paragraph (2-4 sentences, in the requested language) introducing this specific blog for the Privacy Policy page \u2014 what kind of site it is and what it is generally about. Do not write about cookies, advertising, or data collection in this paragraph; that boilerplate is added separately.
Return JSON only with this exact shape: {"about":{"html":"..."},"contact":{"html":"..."},"privacyIntro":"..."}. The html fields must contain only the page body (no <html>/<head>/<body>), using <p> paragraphs only \u2014 no headings, since the Blogger page title already provides one. Write in the requested language only.`;
var FIXED_TITLES = Object.freeze({
  ko: { "privacy-policy": "\uAC1C\uC778\uC815\uBCF4\uCC98\uB9AC\uBC29\uCE68", about: "\uC18C\uAC1C", contact: "\uBB38\uC758\uD558\uAE30" },
  en: { "privacy-policy": "Privacy Policy", about: "About", contact: "Contact" }
});
function validatePagesShape(value) {
  const parsed = value && typeof value === "object" ? value : null;
  if (!parsed) throw Object.assign(new Error("REQUIRED_PAGES_SCHEMA_INVALID"), { status: 502 });
  for (const key of ["about", "contact"]) {
    const page = parsed[key];
    if (!page || typeof page !== "object" || typeof page.html !== "string" || !page.html.trim()) {
      throw Object.assign(new Error(`REQUIRED_PAGES_${key.toUpperCase()}_INVALID`), { status: 502 });
    }
  }
  if (typeof parsed.privacyIntro !== "string" || !parsed.privacyIntro.trim()) {
    throw Object.assign(new Error("REQUIRED_PAGES_PRIVACY_INTRO_INVALID"), { status: 502 });
  }
  return parsed;
}
__name(validatePagesShape, "validatePagesShape");
function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
__name(escapeHtml, "escapeHtml");
function privacyPolicyHtml(language, { blogName, blogUrl, contactEmail, intro }) {
  const introHtml = `<p>${escapeHtml(intro)}</p>`;
  const site = escapeHtml(blogName);
  const url = escapeHtml(blogUrl);
  const email = contactEmail ? escapeHtml(contactEmail) : null;
  if (language === "en") {
    return `${introHtml}
<p>This Privacy Policy explains what information is collected when you visit ${site} (${url}) and how it is used.</p>
<p><strong>Log data and cookies.</strong> Like most websites, this site collects standard log information (browser type, pages visited, time spent, referring pages) and uses cookies to operate correctly and to understand how visitors use the site.</p>
<p><strong>Advertising and third-party vendors.</strong> This site displays advertisements served by Google AdSense and other third-party advertising vendors. These vendors, including Google, use cookies (such as the DoubleClick DART cookie) to serve ads based on a visitor's prior visits to this site or other sites on the internet. Google's use of advertising cookies enables it and its partners to serve ads based on your visits to this site and/or other sites on the internet.</p>
<p>You may opt out of personalized advertising by visiting <a href="https://adssettings.google.com" rel="nofollow noopener" target="_blank">Google Ads Settings</a>. Alternatively, you can opt out of a third-party vendor's use of cookies for personalized advertising by visiting <a href="https://www.aboutads.info/choices/" rel="nofollow noopener" target="_blank">www.aboutads.info</a>.</p>
<p><strong>Children's privacy.</strong> This site does not knowingly collect personal information from children under 13. This site does not specifically target content to children under 13.</p>
<p><strong>Changes to this policy.</strong> This Privacy Policy may be updated from time to time. Continued use of this site after changes are posted constitutes acceptance of those changes.</p>
${email ? `<p>If you have questions about this Privacy Policy, contact us at <a href="mailto:${email}">${email}</a>.</p>` : ""}`;
  }
  return `${introHtml}
<p>\uBCF8 \uAC1C\uC778\uC815\uBCF4\uCC98\uB9AC\uBC29\uCE68\uC740 ${site}(${url}) \uBC29\uBB38 \uC2DC \uC218\uC9D1\uB418\uB294 \uC815\uBCF4\uC640 \uADF8 \uC774\uC6A9 \uBC29\uBC95\uC744 \uC124\uBA85\uD569\uB2C8\uB2E4.</p>
<p><strong>\uB85C\uADF8 \uB370\uC774\uD130 \uBC0F \uCFE0\uD0A4.</strong> \uB300\uBD80\uBD84\uC758 \uC6F9\uC0AC\uC774\uD2B8\uC640 \uB9C8\uCC2C\uAC00\uC9C0\uB85C \uC774 \uC0AC\uC774\uD2B8\uB294 \uBC29\uBB38\uC790\uC758 \uBE0C\uB77C\uC6B0\uC800 \uC885\uB958, \uBC29\uBB38 \uD398\uC774\uC9C0, \uCCB4\uB958 \uC2DC\uAC04, \uC720\uC785 \uACBD\uB85C \uB4F1 \uC77C\uBC18\uC801\uC778 \uB85C\uADF8 \uC815\uBCF4\uB97C \uC218\uC9D1\uD558\uBA70, \uC0AC\uC774\uD2B8\uB97C \uC815\uC0C1\uC801\uC73C\uB85C \uC6B4\uC601\uD558\uACE0 \uBC29\uBB38\uC790\uC758 \uC774\uC6A9 \uBC29\uC2DD\uC744 \uD30C\uC545\uD558\uAE30 \uC704\uD574 \uCFE0\uD0A4\uB97C \uC0AC\uC6A9\uD569\uB2C8\uB2E4.</p>
<p><strong>\uAD11\uACE0 \uBC0F \uC81C3\uC790 \uAD11\uACE0 \uC5C5\uCCB4.</strong> \uC774 \uC0AC\uC774\uD2B8\uB294 Google \uC560\uB4DC\uC13C\uC2A4(Google AdSense) \uBC0F \uAE30\uD0C0 \uC81C3\uC790 \uAD11\uACE0 \uC5C5\uCCB4\uAC00 \uC81C\uACF5\uD558\uB294 \uAD11\uACE0\uB97C \uAC8C\uC7AC\uD569\uB2C8\uB2E4. Google\uC744 \uD3EC\uD568\uD55C \uC774\uB4E4 \uC5C5\uCCB4\uB294 DoubleClick DART \uCFE0\uD0A4 \uB4F1\uC744 \uC0AC\uC6A9\uD558\uC5EC, \uBC29\uBB38\uC790\uAC00 \uC774 \uC0AC\uC774\uD2B8 \uB610\uB294 \uC778\uD130\uB137\uC0C1\uC758 \uB2E4\uB978 \uC0AC\uC774\uD2B8\uB97C \uBC29\uBB38\uD55C \uC774\uB825\uC744 \uBC14\uD0D5\uC73C\uB85C \uAD11\uACE0\uB97C \uAC8C\uC7AC\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.</p>
<p>\uB9DE\uCDA4\uD615 \uAD11\uACE0\uB97C \uC6D0\uD558\uC9C0 \uC54A\uC73C\uC2DC\uBA74 <a href="https://adssettings.google.com" rel="nofollow noopener" target="_blank">Google \uAD11\uACE0 \uC124\uC815</a>\uC5D0\uC11C \uC124\uC815\uC744 \uBCC0\uACBD\uD558\uC2E4 \uC218 \uC788\uC2B5\uB2C8\uB2E4. \uB610\uD55C <a href="https://www.aboutads.info/choices/" rel="nofollow noopener" target="_blank">www.aboutads.info</a>\uC5D0\uC11C\uB3C4 \uC81C3\uC790 \uC5C5\uCCB4\uC758 \uB9DE\uCDA4\uD615 \uAD11\uACE0 \uCFE0\uD0A4 \uC0AC\uC6A9\uC744 \uAC70\uBD80\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.</p>
<p><strong>\uC544\uB3D9\uC758 \uAC1C\uC778\uC815\uBCF4.</strong> \uC774 \uC0AC\uC774\uD2B8\uB294 \uB9CC 13\uC138 \uBBF8\uB9CC \uC544\uB3D9\uC758 \uAC1C\uC778\uC815\uBCF4\uB97C \uACE0\uC758\uB85C \uC218\uC9D1\uD558\uC9C0 \uC54A\uC73C\uBA70, \uB9CC 13\uC138 \uBBF8\uB9CC \uC544\uB3D9\uC744 \uB300\uC0C1\uC73C\uB85C \uCF58\uD150\uCE20\uB97C \uC81C\uACF5\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.</p>
<p><strong>\uBC29\uCE68\uC758 \uBCC0\uACBD.</strong> \uBCF8 \uAC1C\uC778\uC815\uBCF4\uCC98\uB9AC\uBC29\uCE68\uC740 \uC218\uC2DC\uB85C \uBCC0\uACBD\uB420 \uC218 \uC788\uC73C\uBA70, \uBCC0\uACBD \uC0AC\uD56D \uAC8C\uC2DC \uC774\uD6C4 \uC0AC\uC774\uD2B8\uB97C \uACC4\uC18D \uC774\uC6A9\uD558\uB294 \uACBD\uC6B0 \uD574\uB2F9 \uBCC0\uACBD\uC5D0 \uB3D9\uC758\uD55C \uAC83\uC73C\uB85C \uAC04\uC8FC\uB429\uB2C8\uB2E4.</p>
${email ? `<p>\uBCF8 \uBC29\uCE68\uC5D0 \uB300\uD574 \uBB38\uC758\uC0AC\uD56D\uC774 \uC788\uC73C\uC2DC\uBA74 <a href="mailto:${email}">${email}</a>\uB85C \uC5F0\uB77D\uD574 \uC8FC\uC138\uC694.</p>` : ""}`;
}
__name(privacyPolicyHtml, "privacyPolicyHtml");
async function generateRequiredPages(env, input = {}, aiBinding = env?.AI, fetchImpl = fetch) {
  const blogName = required8(input?.blogName, "BLOG_NAME");
  const blogUrl = required8(input?.blogUrl, "BLOG_URL");
  const topic = input?.topic ? String(input.topic).trim() : "";
  const recentPostTitles = Array.isArray(input?.recentPostTitles) ? input.recentPostTitles.map((title) => String(title || "").trim()).filter(Boolean).slice(0, 20) : [];
  const language = String(input?.language || "").trim();
  if (!ALLOWED_LANGUAGES.has(language)) throw Object.assign(new Error("REQUIRED_PAGES_LANGUAGE_INVALID"), { status: 400 });
  const contactEmail = input?.contactEmail ? String(input.contactEmail).trim() : "";
  const masterText = await loadMasterV45();
  const systemInstruction = `${masterText}

--- REQUIRED PAGES ADAPTER ---
${REQUIRED_PAGES_ADAPTER}`;
  const userContent = JSON.stringify({
    platform: "Blogger",
    blogName,
    blogUrl,
    language,
    ...topic ? { topic } : {},
    ...recentPostTitles.length ? { recentPostTitles } : {}
  });
  const cloudflareModel = env.WRITER_MODEL || "@cf/openai/gpt-oss-120b";
  const geminiModel = env.GEMINI_WRITER_MODEL || GEMINI_DEFAULT_MODEL2;
  const result = await runPrimaryWithGeminiFallback(env, {
    cloudflare: {
      model: cloudflareModel,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userContent }
      ],
      maxTokens: OUTPUT_TOKEN_BUDGET2
    },
    gemini: {
      model: geminiModel,
      systemInstruction,
      userContent,
      maxOutputTokens: OUTPUT_TOKEN_BUDGET2,
      thinking: "minimal"
    }
  }, aiBinding, fetchImpl, (parsed2) => validatePagesShape(parsed2));
  let parsed;
  try {
    parsed = parseJsonText(result.response);
  } catch {
    throw Object.assign(new Error("REQUIRED_PAGES_JSON_INVALID"), { status: 502 });
  }
  const validated = validatePagesShape(parsed);
  const titles = FIXED_TITLES[language];
  return {
    pages: [
      {
        type: "privacy-policy",
        title: titles["privacy-policy"],
        html: privacyPolicyHtml(language, { blogName, blogUrl, contactEmail, intro: validated.privacyIntro })
      },
      { type: "about", title: titles.about, html: validated.about.html },
      { type: "contact", title: titles.contact, html: validated.contact.html }
    ],
    model: result.model,
    provider: result.provider,
    fallbackUsed: result.fallbackUsed
  };
}
__name(generateRequiredPages, "generateRequiredPages");

// src/lib/write-policy.js
function forbidden(message) {
  const error = new Error(message);
  error.status = 403;
  throw error;
}
__name(forbidden, "forbidden");
function allowedBlogIds(env) {
  return new Set(String(env.BLOGGER_WRITE_ALLOWED_BLOG_IDS || "").split(",").map((value) => value.trim()).filter(Boolean));
}
__name(allowedBlogIds, "allowedBlogIds");
function assertManagedAllowlist(env, input) {
  const allowlist = allowedBlogIds(env);
  const requestBlogId = String(input?.blogId || "").trim();
  if (!requestBlogId || !allowlist.has(requestBlogId)) forbidden("BLOGGER_WRITE_TARGET_NOT_ALLOWED");
  const operation = String(input?.operation || "create");
  const publishMode = String(input?.publishMode || "draft").toLowerCase();
  if (!["create", "update"].includes(operation)) forbidden("BLOGGER_WRITE_OPERATION_NOT_ALLOWED");
  if (operation === "create" && !["draft", "published", "scheduled"].includes(publishMode)) {
    forbidden("BLOGGER_WRITE_PUBLISH_MODE_NOT_ALLOWED");
  }
  if (operation === "update" && !String(input?.bloggerPostId || "").trim()) {
    forbidden("BLOGGER_WRITE_EXISTING_POST_ID_REQUIRED");
  }
  return true;
}
__name(assertManagedAllowlist, "assertManagedAllowlist");
function assertBloggerWriteAllowed(env, input) {
  if (env.BLOGGER_WRITES_ENABLED !== "true") forbidden("BLOGGER_WRITES_DISABLED");
  const mode = String(env.BLOGGER_WRITE_MODE || "disabled");
  if (mode === "normal") return true;
  if (mode === "managed_allowlist") return assertManagedAllowlist(env, input);
  if (mode === "phase1_single_draft") {
    const targetBlogId = String(env.PHASE1_DRAFT_BLOG_ID || "").trim();
    const requestBlogId = String(input?.blogId || "").trim();
    const operation = String(input?.operation || "create");
    const publishMode = String(input?.publishMode || "draft");
    if (!targetBlogId || requestBlogId !== targetBlogId) forbidden("PHASE1_DRAFT_TARGET_MISMATCH");
    if (input?.phase1Test !== true) forbidden("PHASE1_DRAFT_INTENT_REQUIRED");
    if (operation !== "create") forbidden("PHASE1_DRAFT_CREATE_ONLY");
    if (publishMode === "published") forbidden("PHASE1_DRAFT_PUBLISH_FORBIDDEN");
    return true;
  }
  if (mode === "phase2_single_publish") {
    const targetBlogId = String(env.PHASE2_SINGLE_PUBLISH_BLOG_ID || "").trim();
    const requestBlogId = String(input?.blogId || "").trim();
    const operation = String(input?.operation || "create");
    const publishMode = String(input?.publishMode || "draft");
    if (!targetBlogId || requestBlogId !== targetBlogId) forbidden("PHASE2_PUBLISH_TARGET_MISMATCH");
    if (input?.phase2SinglePublish !== true) forbidden("PHASE2_PUBLISH_INTENT_REQUIRED");
    if (operation !== "create") forbidden("PHASE2_PUBLISH_CREATE_ONLY");
    if (publishMode !== "published") forbidden("PHASE2_PUBLISH_MODE_REQUIRED");
    if (input?.bloggerPostId) forbidden("PHASE2_PUBLISH_NEW_POST_ONLY");
    return true;
  }
  if (mode === "phase2_single_repair") {
    const targetBlogId = String(env.PHASE2_SINGLE_REPAIR_BLOG_ID || "").trim();
    const targetPostId = String(env.PHASE2_SINGLE_REPAIR_POST_ID || "").trim();
    const requestBlogId = String(input?.blogId || "").trim();
    const requestPostId = String(input?.bloggerPostId || "").trim();
    const operation = String(input?.operation || "create");
    if (!targetBlogId || requestBlogId !== targetBlogId) forbidden("PHASE2_REPAIR_TARGET_BLOG_MISMATCH");
    if (!targetPostId || requestPostId !== targetPostId) forbidden("PHASE2_REPAIR_TARGET_POST_MISMATCH");
    if (input?.phase2SingleRepair !== true) forbidden("PHASE2_REPAIR_INTENT_REQUIRED");
    if (operation !== "update") forbidden("PHASE2_REPAIR_UPDATE_ONLY");
    return true;
  }
  forbidden("BLOGGER_WRITE_MODE_DISABLED");
}
__name(assertBloggerWriteAllowed, "assertBloggerWriteAllowed");

// src/index.js
function escapeHtml2(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
__name(escapeHtml2, "escapeHtml");
function textProviderOrder(env, forceGeminiPrimary = false) {
  const primary = forceGeminiPrimary ? "gemini" : String(env.TEXT_PRIMARY_PROVIDER || "cloudflare").trim().toLowerCase();
  const geminiConfigured = Boolean(String(env.GEMINI_API_KEY || "").trim());
  const freeAiEnabled = freeAiFallbackEnabled(env) && freeAiConfigured(env);
  const cloudflareFallbackEnabled = String(env.TEXT_CLOUDFLARE_FALLBACK_ENABLED || "false").trim().toLowerCase() === "true";
  if (primary === "gemini") {
    return [
      "google-gemini",
      ...freeAiEnabled ? ["free-ai"] : [],
      ...cloudflareFallbackEnabled ? ["cloudflare-workers-ai"] : []
    ];
  }
  return geminiConfigured ? ["cloudflare-workers-ai", "google-gemini"] : ["cloudflare-workers-ai"];
}
__name(textProviderOrder, "textProviderOrder");
function oauthTokenPage(refreshToken) {
  const token = escapeHtml2(refreshToken);
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API Hub v2 Google OAuth</title></head><body>
<main style="max-width:760px;margin:40px auto;padding:20px;font-family:system-ui,sans-serif;line-height:1.6">
<h1>Google OAuth \uC5F0\uACB0 \uC2B9\uC778 \uC644\uB8CC</h1>
<p>\uC544\uB798 refresh token\uC740 \uC774 \uD654\uBA74\uC5D0\uC11C\uB9CC \uD655\uC778\uD558\uC138\uC694. \uCC44\uD305\uC774\uB098 \uCEA1\uCC98\uB85C \uBCF4\uB0B4\uC9C0 \uB9D0\uACE0 GitHub production environment secret <strong>API_HUB_V2_GOOGLE_REFRESH_TOKEN</strong>\uC5D0 \uC9C1\uC811 \uC800\uC7A5\uD558\uC138\uC694.</p>
<textarea readonly style="width:100%;min-height:180px;box-sizing:border-box">${token}</textarea>
<p>\uC800\uC7A5\uD55C \uB4A4 API Hub v2\uB97C \uB2E4\uC2DC \uBC30\uD3EC\uD558\uBA74 OAuth \uC124\uC815\uC6A9 \uC5D4\uB4DC\uD3EC\uC778\uD2B8\uB294 \uC790\uB3D9\uC73C\uB85C \uBE44\uD65C\uC131\uD654\uB429\uB2C8\uB2E4.</p>
</main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "pragma": "no-cache",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  });
}
__name(oauthTokenPage, "oauthTokenPage");
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        const geminiConfigured = Boolean(String(env.GEMINI_API_KEY || "").trim());
        const freeAiIsConfigured = freeAiConfigured(env);
        const freeAiIsEnabled = freeAiFallbackEnabled(env) && freeAiIsConfigured;
        const modelScopeIsConfigured = modelScopeConfigured(env);
        const kieConfigured = Boolean(String(env.KIE_API_KEY || "").trim());
        const imageQaRequired2 = String(env.IMAGE_QA_REQUIRED || "false").trim().toLowerCase() === "true";
        const writerProviderOrder = textProviderOrder(env);
        const criticProviderOrder = freeAiIsEnabled ? ["free-ai", "cloudflare-workers-ai"] : ["cloudflare-workers-ai"];
        const repairProviderOrder = textProviderOrder(env);
        const textPrimaryProvider = writerProviderOrder[0];
        const textCloudflareFallbackEnabled = String(env.TEXT_CLOUDFLARE_FALLBACK_ENABLED || "false").trim().toLowerCase() === "true";
        const imageProviderOrder = [
          ...modelScopeIsConfigured ? ["modelscope"] : [],
          ...kieConfigured ? ["kie-ai"] : [],
          "cloudflare-workers-ai"
        ];
        return json({
          ok: true,
          service: "api-hub-v2",
          auth: "x-hub-api-key",
          textPrimaryProvider,
          textCloudflareFallbackEnabled,
          geminiRequestTimeoutMs: geminiRequestTimeoutMs(env),
          freeAiConfigured: freeAiIsConfigured,
          freeAiFallbackEnabled: freeAiIsEnabled,
          freeAiModel: freeAiModel(env),
          freeAiWriterModel: freeAiModel(env, "writer"),
          freeAiCriticModel: freeAiModel(env, "critic"),
          freeAiRepairModel: freeAiModel(env, "repair"),
          writerModel: env.WRITER_MODEL || "@cf/openai/gpt-oss-120b",
          writerProviderOrder,
          writerResearchProvider: "tavily",
          writerResearchMode: "auto",
          topicPlanner: "conservative-evergreen",
          bloggerPostInventory: "read-only-metadata",
          tavilyConfigured: tavilyConfigured(env),
          tavilySearchDepth: "basic",
          tourApiConfigured: tourApiConfigured(env),
          criticProvider: criticProviderOrder[0],
          criticProviderOrder,
          criticFallbackEnabled: criticProviderOrder.length > 1,
          criticModel: freeAiIsEnabled ? freeAiModel(env, "critic") : env.CRITIC_MODEL || "@cf/openai/gpt-oss-120b",
          criticConfigured: Boolean(env.AI),
          criticAuditMode: "master-v4.5-role-critic-free-ai-granular",
          repairModel: env.REPAIR_MODEL || "@cf/openai/gpt-oss-120b",
          repairProviderOrder,
          imageProvider: imageProviderOrder[0],
          imageProviderOrder,
          imageModel: env.IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell",
          imageConfigured: Boolean(env.AI) || kieConfigured || modelScopeIsConfigured,
          imageQaRequired: imageQaRequired2,
          imageQaConfigured: imageQaRequired2 && geminiConfigured,
          imageQaProvider: "google-gemini",
          imageQaModel: env.GEMINI_IMAGE_QA_MODEL || env.GEMINI_CRITIC_MODEL || "gemini-3.5-flash-lite",
          imageQaMaxAttempts: Number(env.IMAGE_QA_MAX_ATTEMPTS || 3),
          modelScopeImageConfigured: modelScopeIsConfigured,
          modelScopeImageModel: env.MODELSCOPE_IMAGE_MODEL || "Tongyi-MAI/Z-Image-Turbo",
          kieImageConfigured: kieConfigured,
          kieImageModel: env.KIE_IMAGE_MODEL || "z-image",
          geminiConfigured,
          geminiFallbackConfigured: geminiConfigured,
          geminiWriterModel: env.GEMINI_WRITER_MODEL || "gemini-3.5-flash-lite",
          geminiCriticModel: env.GEMINI_CRITIC_MODEL || "gemini-3.5-flash-lite",
          geminiRepairModel: env.GEMINI_REPAIR_MODEL || "gemini-3.5-flash-lite",
          googleOAuthClientConfigured: googleOAuthClientConfigured(env),
          googleOAuthSetupEnabled: googleOAuthSetupEnabled(env),
          googleOAuthScopeUpgradeEnabled: googleOAuthScopeUpgradeEnabled(env),
          bloggerConfigured: googleOAuthConfigured(env),
          phase4GoogleData: {
            scopeProbe: "/api/google/scopes",
            searchConsoleSites: "/api/gsc/sites",
            searchConsolePerformance: "/api/gsc/performance",
            analyticsProperties: "/api/ga4/properties",
            analyticsReport: "/api/ga4/report",
            adsenseAccounts: "/api/adsense/accounts",
            adsenseSites: "/api/adsense/sites",
            adsenseReport: "/api/adsense/report"
          },
          bloggerWritesEnabled: env.BLOGGER_WRITES_ENABLED === "true",
          bloggerWriteMode: String(env.BLOGGER_WRITE_MODE || "disabled"),
          masterV45: await masterV45RuntimeStatus(),
          rolePrompts: await masterV45RolePromptRuntimeStatus()
        });
      }
      if (request.method === "GET" && url.pathname === "/oauth/google/start") {
        return Response.redirect(await buildGoogleAuthorizationUrl(env, request.url), 302);
      }
      if (request.method === "GET" && url.pathname === "/oauth/google/callback") {
        const { refreshToken } = await completeGoogleOAuthSetup(env, request.url);
        return oauthTokenPage(refreshToken);
      }
      requireAuthorized(request, env);
      if (request.method !== "POST") return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
      if (url.pathname === "/api/google/scopes") return json(await getGoogleScopeStatus(env));
      if (url.pathname === "/api/gsc/sites") return json(await listSearchConsoleSites(env));
      if (url.pathname === "/api/gsc/performance") return json(await querySearchConsolePerformance(env, await readJson(request)));
      if (url.pathname === "/api/ga4/properties") return json(await listAnalyticsProperties(env));
      if (url.pathname === "/api/ga4/report") return json(await queryAnalyticsReport(env, await readJson(request)));
      if (url.pathname === "/api/adsense/accounts") return json(await listAdsenseAccounts(env));
      if (url.pathname === "/api/adsense/sites") return json(await listAdsenseSites(env, await readJson(request)));
      if (url.pathname === "/api/adsense/report") return json(await queryAdsenseReport(env, await readJson(request)));
      if (url.pathname === "/api/hub/ai/diagnostics/cloudflare") {
        const result = await diagnostic(env);
        return json(result, result.ok ? 200 : 502);
      }
      if (url.pathname === "/api/hub/search/tavily") return json(await tavilySearch(env, await readJson(request)));
      if (url.pathname === "/api/hub/tour/attractions") return json(await fetchAreaBasedAttractionsPage(env, await readJson(request)));
      if (url.pathname === "/api/hub/tour/attraction") return json(await getAttractionDetail(env, await readJson(request)));
      if (url.pathname === "/api/hub/ai/topic") return json(await planTopic(env, await readJson(request)));
      if (url.pathname === "/api/hub/ai/writer") return json(await writer(env, await readJson(request)));
      if (url.pathname === "/api/hub/ai/critic") return json(await critic(env, await readJson(request)));
      if (url.pathname === "/api/hub/ai/repair") return json(await repair(env, await readJson(request)));
      if (url.pathname === "/api/hub/ai/required-pages") return json(await generateRequiredPages(env, await readJson(request)));
      if (url.pathname === "/api/hub/image/generate") return json(await generateImage(env, await readJson(request)));
      if (url.pathname === "/api/blogger/blogs") return json(await listBlogs(env));
      if (url.pathname === "/api/blogger/posts") return json(await listPosts(env, await readJson(request)));
      if (url.pathname === "/api/blogger/post/get") return json(await getPost(env, await readJson(request)));
      if (url.pathname === "/api/blogger/post") {
        const input = await readJson(request);
        assertBloggerWriteAllowed(env, input);
        return json(await writePost(env, input));
      }
      if (url.pathname === "/api/blogger/pages") return json(await listPages(env, await readJson(request)));
      if (url.pathname === "/api/blogger/page/get") return json(await getPage(env, await readJson(request)));
      if (url.pathname === "/api/blogger/page") {
        const input = await readJson(request);
        assertBloggerWriteAllowed(env, input);
        return json(await writePage(env, input));
      }
      return json({ ok: false, error: "NOT_FOUND" }, 404);
    } catch (error) {
      const status = Number(error?.status || 500);
      const body = { ok: false, error: String(error?.message || "INTERNAL_ERROR") };
      if (Number.isInteger(error?.providerCode)) body.providerCode = error.providerCode;
      if (Number.isInteger(error?.providerHttpStatus)) body.providerHttpStatus = error.providerHttpStatus;
      if (Number.isInteger(error?.providerStatus)) body.providerStatus = error.providerStatus;
      if (typeof error?.providerValidationHint === "string" && /^[A-Za-z0-9_./,:; -]{1,240}$/.test(error.providerValidationHint)) body.providerValidationHint = error.providerValidationHint;
      if (Number.isInteger(error?.qaAttempts)) body.qaAttempts = error.qaAttempts;
      if (Number.isInteger(error?.qaViolationCount)) body.qaViolationCount = error.qaViolationCount;
      if (Number.isInteger(error?.qaDetectedTextCount)) body.qaDetectedTextCount = error.qaDetectedTextCount;
      if (Array.isArray(error?.qaDetectedText) && error.qaDetectedText.length) body.qaDetectedText = error.qaDetectedText.map((item) => String(item).slice(0, 100)).slice(0, 8);
      if (Array.isArray(error?.qaViolations) && error.qaViolations.length) body.qaViolations = error.qaViolations.map((item) => String(item).slice(0, 100)).slice(0, 8);
      if (String(error?.message || "") === "IMAGE_QA_REJECTED" && /^https:\/\//i.test(String(error?.rejectedImageUrl || ""))) {
        body.rejectedImageUrl = String(error.rejectedImageUrl);
        body.rejectedImageMimeType = String(error.rejectedImageMimeType || "image/jpeg");
        body.rejectedProvider = "kie-ai";
        body.rejectedModel = String(error.rejectedModel || "z-image").slice(0, 80);
        body.rejectedTaskId = String(error.rejectedTaskId || "").slice(0, 120);
      }
      if (error?.meta === MASTER_V45) body.masterV45 = MASTER_V45;
      return json(body, status);
    }
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
