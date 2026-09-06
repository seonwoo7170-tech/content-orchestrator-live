import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkersAiDiagnostic, runWorkersAiText, WORKERS_AI_MODELS } from '../api-hub-adapters/cloudflare-workers-ai.js';

test('Workers AI adapter sends secrets only in Authorization and uses approved model', async () => {
  let seenUrl = '';
  let seenInit = null;
  const fetchImpl = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return new Response(JSON.stringify({ success: true, result: { response: 'OK', usage: { input_tokens: 3, output_tokens: 1 } } }), { status: 200 });
  };
  const result = await runWorkersAiText({ CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'token-secret' }, {
    model: WORKERS_AI_MODELS.writer,
    prompt: 'Reply only with OK',
    maxTokens: 16
  }, fetchImpl);
  assert.equal(result.response, 'OK');
  assert.match(seenUrl, /accounts\/acct\/ai\/run\/@cf\/openai\/gpt-oss-120b$/);
  assert.equal(seenInit.headers.authorization, 'Bearer token-secret');
  assert.equal(seenInit.body.includes('token-secret'), false);
});

test('Workers AI adapter refuses arbitrary model ids', async () => {
  await assert.rejects(() => runWorkersAiText({ CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'token' }, {
    model: '@cf/untrusted/model', prompt: 'x'
  }, async () => new Response('{}')), /WORKERS_AI_MODEL_NOT_ALLOWED/);
});

test('diagnostic requires exact OK response', async () => {
  const okFetch = async () => new Response(JSON.stringify({ success: true, result: { response: 'OK' } }), { status: 200 });
  const result = await runWorkersAiDiagnostic({ CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'token' }, okFetch);
  assert.equal(result.ok, true);
});
