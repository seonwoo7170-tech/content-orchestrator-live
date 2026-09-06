const baseUrl = String(process.env.API_HUB_V2_BASE_URL || '').replace(/\/$/, '');
const hubKey = String(process.env.HUB_API_KEY || '').trim();
if (!baseUrl || !hubKey) throw new Error('PROBE_CONFIG_MISSING');

async function health(label) {
  const response = await fetch(`${baseUrl}/health?kie_probe=${label}_${Date.now()}`, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HEALTH_${response.status}`);
  if (data.bloggerWritesEnabled !== false || data.bloggerWriteMode !== 'disabled') {
    throw new Error('BLOGGER_WRITE_GATE_NOT_OFF');
  }
  return data;
}

await health('before');

const response = await fetch(`${baseUrl}/api/hub/image/generate`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-hub-api-key': hubKey
  },
  body: JSON.stringify({
    role: 'thumbnail',
    providerMode: 'kie',
    aspectRatio: '16:9',
    prompt: 'Photorealistic editorial photo of a homeowner locating the main water shutoff valve in a clean residential utility area. Clear focus on the valve and surrounding plumbing, natural indoor lighting, practical everyday home-maintenance setting, realistic detail, uncluttered composition, and plain unmarked visible surfaces.'
  })
});

const data = await response.json().catch(() => ({}));
const bytesApprox = data.imageBase64 ? Math.floor(String(data.imageBase64).length * 0.75) : 0;
console.log([
  'KIE_IMAGE_PROBE',
  `http=${response.status}`,
  `ok=${data.ok === true}`,
  `provider=${String(data.provider || 'none')}`,
  `error=${String(data.error || 'none')}`,
  `providerCode=${Number.isInteger(data.providerCode) ? data.providerCode : 'none'}`,
  `providerHttpStatus=${Number.isInteger(data.providerHttpStatus) ? data.providerHttpStatus : 'none'}`,
  `mime=${String(data.mimeType || 'none')}`,
  `bytesApprox=${bytesApprox}`
].join('; '));

await health('after');
console.log('KIE_IMAGE_PROBE_COMPLETE bloggerWrites=OFF');

if (!response.ok || data.ok !== true || !data.imageBase64) process.exitCode = 2;
