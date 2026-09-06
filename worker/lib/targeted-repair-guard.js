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

    const re = new RegExp(EXACT_HTML_LOCATION_RE.source, EXACT_HTML_LOCATION_RE.flags);
    let match;
    while ((match = re.exec(location))) {
      htmlMentioned = true;
      htmlTargets.add(`${match[1].toLowerCase()}:${Number(match[2])}`);
    }
  }

  return {
    allowedFields,
    htmlTargets,
    htmlMentioned,
    htmlBody
  };
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
  if (original.blocks.length !== repaired.blocks.length) {
    throw repairGuardError('TARGETED_REPAIR_CHANGED_HTML_STRUCTURE', {
      beforeBlocks: original.blocks.length,
      afterBlocks: repaired.blocks.length
    });
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

  for (const target of scope.htmlTargets) {
    const [tag, indexText] = target.split(':');
    const block = original.blocks[Number(indexText) - 1];
    if (!block || block.tag !== tag) throw repairGuardError('TARGETED_REPAIR_TARGET_NOT_FOUND', { target });
  }

  let html = original.gaps[0] || '';
  for (let index = 0; index < original.blocks.length; index += 1) {
    const beforeBlock = original.blocks[index];
    const key = `${beforeBlock.tag}:${beforeBlock.index}`;
    html += scope.htmlTargets.has(key) ? repaired.blocks[index].raw : beforeBlock.raw;
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

  if (!scope.htmlMentioned) {
    throw repairGuardError('TARGETED_REPAIR_CHANGED_HTML_WITHOUT_HTML_TARGET');
  }

  const original = htmlParts(before.html);
  const repaired = htmlParts(after.html);

  if (scope.htmlBody) {
    if (original.blocks.length === 0 && repaired.blocks.length === 0) return true;
    throw repairGuardError('TARGETED_REPAIR_HTML_BODY_TARGET_TOO_BROAD');
  }

  if (scope.htmlTargets.size === 0) {
    throw repairGuardError('TARGETED_REPAIR_HTML_LOCATION_UNSAFE');
  }

  if (original.blocks.length !== repaired.blocks.length) {
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

    const key = `${beforeBlock.tag}:${beforeBlock.index}`;
    if (scope.htmlTargets.has(key)) continue;
    if (beforeBlock.raw !== afterBlock.raw) {
      throw repairGuardError('TARGETED_REPAIR_CHANGED_UNTARGETED_HTML_BLOCK', {
        location: `html ${beforeBlock.tag} ${beforeBlock.index}`
      });
    }
  }

  for (const target of scope.htmlTargets) {
    const [tag, indexText] = target.split(':');
    const block = original.blocks[Number(indexText) - 1];
    if (!block || block.tag !== tag) {
      throw repairGuardError('TARGETED_REPAIR_TARGET_NOT_FOUND', { target });
    }
  }

  return true;
}
