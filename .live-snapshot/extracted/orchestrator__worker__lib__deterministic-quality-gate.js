// worker/lib/deterministic-quality-gate.js
var BLOCK_PATTERNS = Object.freeze([
  { code: "PLACEHOLDER_TODO", pattern: /\b(?:TODO|TBD|FIXME)\b/i, message: "\uC791\uC131 \uC911 \uD45C\uC2DD\uC774 \uBCF8\uBB38\uC5D0 \uB0A8\uC544 \uC788\uC2B5\uB2C8\uB2E4." },
  { code: "PLACEHOLDER_LOREM", pattern: /\blorem\s+ipsum\b/i, message: "\uC0D8\uD50C \uBB38\uAD6C\uAC00 \uBCF8\uBB38\uC5D0 \uB0A8\uC544 \uC788\uC2B5\uB2C8\uB2E4." },
  { code: "PLACEHOLDER_INSERT", pattern: /\[(?:insert|add|replace|작성|삽입|추가)[^\]]{0,80}\]/i, message: "\uCE58\uD658\uB418\uC9C0 \uC54A\uC740 \uC790\uB9AC\uD45C\uC2DC\uC790\uAC00 \uB0A8\uC544 \uC788\uC2B5\uB2C8\uB2E4." },
  { code: "CITATION_PLACEHOLDER", pattern: /\[(?:citation needed|source needed|출처 필요|근거 필요)\]/i, message: "\uD655\uC778\uB418\uC9C0 \uC54A\uC740 \uCD9C\uCC98 \uC790\uB9AC\uD45C\uC2DC\uC790\uAC00 \uB0A8\uC544 \uC788\uC2B5\uB2C8\uB2E4." },
  { code: "UNSAFE_JAVASCRIPT_URL", pattern: /(?:href|src)\s*=\s*["']\s*javascript:/i, message: "\uC2E4\uD589\uD615 javascript URL\uC774 \uD3EC\uD568\uB418\uC5B4 \uC788\uC2B5\uB2C8\uB2E4." },
  { code: "UNSAFE_DATA_URL", pattern: /href\s*=\s*["']\s*data:/i, message: "\uB9C1\uD06C\uC5D0 data URL\uC774 \uD3EC\uD568\uB418\uC5B4 \uC788\uC2B5\uB2C8\uB2E4." }
]);
var WARN_PATTERNS = Object.freeze([
  { code: "EMPTY_LINK", pattern: /href\s*=\s*["']\s*["']/i, message: "\uBE44\uC5B4 \uC788\uB294 \uB9C1\uD06C\uAC00 \uC788\uC2B5\uB2C8\uB2E4." },
  { code: "PLACEHOLDER_EXAMPLE_DOMAIN", pattern: /https?:\/\/(?:www\.)?example\.(?:com|org|net)\b/i, message: "\uC608\uC2DC\uC6A9 \uB3C4\uBA54\uC778\uC774 \uB0A8\uC544 \uC788\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4." }
]);
function text(value) {
  return String(value ?? "").trim();
}
__name(text, "text");
function stripTags(value) {
  return String(value || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}
__name(stripTags, "stripTags");
function headingRows(html) {
  const rows = [];
  const regex = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while (match = regex.exec(String(html || ""))) {
    rows.push({ level: Number(match[1]), title: stripTags(match[2]).toLowerCase() });
  }
  return rows;
}
__name(headingRows, "headingRows");
function issue2(code, severity, message, location = "article") {
  return { code, severity, message, location };
}
__name(issue2, "issue");
function articleContractIssues(article) {
  const issues = [];
  if (!article || typeof article !== "object") return [issue2("ARTICLE_REQUIRED", "block", "\uAE00 \uACB0\uACFC\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.")];
  for (const key of ["title", "html", "searchDescription", "language", "topic"]) {
    if (!text(article[key])) issues.push(issue2(`ARTICLE_${key.toUpperCase()}_REQUIRED`, "block", `${key} \uAC12\uC774 \uBE44\uC5B4 \uC788\uC2B5\uB2C8\uB2E4.`, key));
  }
  if (!Array.isArray(article.labels)) issues.push(issue2("ARTICLE_LABELS_REQUIRED", "block", "labels \uBC30\uC5F4\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.", "labels"));
  if (!Array.isArray(article.sources)) issues.push(issue2("ARTICLE_SOURCES_REQUIRED", "block", "sources \uBC30\uC5F4\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.", "sources"));
  return issues;
}
__name(articleContractIssues, "articleContractIssues");
function runDeterministicQualityGate(article) {
  const issues = articleContractIssues(article);
  if (!article || typeof article !== "object") {
    return { version: "smileseon-deterministic-qa.v1", status: "BLOCK", issues, checks: { contract: false } };
  }
  const html = String(article.html || "");
  const combined = `${article.title || ""}
${article.searchDescription || ""}
${html}`;
  for (const rule of BLOCK_PATTERNS) {
    if (rule.pattern.test(combined)) issues.push(issue2(rule.code, "block", rule.message, "content"));
  }
  for (const rule of WARN_PATTERNS) {
    if (rule.pattern.test(combined)) issues.push(issue2(rule.code, "warn", rule.message, "content"));
  }
  if (/<script\b/i.test(html)) {
    issues.push(issue2("ARTICLE_SCRIPT_TAG_BLOCKED", "block", "\uBCF8\uBB38\uC5D0\uB294 \uC2E4\uD589 \uAC00\uB2A5\uD55C script \uD0DC\uADF8\uB97C \uB123\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uAD6C\uC870\uD654\uB370\uC774\uD130\uB294 \uBCC4\uB3C4 \uAC80\uC99D \uB2E8\uACC4\uC5D0\uC11C \uAD00\uB9AC\uD569\uB2C8\uB2E4.", "html"));
  }
  if (/<iframe\b/i.test(html)) {
    issues.push(issue2("ARTICLE_IFRAME_REVIEW", "warn", "iframe\uC774 \uD3EC\uD568\uB418\uC5B4 \uC788\uC5B4 \uAC8C\uC2DC \uC804 \uD655\uC778\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.", "html"));
  }
  const headings = headingRows(html);
  const seen = /* @__PURE__ */ new Map();
  for (const row of headings) {
    if (!row.title) continue;
    const count = (seen.get(row.title) || 0) + 1;
    seen.set(row.title, count);
    if (count === 2) issues.push(issue2("DUPLICATE_HEADING", "warn", `\uAC19\uC740 \uC81C\uBAA9\uC758 \uC139\uC158\uC774 \uBC18\uBCF5\uB429\uB2C8\uB2E4: ${row.title}`, "headings"));
  }
  for (let i2 = 1; i2 < headings.length; i2 += 1) {
    if (headings[i2].level - headings[i2 - 1].level > 1) {
      issues.push(issue2("HEADING_LEVEL_JUMP", "warn", `H${headings[i2 - 1].level} \uB2E4\uC74C\uC5D0 H${headings[i2].level}\uB85C \uAC74\uB108\uB701\uB2C8\uB2E4.`, "headings"));
      break;
    }
  }
  const bodyText = stripTags(html);
  if (bodyText.length < 120) issues.push(issue2("ARTICLE_BODY_THIN_REVIEW", "warn", "\uBCF8\uBB38 \uAE38\uC774\uAC00 \uC9E7\uC2B5\uB2C8\uB2E4. \uAC80\uC0C9\uC758\uB3C4\uC5D0 \uCDA9\uBD84\uD55C\uC9C0\uB294 Critic \uACB0\uACFC\uC640 \uD568\uAED8 \uD655\uC778\uD569\uB2C8\uB2E4.", "html"));
  const blocked = issues.some((item) => item.severity === "block");
  const warned = issues.some((item) => item.severity === "warn");
  return {
    version: "smileseon-deterministic-qa.v1",
    status: blocked ? "BLOCK" : warned ? "WARN" : "PASS",
    issues,
    checks: {
      contract: !issues.some((item) => item.code.startsWith("ARTICLE_") && item.code.endsWith("_REQUIRED")),
      residue: !issues.some((item) => item.severity === "block" && ["content", "html"].includes(item.location)),
      bodyLength: bodyText.length,
      headingCount: headings.length,
      sourceCount: Array.isArray(article.sources) ? article.sources.length : 0
    }
  };
}
__name(runDeterministicQualityGate, "runDeterministicQualityGate");
function deterministicQaAllowsPublish(result) {
  return Boolean(result) && result.status !== "BLOCK";
}
__name(deterministicQaAllowsPublish, "deterministicQaAllowsPublish");
