import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTourApiAttractionTopic } from '../worker/lib/tour-api-topic.js';

const SMILEATLAS_BLOG_ID = '4712699686222371580';

function attraction(contentId, title) {
  return { contentId, title, contentTypeId: '76' };
}

test('returns null for a blog that is not TourAPI-connected', async () => {
  const result = await selectTourApiAttractionTopic({}, {
    blogId: '999',
    callHubFn: async () => ({ attractions: [attraction('1', '경복궁')] })
  });
  assert.equal(result, null);
});

test('returns null when no callHubFn is supplied', async () => {
  const result = await selectTourApiAttractionTopic({}, { blogId: SMILEATLAS_BLOG_ID });
  assert.equal(result, null);
});

test('picks the first unused attraction and returns its topic plus tourApiContentId', async () => {
  const calls = [];
  const result = await selectTourApiAttractionTopic({}, {
    blogId: SMILEATLAS_BLOG_ID,
    language: 'ko',
    recentPosts: [],
    callHubFn: async (env, path, body) => {
      calls.push({ path, body });
      return { attractions: [attraction('126508', '경복궁')] };
    }
  });
  assert.equal(calls[0].path, '/api/hub/tour/attractions');
  assert.ok(calls[0].body.lDongRegnCd);
  assert.equal(result.tourApiContentId, '126508');
  assert.match(result.topic, /경복궁/);
});

test('builds an English topic phrase when language is en', async () => {
  const result = await selectTourApiAttractionTopic({}, {
    blogId: SMILEATLAS_BLOG_ID,
    language: 'en',
    callHubFn: async () => ({ attractions: [attraction('1', 'Gyeongbokgung Palace')] })
  });
  assert.match(result.topic, /Gyeongbokgung Palace/);
  assert.match(result.topic, /Visiting/);
});

test('skips an attraction whose title already appears in recent posts', async () => {
  const result = await selectTourApiAttractionTopic({}, {
    blogId: SMILEATLAS_BLOG_ID,
    recentPosts: [{ title: '경복궁 여행 전 꼭 알아야 할 것들' }],
    callHubFn: async () => ({ attractions: [attraction('1', '경복궁'), attraction('2', '창덕궁')] })
  });
  assert.equal(result.tourApiContentId, '2');
});

test('skips an attraction whose contentId is in excludeContentIds', async () => {
  const result = await selectTourApiAttractionTopic({}, {
    blogId: SMILEATLAS_BLOG_ID,
    excludeContentIds: ['1'],
    callHubFn: async () => ({ attractions: [attraction('1', '경복궁'), attraction('2', '창덕궁')] })
  });
  assert.equal(result.tourApiContentId, '2');
});

test('moves to the next region when a region call fails or returns nothing usable', async () => {
  let calls = 0;
  const result = await selectTourApiAttractionTopic({}, {
    blogId: SMILEATLAS_BLOG_ID,
    callHubFn: async () => {
      calls += 1;
      if (calls === 1) throw new Error('TOUR_API_HTTP_502');
      if (calls === 2) return { attractions: [] };
      return { attractions: [attraction('9', '해운대')] };
    }
  });
  assert.equal(calls, 3);
  assert.equal(result.tourApiContentId, '9');
});

test('returns null when every region is exhausted with nothing unused', async () => {
  const result = await selectTourApiAttractionTopic({}, {
    blogId: SMILEATLAS_BLOG_ID,
    recentPosts: [{ title: '경복궁 여행 전 꼭 알아야 할 것들' }],
    callHubFn: async () => ({ attractions: [attraction('1', '경복궁')] })
  });
  assert.equal(result, null);
});

test('env.TOUR_API_CONNECTED_BLOG_IDS lets a different blog opt in', async () => {
  const result = await selectTourApiAttractionTopic({ TOUR_API_CONNECTED_BLOG_IDS: '555' }, {
    blogId: '555',
    callHubFn: async () => ({ attractions: [attraction('1', '남산타워')] })
  });
  assert.equal(result.tourApiContentId, '1');
});
