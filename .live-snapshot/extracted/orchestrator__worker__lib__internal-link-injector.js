// worker/lib/internal-link-injector.js
function escapeHtml3(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
__name(escapeHtml3, "escapeHtml");
function canonicalHttpUrl2(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
__name(canonicalHttpUrl2, "canonicalHttpUrl");
function normalizedLinks(links = []) {
  const seen = /* @__PURE__ */ new Set();
  const rows = [];
  for (const item of Array.isArray(links) ? links : []) {
    const url = canonicalHttpUrl2(item?.url || item?.targetUrl || item?.target_url);
    const label = String(item?.query || item?.anchorText || item?.anchor_text || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!url || !label || seen.has(url)) continue;
    seen.add(url);
    rows.push({ url, label });
    if (rows.length >= 3) break;
  }
  return rows;
}
__name(normalizedLinks, "normalizedLinks");
function applyInternalLinksToArticle(article, links = []) {
  if (!article || typeof article !== "object") throw new Error("ARTICLE_REQUIRED");
  const html = String(article.html || "");
  if (!html || html.includes('data-smileseon-internal-links="1"')) {
    return { article, appliedCount: 0, alreadyApplied: html.includes('data-smileseon-internal-links="1"') };
  }
  const rows = normalizedLinks(links);
  if (!rows.length) return { article, appliedCount: 0, alreadyApplied: false };
  const korean = String(article.language || "").toLowerCase() === "ko" || /[가-힣]/.test(`${article.title || ""} ${html}`);
  const lead = korean ? "\uD568\uAED8 \uC77D\uC73C\uBA74 \uC88B\uC740 \uAE00" : "Related guides";
  const anchors = rows.map((row) => `<a href="${escapeHtml3(row.url)}" rel="noopener">${escapeHtml3(row.label)}</a>`).join(" \xB7 ");
  const block = `<p data-smileseon-internal-links="1"><strong>${lead}</strong><br>${anchors}</p>`;
  const nextHtml = /<\/article>\s*$/i.test(html) ? html.replace(/<\/article>\s*$/i, `${block}</article>`) : `${html}
${block}`;
  return {
    article: { ...article, html: nextHtml },
    appliedCount: rows.length,
    alreadyApplied: false
  };
}
__name(applyInternalLinksToArticle, "applyInternalLinksToArticle");
