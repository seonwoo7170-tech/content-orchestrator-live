import { classifyPinterestWriteFailure, createPinterestPin, pinterestDeliveryConfigured } from './pinterest.js';

const DEFAULT_VARIANTS = 3;
const MAX_VARIANTS = 5;
const VARIANT_GAP_MINUTES = 30;

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function text(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isKorean(value) {
  return /[가-힣]/.test(String(value || ''));
}

export function htmlToPlainText(html) {
  return text(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"), 6000);
}

function excerpt(value, max = 340) {
  const source = text(value, 6000);
  if (source.length <= max) return source;
  const slice = source.slice(0, max + 1);
  const boundaries = ['. ', '! ', '? ', '다. '].map((mark) => slice.lastIndexOf(mark));
  const boundary = Math.max(...boundaries);
  return text(boundary > max * 0.55 ? slice.slice(0, boundary + 1) : slice.slice(0, max), max);
}

function pinterestTitle(title, variantNo, korean) {
  const base = text(title, 100);
  if (variantNo === 1) return base;
  const ko = [base, `바로 써먹는 ${base}`, `${base} 체크포인트`, `${base}, 놓치기 쉬운 핵심`, `${base} 한 번에 정리`];
  const en = [base, `Practical guide: ${base}`, `${base}: quick checklist`, `${base}: key points`, `${base}, explained simply`];
  return text((korean ? ko : en)[variantNo - 1], 100);
}

function pinterestDescription(body, variantNo, korean) {
  const endings = korean
    ? ['핵심 순서와 주의점을 원문에서 확인해 보세요.', '단계별로 바로 따라 할 수 있게 정리했습니다.', '필요할 때 체크리스트처럼 확인할 수 있습니다.', '실수하기 쉬운 핵심까지 빠르게 확인해 보세요.', '처음부터 끝까지 한 번에 보는 실용 가이드입니다.']
    : ['Open the full guide for the steps and cautions.', 'A practical step-by-step guide you can use right away.', 'Use the full article as a quick checklist.', 'See the key details and common mistakes in the full guide.', 'A straightforward guide with the essential steps in one place.'];
  return text(`${excerpt(body)} ${endings[variantNo - 1]}`, 500);
}

export function transformArticleForPinterest(article, options = {}) {
  const title = text(article?.title, 180);
  if (!title) throw new Error('EXTERNAL_ARTICLE_TITLE_REQUIRED');
  const body = htmlToPlainText(article?.html || article?.content || '');
  const count = Math.max(1, Math.min(MAX_VARIANTS, Math.trunc(Number(options.variants || DEFAULT_VARIANTS)) || DEFAULT_VARIANTS));
  const korean = String(options.language || '').toLowerCase() === 'ko' || isKorean(`${title} ${body}`);
  return Array.from({ length: count }, (_, index) => {
    const variantNo = index + 1;
    return {
      variantNo,
      title: pinterestTitle(title, variantNo, korean),
      description: pinterestDescription(body, variantNo, korean),
      strategy: ['canonical', 'practical', 'checklist', 'key_points', 'simple'][index]
    };
  });
}

function hash(value) {
  let result = 2166136261;
  for (const char of String(value || '')) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

export function externalTrackingCode(jobId, channel, variantNo) {
  return `x${Number(jobId).toString(36)}${Number(variantNo).toString(36)}${hash(`${jobId}|${channel}|${variantNo}`).slice(0, 8)}`;
}

export function trackedUrl(baseUrl, code) {
  const url = new URL(String(baseUrl || 'https://content-orchestrator.smileseon.workers.dev'));
  url.pathname = `/go/${encodeURIComponent(String(code))}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function destinationWithUtm(destinationUrl, asset = {}) {
  const url = new URL(String(destinationUrl || ''));
  const jobId = Number(asset?.jobId ?? asset?.job_id ?? 0);
  const variantNo = Number(asset?.variantNo ?? asset?.variant_no ?? 0);
  url.searchParams.set('utm_source', String(asset?.channel || 'external'));
  url.searchParams.set('utm_medium', 'social');
  url.searchParams.set('utm_campaign', 'smileseon_external');
  url.searchParams.set('utm_content', `job_${jobId}_v${variantNo}`);
  return url.toString();
}

function addMinutes(value, minutes) {
  const date = new Date(value);
  const base = Number.isFinite(date.getTime()) ? date : new Date();
  return new Date(base.getTime() + Number(minutes || 0) * 60000).toISOString();
}

function parseJson(value) {
  try { return value ? JSON.parse(String(value)) : null; } catch { return null; }
}

export async function ensureDefaultExternalSettings(env, blogs = []) {
  const db = requireDb(env);
  let inserted = 0;
  for (const blog of blogs) {
    const blogId = text(blog?.blogId ?? blog?.id, 80);
    if (!blogId) continue;
    const result = await db.prepare(`INSERT OR IGNORE INTO external_channel_settings
      (blog_id, channel, content_enabled, delivery_enabled, variants_per_post, destination_id, updated_at)
      VALUES (?, 'pinterest', 1, 0, 3, NULL, datetime('now'))`).bind(blogId).run();
    inserted += Number(result?.meta?.changes || 0);
  }
  return { ok: true, inserted, blogCount: blogs.length };
}

export async function updateExternalChannelSetting(env, blogId, channel, input = {}) {
  const db = requireDb(env);
  const blog = text(blogId, 80);
  const normalizedChannel = text(channel, 40).toLowerCase();
  if (!blog) throw Object.assign(new Error('BLOG_ID_REQUIRED'), { status: 400 });
  if (normalizedChannel !== 'pinterest') throw Object.assign(new Error('EXTERNAL_CHANNEL_UNSUPPORTED'), { status: 400 });
  const variantsPerPost = Math.max(1, Math.min(MAX_VARIANTS, Math.trunc(Number(input.variantsPerPost ?? input.variants_per_post ?? DEFAULT_VARIANTS)) || DEFAULT_VARIANTS));
  const contentEnabled = input.contentEnabled === false || input.content_enabled === 0 ? 0 : 1;
  const deliveryEnabled = input.deliveryEnabled === true || input.delivery_enabled === 1 ? 1 : 0;
  const destinationId = text(input.destinationId ?? input.destination_id, 100) || null;
  if (deliveryEnabled && !destinationId) throw Object.assign(new Error('PINTEREST_BOARD_REQUIRED'), { status: 400 });
  await db.prepare(`INSERT INTO external_channel_settings
      (blog_id, channel, content_enabled, delivery_enabled, variants_per_post, destination_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(blog_id, channel) DO UPDATE SET content_enabled=excluded.content_enabled,
      delivery_enabled=excluded.delivery_enabled, variants_per_post=excluded.variants_per_post,
      destination_id=excluded.destination_id, updated_at=datetime('now')`)
    .bind(blog, normalizedChannel, contentEnabled, deliveryEnabled, variantsPerPost, destinationId).run();
  return { ok: true, blogId: blog, channel: normalizedChannel, contentEnabled: Boolean(contentEnabled), deliveryEnabled: Boolean(deliveryEnabled), variantsPerPost, destinationId };
}

async function publicationCandidates(env, limit) {
  const rows = await requireDb(env).prepare(`SELECT p.job_id, p.blog_id, p.scheduled_time, p.url, j.result_json,
      COALESCE(s.variants_per_post, 3) AS variants_per_post,
      (SELECT public_url FROM job_images i WHERE i.job_id=p.job_id AND i.role='thumbnail'
       AND i.status IN ('stored','attached') ORDER BY i.id LIMIT 1) AS image_url
      FROM job_publications p JOIN jobs j ON j.id=p.job_id
      LEFT JOIN external_channel_settings s ON s.blog_id=p.blog_id AND s.channel='pinterest'
      WHERE p.status IN ('scheduled','published') AND p.url IS NOT NULL AND p.url<>''
      AND COALESCE(s.content_enabled,1)=1 ORDER BY p.updated_at DESC LIMIT ?`)
    .bind(Math.max(1, Math.min(120, Number(limit) || 80))).all();
  return rows.results || [];
}

export async function syncExternalContentAssets(env, options = {}) {
  const db = requireDb(env);
  const rows = await publicationCandidates(env, options.limit);
  const trackingBase = env?.EXTERNAL_TRACKING_BASE_URL || 'https://content-orchestrator.smileseon.workers.dev';
  let created = 0;
  let imagesFilled = 0;
  let skipped = 0;
  for (const row of rows) {
    const article = parseJson(row.result_json)?.article;
    if (!article?.title || !article?.html) { skipped += 1; continue; }
    let destination;
    try {
      destination = new URL(String(row.url));
      if (!['http:', 'https:'].includes(destination.protocol)) throw new Error('protocol');
    } catch { skipped += 1; continue; }
    const variants = transformArticleForPinterest(article, { variants: row.variants_per_post, language: isKorean(article.title) ? 'ko' : 'en' });
    for (const variant of variants) {
      const code = externalTrackingCode(row.job_id, 'pinterest', variant.variantNo);
      const result = await db.prepare(`INSERT OR IGNORE INTO external_content_assets
        (job_id, blog_id, channel, variant_no, title, description, image_url, destination_url,
         tracked_destination_url, tracking_code, status, eligible_at, attempts, created_at, updated_at)
        VALUES (?, ?, 'pinterest', ?, ?, ?, ?, ?, ?, ?, 'ready', ?, 0, datetime('now'), datetime('now'))`)
        .bind(Number(row.job_id), String(row.blog_id), variant.variantNo, variant.title, variant.description,
          row.image_url || null, destination.toString(), trackedUrl(trackingBase, code), code,
          addMinutes(row.scheduled_time, 5 + (variant.variantNo - 1) * VARIANT_GAP_MINUTES)).run();
      created += Number(result?.meta?.changes || 0);
      if (row.image_url) {
        const fill = await db.prepare(`UPDATE external_content_assets SET image_url=?, updated_at=datetime('now')
          WHERE job_id=? AND channel='pinterest' AND variant_no=? AND image_url IS NULL AND status='ready'`)
          .bind(row.image_url, Number(row.job_id), variant.variantNo).run();
        imagesFilled += Number(fill?.meta?.changes || 0);
      }
    }
  }
  return { ok: true, publicationsScanned: rows.length, created, imagesFilled, skipped };
}

function referrerHost(request) {
  const value = request?.headers?.get?.('referer') || request?.headers?.get?.('referrer') || '';
  if (!value) return null;
  try { return text(new URL(value).hostname, 120) || null; } catch { return null; }
}

export async function resolveExternalTrackingRedirect(env, trackingCode, request) {
  const db = requireDb(env);
  const asset = await db.prepare(`SELECT id, job_id, channel, variant_no, destination_url
    FROM external_content_assets WHERE tracking_code=? LIMIT 1`).bind(text(trackingCode, 80)).first();
  if (!asset) return null;
  const location = destinationWithUtm(asset.destination_url, asset);
  await db.prepare(`INSERT INTO external_click_events (asset_id, occurred_at, referrer_host)
    VALUES (?, datetime('now'), ?)`).bind(Number(asset.id), referrerHost(request)).run();
  await db.prepare(`INSERT INTO external_performance_daily
    (asset_id, metric_date, impressions, outbound_clicks, saves, provider_source, updated_at)
    VALUES (?, date('now'), 0, 1, 0, 'local', datetime('now'))
    ON CONFLICT(asset_id, metric_date) DO UPDATE SET outbound_clicks=external_performance_daily.outbound_clicks+1,
    updated_at=datetime('now')`).bind(Number(asset.id)).run();
  return { assetId: Number(asset.id), location };
}

async function claimDueAsset(env, now) {
  const db = requireDb(env);
  const row = await db.prepare(`SELECT a.*, s.destination_id,
      COALESCE((SELECT SUM(p.outbound_clicks) FROM external_performance_daily p
        JOIN external_content_assets peer ON peer.id=p.asset_id
        WHERE peer.blog_id=a.blog_id AND peer.channel=a.channel AND peer.variant_no=a.variant_no),0) AS historical_clicks
      FROM external_content_assets a JOIN external_channel_settings s
        ON s.blog_id=a.blog_id AND s.channel=a.channel
      WHERE a.channel='pinterest' AND s.delivery_enabled=1 AND s.destination_id IS NOT NULL AND s.destination_id<>''
      AND a.image_url IS NOT NULL AND a.image_url<>'' AND a.eligible_at<=?
      AND (a.status='ready' OR (a.status='retry_wait' AND a.next_retry_at IS NOT NULL AND a.next_retry_at<=?))
      ORDER BY historical_clicks DESC, a.eligible_at, a.id LIMIT 1`)
    .bind(now.toISOString(), now.toISOString()).first();
  if (!row?.id) return null;
  const claimed = await db.prepare(`UPDATE external_content_assets SET status='claimed', attempts=attempts+1,
    error_code=NULL, updated_at=datetime('now') WHERE id=? AND status IN ('ready','retry_wait')`)
    .bind(Number(row.id)).run();
  return Number(claimed?.meta?.changes || 0) === 1 ? row : null;
}

async function deliveryFailure(env, asset, decision, now) {
  const db = requireDb(env);
  const attempt = Number(asset.attempts || 0) + 1;
  if (decision.retryable && attempt < 3) {
    const delay = [15, 60, 360][Math.min(2, attempt - 1)];
    const nextRetryAt = addMinutes(now.toISOString(), delay);
    await db.prepare(`UPDATE external_content_assets SET status='retry_wait', error_code=?, next_retry_at=?,
      updated_at=datetime('now') WHERE id=? AND status='claimed'`)
      .bind(decision.code, nextRetryAt, Number(asset.id)).run();
    return { recoveryState: 'retry_wait', nextRetryAt };
  }
  const code = decision.ambiguous ? 'PINTEREST_WRITE_AMBIGUOUS' : decision.code;
  await db.prepare(`UPDATE external_content_assets SET status='held', error_code=?, next_retry_at=NULL,
    updated_at=datetime('now') WHERE id=? AND status='claimed'`).bind(code, Number(asset.id)).run();
  return { recoveryState: 'held', nextRetryAt: null };
}

export async function runExternalDeliveryTick(env, options = {}) {
  if (env?.EXTERNAL_DISTRIBUTION_ENABLED !== 'true') {
    return { ok: true, enabled: false, reason: 'EXTERNAL_DISTRIBUTION_DISABLED', attempted: 0, published: 0, items: [] };
  }
  if (!pinterestDeliveryConfigured(env)) {
    return { ok: true, enabled: false, reason: 'PINTEREST_ACCESS_TOKEN_MISSING', attempted: 0, published: 0, items: [] };
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const maxItems = Math.max(1, Math.min(3, Number(options.maxItems || 1)));
  const items = [];
  for (let index = 0; index < maxItems; index += 1) {
    const asset = await claimDueAsset(env, now);
    if (!asset) break;
    try {
      const result = await (options.createPinFn || createPinterestPin)(env, {
        title: asset.title,
        description: asset.description,
        imageUrl: asset.image_url,
        trackedDestinationUrl: asset.tracked_destination_url
      }, { destinationId: asset.destination_id }, options.fetchImpl || fetch);
      await requireDb(env).prepare(`UPDATE external_content_assets SET status='published', provider_content_id=?,
        error_code=NULL, next_retry_at=NULL, published_at=datetime('now'), updated_at=datetime('now')
        WHERE id=? AND status='claimed'`).bind(String(result.pinId), Number(asset.id)).run();
      items.push({ assetId: Number(asset.id), status: 'published', providerContentId: result.pinId });
    } catch (error) {
      const decision = classifyPinterestWriteFailure({ status: error?.status, error });
      const recovery = await deliveryFailure(env, asset, decision, now);
      items.push({ assetId: Number(asset.id), status: 'failed', code: decision.code, ...recovery });
    }
  }
  return { ok: true, enabled: true, attempted: items.length,
    published: items.filter((item) => item.status === 'published').length,
    failed: items.filter((item) => item.status === 'failed').length, items };
}

export async function listExternalTrafficOverview(env, options = {}) {
  const db = requireDb(env);
  const blogId = text(options.blogId, 80);
  const limit = Math.max(1, Math.min(100, Number(options.limit || 50)));
  const settingsSql = `SELECT blog_id, channel, content_enabled, delivery_enabled, variants_per_post, destination_id, updated_at
    FROM external_channel_settings${blogId ? ' WHERE blog_id=?' : ''} ORDER BY blog_id, channel`;
  const settings = blogId ? await db.prepare(settingsSql).bind(blogId).all() : await db.prepare(settingsSql).all();
  const assetsSql = `SELECT a.id, a.job_id, a.blog_id, a.channel, a.variant_no, a.title, a.image_url,
    a.tracked_destination_url, a.status, a.eligible_at, a.attempts, a.next_retry_at, a.provider_content_id,
    a.error_code, a.published_at, a.created_at, COALESCE(SUM(p.impressions),0) AS impressions,
    COALESCE(SUM(p.outbound_clicks),0) AS outbound_clicks, COALESCE(SUM(p.saves),0) AS saves
    FROM external_content_assets a LEFT JOIN external_performance_daily p ON p.asset_id=a.id
    ${blogId ? 'WHERE a.blog_id=?' : ''} GROUP BY a.id ORDER BY a.created_at DESC, a.id DESC LIMIT ?`;
  const assets = blogId ? await db.prepare(assetsSql).bind(blogId, limit).all() : await db.prepare(assetsSql).bind(limit).all();
  const rows = assets.results || [];
  const status = rows.reduce((acc, row) => { const key = String(row.status); acc[key] = (acc[key] || 0) + 1; return acc; }, {});
  const bestAssets = [...rows].sort((a, b) => Number(b.outbound_clicks || 0) - Number(a.outbound_clicks || 0)
    || Number(b.saves || 0) - Number(a.saves || 0)).slice(0, 10);
  return {
    ok: true,
    deliveryGateEnabled: env?.EXTERNAL_DISTRIBUTION_ENABLED === 'true',
    pinterestConfigured: pinterestDeliveryConfigured(env),
    settings: settings.results || [], assets: rows, bestAssets,
    summary: { total: rows.length, status, trackedClicks: rows.reduce((sum, row) => sum + Number(row.outbound_clicks || 0), 0),
      published: rows.filter((row) => row.status === 'published').length,
      ready: rows.filter((row) => row.status === 'ready').length,
      waitingForImage: rows.filter((row) => row.status === 'ready' && !row.image_url).length }
  };
}

export async function ingestExternalPerformance(env, input = {}) {
  const assetId = Number(input.assetId);
  if (!Number.isInteger(assetId) || assetId <= 0) throw Object.assign(new Error('EXTERNAL_ASSET_ID_INVALID'), { status: 400 });
  const metricDate = text(input.metricDate, 20) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(metricDate)) throw Object.assign(new Error('EXTERNAL_METRIC_DATE_INVALID'), { status: 400 });
  const impressions = Math.max(0, Math.trunc(Number(input.impressions || 0)));
  const outboundClicks = Math.max(0, Math.trunc(Number(input.outboundClicks ?? input.outbound_clicks ?? 0)));
  const saves = Math.max(0, Math.trunc(Number(input.saves || 0)));
  await requireDb(env).prepare(`INSERT INTO external_performance_daily
    (asset_id, metric_date, impressions, outbound_clicks, saves, provider_source, updated_at)
    VALUES (?, ?, ?, ?, ?, 'provider', datetime('now'))
    ON CONFLICT(asset_id, metric_date) DO UPDATE SET impressions=MAX(external_performance_daily.impressions, excluded.impressions),
    outbound_clicks=MAX(external_performance_daily.outbound_clicks, excluded.outbound_clicks),
    saves=MAX(external_performance_daily.saves, excluded.saves), provider_source='provider', updated_at=datetime('now')`)
    .bind(assetId, metricDate, impressions, outboundClicks, saves).run();
  return { ok: true, assetId, metricDate, impressions, outboundClicks, saves };
}
