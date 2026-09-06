import { classifySearchIntent } from './topic-candidates.js';

const STOPWORDS = new Set([
  '방법', '정리', '가이드', '알아보기', '추천', '비교', '후기', '리뷰', 'the', 'and', 'for', 'with', 'how', 'what', 'best', 'guide', 'review'
]);

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function safeText(value, max = 300) {
  return String(value || '').trim().slice(0, max);
}

function canonicalHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

export function tokenizeTopic(value) {
  return [...new Set(String(value || '')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/gi, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token)))];
}

export function topicSimilarity(left, right) {
  const a = new Set(tokenizeTopic(left));
  const b = new Set(tokenizeTopic(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  const jaccard = union > 0 ? shared / union : 0;
  const containment = shared / Math.min(a.size, b.size);
  return Number((jaccard * 0.65 + containment * 0.35).toFixed(4));
}

function relatedEnough(left, right) {
  const a = tokenizeTopic(left);
  const b = tokenizeTopic(right);
  const shared = a.filter((token) => b.includes(token)).length;
  return shared >= 2 || topicSimilarity(left, right) >= 0.58;
}

function stableClusterKey(blogId, ids) {
  const text = `${blogId}|${[...ids].sort((a, b) => Number(a) - Number(b)).join(',')}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `cluster-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function buildContentClusters(candidates = []) {
  const byBlog = new Map();
  for (const candidate of candidates) {
    const blogId = safeText(candidate.blog_id ?? candidate.blogId, 80);
    const query = safeText(candidate.query, 300);
    if (!blogId || !query) continue;
    if (!byBlog.has(blogId)) byBlog.set(blogId, []);
    byBlog.get(blogId).push({ ...candidate, blog_id: blogId, query });
  }

  const clusters = [];
  for (const [blogId, rows] of byBlog) {
    const parent = rows.map((_, index) => index);
    const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        if (relatedEnough(rows[i].query, rows[j].query)) union(i, j);
      }
    }
    const groups = new Map();
    rows.forEach((row, index) => {
      const root = find(index);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(row);
    });
    for (const members of groups.values()) {
      members.sort((a, b) => Number(b.opportunity_score || 0) - Number(a.opportunity_score || 0)
        || Number(b.impressions || 0) - Number(a.impressions || 0)
        || Number(a.id || 0) - Number(b.id || 0));
      const hub = members[0];
      clusters.push({
        blogId,
        clusterKey: stableClusterKey(blogId, members.map((row) => row.id)),
        label: hub.query,
        hubCandidateId: Number(hub.id),
        members: members.map((row, index) => ({
          candidateId: Number(row.id),
          role: index === 0 ? 'hub' : 'spoke',
          similarity: index === 0 ? 1 : topicSimilarity(hub.query, row.query)
        }))
      });
    }
  }
  return clusters.sort((a, b) => a.blogId.localeCompare(b.blogId) || b.members.length - a.members.length || a.label.localeCompare(b.label));
}

export function buildInternalLinkRecommendations(clusters = [], candidates = []) {
  const candidateById = new Map(candidates.map((row) => [Number(row.id), row]));
  const recommendations = [];
  for (const cluster of clusters) {
    const hub = candidateById.get(Number(cluster.hubCandidateId));
    const hubUrl = canonicalHttpUrl(hub?.target_page ?? hub?.targetPage);
    if (!hubUrl) continue;
    const seen = new Set();
    for (const member of cluster.members) {
      if (member.role === 'hub') continue;
      const row = candidateById.get(Number(member.candidateId));
      const sourceUrl = canonicalHttpUrl(row?.target_page ?? row?.targetPage);
      if (!sourceUrl || sourceUrl === hubUrl) continue;
      const key = `${sourceUrl}\u0000${hubUrl}`;
      if (seen.has(key)) continue;
      seen.add(key);
      recommendations.push({
        blogId: cluster.blogId,
        clusterKey: cluster.clusterKey,
        sourceUrl,
        targetUrl: hubUrl,
        anchorText: safeText(hub?.query || cluster.label, 160),
        score: Number((member.similarity * 100 + Number(hub?.opportunity_score || 0) / 10).toFixed(2)),
        reason: 'spoke_to_cluster_hub'
      });
    }
  }
  return recommendations.sort((a, b) => b.score - a.score || a.sourceUrl.localeCompare(b.sourceUrl));
}

export function detectCannibalization(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const blogId = safeText(row.blog_id ?? row.blogId, 80);
    const query = safeText(row.query, 300);
    const page = canonicalHttpUrl(row.page);
    if (!blogId || !query || !page) continue;
    const key = `${blogId}\u0000${query.toLowerCase()}`;
    if (!grouped.has(key)) grouped.set(key, new Map());
    const pages = grouped.get(key);
    const current = pages.get(page) || { blogId, query, page, impressions: 0, clicks: 0, snapshotDate: safeText(row.snapshot_date ?? row.snapshotDate, 30) };
    current.impressions += Math.max(0, Number(row.impressions) || 0);
    current.clicks += Math.max(0, Number(row.clicks) || 0);
    pages.set(page, current);
  }

  const conflicts = [];
  for (const pages of grouped.values()) {
    const ranked = [...pages.values()].sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.page.localeCompare(b.page));
    if (ranked.length < 2) continue;
    const total = ranked.reduce((sum, row) => sum + row.impressions, 0);
    const primary = ranked[0];
    for (const competitor of ranked.slice(1)) {
      if (primary.impressions <= 0 || competitor.impressions <= 0) continue;
      const primaryShare = total > 0 ? primary.impressions / total : 0;
      const competitorShare = total > 0 ? competitor.impressions / total : 0;
      const evidenceScore = Number(Math.min(100, Math.log1p(total) * 12 + competitorShare * 45).toFixed(2));
      const decision = primaryShare >= 0.72 && competitorShare <= 0.2
        ? 'repair_internal_links'
        : primaryShare < 0.62
          ? 'review_merge'
          : 'review_intent_split';
      conflicts.push({
        blogId: primary.blogId,
        query: primary.query,
        primaryPage: primary.page,
        competingPage: competitor.page,
        evidenceScore,
        decision,
        snapshotDate: primary.snapshotDate || competitor.snapshotDate || null
      });
    }
  }
  return conflicts.sort((a, b) => b.evidenceScore - a.evidenceScore || a.query.localeCompare(b.query));
}

async function loadCandidateRows(db) {
  const result = await db.prepare(
    `SELECT id, blog_id, query, intent, source, snapshot_date, clicks, impressions, ctr, position,
            opportunity_score, target_page, status, claimed_at, claimed_job_id, origin_idea_id
       FROM topic_candidates
      WHERE status <> 'rejected'
      ORDER BY blog_id, opportunity_score DESC, impressions DESC, id`
  ).all();
  return result.results || [];
}

async function loadLatestGscRows(db) {
  const result = await db.prepare(
    `SELECT r.snapshot_date, r.blog_id, r.query, r.page, r.clicks, r.impressions, r.ctr, r.position
       FROM gsc_query_page_rows r
       JOIN (SELECT blog_id, MAX(snapshot_date) AS snapshot_date FROM gsc_query_page_rows GROUP BY blog_id) x
         ON x.blog_id = r.blog_id AND x.snapshot_date = r.snapshot_date
      WHERE r.query <> '' AND r.page <> ''`
  ).all();
  return result.results || [];
}

export async function refreshContentStrategy(env) {
  const db = requireDb(env);
  const [candidates, gscRows] = await Promise.all([loadCandidateRows(db), loadLatestGscRows(db)]);
  const clusters = buildContentClusters(candidates);
  const linkRows = buildInternalLinkRecommendations(clusters, candidates);
  const conflicts = detectCannibalization(gscRows);

  await db.prepare('DELETE FROM content_cluster_members').run();
  await db.prepare('DELETE FROM content_clusters').run();
  await db.prepare("DELETE FROM internal_link_recommendations WHERE status = 'suggested'").run();
  await db.prepare("DELETE FROM content_conflicts WHERE status = 'open'").run();

  const clusterIdByKey = new Map();
  for (const cluster of clusters) {
    await db.prepare(
      `INSERT INTO content_clusters (blog_id, cluster_key, label, hub_candidate_id, member_count, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(cluster.blogId, cluster.clusterKey, cluster.label, cluster.hubCandidateId, cluster.members.length).run();
    const stored = await db.prepare('SELECT id FROM content_clusters WHERE blog_id = ? AND cluster_key = ? LIMIT 1')
      .bind(cluster.blogId, cluster.clusterKey).first();
    if (!stored?.id) throw new Error('CONTENT_CLUSTER_STORE_FAILED');
    clusterIdByKey.set(`${cluster.blogId}\u0000${cluster.clusterKey}`, Number(stored.id));
    for (const member of cluster.members) {
      await db.prepare(
        `INSERT INTO content_cluster_members (cluster_id, candidate_id, role, similarity) VALUES (?, ?, ?, ?)`
      ).bind(Number(stored.id), member.candidateId, member.role, member.similarity).run();
    }
  }

  for (const row of linkRows) {
    const clusterId = clusterIdByKey.get(`${row.blogId}\u0000${row.clusterKey}`) || null;
    await db.prepare(
      `INSERT INTO internal_link_recommendations
       (blog_id, cluster_id, source_url, target_url, anchor_text, reason, score, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'suggested', datetime('now'), datetime('now'))
       ON CONFLICT(blog_id, source_url, target_url) DO UPDATE SET
         cluster_id=excluded.cluster_id, anchor_text=excluded.anchor_text, reason=excluded.reason,
         score=excluded.score, updated_at=datetime('now')`
    ).bind(row.blogId, clusterId, row.sourceUrl, row.targetUrl, row.anchorText, row.reason, row.score).run();
  }

  for (const row of conflicts) {
    await db.prepare(
      `INSERT INTO content_conflicts
       (blog_id, query, primary_page, competing_page, evidence_score, decision, status, snapshot_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, datetime('now'), datetime('now'))
       ON CONFLICT(blog_id, query, primary_page, competing_page) DO UPDATE SET
         evidence_score=excluded.evidence_score, decision=excluded.decision, snapshot_date=excluded.snapshot_date,
         updated_at=datetime('now')`
    ).bind(row.blogId, row.query, row.primaryPage, row.competingPage, row.evidenceScore, row.decision, row.snapshotDate).run();
  }

  return { ok: true, candidates: candidates.length, clusters: clusters.length, internalLinks: linkRows.length, conflicts: conflicts.length };
}

export async function listContentStrategy(env, options = {}) {
  const db = requireDb(env);
  const blogId = safeText(options.blogId, 80);
  const limit = Math.max(1, Math.min(100, Number(options.limit || 30)));
  const bind = blogId ? [blogId, limit] : [limit];
  const where = blogId ? ' WHERE blog_id = ?' : '';
  const [clusters, links, conflicts, ideas] = await Promise.all([
    db.prepare(`SELECT id, blog_id, cluster_key, label, hub_candidate_id, member_count, updated_at FROM content_clusters${where} ORDER BY member_count DESC, label LIMIT ?`).bind(...bind).all(),
    db.prepare(`SELECT id, blog_id, cluster_id, source_url, target_url, anchor_text, reason, score, status, updated_at FROM internal_link_recommendations${where} ORDER BY score DESC, id DESC LIMIT ?`).bind(...bind).all(),
    db.prepare(`SELECT id, blog_id, query, primary_page, competing_page, evidence_score, decision, status, snapshot_date, updated_at FROM content_conflicts${where} ORDER BY evidence_score DESC, id DESC LIMIT ?`).bind(...bind).all(),
    db.prepare(`SELECT id, blog_id, title, query, intent, notes, source, priority, status, applied_candidate_id, created_at, updated_at FROM idea_bank${where} ORDER BY priority DESC, id DESC LIMIT ?`).bind(...bind).all()
  ]);
  return {
    ok: true,
    clusters: clusters.results || [],
    internalLinks: links.results || [],
    conflicts: conflicts.results || [],
    ideas: ideas.results || []
  };
}

export async function createIdea(env, input = {}) {
  const db = requireDb(env);
  const blogId = safeText(input.blogId, 80);
  const title = safeText(input.title || input.query, 200);
  const query = safeText(input.query || input.title, 300);
  if (!blogId) throw Object.assign(new Error('BLOG_ID_REQUIRED'), { status: 400 });
  if (!title || !query) throw Object.assign(new Error('IDEA_TITLE_REQUIRED'), { status: 400 });
  const intent = safeText(input.intent, 40) || classifySearchIntent(query);
  const priority = Math.round(clamp(input.priority ?? 50, 0, 100));
  const notes = safeText(input.notes, 1000) || null;
  const result = await db.prepare(
    `INSERT INTO idea_bank (blog_id, title, query, intent, notes, source, priority, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'manual', ?, 'idea', datetime('now'), datetime('now'))`
  ).bind(blogId, title, query, intent, notes, priority).run();
  const id = Number(result?.meta?.last_row_id || 0);
  return { ok: true, id, blogId, title, query, intent, priority };
}

export async function applyIdeaToCandidates(env, ideaId) {
  const db = requireDb(env);
  const id = Number(ideaId);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('IDEA_ID_INVALID'), { status: 400 });
  const idea = await db.prepare('SELECT * FROM idea_bank WHERE id = ? LIMIT 1').bind(id).first();
  if (!idea) throw Object.assign(new Error('IDEA_NOT_FOUND'), { status: 404 });
  const existing = await db.prepare('SELECT id, target_page, status FROM topic_candidates WHERE blog_id = ? AND query = ? LIMIT 1')
    .bind(String(idea.blog_id), String(idea.query)).first();
  if (existing?.target_page) {
    await db.prepare("UPDATE idea_bank SET status = 'review', updated_at = datetime('now') WHERE id = ?").bind(id).run();
    return { ok: false, conflict: true, reason: 'QUERY_ALREADY_HAS_TARGET_PAGE', existingCandidateId: Number(existing.id) };
  }
  await db.prepare(
    `INSERT INTO topic_candidates
      (blog_id, query, intent, source, snapshot_date, clicks, impressions, ctr, position, opportunity_score,
       target_page, status, origin_idea_id, created_at, updated_at)
     VALUES (?, ?, ?, 'idea', date('now'), 0, 0, 0, 0, ?, NULL, 'candidate', ?, datetime('now'), datetime('now'))
     ON CONFLICT(blog_id, query) DO UPDATE SET
       intent=excluded.intent, source='idea', opportunity_score=excluded.opportunity_score,
       status=CASE WHEN topic_candidates.status IN ('used','reserved') THEN topic_candidates.status ELSE 'candidate' END,
       origin_idea_id=excluded.origin_idea_id, updated_at=datetime('now')`
  ).bind(String(idea.blog_id), String(idea.query), String(idea.intent || classifySearchIntent(idea.query)), Number(idea.priority || 0), id).run();
  const candidate = await db.prepare('SELECT id FROM topic_candidates WHERE blog_id = ? AND query = ? LIMIT 1')
    .bind(String(idea.blog_id), String(idea.query)).first();
  if (!candidate?.id) throw new Error('IDEA_CANDIDATE_CREATE_FAILED');
  await db.prepare("UPDATE idea_bank SET status = 'candidate', applied_candidate_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(Number(candidate.id), id).run();
  return { ok: true, candidateId: Number(candidate.id), ideaId: id };
}

export async function reserveBestNewTopicCandidate(env, blogId) {
  const db = requireDb(env);
  const id = safeText(blogId, 80);
  if (!id) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await db.prepare(
      `SELECT id, blog_id, query, intent, source, opportunity_score, origin_idea_id
         FROM topic_candidates
        WHERE blog_id = ? AND status = 'candidate' AND target_page IS NULL AND source IN ('idea','manual')
        ORDER BY opportunity_score DESC, id ASC LIMIT 1`
    ).bind(id).first();
    if (!row?.id) return null;
    const result = await db.prepare(
      `UPDATE topic_candidates SET status = 'reserved', claimed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND status = 'candidate'`
    ).bind(Number(row.id)).run();
    if (Number(result?.meta?.changes || 0) === 1) return row;
  }
  return null;
}

export async function releaseTopicCandidate(env, candidateId) {
  const id = Number(candidateId);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await requireDb(env).prepare(
    `UPDATE topic_candidates SET status = 'candidate', claimed_at = NULL, claimed_job_id = NULL, updated_at = datetime('now')
     WHERE id = ? AND status = 'reserved'`
  ).bind(id).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function markTopicCandidateUsed(env, candidateId, jobId) {
  const id = Number(candidateId);
  const job = Number(jobId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(job) || job <= 0) return false;
  const result = await requireDb(env).prepare(
    `UPDATE topic_candidates SET status = 'used', claimed_job_id = ?, updated_at = datetime('now')
     WHERE id = ? AND status IN ('reserved','candidate')`
  ).bind(job, id).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function recordPlannerTopic(env, { blogId, topic, jobId }) {
  const db = requireDb(env);
  const query = safeText(topic, 300);
  const blog = safeText(blogId, 80);
  if (!blog || !query) return null;
  const existing = await db.prepare('SELECT id, target_page FROM topic_candidates WHERE blog_id = ? AND query = ? LIMIT 1').bind(blog, query).first();
  if (existing?.target_page) return { candidateId: Number(existing.id), existingTarget: true };
  await db.prepare(
    `INSERT INTO topic_candidates
      (blog_id, query, intent, source, snapshot_date, clicks, impressions, ctr, position, opportunity_score,
       target_page, status, claimed_at, claimed_job_id, created_at, updated_at)
     VALUES (?, ?, ?, 'planner', date('now'), 0, 0, 0, 0, 0, NULL, 'used', datetime('now'), ?, datetime('now'), datetime('now'))
     ON CONFLICT(blog_id, query) DO UPDATE SET
       status='used', claimed_job_id=excluded.claimed_job_id, updated_at=datetime('now')`
  ).bind(blog, query, classifySearchIntent(query), Number(jobId) || null).run();
  const stored = await db.prepare('SELECT id FROM topic_candidates WHERE blog_id = ? AND query = ? LIMIT 1').bind(blog, query).first();
  return stored?.id ? { candidateId: Number(stored.id), existingTarget: false } : null;
}

export async function listStrategyAvoidTopics(env, blogId, limit = 30) {
  const rows = await requireDb(env).prepare(
    `SELECT query, target_page, opportunity_score FROM topic_candidates
      WHERE blog_id = ? AND target_page IS NOT NULL AND status <> 'rejected'
      ORDER BY opportunity_score DESC, impressions DESC LIMIT ?`
  ).bind(String(blogId), Math.max(1, Math.min(100, Number(limit) || 30))).all();
  return (rows.results || []).map((row) => ({ query: row.query, targetPage: row.target_page, opportunityScore: Number(row.opportunity_score || 0) }));
}

export async function strategyLinksForTopic(env, blogId, topic, limit = 3) {
  const rows = await requireDb(env).prepare(
    `SELECT query, target_page, opportunity_score FROM topic_candidates
      WHERE blog_id = ? AND target_page IS NOT NULL AND status <> 'rejected'
      ORDER BY opportunity_score DESC, impressions DESC LIMIT 200`
  ).bind(String(blogId)).all();
  return (rows.results || [])
    .map((row) => ({
      query: row.query,
      url: canonicalHttpUrl(row.target_page),
      similarity: topicSimilarity(topic, row.query),
      opportunityScore: Number(row.opportunity_score || 0)
    }))
    .filter((row) => row.url && row.similarity >= 0.28)
    .sort((a, b) => b.similarity - a.similarity || b.opportunityScore - a.opportunityScore)
    .slice(0, Math.max(0, Math.min(5, Number(limit) || 3)));
}
