import { acceptInsertions } from './expansion-acceptance.js';

const ARTICLE_FIELDS = Object.freeze([
  'title',
  'html',
  'searchDescription',
  'labels',
  'sources',
  'language',
  'topic'
]);

const HTML_BLOCK_RE = /<(p|h2|h3|li|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi;
const EXACT_HTML_LOCATION_RE = /html\s+(p|h2|h3|li|blockquote)\s+(\d+)/gi;
const INTERNAL_LINK_MARKER_RE = /data-smileseon-internal-links\s*=\s*["']1["']/i;
const SOURCE_AUTHORITY_RE = /\b(?:source|sources|citation|citations|reference|references|authority|authoritative|verified|credible|trusted|evidence)\b|출처|인용|근거|검증|신뢰/i;
const SOURCE_REPAIR_RE = /\b(?:remove|replace|delete|drop|swap|use|cite|citation|source)\b|제거|교체|삭제|대체|출처|인용/i;
const INTERNAL_LINK_DEFECT_RE = /\b(?:broken|dead|404|unsafe|javascript|duplicate|duplicated|irrelevant|unrelated|misleading|incorrect|wrong|malformed|redirect\s*loop|not\s*found)\b|깨진|끊긴|404|위험|중복|관련\s*없|무관|오해|잘못된|틀린|유효하지\s*않|찾을\s*수\s*없/i;

function equalValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function repairGuardError(code, meta = {}) {
  const error = new Error(code);
  error.code = code;
  error.meta = meta;
  return error;
}

function htmlParts(value) {
  const source = String(value || '');
  const blocks = [];
  const gaps = [];
  let cursor = 0;
  let match;
  let index = 0;
  const re = new RegExp(HTML_BLOCK_RE.source, HTML_BLOCK_RE.flags);

  while ((match = re.exec(source))) {
    gaps.push(source.slice(cursor, match.index));
    index += 1;
    blocks.push({
      index,
      tag: match[1].toLowerCase(),
      raw: match[0]
    });
    cursor = re.lastIndex;
  }
  gaps.push(source.slice(cursor));
  return { blocks, gaps };
}

function exactHtmlTargetsFromLocation(location) {
  const targets = [];
  const re = new RegExp(EXACT_HTML_LOCATION_RE.source, EXACT_HTML_LOCATION_RE.flags);
  let match;
  while ((match = re.exec(String(location || '')))) {
    targets.push(`${match[1].toLowerCase()}:${Number(match[2])}`);
  }
  return targets;
}

function resolveHtmlTargets(rawTargets, blocks) {
  const resolved = new Set();
  const unresolved = [];
  for (const target of rawTargets) {
    const [tag, indexText] = String(target).split(':');
    const position = Number(indexText);
    const shared = blocks[position - 1];
    if (shared && shared.tag === tag) {
      resolved.add(shared.index);
      continue;
    }
    // Compatibility only: older critic runs sometimes counted per tag rather than shared order.
    // This fallback is never allowed to turn a truly nonexistent locator into a batch failure.
    const nthOfTag = blocks.filter((block) => block.tag === tag)[position - 1];
    if (nthOfTag) {
      resolved.add(nthOfTag.index);
      continue;
    }
    unresolved.push(target);
  }
  return { resolved, unresolved };
}

function issueText(issue) {
  return [issue?.code, issue?.location, issue?.reason, issue?.message, issue?.repairInstruction]
    .map((value) => String(value || ''))
    .join(' ');
}

function isSourceAuthorityRepairIssue(issue) {
  const value = issueText(issue);
  if (INTERNAL_LINK_DEFECT_RE.test(value)) return false;
  return SOURCE_AUTHORITY_RE.test(value) && SOURCE_REPAIR_RE.test(value);
}

function protectedInternalNavigationTargets(parts, issues = []) {
  const protectedTargets = new Set();
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!isSourceAuthorityRepairIssue(issue)) continue;
    const rawTargets = new Set(exactHtmlTargetsFromLocation(issue?.location));
    const { resolved } = resolveHtmlTargets(rawTargets, parts.blocks);
    for (const index of resolved) {
      const block = parts.blocks[index - 1];
      if (block && INTERNAL_LINK_MARKER_RE.test(block.raw)) protectedTargets.add(index);
    }
  }
  return protectedTargets;
}

export function inspectTargetedRepairTargets(article, issues = []) {
  const parts = htmlParts(article?.html);
  const scope = targetedRepairScope(issues);
  const validTargets = [];
  const invalidTargets = [];
  for (const target of scope.htmlTargets) {
    const single = resolveHtmlTargets(new Set([target]), parts.blocks);
    if (single.resolved.size > 0) validTargets.push(target);
    else invalidTargets.push({ target, blockCount: parts.blocks.length });
  }
  const protectedIndexes = protectedInternalNavigationTargets(parts, issues);
  return {
    validTargets,
    invalidTargets,
    protectedInternalNavigationTargets: [...protectedIndexes].map((index) => {
      const block = parts.blocks[index - 1];
      return block ? `${block.tag}:${block.index}` : String(index);
    })
  };
}

export function targetedRepairScope(issues = []) {
  const allowedFields = new Set();
  const htmlTargets = new Set();
  let htmlMentioned = false;
  let htmlBody = false;

  for (const issue of Array.isArray(issues) ? issues : []) {
    const location = String(issue?.location || '').trim();
    const lower = location.toLowerCase();

    if (/\btitle\b/.test(lower) || /\b제목\b/.test(location)) allowedFields.add('title');
    if (/search\s*description|meta\s*description|검색\s*설명|메타\s*설명/i.test(location)) allowedFields.add('searchDescription');
    if (/\blabels?\b|\btags?\b|라벨|태그/i.test(location)) allowedFields.add('labels');
    if (/\bsources?\b|출처/i.test(location)) allowedFields.add('sources');
    if (/\blanguage\b|언어/i.test(location)) allowedFields.add('language');
    if (/\btopic\b|주제/i.test(location)) allowedFields.add('topic');

    if (/\bhtml\b/i.test(location)) htmlMentioned = true;
    if (/\bhtml\s+body\b/i.test(location)) htmlBody = true;

    for (const target of exactHtmlTargetsFromLocation(location)) {
      htmlMentioned = true;
      htmlTargets.add(target);
    }
  }

  return { allowedFields, htmlTargets, htmlMentioned, htmlBody };
}

function appendOnlyInsertions(original, repaired) {
  if (repaired.length <= original.length) return null;
  const insertions = new Map();
  let matched = 0;
  for (const block of repaired) {
    if (matched < original.length && block.raw === original[matched].raw) {
      matched += 1;
      continue;
    }
    if (!insertions.has(matched)) insertions.set(matched, []);
    insertions.get(matched).push(block.raw);
  }
  return matched === original.length ? insertions : null;
}

function rebuildWithInsertions(parts, insertions) {
  let html = parts.gaps[0] || '';
  for (const raw of insertions.get(0) || []) html += raw;
  for (let index = 0; index < parts.blocks.length; index += 1) {
    html += parts.blocks[index].raw;
    for (const raw of insertions.get(index + 1) || []) html += raw;
    html += parts.gaps[index + 1] || '';
  }
  return html;
}

export function constrainTargetedRepair(before, candidate, issues = []) {
  if (!before || !candidate || typeof before !== 'object' || typeof candidate !== 'object') {
    throw repairGuardError('TARGETED_REPAIR_ARTICLE_INVALID');
  }

  const scope = targetedRepairScope(issues);
  const constrained = { ...before };

  for (const field of scope.allowedFields) {
    if (field === 'html') continue;
    if (Object.prototype.hasOwnProperty.call(candidate, field)) constrained[field] = candidate[field];
  }

  if (String(candidate.html || '') === String(before.html || '')) return constrained;
  if (!scope.htmlMentioned) return constrained;
  if (scope.htmlBody) throw repairGuardError('TARGETED_REPAIR_HTML_BODY_TARGET_TOO_BROAD');
  if (scope.htmlTargets.size === 0) throw repairGuardError('TARGETED_REPAIR_HTML_LOCATION_UNSAFE');

  const original = htmlParts(before.html);
  const repaired = htmlParts(candidate.html);
  const { resolved: htmlTargets } = resolveHtmlTargets(scope.htmlTargets, original.blocks);
  const protectedTargets = protectedInternalNavigationTargets(original, issues);
  for (const index of protectedTargets) htmlTargets.delete(index);

  // A stale/nonexistent locator or a false source-authority finding on internal navigation
  // must not poison valid sibling repairs. With no safe HTML target left, preserve HTML exactly.
  if (htmlTargets.size === 0) return constrained;

  if (original.blocks.length !== repaired.blocks.length) {
    const insertions = appendOnlyInsertions(original.blocks, repaired.blocks);
    if (!insertions) {
      throw repairGuardError('TARGETED_REPAIR_CHANGED_HTML_STRUCTURE', {
        beforeBlocks: original.blocks.length,
        afterBlocks: repaired.blocks.length,
        cause: 'ORIGINAL_BLOCK_NOT_PRESERVED'
      });
    }
    const { accepted, rejected, keptBlocks } = acceptInsertions(before.html, insertions, { sources: before.sources });
    if (keptBlocks === 0) {
      throw repairGuardError('TARGETED_REPAIR_INSERTION_REJECTED', {
        beforeBlocks: original.blocks.length,
        afterBlocks: repaired.blocks.length,
        rejected: rejected.slice(0, 6)
      });
    }
    constrained.html = rebuildWithInsertions(original, accepted);
    return constrained;
  }

  if (original.gaps.length !== repaired.gaps.length) {
    throw repairGuardError('TARGETED_REPAIR_CHANGED_HTML_STRUCTURE');
  }

  for (let index = 0; index < original.blocks.length; index += 1) {
    if (original.blocks[index].tag !== repaired.blocks[index].tag) {
      throw repairGuardError('TARGETED_REPAIR_CHANGED_HTML_TAG', {
        index: original.blocks[index].index,
        beforeTag: original.blocks[index].tag,
        afterTag: repaired.blocks[index].tag
      });
    }
  }

  let html = original.gaps[0] || '';
  for (let index = 0; index < original.blocks.length; index += 1) {
    const beforeBlock = original.blocks[index];
    html += htmlTargets.has(beforeBlock.index) ? repaired.blocks[index].raw : beforeBlock.raw;
    html += original.gaps[index + 1] || '';
  }
  constrained.html = html;
  return constrained;
}

export function assertTargetedRepairPreserved(before, after, issues = []) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') {
    throw repairGuardError('TARGETED_REPAIR_ARTICLE_INVALID');
  }

  const scope = targetedRepairScope(issues);
  for (const field of ARTICLE_FIELDS) {
    if (field === 'html') continue;
    if (equalValue(before[field], after[field])) continue;
    if (!scope.allowedFields.has(field)) {
      throw repairGuardError('TARGETED_REPAIR_CHANGED_UNTARGETED_FIELD', { field });
    }
  }

  if (String(before.html || '') === String(after.html || '')) return true;
  if (!scope.htmlMentioned) throw repairGuardError('TARGETED_REPAIR_CHANGED_HTML_WITHOUT_HTML_TARGET');

  const original = htmlParts(before.html);
  const repaired = htmlParts(after.html);

  if (scope.htmlBody) {
    if (original.blocks.length === 0 && repaired.blocks.length === 0) return true;
    throw repairGuardError('TARGETED_REPAIR_HTML_BODY_TARGET_TOO_BROAD');
  }
  if (scope.htmlTargets.size === 0) throw repairGuardError('TARGETED_REPAIR_HTML_LOCATION_UNSAFE');

  const { resolved: htmlTargets } = resolveHtmlTargets(scope.htmlTargets, original.blocks);
  const protectedTargets = protectedInternalNavigationTargets(original, issues);
  for (const index of protectedTargets) htmlTargets.delete(index);

  if (htmlTargets.size === 0) {
    throw repairGuardError('TARGETED_REPAIR_CHANGED_HTML_WITHOUT_RESOLVABLE_TARGET');
  }

  if (original.blocks.length !== repaired.blocks.length) {
    const insertions = appendOnlyInsertions(original.blocks, repaired.blocks);
    if (insertions) return true;
    throw repairGuardError('TARGETED_REPAIR_CHANGED_HTML_STRUCTURE', {
      beforeBlocks: original.blocks.length,
      afterBlocks: repaired.blocks.length
    });
  }

  if (original.gaps.length !== repaired.gaps.length) {
    throw repairGuardError('TARGETED_REPAIR_CHANGED_HTML_STRUCTURE');
  }

  for (let index = 0; index < original.gaps.length; index += 1) {
    if (original.gaps[index] !== repaired.gaps[index]) {
      throw repairGuardError('TARGETED_REPAIR_CHANGED_UNTARGETED_HTML_GAP', { index });
    }
  }

  for (let index = 0; index < original.blocks.length; index += 1) {
    const beforeBlock = original.blocks[index];
    const afterBlock = repaired.blocks[index];
    if (beforeBlock.tag !== afterBlock.tag) {
      throw repairGuardError('TARGETED_REPAIR_CHANGED_HTML_TAG', {
        index: beforeBlock.index,
        beforeTag: beforeBlock.tag,
        afterTag: afterBlock.tag
      });
    }
    if (htmlTargets.has(beforeBlock.index)) continue;
    if (beforeBlock.raw !== afterBlock.raw) {
      throw repairGuardError('TARGETED_REPAIR_CHANGED_UNTARGETED_HTML_BLOCK', {
        location: `html ${beforeBlock.tag} ${beforeBlock.index}`
      });
    }
  }

  return true;
}
