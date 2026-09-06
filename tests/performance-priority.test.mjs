import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPerformancePriorityInputs,
  rankPerformancePriorities,
  scorePerformancePriority
} from '../worker/lib/performance-priority.js';

test('performance priority inputs include only managed Blogger blogs and preserve unmapped GA4', () => {
  const result = buildPerformancePriorityInputs({
    blogs: [
      { blogId: '1', name: 'A', url: 'https://a.blogspot.com' },
      { blogId: '2', name: 'B', url: 'https://b.example.com' },
      { blogId: 'legacy', name: 'Old', url: 'https://old.tistory.com' }
    ],
    gsc: [{ blog_id: '1', clicks: 10 }, { blog_id: '2', clicks: 5 }, { blog_id: 'legacy', clicks: 99 }],
    ga4: [{ blog_id: '1', status: 'ok', sessions: 12 }, { blog_id: '2', status: 'unmapped' }],
    adsense: [{ blog_id: '1', estimated_earnings: 1.2 }, { blog_id: '2', estimated_earnings: 0.4 }]
  });

  assert.deepEqual(result.map((row) => row.blogId), ['1', '2']);
  assert.equal(result[0].sources.gsc.available, true);
  assert.equal(result[0].sources.ga4.status, 'configured');
  assert.equal(result[0].sources.adsense.available, true);
  assert.equal(result[1].sources.ga4.available, false);
  assert.equal(result[1].sources.ga4.status, 'unmapped');
  assert.equal(result.some((row) => row.blogId === 'legacy'), false);
});

test('missing analytics sources do not invent coverage', () => {
  const [row] = buildPerformancePriorityInputs({
    blogs: [{ blogId: '7', name: 'Only', url: 'https://only.blogspot.com' }]
  });

  assert.equal(row.sources.gsc.available, false);
  assert.equal(row.sources.ga4.available, false);
  assert.equal(row.sources.ga4.status, 'unmapped');
  assert.equal(row.sources.adsense.available, false);
});

test('scoring chooses new when 7-day Blogger momentum materially exceeds the 28-day weekly baseline', () => {
  const [input] = buildPerformancePriorityInputs({
    blogs: [{ blogId: 'growth', name: 'Growth', url: 'https://growth.blogspot.com' }],
    gsc: [
      { blog_id: 'growth', window_days: 7, status: 'ok', clicks: 40, impressions: 400, ctr: 0.10 },
      { blog_id: 'growth', window_days: 28, status: 'ok', clicks: 100, impressions: 1000, ctr: 0.10 }
    ],
    ga4: [
      { blog_id: 'growth', window_days: 7, status: 'ok', sessions: 140 },
      { blog_id: 'growth', window_days: 28, status: 'ok', sessions: 400 }
    ],
    adsense: [
      { blog_id: 'growth', window_days: 7, status: 'ok', estimated_earnings: 14 },
      { blog_id: 'growth', window_days: 28, status: 'ok', estimated_earnings: 40 }
    ]
  });

  const priority = scorePerformancePriority(input);
  assert.equal(priority.action, 'new');
  assert.equal(priority.confidence, 'high');
  assert.ok(priority.priorityScore >= 40);
  assert.ok(priority.reasons.includes('search_clicks_growing'));
});

test('scoring chooses repair on material search decline and does not require GA4 mapping', () => {
  const [input] = buildPerformancePriorityInputs({
    blogs: [{ blogId: 'repair', name: 'Repair', url: 'https://repair.example.com' }],
    gsc: [
      { blog_id: 'repair', window_days: 7, status: 'ok', clicks: 8, impressions: 120, ctr: 0.02 },
      { blog_id: 'repair', window_days: 28, status: 'ok', clicks: 80, impressions: 800, ctr: 0.05 }
    ],
    ga4: [{ blog_id: 'repair', window_days: 7, status: 'unmapped' }],
    adsense: [
      { blog_id: 'repair', window_days: 7, status: 'ok', estimated_earnings: 1 },
      { blog_id: 'repair', window_days: 28, status: 'ok', estimated_earnings: 16 }
    ]
  });

  const priority = scorePerformancePriority(input);
  assert.equal(input.sources.ga4.status, 'unmapped');
  assert.equal(priority.action, 'repair');
  assert.equal(priority.confidence, 'medium');
  assert.ok(priority.reasons.includes('search_clicks_declining'));
});

test('scoring fails closed to maintain when GSC 7/28 history is incomplete and ranking stays deterministic', () => {
  const inputs = buildPerformancePriorityInputs({
    blogs: [
      { blogId: 'b', name: 'B', url: 'https://b.blogspot.com' },
      { blogId: 'a', name: 'A', url: 'https://a.blogspot.com' },
      { blogId: 'legacy', name: 'Legacy', url: 'https://legacy.tistory.com' }
    ],
    gsc: [
      { blog_id: 'a', window_days: 7, status: 'ok', clicks: 5 },
      { blog_id: 'b', window_days: 7, status: 'ok', clicks: 3 }
    ]
  });

  const ranked = rankPerformancePriorities(inputs);
  assert.deepEqual(ranked.map((row) => row.blogId), ['a', 'b']);
  assert.equal(ranked[0].priority.action, 'maintain');
  assert.equal(ranked[0].priority.priorityScore, 0);
  assert.deepEqual(ranked[0].priority.reasons, ['insufficient_gsc_7_28_history']);
  assert.equal(ranked.some((row) => row.blogId === 'legacy'), false);
});
