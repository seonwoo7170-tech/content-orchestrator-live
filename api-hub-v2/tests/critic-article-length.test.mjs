import test from 'node:test';
import assert from 'node:assert/strict';
import { critic } from '../src/lib/ai-routes.js';

// The critic used to be told to estimate the article's word count itself and compare it to an
// editorial band. It cannot: smileinfo.net published 33 posts at a median of 873 words against a
// band asking for 1,500-2,500, and the critic passed them. The length is now counted in code and
// supplied as measuredLength, and the critic is told not to estimate or dispute it. A shortfall
// is still tied to CONTENT COMPLETENESS -- it must name the missing content and point at a block
// to expand -- so repair has something concrete to act on rather than a bare "too short".

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
  assert.match(systemText, /measuredLength is supplied with the Article and was counted in code, not estimated/);
  assert.match(systemText, /Do not estimate the length yourself and do not dispute these numbers/);
  assert.match(systemText, /emit CORE_INFORMATION_MISSING against the block or blocks that should be expanded/);
  assert.match(systemText, /Never emit a length finding on its own with no missing-content reason/);
  // Asking the critic to estimate is the defect being removed, so it must not come back.
  assert.doesNotMatch(systemText, /Estimate the Article's total word count/);

  // And the number itself has to actually reach the model.
  const userPayload = JSON.parse(requestBody.messages[1].content);
  assert.equal(typeof userPayload.measuredLength?.chars, 'number');
  assert.equal(userPayload.measuredLength.chars, 'Body.'.length);
  assert.equal(userPayload.measuredLength.belowFloor, true);
  assert.ok(userPayload.measuredLength.floorChars > 0);
});
