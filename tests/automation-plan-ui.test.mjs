import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ui = fs.readFileSync(new URL('../web/automation.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../web/automation.css', import.meta.url), 'utf8');

test('daily target is no longer hidden behind a separate fixed-target checkbox', () => {
  assert.doesNotMatch(ui, /설정한 일일 작업 수 고정/);
  assert.match(ui, /fixedDailyTargets: true/);
  assert.match(ui, /하루 신규 글 수/);
  assert.match(ui, /하루 리페어 최대 수/);
});

test('reservation controls visually and functionally disable when reservation publishing is off', () => {
  assert.match(ui, /PUBLISH_CONTROL_NAMES/);
  assert.match(ui, /syncPublishControls/);
  assert.match(ui, /!autoPublishEnabled/);
  assert.match(css, /automation-field-disabled/);
  assert.match(ui, /예약 발행 OFF · 글 작성\/리페어는 계속 실행/);
});

test('settings save immediately replans today and preview compares configured target with actual workload', () => {
  assert.match(ui, /\/api\/operations\/plan-today/);
  assert.match(ui, /\/api\/operations\/workload\/today/);
  assert.match(ui, /설정 목표 신규/);
  assert.match(ui, /오늘 실제 계획 신규/);
  assert.match(ui, /오늘 실제 계획 미생성 · 자동 복구 대기/);
  assert.match(css, /automation-plan-alert/);
});
