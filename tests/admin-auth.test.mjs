import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_SESSION,
  adminSessionCookie,
  clearAdminSessionCookie,
  createAdminSessionToken,
  requireAdmin,
  verifyAdminSessionToken
} from '../worker/lib/admin-auth.js';

const SECRET = 'test-admin-secret-with-enough-entropy';
const NOW = Date.UTC(2026, 7, 30, 0, 0, 0);

test('signed admin session token verifies until expiry and rejects tampering', async () => {
  const token = await createAdminSessionToken(SECRET, { nowMs: NOW, maxAgeSeconds: 60 });
  assert.equal(await verifyAdminSessionToken(token, SECRET, { nowMs: NOW + 59_000 }), true);
  assert.equal(await verifyAdminSessionToken(token, SECRET, { nowMs: NOW + 60_000 }), false);
  assert.equal(await verifyAdminSessionToken(`${token}x`, SECRET, { nowMs: NOW }), false);
  assert.equal(await verifyAdminSessionToken(token, `${SECRET}-wrong`, { nowMs: NOW }), false);
});

test('requireAdmin accepts the legacy header and the signed HttpOnly cookie', async () => {
  const env = { ADMIN_API_KEY: SECRET };
  const headerRequest = new Request('https://example.test/api/jobs', {
    headers: { 'x-admin-api-key': SECRET }
  });
  assert.equal(await requireAdmin(headerRequest, env, { nowMs: NOW }), true);

  const token = await createAdminSessionToken(SECRET, { nowMs: NOW, maxAgeSeconds: 300 });
  const cookieRequest = new Request('https://example.test/api/jobs', {
    headers: { cookie: `${ADMIN_SESSION.cookieName}=${token}` }
  });
  assert.equal(await requireAdmin(cookieRequest, env, { nowMs: NOW + 1000 }), true);
});

test('admin session cookie is persistent, HttpOnly, Secure and SameSite Strict', async () => {
  const token = await createAdminSessionToken(SECRET, { nowMs: NOW, maxAgeSeconds: 300 });
  const cookie = adminSessionCookie(token, { maxAgeSeconds: 300 });
  assert.match(cookie, new RegExp(`^${ADMIN_SESSION.cookieName}=`));
  assert.match(cookie, /Max-Age=300/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(clearAdminSessionCookie(), /Max-Age=0/);
});
