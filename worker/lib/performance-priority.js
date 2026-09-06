function hostOf(value) {
  try { return new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; }
}

function isTistory(value) {
  const host = hostOf(value);
  return host === 'tistory.com' || host.endsWith('.tistory.com');
}

function rowsByBlog(rows = []) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const blogId = String(row?.blogId ?? row?.blog_id ?? '').trim();
    if (!blogId) continue;
    if (!map.has(blogId)) map.set(blogId, []);
    map.get(blogId).push(row);
  }
  return map;
}

function rowWindowDays(row) {
  const value = Number(row?.windowDays ?? row?.window_days);
  return Number.isFinite(value) ? value : null;
}

function usableRow(row) {
  const status = String(row?.status || 'ok').toLowerCase();
  return !['failed', 'error', 'unmapped', 'not_configured'].includes(status);
}

function latestWindowRow(rows, windowDays) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => rowWindowDays(row) === windowDays && usableRow(row))
    .sort((a, b) => String(b?.snapshot_date ?? b?.snapshotDate ?? b?.collected_at ?? '').localeCompare(String(a?.snapshot_date ?? a?.snapshotDate ?? a?.collected_at ?? '')))[0] || null;
}

function metric(row, snake, camel = snake) {
  const value = Number(row?.[snake] ?? row?.[camel]);
  return Number.isFinite(value) ? value : 0;
}

function weeklyRatio(row7, row28, snake, camel = snake) {
  if (!row7 || !row28) return null;
  const baseline = metric(row28, snake, camel) / 4;
  if (baseline <= 0) return null;
  return metric(row7, snake, camel) / baseline;
}

function rounded(value) {
  return value == null ? null : Math.round(value * 1000) / 1000;
}

export const PERFORMANCE_PRIORITY_POLICY = Object.freeze({
  version: 'phase4-v1',
  growthRatio: 1.2,
  softGrowthRatio: 1.15,
  declineRatio: 0.75,
  ctrDropRatio: 0.8,
  minWeeklyImpressionsForCtrRepair: 50,
  minimumDecisionScore: 40
});

export function buildPerformancePriorityInputs({ blogs = [], gsc = [], ga4 = [], adsense = [] } = {}) {
  const managedBlogs = (Array.isArray(blogs) ? blogs : [])
    .map((blog) => ({
      blogId: String(blog?.blogId ?? blog?.id ?? '').trim(),
      name: blog?.name || null,
      url: blog?.url || null
    }))
    .filter((blog) => blog.blogId && !isTistory(blog.url));

  const gscByBlog = rowsByBlog(gsc);
  const ga4ByBlog = rowsByBlog(ga4);
  const adsenseByBlog = rowsByBlog(adsense);

  return managedBlogs.map((blog) => {
    const ga4Rows = ga4ByBlog.get(blog.blogId) || [];
    const ga4Configured = ga4Rows.some((row) => usableRow(row));
    return {
      ...blog,
      sources: {
        gsc: { available: gscByBlog.has(blog.blogId), rows: gscByBlog.get(blog.blogId) || [] },
        ga4: { available: ga4Configured, status: ga4Configured ? 'configured' : 'unmapped', rows: ga4Rows },
        adsense: { available: adsenseByBlog.has(blog.blogId), rows: adsenseByBlog.get(blog.blogId) || [] }
      }
    };
  });
}

export function scorePerformancePriority(input, policy = PERFORMANCE_PRIORITY_POLICY) {
  const gsc7 = latestWindowRow(input?.sources?.gsc?.rows, 7);
  const gsc28 = latestWindowRow(input?.sources?.gsc?.rows, 28);
  const ga47 = input?.sources?.ga4?.available ? latestWindowRow(input.sources.ga4.rows, 7) : null;
  const ga428 = input?.sources?.ga4?.available ? latestWindowRow(input.sources.ga4.rows, 28) : null;
  const adsense7 = latestWindowRow(input?.sources?.adsense?.rows, 7);
  const adsense28 = latestWindowRow(input?.sources?.adsense?.rows, 28);

  const ratios = {
    searchClicks: weeklyRatio(gsc7, gsc28, 'clicks'),
    searchImpressions: weeklyRatio(gsc7, gsc28, 'impressions'),
    sessions: weeklyRatio(ga47, ga428, 'sessions'),
    earnings: weeklyRatio(adsense7, adsense28, 'estimated_earnings', 'estimatedEarnings')
  };

  const reasons = [];
  let newScore = 0;
  let repairScore = 0;

  if (!gsc7 || !gsc28) {
    return {
      blogId: input?.blogId || null,
      action: 'maintain',
      priorityScore: 0,
      confidence: 'low',
      policyVersion: policy.version,
      reasons: ['insufficient_gsc_7_28_history'],
      ratios: Object.fromEntries(Object.entries(ratios).map(([key, value]) => [key, rounded(value)]))
    };
  }

  if (ratios.searchClicks != null && ratios.searchClicks >= policy.growthRatio) {
    newScore += 40;
    reasons.push('search_clicks_growing');
  }
  if (ratios.searchImpressions != null && ratios.searchImpressions >= policy.growthRatio) {
    newScore += 20;
    reasons.push('search_impressions_growing');
  }
  if (ratios.sessions != null && ratios.sessions >= policy.softGrowthRatio) {
    newScore += 15;
    reasons.push('sessions_growing');
  }
  if (ratios.earnings != null && ratios.earnings >= policy.softGrowthRatio) {
    newScore += 25;
    reasons.push('earnings_growing');
  }

  if (ratios.searchClicks != null && ratios.searchClicks < policy.declineRatio) {
    repairScore += 45;
    reasons.push('search_clicks_declining');
  }
  const ctr7 = metric(gsc7, 'ctr');
  const ctr28 = metric(gsc28, 'ctr');
  if (metric(gsc7, 'impressions') >= policy.minWeeklyImpressionsForCtrRepair && ctr28 > 0 && ctr7 < ctr28 * policy.ctrDropRatio) {
    repairScore += 25;
    reasons.push('ctr_declining_with_impressions');
  }
  if (ratios.sessions != null && ratios.sessions < policy.declineRatio) {
    repairScore += 15;
    reasons.push('sessions_declining');
  }
  if (ratios.earnings != null && ratios.earnings < policy.declineRatio) {
    repairScore += 15;
    reasons.push('earnings_declining');
  }

  let action = 'maintain';
  let priorityScore = Math.max(newScore, repairScore);
  if (repairScore >= policy.minimumDecisionScore && repairScore > newScore) action = 'repair';
  else if (newScore >= policy.minimumDecisionScore && newScore > repairScore) action = 'new';
  else {
    priorityScore = Math.min(priorityScore, policy.minimumDecisionScore - 1);
    reasons.push('no_strong_direction');
  }

  const evidencePairs = [gsc7 && gsc28, ga47 && ga428, adsense7 && adsense28].filter(Boolean).length;
  return {
    blogId: input?.blogId || null,
    action,
    priorityScore,
    confidence: evidencePairs >= 3 ? 'high' : evidencePairs === 2 ? 'medium' : 'low',
    policyVersion: policy.version,
    reasons: [...new Set(reasons)],
    ratios: Object.fromEntries(Object.entries(ratios).map(([key, value]) => [key, rounded(value)]))
  };
}

export function rankPerformancePriorities(inputs = [], policy = PERFORMANCE_PRIORITY_POLICY) {
  return (Array.isArray(inputs) ? inputs : [])
    .map((input) => ({ ...input, priority: scorePerformancePriority(input, policy) }))
    .sort((a, b) => b.priority.priorityScore - a.priority.priorityScore || String(a.blogId).localeCompare(String(b.blogId)));
}
