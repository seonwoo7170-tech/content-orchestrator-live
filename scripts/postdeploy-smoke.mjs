const required = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'ADMIN_API_KEY'];
for (const key of required) {
  if (!String(process.env[key] || '').trim()) throw new Error(`${key}_REQUIRED`);
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID.trim();
const apiToken = process.env.CLOUDFLARE_API_TOKEN.trim();
const adminKey = process.env.ADMIN_API_KEY;
const workerName = process.env.WORKER_NAME || 'content-orchestrator';

async function readJson(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

const subdomainResponse = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
  { headers: { authorization: `Bearer ${apiToken}`, accept: 'application/json' } }
);
const subdomainBody = await readJson(subdomainResponse);
if (!subdomainResponse.ok || !subdomainBody?.success || !subdomainBody?.result?.subdomain) {
  throw new Error(`WORKERS_SUBDOMAIN_LOOKUP_FAILED:${subdomainResponse.status}`);
}

const baseUrl = `https://${workerName}.${subdomainBody.result.subdomain}.workers.dev`;
const healthResponse = await fetch(`${baseUrl}/health`, { headers: { accept: 'application/json' } });
const health = await readJson(healthResponse);
if (!healthResponse.ok || health?.ok !== true) {
  throw new Error(`ORCHESTRATOR_HEALTH_FAILED:${healthResponse.status}`);
}
if (health?.apiHubConfigured !== true) throw new Error('ORCHESTRATOR_API_HUB_NOT_CONFIGURED');

const diagnosticResponse = await fetch(`${baseUrl}/api/diagnostics/cloudflare-ai`, {
  method: 'POST',
  headers: {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-admin-api-key': adminKey
  },
  body: '{}'
});
const diagnostic = await readJson(diagnosticResponse);
const model = diagnostic?.model || diagnostic?.result?.model || diagnostic?.details?.model || 'unknown';
const provider = diagnostic?.provider || diagnostic?.result?.provider || 'cloudflare-workers-ai-via-api-hub';
const code = String(diagnostic?.code || diagnostic?.result?.code || diagnostic?.details?.code || '');
const accountLimited = diagnosticResponse.status === 429 && code === 'CLOUDFLARE_AI_ACCOUNT_LIMITED';

console.log(`Orchestrator health: HTTP ${healthResponse.status}, API Hub configured: yes`);
console.log(`Cloudflare diagnostic: HTTP ${diagnosticResponse.status}, ok=${diagnostic?.ok === true ? 'yes' : 'no'}, provider=${provider}, model=${model}, code=${code || 'none'}`);

if (accountLimited) {
  console.log('Workers AI free allocation is exhausted; deployment smoke is degraded but runtime wiring is valid.');
} else if (!diagnosticResponse.ok || diagnostic?.ok !== true) {
  throw new Error(`CLOUDFLARE_DIAGNOSTIC_FAILED:${diagnosticResponse.status}`);
}
