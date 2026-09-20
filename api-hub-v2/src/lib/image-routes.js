import { classifyWorkersAiFailure } from './cloudflare-ai.js';
import { runGeminiAi } from './gemini-ai.js';
import { generateKieImage, resolveModelForRole, GPT4O_IMAGE_MODEL } from './kie-image.js';
import { generateModelScopeImage } from './modelscope-image.js';

const DEFAULT_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const DEFAULT_IMAGE_QA_MODEL = 'gemini-3.1-flash-lite';
const ALLOWED_IMAGE_MODELS = new Set([DEFAULT_IMAGE_MODEL]);
const IMAGE_ROLES = new Set(['thumbnail', 'body']);
const PROVIDER_MODES = new Set(['auto', 'cloudflare', 'kie', 'modelscope']);
const PLAIN_SURFACE_GUARD = 'Favor simple generic real-world subjects with broad uniform surfaces, simple geometry, natural textures, and minimal decorative detail.';
// A blanket "no visible text" QA rejection gate used to sit downstream of this tail and was
// removed (over-rejected benign real-world text like product labels), which is a separate
// concern from what this prompt tail should say. Emptying this tail at the same time was a
// mistake for body images: they never receive hookText (thumbnail-only) and have no reason to
// render any text at all, yet with no guidance here the model spontaneously hallucinates a
// digital gauge/readout with garbled pseudo-Korean text for numeric topics like GPU
// temperature (confirmed on job #204's body images). This does not resurrect the old QA
// rejection gate -- it only tells the generator itself not to invent on-screen text/UI, which
// is unrelated to whether a rejection gate exists downstream. It must never coexist with
// gpt4oHookRenderTail (the thumbnail hook-caption instruction), since the two contradict.
const KIE_NO_TEXT_TAIL = 'Do not bake any invented digits, dials, readouts, labels, or lettering into the photo as if it depicted a working numeric indicator. Depict the physical subject itself, not a rendered readout or caption overlaid on it.';
const IMAGE_QA_TRANSIENT_DELAYS_MS = [250, 750];
const IMAGE_QA_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    detectedText: { type: 'array', items: { type: 'string' } },
    violations: { type: 'array', items: { type: 'string' } },
    semanticMatch: { type: 'boolean' },
    semanticReason: { type: 'string' }
  },
  required: ['pass', 'detectedText', 'violations', 'semanticMatch', 'semanticReason']
});
const HOOK_MATCH_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    detectedText: { type: 'string' },
    matches: { type: 'boolean' }
  },
  required: ['detectedText', 'matches']
});

// GPT4o-image is the one KIE model that reliably renders legible text, so a thumbnail's
// first-ever attempt bakes the hook caption straight into the image instead of relying on
// the separate HTML-overlay post-processing step. This tail replaces KIE_NO_TEXT_TAIL --
// it must not coexist with it, since the two instructions directly contradict each other.
function gpt4oHookRenderTail(hookText) {
  const hook = String(hookText || '').replace(/\s+/g, ' ').trim();
  return `Render the exact headline text "${hook}" as a bold, highly legible caption near the bottom third of the image, in a clean modern sans-serif font with strong color contrast against the background. Spell it exactly as given, in that language, with no other letters, words, numbers, or logos anywhere else in the image.`;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isLegacyGuardLine(line) {
  const text = String(line || '').trim();
  return text.startsWith('STRICT VISUAL RULE:') || text.startsWith('No letters, words, numbers, labels, logos, watermarks, signs, UI,') || text.startsWith('Avoid products or screens that normally display text;') || text.startsWith('Show only the practical physical scene,') || /^Attempt \d+: keep every visible surface free of text-like marks\.$/i.test(text) || /^Editorial blog image\. No text, no letters, no captions, no logos, no watermark\.$/i.test(text);
}
function normalizePrompt(value) {
  const raw = String(value || '').trim();
  if (!raw) throw Object.assign(new Error('IMAGE_PROMPT_REQUIRED'), { status: 400 });
  if (raw.length > 1900) throw Object.assign(new Error('IMAGE_PROMPT_TOO_LONG'), { status: 400 });
  const prompt = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !isLegacyGuardLine(line)).join(' ').replace(/\s+/g, ' ').trim();
  if (!prompt) throw Object.assign(new Error('IMAGE_PROMPT_REQUIRED'), { status: 400 });
  return prompt;
}
function kieRecoveryLevel(raw) { if (/KIE_RECOVERY_LEVEL_3|even tighter close-up|minimum physical elements/i.test(raw)) return 3; if (/KIE_RECOVERY_LEVEL_2|Recovery visual rule|simplify the composition to a closer view|closer view/i.test(raw)) return 2; return 1; }
function kieComposition(raw) { const level = kieRecoveryLevel(raw); if (level >= 3) return 'Tight close-up, minimal scene elements, soft natural daylight, realistic editorial photography.'; if (level === 2) return 'Close-up view, very simple composition, soft natural daylight, realistic editorial photography.'; return 'Simple uncluttered composition, soft natural daylight, realistic editorial photography.'; }
function prepareKiePrompt(value, tail = KIE_NO_TEXT_TAIL) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim(); const composition = kieComposition(raw);
  // Keep the planner's exact PC/troubleshooting subject. The previous replacement
  // converted every computer article into the same fan/ventilation scene.
  if (/\bshower\b[^.]*\bwater pressure\b|\bwater pressure\b[^.]*\bshower\b/i.test(raw)) return `A realistic editorial photograph of a residential chrome showerhead with a steady stream of water against a clean light-colored tiled bathroom wall. ${composition} ${tail}`;
  if (/\bwater shutoff\b|\bshutoff valve\b|\bmain water valve\b/i.test(raw)) return `A realistic editorial photograph of a residential main water shutoff valve connected to exposed household plumbing in a clean utility area. Slightly angled view with a clear focal subject. ${composition} ${tail}`;
  // Requires an explicit home/household mention alongside the ai/assistant term -- "maintenance"
  // alone used to qualify too, so any unrelated topic that merely said "AI ... maintenance"
  // (e.g. "AI subscription tiers against long-term maintenance and budget planning") was wrongly
  // forced into this residential scene, which the Gemini QA gate then rejected as a semantic
  // mismatch (confirmed on job #167, an AI-subscription-plan article for freelancers).
  if (/\bartificial intelligence\b[^.]*\b(?:home|household)\b|\bai\b[^.]*\b(?:home|household)\b/i.test(raw)) return `A realistic editorial photograph of a homeowner inspecting a household fixture with simple hand tools in a clean residential setting. Natural candid pose with one clear focal subject. ${composition} ${tail}`;
  const focused = raw.match(/focused on\s+([^.]+)/i)?.[1]?.replace(/\b(?:devices?|screens?|displays?|monitors?|interfaces?|gauges?|meters?)\b/gi, '').replace(/control panels?/gi, '').replace(/\s+/g, ' ').trim();
  // Everything above is genuinely home-repair-specific (shower/water-valve/AI-home-assistant
  // topics), which only ever match a blog actually writing about those things -- harmless
  // for any other blog's content. This fallback is not scoped that way: it used to force
  // *every* other topic into "a practical household repair or maintenance scene ... in a
  // clean residential setting" regardless of subject, which is the KIE-only pipeline's only
  // provider now (see scheduledProviderModeForImage in the worker). A non-home blog's KIE
  // images were being asked to depict an unrelated scene in a residential setting, which the
  // Gemini QA gate then rejected as a semantic mismatch far more often than it should have.
  const subject = focused || 'a practical everyday subject';
  // Confirmed across a wide sample of production SEMANTIC_MISMATCH rejections (job #161,
  // #162, #165, #166, #171, and others): for a diagnostic/settings topic with no obvious
  // hands-on physical action, the model's most common fallback interpretation of "a person's
  // hands doing something with a device" is the generic stock-photo cliche of wiping or
  // dusting a screen with a cloth -- completely unrelated to almost every such topic.
  // A "do not depict wiping/dusting/cleaning" negation was tried here first and did not hold
  // up in production (confirmed again on job batches for an unrelated Smile Atlas travel
  // blog on 2026-09-20, well after the model-and-topic scoping fixes above): z-image is a
  // distilled/turbo model with no classifier-free guidance at inference, so it has no real
  // negative-conditioning pathway -- every token in the prompt, negated or not, is something
  // to draw toward, not away from. Naming "wiping, dusting, cleaning, cloth" at all keeps
  // biasing generations toward exactly that scene. The fix is to never name the cliche and
  // instead give a small set of concrete positive actions to depict instead.
  return `A realistic editorial photograph focused on ${subject}. One clear focal subject in natural everyday surroundings. Depict a specific, literal real-world moment unique to this exact subject: a hand holding, pointing to, comparing, arranging, or closely inspecting the actual object or detail named above. ${composition} ${tail}`;
}
function normalizeSteps(value) { if (value === undefined || value === null || value === '') return undefined; const steps = Number(value); if (!Number.isInteger(steps) || steps < 1 || steps > 8) throw Object.assign(new Error('IMAGE_STEPS_INVALID'), { status: 400 }); return steps; }
function normalizeSeed(value) { if (value === undefined || value === null || value === '') return undefined; const seed = Number(value); if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) throw Object.assign(new Error('IMAGE_SEED_INVALID'), { status: 400 }); return seed; }
function normalizeProviderMode(value) { const mode = String(value || 'auto').trim().toLowerCase(); if (!PROVIDER_MODES.has(mode)) throw Object.assign(new Error('IMAGE_PROVIDER_MODE_INVALID'), { status: 400 }); return mode; }
function imageQaRequired(env) { return String(env?.IMAGE_QA_REQUIRED || 'false').trim().toLowerCase() === 'true'; }
function imageQaAttempts(env) { const attempts = Number(env?.IMAGE_QA_MAX_ATTEMPTS || 3); if (!Number.isInteger(attempts) || attempts < 1 || attempts > 4) throw Object.assign(new Error('IMAGE_QA_MAX_ATTEMPTS_INVALID'), { status: 500 }); return attempts; }
function isTransientImageQaFailure(error) { const message = String(error?.message || ''); return ['GEMINI_UNAVAILABLE', 'GEMINI_RATE_LIMITED', 'GEMINI_TIMEOUT', 'GEMINI_REQUEST_FAILED', 'GEMINI_EMPTY_RESPONSE'].includes(message); }
function nextSeed(seed, attempt) { if (!Number.isInteger(seed)) return undefined; return (seed + Math.max(0, attempt - 1) * 104729) % 2147483647; }
function promptForAttempt(prompt, attempt) { if (attempt <= 1) return prompt; if (attempt === 2) return `${prompt} Simplify the composition to a closer view of only the essential physical subject and plain surroundings. Remove secondary props and decorative detail. Use fewer objects, broader uniform surfaces, and simple natural geometry.`; return `${prompt} Use an even tighter close-up with only the minimum physical elements needed to show the subject. Favor simple fixtures, hand tools, walls, tile, pipes, hands, or materials with broad uniform surfaces and subdued detail.`; }
async function generateCloudflareImage(env, { role, prompt, steps, seed }, aiBinding) {
  if (!aiBinding || typeof aiBinding.run !== 'function') throw Object.assign(new Error('IMAGE_AI_BINDING_REQUIRED'), { status: 500 });
  const model = String(env?.IMAGE_MODEL || DEFAULT_IMAGE_MODEL).trim(); if (!ALLOWED_IMAGE_MODELS.has(model)) throw Object.assign(new Error('IMAGE_MODEL_NOT_ALLOWED'), { status: 500 });
  const providerInput = { prompt }; if (Number.isInteger(steps)) providerInput.steps = steps; if (Number.isInteger(seed)) providerInput.seed = seed;
  let result; try { result = await aiBinding.run(model, providerInput); } catch (cause) { const classified = classifyWorkersAiFailure(cause); const error = Object.assign(new Error(classified.message), { status: classified.status }); if (Number.isInteger(classified.providerCode)) error.providerCode = classified.providerCode; throw error; }
  const imageBase64 = String(result?.image || '').trim(); if (!imageBase64) throw Object.assign(new Error('IMAGE_EMPTY_RESPONSE'), { status: 502 }); return { ok: true, role, provider: 'cloudflare-workers-ai', model, mimeType: 'image/jpeg', imageBase64, steps, seed };
}
// gpt4o-image reliably renders Latin-script headlines but not Hangul -- a Korean hookText
// (buildThumbnailHook in image-plan.js defaults to Korean whenever the article's language
// isn't 'en') comes back as garbled pseudo-characters instead of legible text. There is no
// prompt wording that fixes this; it is a model-level limitation. Never spend a KIE
// gpt4o-image attempt on a hook the model cannot render -- go straight to the plain no-text
// path below instead, which the HTML-overlay post-processing step then captions for real.
function isLatinRenderableHookText(hookText) {
  return !/[가-힣ᄀ-ᇿ㄰-㆏]/.test(String(hookText || ''));
}

async function generateProviderImage(env, { role, prompt, steps, seed, providerMode, aspectRatio, taskId, hookText }, aiBinding, fetchImpl) {
  // hookText only ever affects gpt4o-image specifically (the one KIE model that can
  // reliably render legible text) -- see prepareKiePrompt's tail swap and
  // startGpt4oImageTask in kie-image.js. z-image, modelscope, and cloudflare all keep the
  // standard "no visible text" prompt: appending the hook-render tail there as well would
  // leave two contradictory text instructions in the same prompt.
  const targetsGpt4o = role === 'thumbnail' && Boolean(hookText) && isLatinRenderableHookText(hookText) && resolveModelForRole(env, role) === GPT4O_IMAGE_MODEL;
  const hookTail = targetsGpt4o ? gpt4oHookRenderTail(hookText) : KIE_NO_TEXT_TAIL;
  if (providerMode === 'kie') { const result = await generateKieImage(env, { role, prompt: prepareKiePrompt(prompt, hookTail), aspectRatio, taskId, hookText: targetsGpt4o ? hookText : '' }, fetchImpl); return { ...result, role, providerMode: 'kie' }; }
  if (providerMode === 'modelscope') { const result = await generateModelScopeImage(env, { role, prompt: prepareKiePrompt(prompt), aspectRatio, taskId }, fetchImpl); return { ...result, role, providerMode: 'modelscope' }; }
  try { return { ...(await generateCloudflareImage(env, { role, prompt, steps, seed }, aiBinding)), providerMode }; } catch (cloudflareError) { if (providerMode === 'cloudflare' || !String(env?.KIE_API_KEY || '').trim()) throw cloudflareError; const kie = await generateKieImage(env, { role, prompt: prepareKiePrompt(prompt, hookTail), aspectRatio, taskId, hookText: targetsGpt4o ? hookText : '' }, fetchImpl); return { ...kie, role, providerMode: 'auto', fallbackFrom: 'cloudflare-workers-ai', fallbackReason: String(cloudflareError?.message || 'CLOUDFLARE_IMAGE_FAILED') }; }
}
async function inspectGeneratedImage(env, generated, expectedPrompt, fetchImpl) {
  if (!String(env?.GEMINI_API_KEY || '').trim()) throw Object.assign(new Error('IMAGE_QA_GEMINI_REQUIRED'), { status: 503 });
  const model = String(env?.GEMINI_IMAGE_QA_MODEL || env?.GEMINI_CRITIC_MODEL || DEFAULT_IMAGE_QA_MODEL).trim();
  const expected = String(expectedPrompt || '').replace(/\s+/g, ' ').trim().slice(0, 1400);
  // This gate used to fail on any visible text, then (briefly) on logos/watermarks too.
  // Both rules only ever existed to stop the gpt4o thumbnail-hook feature from baking
  // garbled Korean headline text into images -- that problem is fixed at its source
  // (isLatinRenderableHookText in generateImage()), and a thumbnail that DOES bake a hook
  // still gets its own exact-match check via inspectThumbnailHookText. This gate now only
  // checks whether the image's subject actually matches what was asked for; text, UI,
  // labels, logos, and watermarks are all fine.
  const result = await runGeminiAi(env, { model, systemInstruction: ['You are a semantic-relevance gate for blog publishing images.','Inspect only the supplied image pixels and compare them with the expected visual subject/task supplied by the user.','Set semanticMatch=false when the main visible subject or action does not clearly correspond to the expected visual subject/task. A generic portrait, posed person, generic workshop, unrelated room, scenery, or merely thematic stock image is a mismatch when the requested repair target, object, material, condition, or action is not visibly central.','Accept reasonable visual interpretations and normal variation when the requested physical subject or task is clearly recognizable and dominant. Do not require an exact composition.','Visible text, UI, labels, logos, and watermarks are never violations -- ignore them entirely and do not report them.','Return only the requested JSON structure.'].join(' '), userContent: `Expected visual subject/task: ${expected}\nInspect this generated source image before publication and report whether the main visible subject/action semantically matches the expectation.`, inlineImage: { mimeType: String(generated?.mimeType || '').split(';')[0].trim().toLowerCase(), data: String(generated?.imageBase64 || '').trim() }, maxOutputTokens: 512, responseSchema: IMAGE_QA_SCHEMA, thinking: 'minimal' }, fetchImpl);
  let parsed; try { parsed = JSON.parse(String(result.response || '')); } catch { throw Object.assign(new Error('IMAGE_QA_RESPONSE_INVALID'), { status: 502 }); }
  const detectedText = Array.isArray(parsed?.detectedText) ? parsed.detectedText.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12) : [];
  const violations = Array.isArray(parsed?.violations) ? parsed.violations.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12) : [];
  const semanticMatch = parsed?.semanticMatch === true;
  const semanticReason = String(parsed?.semanticReason || '').trim().slice(0, 500);
  return { pass: semanticMatch, detectedText, violations, semanticMatch, semanticReason, model: result.model };
}
async function inspectGeneratedImageWithRetry(env, generated, expectedPrompt, fetchImpl) { const maxChecks = IMAGE_QA_TRANSIENT_DELAYS_MS.length + 1; let lastError = null; for (let check = 1; check <= maxChecks; check += 1) { try { return { ...(await inspectGeneratedImage(env, generated, expectedPrompt, fetchImpl)), inspectionAttempts: check }; } catch (error) { lastError = error; if (!isTransientImageQaFailure(error) || check >= maxChecks) throw error; await sleep(IMAGE_QA_TRANSIENT_DELAYS_MS[check - 1]); } } throw lastError; }
// Narrower than inspectGeneratedImage: a gpt4o-image thumbnail with a hook baked in is
// expected to contain exactly the requested headline, so this only verifies that text
// matches -- it does not re-run the full no-text/semantic-match gate (see the "텍스트 일치
// 검증만" decision this feature shipped with).
async function inspectThumbnailHookText(env, generated, hookText, fetchImpl) {
  if (!String(env?.GEMINI_API_KEY || '').trim()) throw Object.assign(new Error('IMAGE_QA_GEMINI_REQUIRED'), { status: 503 });
  const model = String(env?.GEMINI_IMAGE_QA_MODEL || env?.GEMINI_CRITIC_MODEL || DEFAULT_IMAGE_QA_MODEL).trim();
  const expected = String(hookText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const result = await runGeminiAi(env, {
    model,
    systemInstruction: [
      'You are checking whether an AI-generated thumbnail image correctly rendered a specific headline caption.',
      'Report the exact headline text visible in the image, as best you can read it.',
      'Then decide whether it matches the expected headline below, allowing minor differences in case, spacing, or punctuation, but the words and their order must match.',
      'If no legible headline text is visible at all, or it says something substantially different, matches must be false.',
      'Return only the requested JSON structure.'
    ].join(' '),
    userContent: `Expected headline: "${expected}"\nInspect the visible headline text in this image and report whether it matches.`,
    inlineImage: { mimeType: String(generated?.mimeType || '').split(';')[0].trim().toLowerCase(), data: String(generated?.imageBase64 || '').trim() },
    maxOutputTokens: 256,
    responseSchema: HOOK_MATCH_SCHEMA,
    thinking: 'minimal'
  }, fetchImpl);
  let parsed; try { parsed = JSON.parse(String(result.response || '')); } catch { throw Object.assign(new Error('IMAGE_QA_RESPONSE_INVALID'), { status: 502 }); }
  return { matches: parsed?.matches === true, detectedText: String(parsed?.detectedText || '').trim().slice(0, 200), model: result.model };
}
async function inspectThumbnailHookWithRetry(env, generated, hookText, fetchImpl) { const maxChecks = IMAGE_QA_TRANSIENT_DELAYS_MS.length + 1; let lastError = null; for (let check = 1; check <= maxChecks; check += 1) { try { return { ...(await inspectThumbnailHookText(env, generated, hookText, fetchImpl)), inspectionAttempts: check }; } catch (error) { lastError = error; if (!isTransientImageQaFailure(error) || check >= maxChecks) throw error; await sleep(IMAGE_QA_TRANSIENT_DELAYS_MS[check - 1]); } } throw lastError; }

// index.js's providerValidationHint passthrough only forwards a value matching this exact
// charset (see the regex guard there), so any free-text Gemini reasoning must be sanitized
// to it -- otherwise the actual "why" (text detected vs. topic mismatch, and the model's own
// explanation) never leaves this function and every caller only ever sees the bare
// IMAGE_QA_REJECTED code, same gap this session already closed for the writer/critic path.
function imageQaRejectionHint(lastQa) {
  const parts = [];
  if (lastQa?.violations?.length) parts.push(`TEXT_OR_LOGO:${lastQa.violations.join('|')}`);
  if (lastQa?.detectedText?.length) parts.push(`DETECTED_TEXT:${lastQa.detectedText.join('|')}`);
  if (lastQa?.semanticMatch === false) parts.push(`SEMANTIC_MISMATCH:${lastQa.semanticReason || ''}`);
  const detail = parts.join(' ').replace(/[\r\n]+/g, ' ').trim();
  if (!detail) return null;
  return detail.replace(/[^A-Za-z0-9_./,:; -]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
}
export async function generateImage(env, input, aiBinding = env?.AI, fetchImpl = fetch) {
  const role = String(input?.role || 'body').trim(); if (!IMAGE_ROLES.has(role)) throw Object.assign(new Error('IMAGE_ROLE_INVALID'), { status: 400 });
  const basePrompt = normalizePrompt(input?.prompt); const prompt = `${basePrompt}\n\n${PLAIN_SURFACE_GUARD}`; const steps = normalizeSteps(input?.steps); const seed = normalizeSeed(input?.seed); const providerMode = normalizeProviderMode(input?.providerMode); const qaRequired = imageQaRequired(env); const maxAttempts = qaRequired ? imageQaAttempts(env) : 1;
  // Only relevant for role='thumbnail': the caller opts into hook-baking by sending
  // hookText, and only for a fresh (never-yet-attempted) submission -- see the worker's
  // callImageProvider(), which is the single place that decides when to include it.
  // A non-Latin-renderable hook (buildThumbnailHook in the worker's image-plan.js defaults
  // to Korean for any non-'en' article) is treated as if no hook were given at all: gpt4o-
  // image cannot reliably render Hangul, so the hook-match QA branch below would otherwise
  // compare Korean text against an image that was never asked to contain it and fail every
  // single time with IMAGE_HOOK_TEXT_MISMATCH.
  const hookText = role === 'thumbnail' && isLatinRenderableHookText(input?.hookText)
    ? String(input?.hookText || '').trim()
    : '';
  if (providerMode !== 'kie' && providerMode !== 'modelscope') { const model = String(env?.IMAGE_MODEL || DEFAULT_IMAGE_MODEL).trim(); if (!ALLOWED_IMAGE_MODELS.has(model)) throw Object.assign(new Error('IMAGE_MODEL_NOT_ALLOWED'), { status: 500 }); }
  let lastQa = null; let lastGenerated = null; let providerAttempts = 0; let lastHookQa = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptPrompt = promptForAttempt(prompt, attempt);
    const generated = await generateProviderImage(env, { role, prompt: attemptPrompt, steps, seed: nextSeed(seed, attempt), providerMode, aspectRatio: input?.aspectRatio, taskId: input?.taskId, hookText }, aiBinding, fetchImpl); lastGenerated = generated; providerAttempts = attempt;
    if (generated?.pending === true || generated?.complete === false) return { ...generated, imageQa: { enabled: qaRequired, pass: null, attempts: 0, pending: true } };
    if (hookText && generated.model === GPT4O_IMAGE_MODEL) {
      const hookQa = await inspectThumbnailHookWithRetry(env, generated, hookText, fetchImpl); lastHookQa = hookQa;
      if (hookQa.matches) return { ...generated, hookBaked: true, imageQa: { enabled: true, pass: true, mode: 'hook-match', attempts: attempt, inspectionAttempts: hookQa.inspectionAttempts, detectedText: hookQa.detectedText, model: hookQa.model } };
      break;
    }
    if (!qaRequired) return { ...generated, imageQa: { enabled: false, pass: null, attempts: 0 } };
    const qa = await inspectGeneratedImageWithRetry(env, generated, attemptPrompt, fetchImpl); lastQa = qa; if (qa.pass) return { ...generated, imageQa: { enabled: true, pass: true, attempts: attempt, inspectionAttempts: qa.inspectionAttempts, semanticMatch: true, model: qa.model } };
    if (generated.provider === 'kie-ai' || generated.provider === 'modelscope') break;
  }
  if (lastHookQa) {
    // A hook-text mismatch is never treated as a fatal/unrecoverable image error -- the
    // worker's own retry path (attempt_count > 0) simply omits hookText on the next try,
    // which falls back to the standard no-text prompt plus the HTML-overlay post-process.
    const error = new Error('IMAGE_HOOK_TEXT_MISMATCH'); error.status = 502;
    error.detectedText = lastHookQa.detectedText || '';
    throw error;
  }
  const error = new Error('IMAGE_QA_REJECTED'); error.status = 502; error.qaAttempts = providerAttempts; error.qaViolationCount = Number(lastQa?.violations?.length || 0); error.qaDetectedTextCount = Number(lastQa?.detectedText?.length || 0); error.qaDetectedText = Array.isArray(lastQa?.detectedText) ? lastQa.detectedText.slice(0, 8) : []; error.qaViolations = Array.isArray(lastQa?.violations) ? lastQa.violations.slice(0, 8) : []; error.qaSemanticMismatch = lastQa?.semanticMatch === false; error.qaSemanticReason = String(lastQa?.semanticReason || '').slice(0, 500);
  const qaHint = imageQaRejectionHint(lastQa);
  if (qaHint) error.providerValidationHint = qaHint;
  if (lastGenerated?.provider === 'kie-ai' && /^https:\/\//i.test(String(lastGenerated?.sourceUrl || ''))) { error.rejectedImageUrl = String(lastGenerated.sourceUrl); error.rejectedImageMimeType = String(lastGenerated.mimeType || 'image/jpeg'); error.rejectedProvider = 'kie-ai'; error.rejectedModel = String(lastGenerated.model || 'z-image'); error.rejectedTaskId = String(lastGenerated.taskId || ''); }
  throw error;
}
