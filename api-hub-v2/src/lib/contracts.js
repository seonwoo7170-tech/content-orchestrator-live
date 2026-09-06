export function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    const error = new Error('INVALID_JSON');
    error.status = 400;
    throw error;
  }
}

function responseApiText(container) {
  if (!container || typeof container !== 'object') return '';
  if (typeof container.output_text === 'string') return container.output_text.trim();
  if (!Array.isArray(container.output)) return '';

  const parts = [];
  for (const item of container.output) {
    if (typeof item?.text === 'string') parts.push(item.text);
    if (!Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      if (typeof content?.text === 'string') parts.push(content.text);
      else if (typeof content?.output_text === 'string') parts.push(content.output_text);
    }
  }
  return parts.join('\n').trim();
}

export function parseModelText(data) {
  const direct = data?.result?.response ?? data?.response ?? data?.result?.text ?? data?.text;
  if (typeof direct === 'string') return direct.trim();
  const choice = data?.result?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice.trim();

  const responsesText = responseApiText(data?.result) || responseApiText(data);
  if (responsesText) return responsesText;
  return '';
}

function balancedJsonCandidate(text, start) {
  const opener = text[start];
  const closer = opener === '{' ? '}' : (opener === '[' ? ']' : null);
  if (!closer) return null;
  const stack = [closer];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      if (stack[stack.length - 1] !== char) return null;
      stack.pop();
      if (stack.length === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function parseEmbeddedJson(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{' && text[index] !== '[') continue;
    const candidate = balancedJsonCandidate(text, index);
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* inspect the next possible JSON start */ }
  }
  return null;
}

export function parseJsonText(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const embedded = parseEmbeddedJson(cleaned);
    if (embedded !== null) return embedded;
    const error = new Error('AI_PROVIDER_JSON_INVALID');
    error.status = 502;
    throw error;
  }
}

export const MASTER_V45 = Object.freeze({
  fileName: 'universal_blog_master_prompt_ko_en_verified_v4_5_final.md',
  size: 93282,
  sha256: '0df7c83bb3874c4802ca7c02306beee7cd7032366930d66abfc7fa1bdb6cda66'
});
