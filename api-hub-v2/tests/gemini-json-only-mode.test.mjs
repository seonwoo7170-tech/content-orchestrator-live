import test from 'node:test';
import assert from 'node:assert/strict';
import { runGeminiAi } from '../src/lib/gemini-ai.js';

test('Gemini uses application/json when role contract says Return JSON only', async () => {
  let sent;
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"article":{"title":"x"}}' }] } }],
      usageMetadata: { totalTokenCount: 1 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await runGeminiAi({ GEMINI_API_KEY: 'test-key' }, {
    model: 'gemini-3.5-flash-lite',
    systemInstruction: 'You are a targeted repair editor. Return JSON only.',
    userContent: '{"article":{}}',
    maxOutputTokens: 1024,
    thinking: 'minimal'
  }, fetchImpl);
  assert.equal(sent.generationConfig.responseMimeType, 'application/json');
  assert.equal('responseSchema' in sent.generationConfig, false);
});
