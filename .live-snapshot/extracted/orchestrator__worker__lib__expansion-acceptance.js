// worker/lib/expansion-acceptance.js
var MAX_INSERTED_BLOCKS = 12;
var REDUNDANCY_LIMIT = 0.62;
var MIN_NEW_TERMS = 3;
var MIN_BLOCK_CHARS = 40;
var SHINGLE = 12;
var CITATION_SHAPE_RE = /\b(?:according to|per|based on|as reported by|cited in|guidelines?|standards?|reference manuals?|editorial archive)\b/i;
var STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "your",
  "you",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "not",
  "but",
  "can",
  "will",
  "would",
  "should",
  "could",
  "may",
  "might",
  "into",
  "than",
  "then",
  "them",
  "they",
  "its",
  "it",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "or",
  "is",
  "be",
  "as",
  "if",
  "so",
  "do",
  "does",
  "did",
  "when",
  "what",
  "which",
  "who",
  "how",
  "why",
  "more",
  "most",
  "some",
  "any",
  "all",
  "each",
  "one",
  "two"
]);
function textOf(html) {
  return String(html || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}
__name(textOf, "textOf");
function normalize(text4) {
  return String(text4 || "").toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
}
__name(normalize, "normalize");
function shingleSet(text4) {
  const n = normalize(text4);
  const set = /* @__PURE__ */ new Set();
  for (let i2 = 0; i2 + SHINGLE <= n.length; i2 += 1) set.add(n.slice(i2, i2 + SHINGLE));
  return set;
}
__name(shingleSet, "shingleSet");
function containmentIn(blockShingles, bodyShingles) {
  if (blockShingles.size === 0) return 1;
  let shared = 0;
  for (const s of blockShingles) if (bodyShingles.has(s)) shared += 1;
  return shared / blockShingles.size;
}
__name(containmentIn, "containmentIn");
function contentTerms(text4) {
  const terms = /* @__PURE__ */ new Set();
  for (const match of String(text4 || "").toLowerCase().matchAll(/[a-z가-힣][a-z가-힣0-9-]{2,}/g)) {
    const term = match[0];
    if (!STOPWORDS.has(term)) terms.add(term);
  }
  for (const match of String(text4 || "").matchAll(/\d[\d.,]*\s*(?:%|amp|amps|volts?|v|years?|inches|in|mm|cm)?/gi)) {
    terms.add(match[0].trim().toLowerCase());
  }
  return terms;
}
__name(contentTerms, "contentTerms");
function hostsOf(values) {
  const hosts = /* @__PURE__ */ new Set();
  for (const value of values) {
    for (const match of String(value || "").matchAll(/https?:\/\/([^/"'\s)]+)/gi)) {
      hosts.add(match[1].replace(/^www\./i, "").toLowerCase());
    }
  }
  return hosts;
}
__name(hostsOf, "hostsOf");
function isHeading(raw) {
  return /^\s*<h[23]\b/i.test(String(raw || ""));
}
__name(isHeading, "isHeading");
function judgeInsertedBlock(raw, context) {
  const text4 = textOf(raw);
  const heading = isHeading(raw);
  if (!text4) return { accepted: false, reason: "EMPTY_BLOCK" };
  if (!heading && text4.length < MIN_BLOCK_CHARS) {
    return { accepted: false, reason: "TOO_SHORT_TO_ADD_ANYTHING" };
  }
  const redundancy = containmentIn(shingleSet(text4), context.bodyShingles);
  if (redundancy >= REDUNDANCY_LIMIT) {
    return { accepted: false, reason: "REPEATS_EXISTING_TEXT", redundancy: Number(redundancy.toFixed(2)) };
  }
  let newTerms = 0;
  for (const term of contentTerms(text4)) if (!context.bodyTerms.has(term)) newTerms += 1;
  if (!heading && newTerms < MIN_NEW_TERMS) {
    return { accepted: false, reason: "NO_INFORMATION_GAIN", newTerms };
  }
  for (const host of hostsOf([raw])) {
    if (!context.allowedHosts.has(host)) return { accepted: false, reason: "UNCITED_EXTERNAL_SOURCE", host };
  }
  if (CITATION_SHAPE_RE.test(text4) && !/<a\b[^>]*href\s*=\s*["']https?:/i.test(raw)) {
    return { accepted: false, reason: "UNLINKED_CITATION_SHAPE" };
  }
  return { accepted: true, redundancy: Number(redundancy.toFixed(2)), newTerms };
}
__name(judgeInsertedBlock, "judgeInsertedBlock");
function acceptInsertions(originalHtml, insertions, options = {}) {
  const bodyText = textOf(originalHtml);
  const context = {
    bodyShingles: shingleSet(bodyText),
    bodyTerms: contentTerms(bodyText),
    allowedHosts: hostsOf([originalHtml, ...Array.isArray(options.sources) ? options.sources.map((s) => typeof s === "string" ? s : s?.url) : []])
  };
  const accepted = /* @__PURE__ */ new Map();
  const rejected = [];
  let kept = 0;
  let keptProse = 0;
  for (const [anchor, blocks] of insertions) {
    const keep = [];
    for (const raw of blocks) {
      if (kept >= MAX_INSERTED_BLOCKS) {
        rejected.push({ reason: "TOO_MANY_INSERTED_BLOCKS" });
        continue;
      }
      const verdict = judgeInsertedBlock(raw, context);
      if (!verdict.accepted) {
        rejected.push({ anchor, ...verdict });
        continue;
      }
      keep.push(raw);
      kept += 1;
      if (!isHeading(raw)) keptProse += 1;
    }
    if (keep.length > 0) accepted.set(anchor, keep);
  }
  if (keptProse === 0) {
    return { accepted: /* @__PURE__ */ new Map(), rejected: [...rejected, { reason: "HEADINGS_WITHOUT_CONTENT" }], keptBlocks: 0 };
  }
  return { accepted, rejected, keptBlocks: kept };
}
__name(acceptInsertions, "acceptInsertions");
