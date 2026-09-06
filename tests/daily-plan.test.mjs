import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailySlots, dateInTimeZone } from '../worker/lib/daily-plan.js';

test('Seoul operation date rolls after UTC afternoon', () => {
  assert.equal(dateInTimeZone(new Date('2026-08-28T15:30:00Z')), '2026-08-29');
});

test('daily policy creates one new and one repair slot per blog', () => {
  const slots = buildDailySlots(
    [{ blogId: '1', name: 'A' }, { blogId: '2', name: 'B' }],
    '2026-08-29'
  );
  assert.equal(slots.length, 4);
  assert.deepEqual(
    slots.map((slot) => slot.kind),
    ['new_article', 'repair_existing', 'new_article', 'repair_existing']
  );
});
