#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
API = "https://api.cloudflare.com/client/v4"

if not ACCOUNT or not TOKEN:
    raise SystemExit("CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN required")


@dataclass
class WorkerContent:
    name: str
    body: bytes
    content_type: str


def request(method: str, url: str, *, body: bytes | None = None, content_type: str | None = None, timeout: int = 60):
    headers = {"Authorization": f"Bearer {TOKEN}"}
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:3000]
        raise RuntimeError(f"HTTP {exc.code} {method} {url}: {detail}") from exc


def get_content(name: str) -> WorkerContent:
    url = f"{API}/accounts/{ACCOUNT}/workers/scripts/{name}/content/v2"
    status, headers, body = request("GET", url)
    if status != 200:
        raise RuntimeError(f"GET_CONTENT_{name}_{status}")
    content_type = headers.get("Content-Type", "").strip()
    if not content_type:
        raise RuntimeError(f"CONTENT_TYPE_MISSING:{name}")
    return WorkerContent(name=name, body=body, content_type=content_type)


def put_content(content: WorkerContent, body: bytes) -> None:
    # The content endpoint replaces code without changing Worker configuration/metadata.
    url = f"{API}/accounts/{ACCOUNT}/workers/scripts/{content.name}/content"
    status, _, result = request("PUT", url, body=body, content_type=content.content_type, timeout=90)
    if status < 200 or status >= 300:
        raise RuntimeError(f"PUT_CONTENT_{content.name}_{status}")
    text = result.decode("utf-8", errors="replace")
    if '"success":false' in text.replace(" ", "").lower():
        raise RuntimeError(f"PUT_CONTENT_FAILED:{content.name}:{text[:2000]}")


def replace_one(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, got {count}")
    return text.replace(old, new, 1)


def patch_hub(raw: bytes) -> bytes:
    text = raw.decode("utf-8", errors="surrogateescape")

    writer_marker = "When seoBrief is supplied, use it as planning and search-intent context:"
    writer_insert = (
        "SOURCE QUALITY BOUNDARY \\u2014 for general technical standards, safety guidance, typical savings, costs, rebates, eligibility or performance benchmarks, prefer supplied primary/official/standards-body evidence whenever available. "
        "A contractor, installer, retailer, affiliate, lead-generation or vendor marketing page may support a fact specifically about that business or product, but must not be used as the evidence for a general industry benchmark or universal recommendation. "
        "Same-site internal-navigation links are not evidence sources and must not be put into Article.sources merely to satisfy a source requirement.\n"
    )
    text = replace_one(text, writer_marker, writer_insert + writer_marker, "writer source quality")

    critic_marker = "LOCATION CONTRACT \\u2014 every issue.location must be machine-targetable."
    critic_insert = (
        "SAME-SITE INTERNAL NAVIGATION IS NOT AN EVIDENCE SOURCE \\u2014 HTML marked with data-smileseon-internal-links=\"1\" is a Related guides/internal-navigation block. "
        "Do not emit a source-authority, source-verification, citation-quality or replace/remove-source issue solely because one of those links points to the current site. Internal navigation may still be flagged when the URL is actually broken, unsafe, duplicated, misleading or topically irrelevant.\n\n"
        "LOCATOR VALIDATION \\u2014 never fabricate an HTML locator. Before returning an html p|h2|h3|li|blockquote N location, enumerate the supported blocks in the current supplied Article in the one shared document-order sequence, confirm N exists, and confirm the tag at N exactly matches the emitted tag. Recount on every critic pass; never reuse an index from a prior article version.\n\n"
        "WRITER-ORIGINAL SOURCE QUALITY \\u2014 audit Article.sources and the factual claims they support even when they came from the original writer rather than a repair. Contractor, installer, retailer, affiliate, lead-generation or vendor marketing pages are not adequate evidence for general technical standards, typical savings, costs, safety thresholds, rebates or universal recommendations unless the claim is specifically about that vendor/product. Prefer primary official agencies, standards bodies or original research when the supplied Article/research makes that support available.\n\n"
    )
    text = replace_one(text, critic_marker, critic_insert + critic_marker, "critic locator contract")

    repair_marker = "This is Google Blogger / Blogspot: Article.title is rendered outside Article.html"
    repair_insert = (
        "INTERNAL NAVIGATION SAFETY \\u2014 HTML marked with data-smileseon-internal-links=\"1\" is internal navigation, not an evidence source. Never delete or replace that navigation block merely because a critic describes the same-site link as an unverified, weak or non-authoritative source. Preserve it and apply other valid repair issues normally. Actual broken, unsafe, duplicated, misleading or irrelevant internal-link defects may still be repaired when precisely targeted.\n"
        "STALE LOCATOR SAFETY \\u2014 if a critic locator does not exist in the supplied current Article, do not guess a nearby block and do not broaden the edit. Leave that nonexistent target untouched while applying other valid targets.\n"
    )
    text = replace_one(text, repair_marker, repair_insert + repair_marker, "repair navigation safety")

    required = [
        "SAME-SITE INTERNAL NAVIGATION IS NOT AN EVIDENCE SOURCE",
        "LOCATOR VALIDATION",
        "WRITER-ORIGINAL SOURCE QUALITY",
        "INTERNAL NAVIGATION SAFETY",
        "STALE LOCATOR SAFETY",
        "PUBLICATION DATE PLACEHOLDER",
    ]
    missing = [value for value in required if value not in text]
    if missing:
        raise RuntimeError(f"API_HUB_PATCH_MARKERS_MISSING:{missing}")
    return text.encode("utf-8", errors="surrogateescape")


def patch_orchestrator(raw: bytes) -> bytes:
    text = raw.decode("utf-8", errors="surrogateescape")

    helper_anchor = 'var EXACT_HTML_LOCATION_RE = /html\\s+(p|h2|h3|li|blockquote)\\s+(\\d+)/gi;\n'
    helper_code = '''var SMILESEON_INTERNAL_LINK_MARKER_RE = /data-smileseon-internal-links\\s*=\\s*["']1["']/i;\nvar SMILESEON_SOURCE_AUTHORITY_RE = /\\b(?:source|sources|citation|citations|reference|references|authority|authoritative|verified|credible|trusted|evidence)\\b|출처|인용|근거|검증|신뢰/i;\nvar SMILESEON_SOURCE_REPAIR_RE = /\\b(?:remove|replace|delete|drop|swap|use|cite|citation|source)\\b|제거|교체|삭제|대체|출처|인용/i;\nvar SMILESEON_INTERNAL_LINK_DEFECT_RE = /\\b(?:broken|dead|404|unsafe|javascript|duplicate|duplicated|irrelevant|unrelated|misleading|incorrect|wrong|malformed|redirect\\s*loop|not\\s*found)\\b|깨진|끊긴|404|위험|중복|관련\\s*없|무관|오해|잘못된|틀린|유효하지\\s*않|찾을\\s*수\\s*없/i;\nfunction smileseonRepairIssueText(issue3) {\n  return [issue3?.code, issue3?.location, issue3?.reason, issue3?.message, issue3?.repairInstruction].map((value) => String(value || "")).join(" ");\n}\nfunction smileseonIsSourceAuthorityRepairIssue(issue3) {\n  const value = smileseonRepairIssueText(issue3);\n  if (SMILESEON_INTERNAL_LINK_DEFECT_RE.test(value)) return false;\n  return SMILESEON_SOURCE_AUTHORITY_RE.test(value) && SMILESEON_SOURCE_REPAIR_RE.test(value);\n}\nfunction smileseonProtectedInternalNavIndexes(parts, issues = []) {\n  const protectedIndexes = new Set();\n  for (const issue3 of Array.isArray(issues) ? issues : []) {\n    if (!smileseonIsSourceAuthorityRepairIssue(issue3)) continue;\n    const issueScope = targetedRepairScope([issue3]);\n    const { resolved } = resolveHtmlTargets(issueScope.htmlTargets, parts.blocks);\n    for (const index of resolved) {\n      const block = parts.blocks[index - 1];\n      if (block && SMILESEON_INTERNAL_LINK_MARKER_RE.test(block.raw)) protectedIndexes.add(index);\n    }\n  }\n  return protectedIndexes;\n}\n'''
    text = replace_one(text, helper_anchor, helper_anchor + helper_code, "guard helper anchor")

    old_constrain = '''  const { resolved: htmlTargets, unresolved } = resolveHtmlTargets(scope.htmlTargets, original.blocks);\n  if (unresolved.length > 0) throw repairGuardError("TARGETED_REPAIR_TARGET_NOT_FOUND", { target: unresolved[0] });\n'''
    new_constrain = '''  const { resolved: htmlTargets } = resolveHtmlTargets(scope.htmlTargets, original.blocks);\n  for (const protectedIndex of smileseonProtectedInternalNavIndexes(original, issues)) htmlTargets.delete(protectedIndex);\n  if (htmlTargets.size === 0) return constrained;\n'''
    text = replace_one(text, old_constrain, new_constrain, "constrain stale target")

    old_assert = '''  const { resolved: htmlTargets, unresolved } = resolveHtmlTargets(scope.htmlTargets, original.blocks);\n  if (original.blocks.length !== repaired.blocks.length) {\n    const insertions = appendOnlyInsertions(original.blocks, repaired.blocks);\n    if (insertions && unresolved.length === 0) {\n      return true;\n    }\n'''
    new_assert = '''  const { resolved: htmlTargets } = resolveHtmlTargets(scope.htmlTargets, original.blocks);\n  for (const protectedIndex of smileseonProtectedInternalNavIndexes(original, issues)) htmlTargets.delete(protectedIndex);\n  if (htmlTargets.size === 0) throw repairGuardError("TARGETED_REPAIR_CHANGED_HTML_WITHOUT_RESOLVABLE_TARGET");\n  if (original.blocks.length !== repaired.blocks.length) {\n    const insertions = appendOnlyInsertions(original.blocks, repaired.blocks);\n    if (insertions) {\n      return true;\n    }\n'''
    text = replace_one(text, old_assert, new_assert, "assert stale target")

    old_final = '''  if (unresolved.length > 0) {\n    throw repairGuardError("TARGETED_REPAIR_TARGET_NOT_FOUND", { target: unresolved[0] });\n  }\n  return true;\n'''
    text = replace_one(text, old_final, '  return true;\n', "final stale target throw")

    date_anchor = 'function text(value) {\n'
    date_helpers = '''var SMILESEON_DATE_PLACEHOLDER_RE = /(?:\\[(?:current[_\\s-]*)?date\\]|\\{\\{\\s*(?:current[_\\s-]*)?date\\s*\\}\\})/i;\nvar SMILESEON_PUBLICATION_DATE_SLOT_RE = /(?:Published|게시일|작성일|Last\\s+updated|Updated|Reviewed|최종\\s*수정)\\s*:\\s*\\[DATE\\]/gi;\nfunction smileseonDatePlaceholderResidue(value) {\n  const source = String(value || "");\n  const withoutServerSlots = source.replace(SMILESEON_PUBLICATION_DATE_SLOT_RE, "");\n  return SMILESEON_DATE_PLACEHOLDER_RE.test(withoutServerSlots);\n}\n'''
    text = replace_one(text, date_anchor, date_helpers + date_anchor, "date helper anchor")

    qa_anchor = '''  for (const rule of BLOCK_PATTERNS) {\n    if (rule.pattern.test(combined)) issues.push(issue2(rule.code, "block", rule.message, "content"));\n  }\n  for (const rule of WARN_PATTERNS) {\n'''
    qa_new = '''  for (const rule of BLOCK_PATTERNS) {\n    if (rule.pattern.test(combined)) issues.push(issue2(rule.code, "block", rule.message, "content"));\n  }\n  if (smileseonDatePlaceholderResidue(combined)) {\n    issues.push(issue2("PLACEHOLDER_DATE_TOKEN", "block", "Unresolved date placeholder remains outside server-managed publication metadata.", "content"));\n  }\n  for (const rule of WARN_PATTERNS) {\n'''
    text = replace_one(text, qa_anchor, qa_new, "date residue gate")

    must_keep = [
        "TARGETED_REPAIR_INSERTION_REJECTED",
        "acceptInsertions(before.html, insertions",
        "smileseonProtectedInternalNavIndexes",
        "PLACEHOLDER_DATE_TOKEN",
        "Related Articles",
        "8000",
    ]
    missing = [value for value in must_keep if value not in text]
    if missing:
        raise RuntimeError(f"ORCHESTRATOR_PATCH_MARKERS_MISSING:{missing}")
    poison = 'if (unresolved.length > 0) throw repairGuardError("TARGETED_REPAIR_TARGET_NOT_FOUND"'
    if poison in text:
        raise RuntimeError("STALE_TARGET_POISON_STILL_PRESENT_AFTER_PATCH")
    return text.encode("utf-8", errors="surrogateescape")


def verify_live() -> None:
    hub = get_content("api-hub-v2").body.decode("utf-8", errors="ignore")
    orch = get_content("content-orchestrator").body.decode("utf-8", errors="ignore")
    for marker in [
        "SAME-SITE INTERNAL NAVIGATION IS NOT AN EVIDENCE SOURCE",
        "LOCATOR VALIDATION",
        "WRITER-ORIGINAL SOURCE QUALITY",
        "INTERNAL NAVIGATION SAFETY",
        "STALE LOCATOR SAFETY",
    ]:
        if marker not in hub:
            raise RuntimeError(f"HUB_READBACK_MISSING:{marker}")
    for marker in [
        "smileseonProtectedInternalNavIndexes",
        "TARGETED_REPAIR_INSERTION_REJECTED",
        "PLACEHOLDER_DATE_TOKEN",
        "Related Articles",
    ]:
        if marker not in orch:
            raise RuntimeError(f"ORCHESTRATOR_READBACK_MISSING:{marker}")
    poison = 'if (unresolved.length > 0) throw repairGuardError("TARGETED_REPAIR_TARGET_NOT_FOUND"'
    if poison in orch:
        raise RuntimeError("ORCHESTRATOR_READBACK_STALE_TARGET_POISON")
    print("LIVE_CODE_READBACK_OK")
    print("TARGETED_REPAIR_INSERTION_REJECTED_COUNT", orch.count("TARGETED_REPAIR_INSERTION_REJECTED"))
    print("INTERNAL_NAV_GUARD_COUNT", orch.count("smileseonProtectedInternalNavIndexes"))
    print("DATE_CONTENT_GUARD_COUNT", orch.count("PLACEHOLDER_DATE_TOKEN"))


def health_check() -> None:
    url = f"https://content-orchestrator.smileseon.workers.dev/health?hardening={int(time.time())}"
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"}, method="GET")
    last = ""
    for _ in range(15):
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                body = response.read().decode("utf-8", errors="replace")
                last = f"{response.status}:{body[:500]}"
                if response.status == 200 and '"systemPaused":false' in body.replace(" ", ""):
                    print("PUBLIC_HEALTH_OK")
                    return
        except Exception as exc:  # health retries are bounded; rollback occurs if all fail
            last = repr(exc)
        time.sleep(1)
    raise RuntimeError(f"PUBLIC_HEALTH_FAILED:{last}")


def main() -> int:
    before_hub = get_content("api-hub-v2")
    before_orch = get_content("content-orchestrator")
    after_hub = patch_hub(before_hub.body)
    after_orch = patch_orchestrator(before_orch.body)
    print("PATCH_STATIC_CHECKS_OK")

    hub_done = False
    orch_done = False
    try:
        # Prompt layer first; guard layer second. Both roll back together on any failure.
        put_content(before_hub, after_hub)
        hub_done = True
        put_content(before_orch, after_orch)
        orch_done = True
        time.sleep(2)
        verify_live()
        health_check()
    except Exception:
        print("LIVE_PATCH_FAILED_ROLLING_BACK", file=sys.stderr)
        if orch_done:
            try:
                put_content(before_orch, before_orch.body)
                print("ORCHESTRATOR_ROLLBACK_OK", file=sys.stderr)
            except Exception as rollback_error:
                print(f"ORCHESTRATOR_ROLLBACK_FAILED:{rollback_error}", file=sys.stderr)
        if hub_done:
            try:
                put_content(before_hub, before_hub.body)
                print("API_HUB_ROLLBACK_OK", file=sys.stderr)
            except Exception as rollback_error:
                print(f"API_HUB_ROLLBACK_FAILED:{rollback_error}", file=sys.stderr)
        raise

    print("LIVE_PATCH_DEPLOYED_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
