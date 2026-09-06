import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/lib/auto-repair-updater.js', import.meta.url), 'utf8');

test('slotted repair jobs survive plan-date rollover for two days', () => {
  assert.match(source, /REPAIR_CARRYOVER_LOOKBACK_DAYS\s*=\s*2/);
  assert.match(source, /s\.plan_date BETWEEN date\(\?, \?\) AND \?/);
  assert.match(source, /bind\(planDate, `-\$\{REPAIR_CARRYOVER_LOOKBACK_DAYS\} days`, planDate\)/);
  assert.doesNotMatch(source, /WHERE s\.plan_date = \?/);
});

test('older slotted repair carryover is processed before newer repair slots', () => {
  assert.match(source, /ORDER BY s\.plan_date, s\.slot_no, s\.blog_id, s\.job_id/);
  assert.match(source, /planDate: String\(candidate\.plan_date\)/);
});

test('scheduled repair updates also survive midnight rollover', () => {
  assert.match(source, /p\.plan_date BETWEEN date\(\?, \?\) AND \?/);
  assert.match(source, /p\.status = 'scheduled_update'/);
  assert.match(source, /ORDER BY p\.scheduled_time, p\.plan_date, p\.blog_id, p\.slot_no/);
});
