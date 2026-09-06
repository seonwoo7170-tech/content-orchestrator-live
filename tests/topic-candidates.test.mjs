import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySearchIntent, calculateOpportunityScore } from '../worker/lib/topic-candidates.js';

test('search intent classification stays deterministic for Korean and English query cues', () => {
  assert.equal(classifySearchIntent('에어컨 청소 방법'), 'informational');
  assert.equal(classifySearchIntent('노트북 추천 비교'), 'commercial');
  assert.equal(classifySearchIntent('윈도우 정품 가격 할인'), 'transactional');
  assert.equal(classifySearchIntent('구글 애널리틱스 공식 로그인'), 'navigational');
  assert.equal(classifySearchIntent('best ai tools review'), 'commercial');
  assert.equal(classifySearchIntent('buy graphics card price'), 'transactional');
});

test('opportunity score uses only supplied GSC evidence and is monotonic with impressions', () => {
  const low = calculateOpportunityScore({ impressions: 10, clicks: 0, position: 12 });
  const high = calculateOpportunityScore({ impressions: 100, clicks: 0, position: 12 });
  assert.ok(Number.isFinite(low));
  assert.ok(Number.isFinite(high));
  assert.ok(high > low);
  assert.equal(calculateOpportunityScore({ impressions: 0, clicks: 0, position: 0 }), 0);
});
