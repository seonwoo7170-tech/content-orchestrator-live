import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runExistingRepairPipeline } from '../worker/lib/pipeline.js';
import { validateArticle, validateCriticResult } from '../worker/lib/contracts.js';
import { lintNaturalWriting } from '../worker/lib/natural-writing-linter.js';

const required = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

const API_HUB = required('API_HUB_V2_BASE_URL').replace(/\/$/, '');
const ORCHESTRATOR = required('ORCHESTRATOR_BASE_URL').replace(/\/$/, '');
const HUB_API_KEY = required('HUB_API_KEY');
const DEPLOY_API_TOKEN = required('DEPLOY_API_TOKEN');
const GOOGLE_CLIENT_ID = required('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = required('GOOGLE_CLIENT_SECRET');
const GOOGLE_REFRESH_TOKEN = required('GOOGLE_REFRESH_TOKEN');
const EXPECTED_BLOG_NAME = required('EXPECTED_BLOG_NAME');
const EXPECTED_BLOG_HOST = required('EXPECTED_BLOG_HOST').toLowerCase();
const MAX_REPAIRS = Math.min(2, Math.max(0, Number.parseInt(process.env.MAX_REPAIRS || '2', 10) || 0));
const API_HUB_DIR = path.resolve('api-hub-v2');
const NORMAL_CONFIG = path.join(API_HUB_DIR, 'wrangler.normal.jsonc');
const REPAIR_CONFIG = path.join(API_HUB_DIR, 'wrangler.quality-repair.jsonc');
const SECRET_FILE = path.join(API_HUB_DIR, '.homefix-quality-secrets.json');

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

function normalizedUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return String(value || '').trim().replace(/\/$/, '');
  }
}

function imageSources(html = '') {
  return [...String(html).matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)]
    .map((match) => String(match[1] || '').trim())
    .filter(Boolean)
    .sort();
}

function metrics(article) {
  const html = String(article.html || '');
  const text = stripHtml(html);
  return {
    visibleChars: text.length,
    wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0,
    h2Count: (html.match(/<h2\b/gi) || []).length,
    h3Count: (html.match(/<h3\b/gi) || []).length,
    imageCount: imageSources(html).length,
    linkCount: (html.match(/<a\b[^>]*\bhref=/gi) || []).length,
    hasVisibleKorean: /[가-힣]/.test(`${article.title || ''}\n${text}`)
  };
}

function safeResult(error) {
  return String(error?.message || error || 'UNKNOWN').replace(/[\r\n]+/g, ' ').slice(0, 260);
}

async function hub(pathname, body, retries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(`${API_HUB}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-api-key': HUB_API_KEY },
        body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(`${pathname}:${response.status}:${String(data.error || 'REQUEST_FAILED')}`);
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const retryable = [429, 500, 502, 503, 504].includes(status) || /TIMEOUT|RATE_LIMIT|UPSTREAM|GEMINI|AI_PROVIDER/i.test(String(error?.message || ''));
      if (!retryable || attempt >= retries) throw error;
      await sleep(1600 * (attempt + 1));
    }
  }
  throw lastError || new Error('HUB_REQUEST_FAILED');
}

async function health(expectWrites = false) {
  const [hubResponse, orchResponse] = await Promise.all([
    fetch(`${API_HUB}/health?quality=${Date.now()}_${Math.random()}`, { cache: 'no-store' }),
    fetch(`${ORCHESTRATOR}/health?quality=${Date.now()}_${Math.random()}`, { cache: 'no-store' })
  ]);
  const [hubData, orchData] = await Promise.all([
    hubResponse.json().catch(() => ({})),
    orchResponse.json().catch(() => ({}))
  ]);
  if (!hubResponse.ok || !orchResponse.ok) throw new Error('HEALTH_REQUEST_FAILED');
  if (orchData.bloggerWritesEnabled !== false || orchData.phase2Automation?.autoPublishExecutionEnabled !== false) {
    throw new Error('ORCHESTRATOR_WRITE_GATE_NOT_OFF');
  }
  if (expectWrites) {
    if (hubData.bloggerWritesEnabled !== true || hubData.bloggerWriteMode !== 'phase2_single_repair') throw new Error('REPAIR_GATE_NOT_ACTIVE');
  } else if (hubData.bloggerWritesEnabled !== false || hubData.bloggerWriteMode !== 'disabled') {
    throw new Error('BLOGGER_WRITE_GATE_NOT_OFF');
  }
  return { hub: hubData, orchestrator: orchData };
}

function runWrangler(args) {
  execFileSync('npx', ['--yes', 'wrangler@latest', ...args], {
    cwd: API_HUB_DIR,
    stdio: 'inherit',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: DEPLOY_API_TOKEN }
  });
}

function deployConfig(configPath) {
  runWrangler(['deploy', '--config', path.basename(configPath), '--secrets-file', path.basename(SECRET_FILE)]);
}

async function waitForHealth(expectWrites) {
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      return await health(expectWrites);
    } catch (error) {
      lastError = error;
      await sleep(1200);
    }
  }
  throw lastError || new Error('HEALTH_PROPAGATION_TIMEOUT');
}

function activateExactRepairGate(blogId, postId) {
  const normal = JSON.parse(fs.readFileSync(NORMAL_CONFIG, 'utf8'));
  const repair = structuredClone(normal);
  repair.vars.BLOGGER_WRITES_ENABLED = 'true';
  repair.vars.BLOGGER_WRITE_MODE = 'phase2_single_repair';
  repair.vars.PHASE2_SINGLE_REPAIR_BLOG_ID = String(blogId);
  repair.vars.PHASE2_SINGLE_REPAIR_POST_ID = String(postId);
  fs.writeFileSync(REPAIR_CONFIG, JSON.stringify(repair, null, 2));
  deployConfig(REPAIR_CONFIG);
}

function restoreDisabledGate() {
  deployConfig(NORMAL_CONFIG);
}

async function googleAccessToken() {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error('GOOGLE_TOKEN_EXCHANGE_FAILED');
  return data.access_token;
}

async function google(pathname, token) {
  const response = await fetch(`https://www.googleapis.com/blogger/v3${pathname}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`BLOGGER_READ_${response.status}`);
  return data;
}

async function listLivePosts() {
  const token = await googleAccessToken();
  const blogs = await google('/users/self/blogs?fetchUserInfo=false', token);
  const blog = (blogs.items || []).find((item) => {
    let host = '';
    try { host = new URL(String(item.url || '')).hostname.toLowerCase(); } catch {}
    return String(item.name || '') === EXPECTED_BLOG_NAME && host === EXPECTED_BLOG_HOST;
  });
  if (!blog?.id) throw new Error('HOMEFIX_NOT_FOUND');

  const posts = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({
      fetchBodies: 'true',
      maxResults: '50',
      status: 'live',
      view: 'ADMIN',
      orderBy: 'published'
    });
    if (pageToken) query.set('pageToken', pageToken);
    const page = await google(`/blogs/${encodeURIComponent(blog.id)}/posts?${query}`, token);
    posts.push(...(page.items || []));
    pageToken = String(page.nextPageToken || '');
  } while (pageToken);

  posts.sort((a, b) => String(a.published || '').localeCompare(String(b.published || '')));
  return { blogId: String(blog.id), posts };
}

function toArticle(post) {
  const html = String(post.content || '');
  const fallbackDescription = stripHtml(post.title || '') || 'HomeFix article';
  return validateArticle({
    title: String(post.title || ''),
    html,
    searchDescription: fallbackDescription.slice(0, 160),
    labels: Array.isArray(post.labels) ? post.labels : [],
    sources: [],
    language: 'en',
    topic: String(post.title || '')
  });
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

await health(false);
const { blogId, posts } = await listLivePosts();
if (!posts.length) throw new Error('HOMEFIX_NO_LIVE_POSTS');
console.log(`HOMEFIX_QUALITY_AUDIT_START total=${posts.length}; maxRepairs=${MAX_REPAIRS}; writes=OFF`);

const audits = [];
for (let index = 0; index < posts.length; index += 1) {
  const post = posts[index];
  const article = toArticle(post);
  const lint = lintNaturalWriting(article);
  const articleMetrics = metrics(article);
  let critic = null;
  let auditError = null;
  try {
    critic = validateCriticResult(await hub('/api/hub/ai/critic', {
      article,
      stage: 'homefix_quality_audit',
      sourcePost: {
        blogId,
        bloggerPostId: String(post.id || ''),
        permalink: String(post.url || '')
      }
    }, 2));
  } catch (error) {
    auditError = safeResult(error);
  }

  const needsRepair = !auditError && (
    lint.status === 'BLOCK' ||
    articleMetrics.hasVisibleKorean ||
    critic?.status === 'FAIL' ||
    Number(critic?.score || 0) < 95
  );
  const item = {
    index: index + 1,
    bloggerPostId: String(post.id || ''),
    title: String(post.title || '').replace(/\s+/g, ' ').trim(),
    url: String(post.url || '').trim(),
    published: String(post.published || ''),
    updated: String(post.updated || ''),
    metrics: articleMetrics,
    lintStatus: lint.status,
    lintBlockingIssues: (lint.blockingIssues || []).map((issue) => ({ code: issue.code, location: issue.location, reason: issue.reason })),
    criticStatus: critic?.status || null,
    criticScore: critic ? Number(critic.score || 0) : null,
    criticIssues: (critic?.issues || []).map((issue) => ({ code: issue.code, severity: issue.severity, location: issue.location, reason: issue.reason })),
    auditError,
    needsRepair
  };
  audits.push(item);
  console.log(`AUDIT ${index + 1}/${posts.length} repair=${needsRepair}; critic=${item.criticStatus || 'ERR'}/${item.criticScore ?? 'NA'}; lint=${item.lintStatus}; words=${articleMetrics.wordCount}; images=${articleMetrics.imageCount}; title=${JSON.stringify(item.title)}`);
  await sleep(1200);
}

fs.writeFileSync('.homefix-quality-audit.json', JSON.stringify(audits, null, 2));
fs.chmodSync('.homefix-quality-audit.json', 0o600);

const candidates = audits.filter((item) => item.needsRepair).slice(0, MAX_REPAIRS);
console.log(`HOMEFIX_QUALITY_AUDIT_COMPLETE candidates=${audits.filter((item) => item.needsRepair).length}; selected=${candidates.length}`);

const results = [];
for (const candidate of candidates) {
  const postId = candidate.bloggerPostId;
  let gateActive = false;
  let writeAttempted = false;
  let verified = false;
  let source = null;
  console.log(`HOMEFIX_REPAIR_START published=${candidate.published.slice(0, 10)} title=${JSON.stringify(candidate.title)}`);

  try {
    await health(false);
    source = await hub('/api/blogger/post/get', { blogId, bloggerPostId: postId, language: 'en' }, 1);
    if (String(source.identity?.status || '').toUpperCase() !== 'LIVE') throw new Error('TARGET_NOT_LIVE');
    if (normalizedUrl(source.identity?.permalink) !== normalizedUrl(candidate.url)) throw new Error('TARGET_URL_MISMATCH');
    source.article.language = 'en';
    source.article.topic = source.article.title;
    const beforeArticle = validateArticle(source.article);
    const beforeImages = imageSources(beforeArticle.html);

    const repaired = await runExistingRepairPipeline(
      { API_HUB_BASE_URL: API_HUB, HUB_API_KEY, TARGETED_REPAIR_MAX_ATTEMPTS: 3 },
      source,
      fetch,
      { onStage: async (stage) => console.log(`REPAIR_STAGE post=${postId}; stage=${stage}`) }
    );

    if (repaired.status === 'NO_CHANGE_NEEDED') {
      results.push({ title: candidate.title, url: candidate.url, ok: true, action: 'no_change_needed', repairAttempts: 0 });
      console.log(`HOMEFIX_REPAIR_NO_CHANGE title=${JSON.stringify(candidate.title)}`);
      continue;
    }
    if (repaired.status !== 'READY_TO_UPDATE_EXISTING') throw new Error(`TEXT_REPAIR_NEEDS_REVIEW:${repaired.reviewReason || 'UNKNOWN'}`);

    const article = validateArticle({ ...repaired.article, language: 'en', topic: repaired.article.topic || beforeArticle.topic });
    const afterImages = imageSources(article.html);
    if (JSON.stringify(afterImages) !== JSON.stringify(beforeImages)) throw new Error('EXISTING_IMAGE_SET_CHANGED');
    const quality = assertFinalQuality(article, repaired.finalCritic || await hub('/api/hub/ai/critic', { article, stage: 'homefix_quality_final' }, 2));

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
    }, 0);
    if (String(update.bloggerPostId || '') !== postId) throw new Error('UPDATED_POST_ID_MISMATCH');

    const readback = await hub('/api/blogger/post/get', { blogId, bloggerPostId: postId, language: 'en' }, 1);
    if (String(readback.identity?.bloggerPostId || '') !== postId) throw new Error('READBACK_POST_ID_MISMATCH');
    if (normalizedUrl(readback.identity?.permalink) !== normalizedUrl(candidate.url)) throw new Error('READBACK_URL_CHANGED');
    if (String(readback.article?.title || '') !== String(article.title || '')) throw new Error('READBACK_TITLE_MISMATCH');
    if (String(readback.article?.html || '') !== String(article.html || '')) throw new Error('READBACK_HTML_MISMATCH');
    if (JSON.stringify(imageSources(readback.article.html)) !== JSON.stringify(beforeImages)) throw new Error('READBACK_IMAGE_SET_CHANGED');
    verified = true;

    results.push({
      title: candidate.title,
      url: candidate.url,
      ok: true,
      action: 'updated',
      criticBefore: candidate.criticScore,
      criticAfter: Number(quality.critic.score || 0),
      lintBefore: candidate.lintStatus,
      lintAfter: quality.lint.status,
      repairAttempts: repaired.repairAttempts,
      imagesPreserved: beforeImages.length
    });
    console.log(`HOMEFIX_REPAIR_SUCCESS critic=${candidate.criticScore}->${quality.critic.score}; imagesPreserved=${beforeImages.length}; title=${JSON.stringify(candidate.title)}`);
  } catch (error) {
    console.log(`HOMEFIX_REPAIR_FAILED title=${JSON.stringify(candidate.title)}; reason=${safeResult(error)}; writeAttempted=${writeAttempted}; verified=${verified}`);
    if (writeAttempted && !verified && gateActive && source?.article) {
      try {
        await hub('/api/blogger/post', {
          operation: 'update',
          blogId,
          bloggerPostId: postId,
          phase2SingleRepair: true,
          article: source.article
        }, 0);
        console.log(`ROLLBACK_SUCCESS post=${postId}`);
      } catch (rollbackError) {
        console.log(`ROLLBACK_FAILED post=${postId}; reason=${safeResult(rollbackError)}`);
      }
    }
    results.push({ title: candidate.title, url: candidate.url, ok: false, action: 'failed', reason: safeResult(error), writeAttempted, verified });
  } finally {
    if (gateActive) {
      restoreDisabledGate();
      await waitForHealth(false);
      console.log(`GATE_RESTORED_OFF post=${postId}`);
    } else {
      await health(false);
    }
  }
}

await health(false);
fs.writeFileSync('.homefix-quality-repair-results.json', JSON.stringify(results, null, 2));
fs.chmodSync('.homefix-quality-repair-results.json', 0o600);
const updated = results.filter((item) => item.ok && item.action === 'updated').length;
const unchanged = results.filter((item) => item.ok && item.action === 'no_change_needed').length;
const failed = results.filter((item) => !item.ok).length;
console.log(`HOMEFIX_QUALITY_REPAIR_COMPLETE audited=${audits.length}; candidates=${audits.filter((item) => item.needsRepair).length}; updated=${updated}; unchanged=${unchanged}; failed=${failed}; bloggerWrites=OFF; autoPublish=OFF`);
