import { classifyWorkersAiFailure } from './cloudflare-ai.js';
import { runGeminiAi } from './gemini-ai.js';
import { generateKieImage } from './kie-image.js';
import { generateModelScopeImage } from './modelscope-image.js';

const DEFAULT_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const DEFAULT_IMAGE_QA_MODEL = 'gemini-3.1-flash-lite';
const ALLOWED_IMAGE_MODELS = new Set([DEFAULT_IMAGE_MODEL]);
const IMAGE_ROLES = new Set(['thumbnail', 'body']);
const PROVIDER_MODES = new Set(['auto', 'cloudflare', 'kie', 'modelscope']);
const PLAIN_SURFACE_GUARD = 'Favor simple generic real-world subjects with broad uniform surfaces, simple geometry, natural textures, and minimal decorative detail.';
const KIE_NO_TEXT_TAIL = 'No visible text, logos, branding, or watermark.';
const IMAGE_QA_TRANSIENT_DELAYS_MS = [250, 750];
const IMAGE_QA_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    detectedText: { type: 'array', items: { type: 'string' } },
    violations: { type: 'array', items: { type: 'string' } }
  },
  required: ['pass', 'detectedText', 'violations']
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLegacyGuardLine(line) {
  const text = String(line || '').trim();
  return text.startsWith('STRICT VISUAL RULE:')
    || text.startsWith('No letters, words, numbers, labels, logos, watermarks, signs, UI,')
    || text.startsWith('Avoid products or screens that normally display text;')
    || text.startsWith('Show only the practical physical scene,')
    || /^Attempt \d+: keep every visible surface free of text-like marks\.$/i.test(text)
    || /^Editorial blog image\. No text, no letters, no captions, no logos, no watermark\.$/i.test(text);
}

function normalizePrompt(value) {
  const raw = String(value || '').trim();
  if (!raw) throw Object.assign(new Error('IMAGE_PROMPT_REQUIRED'), { status: 400 });
  if (raw.length > 1900) throw Object.assign(new Error('IMAGE_PROMPT_TOO_LONG'), { status: 400 });
  const prompt = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isLegacyGuardLine(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!prompt) throw Object.assign(new Error('IMAGE_PROMPT_REQUIRED'), { status: 400 });
  return prompt;
}

function kieRecoveryLevel(raw) {
  if (/KIE_RECOVERY_LEVEL_3|even tighter close-up|minimum physical elements/i.test(raw)) return 3;
  if (/KIE_RECOVERY_LEVEL_2|Recovery visual rule|simplify the composition to a closer view|closer view/i.test(raw)) return 2;
  return 1;
}

function kieComposition(raw) {
  const level = kieRecoveryLevel(raw);
  if (level >= 3) {
    return 'Tight close-up, minimal scene elements, soft natural daylight, realistic editorial photography.';
  }
  if (level === 2) {
    return 'Close-up view, very simple composition, soft natural daylight, realistic editorial photography.';
  }
  return 'Simple uncluttered composition, soft natural daylight, realistic editorial photography.';
}

function isComputerTechTopic(raw) {
  return /(?:\bpc\b|컴퓨터|윈도우|windows|노트북|laptop|desktop|블루스크린|blue\s*screen|작업\s*관리자|task\s*manager|렉\s*걸림|버벅|느려|slow\s*(?:pc|computer)|\bcpu\b|\bgpu\b|\bram\b|메모리|드라이버|driver)/i.test(raw);
}

function computerTechScene(raw) {
  const level = kieRecoveryLevel(raw);
  if (level >= 3) {
    return 'A realistic editorial photograph in extreme tight close-up of one plain black computer cooling fan housing mounted inside a smooth unbranded metal desktop case, with one sleeved cable and only fingertips or one simple tool visible. All monitors, keyboards, circuit boards, stickers, labels, packaging, documents, and decorative electronics are completely out of frame. Broad unlabeled unmarked surfaces and minimal physical detail.';
  }
  if (level === 2) {
    return 'A realistic editorial photograph of an open unbranded desktop computer case on a clean workbench, with a person’s hands checking one plain cooling fan and one sleeved cable connection. No monitor or keyboard is visible, exposed circuit boards are minimized, and the case interior uses broad unlabeled unmarked surfaces.';
  }
  return 'A realistic editorial photograph of an open unbranded desktop computer case on a clean workbench, with one pair of hands inspecting a plain cooling fan and a sleeved cable connection. The monitor and keyboard are out of frame, the metal case surfaces are smooth and unmarked, and only a few simple physical components are visible.';
}

function prepareKiePrompt(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  const composition = kieComposition(raw);

  if (isComputerTechTopic(raw)) {
    return `${computerTechScene(raw)} ${composition} ${KIE_NO_TEXT_TAIL}`;
  }

  if (/\bshower\b[^.]*\bwater pressure\b|\bwater pressure\b[^.]*\bshower\b/i.test(raw)) {
    return `A realistic editorial photograph of a residential chrome showerhead with a steady stream of water against a clean light-colored tiled bathroom wall. ${composition} ${KIE_NO_TEXT_TAIL}`;
  }

  if (/\bwater shutoff\b|\bshutoff valve\b|\bmain water valve\b/i.test(raw)) {
    return `A realistic editorial photograph of a residential main water shutoff valve connected to exposed household plumbing in a clean utility area. Slightly angled view with a clear focal subject. ${composition} ${KIE_NO_TEXT_TAIL}`;
  }

  if (/\bai assistants?\b|\bartificial intelligence\b[^.]*\b(?:home|household|maintenance)\b|\bai\b[^.]*\b(?:home|household|maintenance)\b/i.test(raw)) {
    return `A realistic editorial photograph of a homeowner inspecting a household fixture with simple hand tools in a clean residential setting. Natural candid pose with one clear focal subject. ${composition} ${KIE_NO_TEXT_TAIL}`;
  }

  const focused = raw.match(/focused on\s+([^.]+)/i)?.[1]
    ?.replace(/\b(?:devices?|screens?|displays?|monitors?|interfaces?|gauges?|meters?)\b/gi, '')
    .replace(/control panels?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const subject = focused || 'a practical household repair or maintenance scene';
  return `A realistic editorial photograph focused on ${subject}. One clear focal subject in a clean residential setting. ${composition} ${KIE_NO_TEXT_TAIL}`;
}

function normalizeSteps(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const steps = Number(value);
  if (!Number.isInteger(steps) || steps < 1 || steps > 8) {
    throw Object.assign(new Error('IMAGE_STEPS_INVALID'), { status: 400 });
  }
  return steps;
}

function normalizeSeed(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) {
    throw Object.assign(new Error('IMAGE_SEED_INVALID'), { status: 400 });
  }
  return seed;
}

function normalizeProviderMode(value) {
  const mode = String(value || 'auto').trim().toLowerCase();
  if (!PROVIDER_MODES.has(mode)) throw Object.assign(new Error('IMAGE_PROVIDER_MODE_INVALID'), { status: 400 });
  return mode;
}

function imageQaRequired(env) {
  return String(env?.IMAGE_QA_REQUIRED || 'false').trim().toLowerCase() === 'true';
}

function imageQaAttempts(env) {
  const attempts = Number(env?.IMAGE_QA_MAX_ATTEMPTS || 3);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 4) {
    throw Object.assign(new Error('IMAGE_QA_MAX_ATTEMPTS_INVALID'), { status: 500 });
  }
  return attempts;
}

function isTransientImageQaFailure(error) {
  const message = String(error?.message || '');
  return ['GEMINI_UNAVAILABLE', 'GEMINI_RATE_LIMITED', 'GEMINI_TIMEOUT', 'GEMINI_REQUEST_FAILED', 'GEMINI_EMPTY_RESPONSE'].includes(message);
}

function nextSeed(seed, attempt) {
  if (!Number.isInteger(seed)) return undefined;
  return (seed + Math.max(0, attempt - 1) * 104729) % 2147483647;
}

function promptForAttempt(prompt, attempt) {
  if (attempt <= 1) return prompt;
  if (attempt === 2) {
    return `${prompt} Simplify the composition to a closer view of only the essential physical subject and plain surroundings. Remove secondary props and decorative detail. Use fewer objects, broader uniform surfaces, and simple natural geometry.`;
  }
  return `${prompt} Use an even tighter close-up with only the minimum physical elements needed to show the subject. Favor simple fixtures, hand tools, walls, tile, pipes, hands, or materials with broad uniform surfaces and subdued detail.`;
}

async function generateCloudflareImage(env, { role, prompt, steps, seed }, aiBinding) {
  if (!aiBinding || typeof aiBinding.run !== 'function') {
    throw Object.assign(new Error('IMAGE_AI_BINDING_REQUIRED'), { status: 500 });
  }
  const model = String(env?.IMAGE_MODEL || DEFAULT_IMAGE_MODEL).trim();
  if (!ALLOWED_IMAGE_MODELS.has(model)) throw Object.assign(new Error('IMAGE_MODEL_NOT_ALLOWED'), { status: 500 });

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

  const imageBase64 = String(result?.image || '').trim();
  if (!imageBase64) throw Object.assign(new Error('IMAGE_EMPTY_RESPONSE'), { status: 502 });

  return {
    ok: true,
    role,
    provider: 'cloudflare-workers-ai',
    model,
    mimeType: 'image/jpeg',
    imageBase64,
    steps,
    seed
  };
}

async function generateProviderImage(env, { role, prompt, steps, seed, providerMode, aspectRatio, taskId }, aiBinding, fetchImpl) {
  if (providerMode === 'kie') {
    const result = await generateKieImage(env, { role, prompt: prepareKiePrompt(prompt), aspectRatio, taskId }, fetchImpl);
    return { ...result, role, providerMode: 'kie' };
  }

  if (providerMode === 'modelscope') {
    const result = await generateModelScopeImage(env, { role, prompt, aspectRatio, taskId }, fetchImpl);
    return { ...result, role, providerMode: 'modelscope' };
  }

  try {
    return { ...(await generateCloudflareImage(env, { role, prompt, steps, seed }, aiBinding)), providerMode };
  } catch (cloudflareError) {
    if (providerMode === 'cloudflare' || !String(env?.KIE_API_KEY || '').trim()) throw cloudflareError;
    const kie = await generateKieImage(env, { role, prompt: prepareKiePrompt(prompt), aspectRatio, taskId }, fetchImpl);
    return {
      ...kie,
      role,
      providerMode: 'auto',
      fallbackFrom: 'cloudflare-workers-ai',
      fallbackReason: String(cloudflareError?.message || 'CLOUDFLARE_IMAGE_FAILED')
    };
  }
}

async function inspectGeneratedImage(env, generated, fetchImpl) {
  if (!String(env?.GEMINI_API_KEY || '').trim()) {
    throw Object.assign(new Error('IMAGE_QA_GEMINI_REQUIRED'), { status: 503 });
  }
  const model = String(env?.GEMINI_IMAGE_QA_MODEL || env?.GEMINI_CRITIC_MODEL || DEFAULT_IMAGE_QA_MODEL).trim();
  const result = await runGeminiAi(env, {
    model,
    systemInstruction: [
      'You are a strict image compliance gate for blog publishing.',
      'Inspect only the supplied image pixels.',
      'Set pass=false if any readable or clearly intended writing is visible, including words, letters, numbers, logos, watermarks, captions, labels, signs, packaging marks, interface writing, or title overlays.',
      'Do not fail harmless abstract shapes, texture, pipes, seams, shadows, or random marks that are not actually readable.',
      'Only list violations related to readable or clearly intended writing, logos, watermarks, labels, captions, signs, packaging marks, interface writing, or title overlays. Do not use this field for aesthetic or composition preferences.',
      'Return only the requested JSON structure.'
    ].join(' '),
    userContent: 'Inspect this generated source image before publication. List any readable snippets you can see and any compliance violations.',
    inlineImage: {
      mimeType: String(generated?.mimeType || '').split(';')[0].trim().toLowerCase(),
      data: String(generated?.imageBase64 || '').trim()
    },
    maxOutputTokens: 384,
    responseSchema: IMAGE_QA_SCHEMA,
    thinking: 'minimal'
  }, fetchImpl);

  let parsed;
  try { parsed = JSON.parse(String(result.response || '')); } catch {
    throw Object.assign(new Error('IMAGE_QA_RESPONSE_INVALID'), { status: 502 });
  }
  const detectedText = Array.isArray(parsed?.detectedText)
    ? parsed.detectedText.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12)
    : [];
  const violations = Array.isArray(parsed?.violations)
    ? parsed.violations.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12)
    : [];
  const hardViolations = violations.filter((item) => /(readable|text|letter|number|logo|watermark|caption|label|sign|packaging|interface|\bui\b|title|writing|문자|글자|숫자|로고|워터마크|라벨|표지|간판)/i.test(item));
  return {
    pass: detectedText.length === 0 && hardViolations.length === 0,
    detectedText,
    violations: hardViolations,
    model: result.model
  };
}

async function inspectGeneratedImageWithRetry(env, generated, fetchImpl) {
  const maxChecks = IMAGE_QA_TRANSIENT_DELAYS_MS.length + 1;
  let lastError = null;
  for (let check = 1; check <= maxChecks; check += 1) {
    try {
      return { ...(await inspectGeneratedImage(env, generated, fetchImpl)), inspectionAttempts: check };
    } catch (error) {
      lastError = error;
      if (!isTransientImageQaFailure(error) || check >= maxChecks) throw error;
      await sleep(IMAGE_QA_TRANSIENT_DELAYS_MS[check - 1]);
    }
  }
  throw lastError;
}

export async function generateImage(env, input, aiBinding = env?.AI, fetchImpl = fetch) {
  const role = String(input?.role || 'body').trim();
  if (!IMAGE_ROLES.has(role)) throw Object.assign(new Error('IMAGE_ROLE_INVALID'), { status: 400 });

  const basePrompt = normalizePrompt(input?.prompt);
  const prompt = `${basePrompt}\n\n${PLAIN_SURFACE_GUARD}`;
  const steps = normalizeSteps(input?.steps);
  const seed = normalizeSeed(input?.seed);
  const providerMode = normalizeProviderMode(input?.providerMode);
  const qaRequired = imageQaRequired(env);
  const maxAttempts = qaRequired ? imageQaAttempts(env) : 1;

  if (providerMode === 'auto' || providerMode === 'cloudflare') {
    const model = String(env?.IMAGE_MODEL || DEFAULT_IMAGE_MODEL).trim();
    if (!ALLOWED_IMAGE_MODELS.has(model)) throw Object.assign(new Error('IMAGE_MODEL_NOT_ALLOWED'), { status: 500 });
  }

  let lastQa = null;
  let lastGenerated = null;
  let providerAttempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const generated = await generateProviderImage(env, {
      role,
      prompt: promptForAttempt(prompt, attempt),
      steps,
      seed: nextSeed(seed, attempt),
      providerMode,
      aspectRatio: input?.aspectRatio,
      taskId: input?.taskId
    }, aiBinding, fetchImpl);
    lastGenerated = generated;
    providerAttempts = attempt;

    if (generated?.pending === true || generated?.complete === false) {
      return {
        ...generated,
        imageQa: { enabled: qaRequired, pass: null, attempts: 0, pending: true }
      };
    }

    if (!qaRequired) {
      return { ...generated, imageQa: { enabled: false, pass: null, attempts: 0 } };
    }

    const qa = await inspectGeneratedImageWithRetry(env, generated, fetchImpl);
    lastQa = qa;
    if (qa.pass) {
      return {
        ...generated,
        imageQa: {
          enabled: true,
          pass: true,
          attempts: attempt,
          inspectionAttempts: qa.inspectionAttempts,
          model: qa.model
        }
      };
    }

    if (generated.provider === 'kie-ai' || generated.provider === 'modelscope-ai') break;
  }

  const error = new Error('IMAGE_QA_REJECTED');
  error.status = 502;
  error.qaAttempts = providerAttempts;
  error.qaViolationCount = Number(lastQa?.violations?.length || 0);
  error.qaDetectedTextCount = Number(lastQa?.detectedText?.length || 0);
  error.qaDetectedText = Array.isArray(lastQa?.detectedText) ? lastQa.detectedText.slice(0, 8) : [];
  error.qaViolations = Array.isArray(lastQa?.violations) ? lastQa.violations.slice(0, 8) : [];
  if (lastGenerated?.provider === 'kie-ai' && /^https:\/\//i.test(String(lastGenerated?.sourceUrl || ''))) {
    error.rejectedImageUrl = String(lastGenerated.sourceUrl);
    error.rejectedImageMimeType = String(lastGenerated.mimeType || 'image/jpeg');
    error.rejectedProvider = 'kie-ai';
    error.rejectedModel = String(lastGenerated.model || 'z-image');
    error.rejectedTaskId = String(lastGenerated.taskId || '');
  }
  throw error;
}
