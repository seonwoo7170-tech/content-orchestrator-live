import test from 'node:test';
import assert from 'node:assert/strict';
import { writePost } from '../src/lib/blogger.js';

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REFRESH_TOKEN: 'refresh-token'
};

function googleMock(handler) {
  return async (url, init = {}) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), { status: 200 });
    }
    assert.equal(init.headers?.authorization, 'Bearer access-token');
    return handler(String(url), init);
  };
}

test('scheduled create uses draft insert then posts.publish with future publishDate and same post id', async () => {
  const calls = [];
  const publishDate = '2026-08-31T10:17:00+09:00';
  const fetchImpl = googleMock(async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('/posts?isDraft=true')) {
      assert.equal(init.method, 'POST');
      return new Response(JSON.stringify({ id: 'scheduled-33', title: 'Scheduled', status: 'DRAFT' }), { status: 200 });
    }
    assert.match(url, /\/blogs\/11\/posts\/scheduled-33\/publish\?publishDate=/);
    assert.equal(init.method, 'POST');
    return new Response(JSON.stringify({
      id: 'scheduled-33',
      title: 'Scheduled',
      status: 'SCHEDULED',
      url: 'https://example.blogspot.com/2026/08/scheduled.html'
    }), { status: 200 });
  });

  const result = await writePost(GOOGLE_ENV, {
    blogId: '11',
    operation: 'create',
    publishMode: 'scheduled',
    publishDate,
    article: { title: 'Scheduled', html: '<p>body</p>', labels: [] }
  }, fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(result.publishMode, 'scheduled');
  assert.equal(result.bloggerPostId, 'scheduled-33');
  assert.equal(result.status, 'SCHEDULED');
  assert.equal(result.publishDate, new Date(publishDate).toISOString());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[1].method, 'POST');
});

test('scheduled create fails closed if Blogger changes post identity during publish', async () => {
  const fetchImpl = googleMock(async (url) => {
    if (url.includes('/posts?isDraft=true')) {
      return new Response(JSON.stringify({ id: '33', title: 'Scheduled', status: 'DRAFT' }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'DIFFERENT', title: 'Scheduled', status: 'SCHEDULED' }), { status: 200 });
  });

  await assert.rejects(() => writePost(GOOGLE_ENV, {
    blogId: '11',
    operation: 'create',
    publishMode: 'scheduled',
    publishDate: '2026-08-31T10:17:00+09:00',
    article: { title: 'Scheduled', html: '<p>body</p>', labels: [] }
  }, fetchImpl), /BLOGGER_POST_ID_CHANGED_DURING_SCHEDULE/);
});
