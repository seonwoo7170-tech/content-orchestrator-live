import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const router = fs.readFileSync(new URL('../src/lib/ai-provider-router.js', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../src/lib/ai-routes.js', import.meta.url), 'utf8');

test('provider router validates semantic JSON before accepting Gemini, Free.ai or Workers AI output', () => {
  assert.match(router, /function assertProviderSemanticResponse/);
  assert.match(router, /validateResponse\(parseJsonText\(result\?\.response\)\)/);
  assert.match(router, /runGeminiWithRetry\(env, gemini, fetchImpl, validateResponse\)/);
  assert.match(router, /runFreeAiFallback\(env, freeAiRequest, fetchImpl, validateResponse\)/);
  assert.match(router, /CLOUDFLARE_AI_JSON_INVALID'\), validateResponse/);
});

test('writer supplies the full Article validator to the provider fallback chain', () => {
  assert.match(routes, /aiBinding, fetchImpl, \(parsed\) => validateWriterArticle\(parsed, \{ topic, language \}\)\)/);
  assert.match(routes, /validateArticleShape\(value, input, 'WRITER'\)/);
  assert.match(routes, /\$\{prefix\}_ARTICLE_\$\{key\.toUpperCase\(\)\}_REQUIRED/);
});
