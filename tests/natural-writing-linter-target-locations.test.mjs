import test from 'node:test';
import assert from 'node:assert/strict';
import { lintNaturalWriting } from '../worker/lib/natural-writing-linter.js';

const EXACT_LOCATION = /^html (p|h2|h3|li|blockquote) \d+$/;

function article(html) {
  return {
    title: '반복 문체 위치 계약 테스트',
    html,
    searchDescription: '반복 문체가 정확한 HTML 블록 위치로 반환되는지 확인합니다.',
    labels: [],
    sources: [],
    language: 'ko',
    topic: '문체 점검'
  };
}

test('blocking repeated connector and ending issues are machine-targetable exact blocks', () => {
  const result = lintNaturalWriting(article(`
    <p>특히 첫 단계에서는 현재 상태를 확인할 수 있습니다.</p>
    <p>특히 두 번째 단계에서는 원인을 분리할 수 있습니다.</p>
    <p>특히 세 번째 단계에서는 설정을 비교할 수 있습니다.</p>
    <p>특히 네 번째 단계에서는 변경 결과를 확인할 수 있습니다.</p>
    <p>마지막으로 문제가 반복되면 다른 원인을 점검하는 것이 중요합니다.</p>
    <p>증상이 바뀌면 기준을 다시 확인하는 것이 중요합니다.</p>
    <p>업데이트 뒤에는 결과를 기록하는 것이 중요합니다.</p>
    <p>복구 뒤에는 같은 증상이 재현되는지 확인하는 것이 중요합니다.</p>
  `));

  assert.equal(result.status, 'BLOCK');
  const targeted = result.blockingIssues.filter((item) => [
    'REPEATED_CONNECTOR',
    'CONNECTOR_STREAK',
    'REPEATED_SENTENCE_ENDING'
  ].includes(item.code));
  assert.ok(targeted.length >= 4);
  for (const item of targeted) assert.match(item.location, EXACT_LOCATION);
  assert.equal(targeted.some((item) => item.location === 'article body'), false);
  assert.equal(targeted.some((item) => item.location.includes(' through ')), false);
});

test('duplicate sentence blockers target only exact duplicate blocks', () => {
  const repeated = '같은 문장을 여러 블록에 반복하면 리페어가 정확한 위치를 알아야 합니다.';
  const result = lintNaturalWriting(article(`
    <p>첫 문단은 고유한 설명입니다.</p>
    <p>${repeated}</p>
    <p>중간 문단도 고유한 설명입니다.</p>
    <p>${repeated}</p>
  `));

  const duplicates = result.blockingIssues.filter((item) => item.code === 'DUPLICATE_SENTENCE');
  assert.ok(duplicates.length >= 1);
  for (const item of duplicates) assert.match(item.location, EXACT_LOCATION);
  assert.equal(duplicates.some((item) => item.location.includes(',')), false);
});
