// Master v4.5 tells the writer, correctly, never to invent an internal URL:
//
//   실제 Blogger 내부 URL을 모르면 임의 생성하지 않는다.
//   대신 <!-- Internal link opportunity: related article about [TOPIC] --> 형태로 표시한다.
//
// The writer obeys, and an HTML comment is invisible and is not a link. That is why 32 of
// smileinfo.net's 33 posts carry zero internal links -- the single starkest structural signal on
// a site AdSense turned down as low-value. The rule is not the problem: nobody ever handed the
// writer the URLs. This repository has them, in job_publications, for every post it published.
//
// Two layers, because a prompt is a request. The candidates go to the writer so it can place
// contextual links itself, and at publication a Related Articles section is appended when the
// finished body still carries fewer than the minimum. The section is built from real published
// titles and URLs, so it cannot be wrong, and it touches no prose.

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function cleanTitle(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function siteHostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export async function selectInternalLinkCandidates(env, blogId, options = {}) {
  const id = String(blogId || '').trim();
  if (!id) return [];
  const limit = Math.min(30, Math.max(1, Number(options.limit) || 12));
  const excludeJobId = Number(options.excludeJobId);

  const result = await requireDb(env).prepare(
    `SELECT p.url AS url,
            json_extract(j.result_json, '$.article.title') AS title,
            p.updated_at AS updated_at
     FROM job_publications p
     JOIN jobs j ON j.id = p.job_id
     WHERE p.blog_id = ?
       AND p.status = 'published'
       AND p.url IS NOT NULL
       AND p.url != ''
       AND (? IS NULL OR p.job_id != ?)
     ORDER BY p.updated_at DESC
     LIMIT ?`
  ).bind(id, Number.isFinite(excludeJobId) ? excludeJobId : null, Number.isFinite(excludeJobId) ? excludeJobId : null, limit).all();

  const seen = new Set();
  const rows = [];
  for (const row of result?.results || []) {
    const url = String(row?.url || '').trim();
    const title = cleanTitle(row?.title);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    rows.push({ title, url });
  }
  return rows;
}

export function countInternalLinks(html, host) {
  const site = String(host || '').toLowerCase();
  if (!site) return 0;
  let count = 0;
  for (const match of String(html || '').matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    if (siteHostOf(match[1]) === site) count += 1;
  }
  return count;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function relatedArticlesSection(candidates, language = 'en') {
  const rows = (Array.isArray(candidates) ? candidates : []).filter((row) => row?.title && row?.url);
  if (rows.length === 0) return '';
  const heading = String(language || '').trim() === 'ko' ? '함께 읽으면 좋은 글' : 'Related Articles';
  const items = rows
    .map((row) => `    <li><a href="${escapeHtml(row.url)}">${escapeHtml(row.title)}</a></li>`)
    .join('\n');
  return `\n<section>\n  <h2 id="related-articles">${escapeHtml(heading)}</h2>\n  <ul>\n${items}\n  </ul>\n</section>\n`;
}

// Only tags Master v4.5 permits in a Blogger post body are used, and the section goes at the end
// so nothing already reviewed moves.
export function ensureInternalLinks(article, candidates, options = {}) {
  if (!article || typeof article !== 'object' || Array.isArray(article)) {
    throw new Error('ARTICLE_REQUIRED');
  }
  const rows = Array.isArray(candidates) ? candidates.filter((row) => row?.title && row?.url) : [];
  if (rows.length === 0) return article;

  const minimum = Math.max(1, Number(options.minimum) || 2);
  const host = String(options.host || siteHostOf(rows[0].url));
  const html = String(article.html || '');
  const existing = countInternalLinks(html, host);
  if (existing >= minimum) return article;

  const alreadyLinked = new Set();
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    alreadyLinked.add(String(match[1]).trim());
  }
  const take = rows.filter((row) => !alreadyLinked.has(row.url)).slice(0, Math.max(3, minimum));
  if (take.length === 0) return article;

  const section = relatedArticlesSection(take, options.language ?? article.language ?? 'en');
  if (!section) return article;
  return { ...article, html: `${html}${section}` };
}
