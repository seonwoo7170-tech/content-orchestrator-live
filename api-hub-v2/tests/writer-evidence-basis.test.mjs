import test from 'node:test';
import assert from 'node:assert/strict';
import { writer, critic, repair } from '../src/lib/ai-routes.js';

// Production wrote an NBA 2K27 game-server document into a LAN packet-loss guide, the EEOC
// into an electrician licensing article, Namu Wiki as a technical spec source, and an
// invented "Marketo 2024" statistic. The writer-side prohibition against naming a source the
// research never supplied is what survives of the 2026-09-21 attempt to fix that; the
// declared evidence array and the critic pass that read it are gone, because comparing a
// declared URL against Article.sources compares two different sets and reported jobs 215 and
// 220 -- both citing a real TourAPI record -- as fabrications until they ran out of
// continuations.

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

const WRITER_ENV = Object.freeze({ WRITER_MODEL: '@cf/openai/gpt-oss-120b' });
const WRITER_INPUT = Object.freeze({ blogId: '11', topic: 'test topic', language: 'en' });

test('the writer prompt forbids naming an authority the supplied research never contained', async () => {
  let systemPrompt = '';
  const binding = aiMock((model, body) => {
    systemPrompt = body.messages?.[0]?.content || '';
    return { response: JSON.stringify({ article: baseArticle() }) };
  });

  await writer(WRITER_ENV, WRITER_INPUT, binding);

  assert.match(systemPrompt, /SOURCE ATTRIBUTION/);
  assert.match(systemPrompt, /only when a supplied research record actually supports it/);
  assert.match(systemPrompt, /naming a source that was not supplied is a fabrication even when the underlying fact happens to be true/);
});

test('the writer prompt no longer asks for a declared evidence array', async () => {
  let systemPrompt = '';
  const binding = aiMock((model, body) => {
    systemPrompt = body.messages?.[0]?.content || '';
    return { response: JSON.stringify({ article: baseArticle() }) };
  });

  await writer(WRITER_ENV, WRITER_INPUT, binding);

  assert.equal(/"evidence"/.test(systemPrompt), false);
  assert.equal(/EVIDENCE BASIS/.test(systemPrompt), false);
});

test('an evidence array the model still emits is stripped instead of stored', async () => {
  const binding = aiMock(() => ({
    response: JSON.stringify({
      article: baseArticle({ evidence: [{ claim: 'x', basis: 'research', source: 'https://example.com/a' }] })
    })
  }));

  const result = await writer(WRITER_ENV, WRITER_INPUT, binding);

  assert.equal('evidence' in result.article, false);
  assert.equal(result.article.html, '<p>Answer.</p>');
});

function criticEnv() {
  return {
    FREE_AI_API_KEY: 'test-free-ai-key',
    FREE_AI_FALLBACK_ENABLED: 'true',
    FREE_AI_CRITIC_MODEL: 'qwen7b',
    CRITIC_MODEL: '@cf/openai/gpt-oss-120b'
  };
}

function capturingFetch(capture) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    capture.system = body.messages?.[0]?.content || '';
    capture.user = body.messages?.[1]?.content || '';
    return new Response(JSON.stringify({
      model: body.model,
      choices: [{ message: { content: JSON.stringify({ status: 'PASS', score: 100, issues: [] }) } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

// Jobs 215 to 223 were written with the evidence array still in place, so their stored
// articles carry one. Stripping it here keeps those retries from paying for it in the
// critic's input budget -- job 223 died on CRITIC_SCHEMA_INVALID with eight entries attached.
test('a stored evidence array never reaches the critic', async () => {
  const capture = {};
  await critic(criticEnv(), {
    article: baseArticle({
      evidence: [{ claim: 'Marketo 2024 data shows 25-35% lift', basis: 'research', source: 'https://marketo.example/report' }]
    })
  }, { async run() { throw new Error('WORKERS_AI_MUST_NOT_RUN'); } }, capturingFetch(capture));

  const payload = JSON.parse(capture.user);
  assert.equal('evidence' in payload.article, false);
  assert.equal('evidenceAudit' in payload, false);
  assert.equal(payload.article.title, 'Test Title');
});

test('the critic is no longer taught the attribution issue code it could not have repaired', async () => {
  const capture = {};
  await critic(criticEnv(), { article: baseArticle() }, { async run() { throw new Error('WORKERS_AI_MUST_NOT_RUN'); } }, capturingFetch(capture));

  assert.equal(/UNSUPPORTED_SOURCE_ATTRIBUTION/.test(capture.system), false);
  assert.equal(/EVIDENCE PASS/.test(capture.system), false);
  assert.equal(/evidenceAudit/.test(capture.system), false);
  // The passes that caught fabricated sources before any of this are untouched.
  assert.match(capture.system, /fabricated, placeholder, invalid, or unverifiable source names and URLs/);
  assert.match(capture.system, /fabricated or unsupported statistics/);
});

test('the repair prompt drops the guidance for that code too', async () => {
  let systemPrompt = '';
  const binding = aiMock((model, body) => {
    systemPrompt = body.messages?.[0]?.content || '';
    return { response: JSON.stringify({ article: baseArticle() }) };
  });

  await repair({ REPAIR_MODEL: '@cf/openai/gpt-oss-120b' }, {
    article: baseArticle(),
    issues: [{
      code: 'UNSUPPORTED_CLAIM',
      severity: 'HIGH',
      location: 'html p 1',
      reason: 'Unsupported.',
      repairInstruction: 'Qualify the statement.'
    }]
  }, binding);

  assert.equal(/UNSUPPORTED_SOURCE_ATTRIBUTION/.test(systemPrompt), false);
  assert.match(systemPrompt, /Never fabricate first-hand experience, facts, statistics, quotations, URLs, sources, or current claims/);
});
