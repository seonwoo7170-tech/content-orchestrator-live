import test from 'node:test';
import assert from 'node:assert/strict';
import { listPosts } from '../src/lib/blogger-posts.js';

const ENV = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REFRESH_TOKEN: 'refresh-token'
};

function mockGoogle(handler) {
  return async (url, init = {}) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), { status: 200 });
    }
    assert.equal(init.headers?.authorization, 'Bearer access-token');
    return handler(String(url), init);
  };
}

test('Blogger post inventory paginates, omits bodies, and sorts oldest first', async () => {
  const calls = [];
  const fetchImpl = mockGoogle(async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('fetchBodies'), 'false');
    assert.equal(parsed.searchParams.get('status'), 'live');
    assert.equal(parsed.searchParams.get('view'), 'ADMIN');
    assert.equal(parsed.searchParams.get('orderBy'), 'published');
    if (!parsed.searchParams.get('pageToken')) {
      return new Response(JSON.stringify({
        items: [
          { id: '2', title: 'Newer', url: 'https://example.com/newer', status: 'LIVE', published: '2026-02-02T00:00:00Z', labels: ['b'] },
          { id: '1', title: 'Older', url: 'https://example.com/older', status: 'LIVE', published: '2026-01-01T00:00:00Z', labels: ['a'] }
        ],
        nextPageToken: 'next'
      }), { status: 200 });
    }
    assert.equal(parsed.searchParams.get('pageToken'), 'next');
    return new Response(JSON.stringify({
      items: [{ id: '3', title: 'Newest', url: 'https://example.com/newest', status: 'LIVE', published: '2026-03-03T00:00:00Z' }]
    }), { status: 200 });
  });

  const result = await listPosts(ENV, { blogId: '11', limit: 3 }, fetchImpl);
  assert.equal(result.blogId, '11');
  assert.deepEqual(result.statuses, ['live']);
  assert.equal(result.count, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.posts.map((post) => post.bloggerPostId), ['1', '2', '3']);
  assert.deepEqual(result.posts[0].labels, ['a']);
  assert.equal(result.posts[0].status, 'live');
  assert.equal(Object.hasOwn(result.posts[0], 'content'), false);
  assert.equal(calls.length, 2);
});

test('Blogger recovery inventory can inspect live, scheduled, and draft without returning bodies', async () => {
  const seen = [];
  const fetchImpl = mockGoogle(async (url) => {
    const parsed = new URL(url);
    const status = parsed.searchParams.get('status');
    seen.push({ status, orderBy: parsed.searchParams.get('orderBy') });
    const payload = {
      live: { id: '10', title: 'Same title', status: 'LIVE', url: 'https://example.com/live', published: '2026-09-09T12:00:00Z' },
      scheduled: { id: '11', title: 'Same title', status: 'SCHEDULED', url: 'https://example.com/scheduled', published: '2026-09-09T13:00:00Z', updated: '2026-09-09T11:59:00Z' },
      draft: { id: '12', title: 'Same title', status: 'DRAFT', url: null, updated: '2026-09-09T11:58:00Z' }
    };
    return new Response(JSON.stringify({ items: [payload[status]] }), { status: 200 });
  });

  const result = await listPosts(ENV, {
    blogId: '11',
    limit: 10,
    statuses: ['live', 'scheduled', 'draft']
  }, fetchImpl);

  assert.deepEqual(result.statuses, ['live', 'scheduled', 'draft']);
  assert.equal(result.count, 3);
  assert.deepEqual(new Set(result.posts.map((post) => post.status)), new Set(['live', 'scheduled', 'draft']));
  assert.equal(result.posts.every((post) => Object.hasOwn(post, 'content') === false), true);
  assert.deepEqual(seen, [
    { status: 'live', orderBy: 'published' },
    { status: 'scheduled', orderBy: 'updated' },
    { status: 'draft', orderBy: 'updated' }
  ]);
});

test('Blogger post inventory caps the requested limit and rejects invalid input', async () => {
  await assert.rejects(() => listPosts(ENV, { blogId: '', limit: 1 }), /BLOG_ID_REQUIRED/);
  await assert.rejects(() => listPosts(ENV, { blogId: '11', limit: 2001 }), /BLOGGER_POST_LIMIT_INVALID/);
  await assert.rejects(() => listPosts(ENV, { blogId: '11', limit: 0 }), /BLOGGER_POST_LIMIT_INVALID/);
  await assert.rejects(() => listPosts(ENV, { blogId: '11', statuses: ['live', 'unknown'] }), /BLOGGER_POST_STATUS_INVALID/);
});
