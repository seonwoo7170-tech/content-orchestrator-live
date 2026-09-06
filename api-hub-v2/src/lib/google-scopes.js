import { getGoogleAccessToken, GOOGLE_SCOPES } from './google-oauth.js';

function safeProviderError(code, response) {
  const error = new Error(code);
  error.status = 502;
  error.providerStatus = Number(response?.status || 0) || null;
  return error;
}

export function summarizeGoogleScopes(scopes = []) {
  const granted = new Set((Array.isArray(scopes) ? scopes : []).map((scope) => String(scope || '').trim()).filter(Boolean));
  const summary = {
    blogger: granted.has(GOOGLE_SCOPES.blogger),
    searchConsole: granted.has(GOOGLE_SCOPES.searchConsole),
    analytics: granted.has(GOOGLE_SCOPES.analytics),
    adsense: granted.has(GOOGLE_SCOPES.adsense)
  };
  return {
    ...summary,
    phase4Ready: summary.searchConsole && summary.analytics && summary.adsense,
    scopes: [...granted].sort()
  };
}

export async function getGoogleGrantedScopes(env, fetchImpl = fetch) {
  const accessToken = await getGoogleAccessToken(env, fetchImpl);
  const response = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'GET',
    headers: { accept: 'application/json' }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok || typeof data?.scope !== 'string') throw safeProviderError('GOOGLE_OAUTH_TOKENINFO_FAILED', response);
  return String(data.scope).split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
}

export async function getGoogleScopeStatus(env, fetchImpl = fetch) {
  const scopes = await getGoogleGrantedScopes(env, fetchImpl);
  return {
    ok: true,
    ...summarizeGoogleScopes(scopes)
  };
}
