import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { manualAdoptionAllowed } from '../worker/lib/manual-ready-adoption.js';

test('manual ready jobs are adoptable only into enabled automatic publication capacity', () => {
  const base = { enabled: true, autoPublishEnabled: true, approvalMode: 'auto', maxPublishesPerDay: 4 };
  assert.equal(manualAdoptionAllowed(base), true);
  assert.equal(manualAdoptionAllowed({ ...base, autoPublishEnabled: false }), false);
  assert.equal(manualAdoptionAllowed({ ...base, approvalMode: 'approval' }), false);
  assert.equal(manualAdoptionAllowed({ ...base, maxPublishesPerDay: 0 }), false);
});

test('manual adoption waits for ordinary plan and only claims unslotted ready new articles', () => {
  const source = fs.readFileSync(new URL('../worker/lib/manual-ready-adoption.js', import.meta.url), 'utf8');
  assert.match(source, /j\.mode = 'new_article'/);
  assert.match(source, /j\.status = 'ready'/);
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM daily_plan_slots s WHERE s\.job_id = j\.id\)/);
  assert.match(source, /if \(plan\.slotCount === 0\) continue/);
  assert.match(source, /if \(nextSlot > capacity\) break/);
  assert.match(source, /'new_article', \?, 'resolved'/);
});
