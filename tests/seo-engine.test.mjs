import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSeoBrief } from '../worker/lib/seo-brief.js';
import { buildValidatedBlogPostingSchema } from '../worker/lib/blogposting-schema.js';
import { buildContentDecayRows, scoreContentDecay } from '../worker/lib/content-decay.js';
import { buildSchemaAwareDelivery } from '../worker/lib/schema-delivery.js';

test('SEO brief remains available without D1 and keeps current topics evidence-aware', async () => {
  const brief = await buildSeoBrief({}, {
    blogId: 'blog-1',
    topic: '2026년 윈도우 업데이트 오류 해결 방법',
    language: 'ko',
    strategyLinks: [{ url: 'https://example.test/related', query: '윈도우 복구' }]
  });
  assert.equal(brief.version, 'smileseon-seo-brief.v1');
  assert.equal(brief.searchIntent, 'informational');
  assert.equal(brief.answerFirst, true);
  assert.equal(brief.evidence.source, 'planner');
  assert.equal(brief.internalLinks[0].url, 'https://example.test/related');
  assert.match(brief.requirements.freshness, /최신성/);
});

test('BlogPosting schema is canonicalized and validated against the exact readback URL', () => {
  const result = buildValidatedBlogPostingSchema({
    article: {
      title: '윈도우 복구 가이드',
      html: '<p>본문</p>',
      searchDescription: '윈도우 복구 순서를 정리합니다.',
      labels: ['Windows', '복구'],
      language: 'ko',
      topic: '윈도우 복구'
    },
    canonicalUrl: 'https://example.test/post?a=1#section',
    publishedAt: '2026-09-04T03:00:00+09:00'
  });
  assert.equal(result.passed, true);
  assert.equal(result.canonicalUrl, 'https://example.test/post');
  assert.equal(result.schema.url, 'https://example.test/post');
  assert.equal(result.schema.mainEntityOfPage['@id'], 'https://example.test/post');
  assert.equal(result.schema['@type'], 'BlogPosting');
});

test('content decay requires comparative GSC evidence and prioritizes material declines', () => {
  const score = scoreContentDecay(
    { clicks: 4, impressions: 40, ctr: 0.1, position: 10 },
    { clicks: 10, impressions: 100, ctr: 0.1, position: 6 }
  );
  assert.equal(score.action, 'repair');
  assert.ok(score.decayScore >= 40);
  assert.ok(score.reasons.includes('search_clicks_declining'));
  assert.ok(score.reasons.includes('search_impressions_declining'));

  const rows = buildContentDecayRows(
    [{ page: 'https://example.test/a?x=1', clicks: 4, impressions: 40, position: 10 }],
    [{ page: 'https://example.test/a', clicks: 10, impressions: 100, position: 6 }],
    { blogId: 'blog-1', latestSnapshotDate: '2026-09-04', baselineSnapshotDate: '2026-08-25', snapshotGapDays: 10 }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].page, 'https://example.test/a');
  assert.equal(rows[0].action, 'repair');
});

test('schema-aware delivery stays incomplete before Blogger readback and passes after exact canonical readback', () => {
  const result = {
    status: 'READY',
    article: {
      title: '테스트 글', html: '<p>충분한 테스트 본문입니다.</p>', searchDescription: '테스트 설명',
      labels: [], language: 'ko', topic: '테스트'
    },
    finalCritic: { status: 'PASS', score: 98, issues: [] }
  };
  const common = {
    mode: 'new_article', result,
    deterministicQa: { status: 'PASS', issues: [], version: 'qa' },
    naturalWritingStatus: 'PASS',
    images: { passed: true, required: false },
    imagesRequired: false,
    publication: { ok: true, blogId: 'b1', bloggerPostId: 'p1', scheduledAt: '2026-09-04T03:00:00+09:00' }
  };
  const pending = buildSchemaAwareDelivery(common);
  assert.equal(pending.schema.passed, false);
  assert.equal(pending.deliveryEvidence.status, 'INCOMPLETE');

  const verified = buildSchemaAwareDelivery({
    ...common,
    readback: { identity: { blogId: 'b1', bloggerPostId: 'p1', permalink: 'https://example.test/p1' } }
  });
  assert.equal(verified.schema.passed, true);
  assert.equal(verified.deliveryEvidence.status, 'PASS');
});

test('writer critic and repair surfaces all carry the same SEO brief contract', () => {
  const pipeline = fs.readFileSync(new URL('../worker/lib/pipeline.js', import.meta.url), 'utf8');
  const runner = fs.readFileSync(new URL('../worker/lib/job-runner.js', import.meta.url), 'utf8');
  const hub = fs.readFileSync(new URL('../api-hub-v2/src/lib/ai-routes.js', import.meta.url), 'utf8');
  const phase5 = fs.readFileSync(new URL('../worker/phase5-entry.js', import.meta.url), 'utf8');
  const publisher = fs.readFileSync(new URL('../worker/lib/auto-publisher.js', import.meta.url), 'utf8');
  const repairUpdater = fs.readFileSync(new URL('../worker/lib/auto-repair-updater.js', import.meta.url), 'utf8');
  const recovery = fs.readFileSync(new URL('../worker/lib/publication-readback-recovery.js', import.meta.url), 'utf8');
  assert.match(runner, /buildSeoBrief/);
  assert.match(pipeline, /context\.seoBrief/);
  assert.match(pipeline, /seoBrief/);
  assert.match(hub, /\{ seoBrief: input\.seoBrief \}/);
  assert.match(hub, /When seoBrief is supplied/);
  assert.match(phase5, /\/api\/strategy\/seo-brief/);
  assert.match(phase5, /\/api\/strategy\/decay/);
  assert.match(publisher, /buildSchemaAwareDelivery/);
  assert.match(repairUpdater, /buildSchemaAwareDelivery/);
  assert.match(recovery, /buildSchemaAwareDelivery/);
});
