import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8'));
const baseEntry = fs.readFileSync(new URL('../worker/entry.js', import.meta.url), 'utf8');
const phase5Entry = fs.readFileSync(new URL('../worker/phase5-entry.js', import.meta.url), 'utf8');
const phase5OpsTick = fs.readFileSync(new URL('../worker/phase5-ops-tick.js', import.meta.url), 'utf8');
const imageCompletion = fs.readFileSync(new URL('../worker/lib/image-completion.js', import.meta.url), 'utf8');

test('production image routing is KIE-first, async-resumable, serial per article, and local fallback is disabled', () => {
  assert.equal(config.vars.IMAGE_PROVIDER_MODE, 'auto');
  assert.equal(config.vars.KIE_IMAGE_FALLBACK_ENABLED, 'true');
  assert.equal(config.vars.LOCAL_IMAGE_FALLBACK_ENABLED, 'false');
  assert.equal(Number(config.vars.IMAGE_STAGE_PACING_MS), 0);
  assert.equal(Number(config.vars.IMAGE_COMPLETION_MAX_ITEMS), 1);
  assert.equal(Number(config.vars.SERIAL_IMAGE_COOLDOWN_MS), 0);
  assert.equal(Number(config.vars.SERIAL_IMAGE_POLL_INTERVAL_MS), 5000);
  assert.equal(Number(config.vars.SERIAL_ARTICLE_IMAGE_COOLDOWN_MS), 10000);
  assert.equal(Number(config.vars.SERIAL_IMAGE_JOB_BUDGET_MS), 120000);
  assert.equal(Number(config.vars.SERIAL_IMAGE_CHAIN_BUDGET_MS), 130000);
  assert.equal(Number(config.vars.SERIAL_IMAGE_CHAIN_START_CUTOFF_MS), 130000);
  assert.equal(Number(config.vars.SERIAL_IMAGE_CHAIN_MAX_ITEMS), 8);
  assert.equal(Number(config.vars.SERIAL_IMAGE_LEASE_TTL_SECONDS), 210);
  assert.match(imageCompletion, /localFallback:\s*env\?\.LOCAL_IMAGE_FALLBACK_ENABLED === 'true'/);
  assert.match(imageCompletion, /maxImages:\s*1/);
});

test('text AI stages use a four-second pacing interval', () => {
  assert.equal(Number(config.vars.AI_STAGE_PACING_MS), 4000);
});

test('scheduled image completion has one canonical scheduler path in Phase 5', () => {
  assert.doesNotMatch(baseEntry, /runScheduledImageCompletion/);
  assert.match(phase5Entry, /runScheduledImageCompletion/);
});

test('manual image resume and publish tick cannot batch multiple slow image jobs in one HTTP request', () => {
  assert.match(phase5Entry, /runScheduledImageCompletion\(env, \{\s*maxJobs: 1,/s);
  assert.match(phase5Entry, /runPublishTick\(env, ctx, \{ maxJobs: 1, skipImages, now: new Date\(\) \}\)/);
  assert.match(phase5OpsTick, /maxJobs: 1,/);
  assert.match(phase5OpsTick, /options\.skipImages === true/);
  assert.match(phase5Entry, /searchParams\.get\('images'\)/);
});