import {
  buildContentClusters,
  buildInternalLinkRecommendations,
  detectCannibalization
} from './content-strategy.js';

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
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

export async function refreshContentStrategyAtomic(env) {
  const db = requireDb(env);
  const [candidates, gscRows] = await Promise.all([loadCandidateRows(db), loadLatestGscRows(db)]);
  const clusters = buildContentClusters(candidates);
  const linkRows = buildInternalLinkRecommendations(clusters, candidates);
  const conflicts = detectCannibalization(gscRows);

  const statements = [
    db.prepare("UPDATE internal_link_recommendations SET cluster_id = NULL WHERE status <> 'suggested'"),
    db.prepare('DELETE FROM content_cluster_members'),
    db.prepare('DELETE FROM content_clusters'),
    db.prepare("DELETE FROM internal_link_recommendations WHERE status = 'suggested'"),
    db.prepare("DELETE FROM content_conflicts WHERE status = 'open'")
  ];

  for (const cluster of clusters) {
    statements.push(db.prepare(
      `INSERT INTO content_clusters (blog_id, cluster_key, label, hub_candidate_id, member_count, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).bind(cluster.blogId, cluster.clusterKey, cluster.label, cluster.hubCandidateId, cluster.members.length));
    for (const member of cluster.members) {
      statements.push(db.prepare(
        `INSERT INTO content_cluster_members (cluster_id, candidate_id, role, similarity)
         VALUES ((SELECT id FROM content_clusters WHERE blog_id = ? AND cluster_key = ? LIMIT 1), ?, ?, ?)`
      ).bind(cluster.blogId, cluster.clusterKey, member.candidateId, member.role, member.similarity));
    }
  }

  for (const row of linkRows) {
    statements.push(db.prepare(
      `INSERT INTO internal_link_recommendations
       (blog_id, cluster_id, source_url, target_url, anchor_text, reason, score, status, created_at, updated_at)
       VALUES (?, (SELECT id FROM content_clusters WHERE blog_id = ? AND cluster_key = ? LIMIT 1), ?, ?, ?, ?, ?, 'suggested', datetime('now'), datetime('now'))
       ON CONFLICT(blog_id, source_url, target_url) DO UPDATE SET
         cluster_id=excluded.cluster_id, anchor_text=excluded.anchor_text, reason=excluded.reason,
         score=excluded.score, status='suggested', updated_at=datetime('now')`
    ).bind(row.blogId, row.blogId, row.clusterKey, row.sourceUrl, row.targetUrl, row.anchorText, row.reason, row.score));
  }

  for (const row of conflicts) {
    statements.push(db.prepare(
      `INSERT INTO content_conflicts
       (blog_id, query, primary_page, competing_page, evidence_score, decision, status, snapshot_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, datetime('now'), datetime('now'))
       ON CONFLICT(blog_id, query, primary_page, competing_page) DO UPDATE SET
         evidence_score=excluded.evidence_score, decision=excluded.decision, status='open', snapshot_date=excluded.snapshot_date,
         updated_at=datetime('now')`
    ).bind(row.blogId, row.query, row.primaryPage, row.competingPage, row.evidenceScore, row.decision, row.snapshotDate));
  }

  await db.batch(statements);
  return {
    ok: true,
    atomic: true,
    candidates: candidates.length,
    clusters: clusters.length,
    internalLinks: linkRows.length,
    conflicts: conflicts.length,
    statements: statements.length
  };
}
