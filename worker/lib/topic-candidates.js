const INTENTS = new Set(['informational', 'commercial', 'transactional', 'navigational']);

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

export function classifySearchIntent(query) {
  const text = String(query || '').trim().toLowerCase();
  if (!text) return 'informational';
  if (/(구매|가격|할인|쿠폰|신청|예약|다운로드|buy|price|coupon|discount|order|download)/i.test(text)) return 'transactional';
  if (/(추천|비교|후기|리뷰|순위|베스트|어떤|vs\b|best\b|review\b|compare\b|top\b)/i.test(text)) return 'commercial';
  if (/(공식|로그인|홈페이지|사이트|official\b|login\b|website\b)/i.test(text)) return 'navigational';
  return 'informational';
}

export function calculateOpportunityScore({ impressions = 0, clicks = 0, position = 0 } = {}) {
  const imp = Math.max(0, Number(impressions) || 0);
  const clk = Math.max(0, Number(clicks) || 0);
  const pos = Math.max(0, Number(position) || 0);
  const visibility = Math.log1p(imp) * 20;
  const rankingOpportunity = pos > 0 ? Math.max(0, 20 - Math.min(pos, 20)) * 2 : 0;
  const provenDemand = Math.log1p(clk) * 10;
  return Number((visibility + rankingOpportunity + provenDemand).toFixed(2));
}

function aggregateRows(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const blogId = String(row.blog_id || '').trim();
    const query = String(row.query || '').trim();
    if (!blogId || !query) continue;
    const key = `${blogId}\u0000${query.toLowerCase()}`;
    const current = grouped.get(key) || {
      blogId, query, snapshotDate: String(row.snapshot_date || ''), clicks: 0, impressions: 0,
      weightedPosition: 0, positionWeight: 0, targetPage: '', targetPageImpressions: -1
    };
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
    if (impressions > current.targetPageImpressions) {
      current.targetPage = String(row.page || '');
      current.targetPageImpressions = impressions;
    }
    grouped.set(key, current);
  }
  return [...grouped.values()].map((row) => {
    const position = row.positionWeight > 0 ? row.weightedPosition / row.positionWeight : 0;
    const ctr = row.impressions > 0 ? row.clicks / row.impressions : 0;
    return {
      blogId: row.blogId,
      query: row.query,
      snapshotDate: row.snapshotDate,
      clicks: Number(row.clicks.toFixed(4)),
      impressions: Number(row.impressions.toFixed(4)),
      ctr: Number(ctr.toFixed(6)),
      position: Number(position.toFixed(4)),
      intent: classifySearchIntent(row.query),
      targetPage: row.targetPage || null,
      opportunityScore: calculateOpportunityScore({ impressions: row.impressions, clicks: row.clicks, position })
    };
  });
}

export async function refreshTopicCandidatesFromGsc(env) {
  const db = requireDb(env);
  const latest = await db.prepare(
    `SELECT r.snapshot_date, r.blog_id, r.query, r.page, r.clicks, r.impressions, r.ctr, r.position
       FROM gsc_query_page_rows r
       JOIN (SELECT blog_id, MAX(snapshot_date) AS snapshot_date FROM gsc_query_page_rows GROUP BY blog_id) x
         ON x.blog_id = r.blog_id AND x.snapshot_date = r.snapshot_date
      WHERE r.query <> ''
      ORDER BY r.blog_id, r.impressions DESC`
  ).all();
  const candidates = aggregateRows(latest.results || []);
  const statements = candidates.map((row) => db.prepare(
    `INSERT INTO topic_candidates
      (blog_id, query, intent, source, snapshot_date, clicks, impressions, ctr, position, opportunity_score, target_page, status, created_at, updated_at)
     VALUES (?, ?, ?, 'gsc', ?, ?, ?, ?, ?, ?, ?, 'candidate', datetime('now'), datetime('now'))
     ON CONFLICT(blog_id, query) DO UPDATE SET
       intent=excluded.intent, source='gsc', snapshot_date=excluded.snapshot_date,
       clicks=excluded.clicks, impressions=excluded.impressions, ctr=excluded.ctr, position=excluded.position,
       opportunity_score=excluded.opportunity_score, target_page=excluded.target_page, updated_at=datetime('now')`
  ).bind(
    row.blogId, row.query, row.intent, row.snapshotDate, row.clicks, row.impressions,
    row.ctr, row.position, row.opportunityScore, row.targetPage
  ));
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
  return { ok: true, source: 'gsc', refreshedCount: candidates.length, candidates };
}

export async function listTopicCandidates(env, options = {}) {
  const db = requireDb(env);
  const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
  const where = [];
  const binds = [];
  if (options.blogId) { where.push('blog_id = ?'); binds.push(String(options.blogId)); }
  if (options.intent) {
    const intent = String(options.intent).toLowerCase();
    if (!INTENTS.has(intent)) throw Object.assign(new Error('INTENT_INVALID'), { status: 400 });
    where.push('intent = ?'); binds.push(intent);
  }
  if (options.status) { where.push('status = ?'); binds.push(String(options.status)); }
  const sql = `SELECT id, blog_id, query, intent, source, snapshot_date, clicks, impressions, ctr, position,
                      opportunity_score, target_page, status, created_at, updated_at
                 FROM topic_candidates${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
                ORDER BY opportunity_score DESC, impressions DESC, query COLLATE NOCASE
                LIMIT ?`;
  const rows = await db.prepare(sql).bind(...binds, limit).all();
  return { ok: true, count: (rows.results || []).length, rows: rows.results || [] };
}
