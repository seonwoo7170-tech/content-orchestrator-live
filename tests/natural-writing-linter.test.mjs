import test from 'node:test';
import assert from 'node:assert/strict';
import { lintNaturalWriting } from '../worker/lib/natural-writing-linter.js';

function article(html, language = 'ko') {
  return {
    title: language === 'ko' ? 'PC가 갑자기 느려졌을 때 확인할 순서' : 'What to check when a PC suddenly slows down',
    html,
    searchDescription: language === 'ko' ? '갑자기 느려진 PC에서 먼저 확인할 항목을 순서대로 설명합니다.' : 'A practical order for checking a suddenly slow PC.',
    labels: ['guide'],
    sources: [],
    language,
    topic: language === 'ko' ? 'PC 속도 점검' : 'PC slowdown checks'
  };
}

test('natural writing linter passes concise concrete Korean prose', () => {
  const result = lintNaturalWriting(article(`
    <p>컴퓨터가 갑자기 느려졌다면 포맷부터 하지 마세요.</p>
    <p>먼저 작업 관리자를 열어 CPU, 메모리, 디스크 사용률 중 무엇이 계속 높은지 확인하세요.</p>
    <h2>디스크 사용률이 높은 경우</h2>
    <p>파일 복사나 업데이트가 진행 중이면 끝날 때까지 기다린 뒤 다시 확인합니다.</p>
    <p>아무 작업도 없는데 디스크가 계속 100%라면 시작 프로그램과 저장장치 상태를 차례로 점검하세요.</p>
  `));

  assert.equal(result.status, 'PASS');
  assert.equal(result.blockingIssues.length, 0);
  assert.equal(result.flags.length, 0);
  assert.equal(result.riskScore, 0);
});

test('natural writing linter blocks strong stock AI phrases and duplicate sentences', () => {
  const result = lintNaturalWriting(article(`
    <p>현대 사회에서 컴퓨터 성능의 중요성이 더욱 커지고 있습니다.</p>
    <p>이제 해결 방법을 함께 살펴보겠습니다.</p>
    <p>이 방법을 사용하면 문제를 확인할 수 있습니다.</p>
    <p>이 방법을 사용하면 문제를 확인할 수 있습니다.</p>
    <p>도움이 되셨기를 바랍니다.</p>
  `));

  assert.equal(result.status, 'BLOCK');
  assert.ok(result.blockingIssues.some((item) => item.code === 'AI_STYLE_CLICHE'));
  assert.ok(result.blockingIssues.some((item) => item.code === 'DUPLICATE_SENTENCE'));
  assert.ok(result.riskScore > 0);
});

test('natural writing linter ignores a table-of-contents item that echoes its section heading', () => {
  const result = lintNaturalWriting(article(`
    <ul><li>Know when the repair is no longer small</li></ul>
    <p>Check the fixture first and shut off the water if needed.</p>
    <h2>Know when the repair is no longer small</h2>
    <p>Call a plumber when the valve will not close or water damage is spreading.</p>
  `, 'en'));

  assert.equal(result.blockingIssues.some((item) => item.code === 'DUPLICATE_SENTENCE'), false);
  assert.notEqual(result.status, 'BLOCK');
});

test('natural writing linter still blocks true duplicate body sentences even when a TOC exists', () => {
  const result = lintNaturalWriting(article(`
    <ul><li>Check the shutoff valve</li></ul>
    <h2>Check the shutoff valve</h2>
    <p>Turn off the supply before loosening the connection.</p>
    <p>Turn off the supply before loosening the connection.</p>
  `, 'en'));

  assert.equal(result.status, 'BLOCK');
  assert.ok(result.blockingIssues.some((item) => item.code === 'DUPLICATE_SENTENCE'));
});

test('natural writing linter blocks excessive connector-led cadence', () => {
  const result = lintNaturalWriting(article(`
    <p>또한 작업 관리자를 먼저 확인하세요.</p>
    <p>또한 시작 프로그램을 확인하세요.</p>
    <p>또한 저장 공간을 확인하세요.</p>
    <p>또한 업데이트 진행 여부를 확인하세요.</p>
  `));

  assert.equal(result.status, 'BLOCK');
  assert.ok(result.blockingIssues.some((item) => item.code === 'REPEATED_CONNECTOR'));
  assert.ok(result.blockingIssues.some((item) => item.code === 'CONNECTOR_STREAK'));
});

test('natural writing linter flags but does not block a single generic low-information sentence', () => {
  const result = lintNaturalWriting(article(`
    <p>컴퓨터가 느리면 먼저 현재 실행 중인 작업을 확인하세요.</p>
    <p>상황에 맞는 선택이 중요합니다.</p>
    <p>디스크가 가득 찼다면 불필요한 파일부터 정리하세요.</p>
  `));

  assert.equal(result.status, 'FLAG');
  assert.equal(result.blockingIssues.length, 0);
  assert.ok(result.flags.some((item) => item.code === 'LOW_INFORMATION_BOILERPLATE'));
});

test('natural writing linter catches common English stock phrasing', () => {
  const result = lintNaturalWriting(article(`
    <p>In today's fast-paced world, computer performance matters more than ever.</p>
    <p>Let's dive in and explore the available options.</p>
    <p>Check Task Manager first to see which resource is saturated.</p>
  `, 'en'));

  assert.equal(result.status, 'BLOCK');
  assert.ok(result.blockingIssues.filter((item) => item.code === 'AI_STYLE_CLICHE').length >= 2);
});
