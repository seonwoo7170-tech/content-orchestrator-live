import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImagePlan } from '../worker/lib/image-plan.js';

test('body image planning skips abstract headings and keeps the repair target visually dominant', () => {
  const plan = buildImagePlan({
    title: 'Threshold Repair and Restoration: Fixing Common Household Floor Transitions',
    topic: 'threshold repair and restoration for household floor transitions',
    language: 'en',
    html: [
      '<h2>Direct Answer: Repair vs. Replace</h2><p>Decision summary.</p>',
      '<h2>Decision Criteria and Materials</h2><p>Selection details.</p>',
      '<h2>Removing the damaged transition strip</h2><p>Removal details.</p>',
      '<h2>Fitting the replacement threshold</h2><p>Fit details.</p>',
      '<h2>Common Mistakes to Avoid</h2><p>Mistakes.</p>'
    ].join('')
  }, { bodyCount: 2 });

  assert.equal(plan.images.length, 3);
  assert.match(plan.images[1].prompt, /removing damaged transition strip/i);
  assert.match(plan.images[2].prompt, /fitting replacement threshold/i);
  assert.doesNotMatch(plan.images[1].prompt, /direct answer/i);
  assert.doesNotMatch(plan.images[2].prompt, /decision criteria/i);
  assert.match(plan.images[1].prompt, /dominant visual focus/i);
  assert.match(plan.images[1].prompt, /posed portrait/i);
});