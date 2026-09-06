import { ImageResponse } from 'cf-workers-og/html';

const WIDTH_BY_ROLE = Object.freeze({ thumbnail: 1200, body: 1200 });
const HEIGHT_BY_ROLE = Object.freeze({ thumbnail: 675, body: 900 });

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function motif(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (/computer|pc|gpu|graphics|monitor|display|hdmi|displayport|windows|laptop/.test(text)) return 'tech';
  if (/water|pipe|plumb|shower|faucet|valve|drain|toilet/.test(text)) return 'plumbing';
  if (/dryer|washer|clean|home|repair|paint|drill|sand|fixture|maintenance/.test(text)) return 'home';
  return 'neutral';
}

function shapesFor(prompt) {
  const seed = hashText(prompt);
  const variant = seed % 3;
  const kind = motif(prompt);
  if (kind === 'tech') {
    return variant === 0
      ? '<div style="display:flex;width:58%;height:42%;border:18px solid rgba(255,255,255,.72);border-radius:28px;box-sizing:border-box;"></div><div style="display:flex;width:18px;height:150px;background:rgba(255,255,255,.72);"></div><div style="display:flex;width:250px;height:18px;background:rgba(255,255,255,.72);border-radius:10px;"></div>'
      : '<div style="display:flex;width:62%;height:32%;border-radius:32px;background:rgba(255,255,255,.18);border:12px solid rgba(255,255,255,.64);"></div><div style="display:flex;gap:26px;margin-top:36px;"><div style="width:90px;height:90px;border-radius:50%;border:12px solid rgba(255,255,255,.7);"></div><div style="width:90px;height:90px;border-radius:50%;border:12px solid rgba(255,255,255,.7);"></div></div>';
  }
  if (kind === 'plumbing') {
    return '<div style="display:flex;width:170px;height:170px;border-radius:50%;border:22px solid rgba(255,255,255,.72);"></div><div style="display:flex;width:22px;height:220px;background:rgba(255,255,255,.68);"></div><div style="display:flex;width:340px;height:22px;background:rgba(255,255,255,.68);border-radius:12px;"></div>';
  }
  if (kind === 'home') {
    return '<div style="display:flex;width:360px;height:360px;transform:rotate(45deg);border-radius:42px;background:rgba(255,255,255,.18);border:18px solid rgba(255,255,255,.65);"></div><div style="display:flex;position:absolute;width:120px;height:120px;border-radius:50%;background:rgba(255,255,255,.66);"></div>';
  }
  return '<div style="display:flex;width:420px;height:420px;border-radius:50%;background:rgba(255,255,255,.16);border:18px solid rgba(255,255,255,.62);"></div><div style="display:flex;position:absolute;width:210px;height:210px;border-radius:42px;background:rgba(255,255,255,.28);"></div>';
}

export function buildLocalFallbackHtml(prompt, role = 'body') {
  const width = WIDTH_BY_ROLE[role] || WIDTH_BY_ROLE.body;
  const height = HEIGHT_BY_ROLE[role] || HEIGHT_BY_ROLE.body;
  const seed = hashText(prompt);
  const hueA = seed % 360;
  const hueB = (hueA + 48 + (seed % 90)) % 360;
  return `<div style="display:flex;position:relative;width:${width}px;height:${height}px;overflow:hidden;align-items:center;justify-content:center;flex-direction:column;gap:28px;background:linear-gradient(135deg,hsl(${hueA},38%,28%),hsl(${hueB},42%,48%));"><div style="display:flex;position:absolute;left:-12%;top:-20%;width:55%;height:70%;border-radius:50%;background:rgba(255,255,255,.07);"></div><div style="display:flex;position:absolute;right:-10%;bottom:-24%;width:58%;height:72%;border-radius:50%;background:rgba(0,0,0,.10);"></div>${shapesFor(prompt)}</div>`;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export async function generateLocalFallbackImage(prompt, role = 'body', options = {}) {
  const imageResponse = options.imageResponse || ImageResponse;
  const width = WIDTH_BY_ROLE[role] || WIDTH_BY_ROLE.body;
  const height = HEIGHT_BY_ROLE[role] || HEIGHT_BY_ROLE.body;
  const response = await imageResponse.create(buildLocalFallbackHtml(prompt, role), { width, height, format: 'png' });
  if (!response?.ok) throw new Error(`LOCAL_IMAGE_RENDER_FAILED:${response?.status || 'UNKNOWN'}`);
  const mimeType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
  if (mimeType !== 'image/png') throw new Error(`LOCAL_IMAGE_MIME_INVALID:${mimeType || 'missing'}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 100) throw new Error('LOCAL_IMAGE_BYTES_TOO_SMALL');
  return {
    ok: true,
    provider: 'local-free-renderer',
    model: 'deterministic-css-v1',
    mimeType: 'image/png',
    imageBase64: bytesToBase64(bytes),
    imageQa: { enabled: false, pass: true, attempts: 0, reason: 'LOCAL_NO_TEXT_RENDER' }
  };
}
