// src/lib/master-v45-role-prompts.js
var ROLES = Object.freeze(["writer", "critic", "repair"]);
var ROLE_SET = new Set(ROLES);
var cache = /* @__PURE__ */ new Map();
function utf8Bytes(value) {
  return new TextEncoder().encode(String(value || ""));
}
__name(utf8Bytes, "utf8Bytes");
async function sha256Hex2(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex2, "sha256Hex");
function topLevelSectionCount(text) {
  return [...String(text || "").matchAll(/^# .+$/gm)].length;
}
__name(topLevelSectionCount, "topLevelSectionCount");
function rolePromptDefinition(role) {
  const key = String(role || "").trim();
  if (!ROLE_SET.has(key)) {
    throw Object.assign(new Error("MASTER_V45_ROLE_INVALID"), { status: 500 });
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
__name(rolePromptDefinition, "rolePromptDefinition");
async function loadMasterV45RolePrompt(role) {
  const key = String(role || "").trim();
  if (cache.has(key)) return cache.get(key);
  const definition = rolePromptDefinition(key);
  const sourceText = await loadMasterV45();
  const sourceBytes = utf8Bytes(sourceText);
  if (sourceBytes.byteLength !== MASTER_V45.size) {
    throw Object.assign(new Error("MASTER_V45_ROLE_SIZE_MISMATCH"), {
      status: 500,
      meta: { role: key, expected: MASTER_V45.size, actual: sourceBytes.byteLength }
    });
  }
  const sourceDigest = await sha256Hex2(sourceBytes);
  if (sourceDigest !== MASTER_V45.sha256) {
    throw Object.assign(new Error("MASTER_V45_ROLE_SHA256_MISMATCH"), {
      status: 500,
      meta: { role: key }
    });
  }
  const result = Object.freeze({
    text: sourceText,
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
      runtimeClarification: null,
      effectiveSize: MASTER_V45.size,
      effectiveSha256: MASTER_V45.sha256
    })
  });
  cache.set(key, result);
  return result;
}
__name(loadMasterV45RolePrompt, "loadMasterV45RolePrompt");
async function masterV45RolePromptRuntimeStatus() {
  const output = {};
  for (const role of ROLES) {
    output[role] = (await loadMasterV45RolePrompt(role)).meta;
  }
  return output;
}
__name(masterV45RolePromptRuntimeStatus, "masterV45RolePromptRuntimeStatus");
