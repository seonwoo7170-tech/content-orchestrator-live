import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePublishTick } from '../worker/phase5-ops-tick.js';

test('publish tick summary exposes only bounded operational counts and scheduled links', () => {
  const summary = summarizePublishTick({
    image: { attempted: 2, completed: 1, ok: true },
    publish: { attempted: 1, scheduled: 1, blocked: 0, ok: true, outcomes: [{ jobId: 3, status: 'scheduled', url: 'https://example.com/p', scheduledAt: '2026-08-31T14:00:00Z' }] }
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.images.completed, 1);
  assert.equal(summary.publications.scheduled, 1);
  assert.deepEqual(summary.links, [{ jobId: 3, status: 'scheduled', url: 'https://example.com/p', scheduledAt: '2026-08-31T14:00:00Z' }]);
});
