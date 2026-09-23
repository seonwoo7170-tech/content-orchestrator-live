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

// The critic numbers locations per tag, not in the shared document-order sequence the
// LOCATION CONTRACT asks for. On 2026-09-22 that single mismatch accounted for the guard
// violations on jobs 208, 209, 214, 217, 218, 220 and 223; five of them reached
// QUALITY_REVIEW_LIMIT_REACHED with repairApplied false, meaning eight repair calls were
// thrown away without one edit ever landing.
test('a per-tag location resolves when the shared index does not carry that tag', () => {
  const before = article('<p>Intro.</p><h2>Heading.</h2><p>Second paragraph.</p>');
  const candidate = article('<p>Intro.</p><h2>Heading.</h2><p>Second paragraph repaired.</p>');
  // "html p 2" means the second <p>, which is block 3; block 2 is the heading.
  const constrained = constrainTargetedRepair(before, candidate, [issue('html p 2')]);
  assert.equal(constrained.html, '<p>Intro.</p><h2>Heading.</h2><p>Second paragraph repaired.</p>');
  assert.equal(assertTargetedRepairPreserved(before, constrained, [issue('html p 2')]), true);
});

test('the shared document-order reading still wins when it is valid', () => {
  const before = article('<h2>Heading.</h2><p>First paragraph.</p><p>Second paragraph.</p>');
  const candidate = article('<h2>Heading.</h2><p>First paragraph repaired.</p><p>Second paragraph.</p>');
  // Block 2 is a <p>, so "html p 2" resolves there and never falls back to the second <p>.
  const constrained = constrainTargetedRepair(before, candidate, [issue('html p 2')]);
  assert.equal(constrained.html, '<h2>Heading.</h2><p>First paragraph repaired.</p><p>Second paragraph.</p>');
});

test('a location that matches under neither reading is still rejected', () => {
  const before = article('<p>One.</p><li>Two.</li><li>Three.</li>');
  const candidate = article('<p>One changed.</p><li>Two.</li><li>Three.</li>');
  assert.throws(
    () => constrainTargetedRepair(before, candidate, [issue('html li 55')]),
    (error) => error.code === 'TARGETED_REPAIR_TARGET_NOT_FOUND'
  );
});

// Job 214: five LOW_QUALITY_SOURCE findings at "html li 55" through "html li 59", pointing at
// the link list. Shared index 55 is a paragraph there, so every attempt was discarded whole.
test("a long article's late list item resolves by its own tag count", () => {
  const paragraphs = Array.from({ length: 50 }, (_, index) => `<p>Paragraph ${index + 1}.</p>`).join('');
  const items = Array.from({ length: 6 }, (_, index) => `<li>Source ${index + 1}.</li>`).join('');
  const before = article(paragraphs + items);
  const repairedItems = items.replace('<li>Source 5.</li>', '<li>Source 5 replaced.</li>');
  const candidate = article(paragraphs + repairedItems);
  // Block 55 is a paragraph; the fifth <li> is block 55 only by tag count.
  const constrained = constrainTargetedRepair(before, candidate, [issue('html li 5')]);
  assert.match(constrained.html, /Source 5 replaced\./);
  assert.equal(assertTargetedRepairPreserved(before, constrained, [issue('html li 5')]), true);
});

test('a fixable finding still lands when another finding in the batch uses per-tag numbering', () => {
  const before = article('<p>Intro.</p><h2>Heading.</h2><p>Second.</p>');
  const candidate = article('<p>Intro repaired.</p><h2>Heading.</h2><p>Second repaired.</p>');
  const constrained = constrainTargetedRepair(before, candidate, [issue('html p 1'), issue('html p 2')]);
  assert.equal(constrained.html, '<p>Intro repaired.</p><h2>Heading.</h2><p>Second repaired.</p>');
});

test('a repair that lands outside the resolved block is dropped, not accepted', () => {
  const before = article('<p>Intro.</p><h2>Heading.</h2><p>Second.</p>');
  // The model edited the intro although "html p 2" resolves to the second paragraph.
  const candidate = article('<p>Intro rewritten.</p><h2>Heading.</h2><p>Second.</p>');
  const constrained = constrainTargetedRepair(before, candidate, [issue('html p 2')]);
  assert.equal(constrained.html, before.html);
  assert.equal(assertTargetedRepairPreserved(before, constrained, [issue('html p 2')]), true);
});

// Job 216 was a 92-score article with one finding: INVALID_HTML_NESTING, a <ul> inside a <p>.
// Repair did the only thing that fixes it and moved the list out, and the guard rejected the
// result because the block count went 44 -> 47 -- lifting a three-item list out of a paragraph
// necessarily creates three <li> blocks. Repair cannot win that argument and should never have
// been asked to, so the nesting is straightened out before the first critic pass instead.
test('lifting a list out of a paragraph is done up front, so the block count never moves', async () => {
  const { liftBlocksOutOfParagraphs } = await import('../worker/lib/article-image-sanitizer.js');
  const messy = '<p>Intro text<ul><li>a</li><li>b</li><li>c</li></ul></p><p>After.</p>';
  const clean = liftBlocksOutOfParagraphs({ html: messy }).html;
  assert.equal(clean, '<p>Intro text</p><ul><li>a</li><li>b</li><li>c</li></ul><p>After.</p>');

  // The guard now sees the same block count before and after any in-block repair.
  const before = article(clean);
  const after = article(clean.replace('Intro text', 'Intro text repaired'));
  assert.equal(assertTargetedRepairPreserved(before, after, [issue('html p 1')]), true);
});

test('text on both sides of a lifted block is preserved as its own paragraphs', async () => {
  const { liftBlocksOutOfParagraphs } = await import('../worker/lib/article-image-sanitizer.js');
  assert.equal(
    liftBlocksOutOfParagraphs({ html: '<p>Before<ul><li>a</li></ul>After</p>' }).html,
    '<p>Before</p><ul><li>a</li></ul><p>After</p>'
  );
  // A paragraph with nothing but inline markup is left exactly as it was.
  const inline = '<p>Nested <strong>inline</strong> only.</p>';
  assert.equal(liftBlocksOutOfParagraphs({ html: inline }).html, inline);
});

// The guard forbade any change in block count, and most of what the critic asks for adds one:
// "insert a decision checklist here", "add a numbered installation procedure". Repair was being
// asked for something the guard would always reject, and once the per-tag location fix landed
// this was the only wall left -- 154 and 216 went straight from TARGET_NOT_FOUND to
// CHANGED_HTML_STRUCTURE. Insertion is now allowed, and only insertion.
test('a new block may be inserted next to a flagged block', () => {
  const before = article('<p>One.</p><p>Two.</p><p>Three.</p>');
  const candidate = article('<p>One.</p><p>Two.</p><li>added a</li><li>added b</li><p>Three.</p>');
  const constrained = constrainTargetedRepair(before, candidate, [issue('html p 2')]);
  assert.equal(constrained.html, '<p>One.</p><p>Two.</p><li>added a</li><li>added b</li><p>Three.</p>');
  assert.equal(assertTargetedRepairPreserved(before, constrained, [issue('html p 2')]), true);
});

test('a lead block may be inserted immediately before the flagged block', () => {
  const before = article('<p>One.</p><p>Two.</p>');
  const candidate = article('<p>Lead answer.</p><p>One.</p><p>Two.</p>');
  const constrained = constrainTargetedRepair(before, candidate, [issue('html p 1')]);
  assert.equal(constrained.html, '<p>Lead answer.</p><p>One.</p><p>Two.</p>');
});

test('an insertion may not come with an edit to an existing block', () => {
  const before = article('<p>One.</p><p>Two.</p><p>Three.</p>');
  const candidate = article('<p>One rewritten.</p><p>Two.</p><li>added</li><p>Three.</p>');
  assert.throws(
    () => constrainTargetedRepair(before, candidate, [issue('html p 2')]),
    (error) => error.code === 'TARGETED_REPAIR_CHANGED_HTML_STRUCTURE'
  );
});

test('an insertion nowhere near a flagged block is rejected', () => {
  const before = article('<p>One.</p><p>Two.</p><p>Three.</p>');
  const candidate = article('<p>One.</p><li>added</li><p>Two.</p><p>Three.</p>');
  assert.throws(
    () => constrainTargetedRepair(before, candidate, [issue('html p 3')]),
    (error) => error.code === 'TARGETED_REPAIR_CHANGED_HTML_STRUCTURE'
  );
});

// The block list never sees a <table> or a <figure> -- they live in the gaps between blocks.
// Rebuilding from the original parts rather than trusting the model's html is what keeps them.
test('content between blocks, which the block list never sees, survives an insertion', () => {
  const before = article('<p>One.</p><table><tr><td>keep me</td></tr></table><p>Two.</p>');
  const candidate = article('<p>One.</p><p>Two.</p><li>added</li>');
  const constrained = constrainTargetedRepair(before, candidate, [issue('html p 2')]);
  assert.match(constrained.html, /<table><tr><td>keep me<\/td><\/tr><\/table>/);
  assert.match(constrained.html, /<li>added<\/li>/);
});

test('a repair that deletes an existing block is still rejected', () => {
  const before = article('<p>One.</p><p>Two.</p><p>Three.</p>');
  const candidate = article('<p>One.</p><p>Three.</p>');
  assert.throws(
    () => constrainTargetedRepair(before, candidate, [issue('html p 2')]),
    (error) => error.code === 'TARGETED_REPAIR_CHANGED_HTML_STRUCTURE'
  );
});
