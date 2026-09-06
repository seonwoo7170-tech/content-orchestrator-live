import test from 'node:test';
import assert from 'node:assert/strict';
import { detectTextLanguage, listBlogs } from '../src/lib/blogger.js';

const ENV = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REFRESH_TOKEN: 'refresh-token'
};

function mockGoogle({ locale = 'ko', posts = [] } = {}) {
  return async (url, init = {}) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    }
    assert.equal(init.headers?.authorization, 'Bearer token');
    if (String(url).includes('/users/self/blogs')) {
      return new Response(JSON.stringify({
        items: [{ id: '11', name: 'Example', url: 'https://example.blogspot.com/', locale: { language: locale }, posts: { totalItems: posts.length } }]
      }), { status: 200 });
    }
    if (String(url).includes('/blogs/11/posts?')) {
      return new Response(JSON.stringify({ items: posts }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
}

test('text detector distinguishes substantial Korean and English prose', () => {
  assert.equal(detectTextLanguage('에어컨에서 물이 떨어질 때 먼저 배수 호스와 필터 상태를 확인하세요. 안전을 위해 전원을 끄고 점검해야 합니다.'), 'ko');
  assert.equal(detectTextLanguage('If a wall-mounted air conditioner starts leaking water, turn off the unit and check the drain hose, filter, and condensate pan first.'), 'en');
  assert.equal(detectTextLanguage('AC tip'), null);
});

test('recent English posts override a Korean Blogger locale', async () => {
  const result = await listBlogs(ENV, mockGoogle({
    locale: 'ko',
    posts: [
      { title: 'Fix a Leaking Air Conditioner', content: '<p>Turn off the unit first, then inspect the condensate drain hose and filter for blockage before calling a technician.</p>' },
      { title: 'Low Shower Pressure', content: '<p>Start by cleaning the shower head and checking whether the pressure is weak at other fixtures in the home.</p>' },
      { title: 'Stop a Running Toilet', content: '<p>Check the flapper, float, and fill valve in that order. Replace only the worn part after shutting off the water.</p>' }
    ]
  }));
  assert.equal(result.blogs[0].language, 'en');
});

test('recent Korean posts override an English Blogger locale', async () => {
  const result = await listBlogs(ENV, mockGoogle({
    locale: 'en',
    posts: [
      { title: '싱크대 배수구 냄새 없애는 법', content: '<p>먼저 배수구 안쪽의 음식물 찌꺼기를 제거하고 트랩에 물이 남아 있는지 확인하세요. 냄새가 계속되면 배관 연결부를 점검합니다.</p>' },
      { title: '샤워기 수압이 약할 때', content: '<p>샤워기 헤드의 물때를 청소한 뒤 집 안 다른 수도의 수압도 함께 확인하면 원인을 좁히기 쉽습니다.</p>' },
      { title: '변기 물이 계속 흐를 때', content: '<p>급수 밸브를 잠그고 플래퍼와 부구 상태를 차례대로 확인한 다음 손상된 부품만 교체하세요.</p>' }
    ]
  }));
  assert.equal(result.blogs[0].language, 'ko');
});
