import test from 'node:test';
import assert from 'node:assert/strict';
import { writer } from '../src/lib/ai-routes.js';

function aiMock(handler) {
  return { async run(model, body) { return handler(model, body); } };
}

function baseArticle(overrides = {}) {
  return {
    title: 'Test Title',
    html: '<p>Answer.</p>',
    searchDescription: 'Answer.',
    labels: [],
    sources: [],
    language: 'en',
    topic: 'test topic',
    ...overrides
  };
}

test('the writer prompt asks for a thumbnailHook distinct from the title, not just a title restatement', async () => {
  let systemPrompt = '';
  const binding = aiMock((model, body) => {
    systemPrompt = body.messages?.[0]?.content || '';
    return { response: JSON.stringify({ article: baseArticle({ thumbnailHook: 'Try This First' }) }) };
  });

  await writer({ WRITER_MODEL: '@cf/openai/gpt-oss-120b' }, { blogId: '11', topic: 'test topic', language: 'en' }, binding);

  assert.match(systemPrompt, /thumbnailHook/);
  assert.match(systemPrompt, /clearly different from the title/);
  assert.match(systemPrompt, /at most 22 characters for Korean/);
});

test('a thumbnailHook returned by the provider survives writer validation instead of being stripped', async () => {
  const binding = aiMock(() => ({
    response: JSON.stringify({ article: baseArticle({ thumbnailHook: 'Try This First' }) })
  }));

  const result = await writer({ WRITER_MODEL: '@cf/openai/gpt-oss-120b' }, { blogId: '11', topic: 'test topic', language: 'en' }, binding);

  assert.equal(result.article.thumbnailHook, 'Try This First');
});

test('writer output without a thumbnailHook still validates (field stays optional for backward compatibility)', async () => {
  const binding = aiMock(() => ({ response: JSON.stringify({ article: baseArticle() }) }));

  const result = await writer({ WRITER_MODEL: '@cf/openai/gpt-oss-120b' }, { blogId: '11', topic: 'test topic', language: 'en' }, binding);

  assert.equal(result.article.thumbnailHook, undefined);
});
