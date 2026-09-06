import { classifySearchIntent } from './topic-candidates.js';

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function currentSensitive(topic) {
  const text = String(topic || '').toLowerCase();
  return /(202[5-9]|최신|현재|오늘|올해|이번|가격|요금|정책|지원금|세금|법|규정|버전|업데이트|latest|current|today|price|pricing|policy|tax|law|version|update)/i.test(text);
}

function safetySensitive(topic) {
  return /(의료|건강|약|증상|법률|세금|투자|주식|대출|보험|전기|가스|화재|안전|medical|health|medicine|legal|tax|invest|loan|insurance|electric|gas|fire|safety)/i.test(String(topic || ''));
}

function intentGoal(intent) {
  if (intent === 'transactional') return '사용자가 행동·구매·신청 전에 필요한 조건과 선택 기준을 먼저 해결한다.';
  if (intent === 'commercial') return '비교·평가 기준을 먼저 제시하고 장단점과 적합한 사용자를 구분한다.';
  if (intent === 'navigational') return '찾는 대상의 공식 경로·정체성을 혼동 없이 빠르게 안내한다.';
  return '핵심 답을 먼저 제시하고 사용자가 바로 실행할 수 있는 단계와 예외를 설명한다.';
}

async function candidateContext(db, blogId, candidateId, topic) {
  if (!db) return null;
  if (candidateId) {
    const row = await db.prepare(
      `SELECT id, blog_id, query, intent, source, snapshot_date, clicks, impressions, ctr, position,
              opportunity_score, target_page, status
         FROM topic_candidates WHERE id = ? AND blog_id = ? LIMIT 1`
    ).bind(Number(candidateId), String(blogId)).first();
    if (row) return row;
  }
  return db.prepare(
    `SELECT id, blog_id, query, intent, source, snapshot_date, clicks, impressions, ctr, position,
            opportunity_score, target_page, status
       FROM topic_candidates
      WHERE blog_id = ? AND lower(query) = lower(?)
      ORDER BY opportunity_score DESC, id DESC LIMIT 1`
  ).bind(String(blogId), String(topic)).first();
}

async function clusterContext(db, blogId, candidateId) {
  if (!db || !candidateId) return null;
  return db.prepare(
    `SELECT c.id AS cluster_id, c.cluster_key, c.label, c.hub_candidate_id, c.member_count,
            m.role, m.similarity, h.query AS hub_topic
       FROM content_cluster_members m
       JOIN content_clusters c ON c.id = m.cluster_id
       LEFT JOIN topic_candidates h ON h.id = c.hub_candidate_id
      WHERE m.candidate_id = ? AND c.blog_id = ? LIMIT 1`
  ).bind(Number(candidateId), String(blogId)).first();
}

async function conflictContext(db, blogId, topic) {
  if (!db) return [];
  const rows = await db.prepare(
    `SELECT query, primary_page, competing_page, evidence_score, decision, snapshot_date
       FROM content_conflicts
      WHERE blog_id = ? AND status = 'open'
      ORDER BY evidence_score DESC LIMIT 30`
  ).bind(String(blogId)).all();
  const target = String(topic || '').toLowerCase();
  return (rows.results || []).filter((row) => {
    const query = String(row.query || '').toLowerCase();
    return query && (target.includes(query) || query.includes(target));
  }).slice(0, 3);
}

async function safeEvidence(call, fallback) {
  try { return await call(); } catch { return fallback; }
}

export async function buildSeoBrief(env, input = {}) {
  const db = env?.ORCHESTRATOR_DB || null;
  const blogId = clean(input.blogId, 100);
  const topic = clean(input.topic || input.requestedTopic, 300);
  if (!blogId) throw new Error('SEO_BRIEF_BLOG_ID_REQUIRED');
  if (!topic) throw new Error('SEO_BRIEF_TOPIC_REQUIRED');

  const candidate = await safeEvidence(() => candidateContext(db, blogId, input.topicCandidateId, topic), null);
  const candidateId = Number(candidate?.id || input.topicCandidateId || 0) || null;
  const [cluster, conflicts] = await Promise.all([
    safeEvidence(() => clusterContext(db, blogId, candidateId), null),
    safeEvidence(() => conflictContext(db, blogId, topic), [])
  ]);
  const intent = clean(candidate?.intent, 40) || classifySearchIntent(topic);
  const strategyLinks = Array.isArray(input.strategyLinks) ? input.strategyLinks.slice(0, 8) : [];
  const freshnessRequired = currentSensitive(topic);
  const primarySourceRequired = freshnessRequired || safetySensitive(topic);

  return {
    version: 'smileseon-seo-brief.v1',
    topic,
    language: ['ko', 'en'].includes(input.language) ? input.language : 'ko',
    searchIntent: intent,
    intentGoal: intentGoal(intent),
    answerFirst: true,
    cluster: cluster ? {
      id: Number(cluster.cluster_id),
      key: cluster.cluster_key,
      label: cluster.label,
      role: cluster.role,
      hubTopic: cluster.hub_topic || null,
      memberCount: Number(cluster.member_count || 0),
      similarity: Number(cluster.similarity || 0)
    } : { role: 'unclustered' },
    internalLinks: strategyLinks.map((row) => ({
      url: clean(row.url || row.targetUrl || row.target_url, 800),
      anchorText: clean(row.anchorText || row.anchor_text || row.query, 180),
      reason: clean(row.reason || 'same_cluster', 120)
    })).filter((row) => row.url),
    cannibalization: conflicts.map((row) => ({
      query: row.query,
      decision: row.decision,
      evidenceScore: Number(row.evidence_score || 0),
      primaryPage: row.primary_page,
      competingPage: row.competing_page,
      snapshotDate: row.snapshot_date || null
    })),
    evidence: candidate ? {
      source: candidate.source || null,
      snapshotDate: candidate.snapshot_date || null,
      clicks: Number(candidate.clicks || 0),
      impressions: Number(candidate.impressions || 0),
      ctr: Number(candidate.ctr || 0),
      averagePosition: Number(candidate.position || 0),
      opportunityScore: Number(candidate.opportunity_score || 0),
      existingTargetPage: candidate.target_page || null
    } : { source: 'planner', snapshotDate: null },
    requirements: {
      informationGain: '상위 문서의 문장을 재조합하지 말고, 이 글에서만 얻을 수 있는 구체적 판단 기준·예외·실행 순서를 최소 하나 제공한다.',
      primarySources: primarySourceRequired
        ? '현재성·안전성·금전·정책 관련 핵심 주장은 가능하면 공식/1차 출처로 확인하고, 확인하지 못한 현재 사실은 단정하지 않는다.'
        : '사실 주장은 검증 가능한 출처를 우선하며 불필요한 출처 수 채우기는 하지 않는다.',
      freshness: freshnessRequired
        ? '이 주제는 최신성 민감 주제다. 조사 시점이 드러나야 하며 오래된 수치를 최신 사실처럼 쓰지 않는다.'
        : '안정적인 정보는 억지로 최신 문구를 붙이지 않는다.',
      readability: '핵심 답을 먼저, 짧은 문장과 2~4문장 단락 중심으로 작성한다. 고정 단어 수 목표는 사용하지 않는다.',
      seo: '제목·본문·검색설명에 주제를 자연스럽게 명확히 하되 고정 키워드 밀도나 반복 횟수를 강제하지 않는다.',
      geo: '각 핵심 섹션은 맥락 없이도 이해되는 명확한 답변·정의·단계로 만들고, 출처가 있는 사실은 귀속을 분명히 한다.'
    }
  };
}
