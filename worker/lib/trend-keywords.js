const TREND_RSS_BASE = 'https://trends.google.com/trending/rss';
const STOPWORDS = new Set([
  '방법','정리','가이드','알아보기','추천','비교','후기','리뷰','관련','최신','오늘','뉴스',
  'the','and','for','with','how','what','best','guide','review','news','today','latest','official'
]);

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function safeText(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlTag(block, tag) {
  const escaped = tag.replace(':', '\\:');
  const match = String(block || '').match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? safeText(decodeXml(match[1]), 1000) : '';
}

export function parseApproxTraffic(value) {
  const text = String(value || '').trim().toUpperCase().replace(/,/g, '');
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*([KMB]?)/);
  if (!match) return 0;
  const multiplier = ({ K: 1_000, M: 1_000_000, B: 1_000_000_000 })[match[2]] || 1;
  return Math.max(0, Math.round(Number(match[1]) * multiplier));
}

export function parseGoogleTrendsRss(xml, geo = 'KR') {
  const rows = [];
  const items = String(xml || '').match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const item of items) {
    const query = xmlTag(item, 'title');
    if (!query) continue;
    const trafficText = xmlTag(item, 'ht:approx_traffic') || xmlTag(item, 'approx_traffic');
    const publishedRaw = xmlTag(item, 'pubDate');
    const publishedDate = publishedRaw ? new Date(publishedRaw) : null;
    const newsCount = (item.match(/<ht:news_item\b/gi) || []).length;
    rows.push({
      geo: String(geo || 'KR').toUpperCase(),
      query,
      trafficText,
      trafficValue: parseApproxTraffic(trafficText),
      newsCount,
      sourceUrl: xmlTag(item, 'link') || `https://trends.google.com/trending?geo=${encodeURIComponent(String(geo || 'KR').toUpperCase())}`,
      publishedAt: publishedDate && !Number.isNaN(publishedDate.getTime()) ? publishedDate.toISOString() : null
    });
  }
  return rows;
}

export async function fetchGoogleTrendsRss(geo, fetchImpl = fetch) {
  const normalizedGeo = String(geo || 'KR').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalizedGeo)) throw new Error('TREND_GEO_INVALID');
  const response = await fetchImpl(`${TREND_RSS_BASE}?geo=${encodeURIComponent(normalizedGeo)}`, {
    headers: {
      accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
      'user-agent': 'SmileseonTrendCollector/1.0'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw Object.assign(new Error(`GOOGLE_TRENDS_${response.status}`), { status: 502 });
  const text = await response.text();
  const rows = parseGoogleTrendsRss(text, normalizedGeo);
  if (!rows.length) throw Object.assign(new Error('GOOGLE_TRENDS_EMPTY'), { status: 502 });
  return rows;
}

export function tokenizeTrend(value) {
  return [...new Set(String(value || '')
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/gi, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token)))];
}

export function trendTopicSimilarity(left, right) {
  const a = new Set(tokenizeTrend(left));
  const b = new Set(tokenizeTrend(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  if (!shared) return 0;
  const containment = shared / Math.min(a.size, b.size);
  const jaccard = shared / (a.size + b.size - shared);
  return Number((containment * 0.7 + jaccard * 0.3).toFixed(4));
}

function recencyScore(publishedAt, now) {
  if (!publishedAt) return 8;
  const ageHours = Math.max(0, (now.getTime() - new Date(publishedAt).getTime()) / 3_600_000);
  return clamp(24 - ageHours * 1.5, 0, 24);
}

export function calculateTrendScore({ trafficValue = 0, newsCount = 0, relevance = 0, publishedAt = null, now = new Date() } = {}) {
  const demand = clamp(Math.log10(Math.max(1, Number(trafficValue) || 0)) * 10, 0, 48);
  const news = clamp(Number(newsCount || 0) * 2.5, 0, 10);
  const topical = clamp(Number(relevance || 0) * 42, 0, 42);
  const fresh = recencyScore(publishedAt, now);
  return Number(clamp(demand + news + topical + fresh, 0, 100).toFixed(2));
}

export function estimateSeoCompetition({ trafficValue = 0, newsCount = 0, relevance = 0, authorityPosition = 0 } = {}) {
  const demand = clamp(Math.log10(Math.max(1, Number(trafficValue) || 0)) * 11, 0, 52);
  const saturation = clamp(Number(newsCount || 0) * 5, 0, 25);
  const topicalDiscount = clamp(Number(relevance || 0) * 20, 0, 20);
  const position = Number(authorityPosition || 0);
  const authorityDiscount = position > 0 && position <= 10 ? 18 : position <= 20 && position > 0 ? 10 : position <= 40 && position > 0 ? 4 : 0;
  const score = Number(clamp(22 + demand + saturation - topicalDiscount - authorityDiscount, 0, 100).toFixed(1));
  const label = score < 40 ? 'low' : score < 70 ? 'medium' : 'high';
  return { score, label, method: 'smileseon_seo_estimate_v1' };
}

function dateInSeoul(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

async function loadProfileRows(db) {
  const result = await db.prepare(`
    SELECT blog_id, query AS text, position, target_page FROM topic_candidates
     WHERE status <> 'rejected' AND query <> ''
    UNION ALL
    SELECT blog_id, query AS text, position, page AS target_page FROM gsc_query_page_rows
     WHERE query <> '' AND snapshot_date >= date('now', '-90 day')
    UNION ALL
    SELECT blog_id, query AS text, 0 AS position, NULL AS target_page FROM idea_bank
     WHERE query <> '' AND status <> 'rejected'
    UNION ALL
    SELECT blog_id, topic AS text, 0 AS position, NULL AS target_page FROM jobs
     WHERE topic IS NOT NULL AND topic <> ''
    LIMIT 6000
  `).all();
  return result.results || [];
}

function buildProfiles(rows = []) {
  const profiles = new Map();
  for (const row of rows) {
    const blogId = safeText(row.blog_id, 100);
    const text = safeText(row.text, 500);
    if (!blogId || !text) continue;
    if (!profiles.has(blogId)) profiles.set(blogId, { terms: [], tokens: new Set() });
    const profile = profiles.get(blogId);
    if (profile.terms.length < 400) profile.terms.push({ text, position: Number(row.position || 0), targetPage: safeText(row.target_page, 1000) || null });
    for (const token of tokenizeTrend(text)) profile.tokens.add(token);
  }
  return profiles;
}

function relevanceForTrend(trend, profile) {
  if (!profile?.terms?.length) return { score: 0, authorityPosition: 0, closest: null };
  let best = { score: 0, authorityPosition: 0, closest: null };
  for (const term of profile.terms) {
    const similarity = trendTopicSimilarity(trend.query, term.text);
    if (similarity > best.score) {
      best = { score: similarity, authorityPosition: Number(term.position || 0), closest: term };
    }
  }
  const trendTokens = tokenizeTrend(trend.query);
  const profileOverlap = trendTokens.length
    ? trendTokens.filter((token) => profile.tokens.has(token)).length / trendTokens.length
    : 0;
  const score = Number(clamp(best.score * 0.8 + profileOverlap * 0.2, 0, 1).toFixed(4));
  return { ...best, score };
}

async function upsertSignal(db, trend) {
  await db.prepare(`
    INSERT INTO trend_signals
      (geo, query, approx_traffic_text, approx_traffic_value, news_count, source_url, published_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(geo, query) DO UPDATE SET
      approx_traffic_text=excluded.approx_traffic_text,
      approx_traffic_value=MAX(trend_signals.approx_traffic_value, excluded.approx_traffic_value),
      news_count=excluded.news_count,
      source_url=excluded.source_url,
      published_at=COALESCE(excluded.published_at, trend_signals.published_at),
      fetched_at=datetime('now')
  `).bind(
    trend.geo, trend.query, trend.trafficText || null, Number(trend.trafficValue || 0), Number(trend.newsCount || 0),
    trend.sourceUrl || null, trend.publishedAt || null
  ).run();
  return db.prepare('SELECT id FROM trend_signals WHERE geo = ? AND query = ? LIMIT 1').bind(trend.geo, trend.query).first();
}

async function loadExistingCandidates(db, blogId) {
  const result = await db.prepare(`
    SELECT id, query, source, target_page, position, status, opportunity_score
      FROM topic_candidates
     WHERE blog_id = ? AND status <> 'rejected'
     ORDER BY opportunity_score DESC, id DESC
     LIMIT 500
  `).bind(String(blogId)).all();
  return result.results || [];
}

function closestCandidate(query, rows = []) {
  let best = null;
  for (const row of rows) {
    const similarity = trendTopicSimilarity(query, row.query);
    if (!best || similarity > best.similarity) best = { ...row, similarity };
  }
  return best;
}

async function createTrendCandidate(db, blogId, trend, trendScore, snapshotDate) {
  await db.prepare(`
    INSERT OR IGNORE INTO topic_candidates
      (blog_id, query, intent, source, snapshot_date, clicks, impressions, ctr, position,
       opportunity_score, target_page, status, created_at, updated_at)
    VALUES (?, ?, 'informational', 'trend', ?, 0, 0, 0, 0, ?, NULL, 'candidate', datetime('now'), datetime('now'))
  `).bind(String(blogId), trend.query, snapshotDate, Number(1000 + trendScore)).run();
  return db.prepare('SELECT id, status, source, target_page FROM topic_candidates WHERE blog_id = ? AND query = ? LIMIT 1')
    .bind(String(blogId), trend.query).first();
}

async function alreadyActivatedToday(db, blogId, snapshotDate) {
  const row = await db.prepare(`
    SELECT id FROM trend_candidate_matches
     WHERE blog_id = ? AND snapshot_date = ? AND decision = 'new_article'
     LIMIT 1
  `).bind(String(blogId), snapshotDate).first();
  return Boolean(row?.id);
}

async function saveMatch(db, row) {
  await db.prepare(`
    INSERT INTO trend_candidate_matches
      (signal_id, blog_id, topic_candidate_id, relevance_score, trend_score, competition_score,
       competition_label, decision, target_page, snapshot_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(signal_id, blog_id) DO UPDATE SET
      topic_candidate_id=excluded.topic_candidate_id,
      relevance_score=excluded.relevance_score,
      trend_score=excluded.trend_score,
      competition_score=excluded.competition_score,
      competition_label=excluded.competition_label,
      decision=excluded.decision,
      target_page=excluded.target_page,
      snapshot_date=excluded.snapshot_date,
      updated_at=datetime('now')
  `).bind(
    Number(row.signalId), String(row.blogId), row.topicCandidateId ? Number(row.topicCandidateId) : null,
    Number(row.relevance), Number(row.trendScore), Number(row.competition.score), row.competition.label,
    row.decision, row.targetPage || null, row.snapshotDate
  ).run();
}

function geoForLanguage(language) {
  return String(language || '').toLowerCase() === 'en' ? 'US' : 'KR';
}

export async function refreshTrendKeywords(env, blogContexts = [], options = {}) {
  if (String(env?.TREND_KEYWORDS_ENABLED ?? 'true') !== 'true') {
    return { ok: true, enabled: false, reason: 'TREND_KEYWORDS_DISABLED', created: 0, matches: 0 };
  }
  const db = requireDb(env);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const snapshotDate = dateInSeoul(now);
  const profiles = buildProfiles(await loadProfileRows(db));
  const contexts = (blogContexts || [])
    .map((item) => ({
      blogId: safeText(item.blogId ?? item.blog_id, 100),
      language: safeText(item.language ?? item.resolvedLanguage, 10) || 'ko',
      enabled: item.enabled !== false
    }))
    .filter((item) => item.blogId && item.enabled);
  const geos = [...new Set(contexts.map((item) => geoForLanguage(item.language)))];
  const fetchFn = options.fetchTrendFn || fetchGoogleTrendsRss;
  const trendsByGeo = new Map();
  const fetchErrors = [];
  for (const geo of geos) {
    try {
      trendsByGeo.set(geo, await fetchFn(geo, options.fetchImpl || fetch));
    } catch (error) {
      fetchErrors.push({ geo, error: safeText(error?.message || error, 80).split(':')[0] });
      trendsByGeo.set(geo, []);
    }
  }

  let created = 0;
  let matches = 0;
  let repairCandidates = 0;
  let watched = 0;
  const selected = [];
  const minimumRelevance = clamp(Number(env?.TREND_MIN_RELEVANCE ?? 0.28), 0.1, 0.9);

  for (const context of contexts) {
    const profile = profiles.get(context.blogId);
    if (!profile?.terms?.length) continue;
    const geo = geoForLanguage(context.language);
    const trends = trendsByGeo.get(geo) || [];
    const scored = trends.map((trend) => {
      const relevance = relevanceForTrend(trend, profile);
      const trendScore = calculateTrendScore({ ...trend, relevance: relevance.score, now });
      const competition = estimateSeoCompetition({
        trafficValue: trend.trafficValue,
        newsCount: trend.newsCount,
        relevance: relevance.score,
        authorityPosition: relevance.authorityPosition
      });
      return { trend, relevance, trendScore, competition };
    }).filter((item) => item.relevance.score >= minimumRelevance)
      .sort((a, b) => b.trendScore - a.trendScore || b.trend.trafficValue - a.trend.trafficValue)
      .slice(0, 12);

    const existing = await loadExistingCandidates(db, context.blogId);
    let dailyActivated = await alreadyActivatedToday(db, context.blogId, snapshotDate);

    for (const item of scored) {
      const signal = await upsertSignal(db, item.trend);
      if (!signal?.id) continue;
      const closest = closestCandidate(item.trend.query, existing);
      let decision = 'watch';
      let topicCandidateId = null;
      let targetPage = null;

      if (closest?.similarity >= 0.62 && closest?.target_page) {
        decision = 'repair_existing';
        topicCandidateId = Number(closest.id);
        targetPage = closest.target_page;
        repairCandidates += 1;
      } else if (closest?.similarity >= 0.78) {
        decision = 'existing_candidate';
        topicCandidateId = Number(closest.id);
      } else if (!dailyActivated) {
        const candidate = await createTrendCandidate(db, context.blogId, item.trend, item.trendScore, snapshotDate);
        if (candidate?.id && !candidate?.target_page) {
          decision = 'new_article';
          topicCandidateId = Number(candidate.id);
          dailyActivated = true;
          created += 1;
          existing.push({ id: candidate.id, query: item.trend.query, source: 'trend', target_page: null, position: 0, status: candidate.status || 'candidate', opportunity_score: 1000 + item.trendScore });
        } else if (candidate?.id) {
          decision = 'existing_candidate';
          topicCandidateId = Number(candidate.id);
          targetPage = candidate.target_page || null;
        }
      } else {
        watched += 1;
      }

      await saveMatch(db, {
        signalId: signal.id,
        blogId: context.blogId,
        topicCandidateId,
        relevance: item.relevance.score,
        trendScore: item.trendScore,
        competition: item.competition,
        decision,
        targetPage,
        snapshotDate
      });
      matches += 1;
      if (selected.length < 50) selected.push({
        blogId: context.blogId,
        geo,
        query: item.trend.query,
        trafficText: item.trend.trafficText,
        trafficValue: item.trend.trafficValue,
        relevance: item.relevance.score,
        trendScore: item.trendScore,
        competition: item.competition,
        decision,
        topicCandidateId,
        targetPage
      });
    }
  }

  return { ok: fetchErrors.length === 0, enabled: true, snapshotDate, created, matches, repairCandidates, watched, fetchErrors, selected };
}

export async function listTrendInsights(env, options = {}) {
  const db = requireDb(env);
  const blogId = safeText(options.blogId, 100);
  const limit = Math.max(1, Math.min(200, Number(options.limit || 60)));
  const where = blogId ? 'WHERE m.blog_id = ?' : '';
  const binds = blogId ? [blogId, limit] : [limit];
  const result = await db.prepare(`
    SELECT m.id, m.blog_id, m.topic_candidate_id, m.relevance_score, m.trend_score,
           m.competition_score, m.competition_label, m.decision, m.target_page, m.snapshot_date,
           s.geo, s.query, s.approx_traffic_text, s.approx_traffic_value, s.news_count,
           s.source_url, s.published_at, s.fetched_at
      FROM trend_candidate_matches m
      JOIN trend_signals s ON s.id = m.signal_id
      ${where}
     ORDER BY m.snapshot_date DESC, m.trend_score DESC, s.approx_traffic_value DESC
     LIMIT ?
  `).bind(...binds).all();
  const rows = result.results || [];
  return {
    ok: true,
    source: 'Google Trends',
    competitionMethod: 'smileseon_seo_estimate_v1',
    competitionDisclaimer: 'SEO 경쟁도는 Google Ads 경쟁률이 아니라 Smileseon 내부 추정치입니다.',
    count: rows.length,
    rows
  };
}

function rankBucket(position) {
  const value = Number(position || 0);
  if (!value) return 'unknown';
  if (value <= 3) return 'top3';
  if (value <= 10) return 'top10';
  if (value <= 20) return 'top20';
  if (value <= 50) return 'top50';
  return 'below50';
}

export async function listKeywordRankings(env, options = {}) {
  const db = requireDb(env);
  const blogId = safeText(options.blogId, 100);
  const limit = Math.max(1, Math.min(500, Number(options.limit || 120)));
  const blogFilter = blogId ? 'AND r.blog_id = ?' : '';
  const binds = blogId ? [blogId, limit] : [limit];
  const result = await db.prepare(`
    WITH latest AS (
      SELECT blog_id, MAX(snapshot_date) AS snapshot_date
        FROM gsc_query_page_rows
       GROUP BY blog_id
    ), previous AS (
      SELECT r.blog_id, MAX(r.snapshot_date) AS snapshot_date
        FROM gsc_query_page_rows r
        JOIN latest l ON l.blog_id = r.blog_id
       WHERE r.snapshot_date < l.snapshot_date
       GROUP BY r.blog_id
    )
    SELECT r.blog_id, r.snapshot_date, r.query, r.page, r.clicks, r.impressions, r.ctr, r.position,
           p.position AS previous_position, p.impressions AS previous_impressions
      FROM gsc_query_page_rows r
      JOIN latest l ON l.blog_id = r.blog_id AND l.snapshot_date = r.snapshot_date
      LEFT JOIN previous d ON d.blog_id = r.blog_id
      LEFT JOIN gsc_query_page_rows p
        ON p.blog_id = r.blog_id AND p.snapshot_date = d.snapshot_date AND p.query = r.query AND p.page = r.page
     WHERE r.query <> '' AND r.page <> '' AND r.impressions > 0
       ${blogFilter}
     ORDER BY r.impressions DESC, r.clicks DESC, r.position ASC
     LIMIT ?
  `).bind(...binds).all();
  const rows = (result.results || []).map((row) => {
    const current = Number(row.position || 0);
    const previous = Number(row.previous_position || 0);
    return {
      ...row,
      searchVisible: Number(row.impressions || 0) > 0,
      rankBucket: rankBucket(current),
      rankChange: current > 0 && previous > 0 ? Number((previous - current).toFixed(2)) : null
    };
  });
  const summary = rows.reduce((acc, row) => {
    acc.searchVisible += row.searchVisible ? 1 : 0;
    if (row.rankBucket === 'top3') acc.top3 += 1;
    if (['top3', 'top10'].includes(row.rankBucket)) acc.top10 += 1;
    if (['top3', 'top10', 'top20'].includes(row.rankBucket)) acc.top20 += 1;
    return acc;
  }, { searchVisible: 0, top3: 0, top10: 0, top20: 0 });
  return { ok: true, source: 'Google Search Console', count: rows.length, summary, rows };
}
