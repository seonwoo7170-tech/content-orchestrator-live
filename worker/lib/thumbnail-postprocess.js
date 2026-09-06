import { GoogleFont, cache } from 'cf-workers-og';
import { ImageResponse } from 'cf-workers-og/html';

export const THUMBNAIL_OUTPUT_MIME = 'image/png';
export const THUMBNAIL_WIDTH = 1200;
export const THUMBNAIL_HEIGHT = 675;

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanText(value) {
  return normalizeWhitespace(String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function codePoints(value) {
  return Array.from(String(value || ''));
}

function clampCodePoints(value, max, cleaner = cleanText) {
  const chars = codePoints(cleaner(value));
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('').trim();
}

function normalizedSourceMimeType(value) {
  const mimeType = String(value || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
    throw new Error('THUMBNAIL_SOURCE_MIME_UNSUPPORTED');
  }
  return mimeType;
}

function normalizedBase64(value) {
  const base64 = String(value || '').trim();
  if (!base64) throw new Error('THUMBNAIL_SOURCE_BASE64_REQUIRED');
  return base64;
}

export function deriveThumbnailHook(image) {
  const hook = cleanText(image?.hook_text || image?.hookText);
  if (!hook) return '';
  const hasKorean = /[가-힣]/.test(hook);
  return clampCodePoints(hook, hasKorean ? 22 : 38);
}

export function splitThumbnailHook(value) {
  const text = normalizeWhitespace(value);
  if (!text) return [];
  const chars = codePoints(text);
  const maxLine = /[가-힣]/.test(text) ? 11 : 20;
  if (chars.length <= maxLine) return [text];

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    let first = '';
    let second = '';
    for (const word of words) {
      const candidate = first ? `${first} ${word}` : word;
      if (!second && codePoints(candidate).length <= maxLine) {
        first = candidate;
      } else {
        second = second ? `${second} ${word}` : word;
      }
    }
    if (first && second) {
      return [
        clampCodePoints(first, maxLine, normalizeWhitespace),
        clampCodePoints(second, maxLine, normalizeWhitespace)
      ];
    }
  }

  return [
    chars.slice(0, maxLine).join('').trim(),
    chars.slice(maxLine, maxLine * 2).join('').trim()
  ].filter(Boolean);
}

export function buildThumbnailHtml({ imageBase64, sourceMimeType, hookText }) {
  const mimeType = normalizedSourceMimeType(sourceMimeType);
  const base64 = normalizedBase64(imageBase64);
  const hook = normalizeWhitespace(hookText);
  if (!hook) throw new Error('THUMBNAIL_HOOK_REQUIRED');

  const lines = splitThumbnailHook(hook).slice(0, 2);
  const lineHtml = lines
    .map((line) => `<div style="display:flex;line-height:1.08;">${escapeHtml(line)}</div>`)
    .join('');

  return `<div style="display:flex;position:relative;width:${THUMBNAIL_WIDTH}px;height:${THUMBNAIL_HEIGHT}px;overflow:hidden;background:#111;">
  <img src="data:${mimeType};base64,${base64}" width="${THUMBNAIL_WIDTH}" height="${THUMBNAIL_HEIGHT}" style="position:absolute;left:0;top:0;width:${THUMBNAIL_WIDTH}px;height:${THUMBNAIL_HEIGHT}px;object-fit:cover;" />
  <div style="display:flex;position:absolute;left:0;right:0;bottom:0;min-height:235px;padding:42px 68px 48px 68px;box-sizing:border-box;flex-direction:column;justify-content:flex-end;background:rgba(0,0,0,0.68);color:#fff;font-family:'Thumbnail Sans';font-size:58px;font-weight:800;letter-spacing:-1px;">
    ${lineHtml}
  </div>
</div>`;
}

function createHookFont(hookText, FontClass = GoogleFont) {
  const hook = normalizeWhitespace(hookText);
  const korean = /[가-힣]/.test(hook);
  return new FontClass(korean ? 'Noto Sans KR' : 'Inter', {
    weight: 800,
    text: hook
  });
}

export async function renderThumbnailPng({
  imageBase64,
  sourceMimeType,
  hookText,
  executionContext = null,
  imageResponse = ImageResponse,
  fontClass = GoogleFont
}) {
  const hook = normalizeWhitespace(hookText);
  if (!hook) throw new Error('THUMBNAIL_HOOK_REQUIRED');

  if (executionContext?.waitUntil) cache.setExecutionContext(executionContext);
  const html = buildThumbnailHtml({ imageBase64, sourceMimeType, hookText: hook });
  const font = createHookFont(hook, fontClass);
  const response = await imageResponse.create(html, {
    width: THUMBNAIL_WIDTH,
    height: THUMBNAIL_HEIGHT,
    format: 'png',
    fonts: [
      {
        name: 'Thumbnail Sans',
        data: font.data,
        weight: 800,
        style: 'normal'
      }
    ]
  });

  if (!response?.ok) throw new Error(`THUMBNAIL_RENDER_FAILED:${response?.status || 'UNKNOWN'}`);
  const mimeType = String(response.headers?.get?.('content-type') || '').split(';')[0].toLowerCase();
  if (mimeType !== THUMBNAIL_OUTPUT_MIME) throw new Error(`THUMBNAIL_RENDER_MIME_INVALID:${mimeType || 'missing'}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 100) throw new Error('THUMBNAIL_RENDER_BYTES_TOO_SMALL');
  return { bytes, mimeType: THUMBNAIL_OUTPUT_MIME, hookText: hook, html };
}

export async function postprocessThumbnail(image, generated, options = {}) {
  const hookText = deriveThumbnailHook(image);
  if (!hookText) throw new Error('THUMBNAIL_HOOK_REQUIRED');
  return renderThumbnailPng({
    imageBase64: generated?.imageBase64,
    sourceMimeType: generated?.mimeType,
    hookText,
    executionContext: options.executionContext,
    imageResponse: options.imageResponse || ImageResponse,
    fontClass: options.fontClass || GoogleFont
  });
}