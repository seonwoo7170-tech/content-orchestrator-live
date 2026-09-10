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

function substantiveTopic(topic, intent) {
  const text = String(topic || '').toLowerCase();
  if (['commercial', 'transactional'].includes(String(intent || ''))) return true;
  return /(repair|restore|restoration|replace|replacement|install|installation|troubleshoot|diagnos|maintenance|fix|compare|comparison|versus|\bvs\b|cost|budget|floor|threshold|plumb|electric|roof|foundation|hvac|appliance|수리|복원|교체|설치|진단|점검|유지보수|비교|비용|바닥|문턱|배관|전기|지붕|기초|가전)/i.test(text);
}

function intentGoal(intent) {
  if (intent === 'transactional') return '사용자가 행동·구매·신청 전에 필요한 조건과 선택 기준을 먼저 해결한다.';
  if (intent === 'commercial') return '비교·평가 기준을 먼저 제시하고 장단점과 적합한 사용자를 구분한다.';
  if (intent === 'navigational') return '찾는 대상의 공식 경로·정체성을 혼동 없이 빠르게 안내한다.';
  return '핵심 답을 먼저 제시하고 사용자가 바로 실행할 수 있는 단계와 예외를 설명한다.';
}

function planningProfile(topic, intent, { freshnessRequired, primarySourceRequired }) {
  const deep = substantiveTopic(topic, intent);
  const recommendedWordRange = deep
    ? { min: 2500, max: 4000, unit: 'words', flexible: true }
    : { min: 1500, max: 2500, unit: 'words', flexible: true };

  return {
    method: 'master-v4.5-prewrite',
    recommendedDepth: deep ? 'deep-dive' : 'standard-explainer',
    recommendedWordRange,
    completionRule: '이 범위는 Master v4.5의 유연한 편집 깊이 기준이며 채우기용 목표가 아니다. 핵심 결정·행동 정보, 예외, 실패 조건, 구체 예시가 충분해질 때까지 작성하고 단순 반복이나 filler로 길이를 맞추지 않는다.',
    readerDecision: '독자가 이 글을 읽고 무엇을 선택·확인·수리·중단·실행해야 하는지 한 문장으로 먼저 정의한다.',
    originalValueGoal: '검색 결과의 흔한 설명을 재배열하는 데서 끝내지 말고, 실제 판단 기준·상황별 차이·예외·실패 신호·작업 순서 중 최소 두 가지 이상의 고유한 실용 가치를 제공한다.',
    competitorGapQuestions: [
      '경쟁 문서가 보통 설명하는 기본 내용은 무엇인가?',
      '경쟁 문서가 자주 모호하게 남기는 선택 기준이나 예외는 무엇인가?',
      '독자가 여전히 답을 얻지 못하는 실제 행동 질문은 무엇인가?',
      '이 글만의 구체적 판단 규칙·체크포인트·비교 기준을 무엇으로 추가할 것인가?'
    ],
    sourcePlan: {
      researchExpected: true,
      primaryPreferred: primarySourceRequired,
      freshnessRequired,
      instruction: freshnessRequired
        ? '현재성 민감 주장에는 최신 공식/1차 자료를 우선하고 조사 시점을 드러낸다.'
        : 'Evergreen 주제도 핵심 사실·안전·재료·절차를 검증할 수 있는 공식/1차 또는 신뢰도 높은 전문 자료를 우선 조사한다.'
    },
    outlineRequirements: [
      '첫 섹션에서 직접 답 또는 핵심 권고를 제공한다.',
      '원인/진단이 관련되면 증상만 나열하지 말고 어떻게 구분하는지 설명한다.',
      '선택지가 있으면 repair-vs-replace 같은 실제 결정 기준과 trade-off를 제공한다.',
      '실행 절차는 준비물·순서·중단 조건을 포함해 실제로 따라 할 수 있게 만든다.',
      '비용·시간·난이도·안전·전문가 호출 기준은 주제에 적용되는 경우 포함한다.',
      '각 핵심 H2에는 최소 하나의 구체적 기준, 예시, 체크포인트 또는 예외를 둔다.',
      'FAQ는 본문을 반복하지 말고 남은 실제 질문만 보완한다.'
    ]
  };
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
  const language = ['ko', 'en'].includes(input.language) ? input.language : 'ko';
  const strategyLinks = Array.isArray(input.strategyLinks) ? input.strategyLinks.slice(0, 8) : [];
  const freshnessRequired = currentSensitive(topic);
  const primarySourceRequired = freshnessRequired || safetySensitive(topic);
  const planning = planningProfile(topic, intent, { freshnessRequired, primarySourceRequired });

  return {
    version: 'smileseon-seo-brief.v2',
    topic,
    language,
    searchIntent: intent,
    intentGoal: intentGoal(intent),
    answerFirst: true,
    planning,
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
      informationGain: '상위 문서의 문장을 재조합하지 말고, 이 글에서만 얻을 수 있는 구체적 판단 기준·예외·실행 순서를 최소 두 가지 제공한다. 구조만 갖춘 얕은 설명은 완료로 간주하지 않는다.',
      primarySources: primarySourceRequired
        ? '현재성·안전성·금전·정책 관련 핵심 주장은 가능하면 공식/1차 출처로 확인하고, 확인하지 못한 현재 사실은 단정하지 않는다.'
        : 'Evergreen 글도 핵심 절차·안전·재료·판단 기준은 검증 가능한 신뢰도 높은 출처를 우선하며 불필요한 출처 수 채우기는 하지 않는다.',
      freshness: freshnessRequired
        ? '이 주제는 최신성 민감 주제다. 조사 시점이 드러나야 하며 오래된 수치를 최신 사실처럼 쓰지 않는다.'
        : '안정적인 정보는 억지로 최신 문구를 붙이지 않되, 핵심 실무 정보는 조사 없이 추정하지 않는다.',
      readability: '핵심 답을 먼저, 짧은 문장과 2~4문장 단락 중심으로 작성한다. planning.recommendedWordRange는 filler를 위한 고정 할당량이 아니라 충분한 정보 깊이를 확보하기 위한 유연한 편집 기준이다. 핵심 하위 질문이 남았는데 일찍 끝내지 않는다.',
      seo: '제목·본문·검색설명에 주제를 자연스럽게 명확히 하되 고정 키워드 밀도나 반복 횟수를 강제하지 않는다.',
      geo: '각 핵심 섹션은 맥락 없이도 이해되는 명확한 답변·정의·단계로 만들고, 출처가 있는 사실은 귀속을 분명히 한다.'
    }
  };
}
