import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  augmentHealthResponse,
  mutationBlocked,
  systemPaused
} from '../worker/lib/maintenance-mode.js';

test('maintenance mode fails closed unless SYSTEM_PAUSED is explicitly false', () => {
  assert.equal(systemPaused({}), true);
  assert.equal(systemPaused({ SYSTEM_PAUSED: 'true' }), true);
  assert.equal(systemPaused({ SYSTEM_PAUSED: 'false' }), false);
});

test('maintenance mode blocks all mutation methods but leaves read methods available', () => {
  const env = { SYSTEM_PAUSED: 'true' };
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(mutationBlocked({ method }, env), true, method);
  }
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(mutationBlocked({ method }, env), false, method);
  }
  assert.equal(mutationBlocked({ method: 'POST' }, { SYSTEM_PAUSED: 'false' }), false);
});

test('health augmentation exposes global pause without removing existing gates', async () => {
  const response = new Response(JSON.stringify({
    ok: true,
    bloggerWritesEnabled: false,
    phase2Automation: { autoPublishExecutionEnabled: false }
  }), { headers: { 'content-type': 'application/json' } });
  const augmented = await augmentHealthResponse(response, true);
  const body = await augmented.json();
  assert.equal(body.systemPaused, true);
  assert.equal(body.bloggerWritesEnabled, false);
  assert.equal(body.phase2Automation.autoPublishExecutionEnabled, false);
});

test('production wrapper blocks mutations before MCP/actions and skips scheduled delegation while paused', async () => {
  const source = await readFile(new URL('../worker/maintenance-entry.js', import.meta.url), 'utf8');
  assert.match(source, /if \(mutationBlocked\(request, env\)\) return pausedMutationResponse\(\)/);
  assert.match(source, /const response = await app\.fetch\(request, env, ctx\)/);
  assert.match(source, /if \(systemPaused\(env\)\) \{/);
  assert.match(source, /SYSTEM_PAUSED_SCHEDULE_SKIPPED/);
  assert.match(source, /return app\.scheduled\(event, env, ctx\)/);
});
