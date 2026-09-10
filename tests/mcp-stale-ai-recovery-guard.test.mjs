import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('serial AI guard ignores stale in-flight jobs so recovery can run', () => {
  const source = fs.readFileSync(new URL('../worker/mcp-entry.js', import.meta.url), 'utf8');
  assert.match(source, /status IN \('writing', 'critic_review', 'repairing', 'final_critic'\)[\s\S]*updated_at > datetime\('now', '-20 minutes'\)/);
  const guardIndex = source.indexOf('const active = await activeAiJob(env)');
  const recoveryIndex = source.indexOf('recovery = await runScheduledJobRecovery', guardIndex);
  assert.ok(guardIndex >= 0 && recoveryIndex > guardIndex, 'recovery remains immediately downstream of the freshness-aware guard');
});
