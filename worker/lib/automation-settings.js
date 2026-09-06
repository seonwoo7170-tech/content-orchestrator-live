import { buildDailySlots } from './daily-plan.js';

export const DEFAULT_AUTOMATION_SETTINGS = Object.freeze({
  enabled: true,
  dailyOperationStartTime: '09:00',
  newArticlesEnabled: true,
  repairsEnabled: true,
  newArticlesPerDay: 1,
  repairsPerDay: 1,
  fixedDailyTargets: false,
  autoPublishEnabled: false,
  publishStartTime: '09:00',
  publishIntervalMinutes: 30,
  publishJitterMinutes: 5,
  maxPublishesPerDay: 2,
  imagesEnabled: true,
  bodyImageCount: 2,
  approvalMode: 'approval',
  operationMode: 'validation',
  contentLanguage: 'auto',
  timezone: 'Asia/Seoul'
});

const APPROVAL_MODES = new Set(['approval', 'auto']);
const OPERATION_MODES = new Set(['growth', 'recovery', 'validation']);
const CONTENT_LANGUAGES = new Set(['auto', 'ko', 'en']);

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function bool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error('AUTOMATION_BOOLEAN_INVALID');
  return value;
}

function integer(value, fallback, min, max, code) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(code);
  return n;
}

function time(value, fallback, code = 'PUBLISH_START_TIME_INVALID') {
  const text = String(value ?? fallback).trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new Error(code);
  return text;
}

function contentLanguage(value, fallback) {
  const language = String(value ?? fallback ?? 'auto').trim().toLowerCase();
  if (!CONTENT_LANGUAGES.has(language)) throw new Error('CONTENT_LANGUAGE_INVALID');
  return language;
}

export function resolveContentLanguage(setting = 'auto', blogLanguage = null) {
  const configured = contentLanguage(setting, 'auto');
  if (configured === 'ko' || configured === 'en') return configured;
  const locale = String(blogLanguage || '').trim().toLowerCase();
  if (locale === 'ko' || locale.startsWith('ko-') || locale.startsWith('ko_')) return 'ko';
  if (locale === 'en' || locale.startsWith('en-') || locale.startsWith('en_')) return 'en';
  return 'ko';
}

export function normalizeAutomationSettings(input = {}, base = DEFAULT_AUTOMATION_SETTINGS) {
  const settings = {
    enabled: bool(input.enabled, base.enabled),
    dailyOperationStartTime: time(input.dailyOperationStartTime, base.dailyOperationStartTime, 'DAILY_OPERATION_START_TIME_INVALID'),
    newArticlesEnabled: bool(input.newArticlesEnabled, base.newArticlesEnabled),
    repairsEnabled: bool(input.repairsEnabled, base.repairsEnabled),
    newArticlesPerDay: integer(input.newArticlesPerDay, base.newArticlesPerDay, 0, 10, 'NEW_ARTICLES_PER_DAY_INVALID'),
    repairsPerDay: integer(input.repairsPerDay, base.repairsPerDay, 0, 10, 'REPAIRS_PER_DAY_INVALID'),
    fixedDailyTargets: bool(input.fixedDailyTargets, base.fixedDailyTargets),
    autoPublishEnabled: bool(input.autoPublishEnabled, base.autoPublishEnabled),
    publishStartTime: time(input.publishStartTime, base.publishStartTime),
    publishIntervalMinutes: integer(input.publishIntervalMinutes, base.publishIntervalMinutes, 5, 720, 'PUBLISH_INTERVAL_INVALID'),
    publishJitterMinutes: integer(input.publishJitterMinutes, base.publishJitterMinutes, 0, 60, 'PUBLISH_JITTER_INVALID'),
    maxPublishesPerDay: integer(input.maxPublishesPerDay, base.maxPublishesPerDay, 0, 20, 'MAX_PUBLISHES_PER_DAY_INVALID'),
    imagesEnabled: bool(input.imagesEnabled, base.imagesEnabled),
    bodyImageCount: integer(input.bodyImageCount, base.bodyImageCount, 0, 3, 'BODY_IMAGE_COUNT_INVALID'),
    approvalMode: String(input.approvalMode ?? base.approvalMode),
    operationMode: String(input.operationMode ?? base.operationMode),
    contentLanguage: contentLanguage(input.contentLanguage, base.contentLanguage),
    timezone: String(input.timezone ?? base.timezone).trim() || 'Asia/Seoul'
  };
  if (!APPROVAL_MODES.has(settings.approvalMode)) throw new Error('APPROVAL_MODE_INVALID');
  if (!OPERATION_MODES.has(settings.operationMode)) throw new Error('OPERATION_MODE_INVALID');
  return settings;
}

function parseRow(row) {
  if (!row) return null;
  let parsed = {};
  try { parsed = JSON.parse(String(row.settings_json || '{}')); } catch { throw new Error('AUTOMATION_SETTINGS_JSON_INVALID'); }
  return {
    scopeKey: row.scope_key,
    blogId: row.blog_id || null,
    inheritGlobal: Number(row.inherit_global) !== 0,
    settings: parsed,
    updatedAt: row.updated_at || null
  };
}

async function readRows(env) {
  const result = await requireDb(env).prepare(
    `SELECT scope_key, blog_id, inherit_global, settings_json, updated_at
     FROM automation_settings ORDER BY CASE WHEN scope_key = 'global' THEN 0 ELSE 1 END, scope_key`
  ).all();
  return (result.results || []).map(parseRow);
}

export async function readAutomationSettings(env, blogs = []) {
  const rows = await readRows(env);
  const globalRow = rows.find((row) => row.scopeKey === 'global');
  const global = normalizeAutomationSettings(globalRow?.settings || {});
  const overrideMap = new Map(rows.filter((row) => row.blogId).map((row) => [String(row.blogId), row]));
  const blogSettings = (Array.isArray(blogs) ? blogs : []).map((blog) => {
    const blogId = String(blog?.blogId || '').trim();
    const row = overrideMap.get(blogId) || null;
    const inheritGlobal = row ? row.inheritGlobal : true;
    const override = row ? normalizeAutomationSettings(row.settings || {}, global) : global;
    const effective = inheritGlobal ? global : override;
    const detectedLanguage = String(blog?.language || '').trim().toLowerCase() || null;
    return {
      blogId,
      name: blog?.name || `Blog ${blogId}`,
      url: blog?.url || null,
      detectedLanguage,
      resolvedLanguage: resolveContentLanguage(effective.contentLanguage, detectedLanguage),
      inheritGlobal,
      override: row ? override : null,
      effective,
      updatedAt: row?.updatedAt || null
    };
  });
  return { global, blogs: blogSettings };
}

async function upsert(env, scopeKey, blogId, inheritGlobal, settings) {
  await requireDb(env).prepare(
    `INSERT INTO automation_settings(scope_key, blog_id, inherit_global, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(scope_key) DO UPDATE SET
       blog_id = excluded.blog_id,
       inherit_global = excluded.inherit_global,
       settings_json = excluded.settings_json,
       updated_at = datetime('now')`
  ).bind(scopeKey, blogId, inheritGlobal ? 1 : 0, JSON.stringify(settings)).run();
}

export async function saveGlobalAutomationSettings(env, input) {
  const settings = normalizeAutomationSettings(input || {});
  await upsert(env, 'global', null, false, settings);
  return settings;
}

export async function saveBlogAutomationSettings(env, blogId, input) {
  const normalizedBlogId = String(blogId || '').trim();
  if (!normalizedBlogId) throw new Error('BLOG_ID_REQUIRED');
  const current = await readAutomationSettings(env, []);
  const inheritGlobal = input?.inheritGlobal !== false;
  const settings = normalizeAutomationSettings(input?.settings || input || {}, current.global);
  await upsert(env, `blog:${normalizedBlogId}`, normalizedBlogId, inheritGlobal, settings);
  return { blogId: normalizedBlogId, inheritGlobal, settings, effective: inheritGlobal ? current.global : settings };
}

export function buildDailySlotsFromAutomation(blogs, planDate, automation) {
  const byId = new Map((automation?.blogs || []).map((item) => [String(item.blogId), item]));
  const slots = [];
  for (const blog of blogs || []) {
    const blogId = String(blog?.blogId || '').trim();
    const effective = byId.get(blogId)?.effective || automation?.global || DEFAULT_AUTOMATION_SETTINGS;
    if (!effective.enabled) continue;
    const policy = {
      newArticlesPerBlog: effective.newArticlesEnabled ? effective.newArticlesPerDay : 0,
      repairsPerBlog: effective.repairsEnabled ? effective.repairsPerDay : 0
    };
    slots.push(...buildDailySlots([blog], planDate, policy));
  }
  return slots;
}

function minutesOfDay(value) {
  const [hour, minute] = String(value).split(':').map(Number);
  return hour * 60 + minute;
}

function hhmm(totalMinutes) {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function deterministicPublishJitter(planDate, blogId, segment, maxAbsMinutes = 0) {
  const max = Math.max(0, Math.min(60, Number(maxAbsMinutes) || 0));
  if (!max) return 0;
  const width = max * 2 + 1;
  return (stableHash(`${planDate}:${blogId}:${segment}`) % width) - max;
}

export function scheduledMinuteForPublish(settings, planDate, blogId, slotNo) {
  const slot = Number(slotNo);
  if (!Number.isInteger(slot) || slot < 1) throw new Error('PUBLICATION_SLOT_INVALID');
  const interval = Number(settings?.publishIntervalMinutes || 30);
  const jitter = Number(settings?.publishJitterMinutes || 0);
  let minute = minutesOfDay(settings?.publishStartTime || '09:00');
  minute += deterministicPublishJitter(planDate, blogId, 'start', jitter);
  for (let index = 2; index <= slot; index += 1) {
    minute += interval + deterministicPublishJitter(planDate, blogId, `gap:${index}`, jitter);
  }
  return minute;
}

export function publishTimeForSlot(settings, planDate, blogId, slotNo) {
  return hhmm(scheduledMinuteForPublish(settings, planDate, blogId, slotNo));
}

export function buildAutomationPreview(automation, planDate) {
  const blogs = (automation?.blogs || []).map((item) => {
    const s = item.effective;
    const workCount = s.enabled
      ? (s.newArticlesEnabled ? s.newArticlesPerDay : 0) + (s.repairsEnabled ? s.repairsPerDay : 0)
      : 0;
    const publishCount = s.enabled && s.autoPublishEnabled && s.approvalMode === 'auto'
      ? Math.min(workCount, s.maxPublishesPerDay)
      : 0;
    const publishTimes = Array.from({ length: publishCount }, (_, index) => publishTimeForSlot(s, planDate, item.blogId, index + 1));
    return {
      blogId: item.blogId,
      name: item.name,
      inheritGlobal: item.inheritGlobal,
      operationMode: s.operationMode,
      contentLanguage: s.contentLanguage,
      detectedLanguage: item.detectedLanguage || null,
      resolvedLanguage: item.resolvedLanguage || resolveContentLanguage(s.contentLanguage, item.detectedLanguage),
      enabled: s.enabled,
      work: {
        newArticles: s.enabled && s.newArticlesEnabled ? s.newArticlesPerDay : 0,
        repairs: s.enabled && s.repairsEnabled ? s.repairsPerDay : 0,
        fixedDailyTargets: Boolean(s.fixedDailyTargets),
        imagesEnabled: s.imagesEnabled,
        bodyImageCount: s.imagesEnabled ? s.bodyImageCount : 0
      },
      publishing: {
        autoPublishEnabled: s.autoPublishEnabled,
        approvalMode: s.approvalMode,
        startTime: s.publishStartTime,
        intervalMinutes: s.publishIntervalMinutes,
        jitterMinutes: s.publishJitterMinutes,
        maxPerDay: s.maxPublishesPerDay,
        times: publishTimes
      }
    };
  });
  const global = automation?.global || DEFAULT_AUTOMATION_SETTINGS;
  return {
    planDate,
    dailyOperationStartTime: global.dailyOperationStartTime,
    timezone: global.timezone,
    blogs,
    totalWork: blogs.reduce((sum, blog) => sum + blog.work.newArticles + blog.work.repairs, 0),
    totalAutoPublishes: blogs.reduce((sum, blog) => sum + blog.publishing.times.length, 0)
  };
}
