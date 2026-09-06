import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { runExistingRepairPipeline } from '../worker/lib/pipeline.js';
import { validateArticle, validateCriticResult } from '../worker/lib/contracts.js';
import { lintNaturalWriting } from '../worker/lib/natural-writing-linter.js';
import { buildImagePlan, attachStoredImages } from '../worker/lib/image-plan.js';
import { postprocessThumbnail } from '../worker/lib/thumbnail-postprocess.js';

const TARGET_URLS = [
  'https://www.smileinfo.net/2026/08/how-to-find-and-test-your-main-water.html',
  'https://www.smileinfo.net/2026/08/using-ai-assistants-safely-for-home.html',
  'https://www.smileinfo.net/2026/08/before-you-drill-sand-or-paint.html',
  'https://www.smileinfo.net/2026/08/blog-post_29.html',
  'https://www.smileinfo.net/2026/08/5.html',
  'https://www.smileinfo.net/2026/08/how-to-prioritize-home-repairs-when.html',
  'https://www.smileinfo.net/2026/08/how-to-stop-running-toilet-four-checks.html',
  'https://www.smileinfo.net/2026/08/how-to-find-hidden-water-leak-before.html',
  'https://www.smileinfo.net/2026/08/how-to-prepare-your-home-and-scope-bids.html'
];

const required = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

const API_HUB = required('API_HUB_V2_BASE_URL').replace(/\/$/, '');
const ORCHESTRATOR = required('ORCHESTRATOR_BASE_URL').replace(/\/$/, '');
const HUB_API_KEY = required('HUB_API_KEY');
const DEPLOY_API_TOKEN = required('DEPLOY_API_TOKEN');
const R2_API_TOKEN = required('R2_API_TOKEN');
const BUCKET_NAME = required('BUCKET_NAME');
const EXPECTED_BLOG_NAME = required('EXPECTED_BLOG_NAME');
const EXPECTED_BLOG_HOST = required('EXPECTED_BLOG_HOST').toLowerCase();
const API_HUB_DIR = path.resolve('api-hub-v2');
const NORMAL_CONFIG = path.join(API_HUB_DIR, 'wrangler.normal.jsonc');
const REPAIR_CONFIG = path.join(API_HUB_DIR, 'wrangler.batch-repair.jsonc');
const SECRET_FILE = path.join(API_HUB_DIR, '.homefix-batch-secrets.json');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'homefix-batch-v2-'));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripHtml(value = '') {
  return String(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function stripExistingMediaPreserveVisibleText(html = '') {
  let result = String(html);
  result = result.replace(/<figure\b[^>]*>([\s\S]*?)<\/figure>/gi, (_match, inner) => String(inner)
    .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<source\b[^>]*>/gi, ''));
  result = result
    .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<source\b[^>]*>/gi, '');
  return result;
}

function normalizedUrl(value) {
  const url = new URL(String(value));
  return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '');
}

async function hub(pathname, body) {
  const response = await fetch(`${API_HUB}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-api-key': HUB_API_KEY },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname}:${response.status}:${String(data.error || 'REQUEST_FAILED')}`);
  return data;
}

async function health(expectWrites = false) {
  const response = await fetch(`${API_HUB}/health?homefix_batch_v2=${Date.now()}_${Math.random()}`, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HEALTH_${response.status}`);
  if (expectWrites) {
    if (data.bloggerWritesEnabled !== true || data.bloggerWriteMode !== 'phase2_single_repair') throw new Error('REPAIR_GATE_NOT_ACTIVE');
  } else if (data.bloggerWritesEnabled !== false || data.bloggerWriteMode !== 'disabled') {
    throw new Error('BLOGGER_WRITE_GATE_NOT_OFF');
  }
  return data;
}

function runWrangler(args, token, cwd = API_HUB_DIR) {
  execFileSync('npx', ['--yes', 'wrangler@latest', ...args], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token }
  });
}

function deployConfig(configName) {
  runWrangler(['deploy', '--config', configName, '--secrets-file', path.basename(SECRET_FILE)], DEPLOY_API_TOKEN);
}

async function waitForHealth(expectWrites) {
  let last;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      last = await health(expectWrites);
      return last;
    } catch (error) {
      last = error;
      await sleep(1200);
    }
  }
  throw last instanceof Error ? last : new Error('HEALTH_PROPAGATION_TIMEOUT');
}

function activateExactRepairGate(blogId, postId) {
  const normal = JSON.parse(fs.readFileSync(NORMAL_CONFIG, 'utf8'));
  const repair = structuredClone(normal);
  repair.vars.BLOGGER_WRITES_ENABLED = 'true';
  repair.vars.BLOGGER_WRITE_MODE = 'phase2_single_repair';
  repair.vars.PHASE2_SINGLE_REPAIR_BLOG_ID = blogId;
  repair.vars.PHASE2_SINGLE_REPAIR_POST_ID = postId;
  fs.writeFileSync(REPAIR_CONFIG, JSON.stringify(repair, null, 2));
  deployConfig(path.basename(REPAIR_CONFIG));
}

function restoreDisabledGate() {
  deployConfig(path.basename(NORMAL_CONFIG));
}

function mimeExt(mimeType) {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  throw new Error(`IMAGE_MIME_UNSUPPORTED:${mime || 'missing'}`);
}

function detectedText(file) {
  const result = spawnSync('tesseract', [file, 'stdout', '--psm', '11', '-l', 'eng'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  if (result.error) throw result.error;
  const text = String(result.stdout || '').replace(/\s+/g, ' ').trim();
  const tokens = text.match(/[A-Za-z0-9]{2,}/g) || [];
  const alnum = tokens.join('').replace(/[^A-Za-z0-9]/g, '').length;
  return alnum >= 3 ? text.slice(0, 120) : '';
}

async function generateTextFreeImage(image, article, postIndex, imageIndex) {
  const strict = [
    image.prompt,
    'STRICT VISUAL RULE: Create a photorealistic editorial home-maintenance image with absolutely no readable or written text anywhere.',
    'No letters, words, numbers, labels, logos, watermarks, signs, UI, packaging text, printed instructions, numbered gauges, captions, symbols, or text-like glyphs.',
    'Avoid products or screens that normally display text; if a screen is present it must be blank, dark, turned away, or abstract with no interface.',
    'Show only the practical physical scene, tools, fixtures, hands, materials, room surfaces, or household context relevant to the article.'
  ].join('\n');

  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const generated = await hub('/api/hub/image/generate', {
        role: image.role,
        providerMode: attempt === 1 ? 'kie' : 'auto',
        prompt: `${strict}\nAttempt ${attempt}: keep every visible surface free of text-like marks.`,
        aspectRatio: image.role === 'thumbnail' ? '16:9' : '4:3'
      });
      if (generated.ok !== true || !generated.imageBase64) throw new Error(`IMAGE_GENERATION_FAILED:${image.role}:${image.position}`);

      const sourceBytes = Buffer.from(String(generated.imageBase64), 'base64');
      const sourceMime = String(generated.mimeType || '').split(';')[0].trim().toLowerCase();
      const sourceExt = mimeExt(sourceMime);
      const sourceFile = path.join(TMP, `p${postIndex}-i${imageIndex}-a${attempt}-source.${sourceExt}`);
      fs.writeFileSync(sourceFile, sourceBytes);
      const ocr = detectedText(sourceFile);
      if (ocr) {
        console.log(`IMAGE_REJECTED_TEXT post=${postIndex}; role=${image.role}; position=${image.position}; attempt=${attempt}; detectedChars=${ocr.length}`);
        lastError = new Error('IMAGE_SOURCE_TEXT_DETECTED');
        continue;
      }

      if (image.role === 'thumbnail') {
        const processed = await postprocessThumbnail(image, generated);
        const finalBytes = Buffer.from(processed.bytes);
        const finalFile = path.join(TMP, `p${postIndex}-thumbnail-${image.position}.png`);
        fs.writeFileSync(finalFile, finalBytes);
        return {
          bytes: finalBytes,
          mimeType: processed.mimeType,
          file: finalFile,
          hookText: processed.hookText,
          provider: generated.provider || generated.providerMode || 'unknown'
        };
      }

      return {
        bytes: sourceBytes,
        mimeType: sourceMime,
        file: sourceFile,
        hookText: null,
        provider: generated.provider || generated.providerMode || 'unknown'
      };
    } catch (error) {
      lastError = error;
      console.log(`IMAGE_ATTEMPT_FAILED post=${postIndex}; role=${image.role}; position=${image.position}; attempt=${attempt}; reason=${safeResult(error)}`);
      await sleep(1200 * attempt);
    }
  }
  throw new Error(`TEXT_FREE_IMAGE_NOT_OBTAINED:${image.role}:${image.position}:${safeResult(lastError)}`);
}

async function repairTextWithOuterRetries(source, postIndex) {
  let lastResult = null;
  let lastError = null;
  for (let outer = 1; outer <= 3; outer += 1) {
    try {
      console.log(`TEXT_PIPELINE_OUTER_ATTEMPT post=${postIndex}; attempt=${outer}`);
      const result = await runExistingRepairPipeline(
        { API_HUB_BASE_URL: API_HUB, HUB_API_KEY, TARGETED_REPAIR_MAX_ATTEMPTS: 3 },
        source,
        fetch,
        { onStage: async (stage) => console.log(`TEXT_STAGE post=${postIndex}; outer=${outer}; stage=${stage}`) }
      );
      lastResult = result;
      if (['READY_TO_UPDATE_EXISTING', 'NO_CHANGE_NEEDED'].includes(result.status)) return result;
      const retryableReason = String(result.reviewReason || '');
      if (!/TARGETED_REPAIR_SCOPE_VIOLATION|CRITIC_FAILED_AFTER_MAX_TARGETED_REPAIRS|NATURAL_WRITING_LINT_BLOCKED_AFTER_MAX_TARGETED_REPAIRS|TARGETED_REPAIR_EXHAUSTED/.test(retryableReason)) {
        return result;
      }
      console.log(`TEXT_PIPELINE_RETRY post=${postIndex}; attempt=${outer}; reason=${retryableReason}`);
    } catch (error) {
      lastError = error;
      if (!/REPAIR_JSON_INVALID|GEMINI_|AI_PROVIDER_|UPSTREAM|TIMEOUT|RATE_LIMIT/i.test(String(error?.message || ''))) throw error;
      console.log(`TEXT_PIPELINE_TRANSIENT_RETRY post=${postIndex}; attempt=${outer}; reason=${safeResult(error)}`);
    }
    await sleep(1400 * outer);
  }
  if (lastResult) return lastResult;
  throw lastError || new Error('TEXT_PIPELINE_RETRIES_EXHAUSTED');
}

function uploadR2(file, key, mimeType) {
  runWrangler(['r2', 'object', 'put', `${BUCKET_NAME}/${key}`, '--file', file, '--content-type', mimeType, '--remote'], R2_API_TOKEN, path.resolve('.'));
}

function deleteR2(key) {
  try {
    runWrangler(['r2', 'object', 'delete', `${BUCKET_NAME}/${key}`, '--remote'], R2_API_TOKEN, path.resolve('.'));
  } catch {
    console.log(`R2_CLEANUP_FAILED key=${key}`);
  }
}

async function verifyUploaded(file, publicUrl) {
  const response = await fetch(`${publicUrl}?verify=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`MEDIA_HTTP_${response.status}`);
  const remote = Buffer.from(await response.arrayBuffer());
  const local = fs.readFileSync(file);
  if (!remote.equals(local)) throw new Error('MEDIA_BYTES_MISMATCH');
}

function assertFinalQuality(article, critic) {
  const lint = lintNaturalWriting(article);
  if (lint.status === 'BLOCK' || (lint.blockingIssues || []).length) throw new Error('FINAL_NATURAL_WRITING_BLOCK');
  const checked = validateCriticResult(critic);
  if (checked.status !== 'PASS' || Number(checked.score || 0) < 95 || checked.issues.length !== 0) {
    throw new Error(`FINAL_CRITIC_NOT_PASS:${checked.status}:${checked.score}:${checked.issues.length}`);
  }
  if (/[가-힣]/.test(`${article.title}\n${stripHtml(article.html)}`)) throw new Error('FINAL_VISIBLE_KOREAN_FOUND');
  return { lint, critic: checked };
}

function safeResult(error) {
  return String(error?.message || error || 'UNKNOWN').replace(/[\r\n]+/g, ' ').slice(0, 240);
}

await health(false);
const blogs = await hub('/api/blogger/blogs', { action: 'list' });
const targetBlog = (blogs.blogs || []).find((blog) => {
  let host = '';
  try { host = new URL(String(blog.url || '')).hostname.toLowerCase(); } catch {}
  return String(blog.name || blog.blogName || '') === EXPECTED_BLOG_NAME && host === EXPECTED_BLOG_HOST;
});
if (!targetBlog) throw new Error('HOMEFIX_NOT_CONNECTED');
const blogId = String(targetBlog.id || targetBlog.blogId || '').trim();
if (!blogId) throw new Error('HOMEFIX_BLOG_ID_MISSING');

const sources = [];
for (const targetUrl of TARGET_URLS) {
  const source = await hub('/api/blogger/post/get', { blogId, targetUrl, language: 'en' });
  if (String(source.identity?.status || '').toUpperCase() !== 'LIVE') throw new Error(`TARGET_NOT_LIVE:${targetUrl}`);
  if (normalizedUrl(source.identity?.permalink) !== normalizedUrl(targetUrl)) throw new Error(`TARGET_URL_MISMATCH:${targetUrl}`);
  source.article.language = 'en';
  source.article.topic = source.article.title;
  sources.push(source);
}
if (sources.length !== 9) throw new Error(`HOMEFIX_TARGET_COUNT_INVALID:${sources.length}`);

fs.writeFileSync('.homefix-batch-backup.json', JSON.stringify(sources, null, 2));
fs.chmodSync('.homefix-batch-backup.json', 0o600);
console.log(`HOMEFIX_BATCH_LOCKED count=${sources.length}; all targets LIVE; Blogger writes OFF.`);

const results = [];
for (let index = 0; index < sources.length; index += 1) {
  const source = sources[index];
  const title = String(source.article.title || '');
  const postId = String(source.identity.bloggerPostId || '').trim();
  const permalink = String(source.identity.permalink || '');
  const uploadedKeys = [];
  let writeAttempted = false;
  let updateVerified = false;
  let gateActive = false;
  let beforeCriticScore = null;
  let beforeLintStatus = null;

  console.log(`HOMEFIX_REPAIR_START ${index + 1}/9 title=${JSON.stringify(title)} url=${permalink}`);
  try {
    await health(false);
    const beforeCritic = await hub('/api/hub/ai/critic', { article: source.article, stage: 'homefix_batch_before' });
    const beforeLint = lintNaturalWriting(source.article);
    beforeCriticScore = Number(beforeCritic.score || 0);
    beforeLintStatus = beforeLint.status;
    console.log(`QUALITY_BEFORE critic=${beforeCritic.status}/${beforeCritic.score}; issues=${(beforeCritic.issues || []).length}; linter=${beforeLint.status}`);

    const repaired = await repairTextWithOuterRetries(source, index + 1);
    if (!['READY_TO_UPDATE_EXISTING', 'NO_CHANGE_NEEDED'].includes(repaired.status)) {
      throw new Error(`TEXT_REPAIR_NEEDS_REVIEW:${repaired.reviewReason || 'UNKNOWN'}`);
    }

    let article = validateArticle({ ...repaired.article, language: 'en', topic: title });
    const textCritic = repaired.finalCritic || await hub('/api/hub/ai/critic', { article, stage: 'homefix_batch_text_final' });
    assertFinalQuality(article, textCritic);

    const visibleBeforeMediaStrip = stripHtml(article.html);
    const strippedHtml = stripExistingMediaPreserveVisibleText(article.html);
    const visibleAfterMediaStrip = stripHtml(strippedHtml);
    if (visibleAfterMediaStrip !== visibleBeforeMediaStrip) {
      throw new Error(`IMAGE_STRIP_CHANGED_VISIBLE_TEXT:${visibleBeforeMediaStrip.length}->${visibleAfterMediaStrip.length}`);
    }
    article = validateArticle({ ...article, html: strippedHtml });

    const bodyCount = visibleBeforeMediaStrip.length >= 8000 ? 3 : 2;
    const plan = buildImagePlan(article, { bodyCount });
    const rows = [];
    for (let imageIndex = 0; imageIndex < plan.images.length; imageIndex += 1) {
      const image = plan.images[imageIndex];
      const generated = await generateTextFreeImage(image, article, index + 1, imageIndex);
      const ext = mimeExt(generated.mimeType);
      const key = `jobs/homefix-batch-repair-v2-${process.env.GITHUB_RUN_ID || Date.now()}/post-${index + 1}/${image.role}-${image.position}.${ext}`;
      uploadR2(generated.file, key, generated.mimeType);
      uploadedKeys.push(key);
      const publicUrl = `${ORCHESTRATOR}/media/${key}`;
      await verifyUploaded(generated.file, publicUrl);
      rows.push({
        id: Number(`${Date.now()}${imageIndex}`.slice(-12)),
        role: image.role,
        position: image.position,
        status: 'stored',
        public_url: publicUrl,
        alt_text: image.altText,
        storage_key: key,
        mimeType: generated.mimeType,
        hookText: generated.hookText,
        provider: generated.provider
      });
      console.log(`IMAGE_READY post=${index + 1}; role=${image.role}; position=${image.position}; provider=${generated.provider}; hook=${JSON.stringify(generated.hookText || '')}`);
    }

    article = validateArticle(attachStoredImages(article, rows));
    if (stripHtml(article.html) !== visibleBeforeMediaStrip) throw new Error('IMAGE_ATTACH_CHANGED_VISIBLE_TEXT');
    const finalImageUrls = [...article.html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => match[1]);
    if (finalImageUrls.length !== rows.length || rows.some((row) => !finalImageUrls.includes(row.public_url))) throw new Error('FINAL_IMAGE_SET_MISMATCH');

    const finalCritic = await hub('/api/hub/ai/critic', { article, stage: 'homefix_batch_publish_final' });
    const finalQuality = assertFinalQuality(article, finalCritic);

    activateExactRepairGate(blogId, postId);
    gateActive = true;
    await waitForHealth(true);
    writeAttempted = true;
    const update = await hub('/api/blogger/post', {
      operation: 'update',
      blogId,
      bloggerPostId: postId,
      phase2SingleRepair: true,
      article
    });
    if (String(update.bloggerPostId || '') !== postId) throw new Error('UPDATED_POST_ID_MISMATCH');

    const readback = await hub('/api/blogger/post/get', { blogId, bloggerPostId: postId, language: 'en' });
    if (String(readback.identity?.bloggerPostId || '') !== postId) throw new Error('READBACK_POST_ID_MISMATCH');
    if (normalizedUrl(readback.identity?.permalink) !== normalizedUrl(permalink)) throw new Error('READBACK_URL_CHANGED');
    if (String(readback.article?.title || '') !== String(article.title || '')) throw new Error('READBACK_TITLE_MISMATCH');
    if (String(readback.article?.html || '') !== String(article.html || '')) throw new Error('READBACK_HTML_MISMATCH');
    for (const row of rows) {
      if (!String(readback.article.html).includes(row.public_url)) throw new Error('READBACK_IMAGE_URL_MISSING');
      const response = await fetch(`${row.public_url}?readback=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`READBACK_IMAGE_HTTP_${response.status}`);
    }
    updateVerified = true;

    results.push({
      title,
      url: permalink,
      ok: true,
      textStatus: repaired.status,
      repairAttempts: repaired.repairAttempts,
      criticBefore: beforeCriticScore,
      criticAfter: Number(finalQuality.critic.score || 0),
      linterBefore: beforeLintStatus,
      linterAfter: finalQuality.lint.status,
      bodyImages: bodyCount,
      totalImages: rows.length,
      thumbnailHook: rows.find((row) => row.role === 'thumbnail')?.hookText || '',
      providers: rows.map((row) => row.provider)
    });
    console.log(`HOMEFIX_REPAIR_SUCCESS ${index + 1}/9 critic=${beforeCriticScore}->${finalQuality.critic.score}; images=${rows.length}; samePostId=yes; sameUrl=yes`);
  } catch (error) {
    console.log(`HOMEFIX_REPAIR_FAILED ${index + 1}/9 reason=${safeResult(error)}; writeAttempted=${writeAttempted}; verified=${updateVerified}`);
    if (writeAttempted && !updateVerified && gateActive) {
      try {
        await hub('/api/blogger/post', {
          operation: 'update',
          blogId,
          bloggerPostId: postId,
          phase2SingleRepair: true,
          article: source.article
        });
        console.log(`ROLLBACK_SUCCESS post=${index + 1}`);
      } catch (rollbackError) {
        console.log(`ROLLBACK_FAILED post=${index + 1}; reason=${safeResult(rollbackError)}`);
      }
    }
    for (const key of uploadedKeys) deleteR2(key);
    results.push({
      title,
      url: permalink,
      ok: false,
      reason: safeResult(error),
      criticBefore: beforeCriticScore,
      linterBefore: beforeLintStatus,
      writeAttempted,
      updateVerified
    });
  } finally {
    if (gateActive) {
      try {
        restoreDisabledGate();
        await waitForHealth(false);
        console.log(`GATE_RESTORED_OFF post=${index + 1}`);
      } catch (gateError) {
        console.log(`GATE_RESTORE_FAILED post=${index + 1}; reason=${safeResult(gateError)}`);
        throw gateError;
      }
    } else {
      await health(false);
    }
  }
}

await health(false);
fs.writeFileSync('.homefix-batch-results.json', JSON.stringify(results, null, 2));
fs.chmodSync('.homefix-batch-results.json', 0o600);
const success = results.filter((item) => item.ok).length;
const failed = results.length - success;
const images = results.filter((item) => item.ok).reduce((sum, item) => sum + Number(item.totalImages || 0), 0);
console.log(`HOMEFIX_BATCH_COMPLETE success=${success}; failed=${failed}; imagesReplaced=${images}; bloggerWrites=OFF`);
for (const item of results) {
  console.log(`HOMEFIX_BATCH_RESULT ok=${item.ok}; critic=${item.criticBefore ?? 'NA'}->${item.criticAfter ?? 'NA'}; title=${JSON.stringify(item.title)}; reason=${item.reason || 'none'}`);
}
