import test from 'node:test';
import assert from 'node:assert/strict';
import { critic } from '../src/lib/ai-routes.js';

// Master v4.5 Section 26 (기사 길이) sets editorial length bands (Breaking/Straight News
// ~800-1,500 words; Standard News/Explainer ~1,500-2,500; Deep-Dive ~2,500-4,000), but the
// critic rubric never checked them -- a real production test article passed at 96/100 with
// only 641 words, well under even the shortest band. The critic system prompt now ties a
// clearly-under-band word count to the existing CONTENT COMPLETENESS PASS instead of adding
// a bare, unlocatable "too short" issue, so repair still has a concrete block to expand.

const ENV = Object.freeze({ CRITIC_MODEL: '@cf/openai/gpt-oss-120b' });

const ARTICLE = {
  title: 'Test',
  html: '<p>Body.</p>',
  searchDescription: 'Description',
  labels: [],
  sources: [],
  language: 'en',
  topic: 'topic'
};

test('critic system instruction ties under-length articles to CORE_INFORMATION_MISSING, not a standalone length issue', async () => {
  const binding = {
    async run() {
      return { response: JSON.stringify({ status: 'PASS', score: 100, issues: [] }) };
    }
  };
  let requestBody = null;
  const bindingWithCapture = {
    async run(model, body) {
      requestBody = body;
      return binding.run();
    }
  };

  await critic(ENV, { article: ARTICLE }, bindingWithCapture, async () => { throw new Error('unexpected'); });

  const systemText = requestBody.messages[0].content;
  assert.match(systemText, /ARTICLE LENGTH PASS/);
  assert.match(systemText, /Breaking\/Straight News ~800-1,500 words/);
  assert.match(systemText, /Standard News\/Explainer ~1,500-2,500 words/);
  assert.match(systemText, /Deep-Dive ~2,500-4,000 words/);
  assert.match(systemText, /emit CORE_INFORMATION_MISSING pointing at the block\(s\) that should be expanded/);
  assert.match(systemText, /Never emit a length finding on its own with no missing-content reason/);
  assert.match(systemText, /never as a standalone length defect/);
});
