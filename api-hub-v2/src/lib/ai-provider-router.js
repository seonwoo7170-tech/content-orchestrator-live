import { runWorkersAi } from './cloudflare-ai.js';
import { runGeminiAi } from './gemini-ai.js';
import { parseJsonText } from './contracts.js';
import {
  freeAiConfigured,
  freeAiFallbackEnabled,
  freeAiModel,
  runFreeAi,
  shouldFallbackFromFreeAi
} from './free-ai.js';

const CLOUDFLARE_FALLBACK_ERRORS = new Set([
  'CLOUDFLARE_AI_ACCOUNT_LIMITED',
  'CLOUDFLARE_AI_OUT_OF_CAPACITY',
  'CLOUDFLARE_AI_PAID_PLAN_REQUIRED',
  'CLOUDFLARE_AI_TIMEOUT',
  'CLOUDFLARE_AI_BINDING_FAILED',
  'CLOUDFLARE_AI_BINDING_REQUIRED',
  'CLOUDFLARE_AI_EMPTY_RESPONSE',
  'CLOUDFLARE_AI_JSON_INVALID'
]);

const GEMINI_FALLBACK_ERRORS = new Set([
  'GEMINI_REQUEST_FAILED',
  'GEMINI_TIMEOUT',
  'GEMINI_RATE_LIMITED',
  'GEMINI_UNAVAILABLE',
  'GEMINI_API_FAILED',
  'GEMINI_EMPTY_RESPONSE',
  'GEMINI_JSON_INVALID'
]);

const ROLE_OUTPUT_TOKEN_CAP = 12288;
const HTML_BLOCK_RE = /<(p|h2|h3|li|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi;
const EXACT_HTML_LOCATION_RE = /^html\s+(p|h2|h3|li|blockquote)\s+(\d+)$/i;
const TARGETED_REPAIR_FIELDS = new Set([
  'title',
  'searchDescription',
  'labels',
  'sources',
  'language',
  'topic'
]);
const TARGETED_REPAIR_PATCH_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    patches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          location: { type: 'string' },
          value: { type: 'string' }
        },
        required: ['location', 'value']
      }
    }
  },
  required: ['patches']
});

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function geminiRetryDelayMs(env = {}) {
  const configured = Number(env?.AI_PROVIDER_RETRY_DELAY_MS ?? 4000);
  if (!Number.isFinite(configured)) return 4000;
  if (configured <= 0) return 0;
  return Math.max(3000, Math.min(5000, Math.trunc(configured)));
}

function requestSystemText(request = {}) {
  if (String(request?.systemInstruction || '').trim()) return String(request.systemInstruction);
  if (!Array.isArray(request?.messages)) return '';
  return request.messages
    .filter((message) => String(message?.role || '').toLowerCase() === 'system')
    .map((message) => String(message?.content || ''))
    .join('\n');
}

function requestRequiresJson(request = {}) {
  if (request?.responseSchema && typeof request.responseSchema === 'object') return true;
  if (String(request?.responseFormat?.type || '').toLowerCase() === 'json_object') return true;
  return /\breturn\s+json\s+only\b/i.test(requestSystemText(request));
}

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

function assertProviderSemanticResponse(result, validateResponse, errorCode) {
  if (typeof validateResponse !== 'function') return result;
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

function isTargetedRepairFallback(request) {
  const system = String(request?.systemInstruction || '');
  return system.includes('MASTER V4.5 TARGETED REPAIR ADAPTER') || system.includes('targeted repair editor');
}

function parseTargetedRepairInput(request) {
  if (!isTargetedRepairFallback(request)) return null;
  try {
    const parsed = JSON.parse(String(request?.userContent || ''));
    if (!parsed?.article || typeof parsed.article !== 'object') return null;
    if (!Array.isArray(parsed?.issues) || parsed.issues.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function htmlParts(value) {
  const source = String(value || '');
  const blocks = [];
  const gaps = [];
  let cursor = 0;
  let index = 0;
  let match;
  const re = new RegExp(HTML_BLOCK_RE.source, HTML_BLOCK_RE.flags);
  while ((match = re.exec(source))) {
    gaps.push(source.slice(cursor, match.index));
    index += 1;
    blocks.push({ index, tag: String(match[1] || '').toLowerCase(), raw: match[0] });
    cursor = re.lastIndex;
  }
  gaps.push(source.slice(cursor));
  return { source, blocks, gaps };
}

function normalizedLocation(value) {
  return String(value || '').trim();
}

function targetForLocation(article, parts, location) {
  if (TARGETED_REPAIR_FIELDS.has(location)) {
    return { location, currentValue: article[location] };
  }
  const match = location.match(EXACT_HTML_LOCATION_RE);
  if (!match) return null;
  const tag = String(match[1] || '').toLowerCase();
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

function buildTargetedRepairRequest(request) {
  const input = parseTargetedRepairInput(request);
  if (!input) return { request, context: null };

  const article = input.article;
  const parts = htmlParts(article.html);
  const issuesByLocation = new Map();
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

  const systemInstruction = `${String(request.systemInstruction || '')}\n\n--- TARGETED PATCH OUTPUT CONTRACT ---\nDo NOT return the full Article. Return JSON only as {"patches":[{"location":"exact supplied location","value":"replacement"}]}. Return exactly one patch per distinct supplied target location and no other locations. For title, searchDescription, language, and topic, value is the replacement plain string. For labels and sources, value must itself be a valid JSON-array string. For an HTML target such as "html p 3", value must be exactly one complete replacement block with the same tag as the target, for example <p>...</p>. Preserve the requested language and do not add markdown fences or commentary.`;
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
      responseFormat: { type: 'json_object' }
    },
    context: {
      article,
      parts,
      targetLocations: new Set(targets.map((target) => target.location))
    }
  };
}

function targetedPatchError(reason) {
  const error = new Error('GEMINI_REQUEST_FAILED');
  error.status = 502;
  error.cause = new Error(reason);
  return error;
}

function parseJsonArrayString(value, location) {
  try {
    const parsed = JSON.parse(String(value || ''));
    if (!Array.isArray(parsed)) throw new Error('not-array');
    if (location === 'labels' && !parsed.every((item) => typeof item === 'string')) throw new Error('labels-not-strings');
    return parsed;
  } catch {
    throw targetedPatchError(`REPAIR_PATCH_${location.toUpperCase()}_INVALID`);
  }
}

function expandTargetedRepairResult(result, context) {
  if (!context) return result;
  let parsed;
  try {
    parsed = parseJsonText(String(result?.response || '').trim());
  } catch {
    throw targetedPatchError('REPAIR_PATCH_JSON_INVALID');
  }
  const patches = Array.isArray(parsed?.patches) ? parsed.patches : null;
  if (!patches) throw targetedPatchError('REPAIR_PATCHES_REQUIRED');

  const article = { ...context.article };
  const replacements = new Map();
  const seen = new Set();

  for (const patch of patches) {
    const location = normalizedLocation(patch?.location);
    if (!context.targetLocations.has(location) || seen.has(location)) {
      throw targetedPatchError('REPAIR_PATCH_LOCATION_INVALID');
    }
    if (typeof patch?.value !== 'string') throw targetedPatchError('REPAIR_PATCH_VALUE_INVALID');
    seen.add(location);

    if (TARGETED_REPAIR_FIELDS.has(location)) {
      if (location === 'labels' || location === 'sources') {
        article[location] = parseJsonArrayString(patch.value, location);
      } else {
        const value = String(patch.value).trim();
        if (!value) throw targetedPatchError(`REPAIR_PATCH_${location.toUpperCase()}_EMPTY`);
        article[location] = value;
      }
      continue;
    }

    const match = location.match(EXACT_HTML_LOCATION_RE);
    if (!match) throw targetedPatchError('REPAIR_PATCH_HTML_LOCATION_INVALID');
    const tag = String(match[1] || '').toLowerCase();
    const index = Number(match[2]);
    const block = context.parts.blocks[index - 1];
    if (!block || block.index !== index || block.tag !== tag) throw targetedPatchError('REPAIR_PATCH_HTML_TARGET_MISSING');
    const replacement = String(patch.value).trim();
    const sameTag = new RegExp(`^<${tag}\\b[^>]*>[\\s\\S]*<\\/${tag}>$`, 'i');
    if (!sameTag.test(replacement)) throw targetedPatchError('REPAIR_PATCH_HTML_BLOCK_INVALID');
    replacements.set(index, replacement);
  }

  for (const location of context.targetLocations) {
    if (!seen.has(location)) throw targetedPatchError('REPAIR_PATCH_INCOMPLETE');
  }

  if (replacements.size > 0) {
    let html = context.parts.gaps[0] || '';
    for (let index = 0; index < context.parts.blocks.length; index += 1) {
      const block = context.parts.blocks[index];
      html += replacements.get(block.index) || block.raw;
      html += context.parts.gaps[index + 1] || '';
    }
    article.html = html;
  }

  return { ...result, response: JSON.stringify(article) };
}

export function shouldFallbackFromCloudflare(error) {
  return CLOUDFLARE_FALLBACK_ERRORS.has(String(error?.message || ''));
}

export function shouldFallbackFromGemini(error) {
  return GEMINI_FALLBACK_ERRORS.has(String(error?.message || ''));
}

async function runGeminiWithRetry(env, request, fetchImpl, validateResponse = null) {
  const hardened = buildTargetedRepairRequest(request);
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const raw = await runGeminiAi(env, hardened.request, fetchImpl);
      const expanded = expandTargetedRepairResult(raw, hardened.context);
      const result = assertProviderSemanticResponse(assertJsonOnlyResponse(expanded, hardened.request, 'GEMINI_JSON_INVALID'), validateResponse, 'GEMINI_JSON_INVALID');
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
  throw lastError || new Error('GEMINI_REQUEST_FAILED');
}

function freeAiRoleForRequest(request = {}) {
  const system = String(request?.systemInstruction || '');
  if (system.includes('MASTER V4.5 CRITIC ADAPTER') || system.includes('publication critic')) return 'critic';
  if (system.includes('MASTER V4.5 REPAIR ADAPTER') || system.includes('targeted repair editor')) return 'repair';
  return 'writer';
}

function compactFreeAiSystem(systemInstruction) {
  const system = String(systemInstruction || '');
  for (const marker of [
    '--- SERVER AUTOMATION ADAPTER ---',
    '--- MASTER V4.5 CRITIC ADAPTER ---',
    '--- MASTER V4.5 REPAIR ADAPTER ---'
  ]) {
    const index = system.indexOf(marker);
    if (index >= 0) return system.slice(index);
  }
  return system.length > 12000 ? system.slice(-12000) : system;
}

function defaultFreeAiRequest(env, request) {
  if (!request) return null;
  const role = freeAiRoleForRequest(request);
  return {
    ...request,
    model: freeAiModel(env, role),
    systemInstruction: compactFreeAiSystem(request.systemInstruction),
    maxOutputTokens: Math.max(512, Math.min(Number(request?.maxOutputTokens || 4096), ROLE_OUTPUT_TOKEN_CAP)),
    responseFormat: { type: 'json_object' }
  };
}

async function runFreeAiFallback(env, request, fetchImpl, validateResponse = null) {
  const hardened = buildTargetedRepairRequest(request);
  const messages = [
    ...(String(hardened.request?.systemInstruction || '').trim()
      ? [{ role: 'system', content: String(hardened.request.systemInstruction) }]
      : []),
    { role: 'user', content: String(hardened.request?.userContent || '') }
  ];
  const raw = await runFreeAi(env, {
    model: hardened.request?.model,
    messages,
    maxTokens: Math.max(256, Math.min(Number(hardened.request?.maxOutputTokens || 4096), ROLE_OUTPUT_TOKEN_CAP)),
    temperature: hardened.request?.temperature,
    responseFormat: hardened.request?.responseFormat || (hardened.request?.responseSchema ? { type: 'json_object' } : undefined)
  }, fetchImpl);
  try {
    const expanded = expandTargetedRepairResult(raw, hardened.context);
    return assertProviderSemanticResponse(assertJsonOnlyResponse(expanded, hardened.request, 'FREE_AI_REQUEST_FAILED'), validateResponse, 'FREE_AI_REQUEST_FAILED');
  } catch (error) {
    if (String(error?.message || '') === 'GEMINI_REQUEST_FAILED') {
      const wrapped = new Error('FREE_AI_REQUEST_FAILED');
      wrapped.status = 502;
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}

export async function runPrimaryWithGeminiFallback(
  env,
  { cloudflare, gemini, freeai = null },
  aiBinding = env?.AI,
  fetchImpl = fetch,
  validateResponse = null
) {
  const primaryProvider = String(env?.TEXT_PRIMARY_PROVIDER || 'cloudflare').trim().toLowerCase();

  if (primaryProvider === 'gemini') {
    try {
      const result = await runGeminiWithRetry(env, gemini, fetchImpl, validateResponse);
      return {
        ...result,
        provider: 'google-gemini',
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
            provider: 'free-ai',
            fallbackUsed: true,
            primaryError: String(error?.message || 'GEMINI_PRIMARY_FAILED')
          };
        } catch (fallbackError) {
          freeAiError = fallbackError;
          if (!shouldFallbackFromFreeAi(fallbackError)) throw fallbackError;
        }
      }

      const cloudflareEnabled = String(env?.TEXT_CLOUDFLARE_FALLBACK_ENABLED || 'false') === 'true';
      if (!cloudflareEnabled) throw freeAiError || error;
      if (freeAiEnabled) await sleep(geminiRetryDelayMs(env));

      try {
        const raw = await runWorkersAi(env, cloudflare, aiBinding);
        const result = assertProviderSemanticResponse(assertJsonOnlyResponse(raw, cloudflare, 'CLOUDFLARE_AI_JSON_INVALID'), validateResponse, 'CLOUDFLARE_AI_JSON_INVALID');
        return {
          ...result,
          provider: 'cloudflare-workers-ai',
          fallbackUsed: true,
          primaryError: String(error?.message || 'GEMINI_PRIMARY_FAILED'),
          secondaryError: freeAiError ? String(freeAiError?.message || 'FREE_AI_FAILED') : null
        };
      } catch (fallbackError) {
        // Workers AI is the final provider in the configured Gemini -> Free.ai ->
        // Workers AI chain. Preserve that final provider's failure instead of
        // rewriting it back to the original Gemini error; otherwise production
        // recovery cannot distinguish a true Gemini-only throttle from complete
        // fallback exhaustion.
        throw fallbackError;
      }
    }
  }

  try {
    const raw = await runWorkersAi(env, cloudflare, aiBinding);
    const result = assertProviderSemanticResponse(assertJsonOnlyResponse(raw, cloudflare, 'CLOUDFLARE_AI_JSON_INVALID'), validateResponse, 'CLOUDFLARE_AI_JSON_INVALID');
    return {
      ...result,
      provider: 'cloudflare-workers-ai',
      fallbackUsed: false,
      primaryError: null
    };
  } catch (error) {
    if (!shouldFallbackFromCloudflare(error) || !String(env?.GEMINI_API_KEY || '').trim()) throw error;

    const result = await runGeminiWithRetry(env, gemini, fetchImpl, validateResponse);
    return {
      ...result,
      provider: 'google-gemini',
      fallbackUsed: true,
      primaryError: String(error.message)
    };
  }
}
