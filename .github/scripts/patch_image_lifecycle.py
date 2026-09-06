from pathlib import Path


def rep(path, old, new, n=1):
    p = Path(path)
    s = p.read_text()
    if s.count(old) < n:
        raise SystemExit(f"needle missing: {path}: {old[:120]!r}")
    p.write_text(s.replace(old, new, n))


# Preserve the actual KIE result URL so QA-rejected candidates can be inspected.
rep(
    "api-hub-v2/src/lib/kie-image.js",
    "    state: 'success',\n    pending: false,\n    complete: true,\n    ...downloaded",
    "    state: 'success',\n    pending: false,\n    complete: true,\n    sourceUrl: resultUrl,\n    ...downloaded",
)

# QA: block actual writing/logo/watermark defects, not subjective composition preferences.
rep(
    "api-hub-v2/src/lib/image-routes.js",
    "      'Return only the requested JSON structure.'",
    "      'Only list violations related to readable or clearly intended writing, logos, watermarks, labels, captions, signs, packaging marks, interface writing, or title overlays. Do not use this field for aesthetic or composition preferences.',\n      'Return only the requested JSON structure.'",
)
rep(
    "api-hub-v2/src/lib/image-routes.js",
    "  return {\n    pass: parsed?.pass === true && detectedText.length === 0 && violations.length === 0,\n    detectedText,\n    violations,\n    model: result.model\n  };",
    "  const hardViolations = violations.filter((item) => /(readable|text|letter|number|logo|watermark|caption|label|sign|packaging|interface|\\bui\\b|title|writing|문자|글자|숫자|로고|워터마크|라벨|표지|간판)/i.test(item));\n  return {\n    pass: detectedText.length === 0 && hardViolations.length === 0,\n    detectedText,\n    violations: hardViolations,\n    model: result.model\n  };",
)
rep(
    "api-hub-v2/src/lib/image-routes.js",
    "  let lastQa = null;\n  let providerAttempts = 0;",
    "  let lastQa = null;\n  let lastGenerated = null;\n  let providerAttempts = 0;",
)
rep(
    "api-hub-v2/src/lib/image-routes.js",
    "    }, aiBinding, fetchImpl);\n    providerAttempts = attempt;",
    "    }, aiBinding, fetchImpl);\n    lastGenerated = generated;\n    providerAttempts = attempt;",
)
rep(
    "api-hub-v2/src/lib/image-routes.js",
    "  error.qaDetectedTextCount = Number(lastQa?.detectedText?.length || 0);\n  throw error;",
    "  error.qaDetectedTextCount = Number(lastQa?.detectedText?.length || 0);\n  error.qaDetectedText = Array.isArray(lastQa?.detectedText) ? lastQa.detectedText.slice(0, 8) : [];\n  error.qaViolations = Array.isArray(lastQa?.violations) ? lastQa.violations.slice(0, 8) : [];\n  if (lastGenerated?.provider === 'kie-ai' && /^https:\\/\\//i.test(String(lastGenerated?.sourceUrl || ''))) {\n    error.rejectedImageUrl = String(lastGenerated.sourceUrl);\n    error.rejectedImageMimeType = String(lastGenerated.mimeType || 'image/jpeg');\n    error.rejectedProvider = 'kie-ai';\n    error.rejectedModel = String(lastGenerated.model || 'z-image');\n    error.rejectedTaskId = String(lastGenerated.taskId || '');\n  }\n  throw error;",
)
rep(
    "api-hub-v2/src/index.js",
    "      if (Number.isInteger(error?.qaDetectedTextCount)) body.qaDetectedTextCount = error.qaDetectedTextCount;\n      if (error?.meta === MASTER_V45) body.masterV45 = MASTER_V45;",
    "      if (Number.isInteger(error?.qaDetectedTextCount)) body.qaDetectedTextCount = error.qaDetectedTextCount;\n      if (Array.isArray(error?.qaDetectedText) && error.qaDetectedText.length) body.qaDetectedText = error.qaDetectedText.map((item) => String(item).slice(0, 100)).slice(0, 8);\n      if (Array.isArray(error?.qaViolations) && error.qaViolations.length) body.qaViolations = error.qaViolations.map((item) => String(item).slice(0, 100)).slice(0, 8);\n      if (String(error?.message || '') === 'IMAGE_QA_REJECTED' && /^https:\\/\\//i.test(String(error?.rejectedImageUrl || ''))) {\n        body.rejectedImageUrl = String(error.rejectedImageUrl);\n        body.rejectedImageMimeType = String(error.rejectedImageMimeType || 'image/jpeg');\n        body.rejectedProvider = 'kie-ai';\n        body.rejectedModel = String(error.rejectedModel || 'z-image').slice(0, 80);\n        body.rejectedTaskId = String(error.rejectedTaskId || '').slice(0, 120);\n      }\n      if (error?.meta === MASTER_V45) body.masterV45 = MASTER_V45;",
)

# No fixed 10-second wait. KIE task status and genuine 429/backoff remain authoritative.
rep(
    "worker/lib/image-executor.js",
    "export function kieQaRetryCooldownMs(env = {}) {\n  const configured = Number(env?.SERIAL_IMAGE_COOLDOWN_MS ?? 10_000);\n  if (!Number.isInteger(configured) || configured < 5_000 || configured > 60_000) return 10_000;\n  return configured;\n}",
    "export function kieQaRetryCooldownMs(env = {}) {\n  const configured = Number(env?.SERIAL_IMAGE_COOLDOWN_MS ?? 0);\n  if (!Number.isInteger(configured) || configured < 0 || configured > 30_000) return 0;\n  return configured;\n}",
)
rep(
    "worker/lib/image-executor.js",
    "async function restartKieAfterQa(env, image, callHubFn) {\n  await sleep(kieQaRetryCooldownMs(env));",
    "async function restartKieAfterQa(env, image, callHubFn) {\n  const cooldownMs = kieQaRetryCooldownMs(env);\n  if (cooldownMs > 0) await sleep(cooldownMs);",
)

# Keep rejected KIE preview evidence and prioritize active/fresh work fairly.
rep(
    "worker/lib/image-executor.js",
    "      error.cause = lastError;\n      throw error;",
    "      error.cause = lastError;\n      error.rejectedImageData = firstError?.data?.rejectedImageUrl ? firstError.data : (lastError?.data?.rejectedImageUrl ? lastError.data : null);\n      throw error;",
)
rep(
    "worker/lib/image-executor.js",
    "export async function generatePlannedImages(env, jobId, options = {}) {",
    "const ACTIVE_PROVIDER_STATES = new Set(['waiting', 'queuing', 'generating', 'pending', 'processing', 'running']);\n\nexport function imageExecutionPriority(image = {}) {\n  const status = String(image?.status || '');\n  const providerState = String(image?.provider_status || '').trim().toLowerCase();\n  const active = Boolean(String(image?.provider_task_id || '').trim()) && ACTIVE_PROVIDER_STATES.has(providerState);\n  if (active) return 0;\n  if (status === 'planned' && Number(image?.provider_attempt_count || 0) === 0) return 1;\n  if (status === 'generated') return 2;\n  if (status === 'planned') return 3;\n  if (status === 'failed') return 4;\n  return 5;\n}\n\nfunction orderedImageCandidates(rows = [], retryFailed = true) {\n  return rows.filter((row) => isResumableImageStatus(row.status, retryFailed)).map((row, index) => ({ row, index })).sort((a, b) => imageExecutionPriority(a.row) - imageExecutionPriority(b.row) || a.index - b.index).map((item) => item.row);\n}\n\nexport async function generatePlannedImages(env, jobId, options = {}) {",
)
rep(
    "worker/lib/image-executor.js",
    "  const candidates = rows.filter((row) => isResumableImageStatus(row.status, retryFailed)).slice(0, maxImages);",
    "  const candidates = orderedImageCandidates(rows, retryFailed).slice(0, maxImages);",
)
rep(
    "worker/lib/image-executor.js",
    "export function isResumableImageStatus(status, retryFailed = true) {",
    "async function preserveRejectedPreview(env, bucket, baseUrl, jobId, image, error) {\n  const data = error?.rejectedImageData || error?.data || null;\n  const url = String(data?.rejectedImageUrl || '').trim();\n  if (!/^https:\\/\\//i.test(url)) return null;\n  const response = await fetch(url, { redirect: 'follow' });\n  if (!response.ok) return null;\n  const bytes = new Uint8Array(await response.arrayBuffer());\n  if (!bytes.length || bytes.length > 12 * 1024 * 1024) return null;\n  const mimeType = sourceImageMimeType(response.headers.get('content-type') || data?.rejectedImageMimeType || 'image/jpeg');\n  const generated = { provider: 'kie-ai', model: String(data?.rejectedModel || 'z-image'), mimeType };\n  await markImageGenerated(env, image.id, generated);\n  const stored = await storeImageBytes(env, bucket, baseUrl, jobId, image, bytes, mimeType, generated, { sourceMimeType: mimeType, postprocessed: 'qa-rejected-preview' });\n  return stored.url;\n}\n\nexport function isResumableImageStatus(status, retryFailed = true) {",
)
rep(
    "worker/lib/image-executor.js",
    "    } catch (error) {\n      await markImageFailed(env, image.id, error?.message || 'IMAGE_GENERATION_FAILED');\n      outcomes.push({ imageId: image.id, status: 'failed', error: String(error?.message || 'IMAGE_GENERATION_FAILED') });\n    }",
    "    } catch (error) {\n      const rejectedPreviewUrl = await preserveRejectedPreview(env, bucket, baseUrl, jobId, image, error).catch(() => null);\n      await markImageFailed(env, image.id, error?.message || 'IMAGE_GENERATION_FAILED');\n      outcomes.push({ imageId: image.id, status: 'failed', error: String(error?.message || 'IMAGE_GENERATION_FAILED'), rejectedPreviewUrl });\n    }",
)

# Core lifecycle fix: accepted stored images are attached and persisted immediately.
old_completion = """  if (!state.complete) {
    return {
      jobId,
      blogId: String(candidate.blog_id),
      mode: String(candidate.mode),
      complete: false,
      generated: generated.stored,
      failed: generated.failed,
      targetTotal: plan.targetTotal,
      existingCount: plan.existingCount,
      ...state
    };
  }

  const article = attachStoredImages(result.article, images);
  const verification = validateImagePolicy(candidate.mode, article, effective);
  if (!verification.ok) throw new Error('IMAGE_POLICY_ATTACH_INCOMPLETE');

  const nextResult = {
    ...result,
    article,
    images: images.map((image) => ({
      id: image.id,
      role: image.role,
      position: image.position,
      url: image.public_url,
      altText: image.alt_text,
      provider: image.provider || null
    })),
    imagePipeline: imagePipelineMeta(candidate, plan, images, verification, {
      generated: plan.generatedCount,
      reusedExisting: plan.existingCount > 0
    })
  };
  await persistJobResult(env, jobId, nextResult);
  for (const image of images) {
    if (String(image.status) === 'stored') await markImageAttached(env, image.id);
  }
  const attachedImages = await listJobImages(env, jobId);
  const finalState = imageCompletionState(attachedImages, plan.generatedCount);
  if (finalState.attached < plan.generatedCount) throw new Error('IMAGE_COMPLETION_ATTACH_INCOMPLETE');

  return {
    jobId,
    blogId: String(candidate.blog_id),
    mode: String(candidate.mode),
    complete: true,
    generated: generated.stored,
    failed: generated.failed,
    targetTotal: plan.targetTotal,
    existingCount: plan.existingCount,
    currentCount: verification.currentCount,
    ...finalState
  };
"""
new_completion = """  const attachableImages = images.filter((image) => String(image.status) === 'stored');
  const article = attachStoredImages(result.article, images);
  const verification = validateImagePolicy(candidate.mode, article, effective);
  const visibleImages = images.filter((image) => ['stored', 'attached'].includes(String(image.status)) && /^https:\/\//i.test(String(image.public_url || '')));

  if (visibleImages.length > 0) {
    const nextResult = {
      ...result,
      article,
      images: visibleImages.map((image) => ({
        id: image.id,
        role: image.role,
        position: image.position,
        url: image.public_url,
        altText: image.alt_text,
        provider: image.provider || null
      })),
      imagePipeline: imagePipelineMeta(candidate, plan, images, verification, {
        complete: verification.ok,
        generated: visibleImages.length,
        attachedThisRun: attachableImages.length,
        reusedExisting: plan.existingCount > 0,
        lastAttachedAt: new Date().toISOString()
      })
    };
    await persistJobResult(env, jobId, nextResult);
    for (const image of attachableImages) await markImageAttached(env, image.id);
    images = await listJobImages(env, jobId);
    state = imageCompletionState(images, plan.generatedCount);
  }

  if (!verification.ok) {
    return {
      jobId,
      blogId: String(candidate.blog_id),
      mode: String(candidate.mode),
      complete: false,
      generated: generated.stored,
      failed: generated.failed,
      attachedThisRun: attachableImages.length,
      targetTotal: plan.targetTotal,
      existingCount: plan.existingCount,
      currentCount: verification.currentCount,
      missing: verification.missing,
      ...state
    };
  }

  return {
    jobId,
    blogId: String(candidate.blog_id),
    mode: String(candidate.mode),
    complete: true,
    generated: generated.stored,
    failed: generated.failed,
    attachedThisRun: attachableImages.length,
    targetTotal: plan.targetTotal,
    existingCount: plan.existingCount,
    currentCount: verification.currentCount,
    ...state
  };
"""
rep("worker/lib/image-completion.js", old_completion, new_completion)

# Image watchdog: one leased batch, up to 8 serial KIE tasks, no artificial 10s sleep.
p = Path("worker/mcp-entry.js")
s = p.read_text()
start = s.index("async function runSerialImageWatchdog(env, ctx) {")
end = s.index("\nasync function runLegacyMaintenance", start)
new_watchdog = """async function runSerialImageWatchdog(env, ctx) {
  const maxItems = positiveBounded(env?.SERIAL_IMAGE_CHAIN_MAX_ITEMS, 8, 1, 8);
  const leaseTtlSeconds = positiveBounded(env?.SERIAL_IMAGE_LEASE_TTL_SECONDS, 210, 60, 900);
  const startedAt = Date.now();
  const steps = [];
  const lease = await acquireRuntimeLock(env, IMAGE_LANE_LOCK_KEY, { ttlSeconds: leaseTtlSeconds });
  if (!lease.acquired) return { ok: true, watchdogCron: WATCHDOG_CRON, providerPriority: 'kie->cloudflare', cooldownMs: 0, maxItems, stopReason: 'IMAGE_LANE_BUSY', durationMs: Date.now() - startedAt, steps };
  let stopReason = 'NO_ELIGIBLE_IMAGES';
  try {
    if (!await renewRuntimeLock(env, lease, { ttlSeconds: leaseTtlSeconds })) {
      stopReason = 'IMAGE_LANE_LEASE_LOST';
    } else {
      let imageWork = emptyImageWork();
      let imageError = null;
      try {
        imageWork = await runScheduledImageCompletion(env, { maxJobs: maxItems, maxImages: 1, staleMinutes: 0, executionContext: ctx });
      } catch (error) {
        imageError = safeScheduledError(error);
        imageWork = emptyImageWork(imageError);
        console.error('SERIAL_IMAGE_WORK_FAILED', imageError);
      }
      steps.push({ sequence: 1, ...compactImageWork(imageWork, imageError) });
      if (imageError) stopReason = 'IMAGE_WORK_ERROR';
      else if (imageWork?.enabled === false) stopReason = String(imageWork?.reason || 'IMAGE_WORK_DISABLED');
      else if (Number(imageWork?.attempted || 0) === 0) stopReason = 'NO_ELIGIBLE_IMAGES';
      else if (imageProviderBackoffRequired(imageWork)) stopReason = 'IMAGE_PROVIDER_BACKOFF';
      else stopReason = 'BATCH_DISPATCHED';
    }
  } finally {
    await releaseRuntimeLock(env, lease).catch((error) => console.error('SERIAL_IMAGE_LEASE_RELEASE_FAILED', safeScheduledError(error)));
  }
  return { ok: !['IMAGE_WORK_ERROR', 'IMAGE_LANE_LEASE_LOST'].includes(stopReason), watchdogCron: WATCHDOG_CRON, providerPriority: 'kie->cloudflare', cooldownMs: 0, maxItems, leaseTtlSeconds, stopReason, durationMs: Date.now() - startedAt, steps };
}
"""
p.write_text(s[:start] + new_watchdog + s[end:])

# Add image rows to job list in one query for the Work UI gallery.
rep(
    "worker/lib/job-store.js",
    "  const rows = await statement.all();\n  return (rows.results || []).map((row) => {",
    "  const rows = await statement.all();\n  const normalizedRows = (rows.results || []).map((row) => {",
)
rep(
    "worker/lib/job-store.js",
    "      error: humanReadableJobError(errorCode)\n    };\n  });\n}\n\nexport async function getStoredJob",
    "      error: humanReadableJobError(errorCode)\n    };\n  });\n  const ids = normalizedRows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);\n  if (!ids.length) return normalizedRows;\n  const placeholders = ids.map(() => '?').join(',');\n  const imageRows = await db.prepare(`SELECT id, job_id, role, position, alt_text, provider, status, public_url, provider_status, provider_task_id, updated_at FROM job_images WHERE job_id IN (${placeholders}) ORDER BY job_id DESC, CASE role WHEN 'thumbnail' THEN 0 ELSE 1 END, position, id`).bind(...ids).all();\n  const byJob = new Map();\n  for (const image of imageRows.results || []) {\n    const key = Number(image.job_id);\n    if (!byJob.has(key)) byJob.set(key, []);\n    if (byJob.get(key).length < 12) byJob.get(key).push(image);\n  }\n  return normalizedRows.map((row) => ({ ...row, _images: byJob.get(Number(row.id)) || [] }));\n}\n\nexport async function getStoredJob",
)

# Work UI image gallery.
rep(
    "web/work-cards.js",
    "  const image = imageSummary(row, result);\n\n  return `",
    "  const image = imageSummary(row, result);\n  const generatedImages = (Array.isArray(row?._images) ? row._images : []).filter((item) => /^https:\\/\\//i.test(String(item.public_url || '')));\n  const imageGallery = generatedImages.length ? `<div class=\"result-image-gallery\">${generatedImages.map((item) => `<a class=\"result-image-item\" href=\"${escapeHtml(item.public_url)}\" target=\"_blank\" rel=\"noopener noreferrer\"><img src=\"${escapeHtml(item.public_url)}\" alt=\"${escapeHtml(item.alt_text || '생성 이미지')}\" loading=\"lazy\"><span>${escapeHtml(item.role === 'thumbnail' ? '썸네일' : `본문 ${item.position || ''}`)} · ${escapeHtml(item.provider || '생성 이미지')}${item.status === 'failed' ? ' · QA 확인 필요' : ''}</span></a>`).join('')}</div>` : '';\n\n  return `",
)
rep(
    "web/work-cards.js",
    "        ${image.errorCodes.length ? `<div class=\"result-error\"><dt>이미지 오류</dt><dd>${escapeHtml(image.errorCodes.join(', '))}</dd></div>` : ''}\n        ${scheduled ?",
    "        ${image.errorCodes.length ? `<div class=\"result-error\"><dt>이미지 오류</dt><dd>${escapeHtml(image.errorCodes.join(', '))}</dd></div>` : ''}\n        ${generatedImages.length ? `<div class=\"result-images-row\"><dt>생성 이미지</dt><dd>${imageGallery}</dd></div>` : ''}\n        ${scheduled ?",
)
css = Path("web/work-cards.css")
css.write_text(css.read_text() + "\n.result-images-row dd{min-width:0}.result-image-gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-top:2px}.result-image-item{display:block;text-decoration:none;color:#cbd5e1;border:1px solid #26364f;border-radius:12px;overflow:hidden;background:#0b1422}.result-image-item img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;background:#020617}.result-image-item span{display:block;padding:7px 8px;font-size:10px;line-height:1.35;color:#94a3b8}@media(max-width:420px){.result-image-gallery{grid-template-columns:1fr}}\n")

rep("web/sw.js", "const CACHE = 'content-orchestrator-v29';", "const CACHE = 'content-orchestrator-v30';")
rep("wrangler.example.jsonc", '"SERIAL_IMAGE_COOLDOWN_MS": "10000",', '"SERIAL_IMAGE_COOLDOWN_MS": "0",')

# Update old regression expectations.
rep(
    "tests/image-production-config.test.mjs",
    "assert.equal(Number(config.vars.SERIAL_IMAGE_COOLDOWN_MS), 10000);",
    "assert.equal(Number(config.vars.SERIAL_IMAGE_COOLDOWN_MS), 0);",
)
p = Path("tests/image-repair-ui-integration.test.mjs")
t = p.read_text()
t = t.replace(
    "3-minute watchdog runs a leased KIE-first image lane with 10-second serial pacing",
    "3-minute watchdog runs a leased KIE-first image lane without fixed serial pacing",
)
t = t.replace(
    "assert.match(entry, /SERIAL_IMAGE_COOLDOWN_MS, 10_000/);",
    "assert.doesNotMatch(entry, /await sleep\\(cooldownMs\\)/);",
)
t = t.replace(
    "assert.match(entry, /SERIAL_IMAGE_CHAIN_MAX_ITEMS, 4/);",
    "assert.match(entry, /SERIAL_IMAGE_CHAIN_MAX_ITEMS, 8/);",
)
t = t.replace(
    "assert.match(entry, /maxJobs:\\s*1/);",
    "assert.match(entry, /maxJobs:\\s*maxItems/);",
)
if "assert.match(entry, /cooldownMs:\\s*0/);" not in t:
    marker = "assert.match(entry, /maxImages:\\s*1/);"
    t = t.replace(marker, marker + "\n  assert.match(entry, /cooldownMs:\\s*0/);")
p.write_text(t)

Path("tests/image-lifecycle-gallery.test.mjs").write_text(
    """import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const entry = fs.readFileSync('worker/mcp-entry.js', 'utf8');
const cards = fs.readFileSync('web/work-cards.js', 'utf8');
const routes = fs.readFileSync('api-hub-v2/src/lib/image-routes.js', 'utf8');
const executor = fs.readFileSync('worker/lib/image-executor.js', 'utf8');
const completion = fs.readFileSync('worker/lib/image-completion.js', 'utf8');
const store = fs.readFileSync('worker/lib/job-store.js', 'utf8');

test('image lane has no artificial fixed 10 second wait', () => {
  const part = entry.slice(entry.indexOf('async function runSerialImageWatchdog'), entry.indexOf('async function runLegacyMaintenance'));
  assert.match(part, /cooldownMs:\\s*0/);
  assert.match(part, /maxJobs:\\s*maxItems/);
  assert.doesNotMatch(part, /await sleep\\(cooldownMs\\)/);
  assert.match(executor, /SERIAL_IMAGE_COOLDOWN_MS \\?\\? 0/);
  assert.match(executor, /if \\(cooldownMs > 0\\) await sleep\\(cooldownMs\\)/);
});

test('generated images are visible in work detail', () => {
  assert.match(store, /_images:/);
  assert.match(cards, /result-image-gallery/);
  assert.match(cards, /QA 확인 필요/);
});

test('QA keeps rejected preview evidence', () => {
  assert.match(routes, /rejectedImageUrl/);
  assert.match(executor, /preserveRejectedPreview/);
  assert.match(executor, /rejectedPreviewUrl/);
});

test('stored accepted images are attached and persisted incrementally', () => {
  const attachAt = completion.indexOf('const attachableImages');
  const persistAt = completion.indexOf('await persistJobResult', attachAt);
  const incompleteAt = completion.indexOf('if (!verification.ok)', attachAt);
  assert.ok(attachAt >= 0);
  assert.ok(persistAt > attachAt);
  assert.ok(incompleteAt > persistAt, 'partial image progress must persist before incomplete return');
  assert.match(completion, /for \\(const image of attachableImages\\) await markImageAttached/);
  assert.match(completion, /attachedThisRun/);
});
"""
)
