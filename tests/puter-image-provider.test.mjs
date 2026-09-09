import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generatePuterImage,
  puterCheckpointPath,
  puterImageConfigured,
  puterImageModels
} from '../worker/lib/puter-image-provider.js';

const env = {
  PUTER_AUTH_TOKEN: 'test-token',
  PUTER_IMAGE_ENABLED: 'true',
  PUTER_IMAGE_MODELS: 'gemini-3.1-flash-lite-image,gemini-2.5-flash-image'
};
const image = { id: 7, role: 'thumbnail', position: 0 };

function pngBytes() {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
}

test('Puter configuration and model list are explicit and token-gated', () => {
  assert.equal(puterImageConfigured(env), true);
  assert.equal(puterImageConfigured({ PUTER_IMAGE_ENABLED: 'true' }), false);
  assert.deepEqual(puterImageModels(env), ['gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image']);
  assert.equal(puterCheckpointPath(11, image), '~/smileseon-image-11-7.png');
});

test('an existing Puter filesystem checkpoint is reused without a new generation call', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    assert.match(String(url), /\/read\?file=/);
    return new Response(pngBytes(), { status: 200, headers: { 'content-type': 'image/png' } });
  };

  const result = await generatePuterImage(env, 11, image, 'safe home repair photo', { fetchImpl });
  assert.equal(result.provider, 'puter');
  assert.equal(result.recovered, true);
  assert.equal(result.mimeType, 'image/png');
  assert.equal(calls.length, 1);
  assert.equal(calls.some((call) => call.url.includes('/drivers/call')), false);
});

test('new Puter generation uses a deterministic output path and can recover returned image bytes', async () => {
  const calls = [];
  let readCount = 0;
  const dataUri = `data:image/png;base64,${Buffer.from(pngBytes()).toString('base64')}`;
  const fetchImpl = async (url, init = {}) => {
    const text = String(url);
    calls.push({ url: text, method: init.method || 'GET', body: init.body || null });
    if (text.includes('/read?file=')) {
      readCount += 1;
      return new Response('', { status: 404 });
    }
    if (text.endsWith('/drivers/call')) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.interface, 'puter-image-generation');
      assert.equal(body.method, 'generate');
      assert.equal(body.auth_token, 'test-token');
      assert.equal(body.args.model, 'gemini-3.1-flash-lite-image');
      assert.equal(body.args.puter_output_path, '~/smileseon-image-11-7.png');
      assert.deepEqual(body.args.ratio, { w: 16, h: 9 });
      assert.equal(body.args.quality, '1K');
      return Response.json({ success: true, result: dataUri });
    }
    throw new Error(`UNEXPECTED_URL:${text}`);
  };

  const result = await generatePuterImage(env, 11, image, 'safe home repair photo', { fetchImpl });
  assert.equal(result.provider, 'puter');
  assert.equal(result.model, 'gemini-3.1-flash-lite-image');
  assert.equal(result.mimeType, 'image/png');
  assert.ok(result.imageBytes.length > 8);
  assert.equal(calls.filter((call) => call.url.endsWith('/drivers/call')).length, 1);
  assert.equal(readCount, 2);
});

test('unknown Puter write outcome is never blindly generated a second time', async () => {
  let generateCalls = 0;
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.includes('/read?file=')) return new Response('', { status: 404 });
    if (text.endsWith('/drivers/call')) {
      generateCalls += 1;
      throw new TypeError('connection reset after request');
    }
    throw new Error(`UNEXPECTED_URL:${text}`);
  };

  await assert.rejects(
    () => generatePuterImage(env, 11, image, 'safe home repair photo', { fetchImpl }),
    /PUTER_OUTCOME_UNKNOWN/
  );
  assert.equal(generateCalls, 1);
});
