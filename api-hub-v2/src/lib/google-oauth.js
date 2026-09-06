function required(value, name) {
  const text = String(value || '').trim();
  if (!text) {
    const error = new Error(`${name}_REQUIRED`);
    error.status = 503;
    throw error;
  }
  return text;
}

export const GOOGLE_SCOPES = Object.freeze({
  blogger: 'https://www.googleapis.com/auth/blogger',
  searchConsole: 'https://www.googleapis.com/auth/webmasters.readonly',
  analytics: 'https://www.googleapis.com/auth/analytics.readonly',
  adsense: 'https://www.googleapis.com/auth/adsense.readonly'
});

export const GOOGLE_PHASE4_SCOPES = Object.freeze(Object.values(GOOGLE_SCOPES));
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(text) {
  const normalized = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signState(env, payload) {
  const secret = required(env.ORCHESTRATOR_API_KEY, 'ORCHESTRATOR_API_KEY');
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(encoded));
  return `${encoded}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyState(env, state, expectedRedirectUri) {
  const [encoded, signatureText, extra] = String(state || '').split('.');
  if (!encoded || !signatureText || extra) throw Object.assign(new Error('GOOGLE_OAUTH_STATE_INVALID'), { status: 400 });

  const secret = required(env.ORCHESTRATOR_API_KEY, 'ORCHESTRATOR_API_KEY');
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    base64UrlDecode(signatureText),
    new TextEncoder().encode(encoded)
  );
  if (!valid) throw Object.assign(new Error('GOOGLE_OAUTH_STATE_INVALID'), { status: 400 });

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)));
  } catch {
    throw Object.assign(new Error('GOOGLE_OAUTH_STATE_INVALID'), { status: 400 });
  }

  const issuedAt = Number(payload?.iat || 0);
  if (!issuedAt || Date.now() - issuedAt > STATE_MAX_AGE_MS || issuedAt - Date.now() > 60_000) {
    throw Object.assign(new Error('GOOGLE_OAUTH_STATE_EXPIRED'), { status: 400 });
  }
  if (String(payload?.redirectUri || '') !== expectedRedirectUri) {
    throw Object.assign(new Error('GOOGLE_OAUTH_REDIRECT_MISMATCH'), { status: 400 });
  }
  return payload;
}

export function googleOAuthClientConfigured(env) {
  return Boolean(
    String(env.GOOGLE_CLIENT_ID || '').trim() &&
    String(env.GOOGLE_CLIENT_SECRET || '').trim()
  );
}

export function googleOAuthSetupEnabled(env) {
  return env.GOOGLE_OAUTH_SETUP_ENABLED === 'true' && googleOAuthClientConfigured(env) && !String(env.GOOGLE_REFRESH_TOKEN || '').trim();
}

export function googleOAuthConfigured(env) {
  return googleOAuthClientConfigured(env) && Boolean(String(env.GOOGLE_REFRESH_TOKEN || '').trim());
}

export function googleOAuthScopeUpgradeEnabled(env) {
  return env.GOOGLE_OAUTH_SCOPE_UPGRADE_ENABLED === 'true' && googleOAuthConfigured(env);
}

function oauthFlowMode(env) {
  if (googleOAuthSetupEnabled(env)) return 'bootstrap';
  if (googleOAuthScopeUpgradeEnabled(env)) return 'phase4_scope_upgrade';
  return null;
}

function oauthRedirectUri(requestUrl) {
  const url = new URL(requestUrl);
  return `${url.origin}/oauth/google/callback`;
}

export async function buildGoogleAuthorizationUrl(env, requestUrl) {
  const mode = oauthFlowMode(env);
  if (!mode) throw Object.assign(new Error('GOOGLE_OAUTH_SETUP_DISABLED'), { status: 404 });

  const clientId = required(env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID');
  const redirectUri = oauthRedirectUri(requestUrl);
  const state = await signState(env, {
    iat: Date.now(),
    nonce: crypto.randomUUID(),
    redirectUri,
    mode
  });

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_PHASE4_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function completeGoogleOAuthSetup(env, requestUrl, fetchImpl = fetch) {
  if (!oauthFlowMode(env)) {
    throw Object.assign(new Error('GOOGLE_OAUTH_SETUP_DISABLED'), { status: 404 });
  }

  const url = new URL(requestUrl);
  const providerError = String(url.searchParams.get('error') || '').trim();
  if (providerError) throw Object.assign(new Error('GOOGLE_OAUTH_AUTHORIZATION_DENIED'), { status: 400 });

  const code = String(url.searchParams.get('code') || '').trim();
  const state = String(url.searchParams.get('state') || '').trim();
  if (!code) throw Object.assign(new Error('GOOGLE_OAUTH_CODE_REQUIRED'), { status: 400 });

  const redirectUri = oauthRedirectUri(requestUrl);
  await verifyState(env, state, redirectUri);

  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: required(env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID'),
      client_secret: required(env.GOOGLE_CLIENT_SECRET, 'GOOGLE_CLIENT_SECRET'),
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }).toString()
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!response.ok) {
    const error = new Error('GOOGLE_OAUTH_CODE_EXCHANGE_FAILED');
    error.status = 502;
    error.providerStatus = response.status;
    throw error;
  }

  const refreshToken = String(data?.refresh_token || '').trim();
  if (!refreshToken) {
    throw Object.assign(new Error('GOOGLE_OAUTH_REFRESH_TOKEN_NOT_RETURNED'), { status: 502 });
  }

  return { refreshToken };
}

function refreshFailureCode(data) {
  const providerError = String(data?.error || '').trim();
  if (providerError === 'invalid_grant') return 'GOOGLE_OAUTH_REAUTH_REQUIRED';
  if (providerError === 'invalid_client' || providerError === 'unauthorized_client') return 'GOOGLE_OAUTH_CLIENT_INVALID';
  return 'GOOGLE_OAUTH_REFRESH_FAILED';
}

export async function getGoogleAccessToken(env, fetchImpl = fetch) {
  const clientId = required(env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID');
  const clientSecret = required(env.GOOGLE_CLIENT_SECRET, 'GOOGLE_CLIENT_SECRET');
  const refreshToken = required(env.GOOGLE_REFRESH_TOKEN, 'GOOGLE_REFRESH_TOKEN');

  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString()
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!response.ok || !data?.access_token) {
    const error = new Error(refreshFailureCode(data));
    error.status = 502;
    error.providerStatus = response.status;
    throw error;
  }

  return String(data.access_token);
}
