import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContentClusters,
  buildInternalLinkRecommendations,
  detectCannibalization,
  tokenizeTopic,
  topicSimilarity
} from '../worker/lib/content-strategy.js';

test('topic tokenization and similarity stay deterministic across Korean strategy phrases', () => {
  assert.deepEqual(tokenizeTopic('에어컨 필터 청소 방법'), ['에어컨', '필터', '청소']);
  assert.ok(topicSimilarity('에어컨 필터 청소', '에어컨 실내기 청소') > topicSimilarity('에어컨 필터 청소', '노트북 배터리 교체'));
});

test('content clustering never crosses blog boundaries and chooses highest opportunity hub', () => {
  const rows = [
    { id: 1, blog_id: 'b1', query: '에어컨 필터 청소', opportunity_score: 20, impressions: 30, target_page: 'https://one.example/filter' },
    { id: 2, blog_id: 'b1', query: '에어컨 필터 청소 냄새 제거', opportunity_score: 80, impressions: 100, target_page: 'https://one.example/smell' },
    { id: 3, blog_id: 'b2', query: '에어컨 필터 청소', opportunity_score: 99, impressions: 200, target_page: 'https://two.example/filter' }
  ];
  const clusters = buildContentClusters(rows);
  const b1 = clusters.find((cluster) => cluster.blogId === 'b1' && cluster.members.length === 2);
  assert.ok(b1);
  assert.equal(b1.hubCandidateId, 2);
  assert.ok(clusters.some((cluster) => cluster.blogId === 'b2' && cluster.members.length === 1));
});

test('internal link recommendations only connect distinct pages inside the same cluster', () => {
  const rows = [
    { id: 1, blog_id: 'b1', query: '에어컨 청소 냄새 제거', opportunity_score: 80, target_page: 'https://example.com/hub?x=1' },
    { id: 2, blog_id: 'b1', query: '에어컨 필터 청소 냄새', opportunity_score: 50, target_page: 'https://example.com/spoke#part' }
  ];
  const clusters = buildContentClusters(rows);
  const links = buildInternalLinkRecommendations(clusters, rows);
  assert.equal(links.length, 1);
  assert.equal(links[0].sourceUrl, 'https://example.com/spoke');
  assert.equal(links[0].targetUrl, 'https://example.com/hub');
  assert.equal(links[0].blogId, 'b1');
});

test('cannibalization detection is evidence based and never invents a conflict from one page', () => {
  const rows = [
    { snapshot_date: '2026-09-01', blog_id: 'b1', query: '에어컨 청소', page: 'https://example.com/a', impressions: 70, clicks: 4 },
    { snapshot_date: '2026-09-01', blog_id: 'b1', query: '에어컨 청소', page: 'https://example.com/b', impressions: 30, clicks: 2 },
    { snapshot_date: '2026-09-01', blog_id: 'b1', query: '세탁기 청소', page: 'https://example.com/c', impressions: 50, clicks: 3 }
  ];
  const conflicts = detectCannibalization(rows);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].query, '에어컨 청소');
  assert.equal(conflicts[0].primaryPage, 'https://example.com/a');
  assert.ok(['repair_internal_links', 'review_merge', 'review_intent_split'].includes(conflicts[0].decision));
});
