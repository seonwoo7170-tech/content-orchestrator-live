import test from 'node:test';
import assert from 'node:assert/strict';
import { getPost } from '../src/lib/blogger.js';

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

function post(id, url) {
  return {
    id,
    blog: { id: '11' },
    title: `Existing ${id}`,
    content: '<p>Hello old post.</p>',
    labels: ['guide'],
    url,
    status: 'LIVE'
  };
}

test('Blogger URL-only lookup uses getByPath so old posts are not limited to the newest 20', async () => {
  const calls = [];
  const fetchImpl = googleMock(async (url) => {
    calls.push(url);
    if (url.endsWith('/blogs/11')) {
      return new Response(JSON.stringify({ id: '11', locale: { language: 'en' } }), { status: 200 });
    }
    assert.match(url, /\/blogs\/11\/posts\/bypath\?path=%2F2024%2F08%2Fold\.html&view=ADMIN$/);
    return new Response(JSON.stringify(post('99', 'https://custom.example/2024/08/old.html')), { status: 200 });
  });

  const result = await getPost(GOOGLE_ENV, {
    blogId: '11',
    targetUrl: 'https://custom.example/2024/08/old.html'
  }, fetchImpl);

  assert.equal(result.identity.bloggerPostId, '99');
  assert.equal(result.identity.permalink, 'https://custom.example/2024/08/old.html');
  assert.equal(calls.some((url) => url.includes('maxResults=20')), false);
});

test('Blogger ID 404 can fall back to the exact target path when the recovered ID is unchanged', async () => {
  let directCalls = 0;
  let pathCalls = 0;
  const fetchImpl = googleMock(async (url) => {
    if (url.endsWith('/blogs/11')) {
      return new Response(JSON.stringify({ id: '11', locale: { language: 'en' } }), { status: 200 });
    }
    if (/\/blogs\/11\/posts\/22\?view=ADMIN$/.test(url)) {
      directCalls += 1;
      return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
    }
    if (url.includes('/blogs/11/posts/bypath?')) {
      pathCalls += 1;
      return new Response(JSON.stringify(post('22', 'https://custom.example/2024/08/exact.html')), { status: 200 });
    }
    throw new Error(`UNEXPECTED_URL:${url}`);
  });

  const result = await getPost(GOOGLE_ENV, {
    blogId: '11',
    bloggerPostId: '22',
    targetUrl: 'https://custom.example/2024/08/exact.html'
  }, fetchImpl);

  assert.equal(result.identity.bloggerPostId, '22');
  assert.equal(directCalls, 1);
  assert.equal(pathCalls, 1);
});

test('Blogger path fallback never silently swaps a stored post ID', async () => {
  const fetchImpl = googleMock(async (url) => {
    if (url.endsWith('/blogs/11')) {
      return new Response(JSON.stringify({ id: '11', locale: { language: 'en' } }), { status: 200 });
    }
    if (/\/blogs\/11\/posts\/22\?view=ADMIN$/.test(url)) {
      return new Response(JSON.stringify({}), { status: 404 });
    }
    if (url.includes('/blogs/11/posts/bypath?')) {
      return new Response(JSON.stringify(post('23', 'https://custom.example/2024/08/exact.html')), { status: 200 });
    }
    throw new Error(`UNEXPECTED_URL:${url}`);
  });

  await assert.rejects(
    () => getPost(GOOGLE_ENV, {
      blogId: '11',
      bloggerPostId: '22',
      targetUrl: 'https://custom.example/2024/08/exact.html'
    }, fetchImpl),
    /BLOGGER_POST_ID_MISMATCH/
  );
});

test('Blogger getByPath result must match the requested URL path', async () => {
  const fetchImpl = googleMock(async (url) => {
    if (url.endsWith('/blogs/11')) {
      return new Response(JSON.stringify({ id: '11', locale: { language: 'en' } }), { status: 200 });
    }
    if (url.includes('/blogs/11/posts/bypath?')) {
      return new Response(JSON.stringify(post('99', 'https://custom.example/2024/08/different.html')), { status: 200 });
    }
    throw new Error(`UNEXPECTED_URL:${url}`);
  });

  await assert.rejects(
    () => getPost(GOOGLE_ENV, {
      blogId: '11',
      targetUrl: 'https://custom.example/2024/08/exact.html'
    }, fetchImpl),
    /BLOGGER_POST_URL_MISMATCH/
  );
});
