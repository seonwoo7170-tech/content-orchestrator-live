import test from 'node:test';
import assert from 'node:assert/strict';
import { orderPendingWork } from '../worker/lib/daily-auto-work.js';

test('automatic work alternates blogs round-robin within each work kind and slot round', () => {
  const now = new Date('2026-08-31T00:00:00Z');
  const blogOrder = ['ai', 'home', 'info', 'life'];
  const ordered = orderPendingWork([
    { id: 8, status: 'pending', recovery_state: 'none', priority_score: 99, blog_id: 'life', kind: 'new_article', slot_no: 2 },
    { id: 4, status: 'pending', recovery_state: 'none', priority_score: 20, blog_id: 'life', kind: 'new_article', slot_no: 1 },
    { id: 1, status: 'pending', recovery_state: 'none', priority_score: 10, blog_id: 'ai', kind: 'new_article', slot_no: 1 },
    { id: 5, status: 'pending', recovery_state: 'none', priority_score: 10, blog_id: 'ai', kind: 'new_article', slot_no: 2 },
    { id: 3, status: 'pending', recovery_state: 'none', priority_score: 90, blog_id: 'info', kind: 'new_article', slot_no: 1 },
    { id: 7, status: 'pending', recovery_state: 'none', priority_score: 90, blog_id: 'info', kind: 'new_article', slot_no: 2 },
    { id: 2, status: 'pending', recovery_state: 'none', priority_score: 80, blog_id: 'home', kind: 'new_article', slot_no: 1 },
    { id: 6, status: 'pending', recovery_state: 'none', priority_score: 80, blog_id: 'home', kind: 'new_article', slot_no: 2 },
    { id: 9, status: 'pending', recovery_state: 'none', priority_score: 100, blog_id: 'ai', kind: 'repair_existing', slot_no: 1 },
    { id: 10, status: 'pending', recovery_state: 'none', priority_score: 100, blog_id: 'home', kind: 'repair_existing', slot_no: 1 }
  ], now, blogOrder);
  assert.deepEqual(ordered.map((slot) => slot.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('held and not-yet-due retry slots are excluded even when their priority is high', () => {
  const now = new Date('2026-08-31T00:00:00Z');
  const ordered = orderPendingWork([
    { id: 1, status: 'pending', recovery_state: 'held', priority_score: 100, blog_id: 'a', kind: 'new_article', slot_no: 1 },
    { id: 2, status: 'pending', recovery_state: 'retry_wait', next_retry_at: '2026-08-31T01:00:00.000Z', priority_score: 99, blog_id: 'b', kind: 'new_article', slot_no: 1 },
    { id: 3, status: 'pending', recovery_state: 'none', priority_score: 50, blog_id: 'c', kind: 'new_article', slot_no: 1 }
  ], now, ['a', 'b', 'c']);
  assert.deepEqual(ordered.map((slot) => slot.id), [3]);
});
