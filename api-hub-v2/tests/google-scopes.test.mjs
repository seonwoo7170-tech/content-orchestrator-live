import test from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_SCOPES } from '../src/lib/google-oauth.js';
import { getGoogleScopeStatus, summarizeGoogleScopes } from '../src/lib/google-scopes.js';

const ENV = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REFRESH_TOKEN: 'refresh-token'
};

test('scope summary distinguishes Blogger and Phase 4 data permissions', () => {
  const partial = summarizeGoogleScopes([GOOGLE_SCOPES.blogger, GOOGLE_SCOPES.searchConsole]);
  assert.equal(partial.blogger, true);
  assert.equal(partial.searchConsole, true);
  assert.equal(partial.analytics, false);
  assert.equal(partial.adsense, false);
  assert.equal(partial.phase4Ready, false);

  const full = summarizeGoogleScopes(Object.values(GOOGLE_SCOPES));
  assert.equal(full.phase4Ready, true);
});

test('scope status refreshes access token then returns only granted permission metadata', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push(String(url));
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      assert.equal(init.method, 'POST');
      return new Response(JSON.stringify({ access_token: 'private-access-token' }), { status: 200 });
    }
    assert.match(String(url), /^https:\/\/oauth2\.googleapis\.com\/tokeninfo\?access_token=/);
    return new Response(JSON.stringify({ scope: `${GOOGLE_SCOPES.blogger} ${GOOGLE_SCOPES.searchConsole}` }), { status: 200 });
  };

  const status = await getGoogleScopeStatus(ENV, fetchImpl);
  assert.equal(status.ok, true);
  assert.equal(status.blogger, true);
  assert.equal(status.searchConsole, true);
  assert.equal(status.analytics, false);
  assert.equal(status.adsense, false);
  assert.equal(status.phase4Ready, false);
  assert.equal(JSON.stringify(status).includes('private-access-token'), false);
  assert.equal(seen.length, 2);
});

test('tokeninfo provider errors are reduced to a safe code', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
    return new Response('provider detail must not escape', { status: 500 });
  };
  await assert.rejects(() => getGoogleScopeStatus(ENV, fetchImpl), /GOOGLE_OAUTH_TOKENINFO_FAILED/);
});
