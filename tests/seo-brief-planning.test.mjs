import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeoBrief } from '../worker/lib/seo-brief.js';

// recommendedDepth becomes the word floor the critic's Section 26 pass judges the finished
// article against, so classifying an ordinary repair guide as deep-dive puts a permanent
// CORE_INFORMATION_MISSING on it. The old heuristic answered deep-dive for repair, install,
// troubleshoot, compare, cost, electric, 수리, 점검, 비교 and any commercial intent -- the whole
// subject matter of these blogs -- and jobs 154, 156, 157, 165 and 172 were held because of it.
test('an ordinary repair guide is a standard explainer, not a deep dive', async () => {
  const brief = await buildSeoBrief({}, {
    blogId: '5540565797560833468',
    topic: 'Threshold Repair and Restoration: Fixing Common Household Floor Transitions',
    language: 'en'
  });

  assert.equal(brief.version, 'smileseon-seo-brief.v2');
  assert.equal(brief.planning.method, 'master-v4.5-prewrite');
  assert.equal(brief.planning.recommendedDepth, 'standard-explainer');
  assert.deepEqual(brief.planning.recommendedWordRange, {
    min: 1500,
    max: 2500,
    unit: 'words',
    flexible: true
  });
  assert.equal(brief.planning.sourcePlan.researchExpected, true);
  assert.ok(brief.planning.competitorGapQuestions.length >= 4);
  assert.ok(brief.planning.outlineRequirements.length >= 6);
  assert.match(brief.requirements.informationGain, /판단 기준/);
});

test('lighter topics retain the Master v4.5 standard explainer planning range', async () => {
  const brief = await buildSeoBrief({}, {
    blogId: '11',
    topic: 'What is a favicon',
    language: 'en'
  });

  assert.equal(brief.planning.recommendedDepth, 'standard-explainer');
  assert.deepEqual(brief.planning.recommendedWordRange, {
    min: 1500,
    max: 2500,
    unit: 'words',
    flexible: true
  });
});

// Deep-dive still exists, for a topic that actually announces itself as long-form analysis.
test('a topic that announces itself as long-form analysis still gets the deep-dive range', async () => {
  const brief = await buildSeoBrief({}, {
    blogId: '5540565797560833468',
    topic: '2026 Home Battery Storage Market Analysis: An In-Depth Report',
    language: 'en'
  });
  assert.equal(brief.planning.recommendedDepth, 'deep-dive');
  assert.equal(brief.planning.recommendedWordRange.min, 2500);
});

// A commercial or transactional intent used to force deep-dive on its own, which is how a
// two-product comparison ended up with a 2,500-word floor.
test('commercial intent alone no longer forces the deep-dive range', async () => {
  const brief = await buildSeoBrief({}, {
    blogId: '7741529904469657049',
    topic: '외장 SSD vs 내장 SSD 속도 차이와 용도별 선택 가이드',
    language: 'ko'
  });
  assert.equal(brief.planning.recommendedDepth, 'standard-explainer');
  assert.equal(brief.planning.recommendedWordRange.min, 1500);
});
