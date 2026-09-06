import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runNewArticlePipeline } from '../worker/lib/pipeline.js';
import { validateArticle } from '../worker/lib/contracts.js';
import { lintNaturalWriting } from '../worker/lib/natural-writing-linter.js';
import { buildImagePlan, attachStoredImages } from '../worker/lib/image-plan.js';
import { postprocessThumbnail } from '../worker/lib/thumbnail-postprocess.js';

const API_HUB = 'https://api-hub-v2.smileseon.workers.dev';
const ORCHESTRATOR = 'https://content-orchestrator.smileseon.workers.dev';
const TARGET_URL = 'https://www.smileinfo.net/2026/08/5.html';
const EXPECTED_BLOG_NAME = 'Smile HomeFix';
const EXPECTED_BLOG_HOST = 'www.smileinfo.net';
const ARTICLE_TOPIC = 'Low Shower Water Pressure - 5 Things to Check at Home First';
const BUCKET = 'content-orchestrator-images';
const HUB_API_KEY = String(process.env.API_HUB_V2_KEY || process.env.EXISTING_ORCHESTRATOR_KEY || '').trim();
const REQUIRED = ['DEPLOY_API_TOKEN','R2_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','GEMINI_API_KEY','KIE_API_KEY','TAVILY_API_KEY','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN'];

function fail(code) { throw new Error(code); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) fail(`COMMAND_FAILED_${command}_${result.status}`);
}
function visible(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
function isKoreanVisible(article) {
  const text = `${article?.title || ''}\n${visible(article?.html || '')}`;
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return hangul >= 12 && hangul >= latin * 0.15;
}
function isEnglishVisible(article) {
  const text = `${article?.title || ''}\n${visible(article?.html || '')}`;
  const hangul = (text.match(/[가-힣]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return hangul === 0 && latin >= 50;
}
async function callHub(path, body) {
  const r = await fetch(`${API_HUB}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-api-key': HUB_API_KEY },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) fail(`${path}_${r.status}_${data.error || 'REQUEST_FAILED'}`);
  return data;
}
async function health(url, suffix) {
  const r = await fetch(`${url}/health?check=${encodeURIComponent(suffix)}_${Date.now()}`, { cache: 'no-store' });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}
async function waitForHub(predicate, label) {
  for (let i = 0; i < 25; i += 1) {
    const h = await health(API_HUB, `${label}_${i}`);
    if (h.ok && predicate(h.data)) return h.data;
    await new Promise(r => setTimeout(r, 1500));
  }
  fail(`${label}_TIMEOUT`);
}
function deploy(configName, secretFile) {
  run('npx', ['--yes','wrangler@latest','deploy','--config',configName,'--secrets-file',secretFile], {
    cwd: 'api-hub-v2',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.DEPLOY_API_TOKEN }
  });
}
function r2Put(key, file, mime) {
  run('npx', ['--yes','wrangler@latest','r2','object','put',`${BUCKET}/${key}`,'--file',file,'--content-type',mime,'--remote'], {
    env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.R2_API_TOKEN }
  });
}
function r2Delete(key) {
  const result = spawnSync('npx', ['--yes','wrangler@latest','r2','object','delete',`${BUCKET}/${key}`,'--remote'], {
    stdio: 'inherit',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.R2_API_TOKEN }
  });
  if (result.status !== 0) console.log(`ORPHAN_DELETE_WARNING key=${key}`);
}

if (!HUB_API_KEY) fail('HUB_KEY_MISSING');
for (const name of REQUIRED) if (!String(process.env[name] || '').trim()) fail(`${name}_MISSING`);

const secretPath = 'api-hub-v2/.homefix-korean-repair-secrets.json';
const renderedPath = 'api-hub-v2/wrangler.jsonc';
const normalPath = 'api-hub-v2/wrangler.normal.jsonc';
const repairPath = 'api-hub-v2/wrangler.repair.jsonc';
let normalReady = false;
let updateSucceeded = false;
const uploaded = [];

try {
  run('node', ['api-hub-v2/scripts/render-wrangler.mjs'], { env: { ...process.env, GOOGLE_OAUTH_SETUP_ENABLED: 'false' } });
  const normal = JSON.parse(fs.readFileSync(renderedPath, 'utf8'));
  if (normal.vars?.BLOGGER_WRITES_ENABLED !== 'false' || normal.vars?.BLOGGER_WRITE_MODE !== 'disabled') fail('NORMAL_GATE_NOT_DISABLED');
  fs.writeFileSync(normalPath, JSON.stringify(normal, null, 2));
  fs.writeFileSync(secretPath, JSON.stringify({
    ORCHESTRATOR_API_KEY: HUB_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    KIE_API_KEY: process.env.KIE_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN
  }));
  fs.chmodSync(secretPath, 0o600);
  normalReady = true;
  deploy('wrangler.normal.jsonc', '.homefix-korean-repair-secrets.json');
  await waitForHub(h => h.bloggerWritesEnabled === false && h.bloggerWriteMode === 'disabled' && h.tavilyConfigured === true, 'SAFE_DISABLED_GATE');
  const orch = await health(ORCHESTRATOR, 'pre_repair');
  if (!orch.ok || orch.data.bloggerWritesEnabled !== false || orch.data.phase2Automation?.autoPublishExecutionEnabled !== false) fail('ORCHESTRATOR_NOT_SAFE');

  const blogs = await callHub('/api/blogger/blogs', { action: 'list' });
  const targetBlog = (blogs.blogs || []).find(b => {
    let host = '';
    try { host = new URL(String(b.url || '')).hostname.toLowerCase(); } catch {}
    return String(b.name || b.blogName || '') === EXPECTED_BLOG_NAME && host === EXPECTED_BLOG_HOST;
  });
  const blogId = String(targetBlog?.id || targetBlog?.blogId || '').trim();
  if (!blogId) fail('HOMEFIX_NOT_CONNECTED');
  const before = await callHub('/api/blogger/post/get', { blogId, targetUrl: TARGET_URL });
  const postId = String(before.identity?.bloggerPostId || '').trim();
  if (!postId) fail('TARGET_POST_ID_MISSING');
  if (String(before.identity?.status || '').toUpperCase() !== 'LIVE') fail('TARGET_NOT_LIVE');
  if (new URL(String(before.identity?.permalink || '')).pathname !== new URL(TARGET_URL).pathname) fail('TARGET_URL_MISMATCH');
  if (!isKoreanVisible(before.article)) fail('TARGET_NO_LONGER_KOREAN');
  console.log('TARGET_LOCKED Korean LIVE post; exact Blogger ID is not printed.');

  const env = { API_HUB_BASE_URL: API_HUB, HUB_API_KEY };
  let chosen = null;
  for (let candidate = 1; candidate <= 3; candidate += 1) {
    const result = await runNewArticlePipeline(env, { blogId, topic: ARTICLE_TOPIC, language: 'en' }, fetch, {
      onStage: async stage => console.log(`candidate=${candidate}; stage=${stage}`)
    });
    if (result.status !== 'READY') continue;
    if (result.finalCritic?.status !== 'PASS' || Number(result.finalCritic?.score || 0) < 95 || (result.finalCritic?.issues || []).length) continue;
    const article = validateArticle(result.article);
    if (article.language !== 'en' || !isEnglishVisible(article) || lintNaturalWriting(article).status === 'BLOCK') continue;
    chosen = { article, finalCritic: result.finalCritic, research: result.research || null };
    break;
  }
  if (!chosen) fail('NO_READY_ENGLISH_CANDIDATE');
  console.log(`ENGLISH_READY finalCritic=${chosen.finalCritic.score}; tavilyUsed=${Boolean(chosen.research?.used)}`);

  const plan = buildImagePlan(chosen.article, { bodyCount: 2 });
  const rows = [];
  try {
    for (let i = 0; i < plan.images.length; i += 1) {
      const image = plan.images[i];
      const prompt = `${image.prompt}\n\nSTRICT VISUAL RULE: photorealistic editorial home-maintenance image. Show only plain residential shower fixtures, water flow, plumbing hardware, hands or tools where useful, and neutral bathroom surfaces. No packaging, control panels, signs, labels, screens, display text, letters, numbers, logos, watermarks, symbols, or text-like glyphs anywhere in the generated source image.`;
      const r = await fetch(`${API_HUB}/api/hub/image/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-api-key': HUB_API_KEY },
        body: JSON.stringify({ role: image.role, providerMode: 'kie', prompt, aspectRatio: image.role === 'thumbnail' ? '16:9' : '4:3' })
      });
      const generated = await r.json().catch(() => ({}));
      if (!r.ok || generated.ok !== true) fail(`KIE_IMAGE_${i}_FAILED`);
      let bytes = Buffer.from(String(generated.imageBase64 || ''), 'base64');
      let mime = String(generated.mimeType || '').split(';')[0].trim().toLowerCase();
      let hookText = null;
      if (image.role === 'thumbnail') {
        const processed = await postprocessThumbnail(image, generated);
        bytes = Buffer.from(processed.bytes);
        mime = processed.mimeType;
        hookText = processed.hookText;
      }
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/jpeg' ? 'jpg' : '';
      if (!ext || bytes.length < 1000) fail('IMAGE_OUTPUT_INVALID');
      const localFile = `/tmp/homefix-korean-${i}.${ext}`;
      const key = `jobs/homefix-korean-repair-${process.env.GITHUB_RUN_ID || Date.now()}/${image.role}-${image.position}.${ext}`;
      fs.writeFileSync(localFile, bytes);
      r2Put(key, localFile, mime);
      const publicUrl = `${ORCHESTRATOR}/media/${key}`;
      const media = await fetch(publicUrl, { cache: 'no-store' });
      if (!media.ok) fail('R2_MEDIA_READBACK_FAILED');
      const remote = Buffer.from(await media.arrayBuffer());
      if (!remote.equals(bytes)) fail('R2_MEDIA_BYTES_MISMATCH');
      uploaded.push(key);
      rows.push({ id: 960000 + i, role: image.role, position: image.position, status: 'stored', public_url: publicUrl, alt_text: image.altText, storage_key: key, mimeType: mime, hookText });
    }
    chosen.article = validateArticle(attachStoredImages(chosen.article, rows));
    console.log(`IMAGES_READY count=${rows.length}; thumbnailHook=${rows.find(x => x.role === 'thumbnail')?.hookText || 'none'}`);
  } catch (error) {
    console.log(`IMAGE_STAGE_SKIPPED reason=${String(error.message || 'unknown')}; article will be repaired without partial image set.`);
    for (const key of uploaded.splice(0)) r2Delete(key);
    chosen.article = validateArticle(chosen.article);
  }

  const repair = structuredClone(normal);
  repair.vars.BLOGGER_WRITES_ENABLED = 'true';
  repair.vars.BLOGGER_WRITE_MODE = 'phase2_single_repair';
  repair.vars.PHASE2_SINGLE_REPAIR_BLOG_ID = blogId;
  repair.vars.PHASE2_SINGLE_REPAIR_POST_ID = postId;
  fs.writeFileSync(repairPath, JSON.stringify(repair, null, 2));
  deploy('wrangler.repair.jsonc', '.homefix-korean-repair-secrets.json');
  await waitForHub(h => h.bloggerWritesEnabled === true && h.bloggerWriteMode === 'phase2_single_repair' && h.tavilyConfigured === true, 'EXACT_REPAIR_GATE');

  const updated = await callHub('/api/blogger/post', { phase2SingleRepair: true, operation: 'update', blogId, bloggerPostId: postId, article: chosen.article });
  if (String(updated.bloggerPostId || '') !== postId) fail('POST_ID_CHANGED_DURING_REPAIR');
  updateSucceeded = true;

  const after = await callHub('/api/blogger/post/get', { blogId, bloggerPostId: postId, language: 'en' });
  if (String(after.identity?.bloggerPostId || '') !== postId) fail('READBACK_POST_ID_MISMATCH');
  if (String(after.identity?.status || '').toUpperCase() !== 'LIVE') fail('REPAIRED_POST_NOT_LIVE');
  if (new URL(String(after.identity?.permalink || '')).pathname !== new URL(TARGET_URL).pathname) fail('REPAIRED_URL_CHANGED');
  if (!isEnglishVisible(after.article)) fail('VISIBLE_LANGUAGE_NOT_ENGLISH');
  for (const row of rows) {
    if (!String(after.article?.html || '').includes(row.public_url)) fail('REPLACEMENT_IMAGE_MISSING');
    const media = await fetch(row.public_url, { cache: 'no-store' });
    if (!media.ok) fail('REPLACEMENT_IMAGE_BROKEN');
  }
  console.log(`HOMEFIX_KOREAN_REPAIR_OK title=${after.article.title}; status=LIVE; images=${rows.length}; finalCritic=${chosen.finalCritic.score}`);
  console.log(`HOMEFIX_PUBLIC_URL=${after.identity.permalink}`);
} finally {
  if (normalReady && fs.existsSync(normalPath) && fs.existsSync(secretPath)) {
    try {
      deploy('wrangler.normal.jsonc', '.homefix-korean-repair-secrets.json');
      await waitForHub(h => h.bloggerWritesEnabled === false && h.bloggerWriteMode === 'disabled' && h.tavilyConfigured === true, 'RESTORE_DISABLED_GATE');
      const orch = await health(ORCHESTRATOR, 'final_repair');
      if (!orch.ok || orch.data.bloggerWritesEnabled !== false || orch.data.phase2Automation?.autoPublishExecutionEnabled !== false) fail('FINAL_ORCHESTRATOR_NOT_SAFE');
      console.log('FINAL_SAFETY_OK APIHubWrites=OFF; OrchestratorWrites=OFF; AutoPublish=OFF; Tavily=true');
    } catch (restoreError) {
      console.error(`RESTORE_FAILURE=${String(restoreError.message || 'unknown')}`);
      process.exitCode = 1;
    }
  }
  if (!updateSucceeded) {
    for (const key of uploaded) r2Delete(key);
  } else if (uploaded.length) {
    console.log('UPDATED_POST_OWNS_REPLACEMENT_IMAGES; no R2 cleanup performed.');
  }
  for (const path of [secretPath, renderedPath, normalPath, repairPath]) {
    try { fs.unlinkSync(path); } catch {}
  }
  for (let i = 0; i < 5; i += 1) {
    try { fs.unlinkSync(`/tmp/homefix-korean-${i}.png`); } catch {}
    try { fs.unlinkSync(`/tmp/homefix-korean-${i}.webp`); } catch {}
    try { fs.unlinkSync(`/tmp/homefix-korean-${i}.jpg`); } catch {}
  }
}
