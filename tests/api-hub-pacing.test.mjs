import test from 'node:test';
import assert from 'node:assert/strict';
import { aiStagePacingMs } from '../worker/lib/api-hub.js';

test('AI stage pacing applies only to AI Hub routes', () => {
  assert.equal(aiStagePacingMs({ AI_STAGE_PACING_MS: '4000' }, '/api/hub/ai/writer'), 4000);
  assert.equal(aiStagePacingMs({ AI_STAGE_PACING_MS: '4000' }, '/api/hub/ai/critic'), 4000);
  assert.equal(aiStagePacingMs({ AI_STAGE_PACING_MS: '4000' }, '/api/hub/ai/repair'), 4000);
  assert.equal(aiStagePacingMs({ AI_STAGE_PACING_MS: '4000' }, '/api/hub/image/generate'), 0);
  assert.equal(aiStagePacingMs({ AI_STAGE_PACING_MS: '4000' }, '/api/blogger/post'), 0);
});

test('AI pacing is constrained to 3-5 seconds when enabled', () => {
  assert.equal(aiStagePacingMs({}, '/api/hub/ai/writer'), 0);
  assert.equal(aiStagePacingMs({ AI_STAGE_PACING_MS: '1000' }, '/api/hub/ai/writer'), 3000);
  assert.equal(aiStagePacingMs({ AI_STAGE_PACING_MS: '9000' }, '/api/hub/ai/writer'), 5000);
});
