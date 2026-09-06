export const WORKERS_AI_MODELS = Object.freeze({
  writer: '@cf/openai/gpt-oss-120b',
  critic: '@cf/zai-org/glm-4.7-flash'
});

const ALLOWED_MODELS = new Set(Object.values(WORKERS_AI_MODELS));

function requireSecret(env, key) {
  const value = String(env?.[key] || '').trim();
  if (!value) throw new Error(`${key}_REQUIRED`);
  return value;
}

function extractText(payload) {
  return String(
    payload?.result?.response ??
    payload?.result?.output_text ??
    payload?.response ??
    payload?.output_text ??
    payload?.result?.choices?.[0]?.message?.content ??
    payload?.choices?.[0]?.message?.content ??
    ''
  ).trim();
}

export async function runWorkersAiText(env, input = {}, fetchImpl = fetch) {
  const accountId = requireSecret(env, 'CLOUDFLARE_ACCOUNT_ID');
  const apiToken = requireSecret(env, 'CLOUDFLARE_API_TOKEN');
  const model = String(input.model || WORKERS_AI_MODELS.writer).trim();
  if (!ALLOWED_MODELS.has(model)) throw new Error('WORKERS_AI_MODEL_NOT_ALLOWED');

  const prompt = String(input.prompt || '').trim();
  const messages = Array.isArray(input.messages) ? input.messages : [
    { role: 'system', content: input.system || 'Follow the instruction exactly.' },
    { role: 'user', content: prompt }
  ];
  if (!messages.length || messages.some((item) => !item || typeof item.content !== 'string' || !item.content.trim())) {
    throw new Error('WORKERS_AI_MESSAGES_REQUIRED');
  }

  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        messages,
        max_tokens: Math.min(Math.max(Number(input.maxTokens || 256), 1), 4096),
        temperature: Number.isFinite(Number(input.temperature)) ? Number(input.temperature) : 0.2,
        stream: false
      })
    }
  );

  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }

  if (!response.ok || payload?.success === false) {
    const error = new Error(`CLOUDFLARE_WORKERS_AI_${response.status}`);
    error.status = response.status;
    error.providerErrors = Array.isArray(payload?.errors) ? payload.errors.map((item) => ({ code: item?.code ?? null, message: item?.message ?? 'Unknown error' })) : [];
    throw error;
  }

  return {
    ok: true,
    provider: 'cloudflare-workers-ai',
    model,
    response: extractText(payload),
    usage: payload?.result?.usage ?? payload?.usage ?? null
  };
}

export async function runWorkersAiDiagnostic(env, fetchImpl = fetch) {
  const result = await runWorkersAiText(env, {
    model: WORKERS_AI_MODELS.writer,
    system: 'You are a connectivity test. Follow the user instruction exactly.',
    prompt: 'Reply only with OK',
    maxTokens: 16,
    temperature: 0
  }, fetchImpl);

  return {
    ok: result.ok && /^ok[.!]?$/i.test(result.response),
    provider: result.provider,
    model: result.model,
    response: result.response,
    usage: result.usage
  };
}
