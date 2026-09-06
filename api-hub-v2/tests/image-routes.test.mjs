import test from 'node:test';
import assert from 'node:assert/strict';
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
const KIE_NO_TEXT_TAIL = /No visible text, logos, branding, or watermark\./i;

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
  assert.match(body.input.prompt, /homeowner inspecting a household fixture with simple hand tools/);
  assert.match(body.input.prompt, /Simple uncluttered composition/);
  assert.match(body.input.prompt, KIE_NO_TEXT_TAIL);
  assert.doesNotMatch(body.input.prompt, KIE_RISKY_SCENE_WORDS);
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
  assert.match(body.input.prompt, KIE_NO_TEXT_TAIL);
  assert.doesNotMatch(body.input.prompt, KIE_RISKY_SCENE_WORDS);
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
  assert.match(body.input.prompt, KIE_NO_TEXT_TAIL);
  assert.doesNotMatch(body.input.prompt, KIE_RISKY_SCENE_WORDS);
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
