import test from 'node:test';
import assert from 'node:assert/strict';
import { planTopic, validatePlannedTopic } from '../src/lib/topic-planner.js';

function aiMock(response) {
  return {
    async run(model, body) {
      assert.equal(model, '@cf/openai/gpt-oss-120b');
      assert.equal(body.messages[0].role, 'system');
      assert.match(body.messages[0].content, /conservative blog topic planner/);
      assert.match(body.messages[0].content, /do not default every English topic to \"How to\"/i);
      return { response, usage: { input_tokens: 10, output_tokens: 5 } };
    }
  };
}

test('topic planner returns one validated non-duplicate topic through the primary provider', async () => {
  const result = await planTopic(
    { WRITER_MODEL: '@cf/openai/gpt-oss-120b' },
    {
      blogId: '11',
      blogName: 'HomeFix',
      blogUrl: 'https://example.com',
      language: 'en',
      operationMode: 'growth',
      recentPosts: [{ title: 'How to Stop a Running Toilet', labels: ['plumbing'] }]
    },
    aiMock(JSON.stringify({ topic: 'How to Test a GFCI Outlet Before Replacing It' }))
  );
  assert.equal(result.topic, 'How to Test a GFCI Outlet Before Replacing It');
  assert.equal(result.provider, 'cloudflare-workers-ai');
  assert.equal(result.fallbackUsed, false);
});

test('topic planner rejects exact recent-title duplicates after normalization', () => {
  assert.throws(
    () => validatePlannedTopic(
      { topic: 'How to Stop a Running Toilet!' },
      { recentPosts: [{ title: 'How to Stop a Running Toilet' }] }
    ),
    /TOPIC_PLANNER_DUPLICATE_TITLE/
  );
});

test('topic planner validates required language, blog identity, and topic length', async () => {
  await assert.rejects(() => planTopic({}, { blogId: '', blogName: 'x', language: 'en' }), /TOPIC_PLANNER_BLOG_ID_REQUIRED/);
  await assert.rejects(() => planTopic({}, { blogId: '1', blogName: '', language: 'en' }), /TOPIC_PLANNER_BLOG_NAME_REQUIRED/);
  await assert.rejects(() => planTopic({}, { blogId: '1', blogName: 'x', language: 'ja' }), /TOPIC_PLANNER_LANGUAGE_INVALID/);
  assert.throws(() => validatePlannedTopic({ topic: 'too short' }), /TOPIC_PLANNER_TOPIC_LENGTH_INVALID/);
});
