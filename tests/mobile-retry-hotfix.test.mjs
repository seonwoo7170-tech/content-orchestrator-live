import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const hotfix = readFileSync(new URL('../web/retry-hotfix.js', import.meta.url), 'utf8');
const adminSession = readFileSync(new URL('../web/admin-session.js', import.meta.url), 'utf8');
const serviceWorker = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');

test('mobile retry interceptor loads before job card handlers', () => {
  assert.match(adminSession, /^import '\.\/retry-hotfix\.js';/);
  assert.match(hotfix, /window\.addEventListener\('click',[\s\S]*stopImmediatePropagation\(\)[\s\S]*resetAndQueue/);
});

test('mobile retry resets the same job and hands execution to one serial lane', () => {
  assert.doesNotMatch(hotfix, /setInterval\(/);
  assert.match(hotfix, /await requestJson\(`\/api\/jobs\/\$\{jobId\}\/retry`/);
  assert.match(hotfix, /let serialTail = Promise\.resolve\(\)/);
  assert.match(hotfix, /waitUntilLaneFree/);
  assert.match(hotfix, /waitUntilJobStops/);
  assert.match(hotfix, /runWhenFree/);
  assert.doesNotMatch(hotfix, /startDetached/);
});

test('mobile retry waits while another AI pipeline is active instead of fanning out', () => {
  for (const status of ['writing', 'critic_review', 'repairing', 'final_critic']) {
    assert.match(hotfix, new RegExp(status));
  }
  assert.match(hotfix, /POLL_MS = 5000/);
  assert.match(hotfix, /MAX_WAIT_MS = 20 \* 60 \* 1000/);
  assert.match(hotfix, /String\(job\.status \|\| ''\)/);
  assert.match(hotfix, /await sleep\(POLL_MS\)/);
  assert.match(hotfix, /orchestrator:jobs-changed/);
});

test('mobile retry requests stay bounded and the current PWA includes the hotfix and live progress', () => {
  assert.match(hotfix, /REQUEST_TIMEOUT_MS = 8000/);
  assert.match(hotfix, /controller\.abort\(\)/);
  assert.match(hotfix, /keepalive: true/);
  assert.match(serviceWorker, /const CACHE = 'content-orchestrator-v\d+'/);
  assert.match(serviceWorker, /'\.\/retry-hotfix\.js'/);
  assert.match(serviceWorker, /'\.\/live-work-progress\.js'/);
});