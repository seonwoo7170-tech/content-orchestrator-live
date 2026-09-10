import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8'));
const baseEntry = fs.readFileSync(new URL('../worker/entry.js', import.meta.url), 'utf8');
const phase5Entry = fs.readFileSync(new URL('../worker/phase5-entry.js', import.meta.url), 'utf8');
const phase5OpsTick = fs.readFileSync(new URL('../worker/phase5-ops-tick.js', import.meta.url), 'utf8');
const imageCompletion = fs.readFileSync(new URL('../worker/lib/image-completion.js', import.meta.url), 'utf8');
const resilientImageExecutor = fs.readFileSync(new URL('../worker/lib/image-executor-resilient.js', import.meta.url), 'utf8');
const puterProvider = fs.readFileSync(new URL('../worker/lib/puter-image-provider.js', import.meta.url), 'utf8');

test('active production uses Puter-first resumable durable image completion without fixed per-image cooldown', () => {
  assert.equal(config.vars.SYSTEM_PAUSED, 'false');
  assert.equal(config.vars.IMAGE_PROVIDER_MODE, undefined);
  assert.equal(config.vars.PUTER_IMAGE_ENABLED, undefined);
  assert.equal(config.vars.PUTER_IMAGE_MODELS, undefined);
  assert.equal(config.vars.PUTER_IMAGE_QUALITY, undefined);
  assert.equal(config.vars.PUTER_IMAGE_TIMEOUT_MS, undefined);
  assert.equal(config.vars.PUTER_IMAGE_READ_TIMEOUT_MS, undefined);
  assert.equal(config.vars.PUTER_OUTCOME_UNKNOWN_GRACE_MS, undefined);
  assert.equal(config.vars.MODELSCOPE_IMAGE_ENABLED, 'true');
  assert.equal(config.vars.KIE_IMAGE_CALLBACK_ENABLED, 'false');
  assert.equal(config.vars.KIE_IMAGE_FALLBACK_ENABLED, 'false');
  assert.equal(config.vars.LOCAL_IMAGE_FALLBACK_ENABLED, 'false');
  assert.equal(config.vars.IMAGE_STAGE_PACING_MS, undefined);
  // Free Workers allow 64 text variables plus secrets. Reserve three slots for
  // HUB_API_KEY, ADMIN_API_KEY, and PUTER_AUTH_TOKEN.
  assert.ok(Object.keys(config.vars).length <= 61);
  assert.equal(Number(config.vars.IMAGE_COMPLETION_MAX_ITEMS), 1);
  assert.equal(Number(config.vars.SERIAL_IMAGE_COOLDOWN_MS), 0);
  assert.equal(Number(config.vars.SERIAL_IMAGE_POLL_INTERVAL_MS), 3000);
  assert.equal(Number(config.vars.SERIAL_ARTICLE_IMAGE_COOLDOWN_MS), 10000);
  assert.equal(Number(config.vars.SERIAL_IMAGE_JOB_BUDGET_MS), 120000);
  assert.equal(Number(config.vars.SERIAL_IMAGE_CHAIN_BUDGET_MS), 130000);
  assert.equal(Number(config.vars.SERIAL_IMAGE_CHAIN_START_CUTOFF_MS), 130000);
  assert.equal(Number(config.vars.SERIAL_IMAGE_CHAIN_MAX_ITEMS), 8);
  assert.equal(Number(config.vars.SERIAL_IMAGE_LEASE_TTL_SECONDS), 210);
  assert.match(imageCompletion, /localFallback:\s*false/);
  assert.match(imageCompletion, /maxImages:\s*positiveLimit\(options\.maxImages, 1, 3\)/);
  assert.match(imageCompletion, /storedBeforeGeneration/);
  assert.match(resilientImageExecutor, /Math\.min\(3, number\)/);
  assert.match(resilientImageExecutor, /!puterAttempted && puterImageConfigured\(env\)\) return 'puter'/);
  assert.match(resilientImageExecutor, /attempts === 0 && modelScopeImageEnabled\(env\)\) return 'modelscope'/);
  assert.match(resilientImageExecutor, /return provider === 'modelscope' \? 'modelscope' : 'kie'/);
  assert.match(resilientImageExecutor, /IMAGE_PROVIDER_MODE: 'cloudflare'/);
  assert.match(resilientImageExecutor, /isSuccessfulPaidImageCheckpoint/);
  assert.doesNotMatch(resilientImageExecutor, /localFallback:\s*true/);
  assert.match(puterProvider, /puter_output_path/);
  assert.match(puterProvider, /PUTER_OUTCOME_UNKNOWN/);
  assert.match(puterProvider, /readPuterCheckpoint/);
});

test('text AI stages retain a four-second pacing interval in preserved code', () => {
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
