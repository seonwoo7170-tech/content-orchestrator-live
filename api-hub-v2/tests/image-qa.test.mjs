import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage } from '../src/lib/image-routes.js';

function aiMock(handler) {
  return { async run(model, body) { return handler(model, body); } };
}

function geminiResponse(payload) {
  return new Response(JSON.stringify({
    candidates: [{
      content: { parts: [{ text: JSON.stringify(payload) }] },
      finishReason: 'STOP'
    }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('required image QA retries a rejected source with a simpler scene and returns only the passing image', async () => {
  let generatedCount = 0;
  let qaCount = 0;
  const seenBodies = [];
  const generatedPrompts = [];

  const result = await generateImage(
    {
      GEMINI_API_KEY: 'gemini-test-key',
      GEMINI_IMAGE_QA_MODEL: 'gemini-3.1-flash-lite',
      IMAGE_QA_REQUIRED: 'true',
      IMAGE_QA_MAX_ATTEMPTS: '3'
    },
    { role: 'thumbnail', prompt: 'photorealistic main water shutoff in a utility room', seed: 7 },
    aiMock(async (_model, body) => {
      generatedCount += 1;
      generatedPrompts.push(String(body.prompt || ''));
      return { image: generatedCount === 1 ? 'Zmlyc3QtaW1hZ2U=' : 'c2Vjb25kLWltYWdl' };
    }),
    async (_url, init) => {
      qaCount += 1;
      const body = JSON.parse(init.body);
      seenBodies.push(body);
      if (qaCount === 1) {
        return geminiResponse({ pass: false, detectedText: ['MAIN WATER'], violations: ['readable writing'], semanticMatch: true, semanticReason: 'The shutoff valve is visible and central.' });
      }
      return geminiResponse({ pass: true, detectedText: [], violations: [], semanticMatch: true, semanticReason: 'The shutoff valve is clearly visible and central.' });
    }
  );

  assert.equal(generatedCount, 2);
  assert.equal(qaCount, 2);
  assert.equal(result.imageBase64, 'c2Vjb25kLWltYWdl');
  assert.deepEqual(result.imageQa, {
    enabled: true,
    pass: true,
    attempts: 2,
    inspectionAttempts: 1,
    semanticMatch: true,
    model: 'gemini-3.1-flash-lite'
  });
  assert.equal(seenBodies[0].contents[0].parts[0].inlineData.data, 'Zmlyc3QtaW1hZ2U=');
  assert.equal(seenBodies[1].contents[0].parts[0].inlineData.data, 'c2Vjb25kLWltYWdl');
  assert.match(JSON.stringify(seenBodies[0]), /Expected visual subject\/task/i);
  assert.match(generatedPrompts[0], /main water shutoff/i);
  assert.doesNotMatch(generatedPrompts[0], /Simplify the composition/i);
  assert.match(generatedPrompts[1], /Simplify the composition to a closer view/i);
  assert.notEqual(generatedPrompts[0], generatedPrompts[1]);
});

test('required image QA rejects a clean but semantically unrelated image', async () => {
  await assert.rejects(
    () => generateImage(
      {
        GEMINI_API_KEY: 'gemini-test-key',
        IMAGE_QA_REQUIRED: 'true',
        IMAGE_QA_MAX_ATTEMPTS: '1'
      },
      { role: 'body', prompt: 'threshold repair at a household floor transition' },
      aiMock(async () => ({ image: 'cG9ydHJhaXQtaW1hZ2U=' })),
      async () => geminiResponse({
        pass: false,
        detectedText: [],
        violations: [],
        semanticMatch: false,
        semanticReason: 'The image is a posed portrait and no threshold, floor transition, or repair action is visible.'
      })
    ),
    (error) => {
      assert.equal(error.message, 'IMAGE_QA_REJECTED');
      assert.equal(error.qaSemanticMismatch, true);
      assert.match(error.qaSemanticReason, /no threshold/i);
      assert.equal(error.qaDetectedTextCount, 0);
      assert.equal(error.qaViolationCount, 0);
      return true;
    }
  );
});

test('required image QA fails closed when Gemini is not configured', async () => {
  await assert.rejects(
    () => generateImage(
      { IMAGE_QA_REQUIRED: 'true' },
      { role: 'body', prompt: 'photorealistic shower fixture' },
      aiMock(async () => ({ image: 'ZmFrZS1pbWFnZQ==' }))
    ),
    (error) => error.message === 'IMAGE_QA_GEMINI_REQUIRED' && error.status === 503
  );
});

test('required image QA fails closed after the configured retry limit', async () => {
  let generatedCount = 0;
  const generatedPrompts = [];
  await assert.rejects(
    () => generateImage(
      {
        GEMINI_API_KEY: 'gemini-test-key',
        IMAGE_QA_REQUIRED: 'true',
        IMAGE_QA_MAX_ATTEMPTS: '2'
      },
      { role: 'body', prompt: 'photorealistic plumbing repair scene', seed: 11 },
      aiMock(async (_model, body) => {
        generatedCount += 1;
        generatedPrompts.push(String(body.prompt || ''));
        return { image: `ZmFrZS0taW1hZ2Ut${generatedCount}` };
      }),
      async () => geminiResponse({ pass: false, detectedText: ['123'], violations: ['visible number'], semanticMatch: true, semanticReason: 'The plumbing repair scene matches.' })
    ),
    (error) => {
      assert.equal(error.message, 'IMAGE_QA_REJECTED');
      assert.equal(error.status, 502);
      assert.equal(error.qaAttempts, 2);
      assert.equal(error.qaViolationCount, 1);
      assert.equal(error.qaDetectedTextCount, 1);
      assert.equal(error.qaSemanticMismatch, false);
      return true;
    }
  );
  assert.equal(generatedCount, 2);
  assert.match(generatedPrompts[1], /Simplify the composition to a closer view/i);
});
