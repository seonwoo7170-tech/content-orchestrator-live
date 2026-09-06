const base = String(process.env.API_HUB_V2_BASE_URL || '').replace(/\/+$/, '');
const key = String(process.env.API_HUB_V2_KEY || process.env.EXISTING_ORCHESTRATOR_KEY || '').trim();

if (!base || !key) {
  console.log('LIVE_WRITER_ROUTE_PROBE_SKIPPED');
  process.exit(0);
}

const response = await fetch(`${base}/api/hub/ai/writer`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-hub-api-key': key
  },
  body: '{}'
});

let data = null;
try { data = await response.json(); } catch { data = null; }
const code = String(data?.error || '');
console.log(`LIVE_WRITER_ROUTE_PROBE status=${response.status} code=${code || 'none'}`);

if (response.status !== 400 || code !== 'WRITER_TOPIC_REQUIRED') {
  throw new Error(`LIVE_WRITER_ROUTE_PROBE_FAILED:${response.status}:${code || 'NO_CODE'}`);
}

console.log('LIVE_WRITER_ROUTE_PROBE_OK');
