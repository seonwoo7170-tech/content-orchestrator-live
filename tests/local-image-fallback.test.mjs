import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalFallbackHtml, generateLocalFallbackImage } from '../worker/lib/local-image-fallback.js';

function fakeImageResponse(bytes = new Uint8Array(256).fill(7)) {
  return {
    async create(html, options) {
      return {
        ok: true,
        status: 200,
        headers: { get(name) { return String(name).toLowerCase() === 'content-type' ? 'image/png' : null; } },
        async arrayBuffer() { return bytes.buffer; },
        html,
        options
      };
    }
  };
}

test('local fallback renders a no-text deterministic visual without external AI', async () => {
  const prompt = 'Windows monitor HDMI cable connection troubleshooting';
  const html = buildLocalFallbackHtml(prompt, 'body');
  assert.match(html, /1200px/);
  assert.doesNotMatch(html, /Windows|HDMI|troubleshooting/i);

  const result = await generateLocalFallbackImage(prompt, 'body', { imageResponse: fakeImageResponse() });
  assert.equal(result.provider, 'local-free-renderer');
  assert.equal(result.model, 'deterministic-css-v1');
  assert.equal(result.mimeType, 'image/png');
  assert.ok(result.imageBase64.length > 100);
  assert.equal(result.imageQa.pass, true);
});

test('worker routes images KIE first, Cloudflare second, while local rendering stays explicit-only', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../worker/lib/image-executor.js', import.meta.url), 'utf8'));
  assert.match(source, /if \(mode === 'auto'\) return \['kie', 'cloudflare'\]/);
  assert.match(source, /imageStagePacingMs/);
  assert.match(source, /if \(index > 0 && pacingMs > 0\) await sleep\(pacingMs\)/);
  assert.match(source, /options\.localFallback !== true/);
  assert.match(source, /generateLocalFallbackImage/);
  assert.doesNotMatch(source, /env\?\.KIE_API_KEY/);
});
