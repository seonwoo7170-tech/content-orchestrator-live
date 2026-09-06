const base = String(process.env.API_HUB_V2_BASE_URL || '').replace(/\/$/, '');
const key = String(process.env.HUB_API_KEY || '');
if (!base || !key) throw new Error('PROBE_CONFIG_REQUIRED');

const health = await fetch(`${base}/health?image_probe=${Date.now()}`, { cache: 'no-store' });
const state = await health.json().catch(() => ({}));
if (!health.ok || state.bloggerWritesEnabled !== false || state.bloggerWriteMode !== 'disabled') {
  throw new Error('BLOGGER_WRITE_GATE_NOT_OFF');
}

const response = await fetch(`${base}/api/hub/image/generate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-api-key': key },
  body: JSON.stringify({
    role: 'body',
    providerMode: 'cloudflare',
    prompt: 'Photorealistic close-up of a plain chrome household faucet and a wrench on a neutral countertop, no text, no labels, no logos, no numbers.',
    aspectRatio: '4:3'
  })
});
const data = await response.json().catch(() => ({}));
console.log(`CLOUDFLARE_IMAGE_PROBE http=${response.status}; ok=${data?.ok === true}; provider=${String(data?.provider || 'none')}; error=${String(data?.error || 'none')}; mime=${String(data?.mimeType || 'none')}; bytesApprox=${data?.imageBase64 ? Math.floor(String(data.imageBase64).length * 0.75) : 0}`);

const finalHealth = await fetch(`${base}/health?image_probe_final=${Date.now()}`, { cache: 'no-store' });
const finalState = await finalHealth.json().catch(() => ({}));
if (!finalHealth.ok || finalState.bloggerWritesEnabled !== false || finalState.bloggerWriteMode !== 'disabled') {
  throw new Error('FINAL_BLOGGER_WRITE_GATE_NOT_OFF');
}
console.log('CLOUDFLARE_IMAGE_PROBE_COMPLETE bloggerWrites=OFF');
