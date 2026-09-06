import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isPublicationDue, scheduledMinuteForSlot, validatePublicationResult } from '../worker/lib/auto-publisher.js';

const settings = {
  enabled: true,
  autoPublishEnabled: true,
  approvalMode: 'auto',
  publishStartTime: '09:00',
  publishIntervalMinutes: 30,
  publishJitterMinutes: 5,
  maxPublishesPerDay: 4,
  imagesEnabled: true,
  bodyImageCount: 2
};

const cleanArticle = {
  title: '윈도우 파일 이름을 한 번에 바꾸는 방법',
  topic: '윈도우 파일 이름 변경',
  language: 'ko',
  searchDescription: '여러 파일의 이름을 순서대로 정리하는 방법과 실수하기 쉬운 부분을 설명합니다.',
  labels: ['Windows'],
  sources: [],
  html: '<p>파일이 많다면 먼저 복사본으로 시험해 보세요.</p><h2>탐색기에서 바꾸기</h2><p>파일을 선택한 뒤 이름 바꾸기를 실행하면 순서 번호가 붙습니다.</p><h2>확인할 점</h2><p>확장자를 표시한 상태에서는 확장자까지 지우지 않도록 확인하세요.</p>'
};

const cleanResult = {
  status: 'READY',
  article: cleanArticle,
  finalCritic: { status: 'PASS', score: 100, issues: [] }
};

test('scheduled publication slots use deterministic 30±5 minute gaps', () => {
  const minutes = [1, 2, 3, 4].map((slot) => scheduledMinuteForSlot(settings, slot, '2026-08-31', 'homefix'));
  for (let index = 1; index < minutes.length; index += 1) {
    const gap = minutes[index] - minutes[index - 1];
    assert.ok(gap >= 25 && gap <= 35, `gap ${gap} should be within 25..35`);
  }
  assert.equal(scheduledMinuteForSlot(settings, 1, '2026-08-31', 'homefix'), minutes[0]);
  assert.equal(isPublicationDue(settings, 1), true);
  assert.equal(isPublicationDue(settings, 4), true);
  assert.equal(isPublicationDue(settings, 5), false);
});

test('approval mode and disabled automation never become schedulable', () => {
  assert.equal(isPublicationDue({ ...settings, approvalMode: 'approval' }, 1), false);
  assert.equal(isPublicationDue({ ...settings, autoPublishEnabled: false }, 1), false);
  assert.equal(isPublicationDue({ ...settings, enabled: false }, 1), false);
});

test('publication exit check requires critic, lint, thumbnail and planned body images', () => {
  const images = [
    { role: 'thumbnail', status: 'attached' },
    { role: 'body', status: 'attached' },
    { role: 'body', status: 'attached' }
  ];
  assert.equal(validatePublicationResult(cleanResult, settings, images).ok, true);
  assert.equal(validatePublicationResult({ ...cleanResult, finalCritic: { status: 'PASS', score: 94, issues: [] } }, settings, images).reason, 'FINAL_CRITIC_NOT_CLEAN');
  assert.equal(validatePublicationResult(cleanResult, settings, images.slice(1)).reason, 'THUMBNAIL_NOT_ATTACHED');
  assert.equal(validatePublicationResult(cleanResult, settings, images.slice(0, 2)).reason, 'IMAGES_NOT_ATTACHED');
});

test('image checks are skipped only when blog image automation is disabled', () => {
  assert.equal(validatePublicationResult(cleanResult, { ...settings, imagesEnabled: false }, []).ok, true);
});

test('publisher scans recent carryover plan dates instead of only today', async () => {
  const source = await readFile(new URL('../worker/lib/auto-publisher.js', import.meta.url), 'utf8');
  assert.match(source, /CARRYOVER_LOOKBACK_DAYS\s*=\s*2/);
  assert.match(source, /s\.plan_date BETWEEN date\(\?, \?\) AND \?/);
  assert.match(source, /ORDER BY s\.plan_date, s\.slot_no/);
});
