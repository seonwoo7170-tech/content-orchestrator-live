import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isPublicationDue, scheduledMinuteForSlot, validatePublicationResult } from '../worker/lib/auto-publisher.js';

const settings = {
  enabled: true,
  autoPublishEnabled: true,
  approvalMode: 'auto',
  publishStartTime: '09:00',
  publishIntervalMinutes: 30,
  publishJitterMinutes: 5,
  maxPublishesPerDay: 4,
  imagesEnabled: true,
  bodyImageCount: 2
};

const cleanArticle = {
  title: '윈도우 파일 이름을 한 번에 바꾸는 방법',
  topic: '윈도우 파일 이름 변경',
  language: 'ko',
  searchDescription: '여러 파일의 이름을 순서대로 정리하는 방법과 실수하기 쉬운 부분을 설명합니다.',
  labels: ['Windows'],
  sources: [],
  html: '<p>파일이 많다면 먼저 복사본으로 시험해 보세요.</p><h2>탐색기에서 바꾸기</h2><p>파일을 선택한 뒤 이름 바꾸기를 실행하면 순서 번호가 붙습니다.</p><h2>확인할 점</h2><p>확장자를 표시한 상태에서는 확장자까지 지우지 않도록 확인하세요.</p>'
};

const cleanResult = {
  status: 'READY',
  article: cleanArticle,
  finalCritic: { status: 'PASS', score: 100, issues: [] }
};

test('scheduled publication slots use deterministic 30±5 minute gaps', () => {
  const minutes = [1, 2, 3, 4].map((slot) => scheduledMinuteForSlot(settings, slot, '2026-08-31', 'homefix'));
  for (let index = 1; index < minutes.length; index += 1) {
    const gap = minutes[index] - minutes[index - 1];
    assert.ok(gap >= 25 && gap <= 35, `gap ${gap} should be within 25..35`);
  }
  assert.equal(scheduledMinuteForSlot(settings, 1, '2026-08-31', 'homefix'), minutes[0]);
  assert.equal(isPublicationDue(settings, 1), true);
  assert.equal(isPublicationDue(settings, 4), true);
  assert.equal(isPublicationDue(settings, 5), false);
});

test('approval mode and disabled automation never become schedulable', () => {
  assert.equal(isPublicationDue({ ...settings, approvalMode: 'approval' }, 1), false);
  assert.equal(isPublicationDue({ ...settings, autoPublishEnabled: false }, 1), false);
  assert.equal(isPublicationDue({ ...settings, enabled: false }, 1), false);
});

test('publication exit check requires critic, lint, thumbnail and planned body images', () => {
  const images = [
    { role: 'thumbnail', status: 'attached' },
    { role: 'body', status: 'attached' },
    { role: 'body', status: 'attached' }
  ];
  assert.equal(validatePublicationResult(cleanResult, settings, images).ok, true);
  assert.equal(validatePublicationResult({ ...cleanResult, finalCritic: { status: 'PASS', score: 94, issues: [] } }, settings, images).reason, 'FINAL_CRITIC_NOT_CLEAN');
  assert.equal(validatePublicationResult(cleanResult, settings, images.slice(1)).reason, 'THUMBNAIL_NOT_ATTACHED');
  assert.equal(validatePublicationResult(cleanResult, settings, images.slice(0, 2)).reason, 'IMAGES_NOT_ATTACHED');
});

test('image checks are skipped only when blog image automation is disabled', () => {
  assert.equal(validatePublicationResult(cleanResult, { ...settings, imagesEnabled: false }, []).ok, true);
});

test('the image-count exception frees only the allowlisted jobs that still hold their images', () => {
  // settings.bodyImageCount is 2 in this file, so expected = 3; two attached images is one short.
  const short = [
    { role: 'thumbnail', status: 'attached' },
    { role: 'body', status: 'attached' }
  ];
  // Not on the allowlist -> still blocked, whatever the job id.
  assert.equal(validatePublicationResult(cleanResult, settings, short, 999).reason, 'IMAGES_NOT_ATTACHED');
  assert.equal(validatePublicationResult(cleanResult, settings, short).reason, 'IMAGES_NOT_ATTACHED');
  // On the allowlist but only two attached images -> below the 3-image floor, still blocked.
  assert.equal(validatePublicationResult(cleanResult, settings, short, 137).reason, 'IMAGES_NOT_ATTACHED');

  // On the allowlist with its thumbnail plus three attached images -> exempt.
  const intact = [
    { role: 'thumbnail', status: 'attached' },
    { role: 'body', status: 'attached' },
    { role: 'body', status: 'attached' }
  ];
  const raised = { ...settings, bodyImageCount: 3 };
  assert.equal(validatePublicationResult(cleanResult, raised, intact).reason, 'IMAGES_NOT_ATTACHED');
  const exempt = validatePublicationResult(cleanResult, raised, intact, 137);
  assert.equal(exempt.ok, true);
  assert.equal(exempt.imageCountException, true);
  assert.equal(exempt.imagesEvidence.exception, 'PUBLISH_IMAGE_COUNT_EXCEPTION');

  // A missing thumbnail is never exempt, even for an allowlisted job.
  assert.equal(validatePublicationResult(cleanResult, raised, intact.slice(1), 137).reason, 'THUMBNAIL_NOT_ATTACHED');
});

test('every stuck job id from the 2026-09-20 backlog is on the allowlist', async () => {
  const source = await readFile(new URL('../worker/lib/auto-publisher.js', import.meta.url), 'utf8');
  assert.match(source, /PUBLISH_IMAGE_COUNT_EXCEPTION_JOB_IDS\s*=\s*new Set\(\[137, 139, 149, 151, 153, 154, 156, 157\]\)/);
  assert.match(source, /PUBLISH_IMAGE_COUNT_EXCEPTION_MIN_IMAGES\s*=\s*3/);
});

test('a blocked publish records its reason as a job event without changing job status', async () => {
  const source = await readFile(new URL('../worker/lib/auto-publisher.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('async function recordPublishBlock'), source.indexOf('export function validatePublicationResult'));
  // Deduped on (job, reason) so a long-lived block does not log once per five-minute tick.
  assert.match(fn, /event_type = 'publish_blocked' AND message = \?/);
  assert.match(fn, /eventType: 'publish_blocked'/);
  // Must never move the job out of 'ready' -- this block is routinely transient.
  assert.doesNotMatch(fn, /persistJobTransition|needs_review/);
  // Logging must never be able to stop a publish.
  assert.match(fn, /catch \{\s*return false;\s*\}/);
  assert.match(source, /await recordPublishBlock\(env, candidate\.job_id, eligibility\.reason\)/);
  assert.match(source, /validatePublicationResult\(result, settings, images, candidate\.job_id\)/);
});

test('publisher scans recent carryover plan dates instead of only today', async () => {
  const source = await readFile(new URL('../worker/lib/auto-publisher.js', import.meta.url), 'utf8');
  assert.match(source, /CARRYOVER_LOOKBACK_DAYS\s*=\s*14/);
  assert.match(source, /s\.plan_date BETWEEN date\(\?, \?\) AND \?/);
  assert.match(source, /ORDER BY s\.plan_date, s\.slot_no/);
});

// Blogger answered 429 to three of the eight jobs freed on 2026-09-20, all of which had been
// scheduled into the same minute. A rate limit is "not now", not "never", so it must not spend
// one of the three publication attempts and must not be retried on the very next tick.
test('a Blogger rate limit is recognised from its real error code, not from a bare 429 substring', async () => {
  const { isPublishRateLimitError } = await import('../worker/lib/auto-publisher.js');
  assert.equal(isPublishRateLimitError(new Error('API_HUB_429:BLOGGER_API_429')), true);
  assert.equal(isPublishRateLimitError({ status: 429 }), true);
  assert.equal(isPublishRateLimitError(new Error('BLOGGER_RATE_LIMIT')), true);
  assert.equal(isPublishRateLimitError(new Error('TOO_MANY_REQUESTS')), true);
  // A longer number that merely contains 429 is not a rate limit.
  assert.equal(isPublishRateLimitError(new Error('API_HUB_4290')), false);
  assert.equal(isPublishRateLimitError(new Error('DELIVERY_EVIDENCE_INCOMPLETE')), false);
  assert.equal(isPublishRateLimitError(null), false);
});

test('a rate-limited publish refunds its attempt and waits out a cooldown before re-claiming', async () => {
  const source = await readFile(new URL('../worker/lib/auto-publisher.js', import.meta.url), 'utf8');
  assert.match(source, /PUBLISH_RATE_LIMIT_COOLDOWN_MINUTES\s*=\s*30/);
  // The refund: the claim incremented attempts, the rate limit gives it back.
  const fn = source.slice(source.indexOf('async function markRateLimited'), source.indexOf('export function isPublishRateLimitError'));
  assert.match(fn, /attempts = MAX\(attempts - 1, 0\)/);
  assert.match(fn, /WHERE job_id = \? AND status = 'claimed'/);
  // The cooldown: a row that failed with a 429 is not re-claimed until it has aged out.
  assert.match(source, /error NOT LIKE '%429%'/);
  assert.match(source, /updated_at <= datetime\('now', '-\$\{PUBLISH_RATE_LIMIT_COOLDOWN_MINUTES\} minutes'\)/);
  // Rate limits are checked before the ambiguous-write branch and never fall through to markFailed.
  assert.match(source, /if \(isPublishRateLimitError\(error\)\) \{[\s\S]*?\} else if \(isAmbiguousWriteError\(error\)\) \{/);
  // A rate-limited tick is reported honestly rather than counted as a clean run.
  assert.match(source, /ok: outcomes\.every\(\(item\) => !\['failed', 'held', 'rate_limited'\]\.includes\(item\.status\)\)/);
});
