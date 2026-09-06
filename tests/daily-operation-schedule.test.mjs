import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDailyOperationStarted, isDailyOperationDue, localClock } from '../worker/lib/daily-operation-schedule.js';

test('daily operation is due at 03:00 Asia/Seoul only inside the five-minute poll window', () => {
  const settings = { dailyOperationStartTime: '03:00', timezone: 'Asia/Seoul' };
  assert.equal(isDailyOperationDue(settings, new Date('2026-08-30T18:00:00Z')), true);
  assert.equal(isDailyOperationDue(settings, new Date('2026-08-30T18:04:59Z')), true);
  assert.equal(isDailyOperationDue(settings, new Date('2026-08-30T18:05:00Z')), false);
  assert.equal(isDailyOperationDue(settings, new Date('2026-08-30T17:59:00Z')), false);
});

test('daily operation start remains true after the initial poll window for self-healing', () => {
  const settings = { dailyOperationStartTime: '09:00', timezone: 'Asia/Seoul' };
  assert.equal(hasDailyOperationStarted(settings, new Date('2026-09-01T23:59:59Z')), false);
  assert.equal(hasDailyOperationStarted(settings, new Date('2026-09-02T00:00:00Z')), true);
  assert.equal(hasDailyOperationStarted(settings, new Date('2026-09-02T08:30:00Z')), true);
});

test('daily operation follows a management-center time change', () => {
  const settings = { dailyOperationStartTime: '07:30', timezone: 'Asia/Seoul' };
  assert.equal(isDailyOperationDue(settings, new Date('2026-08-29T22:30:00Z')), true);
  assert.equal(isDailyOperationDue(settings, new Date('2026-08-29T18:00:00Z')), false);
});

test('local clock respects the configured timezone', () => {
  assert.deepEqual(localClock(new Date('2026-08-30T18:00:00Z'), 'Asia/Seoul'), { hour: 3, minute: 0, minutes: 180 });
});
