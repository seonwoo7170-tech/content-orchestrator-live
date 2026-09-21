import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../worker/lib/pipeline.js', import.meta.url), 'utf8');

// Jobs 154, 156, 157, 165 and 172 each burned four continuations and ten repair calls on
// 2026-09-21 with a guard rejection on every attempt. The cause was not a hard topic: the critic
// asked for a lead paragraph or more sections, repair did as told, and the structure guard threw
// TARGETED_REPAIR_CHANGED_HTML_STRUCTURE, discarding the whole repair -- including the in-scope
// citation fixes batched beside it. 172 had five fixable unsupported-fact findings that never
// landed for exactly that reason.
test('findings that require adding a block never reach targeted repair', () => {
  assert.match(source, /const REPAIR_INAPPLICABLE_CODES = new Set\(\[\s*\.\.\.STRUCTURAL_REPLAN_CODES,\s*'CORE_INFORMATION_MISSING'/);
  assert.match(source, /'MISSING_LEAD_PARAGRAPH'/);
  // The repair call takes the filtered list, not the raw critic list.
  assert.match(source, /const repairIssues = escalatedRepairIssues\(applicableIssues, context\);/);
  assert.doesNotMatch(source, /escalatedRepairIssues\(issues, context\)/);
});

test('a batch with nothing repairable fails fast instead of spending attempts', () => {
  assert.match(source, /const applicableIssues = repairableIssues\(issues\);/);
  assert.match(source, /if \(applicableIssues\.length === 0\) \{[\s\S]*?reviewReason: 'STRUCTURAL_REPLAN_REQUIRED'/);
  // The fail-fast must sit before the repair loop, or attempts are spent before it is reached.
  assert.ok(
    source.indexOf('const applicableIssues = repairableIssues(issues);') < source.indexOf('while (!repairSucceeded && repairAttempts < maxRepairs)'),
    'the empty-batch check must precede the repair loop'
  );
});

test('a lone expansion finding does not cancel the repair of everything beside it', () => {
  // Lowering this to >= 1 on 2026-09-21 was a mistake: with every article still carrying a
  // deep-dive word floor, one length-driven finding skipped repair entirely (repairAttempts 0)
  // and sent 154, 156, 157 and 165 round the replan loop until candidates ran out, each rewrite
  // shorter than the article it replaced. Keeping unfixable findings out of the repair batch is
  // the actual deadlock fix; the replan threshold stays where it was.
  assert.match(source, /code === 'CORE_INFORMATION_MISSING'\)\.length >= 2;/);
});
