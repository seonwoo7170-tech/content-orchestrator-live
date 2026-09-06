import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const buildStage = fs.readFileSync(new URL('../web/build-stage.js', import.meta.url), 'utf8');
const buildStageCss = fs.readFileSync(new URL('../web/build-stage.css', import.meta.url), 'utf8');

test('dashboard loads the full build-stage renderer and styles', () => {
  assert.match(index, /build-stage\.js/);
  assert.match(index, /build-stage\.css/);
  assert.match(index, /구축 단계/);
});

test('build roadmap covers phases 0 through 9 and marks phase 6 current', () => {
  assert.match(buildStage, /CURRENT_BUILD_PHASE\s*=\s*6/);
  for (let phase = 0; phase <= 9; phase += 1) assert.match(buildStage, new RegExp(`phase:\\s*${phase}\\b`));
  assert.match(buildStage, /외부 유입 자동화/);
});

test('each roadmap phase exposes expandable implementation details', () => {
  assert.match(buildStage, /<details class="phase-entry/);
  assert.match(buildStage, /자세히 보기/);
  assert.match(buildStage, /접기/);
  assert.match(buildStage, /item\.items\.map/);
  assert.match(buildStage, /GitHub 저장소와 배포 구조/);
  assert.match(buildStage, /Writer → Critic → Targeted Repair → Final Critic/);
  assert.match(buildStage, /이미지 생성과 본문 중간 분산 배치/);
  assert.match(buildStageCss, /phase-entry\[open\]/);
});

test('roadmap exposes completion count, percent and item-level status', () => {
  assert.match(buildStage, /getPhaseProgress/);
  assert.match(buildStage, /phase-progress-summary/);
  assert.match(buildStage, /phase-progress-track/);
  assert.match(buildStage, /phase-item-status/);
  assert.match(buildStage, /\$\{progress\.done\}\/\$\{progress\.total\} 완료/);
  assert.match(buildStage, /status: 'active'/);
  assert.match(buildStageCss, /phase-item-status\.done/);
  assert.match(buildStageCss, /phase-item-status\.active/);
  assert.match(buildStageCss, /phase-item-status\.planned/);
});

test('phase 5 is complete and Phase 6 has only the live Pinterest connection step active', () => {
  assert.match(buildStage, /검색의도 · 키워드 · 주제 후보 관리', status: 'done'/);
  assert.match(buildStage, /아이디어뱅크와 적용 흐름', status: 'done'/);
  assert.match(buildStage, /외부 유입 채널별 콘텐츠 변환', status: 'done'/);
  assert.match(buildStage, /Pinterest 등 채널 배포 자동화', status: 'active'/);
  assert.match(buildStage, /원문과 외부 콘텐츠 연결 추적', status: 'done'/);
  assert.match(buildStage, /유입 성과 기반 채널 운영 최적화', status: 'done'/);
});
