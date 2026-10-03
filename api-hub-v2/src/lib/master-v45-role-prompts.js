import { MASTER_V45 } from './contracts.js';
import { loadMasterV45 } from './master-v45-bundle.js';

const ROLES = Object.freeze(['writer', 'critic', 'repair']);
const ROLE_SET = new Set(ROLES);
const cache = new Map();

const RUNTIME_CLARIFICATIONS = Object.freeze({
  writer: `RUNTIME WRITER CLARIFICATION — preserve the exact integrated Master v4.5 above and apply these source-safety rules in addition to it.
1. For general technical claims, standards, safety guidance, typical savings, rebates, costs, eligibility, or performance benchmarks, prefer supplied primary/official/standards-body sources whenever available. A contractor, installer, retailer, affiliate, lead-generation, or vendor marketing page may support a fact specifically about that business or product, but must not be used as the evidence for a general industry benchmark or universal recommendation.
2. Same-site/internal navigation links are not evidence sources. Do not place internal-navigation URLs in Article.sources merely to satisfy a source requirement.`,
  critic: `RUNTIME CRITIC CLARIFICATION — preserve the exact integrated Master v4.5 above and apply these machine-safety clarifications in addition to it.
1. SAME-SITE INTERNAL NAVIGATION IS NOT AN EVIDENCE SOURCE. HTML marked with data-smileseon-internal-links="1" is a Related guides / internal-navigation block. Do not emit a source-authority, source-verification, citation-quality, or replace/remove-source issue solely because one of those links points to the current site. Internal navigation may still be flagged when the URL is actually broken, misleading, unsafe, duplicated, or topically irrelevant.
2. NEVER FABRICATE AN HTML LOCATOR. Before returning an html p|h2|h3|li|blockquote N location, enumerate only those supported blocks in one shared document-order sequence starting at 1, confirm that N exists, and confirm that the tag at N exactly matches the emitted tag. Recount from the supplied current Article on every critic pass; never reuse an index from a prior version.
3. PLACEHOLDERS ARE CONTENT DEFECTS, NOT CODE-NAME CONTRACTS. If a literal placeholder such as [DATE] remains, report the actual token and exact valid location. Do not rely on a particular issue-code spelling to convey the defect.
4. SOURCE QUALITY APPLIES TO WRITER-ORIGINAL CONTENT TOO. Inspect Article.sources and the factual claims they support, not only newly repaired/inserted blocks. Contractor, installer, retailer, affiliate, lead-generation, or vendor marketing pages must not be accepted as evidence for general technical standards, typical savings, costs, safety thresholds, rebates, or universal recommendations unless the claim is specifically about that vendor/product. Prefer primary official agencies, standards bodies, original research, or other clearly authoritative sources when the supplied Article itself makes that support visible.`,
  repair: `RUNTIME REPAIR CLARIFICATION — preserve the exact integrated Master v4.5 above and apply these machine-safety clarifications in addition to it.
1. HTML marked with data-smileseon-internal-links="1" is internal navigation, not an evidence source. Never delete or replace that navigation block merely because a critic describes the same-site link as an unverified, weak, or non-authoritative source. Preserve it and apply any other valid repair issues normally. Actual broken, unsafe, duplicated, misleading, or irrelevant internal-link defects may still be repaired when precisely targeted.
2. A critic locator that does not exist in the supplied current Article is stale. Do not guess a nearby block and do not broaden the edit. Leave that nonexistent target untouched while applying other valid targets.`
});

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value || ''));
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function topLevelSectionCount(text) {
  return [...String(text || '').matchAll(/^# .+$/gm)].length;
}

export function rolePromptDefinition(role) {
  const key = String(role || '').trim();
  if (!ROLE_SET.has(key)) {
    throw Object.assign(new Error('MASTER_V45_ROLE_INVALID'), { status: 500 });
  }
  return Object.freeze({
    role: key,
    fileName: MASTER_V45.fileName,
    size: MASTER_V45.size,
    sha256: MASTER_V45.sha256,
    integratedMaster: true,
    exactFullMaster: true
  });
}

export async function loadMasterV45RolePrompt(role) {
  const key = String(role || '').trim();
  if (cache.has(key)) return cache.get(key);

  const definition = rolePromptDefinition(key);
  const sourceText = await loadMasterV45();
  const sourceBytes = utf8Bytes(sourceText);
  if (sourceBytes.byteLength !== MASTER_V45.size) {
    throw Object.assign(new Error('MASTER_V45_ROLE_SIZE_MISMATCH'), {
      status: 500,
      meta: { role: key, expected: MASTER_V45.size, actual: sourceBytes.byteLength }
    });
  }
  const sourceDigest = await sha256Hex(sourceBytes);
  if (sourceDigest !== MASTER_V45.sha256) {
    throw Object.assign(new Error('MASTER_V45_ROLE_SHA256_MISMATCH'), {
      status: 500,
      meta: { role: key }
    });
  }

  const runtimeClarification = String(RUNTIME_CLARIFICATIONS[key] || '').trim();
  const effectiveText = runtimeClarification ? `${sourceText}\n\n${runtimeClarification}` : sourceText;
  const effectiveBytes = utf8Bytes(effectiveText);
  const effectiveDigest = await sha256Hex(effectiveBytes);

  const result = Object.freeze({
    text: effectiveText,
    sourceText,
    meta: Object.freeze({
      role: key,
      fileName: definition.fileName,
      size: MASTER_V45.size,
      sha256: MASTER_V45.sha256,
      sectionCount: topLevelSectionCount(sourceText),
      exactSourceSections: true,
      exactFullMaster: true,
      integratedMaster: true,
      sourceMasterSha256: MASTER_V45.sha256,
      sourceMasterSize: MASTER_V45.size,
      runtimeClarification: runtimeClarification || null,
      effectiveSize: effectiveBytes.byteLength,
      effectiveSha256: effectiveDigest
    })
  });
  cache.set(key, result);
  return result;
}

export async function masterV45RolePromptRuntimeStatus() {
  const output = {};
  for (const role of ROLES) {
    output[role] = (await loadMasterV45RolePrompt(role)).meta;
  }
  return output;
}
