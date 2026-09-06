import test from 'node:test';
import assert from 'node:assert/strict';
import {
  THUMBNAIL_OUTPUT_MIME,
  buildThumbnailHtml,
  deriveThumbnailHook,
  postprocessThumbnail,
  renderThumbnailPng,
  splitThumbnailHook
} from '../worker/lib/thumbnail-postprocess.js';

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';

class FakeFont {
  constructor(name, options) {
    this.name = name;
    this.options = options;
    this.data = Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer);
  }
}

function fakePngBytes() {
  const bytes = new Uint8Array(160);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

const fakeImageResponse = {
  async create(html, options) {
    assert.match(html, /font-family:'Thumbnail Sans'/);
    assert.equal(options.width, 1200);
    assert.equal(options.height, 675);
    assert.equal(options.format, 'png');
    assert.equal(options.fonts[0].name, 'Thumbnail Sans');
    return new Response(fakePngBytes(), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    });
  }
};

test('thumbnail overlay uses dedicated hook copy only', () => {
  const hook = deriveThumbnailHook({
    hook_text: '이것부터 확인',
    alt_text: '2026년 초보자를 위한 PC 블루스크린 해결 방법 대표 이미지',
    prompt: 'Photorealistic real-world photograph focused on a computer problem.'
  });
  assert.equal(hook, '이것부터 확인');
});

test('thumbnail hook never falls back to article title from alt text or prompt', () => {
  assert.equal(deriveThumbnailHook({
    alt_text: 'How to Prioritize Home Repairs When Money Is Tight featured image',
    prompt: 'Wide image for "How to Prioritize Home Repairs When Money Is Tight"'
  }), '');
});

test('thumbnail hook splits into no more than two display lines', () => {
  const lines = splitThumbnailHook('노트북 배터리 수명 오래 쓰는 핵심 설정');
  assert.ok(lines.length >= 1);
  assert.ok(lines.length <= 2);
  assert.ok(lines.every((line) => line.length > 0));
});

test('thumbnail HTML embeds source raster and escaped hook text across up to two lines', () => {
  const html = buildThumbnailHtml({
    imageBase64: tinyPngBase64,
    sourceMimeType: 'image/png',
    hookText: 'PC & 오류 <해결>'
  });
  assert.match(html, /width:1200px/);
  assert.match(html, /height:675px/);
  assert.match(html, /data:image\/png;base64,/);
  assert.match(html, /PC &amp; 오류/);
  assert.match(html, /&lt;해결&gt;/);
  assert.equal((html.match(/line-height:1\.08/g) || []).length, 2);
});

test('PNG renderer returns image/png with the generated raster embedded in its HTML input', async () => {
  const rendered = await renderThumbnailPng({
    imageBase64: tinyPngBase64,
    sourceMimeType: 'image/png',
    hookText: 'PC 오류 해결',
    imageResponse: fakeImageResponse,
    fontClass: FakeFont
  });
  assert.equal(rendered.mimeType, THUMBNAIL_OUTPUT_MIME);
  assert.equal(rendered.bytes.byteLength, 160);
  assert.equal(Buffer.from(rendered.bytes.slice(0, 8)).toString('hex'), '89504e470d0a1a0a');
  assert.match(rendered.html, new RegExp(tinyPngBase64.slice(0, 30)));
});

test('thumbnail postprocess renders the stored hook instead of the title', async () => {
  const result = await postprocessThumbnail(
    { hook_text: '큰돈 들기 전에 먼저', alt_text: '긴 글 제목 featured image' },
    { imageBase64: tinyPngBase64, mimeType: 'image/png' },
    { imageResponse: fakeImageResponse, fontClass: FakeFont }
  );
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.hookText, '큰돈 들기 전에 먼저');
  assert.equal(Buffer.from(result.bytes.slice(0, 8)).toString('hex'), '89504e470d0a1a0a');
});

test('thumbnail postprocess refuses title fallback when hook copy is missing', async () => {
  await assert.rejects(
    () => postprocessThumbnail(
      { alt_text: 'Full Article Title featured image' },
      { imageBase64: tinyPngBase64, mimeType: 'image/png' },
      { imageResponse: fakeImageResponse, fontClass: FakeFont }
    ),
    /THUMBNAIL_HOOK_REQUIRED/
  );
});

test('thumbnail renderer rejects unsupported source image MIME', async () => {
  await assert.rejects(
    () => renderThumbnailPng({
      imageBase64: tinyPngBase64,
      sourceMimeType: 'image/svg+xml',
      hookText: '테스트',
      imageResponse: fakeImageResponse,
      fontClass: FakeFont
    }),
    /THUMBNAIL_SOURCE_MIME_UNSUPPORTED/
  );
});
