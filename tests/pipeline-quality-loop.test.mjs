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
  // Adding a footnote is a block insertion too -- found on job 172's first run after the filter
  // landed, where it was the only thing still failing the guard.
  assert.match(source, /'MISSING_FOOTNOTE_CONTENT'/);
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

// The critic invents its issue codes freely -- there is no enum. On 2026-09-21 four fresh jobs
// sent the same "add a block" request under five different names (MISSING_LEAD_SECTION,
// MISSING_DIRECT_ANSWER_IN_LEAD, INSUFFICIENT_CONTENT_DEPTH, MISSING_SAFETY_WARNING,
// MISSING_H2_IN_HTML), none on the denylist, and every one failed the structure guard again.
// The instruction is what is stable, so that is what decides.
test('an instruction asking for a new block is recognised whatever the issue is called', async () => {
  const { requiresNewBlock } = await import('../worker/lib/pipeline.js');
  const expansion = [
    { code: 'MISSING_SAFETY_WARNING', repairInstruction: 'Add a safety warning paragraph before any hardware handling steps.' },
    { code: 'MISSING_FOOTNOTE_CONTENT', repairInstruction: 'Add a footnote after the paragraph that cites the official fare page.' },
    { code: 'ANYTHING_AT_ALL', repairInstruction: 'Expand the article by adding substantive sections such as benchmark methodology.' },
    { code: 'MISSING_LEAD_SECTION', repairInstruction: '본문 최상단에 핵심 답변을 제시하는 리드 문단을 추가한다.' },
    { code: 'CORE_INFORMATION_MISSING', repairInstruction: '구매 절차 섹션에 벤치마크 결과를 추가하여 최소 1500단어 수준으로 보강한다.' },
    { code: 'MISSING_DIRECT_ANSWER_IN_LEAD', repairInstruction: 'Insert a concise lead <p> element before the first <h2>.' }
  ];
  for (const issue of expansion) {
    assert.equal(requiresNewBlock(issue), true, `${issue.code} should be recognised as a block insertion`);
  }
});

test('an edit inside an existing block still goes to repair', async () => {
  const { requiresNewBlock } = await import('../worker/lib/pipeline.js');
  const inScope = [
    { code: 'MISSING_INLINE_CITATION', repairInstruction: 'Add an inline citation after the sentence, e.g. "(ESFI)", linking to the source URL.' },
    { code: 'MISLEADING_SOURCE_LINK', repairInstruction: 'Replace the EEOC URL with a legitimate state licensing board site.' },
    { code: 'UNSUPPORTED_CLAIM', repairInstruction: 'Qualify the statement (e.g. "in this case"), or provide a broader data set.' },
    { code: 'MISSING_DIRECT_ANSWER_IN_LEAD', repairInstruction: 'Rewrite the lead paragraph (html p 1) to start with a concise answer.' },
    { code: 'UNSUPPORTED_PRICE_CLAIM', repairInstruction: '가격 수치를 삭제하거나, 공식 유통업체의 최신 데이터를 인용하여 출처를 명시한다.' }
  ];
  for (const issue of inScope) {
    assert.equal(requiresNewBlock(issue), false, `${issue.code} is an in-block edit and must still be repaired`);
  }
});

// The filter that kept expansion findings out of the repair batch existed only because the
// guard rejected any change in block count. Now that an insertion next to a flagged block is
// accepted, those findings are applicable and repair should get them -- keeping them out would
// leave replan as the only answer, and replan is worse: job 154 came back from one 1,604 words
// shorter than it went in.
test('an expansion finding now reaches repair instead of being filtered out', async () => {
  const source = await readFile(new URL('../worker/lib/pipeline.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('function repairableIssues'), source.indexOf('function escalatedRepairIssues'));
  assert.doesNotMatch(fn, /requiresNewBlock/);
  assert.match(fn, /return Array\.isArray\(issues\) \? issues : \[\];/);
});

// requiresNewBlock itself stays: structuralReplanRequired still uses it to decide when a
// rewrite genuinely is the last resort.
test('requiresNewBlock is still what decides a structural replan', async () => {
  const { requiresNewBlock } = await import('../worker/lib/pipeline.js');
  assert.equal(requiresNewBlock({ code: 'CORE_INFORMATION_MISSING', repairInstruction: 'Insert a checklist.' }), true);
  assert.equal(requiresNewBlock({ code: 'UNSUPPORTED_CLAIM', repairInstruction: 'Qualify the statement.' }), false);
  const source = await readFile(new URL('../worker/lib/pipeline.js', import.meta.url), 'utf8');
  assert.match(source, /function structuralReplanRequired\(critic\)/);
});
