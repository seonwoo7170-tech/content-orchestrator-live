import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AUTOMATION_SETTINGS,
  buildAutomationPreview,
  buildDailySlotsFromAutomation,
  deterministicPublishJitter,
  normalizeAutomationSettings,
  publishTimeForSlot,
  resolveContentLanguage,
  scheduledMinuteForPublish
} from '../worker/lib/automation-settings.js';

test('normalizes safe defaults and validates publish time, jitter and language', () => {
  const value = normalizeAutomationSettings({ publishStartTime: '08:30', publishIntervalMinutes: 30, publishJitterMinutes: 5 });
  assert.equal(value.publishStartTime, '08:30');
  assert.equal(value.publishIntervalMinutes, 30);
  assert.equal(value.publishJitterMinutes, 5);
  assert.equal(value.autoPublishEnabled, false);
  assert.equal(value.contentLanguage, 'auto');
  assert.throws(() => normalizeAutomationSettings({ publishStartTime: '25:00' }), /PUBLISH_START_TIME_INVALID/);
  assert.throws(() => normalizeAutomationSettings({ publishJitterMinutes: 61 }), /PUBLISH_JITTER_INVALID/);
  assert.throws(() => normalizeAutomationSettings({ contentLanguage: 'jp' }), /CONTENT_LANGUAGE_INVALID/);
});

test('daily operation defaults to 09:00 and accepts a management-center override', () => {
  assert.equal(DEFAULT_AUTOMATION_SETTINGS.dailyOperationStartTime, '09:00');
  assert.equal(normalizeAutomationSettings({}).dailyOperationStartTime, '09:00');
  assert.equal(normalizeAutomationSettings({ dailyOperationStartTime: '07:30' }).dailyOperationStartTime, '07:30');
  assert.throws(() => normalizeAutomationSettings({ dailyOperationStartTime: '25:00' }), /DAILY_OPERATION_START_TIME_INVALID/);
});

test('automatic content language follows Blogger locale while explicit setting wins', () => {
  assert.equal(resolveContentLanguage('auto', 'ko'), 'ko');
  assert.equal(resolveContentLanguage('auto', 'en-US'), 'en');
  assert.equal(resolveContentLanguage('en', 'ko'), 'en');
  assert.equal(resolveContentLanguage('ko', 'en'), 'ko');
  assert.equal(resolveContentLanguage('auto', null), 'ko');
});

test('per-blog effective settings drive daily slot counts', () => {
  const blogs = [
    { blogId: '1', name: 'Homefix' },
    { blogId: '2', name: 'Recovery' },
    { blogId: '3', name: 'Paused' }
  ];
  const automation = {
    global: DEFAULT_AUTOMATION_SETTINGS,
    blogs: [
      { blogId: '1', effective: { ...DEFAULT_AUTOMATION_SETTINGS, newArticlesPerDay: 2, repairsEnabled: false } },
      { blogId: '2', effective: { ...DEFAULT_AUTOMATION_SETTINGS, newArticlesEnabled: false, repairsPerDay: 2 } },
      { blogId: '3', effective: { ...DEFAULT_AUTOMATION_SETTINGS, enabled: false } }
    ]
  };
  const slots = buildDailySlotsFromAutomation(blogs, '2026-08-29', automation);
  assert.deepEqual(slots.map((item) => [item.blogId, item.kind, item.slotNo]), [
    ['1', 'new_article', 1],
    ['1', 'new_article', 2],
    ['2', 'repair_existing', 1],
    ['2', 'repair_existing', 2]
  ]);
});

test('30±5 schedule is deterministic and every same-blog gap stays between 25 and 35 minutes', () => {
  const settings = {
    ...DEFAULT_AUTOMATION_SETTINGS,
    publishStartTime: '09:00',
    publishIntervalMinutes: 30,
    publishJitterMinutes: 5
  };
  const times = [1, 2, 3, 4].map((slot) => scheduledMinuteForPublish(settings, '2026-08-31', 'homefix', slot));
  const repeated = [1, 2, 3, 4].map((slot) => scheduledMinuteForPublish(settings, '2026-08-31', 'homefix', slot));
  assert.deepEqual(times, repeated);
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index] - times[index - 1];
    assert.ok(gap >= 25 && gap <= 35, `gap ${gap} should be within 25..35`);
  }
  assert.ok(Math.abs(deterministicPublishJitter('2026-08-31', 'homefix', 'start', 5)) <= 5);
  assert.match(publishTimeForSlot(settings, '2026-08-31', 'homefix', 1), /^\d{2}:\d{2}$/);
});

test('preview exposes fixed target mode, resolved language and jittered reservation times', () => {
  const automation = {
    global: DEFAULT_AUTOMATION_SETTINGS,
    blogs: [
      {
        blogId: '1', name: 'Homefix', inheritGlobal: false, detectedLanguage: 'ko', resolvedLanguage: 'ko',
        effective: {
          ...DEFAULT_AUTOMATION_SETTINGS,
          fixedDailyTargets: true,
          newArticlesPerDay: 2,
          repairsPerDay: 2,
          autoPublishEnabled: true,
          approvalMode: 'auto',
          publishStartTime: '09:00',
          publishIntervalMinutes: 30,
          publishJitterMinutes: 5,
          maxPublishesPerDay: 4
        }
      },
      {
        blogId: '2', name: 'Approval Only', inheritGlobal: true, detectedLanguage: 'en-US', resolvedLanguage: 'en',
        effective: {
          ...DEFAULT_AUTOMATION_SETTINGS,
          autoPublishEnabled: true,
          approvalMode: 'approval'
        }
      }
    ]
  };
  const preview = buildAutomationPreview(automation, '2026-08-31');
  assert.equal(preview.dailyOperationStartTime, '09:00');
  assert.equal(preview.timezone, 'Asia/Seoul');
  assert.equal(preview.blogs[0].publishing.times.length, 4);
  assert.equal(preview.blogs[0].publishing.intervalMinutes, 30);
  assert.equal(preview.blogs[0].publishing.jitterMinutes, 5);
  assert.equal(preview.blogs[0].work.fixedDailyTargets, true);
  assert.deepEqual(preview.blogs[1].publishing.times, []);
  assert.equal(preview.blogs[0].resolvedLanguage, 'ko');
  assert.equal(preview.blogs[1].resolvedLanguage, 'en');
  assert.equal(preview.totalAutoPublishes, 4);
});
