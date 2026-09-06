import test from 'node:test';
import assert from 'node:assert/strict';
import { getGoogleAccessToken } from '../src/lib/google-oauth.js';

const ENV = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REFRESH_TOKEN: 'refresh-token'
};

function failedRefresh(errorCode, status = 400) {
  return async (url, init = {}) => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    assert.equal(init.method, 'POST');
    return new Response(JSON.stringify({ error: errorCode, error_description: 'redacted provider detail' }), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  };
}

test('invalid_grant is classified as explicit reauthorization required', async () => {
  await assert.rejects(
    () => getGoogleAccessToken(ENV, failedRefresh('invalid_grant')),
    (error) => error?.message === 'GOOGLE_OAUTH_REAUTH_REQUIRED' && error?.status === 502 && error?.providerStatus === 400
  );
});

test('invalid OAuth client credentials are classified separately', async () => {
  await assert.rejects(
    () => getGoogleAccessToken(ENV, failedRefresh('invalid_client', 401)),
    (error) => error?.message === 'GOOGLE_OAUTH_CLIENT_INVALID' && error?.providerStatus === 401
  );
});

test('unknown refresh failures remain safely generic', async () => {
  await assert.rejects(
    () => getGoogleAccessToken(ENV, failedRefresh('temporarily_unavailable', 503)),
    (error) => error?.message === 'GOOGLE_OAUTH_REFRESH_FAILED' && error?.providerStatus === 503
  );
});
