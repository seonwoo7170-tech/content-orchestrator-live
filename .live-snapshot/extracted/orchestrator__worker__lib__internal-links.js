// worker/lib/internal-links.js
function requireDb9(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error("DB_NOT_BOUND");
  return env.ORCHESTRATOR_DB;
}
__name(requireDb9, "requireDb");
function cleanTitle(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
__name(cleanTitle, "cleanTitle");
function siteHostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}
__name(siteHostOf, "siteHostOf");
async function selectInternalLinkCandidates(env, blogId, options = {}) {
  const id2 = String(blogId || "").trim();
  if (!id2) return [];
  const limit = Math.min(30, Math.max(1, Number(options.limit) || 12));
  const excludeJobId = Number(options.excludeJobId);
  const result = await requireDb9(env).prepare(
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
  ).bind(id2, Number.isFinite(excludeJobId) ? excludeJobId : null, Number.isFinite(excludeJobId) ? excludeJobId : null, limit).all();
  const seen = /* @__PURE__ */ new Set();
  const rows = [];
  for (const row of result?.results || []) {
    const url = String(row?.url || "").trim();
    const title = cleanTitle(row?.title);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    rows.push({ title, url });
  }
  return rows;
}
__name(selectInternalLinkCandidates, "selectInternalLinkCandidates");
function countInternalLinks(html, host) {
  const site = String(host || "").toLowerCase();
  if (!site) return 0;
  let count = 0;
  for (const match of String(html || "").matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    if (siteHostOf(match[1]) === site) count += 1;
  }
  return count;
}
__name(countInternalLinks, "countInternalLinks");
function escapeHtml2(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
__name(escapeHtml2, "escapeHtml");
function relatedArticlesSection(candidates, language = "en") {
  const rows = (Array.isArray(candidates) ? candidates : []).filter((row) => row?.title && row?.url);
  if (rows.length === 0) return "";
  const heading = String(language || "").trim() === "ko" ? "\uD568\uAED8 \uC77D\uC73C\uBA74 \uC88B\uC740 \uAE00" : "Related Articles";
  const items = rows.map((row) => `    <li><a href="${escapeHtml2(row.url)}">${escapeHtml2(row.title)}</a></li>`).join("\n");
  return `
<section>
  <h2 id="related-articles">${escapeHtml2(heading)}</h2>
  <ul>
${items}
  </ul>
</section>
`;
}
__name(relatedArticlesSection, "relatedArticlesSection");
function ensureInternalLinks(article, candidates, options = {}) {
  if (!article || typeof article !== "object" || Array.isArray(article)) {
    throw new Error("ARTICLE_REQUIRED");
  }
  const rows = Array.isArray(candidates) ? candidates.filter((row) => row?.title && row?.url) : [];
  if (rows.length === 0) return article;
  const minimum = Math.max(1, Number(options.minimum) || 2);
  const host = String(options.host || siteHostOf(rows[0].url));
  const html = String(article.html || "");
  const existing = countInternalLinks(html, host);
  if (existing >= minimum) return article;
  const alreadyLinked = /* @__PURE__ */ new Set();
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    alreadyLinked.add(String(match[1]).trim());
  }
  const take = rows.filter((row) => !alreadyLinked.has(row.url)).slice(0, Math.max(3, minimum));
  if (take.length === 0) return article;
  const section = relatedArticlesSection(take, options.language ?? article.language ?? "en");
  if (!section) return article;
  return { ...article, html: `${html}${section}` };
}
__name(ensureInternalLinks, "ensureInternalLinks");
