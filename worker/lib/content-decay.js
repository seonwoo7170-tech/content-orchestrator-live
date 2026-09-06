const DECAY_POLICY = Object.freeze({
  version: 'smileseon-content-decay.v1',
  minimumSnapshotGapDays: 7,
  minimumBaselineImpressions: 10,
  materialRatio: 0.75,
  ctrRatio: 0.8,
  positionWorsening: 2,
  minimumRepairScore: 40
});

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function canonicalHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

function daysBetween(later, earlier) {
  const a = Date.parse(`${later}T00:00:00Z`);
  const b = Date.parse(`${earlier}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((a - b) / 86400000);
}

function aggregatePages(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const page = canonicalHttpUrl(row.page);
    if (!page) continue;
    const current = map.get(page) || { page, clicks: 0, impressions: 0, weightedPosition: 0, positionWeight: 0 };
    const impressions = Math.max(0, Number(row.impressions) || 0);
    const clicks = Math.max(0, Number(row.clicks) || 0);
    const position = Math.max(0, Number(row.position) || 0);
    current.impressions += impressions;
    current.clicks += clicks;
    if (position > 0) {
      const weight = impressions > 0 ? impressions : 1;
      current.weightedPosition += position * weight;
      current.positionWeight += weight;
    }
    map.set(page, current);
  }
  return new Map([...map.entries()].map(([page, row]) => [page, {
    page,
    clicks: Number(row.clicks.toFixed(4)),
    impressions: Number(row.impressions.toFixed(4)),
    ctr: row.impressions > 0 ? Number((row.clicks / row.impressions).toFixed(6)) : 0,
    position: row.positionWeight > 0 ? Number((row.weightedPosition / row.positionWeight).toFixed(4)) : 0
  }]));
}

function ratio(latest, baseline) {
  if (!(baseline > 0)) return null;
  return Number((latest / baseline).toFixed(4));
}

export function scoreContentDecay(latest, baseline, policy = DECAY_POLICY) {
  if (!latest || !baseline || Number(baseline.impressions || 0) < policy.minimumBaselineImpressions) {
    return { action: 'maintain', decayScore: 0, reasons: ['insufficient_page_evidence'] };
  }
  const ratios = {
    clicks: ratio(Number(latest.clicks || 0), Number(baseline.clicks || 0)),
    impressions: ratio(Number(latest.impressions || 0), Number(baseline.impressions || 0)),
    ctr: ratio(Number(latest.ctr || 0), Number(baseline.ctr || 0))
  };
  const positionDelta = Number((Number(latest.position || 0) - Number(baseline.position || 0)).toFixed(4));
  const reasons = [];
  let decayScore = 0;

  if (ratios.clicks != null && ratios.clicks <= policy.materialRatio) {
    decayScore += 35;
    reasons.push('search_clicks_declining');
  }
  if (ratios.impressions != null && ratios.impressions <= policy.materialRatio) {
    decayScore += 30;
    reasons.push('search_impressions_declining');
  }
  if (ratios.ctr != null && ratios.ctr <= policy.ctrRatio && Number(baseline.impressions || 0) >= policy.minimumBaselineImpressions) {
    decayScore += 15;
    reasons.push('search_ctr_declining');
  }
  if (Number(baseline.position || 0) > 0 && positionDelta >= policy.positionWorsening) {
    decayScore += 20;
    reasons.push('average_position_worsening');
  }

  return {
    action: decayScore >= policy.minimumRepairScore ? 'repair' : 'maintain',
    decayScore: Math.min(100, decayScore),
    reasons: reasons.length ? reasons : ['no_material_decay'],
    ratios,
    positionDelta
  };
}

export function buildContentDecayRows(latestRows = [], baselineRows = [], meta = {}, policy = DECAY_POLICY) {
  const latest = aggregatePages(latestRows);
  const baseline = aggregatePages(baselineRows);
  const rows = [];
  for (const [page, latestMetrics] of latest) {
    const baselineMetrics = baseline.get(page);
    if (!baselineMetrics) continue;
    const scored = scoreContentDecay(latestMetrics, baselineMetrics, policy);
    rows.push({
      blogId: String(meta.blogId || ''),
      page,
      action: scored.action,
      decayScore: scored.decayScore,
      reasons: scored.reasons,
      ratios: scored.ratios || null,
      positionDelta: scored.positionDelta ?? null,
      latestSnapshotDate: meta.latestSnapshotDate || null,
      baselineSnapshotDate: meta.baselineSnapshotDate || null,
      snapshotGapDays: Number(meta.snapshotGapDays || 0),
      latest: latestMetrics,
      baseline: baselineMetrics,
      policyVersion: policy.version
    });
  }
  return rows.sort((a, b) => b.decayScore - a.decayScore || b.baseline.impressions - a.baseline.impressions || a.page.localeCompare(b.page));
}

async function snapshotPair(db, blogId, policy) {
  const result = await db.prepare(
    `SELECT DISTINCT snapshot_date FROM gsc_query_page_rows
      WHERE blog_id = ? ORDER BY snapshot_date DESC LIMIT 60`
  ).bind(String(blogId)).all();
  const dates = (result.results || []).map((row) => String(row.snapshot_date || '')).filter(Boolean);
  const latest = dates[0] || null;
  if (!latest) return null;
  const baseline = dates.find((date) => daysBetween(latest, date) >= policy.minimumSnapshotGapDays) || null;
  if (!baseline) return null;
  return { latest, baseline, gapDays: daysBetween(latest, baseline) };
}

async function rowsForSnapshot(db, blogId, snapshotDate) {
  const result = await db.prepare(
    `SELECT page, clicks, impressions, ctr, position
       FROM gsc_query_page_rows WHERE blog_id = ? AND snapshot_date = ? AND page <> ''`
  ).bind(String(blogId), String(snapshotDate)).all();
  return result.results || [];
}

export async function listContentDecay(env, options = {}) {
  const db = requireDb(env);
  const blogId = String(options.blogId || '').trim();
  if (!blogId) throw Object.assign(new Error('CONTENT_DECAY_BLOG_ID_REQUIRED'), { status: 400 });
  const limit = Math.max(1, Math.min(100, Number(options.limit || 30)));
  const pair = await snapshotPair(db, blogId, DECAY_POLICY);
  if (!pair) {
    return {
      ok: true,
      blogId,
      evidenceAvailable: false,
      reason: 'INSUFFICIENT_GSC_SNAPSHOT_HISTORY',
      policyVersion: DECAY_POLICY.version,
      rows: []
    };
  }
  const [latestRows, baselineRows] = await Promise.all([
    rowsForSnapshot(db, blogId, pair.latest),
    rowsForSnapshot(db, blogId, pair.baseline)
  ]);
  const rows = buildContentDecayRows(latestRows, baselineRows, {
    blogId,
    latestSnapshotDate: pair.latest,
    baselineSnapshotDate: pair.baseline,
    snapshotGapDays: pair.gapDays
  });
  return {
    ok: true,
    blogId,
    evidenceAvailable: true,
    policyVersion: DECAY_POLICY.version,
    latestSnapshotDate: pair.latest,
    baselineSnapshotDate: pair.baseline,
    snapshotGapDays: pair.gapDays,
    repairCandidates: rows.filter((row) => row.action === 'repair').length,
    rows: rows.slice(0, limit)
  };
}

export { DECAY_POLICY };
