const MAX_INSERTED_BLOCKS = 12;
const REDUNDANCY_LIMIT = 0.62;
const MIN_NEW_TERMS = 3;
const MIN_BLOCK_CHARS = 40;
const SHINGLE = 12;
const CITATION_SHAPE_RE = /\b(?:according to|per|based on|as reported by|cited in|guidelines?|standards?|reference manuals?|editorial archive)\b/i;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'your', 'you', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'can', 'will', 'would', 'should', 'could', 'may', 'might',
  'into', 'than', 'then', 'them', 'they', 'its', 'it', 'a', 'an', 'of', 'to', 'in', 'on', 'at',
  'by', 'or', 'is', 'be', 'as', 'if', 'so', 'do', 'does', 'did', 'when', 'what', 'which', 'who',
  'how', 'why', 'more', 'most', 'some', 'any', 'all', 'each', 'one', 'two'
]);

function textOf(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
}

function shingleSet(text) {
  const normalized = normalize(text);
  const set = new Set();
  for (let i = 0; i + SHINGLE <= normalized.length; i += 1) set.add(normalized.slice(i, i + SHINGLE));
  return set;
}

function containmentIn(blockShingles, bodyShingles) {
  if (blockShingles.size === 0) return 1;
  let shared = 0;
  for (const shingle of blockShingles) if (bodyShingles.has(shingle)) shared += 1;
  return shared / blockShingles.size;
}

function contentTerms(text) {
  const terms = new Set();
  for (const match of String(text || '').toLowerCase().matchAll(/[a-z가-힣][a-z가-힣0-9-]{2,}/g)) {
    const term = match[0];
    if (!STOPWORDS.has(term)) terms.add(term);
  }
  for (const match of String(text || '').matchAll(/\d[\d.,]*\s*(?:%|amp|amps|volts?|v|years?|inches|in|mm|cm)?/gi)) {
    terms.add(match[0].trim().toLowerCase());
  }
  return terms;
}

function hostsOf(values) {
  const hosts = new Set();
  for (const value of values) {
    for (const match of String(value || '').matchAll(/https?:\/\/([^/"'\s)]+)/gi)) {
      hosts.add(match[1].replace(/^www\./i, '').toLowerCase());
    }
  }
  return hosts;
}

function isHeading(raw) {
  return /^\s*<h[23]\b/i.test(String(raw || ''));
}

export function judgeInsertedBlock(raw, context) {
  const text = textOf(raw);
  const heading = isHeading(raw);
  if (!text) return { accepted: false, reason: 'EMPTY_BLOCK' };
  if (!heading && text.length < MIN_BLOCK_CHARS) {
    return { accepted: false, reason: 'TOO_SHORT_TO_ADD_ANYTHING' };
  }

  const redundancy = containmentIn(shingleSet(text), context.bodyShingles);
  if (redundancy >= REDUNDANCY_LIMIT) {
    return { accepted: false, reason: 'REPEATS_EXISTING_TEXT', redundancy: Number(redundancy.toFixed(2)) };
  }

  let newTerms = 0;
  for (const term of contentTerms(text)) if (!context.bodyTerms.has(term)) newTerms += 1;
  if (!heading && newTerms < MIN_NEW_TERMS) {
    return { accepted: false, reason: 'NO_INFORMATION_GAIN', newTerms };
  }

  for (const host of hostsOf([raw])) {
    if (!context.allowedHosts.has(host)) return { accepted: false, reason: 'UNCITED_EXTERNAL_SOURCE', host };
  }

  if (CITATION_SHAPE_RE.test(text) && !/<a\b[^>]*href\s*=\s*["']https?:/i.test(raw)) {
    return { accepted: false, reason: 'UNLINKED_CITATION_SHAPE' };
  }

  return { accepted: true, redundancy: Number(redundancy.toFixed(2)), newTerms };
}

export function acceptInsertions(originalHtml, insertions, options = {}) {
  const bodyText = textOf(originalHtml);
  const context = {
    bodyShingles: shingleSet(bodyText),
    bodyTerms: contentTerms(bodyText),
    allowedHosts: hostsOf([
      originalHtml,
      ...(Array.isArray(options.sources) ? options.sources.map((source) => typeof source === 'string' ? source : source?.url) : [])
    ])
  };

  const accepted = new Map();
  const rejected = [];
  let kept = 0;
  let keptProse = 0;

  for (const [anchor, blocks] of insertions) {
    const keep = [];
    for (const raw of blocks) {
      if (kept >= MAX_INSERTED_BLOCKS) {
        rejected.push({ reason: 'TOO_MANY_INSERTED_BLOCKS' });
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
    return {
      accepted: new Map(),
      rejected: [...rejected, { reason: 'HEADINGS_WITHOUT_CONTENT' }],
      keptBlocks: 0
    };
  }

  return { accepted, rejected, keptBlocks: kept };
}
