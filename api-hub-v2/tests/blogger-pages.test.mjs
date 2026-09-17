import test from 'node:test';
import assert from 'node:assert/strict';
import { getPage, listPages, writePage } from '../src/lib/blogger-pages.js';

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

test('Blogger page inventory paginates, omits bodies, and rejects invalid input', async () => {
  const calls = [];
  const fetchImpl = mockGoogle(async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('fetchBodies'), 'false');
    assert.equal(parsed.searchParams.get('status'), 'live');
    assert.equal(parsed.searchParams.get('view'), 'ADMIN');
    if (!parsed.searchParams.get('pageToken')) {
      return new Response(JSON.stringify({
        items: [{ id: '1', title: 'Privacy Policy', url: 'https://example.com/p/privacy.html', status: 'LIVE' }],
        nextPageToken: 'next'
      }), { status: 200 });
    }
    assert.equal(parsed.searchParams.get('pageToken'), 'next');
    return new Response(JSON.stringify({
      items: [{ id: '2', title: 'About', url: 'https://example.com/p/about.html', status: 'LIVE' }]
    }), { status: 200 });
  });

  const result = await listPages(ENV, { blogId: '11', limit: 2 }, fetchImpl);
  assert.equal(result.blogId, '11');
  assert.deepEqual(result.statuses, ['live']);
  assert.equal(result.count, 2);
  assert.deepEqual(new Set(result.pages.map((page) => page.bloggerPageId)), new Set(['1', '2']));
  assert.equal(Object.hasOwn(result.pages[0], 'content'), false);
  assert.equal(calls.length, 2);

  await assert.rejects(() => listPages(ENV, { blogId: '' }), /BLOG_ID_REQUIRED/);
  await assert.rejects(() => listPages(ENV, { blogId: '11', limit: 501 }), /BLOGGER_PAGE_LIMIT_INVALID/);
  await assert.rejects(() => listPages(ENV, { blogId: '11', statuses: ['live', 'scheduled'] }), /BLOGGER_PAGE_STATUS_INVALID/);
});

test('Blogger page lookup falls back from ID to path without swapping a mismatched result', async () => {
  const fetchImpl = mockGoogle(async (url) => {
    if (/\/blogs\/11\/pages\/22\?view=ADMIN$/.test(url)) {
      return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 });
    }
    if (url.includes('/blogs/11/pages/bypath?')) {
      return new Response(JSON.stringify({
        id: '23',
        title: 'Contact',
        content: '<p>Contact us.</p>',
        url: 'https://custom.example/p/contact.html',
        status: 'LIVE'
      }), { status: 200 });
    }
    throw new Error(`UNEXPECTED_URL:${url}`);
  });

  await assert.rejects(
    () => getPage(ENV, { blogId: '11', bloggerPageId: '22', targetUrl: 'https://custom.example/p/contact.html' }, fetchImpl),
    /BLOGGER_PAGE_ID_MISMATCH/
  );
});

test('Blogger page create rejects scheduled publish mode (pages have no scheduling)', async () => {
  await assert.rejects(
    () => writePage(ENV, { blogId: '11', title: 'About', html: '<p>x</p>', publishMode: 'scheduled' }, async () => { throw new Error('must not fetch'); }),
    /BLOGGER_PAGE_PUBLISH_MODE_INVALID/
  );
});

test('Blogger page create rejects an explicit page ID (create must not target an existing page)', async () => {
  await assert.rejects(
    () => writePage(ENV, { blogId: '11', bloggerPageId: '5', title: 'About', html: '<p>x</p>' }, async () => { throw new Error('must not fetch'); }),
    /NEW_PAGE_MUST_NOT_HAVE_EXISTING_PAGE_ID/
  );
});

test('Blogger page create publishes a draft or live page and returns its identity', async () => {
  const fetchImpl = mockGoogle(async (url, init) => {
    assert.match(url, /\/blogs\/11\/pages\?isDraft=false$/);
    const body = JSON.parse(init.body);
    assert.equal(body.title, 'Privacy Policy');
    return new Response(JSON.stringify({ id: '77', title: 'Privacy Policy', url: 'https://example.com/p/privacy.html', status: 'LIVE' }), { status: 200 });
  });

  const result = await writePage(ENV, {
    blogId: '11',
    title: 'Privacy Policy',
    html: '<p>We respect your privacy.</p>',
    publishMode: 'published'
  }, fetchImpl);

  assert.equal(result.ok, true);
  assert.equal(result.bloggerPageId, '77');
  assert.equal(result.status, 'LIVE');
});

test('Blogger page update requires an existing page ID and preserves it on the write', async () => {
  await assert.rejects(
    () => writePage(ENV, { blogId: '11', operation: 'update', title: 'About', html: '<p>x</p>' }, async () => { throw new Error('must not fetch'); }),
    /BLOGGER_PAGE_ID_REQUIRED/
  );

  const fetchImpl = mockGoogle(async (url, init) => {
    assert.match(url, /\/blogs\/11\/pages\/77$/);
    assert.equal(init.method, 'PUT');
    return new Response(JSON.stringify({ id: '77', title: 'About (updated)', url: 'https://example.com/p/about.html', status: 'LIVE' }), { status: 200 });
  });

  const result = await writePage(ENV, {
    blogId: '11',
    operation: 'update',
    bloggerPageId: '77',
    title: 'About (updated)',
    html: '<p>Updated.</p>'
  }, fetchImpl);

  assert.equal(result.bloggerPageId, '77');
  assert.equal(result.title, 'About (updated)');
});
