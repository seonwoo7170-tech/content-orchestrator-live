import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/lib/pipeline.js', import.meta.url), 'utf8');

// Handing the critic a real measurement makes it emit CORE_INFORMATION_MISSING on every short
// article, and two of those used to trigger a replan. A replan rewrites from scratch and comes
// back shorter -- job 154 lost 1,604 words -- so measuring the length without this guard would
// have made the very defect being fixed worse.
test('a below-floor article is repaired, never replanned', () => {
  const fn = source.slice(source.indexOf('function structuralReplanRequired'), source.indexOf('function retryReasonForEvaluation'));
  assert.match(fn, /if \(critic\?\.measuredLength\?\.belowFloor\) return false;/);
  // The guard must sit after the explicit structural codes, so a genuinely structural finding
  // still replans even on a short article.
  assert.ok(
    fn.indexOf('STRUCTURAL_REPLAN_CODES.has(code)') < fn.indexOf('measuredLength?.belowFloor'),
    'the explicit structural-code path must still win'
  );
  // And before the count path, which is the one a length shortfall would otherwise trip.
  assert.ok(
    fn.indexOf('measuredLength?.belowFloor') < fn.indexOf("code === 'CORE_INFORMATION_MISSING'"),
    'the guard must short-circuit the finding-count path'
  );
});

// Repair can only close a shortfall if findings that ask for new content still reach it.
test('findings asking for new content still go to repair', () => {
  const fn = source.slice(source.indexOf('function repairableIssues'), source.indexOf('async function emitStage'));
  assert.match(fn, /return Array\.isArray\(issues\) \? issues : \[\];/);
});

test('the measured length is carried onto the job record', () => {
  assert.match(source, /measuredLength: critic\?\.measuredLength \?\? null,/);
});
