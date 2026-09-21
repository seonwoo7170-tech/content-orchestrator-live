import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateImage } from '../src/lib/image-routes.js';

function aiMock(handler) {
  return { async run(model, body) { return handler(model, body); } };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; }
  };
}

function imageResponse(bytes = Buffer.from('fake-image-bytes')) {
  return {
    ok: true,
    status: 200,
    headers: { get(name) { return String(name).toLowerCase() === 'content-type' ? 'image/png' : null; } },
    async arrayBuffer() { return Uint8Array.from(bytes).buffer; }
  };
}

function kieFetchMock(calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/api/v1/jobs/createTask')) {
      return jsonResponse({ code: 200, msg: 'success', data: { taskId: 'task_z-image_test' } });
    }
    if (String(url).includes('/api/v1/jobs/recordInfo?taskId=')) {
      return jsonResponse({
        code: 200,
        msg: 'success',
        data: {
          state: 'success',
          resultJson: JSON.stringify({ resultUrls: ['https://cdn.example.test/result.png'] })
        }
      });
    }
    if (String(url) === 'https://cdn.example.test/result.png') return imageResponse();
    throw new Error(`unexpected fetch: ${url}`);
  };
}

const GLYPH_SEEDING_WORDS = /\b(?:text|letters|numbers|labels|captions|watermarks|signage|poster|document|infographic)\b/i;
const KIE_RISKY_SCENE_WORDS = /\b(?:devices?|screens?|displays?|monitors?|interfaces?|gauges?|meters?)\b|control panels?|ai assistants?/i;

test('image generation uses FLUX schnell with a positive-only plain-surface guard', async () => {
  let seen = null;
  const result = await generateImage(
    {},
    { role: 'thumbnail', prompt: 'A tidy smartphone storage management scene', steps: 4, seed: 7 },
    aiMock(async (model, body) => {
      seen = { model, body };
      return { image: 'ZmFrZS1qcGVn' };
    })
  );

  assert.equal(seen.model, '@cf/black-forest-labs/flux-1-schnell');
  assert.match(seen.body.prompt, /broad uniform surfaces/);
  assert.match(seen.body.prompt, /simple geometry/);
  assert.match(seen.body.prompt, /minimal decorative detail/);
  assert.doesNotMatch(seen.body.prompt, GLYPH_SEEDING_WORDS);
  assert.equal(seen.body.steps, 4);
  assert.equal(seen.body.seed, 7);
  assert.equal(result.role, 'thumbnail');
  assert.equal(result.provider, 'cloudflare-workers-ai');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.imageBase64, 'ZmFrZS1qcGVn');
  assert.equal(result.providerMode, 'auto');
});

test('omitted optional FLUX parameters are not synthesized into the provider request', async () => {
  let seenBody = null;
  await generateImage(
    {},
    { role: 'body', prompt: 'A clean household repair scene' },
    aiMock(async (_model, body) => {
      seenBody = body;
      return { image: 'ZmFrZQ==' };
    })
  );

  assert.deepEqual(Object.keys(seenBody).sort(), ['prompt']);
  assert.equal('steps' in seenBody, false);
  assert.equal('seed' in seenBody, false);
});

test('legacy batch guardrail lines are stripped before provider use', async () => {
  let seenPrompt = '';
  await generateImage(
    {},
    {
      role: 'body',
      prompt: [
        'Photorealistic editorial photo of a residential shutoff valve.',
        'STRICT VISUAL RULE: Create a photorealistic editorial home-maintenance image with absolutely no readable or written text anywhere.',
        'No letters, words, numbers, labels, logos, watermarks, signs, UI, packaging text, printed instructions, numbered gauges, captions, symbols, or text-like glyphs.',
        'Avoid products or screens that normally display text; if a screen is present it must be blank, dark, turned away, or abstract with no interface.',
        'Show only the practical physical scene, tools, fixtures, hands, materials, room surfaces, or household context relevant to the article.',
        'Attempt 2: keep every visible surface free of text-like marks.'
      ].join('\n')
    },
    aiMock(async (_model, body) => {
      seenPrompt = body.prompt;
      return { image: 'ZmFrZQ==' };
    })
  );
  assert.match(seenPrompt, /residential shutoff valve/);
  assert.doesNotMatch(seenPrompt, /STRICT VISUAL RULE|No letters, words, numbers|Attempt 2/);
  assert.match(seenPrompt, /broad uniform surfaces/);
  assert.doesNotMatch(seenPrompt, GLYPH_SEEDING_WORDS);
});

test('image generation rejects unsupported models before provider use', async () => {
  let called = false;
  await assert.rejects(
    () => generateImage(
      { IMAGE_MODEL: '@cf/not-allowed/model' },
      { role: 'body', prompt: 'safe image' },
      aiMock(async () => { called = true; return { image: 'unused' }; })
    ),
    /IMAGE_MODEL_NOT_ALLOWED/
  );
  assert.equal(called, false);
});

test('image generation rejects invalid role, provider mode and oversized prompts', async () => {
  const ai = aiMock(async () => ({ image: 'unused' }));
  await assert.rejects(() => generateImage({}, { role: 'cover', prompt: 'x' }, ai), /IMAGE_ROLE_INVALID/);
  await assert.rejects(() => generateImage({}, { role: 'body', prompt: 'x'.repeat(1901) }, ai), /IMAGE_PROMPT_TOO_LONG/);
  await assert.rejects(() => generateImage({}, { role: 'body', prompt: 'safe', providerMode: 'other' }, ai), /IMAGE_PROVIDER_MODE_INVALID/);
});

test('image generation fails closed on empty provider output when KIE is not configured', async () => {
  await assert.rejects(
    () => generateImage({}, { role: 'body', prompt: 'safe image' }, aiMock(async () => ({ image: '' }))),
    /IMAGE_EMPTY_RESPONSE/
  );
});

test('image generation preserves safe Workers AI account-limit classification without KIE', async () => {
  const cause = Object.assign(new Error('Daily free allocation exceeded (3036): provider details must stay hidden'), { code: 3036 });
  await assert.rejects(
    async () => generateImage({}, { role: 'body', prompt: 'safe image' }, aiMock(async () => { throw cause; })),
    (error) => {
      assert.equal(error.message, 'CLOUDFLARE_AI_ACCOUNT_LIMITED');
      assert.equal(error.status, 429);
      assert.doesNotMatch(error.message, /provider details/i);
      return true;
    }
  );
});

test('image generation redacts unknown Workers AI provider failures without KIE', async () => {
  const cause = new Error('secret upstream payload that must not escape');
  await assert.rejects(
    async () => generateImage({}, { role: 'body', prompt: 'safe image' }, aiMock(async () => { throw cause; })),
    (error) => {
      assert.equal(error.message, 'CLOUDFLARE_AI_BINDING_FAILED');
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /secret upstream/i);
      return true;
    }
  );
});

test('forced KIE mode converts risky digital HomeFix concepts into a short physical scene', async () => {
  const calls = [];
  const fetchImpl = kieFetchMock(calls);
  let aiCalled = false;
  const riskyPrompt = 'Photorealistic real-world photograph focused on ai assistants for home maintenance. Depict the subject through tangible people, objects, tools, devices, materials, and surroundings appropriate to the topic. One clear focal subject, natural lighting, realistic materials, uncluttered composition, plain unmarked surfaces, unbranded objects, and blank featureless screens and control panels when present.';
  const input = { role: 'thumbnail', prompt: riskyPrompt, providerMode: 'kie', aspectRatio: '16:9' };
  const pending = await generateImage(
    { KIE_API_KEY: 'test-secret' },
    input,
    aiMock(async () => { aiCalled = true; return { image: 'unused' }; }),
    fetchImpl
  );
  assert.equal(aiCalled, false);
  assert.equal(pending.provider, 'kie-ai');
  assert.equal(pending.model, 'z-image');
  assert.equal(pending.pending, true);
  assert.equal(pending.taskId, 'task_z-image_test');
  assert.equal(calls.filter((call) => call.url.endsWith('/api/v1/jobs/createTask')).length, 1);
  assert.equal(calls.some((call) => call.url.includes('/recordInfo?taskId=')), false);

  const result = await generateImage(
    { KIE_API_KEY: 'test-secret' },
    { ...input, taskId: pending.taskId },
    aiMock(async () => { aiCalled = true; return { image: 'unused' }; }),
    fetchImpl
  );
  assert.equal(aiCalled, false);
  assert.equal(result.provider, 'kie-ai');
  assert.equal(result.model, 'z-image');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(Buffer.from(result.imageBase64, 'base64').toString(), 'fake-image-bytes');
  assert.equal(calls.filter((call) => call.url.endsWith('/api/v1/jobs/createTask')).length, 1);
  const create = calls.find((call) => call.url.endsWith('/api/v1/jobs/createTask'));
  const body = JSON.parse(create.init.body);
  assert.equal(body.model, 'z-image');
  assert.equal(body.input.aspect_ratio, '16:9');
  assert.match(body.input.prompt, /household fixture with simple repair tools resting beside it/);
  assert.match(body.input.prompt, /Simple uncluttered composition/);
  assert.doesNotMatch(body.input.prompt.split('Preserve the exact subject')[0], KIE_RISKY_SCENE_WORDS);
  assert.doesNotMatch(body.input.prompt, /broad uniform surfaces|simple geometry|minimal decorative detail/i);
  assert.equal(create.init.headers.authorization, 'Bearer test-secret');
});

test('auto mode fallback resumes one KIE task after Workers AI account limit', async () => {
  const calls = [];
  const fetchImpl = kieFetchMock(calls);
  const cause = Object.assign(new Error('allocation 3036'), { code: 3036 });
  const riskyPrompt = 'Photorealistic real-world photograph focused on low shower water pressure. Depict the subject through tangible people, objects, tools, devices, materials, and surroundings appropriate to the topic. Natural lighting, realistic materials, one clear focal subject, clean composition, plain unmarked surfaces, unbranded objects, and blank featureless screens and control panels when present.';
  const input = { role: 'body', prompt: riskyPrompt };
  const pending = await generateImage(
    { KIE_API_KEY: 'test-secret' },
    input,
    aiMock(async () => { throw cause; }),
    fetchImpl
  );
  assert.equal(pending.provider, 'kie-ai');
  assert.equal(pending.model, 'z-image');
  assert.equal(pending.pending, true);
  assert.equal(pending.taskId, 'task_z-image_test');
  assert.equal(pending.fallbackFrom, 'cloudflare-workers-ai');
  assert.equal(pending.fallbackReason, 'CLOUDFLARE_AI_ACCOUNT_LIMITED');
  assert.equal(calls.filter((call) => call.url.endsWith('/api/v1/jobs/createTask')).length, 1);

  const result = await generateImage(
    { KIE_API_KEY: 'test-secret' },
    { ...input, taskId: pending.taskId },
    aiMock(async () => { throw cause; }),
    fetchImpl
  );
  assert.equal(result.provider, 'kie-ai');
  assert.equal(result.model, 'z-image');
  assert.equal(result.fallbackFrom, 'cloudflare-workers-ai');
  assert.equal(result.fallbackReason, 'CLOUDFLARE_AI_ACCOUNT_LIMITED');
  assert.equal(calls.filter((call) => call.url.endsWith('/api/v1/jobs/createTask')).length, 1);
  const create = calls.find((call) => call.url.endsWith('/api/v1/jobs/createTask'));
  const body = JSON.parse(create.init.body);
  assert.match(body.input.prompt, /residential chrome showerhead with a steady stream of water/);
  assert.doesNotMatch(body.input.prompt.split('Preserve the exact subject')[0], KIE_RISKY_SCENE_WORDS);
  assert.doesNotMatch(body.input.prompt, /broad uniform surfaces|simple geometry|minimal decorative detail/i);
  assert.ok(calls.some((call) => call.url.includes('/recordInfo?taskId=')));
});

test('forced KIE mode converts main water shutoff into a concise editorial scene', async () => {
  const calls = [];
  const prompt = 'Photorealistic real-world photograph focused on main water shutoff. Depict the subject through tangible people, objects, tools, devices, materials, and surroundings appropriate to the topic.';
  await generateImage(
    { KIE_API_KEY: 'test-secret' },
    { role: 'body', prompt, providerMode: 'kie' },
    aiMock(async () => ({ image: 'unused' })),
    kieFetchMock(calls)
  );
  const create = calls.find((call) => call.url.endsWith('/api/v1/jobs/createTask'));
  const body = JSON.parse(create.init.body);
  assert.match(body.input.prompt, /residential main water shutoff valve connected to exposed household plumbing/);
  assert.doesNotMatch(body.input.prompt.split('Preserve the exact subject')[0], KIE_RISKY_SCENE_WORDS);
});

// KIE is the only provider left in the scheduled pipeline (see scheduledProviderModeForImage
// in the worker), so every blog's images pass through prepareKiePrompt, not just the
// home-repair blog the shower/water-valve/AI-assistant branches above were written for. A
// topic that doesn't match any of those must keep its own subject and neutral surroundings,
// not get forced into a residential repair scene it has nothing to do with -- that mismatch
// is exactly what made the Gemini QA gate reject so many non-home blogs' images as a
// semantic mismatch.
test('forced KIE mode never forces an unrelated topic into a residential repair scene', async () => {
  const calls = [];
  const prompt = 'Photorealistic real-world photograph focused on choosing an ai subscription plan for freelancers. Depict the subject through tangible people, objects, tools, devices, materials, and surroundings appropriate to the topic.';
  await generateImage(
    { KIE_API_KEY: 'test-secret' },
    { role: 'thumbnail', prompt, providerMode: 'kie' },
    aiMock(async () => ({ image: 'unused' })),
    kieFetchMock(calls)
  );
  const create = calls.find((call) => call.url.endsWith('/api/v1/jobs/createTask'));
  const body = JSON.parse(create.init.body);
  assert.match(body.input.prompt, /photograph of choosing an ai subscription plan for freelancers/);
  assert.doesNotMatch(body.input.prompt, /residential|household repair or maintenance/i);
});

// Confirmed via production job #167 ("Choosing an AI Subscription Plan as a Freelancer:
// Financial and Workflow Decision Factors"): mentioning "AI" and "maintenance" in the same
// sentence used to be enough to trigger the home-repair branch above even with no home or
// household context at all, producing a vacuum-cleaning thumbnail and screen-wiping body
// images for a completely unrelated financial-decision article.
test('forced KIE mode does not force an AI-subscription topic into a residential scene just because it mentions "maintenance"', async () => {
  const calls = [];
  const prompt = 'Photorealistic real-world photograph focused on a freelancer weighing AI subscription tiers against long-term maintenance and budget planning. Depict the subject through tangible people, objects, tools, devices, materials, and surroundings appropriate to the topic.';
  await generateImage(
    { KIE_API_KEY: 'test-secret' },
    { role: 'thumbnail', prompt, providerMode: 'kie' },
    aiMock(async () => ({ image: 'unused' })),
    kieFetchMock(calls)
  );
  const create = calls.find((call) => call.url.endsWith('/api/v1/jobs/createTask'));
  const body = JSON.parse(create.init.body);
  assert.doesNotMatch(body.input.prompt, /residential|household repair or maintenance|homeowner inspecting/i);
});

// Confirmed across a wide sample of production SEMANTIC_MISMATCH rejections (jobs #161
// power-supply sizing, #162 Wi-Fi router speed, #165 network adapter packet loss, #166 RAM
// usage/task manager, #171 circuit breaker trips): for a diagnostic/settings topic with no
// obvious hands-on physical action, the model's most common fallback interpretation was a
// person wiping/dusting/cleaning a screen with a cloth -- completely unrelated to the topic.
// A negation ("do not depict wiping/dusting/cleaning") was tried first and did not hold up in
// production (confirmed again on an unrelated Smile Atlas travel blog on 2026-09-20): z-image
// is a distilled/turbo model with no classifier-free guidance, so naming the cliche at all --
// negated or not -- keeps biasing generations toward it. The prompt must never name it and
// instead point at concrete positive actions instead.
test('the generic KIE prompt fallback describes the object itself and names no person or hand', async () => {
  const calls = [];
  const prompt = 'Photorealistic real-world photograph focused on 램 RAM 용량 부족 현상 원인과 작업관리자 메모리 점유율 분석 방법. Depict the subject through tangible people, objects, tools, devices, materials, and surroundings appropriate to the topic.';
  await generateImage(
    { KIE_API_KEY: 'test-secret' },
    { role: 'body', prompt, providerMode: 'kie' },
    aiMock(async () => ({ image: 'unused' })),
    kieFetchMock(calls)
  );
  const create = calls.find((call) => call.url.endsWith('/api/v1/jobs/createTask'));
  const body = JSON.parse(create.init.body);
  assert.match(body.input.prompt, /램 RAM 용량 부족 현상 원인과 작업관리자 메모리 점유율 분석 방법/);
  assert.match(body.input.prompt, /as the only subject, filling most of the frame in its real everyday location/i);
  assert.doesNotMatch(body.input.prompt, /wip(e|ing)|dust(ing)?|cloth/i);
  assert.doesNotMatch(body.input.prompt, /\bhands?\b|\bperson\b|\bpeople\b|\bhomeowner\b|\bsomeone\b|\bfingers?\b|\barms?\b/i);
});

// The old carve-out ("unless the topic is specifically about physically cleaning that device")
// existed only because the negation above named the cliche in the first place. Now that the
// prompt never names wiping/dusting/cleaning at all, there is nothing for a scoped carve-out to
// guard, and bodyScene() folding the whole article's topic into every section's subject phrase
// (confirmed on job #204, a GPU-temperature article) can no longer resurrect it either.
test('the still-life phrasing applies the same way whether or not a broader topic is present', async () => {
  const calls = [];
  const prompt = 'Photorealistic real-world photograph focused on 팬 속도 설정 within the broader context of 그래픽카드 온도 정상 범위와 낮추는 방법.';
  await generateImage(
    { KIE_API_KEY: 'test-secret' },
    { role: 'body', prompt, providerMode: 'kie' },
    aiMock(async () => ({ image: 'unused' })),
    kieFetchMock(calls)
  );
  const create = calls.find((call) => call.url.endsWith('/api/v1/jobs/createTask'));
  const body = JSON.parse(create.init.body);
  assert.match(body.input.prompt, /as the only subject, filling most of the frame in its real everyday location/i);
  assert.doesNotMatch(body.input.prompt, /wip(e|ing)|dust(ing)?|cloth/i);
  assert.doesNotMatch(body.input.prompt, /\bhands?\b|\bperson\b|\bpeople\b|\bhomeowner\b|\bsomeone\b|\bfingers?\b|\barms?\b/i);
});

// The wiping cliche came back on 2026-09-21 in a new form: the positive-action wording that
// replaced the old negation ("a hand holding, pointing to, comparing, arranging, or closely
// inspecting the actual object") named a hand outright, so every body image had one, and a hand
// beside a household object drifts straight back into the wiping pose -- one article's three body
// images were a hand with a sponge, a hand with a cloth, and a hand with a brush. z-image has no
// negative conditioning, so any human noun in the prompt is a guarantee, not a suggestion. No
// prompt this function can produce, on any branch or retry attempt, may name one.
test('no branch or retry attempt of the KIE prompt can put a person or a hand in the frame', async () => {
  const human = /\bhands?\b|\bperson\b|\bpeople\b|\bhomeowner\b|\bsomeone\b|\bfingers?\b|\barms?\b|\bforearms?\b/i;
  const subjects = [
    // The generic fallback, which is what almost every article goes through.
    'Photorealistic real-world photograph focused on 음식물 쓰레기통 냄새 제거와 관리 방법.',
    // The AI-in-the-home branch, which used to depict a homeowner with hand tools.
    'Photorealistic real-world photograph focused on artificial intelligence assistants for the home.',
    // The two hard-coded plumbing branches.
    'Photorealistic real-world photograph focused on shower water pressure problems.',
    'Photorealistic real-world photograph focused on the main water shutoff valve.'
  ];
  for (const prompt of subjects) {
    const calls = [];
    await generateImage(
      { KIE_API_KEY: 'test-secret' },
      { role: 'body', prompt, providerMode: 'kie' },
      aiMock(async () => ({ image: 'unused' })),
      kieFetchMock(calls)
    );
    const body = JSON.parse(calls.find((call) => call.url.endsWith('/api/v1/jobs/createTask')).init.body);
    assert.doesNotMatch(body.input.prompt, human, `prompt for "${prompt}" named a person`);
  }
});

test('the QA retry hints never reintroduce hands either', async () => {
  const source = await readFile(new URL('../src/lib/image-routes.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('function promptForAttempt'), source.indexOf('async function generateCloudflareImage'));
  assert.doesNotMatch(fn, /\bhands?\b|\bhand tools\b/i);
});

// This tail rides on every KIE prompt, so whatever it names is in every image. Emptying it was
// tried and failed -- body images never receive hookText, so a numeric topic like GPU
// temperature came back with an invented garbled readout (job #204). Negating the failure
// failed differently and worse: naming "digits, dials, readouts, labels, lettering, caption"
// in one sentence seeded exactly those glyphs, and published thumbnails carried banners of
// fake Hangul ("2026 그래퍽카도 교해 주기기 간간가") on 2026-09-21. z-image has no negative
// conditioning, so the tail must describe the surfaces positively and name no glyph noun.
test('the tail that rides on every image prompt names no glyph noun at all', async () => {
  const calls = [];
  const prompt = 'Photorealistic real-world photograph focused on 그래픽카드 정상 온도 범위.';
  await generateImage(
    { KIE_API_KEY: 'test-secret' },
    { role: 'body', prompt, providerMode: 'kie' },
    aiMock(async () => ({ image: 'unused' })),
    kieFetchMock(calls)
  );
  const create = calls.find((call) => call.url.endsWith('/api/v1/jobs/createTask'));
  const body = JSON.parse(create.init.body);
  assert.match(body.input.prompt, /Every surface in the frame shows only its own bare material texture/i);
  // The prompt as a whole must not hand the generator a glyph to draw. gpt4o hook thumbnails
  // are the one exception and take a different tail (gpt4oHookRenderTail), never this one.
  assert.doesNotMatch(body.input.prompt, /\blettering\b|\bcaptions?\b|\breadouts?\b|\bdigits?\b|\bdials?\b|\blabels?\b|\bletters?\b|\bwatermarks?\b|\bsignage\b|\btext\b/i);
});

// The same tail is on thumbnails that are not baking a hook, which is where the garbled Hangul
// banners were actually seen.
test('a thumbnail with a Korean hook gets the plain tail, never a glyph noun', async () => {
  const calls = [];
  await generateImage(
    { KIE_API_KEY: 'test-secret' },
    { role: 'thumbnail', prompt: 'Photorealistic real-world photograph focused on 그래픽카드 교체 주기.', hookText: '핵심부터 확인', providerMode: 'kie' },
    aiMock(async () => ({ image: 'unused' })),
    kieFetchMock(calls)
  );
  const body = JSON.parse(calls.find((call) => call.url.endsWith('/api/v1/jobs/createTask')).init.body);
  assert.doesNotMatch(body.input.prompt, /\blettering\b|\bcaptions?\b|\breadouts?\b|\bdigits?\b|\bdials?\b|\blabels?\b|\bletters?\b|\bwatermarks?\b|\btext\b/i);
  // A Korean hook is never renderable by the model, so it must not reach the prompt either.
  assert.doesNotMatch(body.input.prompt, /핵심부터 확인/);
});

test('forced KIE mode still recognizes a genuine home-repair AI-assistant topic when "home" is explicitly mentioned', async () => {
  const calls = [];
  const prompt = 'Photorealistic real-world photograph focused on ai assistants for home maintenance. Depict the subject through tangible people, objects, tools, devices, materials, and surroundings appropriate to the topic.';
  await generateImage(
    { KIE_API_KEY: 'test-secret' },
    { role: 'body', prompt, providerMode: 'kie' },
    aiMock(async () => ({ image: 'unused' })),
    kieFetchMock(calls)
  );
  const create = calls.find((call) => call.url.endsWith('/api/v1/jobs/createTask'));
  const body = JSON.parse(create.init.body);
  assert.match(body.input.prompt, /household fixture with simple repair tools resting beside it/);
});

test('forced KIE mode falls back to a neutral generic subject only when the concept could not be extracted at all', async () => {
  const calls = [];
  await generateImage(
    { KIE_API_KEY: 'test-secret' },
    { role: 'body', prompt: 'no extractable subject marker here', providerMode: 'kie' },
    aiMock(async () => ({ image: 'unused' })),
    kieFetchMock(calls)
  );
  const create = calls.find((call) => call.url.endsWith('/api/v1/jobs/createTask'));
  const body = JSON.parse(create.init.body);
  assert.match(body.input.prompt, /photograph of a practical everyday subject/);
  assert.doesNotMatch(body.input.prompt, /residential|household repair or maintenance/i);
});

for (const sample of [
  { http: 401, code: 401, expected: 'KIE_AUTH_FAILED', status: 401 },
  { http: 402, code: 402, expected: 'KIE_INSUFFICIENT_CREDITS', status: 402 },
  { http: 422, code: 422, expected: 'KIE_VALIDATION_FAILED', status: 422 },
  { http: 429, code: 429, expected: 'KIE_RATE_LIMITED', status: 429 },
  { http: 500, code: 500, expected: 'KIE_PROVIDER_ERROR', status: 502 }
]) {
  test(`KIE createTask ${sample.http} is safely classified as ${sample.expected}`, async () => {
    const fetchImpl = async () => jsonResponse({ code: sample.code, msg: 'provider detail must not escape' }, sample.http);
    await assert.rejects(
      () => generateImage(
        { KIE_API_KEY: 'test-secret' },
        { role: 'thumbnail', prompt: 'clean residential repair scene', providerMode: 'kie', aspectRatio: '16:9' },
        aiMock(async () => ({ image: 'unused' })),
        fetchImpl
      ),
      (error) => {
        assert.equal(error.message, sample.expected);
        assert.equal(error.status, sample.status);
        assert.equal(error.providerHttpStatus, sample.http);
        assert.equal(error.providerCode, sample.code);
        assert.doesNotMatch(error.message, /provider detail/i);
        return true;
      }
    );
  });
}

test('a KIE validation failure keeps its own reason as a sanitized, capped hint instead of discarding it', async () => {
  const fetchImpl = async () => jsonResponse({ code: 422, msg: 'aspect_ratio must be one of 1:1, 4:3, 3:4, 16:9, 9:16' }, 422);
  await assert.rejects(
    () => generateImage(
      { KIE_API_KEY: 'test-secret' },
      { role: 'thumbnail', prompt: 'clean residential repair scene', providerMode: 'kie', aspectRatio: '16:9' },
      aiMock(async () => ({ image: 'unused' })),
      fetchImpl
    ),
    (error) => {
      assert.equal(error.message, 'KIE_VALIDATION_FAILED');
      assert.equal(error.providerValidationHint, 'aspect_ratio must be one of 1:1, 4:3, 3:4, 16:9, 9:16');
      return true;
    }
  );
});

test('a KIE validation hint is stripped of characters outside the safe allowlist and length-capped', async () => {
  const fetchImpl = async () => jsonResponse({ code: 400, msg: `bad<script>${'x'.repeat(250)}` }, 400);
  await assert.rejects(
    () => generateImage(
      { KIE_API_KEY: 'test-secret' },
      { role: 'body', prompt: 'clean residential repair scene', providerMode: 'kie', aspectRatio: '4:3' },
      aiMock(async () => ({ image: 'unused' })),
      fetchImpl
    ),
    (error) => {
      assert.doesNotMatch(error.providerValidationHint, /[<>]/);
      assert.ok(error.providerValidationHint.length <= 200);
      return true;
    }
  );
});

test('no validation hint is attached when KIE omits msg or only reports success', async () => {
  for (const msg of ['success', '', undefined]) {
    const fetchImpl = async () => jsonResponse({ code: 422, msg }, 422);
    await assert.rejects(
      () => generateImage(
        { KIE_API_KEY: 'test-secret' },
        { role: 'body', prompt: 'clean residential repair scene', providerMode: 'kie', aspectRatio: '4:3' },
        aiMock(async () => ({ image: 'unused' })),
        fetchImpl
      ),
      (error) => {
        assert.equal(error.providerValidationHint, undefined);
        return true;
      }
    );
  }
});

function geminiQaFetchMock(kieCalls, qaResult) {
  const kie = kieFetchMock(kieCalls);
  return async (url, init = {}) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(qaResult) }] } }] });
    }
    return kie(url, init);
  };
}

// This is the gap the "이미지 재시도" button's fix exposed live: KIE_RETRY_BUDGET_EXHAUSTED
// only ever wraps IMAGE_QA_REJECTED, and until now that code carried no providerValidationHint
// -- an operator (or Claude) reading the job's event log had no way to tell a QA rejection
// (wrong subject, or KIE rendered readable text/a watermark) from any other 502 apart from
// re-deriving it from D1 by hand.
test('an image rejected by the Gemini QA gate carries a sanitized providerValidationHint, not just the bare code', async () => {
  const env = { KIE_API_KEY: 'test-secret', GEMINI_API_KEY: 'test-gemini-key', IMAGE_QA_REQUIRED: 'true' };
  const kieCalls = [];
  const input = { role: 'body', prompt: 'clean residential repair scene', providerMode: 'kie' };

  const semanticFetch = geminiQaFetchMock(kieCalls, {
    pass: false, detectedText: [], violations: [], semanticMatch: false,
    semanticReason: 'Shows an empty office desk, not the requested kitchen sink repair'
  });
  const pending = await generateImage(env, input, aiMock(async () => ({ image: 'unused' })), semanticFetch);
  await assert.rejects(
    () => generateImage(env, { ...input, taskId: pending.taskId }, aiMock(async () => ({ image: 'unused' })), semanticFetch),
    (error) => {
      assert.equal(error.message, 'IMAGE_QA_REJECTED');
      assert.equal(error.status, 502);
      assert.match(error.providerValidationHint, /^SEMANTIC_MISMATCH:Shows an empty office desk, not the requested kitchen sink repair$/);
      return true;
    }
  );

});

// Readable text used to fail this gate unconditionally -- that rule only ever existed to
// stop the gpt4o hook-baking feature from producing garbled Korean headline text, which is
// now prevented at its source (isLatinRenderableHookText). Ordinary text/UI visible in a
// scene must no longer reject the image on its own; only a brand logo, a watermark, or a
// topic mismatch still does.
test('plain readable text with no logo or watermark no longer fails the Gemini QA gate', async () => {
  const env = { KIE_API_KEY: 'test-secret', GEMINI_API_KEY: 'test-gemini-key', IMAGE_QA_REQUIRED: 'true' };
  const kieCalls = [];
  const input = { role: 'body', prompt: 'a hand adjusting a labeled control panel', providerMode: 'kie' };
  const textFetch = geminiQaFetchMock(kieCalls, {
    pass: false, detectedText: ['SETTINGS'], violations: ['readable text visible on the control panel'], semanticMatch: true,
    semanticReason: ''
  });
  const pending = await generateImage(env, input, aiMock(async () => ({ image: 'unused' })), textFetch);
  const result = await generateImage(env, { ...input, taskId: pending.taskId }, aiMock(async () => ({ image: 'unused' })), textFetch);
  assert.equal(result.imageQa.pass, true);
});
