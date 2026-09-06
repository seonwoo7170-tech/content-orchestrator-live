import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTargetedRepairPreserved, constrainTargetedRepair } from '../worker/lib/targeted-repair-guard.js';

function article(html, extra = {}) {
  return {
    title: 'Test title',
    html,
    searchDescription: 'Description',
    labels: ['test'],
    sources: [],
    language: 'en',
    topic: 'test topic',
    ...extra
  };
}

function issue(location) {
  return {
    code: 'READABILITY',
    severity: 'LOW',
    location,
    reason: 'Needs a small repair.',
    repairInstruction: 'Change only the flagged location.'
  };
}

test('guard allows only the explicitly targeted HTML block to change', () => {
  const before = article('<p>Keep one.</p><h2>Keep heading.</h2><p>Change me.</p><p>Keep four.</p>');
  const after = article('<p>Keep one.</p><h2>Keep heading.</h2><p>Changed only here.</p><p>Keep four.</p>');
  assert.equal(assertTargetedRepairPreserved(before, after, [issue('html p 3')]), true);
});

test('constraint discards model drift outside the targeted block', () => {
  const before = article('<p>Target.</p><p>Do not touch.</p>');
  const candidate = article('<p>Target repaired.</p><p>Model drifted here too.</p>', { title: 'Unwanted title change' });
  const constrained = constrainTargetedRepair(before, candidate, [issue('html p 1')]);
  assert.equal(constrained.title, before.title);
  assert.equal(constrained.html, '<p>Target repaired.</p><p>Do not touch.</p>');
  assert.equal(assertTargetedRepairPreserved(before, constrained, [issue('html p 1')]), true);
});

test('constraint keeps an explicitly targeted field but restores all other fields', () => {
  const before = article('<p>Keep body.</p>');
  const candidate = article('<p>Unwanted body rewrite.</p>', {
    searchDescription: 'Improved description',
    labels: ['changed']
  });
  const constrained = constrainTargetedRepair(before, candidate, [issue('searchDescription')]);
  assert.equal(constrained.searchDescription, 'Improved description');
  assert.deepEqual(constrained.labels, before.labels);
  assert.equal(constrained.html, before.html);
  assert.equal(assertTargetedRepairPreserved(before, constrained, [issue('searchDescription')]), true);
});

test('constraint still fails closed when model changes HTML structure', () => {
  const before = article('<p>Target.</p><p>Keep.</p>');
  const candidate = article('<p>Target repaired.</p><p>Keep.</p><p>Added block.</p>');
  assert.throws(
    () => constrainTargetedRepair(before, candidate, [issue('html p 1')]),
    /TARGETED_REPAIR_CHANGED_HTML_STRUCTURE/
  );
});

test('guard rejects changes to an unflagged HTML block', () => {
  const before = article('<p>Target.</p><p>Do not touch.</p>');
  const after = article('<p>Target repaired.</p><p>Also changed.</p>');
  assert.throws(
    () => assertTargetedRepairPreserved(before, after, [issue('html p 1')]),
    /TARGETED_REPAIR_CHANGED_UNTARGETED_HTML_BLOCK/
  );
});

test('guard rejects unflagged metadata changes', () => {
  const before = article('<p>Target.</p>');
  const after = article('<p>Target repaired.</p>', { title: 'Changed title' });
  assert.throws(
    () => assertTargetedRepairPreserved(before, after, [issue('html p 1')]),
    /TARGETED_REPAIR_CHANGED_UNTARGETED_FIELD/
  );
});

test('guard allows an explicitly flagged metadata field and preserves HTML', () => {
  const before = article('<p>Keep body.</p>');
  const after = article('<p>Keep body.</p>', { searchDescription: 'Improved description' });
  assert.equal(assertTargetedRepairPreserved(before, after, [issue('searchDescription')]), true);
});

test('guard fails closed on a broad html body target when structured blocks exist', () => {
  const before = article('<p>One.</p><p>Two.</p>');
  const after = article('<p>Changed one.</p><p>Changed two.</p>');
  assert.throws(
    () => assertTargetedRepairPreserved(before, after, [issue('html body')]),
    /TARGETED_REPAIR_HTML_BODY_TARGET_TOO_BROAD/
  );
});
