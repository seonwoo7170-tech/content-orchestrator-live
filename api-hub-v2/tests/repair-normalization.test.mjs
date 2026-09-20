import test from 'node:test';
import assert from 'node:assert/strict';
import { critic, repair, writer } from '../src/lib/ai-routes.js';

function aiMock(handler) {
  return {
    async run(model, body) {
      return handler(model, body);
    }
  };
}

function article() {
  return {
    title: 'Test title',
    html: '<h2>First section</h2><p>Useful answer.</p>',
    searchDescription: 'Useful answer.',
    labels: ['test'],
    sources: [],
    language: 'en',
    topic: 'test topic'
  };
}

test('Writer and Critic Blogger adapters explicitly keep post H1 outside body HTML', async () => {
  const systems = [];
  const binding = aiMock((model, body) => {
    const system = body.messages?.[0]?.content || '';
    systems.push(system);
    if (system.includes('AUTOMATION WRITER ADAPTER')) {
      return { response: JSON.stringify({ article: article() }) };
    }
    if (system.includes('COMPLIANCE CRITIC ADAPTER')) {
      return { response: JSON.stringify({ status: 'PASS', score: 100, issues: [] }) };
    }
    throw new Error('unexpected Workers AI call');
  });

  await writer(
    { WRITER_MODEL: '@cf/openai/gpt-oss-120b' },
    { blogId: '11', topic: 'test topic', language: 'en' },
    binding
  );
  await critic(
    { CRITIC_MODEL: '@cf/openai/gpt-oss-120b' },
    { article: article() },
    binding,
    async () => { throw new Error('GEMINI_MUST_NOT_RUN_FOR_CRITIC'); }
  );

  assert.match(systems[0], /do not duplicate the title as an <h1> inside html/i);
  assert.match(systems[1], /absence of an <h1> element inside Article\.html is NOT a defect/);
  assert.match(systems[1], /must never be reported as MISSING_H1_IN_HTML/);
});

test('Repair accepts a direct Article object', async () => {
  const fixed = article();
  fixed.html = '<h2>First section</h2><p>Shorter answer.</p>';

  const result = await repair(
    { REPAIR_MODEL: '@cf/openai/gpt-oss-120b' },
    { article: article(), issues: [{ code: 'READABILITY' }] },
    aiMock(() => ({ response: JSON.stringify(fixed) }))
  );

  assert.equal(result.article.html, fixed.html);
  assert.equal(result.article.language, 'en');
});

test('Repair also normalizes a nested {article: Article} model response', async () => {
  const fixed = article();
  fixed.html = '<h2>First section</h2><p>Repaired answer.</p>';

  const result = await repair(
    { REPAIR_MODEL: '@cf/openai/gpt-oss-120b' },
    { article: article(), issues: [{ code: 'READABILITY' }] },
    aiMock(() => ({ response: JSON.stringify({ article: fixed }) }))
  );

  assert.equal(result.article.title, fixed.title);
  assert.equal(result.article.html, fixed.html);
  assert.ok(!result.article.article);
});

test('Repair rejects a language-changing response', async () => {
  const changed = article();
  changed.language = 'ko';

  await assert.rejects(
    () => repair(
      { REPAIR_MODEL: '@cf/openai/gpt-oss-120b' },
      { article: article(), issues: [{ code: 'READABILITY' }] },
      aiMock(() => ({ response: JSON.stringify(changed) }))
    ),
    /REPAIR_LANGUAGE_MISMATCH/
  );
});
