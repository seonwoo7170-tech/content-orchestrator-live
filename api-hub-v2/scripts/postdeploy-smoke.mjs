const baseUrl = String(process.env.API_HUB_V2_BASE_URL || 'https://api-hub-v2.smileseon.workers.dev').replace(/\/+$/, '');
const key = String(process.env.ORCHESTRATOR_API_KEY || '');
const expectedMasterSha = '0df7c83bb3874c4802ca7c02306beee7cd7032366930d66abfc7fa1bdb6cda66';
const expectedMasterSize = 93282;

if (!key) throw new Error('ORCHESTRATOR_API_KEY_REQUIRED');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJsonWithRetry(
  url,
  init = {},
  {
    attempts = 12,
    delayMs = 2000,
    retryStatuses = [404, 429, 500, 502, 503, 504],
    terminalErrorCodes = []
  } = {}
) {
  let response;
  let data = {};
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await fetch(url, init);
      data = await response.json().catch(() => ({}));
    } catch (error) {
      if (attempt === attempts) throw error;
      console.log(`Transient fetch error on attempt ${attempt}/${attempts}; retrying without printing response bodies.`);
      await sleep(delayMs);
      continue;
    }

    const errorCode = String(data?.error || '');
    if (terminalErrorCodes.includes(errorCode)) {
      console.log(`Terminal provider condition ${errorCode}; retry suppressed.`);
      return { response, data, attempt };
    }

    if (!retryStatuses.includes(response.status) || attempt === attempts) {
      return { response, data, attempt };
    }

    console.log(`Transient HTTP ${response.status} on attempt ${attempt}/${attempts}; retrying.`);
    await sleep(delayMs);
  }
  return { response, data, attempt: attempts };
}

const healthResult = await fetchJsonWithRetry(`${baseUrl}/health`);
const health = healthResult.response;
const healthData = healthResult.data;
const master = healthData?.masterV45 || {};
const masterOk = master?.bundled === true && master?.sha256 === expectedMasterSha && Number(master?.size) === expectedMasterSize;
const writesManaged = healthData?.bloggerWritesEnabled === true && healthData?.bloggerWriteMode === 'managed_allowlist';
const oauthSetupEnabled = healthData?.googleOAuthSetupEnabled === true;
const oauthClientConfigured = healthData?.googleOAuthClientConfigured === true;

console.log(
  `API Hub v2 health: HTTP ${health?.status || 0}, ok=${healthData?.ok === true ? 'yes' : 'no'}, ` +
  `masterV45=${masterOk ? 'verified' : 'invalid'}, bloggerConfigured=${healthData?.bloggerConfigured === true ? 'yes' : 'no'}, ` +
  `bloggerWrites=${writesManaged ? 'managed' : 'INVALID'}, oauthSetup=${oauthSetupEnabled ? 'enabled' : 'disabled'}, attempt=${healthResult.attempt}`
);

if (!health?.ok || healthData?.ok !== true) throw new Error(`API_HUB_V2_HEALTH_FAILED:${health?.status || 0}`);
if (!masterOk) throw new Error('API_HUB_V2_MASTER_V45_INTEGRITY_FAILED');
if (!writesManaged) throw new Error('API_HUB_V2_BLOGGER_WRITE_GATE_NOT_MANAGED');
if (oauthSetupEnabled && !oauthClientConfigured) throw new Error('API_HUB_V2_OAUTH_SETUP_WITHOUT_CLIENT');
if (oauthSetupEnabled && healthData?.bloggerConfigured === true) throw new Error('API_HUB_V2_OAUTH_SETUP_MUST_DISABLE_AFTER_REFRESH_TOKEN');

const diagnosticResult = await fetchJsonWithRetry(`${baseUrl}/api/hub/ai/diagnostics/cloudflare`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-hub-api-key': key
  },
  body: JSON.stringify({ model: '@cf/openai/gpt-oss-120b', prompt: 'Reply only with OK' })
}, {
  attempts: 6,
  delayMs: 2000,
  retryStatuses: [404, 429, 500, 502, 503, 504],
  terminalErrorCodes: ['CLOUDFLARE_AI_ACCOUNT_LIMITED', 'CLOUDFLARE_AI_PAID_PLAN_REQUIRED']
});
const diagnostic = diagnosticResult.response;
const diagnosticData = diagnosticResult.data;
const diagnosticError = String(diagnosticData?.error || 'none');
let aiAvailability = 'available';
console.log(
  `API Hub v2 Cloudflare diagnostic: HTTP ${diagnostic?.status || 0}, ok=${diagnosticData?.ok === true ? 'yes' : 'no'}, ` +
  `error=${diagnosticError}, model=${diagnosticData?.model || 'unknown'}, attempt=${diagnosticResult.attempt}`
);
if (!diagnostic?.ok || diagnosticData?.ok !== true) {
  if (diagnosticError === 'CLOUDFLARE_AI_ACCOUNT_LIMITED' && Number(diagnostic?.status) === 429) {
    aiAvailability = 'degraded-account-limited';
    console.log('Workers AI daily free allocation is exhausted; deployment integrity remains valid and read-only Blogger smoke will continue.');
  } else {
    throw new Error(`API_HUB_V2_DIAGNOSTIC_FAILED:${diagnostic?.status || 0}:${diagnosticError}`);
  }
}

if (oauthSetupEnabled) {
  const oauthStart = await fetch(`${baseUrl}/oauth/google/start`, { redirect: 'manual' });
  const location = String(oauthStart.headers.get('location') || '');
  const redirectOk = oauthStart.status === 302 && location.startsWith('https://accounts.google.com/o/oauth2/v2/auth?');
  console.log(`API Hub v2 Google OAuth bootstrap: HTTP ${oauthStart.status}, redirect=${redirectOk ? 'valid' : 'invalid'}`);
  if (!redirectOk) throw new Error(`API_HUB_V2_GOOGLE_OAUTH_START_FAILED:${oauthStart.status}`);
}

if (healthData?.bloggerConfigured === true) {
  if (oauthSetupEnabled) throw new Error('API_HUB_V2_OAUTH_BOOTSTRAP_STILL_ENABLED');
  const blogsResult = await fetchJsonWithRetry(`${baseUrl}/api/blogger/blogs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-api-key': key
    },
    body: JSON.stringify({ action: 'list' })
  }, { attempts: 4, delayMs: 1500, retryStatuses: [404, 429, 500, 502, 503, 504] });
  const blogs = blogsResult.response;
  const blogsData = blogsResult.data;
  const count = Number(blogsData?.count ?? (Array.isArray(blogsData?.blogs) ? blogsData.blogs.length : 0));
  console.log(`API Hub v2 Blogger read-only smoke: HTTP ${blogs?.status || 0}, connectedBlogs=${Number.isFinite(count) ? count : 0}`);
  if (!blogs?.ok || !Array.isArray(blogsData?.blogs) || count < 1) {
    throw new Error(`API_HUB_V2_BLOGGER_LIST_FAILED:${blogs?.status || 0}`);
  }
}

console.log(`API Hub v2 post-deploy smoke passed; aiAvailability=${aiAvailability}. Managed Blogger write gate verified; no Blogger write was attempted.`);
