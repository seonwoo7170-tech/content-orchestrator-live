const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const ALLOWED_TOPICS = new Set(['general', 'news']);
const ALLOWED_TIME_RANGES = new Set(['day', 'week', 'month', 'year']);

const FRESHNESS_PATTERNS = [
  /\b20\d{2}\b/i,
  /\b(latest|current|today|recent|newest|update|updated|release|released|version|price|pricing|policy|law|regulation|support|benefit|deadline|schedule|availability|recall|security|vulnerability|ai model)\b/i,
  /\bAI\b/i,
  /(최신|현재|오늘|최근|업데이트|출시|버전|가격|정책|지원금|법률|규정|마감|일정|보안|취약점|리콜|인공지능)/i
];

function httpError(code, status = 502) {
  return Object.assign(new Error(code), { status });
}

function normalizeDomains(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim().toLowerCase())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, 10);
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') return null;
  const title = String(result.title || '').trim();
  const url = String(result.url || '').trim();
  const content = String(result.content || '').trim();
  if (!title || !url || !content) return null;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  } catch {
    return null;
  }
  return {
    title: title.slice(0, 300),
    url,
    content: content.slice(0, 3000),
    score: Number.isFinite(Number(result.score)) ? Number(result.score) : null,
    publishedDate: result.published_date ? String(result.published_date).slice(0, 64) : null
  };
}

export function tavilyConfigured(env) {
  return Boolean(String(env?.TAVILY_API_KEY || '').trim());
}

export function shouldUseTavilyResearch(topic, mode = 'auto') {
  const normalizedMode = String(mode || 'auto').trim().toLowerCase();
  if (normalizedMode === 'off') return false;
  if (normalizedMode === 'always') return true;
  if (normalizedMode !== 'auto') throw httpError('TAVILY_RESEARCH_MODE_INVALID', 400);
  const text = String(topic || '').trim();
  if (!text) return false;
  return FRESHNESS_PATTERNS.some(pattern => pattern.test(text));
}

export async function tavilySearch(env, input = {}, fetchImpl = fetch) {
  if (!tavilyConfigured(env)) throw httpError('TAVILY_NOT_CONFIGURED', 503);

  const query = String(input.query || '').trim();
  if (!query) throw httpError('TAVILY_QUERY_REQUIRED', 400);
  if (query.length > 1200) throw httpError('TAVILY_QUERY_TOO_LONG', 400);

  const maxResults = Math.max(1, Math.min(5, Number(input.maxResults || 5) || 5));
  const topic = ALLOWED_TOPICS.has(String(input.topic || '').trim()) ? String(input.topic).trim() : 'general';
  const timeRangeRaw = String(input.timeRange || '').trim();
  const timeRange = ALLOWED_TIME_RANGES.has(timeRangeRaw) ? timeRangeRaw : null;
  const includeDomains = normalizeDomains(input.includeDomains);

  let response;
  try {
    response = await fetchImpl(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${String(env.TAVILY_API_KEY).trim()}`
      },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        topic,
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
        ...(timeRange ? { time_range: timeRange } : {}),
        ...(includeDomains.length ? { include_domains: includeDomains } : {})
      })
    });
  } catch {
    throw httpError('TAVILY_NETWORK_ERROR', 502);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw httpError('TAVILY_AUTH_FAILED', 502);
    if (response.status === 429) throw httpError('TAVILY_RATE_LIMITED', 503);
    if (response.status === 402) throw httpError('TAVILY_CREDITS_EXHAUSTED', 503);
    throw httpError(`TAVILY_SEARCH_FAILED_${response.status}`, 502);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw httpError('TAVILY_RESPONSE_INVALID', 502);
  }

  const results = (Array.isArray(payload?.results) ? payload.results : [])
    .map(normalizeResult)
    .filter(Boolean)
    .slice(0, maxResults);

  return {
    ok: true,
    provider: 'tavily',
    searchDepth: 'basic',
    query,
    resultCount: results.length,
    results
  };
}

export async function collectWriterResearch(env, { topic, language, researchMode = 'auto' } = {}, fetchImpl = fetch) {
  const mode = String(researchMode || 'auto').trim().toLowerCase();
  const requested = shouldUseTavilyResearch(topic, mode);
  if (!requested) {
    return { requested: false, used: false, provider: 'tavily', resultCount: 0, results: [] };
  }
  if (!tavilyConfigured(env)) {
    if (mode === 'always') throw httpError('TAVILY_REQUIRED_BUT_NOT_CONFIGURED', 503);
    return { requested: true, used: false, provider: 'tavily', resultCount: 0, results: [], unavailableReason: 'not_configured' };
  }

  const query = language === 'ko'
    ? `${String(topic).trim()} 최신 정보 공식 출처`
    : `${String(topic).trim()} latest official information`;

  try {
    const searched = await tavilySearch(env, {
      query,
      maxResults: 5,
      topic: /\b(news|announcement|launch|released?|today)\b/i.test(String(topic)) || /(뉴스|발표|출시|오늘)/.test(String(topic)) ? 'news' : 'general',
      timeRange: 'month'
    }, fetchImpl);

    if (!searched.results.length) {
      if (mode === 'always') throw httpError('TAVILY_NO_RESULTS', 502);
      return { requested: true, used: false, provider: 'tavily', resultCount: 0, results: [], unavailableReason: 'no_results' };
    }
    return {
      requested: true,
      used: true,
      provider: 'tavily',
      retrievedAt: new Date().toISOString(),
      resultCount: searched.results.length,
      results: searched.results
    };
  } catch (error) {
    if (mode === 'always') throw error;
    return {
      requested: true,
      used: false,
      provider: 'tavily',
      resultCount: 0,
      results: [],
      unavailableReason: String(error?.message || 'TAVILY_UNAVAILABLE')
    };
  }
}
