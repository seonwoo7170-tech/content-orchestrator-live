import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicQaAllowsPublish, runDeterministicQualityGate } from '../worker/lib/deterministic-quality-gate.js';

function article(overrides = {}) {
  return {
    title: '윈도우 안전 모드 진입 방법',
    topic: '윈도우 안전 모드',
    language: 'ko',
    searchDescription: '윈도우 문제를 점검할 때 안전 모드로 진입하는 방법을 단계별로 설명합니다.',
    labels: ['Windows'],
    sources: [],
    html: '<p>안전 모드는 기본 드라이버만 불러와 문제 원인을 좁힐 때 사용합니다.</p><h2>설정에서 진입하기</h2><p>복구 메뉴의 고급 시작 옵션을 사용하면 재부팅 뒤 안전 모드를 선택할 수 있습니다.</p>',
    ...overrides
  };
}

test('deterministic QA permits clean content and keeps advisory signals non-blocking', () => {
  const result = runDeterministicQualityGate(article());
  assert.notEqual(result.status, 'BLOCK');
  assert.equal(deterministicQaAllowsPublish(result), true);
  assert.equal(result.version, 'smileseon-deterministic-qa.v1');
});

test('deterministic QA blocks unresolved placeholders instead of trusting model score', () => {
  const result = runDeterministicQualityGate(article({ html: '<p>TODO: 실제 절차를 여기에 작성</p>' }));
  assert.equal(result.status, 'BLOCK');
  assert.equal(deterministicQaAllowsPublish(result), false);
  assert.ok(result.issues.some((item) => item.code === 'PLACEHOLDER_TODO'));
});

test('deterministic QA blocks executable script and javascript links', () => {
  const result = runDeterministicQualityGate(article({ html: '<p><a href="javascript:alert(1)">링크</a></p><script>alert(1)</script>' }));
  assert.equal(result.status, 'BLOCK');
  assert.ok(result.issues.some((item) => item.code === 'UNSAFE_JAVASCRIPT_URL'));
  assert.ok(result.issues.some((item) => item.code === 'ARTICLE_SCRIPT_TAG_BLOCKED'));
});
