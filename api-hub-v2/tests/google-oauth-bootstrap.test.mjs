import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGoogleAuthorizationUrl,
  completeGoogleOAuthSetup,
  GOOGLE_PHASE4_SCOPES,
  GOOGLE_SCOPES,
  googleOAuthClientConfigured,
  googleOAuthConfigured,
  googleOAuthScopeUpgradeEnabled,
  googleOAuthSetupEnabled
} from '../src/lib/google-oauth.js';

const ENV = {
  ORCHESTRATOR_API_KEY: 'test-orchestrator-key',
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_OAUTH_SETUP_ENABLED: 'true',
  GOOGLE_OAUTH_SCOPE_UPGRADE_ENABLED: 'false'
};

test('Google OAuth bootstrap requires client pair and no refresh token', () => {
  assert.equal(googleOAuthClientConfigured(ENV), true);
  assert.equal(googleOAuthSetupEnabled(ENV), true);
  assert.equal(googleOAuthConfigured(ENV), false);
  assert.equal(googleOAuthSetupEnabled({ ...ENV, GOOGLE_REFRESH_TOKEN: 'refresh-token' }), false);
  assert.equal(googleOAuthConfigured({ ...ENV, GOOGLE_REFRESH_TOKEN: 'refresh-token' }), true);
});

test('Phase 4 scope upgrade is explicit and requires an existing configured token', () => {
  const configured = { ...ENV, GOOGLE_REFRESH_TOKEN: 'refresh-token', GOOGLE_OAUTH_SCOPE_UPGRADE_ENABLED: 'true' };
  assert.equal(googleOAuthScopeUpgradeEnabled(configured), true);
  assert.equal(googleOAuthScopeUpgradeEnabled({ ...configured, GOOGLE_OAUTH_SCOPE_UPGRADE_ENABLED: 'false' }), false);
  assert.equal(googleOAuthScopeUpgradeEnabled({ ...ENV, GOOGLE_OAUTH_SCOPE_UPGRADE_ENABLED: 'true' }), false);
});

test('Google OAuth authorization URL requests Blogger plus all Phase 4 read-only scopes', async () => {
  const authorizationUrl = new URL(await buildGoogleAuthorizationUrl(ENV, 'https://api-hub-v2.example/oauth/google/start'));
  assert.equal(authorizationUrl.origin, 'https://accounts.google.com');
  assert.equal(authorizationUrl.pathname, '/o/oauth2/v2/auth');
  assert.equal(authorizationUrl.searchParams.get('client_id'), ENV.GOOGLE_CLIENT_ID);
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), 'https://api-hub-v2.example/oauth/google/callback');
  const scopes = new Set(String(authorizationUrl.searchParams.get('scope') || '').split(/\s+/).filter(Boolean));
  assert.deepEqual(scopes, new Set(GOOGLE_PHASE4_SCOPES));
  assert.equal(scopes.has(GOOGLE_SCOPES.blogger), true);
  assert.equal(scopes.has(GOOGLE_SCOPES.searchConsole), true);
  assert.equal(scopes.has(GOOGLE_SCOPES.analytics), true);
  assert.equal(scopes.has(GOOGLE_SCOPES.adsense), true);
  assert.equal(authorizationUrl.searchParams.get('access_type'), 'offline');
  assert.equal(authorizationUrl.searchParams.get('prompt'), 'consent');
  assert.equal(authorizationUrl.searchParams.get('include_granted_scopes'), 'true');
  assert.match(String(authorizationUrl.searchParams.get('state')), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('Google OAuth callback exchanges code and returns only refresh token', async () => {
  const authorizationUrl = new URL(await buildGoogleAuthorizationUrl(ENV, 'https://api-hub-v2.example/oauth/google/start'));
  const state = authorizationUrl.searchParams.get('state');
  const callback = new URL('https://api-hub-v2.example/oauth/google/callback');
  callback.searchParams.set('code', 'authorization-code');
  callback.searchParams.set('state', state);

  let seenBody;
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    assert.equal(init.method, 'POST');
    seenBody = new URLSearchParams(init.body);
    return new Response(JSON.stringify({ access_token: 'access-token', refresh_token: 'new-refresh-token' }), { status: 200 });
  };

  const result = await completeGoogleOAuthSetup(ENV, callback.toString(), fetchImpl);
  assert.deepEqual(result, { refreshToken: 'new-refresh-token' });
  assert.equal(seenBody.get('client_id'), ENV.GOOGLE_CLIENT_ID);
  assert.equal(seenBody.get('client_secret'), ENV.GOOGLE_CLIENT_SECRET);
  assert.equal(seenBody.get('code'), 'authorization-code');
  assert.equal(seenBody.get('redirect_uri'), 'https://api-hub-v2.example/oauth/google/callback');
  assert.equal(seenBody.get('grant_type'), 'authorization_code');
});

test('Google OAuth callback rejects tampered state before provider exchange', async () => {
  const authorizationUrl = new URL(await buildGoogleAuthorizationUrl(ENV, 'https://api-hub-v2.example/oauth/google/start'));
  const state = authorizationUrl.searchParams.get('state');
  const callback = new URL('https://api-hub-v2.example/oauth/google/callback');
  callback.searchParams.set('code', 'authorization-code');
  callback.searchParams.set('state', `${state}x`);

  let called = false;
  await assert.rejects(
    () => completeGoogleOAuthSetup(ENV, callback.toString(), async () => { called = true; return new Response('{}'); }),
    /GOOGLE_OAUTH_STATE_INVALID/
  );
  assert.equal(called, false);
});
