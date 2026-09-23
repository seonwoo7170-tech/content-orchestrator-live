import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { acceptInsertions, judgeInsertedBlock } from '../worker/lib/expansion-acceptance.js';
import { constrainTargetedRepair } from '../worker/lib/targeted-repair-guard.js';

const BODY = '<h2>Panel Capacity</h2><p>A 100-amp service runs most older homes, and a 200-amp service is standard in new construction. Adding an electric vehicle charger or a heat pump is what usually forces the upgrade.</p><p>Scorch marks, a burning smell and breakers that trip under normal load are the signs that stop being maintenance and start being urgent.</p>';
const SOURCES = ['https://www.nfpa.org/codes', 'https://www.cpsc.gov/safety'];

function ctxInsertions(blocks) {
  return new Map([[2, blocks]]);
}

// Padding is the first thing to stop: the article gets longer and says nothing new.
test('a block that repeats existing text is rejected', () => {
  const repeat = '<p>A 100-amp service runs most older homes, and a 200-amp service is standard in new construction. Adding an electric vehicle charger is what usually forces the upgrade.</p>';
  const { accepted, rejected } = acceptInsertions(BODY, ctxInsertions([repeat]), { sources: SOURCES });
  assert.equal(accepted.size, 0);
  assert.equal(rejected[0].reason, 'REPEATS_EXISTING_TEXT');
});

test('a block that recombines the same words without adding anything is rejected', () => {
  const reworded = '<p>Most older homes run a 100-amp service. New construction is standard at 200-amp. A charger forces the upgrade.</p>';
  const { rejected } = acceptInsertions(BODY, ctxInsertions([reworded]), { sources: SOURCES });
  assert.ok(['REPEATS_EXISTING_TEXT', 'NO_INFORMATION_GAIN'].includes(rejected[0].reason));
});

// Hallucination is the second: a source the article never cited, invented to look authoritative.
test('a block citing a host the article never cited is rejected', () => {
  const invented = '<p>Panel replacement permits are issued locally and inspection timelines vary. See <a href="https://electrical-authority.example/permits">the permit schedule</a> for the filing window and typical fees in most jurisdictions.</p>';
  const { rejected } = acceptInsertions(BODY, ctxInsertions([invented]), { sources: SOURCES });
  assert.equal(rejected[0].reason, 'UNCITED_EXTERNAL_SOURCE');
});

// This is the exact shape found on the live site: citation-looking prose naming nothing locatable.
test('citation-shaped prose with nothing to click is rejected', () => {
  const shaped = '<p>According to standard residential wiring guidelines, breaker sizing should match conductor ampacity and the panel directory should be updated whenever a circuit is added or moved.</p>';
  const { rejected } = acceptInsertions(BODY, ctxInsertions([shaped]), { sources: SOURCES });
  assert.equal(rejected[0].reason, 'UNLINKED_CITATION_SHAPE');
});

// And the point of all of it: real added substance gets through.
test('a block with genuinely new, linked substance is accepted', () => {
  const good = '<p>Aluminium branch wiring installed between 1965 and 1973 needs pigtailing with approved connectors before any panel work, and an inspector will look for it. See <a href="https://www.cpsc.gov/safety">the CPSC bulletin</a> for identification.</p>';
  const { accepted, rejected } = acceptInsertions(BODY, ctxInsertions([good]), { sources: SOURCES });
  assert.equal(rejected.length, 0);
  assert.equal(accepted.get(2).length, 1);
});

test('a one-line fragment is not worth inserting', () => {
  const verdict = judgeInsertedBlock('<p>Check the panel.</p>', {
    bodyShingles: new Set(), bodyTerms: new Set(), allowedHosts: new Set()
  });
  assert.equal(verdict.reason, 'TOO_SHORT_TO_ADD_ANYTHING');
});

test('a model cannot dump an unbounded number of blocks', () => {
  const blocks = Array.from({ length: 20 }, (_, i) =>
    `<p>Distinct consideration number ${i} covering grounding electrode conductors, bonding jumpers and service entrance clearances specific to situation ${i}.</p>`);
  const { keptBlocks, rejected } = acceptInsertions(BODY, ctxInsertions(blocks), { sources: SOURCES });
  assert.ok(keptBlocks <= 12);
  assert.ok(rejected.some((r) => r.reason === 'TOO_MANY_INSERTED_BLOCKS'));
});

// The safety that actually matters is unchanged: originals are rebuilt, not taken from the model.
test('an expansion still cannot alter or drop an existing block', () => {
  const before = { title: 'T', html: BODY, searchDescription: 'd', labels: [], sources: SOURCES, language: 'en', topic: 't' };
  const tampered = {
    ...before,
    html: BODY.replace('Scorch marks', 'Scorch marks and sparks') +
      '<p>Aluminium branch wiring installed between 1965 and 1973 needs pigtailing with approved connectors before any panel work, and an inspector will look for it.</p>'
  };
  assert.throws(
    () => constrainTargetedRepair(before, tampered, [{ location: 'html p 1' }]),
    /TARGETED_REPAIR_CHANGED_HTML_STRUCTURE/
  );
});

// Job 157: repair added blocks twice (69 -> 74, 69 -> 77) against findings at html p 19, h2 8 and
// p 1, and adjacency threw both batches away. An expansion has no meaningful adjacency.
test('an insertion far from the flagged block is no longer refused for that reason', () => {
  const before = { title: 'T', html: BODY, searchDescription: 'd', labels: [], sources: SOURCES, language: 'en', topic: 't' };
  const expanded = {
    ...before,
    html: `${BODY}<h2>Aluminium Branch Wiring</h2><p>Aluminium branch wiring installed between 1965 and 1973 needs pigtailing with approved connectors before any panel work, and an inspector will look for it during a service upgrade.</p>`
  };
  const out = constrainTargetedRepair(before, expanded, [{ location: 'html p 1' }]);
  assert.match(out.html, /Aluminium Branch Wiring/);
  assert.ok(out.html.startsWith(BODY), 'the original body must come through untouched and first');
});

test('an expansion made entirely of padding is refused, and says so', () => {
  const before = { title: 'T', html: BODY, searchDescription: 'd', labels: [], sources: SOURCES, language: 'en', topic: 't' };
  const padded = {
    ...before,
    html: `${BODY}<p>A 100-amp service runs most older homes, and a 200-amp service is standard in new construction today.</p>`
  };
  assert.throws(
    () => constrainTargetedRepair(before, padded, [{ location: 'html p 1' }]),
    /TARGETED_REPAIR_INSERTION_REJECTED/
  );
});

test('the critic is told the DATE placeholder is finished work', async () => {
  const routes = await readFile(new URL('../api-hub-v2/src/lib/ai-routes.js', import.meta.url), 'utf8');
  assert.match(routes, /PUBLICATION DATE PLACEHOLDER/);
  assert.match(routes, /never report it as a placeholder, an unresolved token, a missing date/);
});

// A heading is short and term-poor by nature, so the prose rules would always reject it and leave
// its paragraphs without one. It rides along -- but never on its own.
test('a new section heading rides along with its prose', () => {
  const before = { title: 'T', html: BODY, searchDescription: 'd', labels: [], sources: SOURCES, language: 'en', topic: 't' };
  const expanded = {
    ...before,
    html: `${BODY}<h2>Aluminium Branch Wiring</h2><p>Aluminium branch wiring installed between 1965 and 1973 needs pigtailing with approved connectors before any panel work, and an inspector will look for it during a service upgrade.</p>`
  };
  const out = constrainTargetedRepair(before, expanded, [{ location: 'html p 1' }]);
  assert.match(out.html, /<h2>Aluminium Branch Wiring<\/h2>/);
  assert.match(out.html, /pigtailing with approved connectors/);
  assert.ok(out.html.startsWith(BODY));
});

test('headings with no prose behind them are not an expansion', () => {
  const { accepted, rejected, keptBlocks } = acceptInsertions(
    BODY,
    new Map([[2, ['<h2>Grounding and Bonding</h2>', '<h3>Service Entrance Clearances</h3>']]]),
    { sources: SOURCES }
  );
  assert.equal(keptBlocks, 0);
  assert.equal(accepted.size, 0);
  assert.ok(rejected.some((r) => r.reason === 'HEADINGS_WITHOUT_CONTENT'));
});
