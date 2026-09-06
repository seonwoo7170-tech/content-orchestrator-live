const COOKIE_NAME = 'content_orchestrator_admin';
const SESSION_VERSION = 1;
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const normalized = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function cookieValue(request, name) {
  const header = String(request?.headers?.get?.('cookie') || '');
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    return part.slice(index + 1).trim();
  }
  return '';
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

function constantTimeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export async function createAdminSessionToken(secret, options = {}) {
  if (!String(secret || '')) throw new Error('ADMIN_API_KEY_NOT_CONFIGURED');
  const nowMs = Number(options.nowMs ?? Date.now());
  const maxAgeSeconds = Number(options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS);
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error('ADMIN_SESSION_OPTIONS_INVALID');
  }
  const payload = {
    v: SESSION_VERSION,
    exp: Math.floor(nowMs / 1000) + Math.floor(maxAgeSeconds)
  };
  const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = bytesToBase64Url(await hmac(secret, encodedPayload));
  return `${encodedPayload}.${signature}`;
}

export async function verifyAdminSessionToken(token, secret, options = {}) {
  if (!String(secret || '') || !String(token || '')) return false;
  const [encodedPayload, signature, extra] = String(token).split('.');
  if (!encodedPayload || !signature || extra !== undefined) return false;

  let payload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlToBytes(encodedPayload)));
  } catch {
    return false;
  }
  if (payload?.v !== SESSION_VERSION || !Number.isInteger(payload?.exp)) return false;
  const nowSeconds = Math.floor(Number(options.nowMs ?? Date.now()) / 1000);
  if (!Number.isFinite(nowSeconds) || payload.exp <= nowSeconds) return false;

  const expected = bytesToBase64Url(await hmac(secret, encodedPayload));
  return constantTimeEqual(signature, expected);
}

export async function requireAdmin(request, env, options = {}) {
  const secret = String(env?.ADMIN_API_KEY || '');
  if (!secret) return false;
  const headerCredential = String(request?.headers?.get?.('x-admin-api-key') || '');
  if (headerCredential && constantTimeEqual(headerCredential, secret)) return true;
  const token = cookieValue(request, COOKIE_NAME);
  return verifyAdminSessionToken(token, secret, options);
}

export function adminSessionCookie(token, options = {}) {
  const maxAgeSeconds = Math.floor(Number(options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS));
  if (!token || !Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) throw new Error('ADMIN_SESSION_COOKIE_INVALID');
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearAdminSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export const ADMIN_SESSION = Object.freeze({
  cookieName: COOKIE_NAME,
  maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS
});
