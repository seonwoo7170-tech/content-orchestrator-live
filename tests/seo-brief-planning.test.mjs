import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeoBrief } from '../worker/lib/seo-brief.js';

test('substantive repair topics receive the Master v4.5 deep-dive planning range', async () => {
  const brief = await buildSeoBrief({}, {
    blogId: '5540565797560833468',
    topic: 'Threshold Repair and Restoration: Fixing Common Household Floor Transitions',
    language: 'en'
  });

  assert.equal(brief.version, 'smileseon-seo-brief.v2');
  assert.equal(brief.planning.method, 'master-v4.5-prewrite');
  assert.equal(brief.planning.recommendedDepth, 'deep-dive');
  assert.deepEqual(brief.planning.recommendedWordRange, {
    min: 2500,
    max: 4000,
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
