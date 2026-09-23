// worker/lib/targeted-repair-guard.js
var ARTICLE_FIELDS = Object.freeze([
  "title",
  "html",
  "searchDescription",
  "labels",
  "sources",
  "language",
  "topic"
]);
var HTML_BLOCK_RE = /<(p|h2|h3|li|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi;
var EXACT_HTML_LOCATION_RE = /html\s+(p|h2|h3|li|blockquote)\s+(\d+)/gi;
function equalValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
__name(equalValue, "equalValue");
function repairGuardError(code, meta2 = {}) {
  const error = new Error(code);
  error.code = code;
  error.meta = meta2;
  return error;
}
__name(repairGuardError, "repairGuardError");
function htmlParts(value) {
  const source = String(value || "");
  const blocks = [];
  const gaps = [];
  let cursor = 0;
  let match;
  let index = 0;
  const re = new RegExp(HTML_BLOCK_RE.source, HTML_BLOCK_RE.flags);
  while (match = re.exec(source)) {
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
__name(htmlParts, "htmlParts");
function resolveHtmlTargets(rawTargets, blocks) {
  const resolved = /* @__PURE__ */ new Set();
  const unresolved = [];
  for (const target of rawTargets) {
    const [tag, indexText] = String(target).split(":");
    const position = Number(indexText);
    const shared = blocks[position - 1];
    if (shared && shared.tag === tag) {
      resolved.add(shared.index);
      continue;
    }
    const nthOfTag = blocks.filter((block) => block.tag === tag)[position - 1];
    if (nthOfTag) {
      resolved.add(nthOfTag.index);
      continue;
    }
    unresolved.push(target);
  }
  return { resolved, unresolved };
}
__name(resolveHtmlTargets, "resolveHtmlTargets");
function targetedRepairScope(issues = []) {
  const allowedFields = /* @__PURE__ */ new Set();
  const htmlTargets = /* @__PURE__ */ new Set();
  let htmlMentioned = false;
  let htmlBody = false;
  for (const issue3 of Array.isArray(issues) ? issues : []) {
    const location = String(issue3?.location || "").trim();
    const lower = location.toLowerCase();
    if (/\btitle\b/.test(lower) || /\b제목\b/.test(location)) allowedFields.add("title");
    if (/search\s*description|meta\s*description|검색\s*설명|메타\s*설명/i.test(location)) allowedFields.add("searchDescription");
    if (/\blabels?\b|\btags?\b|라벨|태그/i.test(location)) allowedFields.add("labels");
    if (/\bsources?\b|출처/i.test(location)) allowedFields.add("sources");
    if (/\blanguage\b|언어/i.test(location)) allowedFields.add("language");
    if (/\btopic\b|주제/i.test(location)) allowedFields.add("topic");
    if (/\bhtml\b/i.test(location)) htmlMentioned = true;
    if (/\bhtml\s+body\b/i.test(location)) htmlBody = true;
    const re = new RegExp(EXACT_HTML_LOCATION_RE.source, EXACT_HTML_LOCATION_RE.flags);
    let match;
    while (match = re.exec(location)) {
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
__name(targetedRepairScope, "targetedRepairScope");
function appendOnlyInsertions(original, repaired) {
  if (repaired.length <= original.length) return null;
  const insertions = /* @__PURE__ */ new Map();
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
__name(appendOnlyInsertions, "appendOnlyInsertions");
function rebuildWithInsertions(parts, insertions) {
  let html = parts.gaps[0] || "";
  for (const raw of insertions.get(0) || []) html += raw;
  for (let index = 0; index < parts.blocks.length; index += 1) {
    html += parts.blocks[index].raw;
    for (const raw of insertions.get(index + 1) || []) html += raw;
    html += parts.gaps[index + 1] || "";
  }
  return html;
}
__name(rebuildWithInsertions, "rebuildWithInsertions");
function constrainTargetedRepair(before, candidate, issues = []) {
  if (!before || !candidate || typeof before !== "object" || typeof candidate !== "object") {
    throw repairGuardError("TARGETED_REPAIR_ARTICLE_INVALID");
  }
  const scope = targetedRepairScope(issues);
  const constrained = { ...before };
  for (const field of scope.allowedFields) {
    if (field === "html") continue;
    if (Object.prototype.hasOwnProperty.call(candidate, field)) constrained[field] = candidate[field];
  }
  if (String(candidate.html || "") === String(before.html || "")) return constrained;
  if (!scope.htmlMentioned) return constrained;
  if (scope.htmlBody) throw repairGuardError("TARGETED_REPAIR_HTML_BODY_TARGET_TOO_BROAD");
  if (scope.htmlTargets.size === 0) throw repairGuardError("TARGETED_REPAIR_HTML_LOCATION_UNSAFE");
  const original = htmlParts(before.html);
  const repaired = htmlParts(candidate.html);
  const { resolved: htmlTargets, unresolved } = resolveHtmlTargets(scope.htmlTargets, original.blocks);
  if (unresolved.length > 0) throw repairGuardError("TARGETED_REPAIR_TARGET_NOT_FOUND", { target: unresolved[0] });
  if (original.blocks.length !== repaired.blocks.length) {
    const insertions = appendOnlyInsertions(original.blocks, repaired.blocks);
    if (!insertions) {
      throw repairGuardError("TARGETED_REPAIR_CHANGED_HTML_STRUCTURE", {
        beforeBlocks: original.blocks.length,
        afterBlocks: repaired.blocks.length,
        cause: "ORIGINAL_BLOCK_NOT_PRESERVED"
      });
    }
    const { accepted, rejected, keptBlocks } = acceptInsertions(before.html, insertions, { sources: before.sources });
    if (keptBlocks === 0) {
      throw repairGuardError("TARGETED_REPAIR_INSERTION_REJECTED", {
        beforeBlocks: original.blocks.length,
        afterBlocks: repaired.blocks.length,
        rejected: rejected.slice(0, 6)
      });
    }
    constrained.html = rebuildWithInsertions(original, accepted);
    return constrained;
  }
  if (original.gaps.length !== repaired.gaps.length) {
    throw repairGuardError("TARGETED_REPAIR_CHANGED_HTML_STRUCTURE");
  }
  for (let index = 0; index < original.blocks.length; index += 1) {
    if (original.blocks[index].tag !== repaired.blocks[index].tag) {
      throw repairGuardError("TARGETED_REPAIR_CHANGED_HTML_TAG", {
        index: original.blocks[index].index,
        beforeTag: original.blocks[index].tag,
        afterTag: repaired.blocks[index].tag
      });
    }
  }
  let html = original.gaps[0] || "";
  for (let index = 0; index < original.blocks.length; index += 1) {
    const beforeBlock = original.blocks[index];
    html += htmlTargets.has(beforeBlock.index) ? repaired.blocks[index].raw : beforeBlock.raw;
    html += original.gaps[index + 1] || "";
  }
  constrained.html = html;
  return constrained;
}
__name(constrainTargetedRepair, "constrainTargetedRepair");
function assertTargetedRepairPreserved(before, after, issues = []) {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") {
    throw repairGuardError("TARGETED_REPAIR_ARTICLE_INVALID");
  }
  const scope = targetedRepairScope(issues);
  for (const field of ARTICLE_FIELDS) {
    if (field === "html") continue;
    if (equalValue(before[field], after[field])) continue;
    if (!scope.allowedFields.has(field)) {
      throw repairGuardError("TARGETED_REPAIR_CHANGED_UNTARGETED_FIELD", { field });
    }
  }
  if (String(before.html || "") === String(after.html || "")) return true;
  if (!scope.htmlMentioned) {
    throw repairGuardError("TARGETED_REPAIR_CHANGED_HTML_WITHOUT_HTML_TARGET");
  }
  const original = htmlParts(before.html);
  const repaired = htmlParts(after.html);
  if (scope.htmlBody) {
    if (original.blocks.length === 0 && repaired.blocks.length === 0) return true;
    throw repairGuardError("TARGETED_REPAIR_HTML_BODY_TARGET_TOO_BROAD");
  }
  if (scope.htmlTargets.size === 0) {
    throw repairGuardError("TARGETED_REPAIR_HTML_LOCATION_UNSAFE");
  }
  const { resolved: htmlTargets, unresolved } = resolveHtmlTargets(scope.htmlTargets, original.blocks);
  if (original.blocks.length !== repaired.blocks.length) {
    const insertions = appendOnlyInsertions(original.blocks, repaired.blocks);
    if (insertions && unresolved.length === 0) {
      return true;
    }
    throw repairGuardError("TARGETED_REPAIR_CHANGED_HTML_STRUCTURE", {
      beforeBlocks: original.blocks.length,
      afterBlocks: repaired.blocks.length
    });
  }
  if (original.gaps.length !== repaired.gaps.length) {
    throw repairGuardError("TARGETED_REPAIR_CHANGED_HTML_STRUCTURE");
  }
  for (let index = 0; index < original.gaps.length; index += 1) {
    if (original.gaps[index] !== repaired.gaps[index]) {
      throw repairGuardError("TARGETED_REPAIR_CHANGED_UNTARGETED_HTML_GAP", { index });
    }
  }
  for (let index = 0; index < original.blocks.length; index += 1) {
    const beforeBlock = original.blocks[index];
    const afterBlock = repaired.blocks[index];
    if (beforeBlock.tag !== afterBlock.tag) {
      throw repairGuardError("TARGETED_REPAIR_CHANGED_HTML_TAG", {
        index: beforeBlock.index,
        beforeTag: beforeBlock.tag,
        afterTag: afterBlock.tag
      });
    }
    if (htmlTargets.has(beforeBlock.index)) continue;
    if (beforeBlock.raw !== afterBlock.raw) {
      throw repairGuardError("TARGETED_REPAIR_CHANGED_UNTARGETED_HTML_BLOCK", {
        location: `html ${beforeBlock.tag} ${beforeBlock.index}`
      });
    }
  }
  if (unresolved.length > 0) {
    throw repairGuardError("TARGETED_REPAIR_TARGET_NOT_FOUND", { target: unresolved[0] });
  }
  return true;
}
__name(assertTargetedRepairPreserved, "assertTargetedRepairPreserved");
