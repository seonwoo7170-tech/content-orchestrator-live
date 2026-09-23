import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertTargetedRepairPreserved,
  constrainTargetedRepair,
  inspectTargetedRepairTargets
} from '../worker/lib/targeted-repair-guard.js';
import { runDeterministicQualityGate } from '../worker/lib/deterministic-quality-gate.js';

function article(html) {
  return {
    title: 'Test article',
    html,
    searchDescription: 'A sufficiently descriptive search description for deterministic QA.',
    labels: ['test'],
    sources: [],
    language: 'en',
    topic: 'test topic'
  };
}

test('stale critic target does not discard a valid sibling repair', () => {
  const before = article('<p>Original answer with enough supporting text to be useful.</p><h2>Details</h2><p>More details remain unchanged.</p>');
  const candidate = article('<p>Improved answer with a concrete decision rule and useful detail.</p><h2>Details</h2><p>More details remain unchanged.</p>');
  const issues = [
    {
      code: 'CORE_INFORMATION_MISSING',
      location: 'html p 1',
      reason: 'The direct answer needs a decision rule.',
      repairInstruction: 'Add the decision rule to this paragraph.'
    },
    {
      code: 'MADE_UP_LOCATOR',
      location: 'html h2 58',
      reason: 'This locator does not exist.',
      repairInstruction: 'Do not let this stale locator poison the valid repair.'
    }
  ];

  const repaired = constrainTargetedRepair(before, candidate, issues);
  assert.match(repaired.html, /Improved answer/);
  assert.doesNotMatch(repaired.html, /Original answer/);
  assert.equal(assertTargetedRepairPreserved(before, repaired, issues), true);

  const inspection = inspectTargetedRepairTargets(before, issues);
  assert.deepEqual(inspection.validTargets, ['p:1']);
  assert.equal(inspection.invalidTargets[0].target, 'h2:58');
});

test('an invalid-only HTML locator preserves the original even if repair output rewrites structure', () => {
  const before = article('<p>Keep this paragraph unchanged because the critic locator is stale.</p><h2>Details</h2><p>Keep this too.</p>');
  const candidate = article('<section><p>Model attempted a broad rewrite.</p></section>');
  const issues = [{
    code: 'STALE_LOCATION',
    location: 'html li 30',
    reason: 'Nonexistent list item.',
    repairInstruction: 'Attempted repair.'
  }];

  const repaired = constrainTargetedRepair(before, candidate, issues);
  assert.equal(repaired.html, before.html);
  assert.equal(assertTargetedRepairPreserved(before, repaired, issues), true);
});

test('source-authority criticism cannot delete a marked internal-navigation block', () => {
  const internal = '<p data-smileseon-internal-links="1"><strong>Related guides</strong><br><a href="https://smileinfo.net/guide">Useful guide</a></p>';
  const before = article(`<p>Main body content remains useful and independent.</p>${internal}`);
  const candidate = article('<p>Main body content remains useful and independent.</p><p>Replaced with an external source.</p>');
  const issues = [{
    code: 'UNVERIFIED_SOURCE',
    location: 'html p 2',
    reason: 'Replace the smileinfo.net link with a verified authoritative source.',
    repairInstruction: 'Remove or replace this source link.'
  }];

  const repaired = constrainTargetedRepair(before, candidate, issues);
  assert.equal(repaired.html, before.html);
  const inspection = inspectTargetedRepairTargets(before, issues);
  assert.deepEqual(inspection.protectedInternalNavigationTargets, ['p:2']);
});

test('non-source repairs may still fix a marked internal-navigation block', () => {
  const before = article('<p>Main content is here.</p><p data-smileseon-internal-links="1"><strong>Related guides</strong><br><a href="https://smileinfo.net/bad">Broken guide</a></p>');
  const candidate = article('<p>Main content is here.</p><p data-smileseon-internal-links="1"><strong>Related guides</strong><br><a href="https://smileinfo.net/fixed">Fixed guide</a></p>');
  const issues = [{
    code: 'BROKEN_INTERNAL_LINK',
    location: 'html p 2',
    reason: 'The navigation URL is broken.',
    repairInstruction: 'Replace the broken URL with the valid internal URL.'
  }];

  const repaired = constrainTargetedRepair(before, candidate, issues);
  assert.match(repaired.html, /\/fixed/);
  assert.equal(assertTargetedRepairPreserved(before, repaired, issues), true);
});

test('literal date placeholders are blocked by content, regardless of critic code naming', () => {
  const result = runDeterministicQualityGate(article('<p>This article was checked on [DATE] and still contains enough surrounding text to exceed the thin-content minimum for this unit test. It includes additional stable wording solely so the deterministic body-length warning does not distract from the placeholder assertion.</p>'));
  assert.equal(result.status, 'BLOCK');
  assert.ok(result.issues.some((issue) => issue.code === 'PLACEHOLDER_DATE_TOKEN' && issue.severity === 'block'));
});

test('date placeholder variants are blocked too', () => {
  for (const token of ['[CURRENT_DATE]', '{{DATE}}', '{{ current-date }}']) {
    const result = runDeterministicQualityGate(article(`<p>This content contains ${token} and enough ordinary prose around it to make the test focus on the date placeholder itself rather than article contract validation or an unrelated HTML safety rule.</p>`));
    assert.ok(result.issues.some((issue) => issue.code === 'PLACEHOLDER_DATE_TOKEN'), token);
  }
});
