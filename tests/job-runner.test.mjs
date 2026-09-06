import test from 'node:test';
import assert from 'node:assert/strict';
import { executeJob, fetchExistingBloggerPost } from '../worker/lib/job-runner.js';

const baseArticle = {
  title: 'Original', html: '<p>original</p>', searchDescription: 'desc', language: 'ko', topic: 'topic', labels: [], sources: []
};
const repairedArticle = { ...baseArticle, html: '<p>repaired</p>' };
const issue = { code:'SOURCE_WEAK', severity:'HIGH', location:'html p 1', reason:'weak', repairInstruction:'fix only html p 1' };

function router(responses, seen) {
  return async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift();
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
}

test('existing job fetches original Blogger post then rewrites it before Critic and keeps the same identity', async () => {
  const seen = [];
  const rewrittenArticle = { ...baseArticle, title: 'Original - Updated Guide', html: '<p>fresh rewrite</p>' };
  const fetchImpl = router([
    { body: { blogId:'b1', bloggerPostId:'p1', permalink:'https://example.com/x', article: baseArticle } },
    { body: { article: rewrittenArticle } },
    { body: { status:'FAIL', score:90, issues:[issue] } },
    { body: { article: repairedArticle } },
    { body: { status:'PASS', score:98, issues:[] } }
  ], seen);
  const result = await executeJob({ API_HUB_BASE_URL:'https://hub.example', HUB_API_KEY:'secret' }, { mode:'repair_existing', blogId:'b1', bloggerPostId:'p1' }, fetchImpl);
  assert.equal(result.status, 'READY_TO_UPDATE_EXISTING');
  assert.equal(result.identity.bloggerPostId, 'p1');
  assert.equal(result.rewriteApplied, true);
  assert.match(seen[0].url, /\/api\/blogger\/post\/get$/);
  assert.equal(seen[1].body.rewriteExisting, true);
  assert.equal(seen[1].body.rewriteSource.title, 'Original');
  assert.equal(Object.hasOwn(seen[1].body.rewriteSource, 'html'), false);
  assert.equal(seen[3].body.strategy, 'targeted_sections_only');
  assert.deepEqual(seen[3].body.preserve, ['blogId','bloggerPostId','permalink']);
});

test('existing post fetch rejects changed Blogger Post ID', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ blogId:'b1', bloggerPostId:'different', article: baseArticle }), { status:200 });
  await assert.rejects(() => fetchExistingBloggerPost({ API_HUB_BASE_URL:'https://hub.example', HUB_API_KEY:'secret' }, { blogId:'b1', bloggerPostId:'p1' }, fetchImpl), /BLOGGER_POST_ID_CHANGED/);
});
