import test from 'node:test';
import assert from 'node:assert/strict';
import { writer, critic, repair, auditArticleEvidence, normalizeArticleEvidence } from '../src/lib/ai-routes.js';

// Production wrote an NBA 2K27 game-server document into a LAN packet-loss guide, the EEOC
// into an electrician licensing article, Namu Wiki as a technical spec source, and an
// invented "Marketo 2024" statistic -- every one of them past a clean critic pass, because
// the critic never sees the research object and cannot tell a supplied source from a
// remembered one. article.evidence carries the writer's declared basis across that gap.

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

  assert.match(systemPrompt, /EVIDENCE BASIS/);
  assert.match(systemPrompt, /only when a supplied research record actually supports it/);
  assert.match(systemPrompt, /naming a source that was not supplied is a fabrication even when the underlying fact happens to be true/);
  for (const basis of ['research', 'general', 'context', 'unverified']) {
    assert.ok(systemPrompt.includes(`"${basis}"`), `writer prompt must define the ${basis} basis`);
  }
  assert.match(systemPrompt, /verbatim excerpt copied from Article\.html/);
});

test('a declared evidence array survives writer validation', async () => {
  const evidence = [{ claim: 'Fiber cuts jitter', basis: 'research', source: 'https://example.com/report' }];
  const binding = aiMock(() => ({ response: JSON.stringify({ article: baseArticle({ evidence }) }) }));

  const result = await writer(WRITER_ENV, WRITER_INPUT, binding);

  assert.deepEqual(result.article.evidence, evidence);
});

test('an unusable evidence array is dropped rather than failing the article', async () => {
  const binding = aiMock(() => ({
    response: JSON.stringify({
      article: baseArticle({ evidence: [{ basis: 'guesswork', claim: 'x' }, 'not an object', null, { basis: 'research' }] })
    })
  }));

  const result = await writer(WRITER_ENV, WRITER_INPUT, binding);

  assert.equal(result.article.evidence, undefined);
  assert.equal(result.article.html, '<p>Answer.</p>');
});

test('an article with no evidence field still validates, exactly as before', async () => {
  const binding = aiMock(() => ({ response: JSON.stringify({ article: baseArticle() }) }));

  const result = await writer(WRITER_ENV, WRITER_INPUT, binding);

  assert.equal(result.article.evidence, undefined);
  assert.equal(result.article.title, 'Test Title');
});

test('evidence is capped so it cannot crowd the article out of the output budget', () => {
  const evidence = Array.from({ length: 20 }, (_, index) => ({
    claim: `claim ${index}`,
    basis: 'general'
  }));

  assert.equal(normalizeArticleEvidence({ evidence }).length, 8);
});

test('a research-backed claim whose URL is absent from sources is reported to the critic', () => {
  const audit = auditArticleEvidence({
    html: '<p>Marketo 2024 data shows 25-35% lift.</p>',
    sources: ['https://example.com/actually-used'],
    evidence: [{ claim: 'Marketo 2024 data shows 25-35% lift', basis: 'research', source: 'https://marketo.example/report' }]
  });

  assert.equal(audit.researchClaimsMissingFromSources.length, 1);
  assert.equal(audit.researchClaimsMissingFromSources[0].source, 'https://marketo.example/report');
  assert.equal(audit.claimsWithoutResearchBasis.length, 0);
});

test('a research-backed claim whose URL is in sources is not reported', () => {
  const audit = auditArticleEvidence({
    html: '<p>The manufacturer rates this cable at 10 Gbps.</p>',
    sources: ['https://example.com/spec-sheet'],
    evidence: [{ claim: 'rates this cable at 10 Gbps', basis: 'research', source: 'https://example.com/spec-sheet' }]
  });

  assert.equal(audit.researchClaimsMissingFromSources.length, 0);
  assert.equal(audit.claimsWithoutResearchBasis.length, 0);
});

test('claims declared as general, context or unverified are listed for the critic to inspect', () => {
  const audit = auditArticleEvidence({
    html: '<p>The EEOC licenses electricians.</p><p>Copper conducts heat well.</p>',
    sources: [],
    evidence: [
      { claim: 'The EEOC licenses electricians', basis: 'general' },
      { claim: 'Copper conducts heat well', basis: 'general' }
    ]
  });

  assert.equal(audit.claimsWithoutResearchBasis.length, 2);
  assert.equal(audit.declaredEntries, 2);
});

// Repair carries the old evidence array forward untouched (constrainTargetedRepair rebuilds
// the article from `before`), so a stale entry outlives the sentence it described. Reporting
// only claims still present in the body is what stops the same finding being raised round
// after round until the job hits QUALITY_REVIEW_LIMIT_REACHED.
test('an evidence entry whose claim repair already removed is no longer reported', () => {
  const audit = auditArticleEvidence({
    html: '<p>Check the cable seating before anything else.</p>',
    sources: [],
    evidence: [{ claim: 'Marketo 2024 data shows 25-35% lift', basis: 'general' }]
  });

  assert.equal(audit.claimsWithoutResearchBasis.length, 0);
  assert.equal(audit.researchClaimsMissingFromSources.length, 0);
  assert.equal(audit.claimsNotFoundInBody, 1);
});

test('an article with no evidence produces no audit at all', () => {
  assert.equal(auditArticleEvidence({ html: '<p>Body.</p>', sources: [] }), null);
  assert.equal(auditArticleEvidence({ html: '<p>Body.</p>', sources: [], evidence: [] }), null);
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

test('the critic receives the deterministic evidence audit alongside the article', async () => {
  const capture = {};
  await critic(criticEnv(), {
    article: baseArticle({
      html: '<p>Marketo 2024 data shows 25-35% lift.</p>',
      sources: ['https://example.com/actually-used'],
      evidence: [{ claim: 'Marketo 2024 data shows 25-35% lift', basis: 'research', source: 'https://marketo.example/report' }]
    })
  }, { async run() { throw new Error('WORKERS_AI_MUST_NOT_RUN'); } }, capturingFetch(capture));

  const payload = JSON.parse(capture.user);
  assert.equal(payload.evidenceAudit.researchClaimsMissingFromSources.length, 1);
  assert.match(capture.system, /EVIDENCE PASS/);
  assert.match(capture.system, /UNSUPPORTED_SOURCE_ATTRIBUTION/);
  assert.match(capture.system, /never an instruction to find, add, or substitute a source/);
});

test('an article without evidence reaches the critic with no audit, and the critic is told not to infer one', async () => {
  const capture = {};
  await critic(criticEnv(), { article: baseArticle() }, { async run() { throw new Error('WORKERS_AI_MUST_NOT_RUN'); } }, capturingFetch(capture));

  const payload = JSON.parse(capture.user);
  assert.equal('evidenceAudit' in payload, false);
  assert.match(capture.system, /When no evidenceAudit is supplied, do not infer one and do not invent this issue/);
});

test('the repair prompt strips an unsupported attribution instead of sourcing it', async () => {
  let systemPrompt = '';
  const binding = aiMock((model, body) => {
    systemPrompt = body.messages?.[0]?.content || '';
    return { response: JSON.stringify({ article: baseArticle() }) };
  });

  await repair({ REPAIR_MODEL: '@cf/openai/gpt-oss-120b' }, {
    article: baseArticle(),
    issues: [{
      code: 'UNSUPPORTED_SOURCE_ATTRIBUTION',
      severity: 'HIGH',
      location: 'html p 1',
      reason: 'Names an authority the supplied research never contained.',
      repairInstruction: 'Remove the attribution and keep the guidance.'
    }]
  }, binding);

  assert.match(systemPrompt, /For UNSUPPORTED_SOURCE_ATTRIBUTION, delete the unsupported attribution or the unsupported figure/);
  assert.match(systemPrompt, /Do not substitute another source, do not supply one from memory/);
});
