import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBlogDiagnostic, summarizeDiagnostics } from '../worker/lib/daily-diagnostics.js';

const blog = { blogId: '1', name: 'HomeFix', postsTotal: 9, language: 'en' };

test('disabled blog is diagnosed as paused', () => {
  const result = classifyBlogDiagnostic({ blog, effective: { enabled: false, operationMode: 'growth' } });
  assert.equal(result.status, 'disabled');
  assert.equal(result.severity, 'paused');
});

test('failed or review jobs take diagnostic priority', () => {
  const result = classifyBlogDiagnostic({
    blog,
    effective: { enabled: true, operationMode: 'growth' },
    jobs: [{ status: 'failed' }, { status: 'queued' }]
  });
  assert.equal(result.status, 'attention');
  assert.equal(result.queue.active, 1);
  assert.equal(result.queue.attention, 1);
});

test('active jobs report working while an idle populated blog is healthy', () => {
  const active = classifyBlogDiagnostic({ blog, effective: { enabled: true }, jobs: [{ status: 'critic_review' }] });
  const healthy = classifyBlogDiagnostic({ blog, effective: { enabled: true } });
  assert.equal(active.severity, 'active');
  assert.equal(healthy.severity, 'healthy');
});

test('empty enabled blog is marked new and slot counts are exposed', () => {
  const result = classifyBlogDiagnostic({
    blog: { ...blog, postsTotal: 0 },
    effective: { enabled: true },
    slots: [{ kind: 'new_article', status: 'pending' }, { kind: 'repair_existing', status: 'skipped' }]
  });
  assert.equal(result.severity, 'new');
  assert.deepEqual(result.today, { total: 2, pending: 1, resolved: 0, skipped: 1, newArticles: 1, repairs: 1 });
});

test('diagnostic summary counts severity buckets', () => {
  assert.deepEqual(
    summarizeDiagnostics([{ severity: 'healthy' }, { severity: 'attention' }, { severity: 'active' }, { severity: 'paused' }, { severity: 'new' }]),
    { total: 5, healthy: 1, active: 1, attention: 1, paused: 1, new: 1 }
  );
});
