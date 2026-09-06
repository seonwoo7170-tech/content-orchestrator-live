import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cards = await readFile(new URL('../web/work-cards.js', import.meta.url), 'utf8');
const sw = await readFile(new URL('../web/sw.js', import.meta.url), 'utf8');

test('ready work cards distinguish preparation, reservation, confirmation and completion', () => {
  assert.match(cards, /작성 완료 · 이미지 대기/);
  assert.match(cards, /이미지 처리 중/);
  assert.match(cards, /발행 준비 완료/);
  assert.match(cards, /예약발행 대기/);
  assert.match(cards, /발행 확인 중/);
  assert.match(cards, /발행 처리 중/);
  assert.match(cards, /발행 완료/);
  assert.match(cards, /리페어 완료/);
  assert.match(cards, /업데이트 예약/);
  assert.match(cards, /업데이트 확인 중/);
  assert.match(cards, /publicationStatusLabel/);
  assert.doesNotMatch(cards, /status === 'scheduled'\) return .*발행 완료/);
  assert.match(cards, /\/api\/operations\/publications\/today/);
});

test('scheduled publication boundary asks the server to verify Blogger instead of inferring completion locally', () => {
  assert.match(cards, /status === 'scheduled'\) return '예약발행 대기'/);
  assert.match(cards, /publicationBoundaryTimer/);
  assert.match(cards, /schedulePublicationBoundaryRefresh/);
  assert.match(cards, /publicationBoundaryTimer = setTimeout\(\(\) => \{\s*void refreshPublicationStates\(\)/);
});

test('pre-publish preview uses the persisted article when no Blogger URL exists', () => {
  assert.match(cards, /Smileseon 내부 미리보기/);
  assert.match(cards, /sanitizePreviewHtml/);
  assert.match(cards, /Content-Security-Policy/);
  assert.match(cards, /result\?\.article/);
  assert.doesNotMatch(cards, /아직 Blogger 글 주소가 없습니다\. 결과 보기에서 작성 결과를 확인해 주세요/);
});

test('publication-aware queue keeps preview available and refreshes after queue changes', () => {
  assert.match(cards, /preview-readable/);
  assert.match(cards, /orchestrator:jobs-changed/);
  assert.match(cards, /refreshPublicationStates/);
  assert.match(cards, /refreshReadyCards/);
});

test('current PWA carries publication labels and the live sequential progress module', () => {
  assert.match(sw, /const CACHE = 'content-orchestrator-v\d+'/);
  assert.match(sw, /\.\/work-cards\.js/);
  assert.match(sw, /\.\/work-live-progress\.js/);
  assert.match(sw, /\.\/live-work-progress\.js/);
});