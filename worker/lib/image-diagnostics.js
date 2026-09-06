import { readAutomationSettings } from './automation-settings.js';
import { loadConnectedBlogs } from './connected-blogs.js';
import { imageProviderMode } from './image-executor.js';
import { validateImagePolicy } from './image-policy.js';

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function safeResult(value) {
  try { return JSON.parse(String(value || '')); } catch { return null; }
}

export function safeImageErrorCodes(value) {
  const allowedPrefix = /^(?:IMAGE|KIE|WORKERS_AI|CLOUDFLARE|API_HUB|R2)_[A-Z0-9_]+$/;
  const codes = String(value || '')
    .split(/[:\s]+/)
    .map((token) => token.toUpperCase().replace(/[^A-Z0-9_]+/g, '_').slice(0, 80))
    .filter((token) => allowedPrefix.test(token));
  return [...new Set(codes)].slice(0, 4);
}

function safeErrorCode(value) {
  return safeImageErrorCodes(value)[0] || null;
}

function aggregateCounts(rows, key) {
  const result = {};
  for (const row of rows || []) {
    const name = String(row?.[key] || 'unknown') || 'unknown';
    result[name] = (result[name] || 0) + Number(row?.count || 0);
  }
  return result;
}

export function readyImageState(complete, statusCounts = {}, providerStatusCounts = {}) {
  if (complete) return 'complete';
  if (Number(statusCounts.failed || 0) > 0) return 'failed';
  const providerActive = ['queued', 'queuing', 'waiting', 'pending', 'generating', 'processing', 'running', 'in_progress']
    .some((status) => Number(providerStatusCounts[status] || 0) > 0);
  if (providerActive || Number(statusCounts.generating || 0) > 0) return 'generating';
  if (Number(statusCounts.generated || 0) > 0 || Number(statusCounts.stored || 0) > 0) return 'attaching';
  if (Number(statusCounts.planned || 0) > 0) return 'planned';
  return 'waiting';
}

export async function listImageDiagnostics(env, options = {}) {
  const db = requireDb(env);
  const blogs = options.blogs || await loadConnectedBlogs(env);
  const automation = options.automation || await readAutomationSettings(env, blogs);
  const settingsByBlog = new Map((automation.blogs || []).map((item) => [String(item.blogId), item.effective || {}]));

  const [statusRows, providerRows, activeFailures, readyJobs, readyImageRows] = await Promise.all([
    db.prepare(
      `SELECT status, COUNT(*) AS count
         FROM job_images
        GROUP BY status
        ORDER BY status`
    ).all(),
    db.prepare(
      `SELECT COALESCE(NULLIF(provider, ''), 'unassigned') AS provider, COUNT(*) AS count
         FROM job_images
        WHERE status IN ('generated', 'stored', 'attached')
        GROUP BY COALESCE(NULLIF(provider, ''), 'unassigned')
        ORDER BY count DESC, provider`
    ).all(),
    db.prepare(
      `SELECT i.job_id, j.blog_id, j.mode, i.role, i.position, i.error, i.updated_at
         FROM job_images i
         JOIN jobs j ON j.id = i.job_id
        WHERE i.status = 'failed'
          AND j.archived_at IS NULL
          AND j.status <> 'completed'
        ORDER BY i.updated_at DESC, i.id DESC
        LIMIT 30`
    ).all(),
    db.prepare(
      `SELECT id, blog_id, mode, result_json, updated_at
         FROM jobs
        WHERE status = 'ready'
          AND archived_at IS NULL
          AND mode IN ('new_article', 'repair_existing')
        ORDER BY updated_at, id
        LIMIT 100`
    ).all(),
    db.prepare(
      `SELECT i.job_id,
              i.status,
              COALESCE(NULLIF(i.provider, ''), 'unassigned') AS provider,
              COALESCE(NULLIF(i.provider_status, ''), 'none') AS provider_status,
              COUNT(*) AS count
         FROM job_images i
         JOIN jobs j ON j.id = i.job_id
        WHERE j.status = 'ready'
          AND j.archived_at IS NULL
          AND j.mode IN ('new_article', 'repair_existing')
        GROUP BY i.job_id, i.status,
                 COALESCE(NULLIF(i.provider, ''), 'unassigned'),
                 COALESCE(NULLIF(i.provider_status, ''), 'none')
        ORDER BY i.job_id, i.status`
    ).all()
  ]);

  const stateByJob = new Map();
  for (const row of readyImageRows.results || []) {
    const jobId = Number(row.job_id);
    const entry = stateByJob.get(jobId) || { statusCounts: {}, providerCounts: {}, providerStatusCounts: {} };
    const status = String(row.status || 'unknown') || 'unknown';
    const provider = String(row.provider || 'unassigned') || 'unassigned';
    const providerStatus = String(row.provider_status || 'none') || 'none';
    entry.statusCounts[status] = (entry.statusCounts[status] || 0) + Number(row.count || 0);
    entry.providerCounts[provider] = (entry.providerCounts[provider] || 0) + Number(row.count || 0);
    entry.providerStatusCounts[providerStatus] = (entry.providerStatusCounts[providerStatus] || 0) + Number(row.count || 0);
    stateByJob.set(jobId, entry);
  }

  const ready = [];
  for (const row of readyJobs.results || []) {
    const result = safeResult(row.result_json);
    const settings = settingsByBlog.get(String(row.blog_id)) || { imagesEnabled: false, bodyImageCount: 0 };
    if (!result?.article) continue;
    const verification = validateImagePolicy(row.mode, result.article, settings);
    const meta = result.imagePipeline || null;
    const rowState = stateByJob.get(Number(row.id)) || { statusCounts: {}, providerCounts: {}, providerStatusCounts: {} };
    const rowProviders = Object.keys(rowState.providerCounts).filter((provider) => provider !== 'unassigned');
    const providers = [...new Set([
      ...(Array.isArray(meta?.providers) ? meta.providers : []),
      ...rowProviders
    ].map((provider) => String(provider || '').trim()).filter(Boolean))].slice(0, 4);
    ready.push({
      jobId: Number(row.id),
      blogId: String(row.blog_id || ''),
      mode: String(row.mode || ''),
      imagesEnabled: settings.imagesEnabled !== false,
      complete: verification.ok,
      current: Number(verification.currentCount ?? 0),
      target: Number(verification.policy?.targetTotal ?? 0),
      missing: Number(verification.missing ?? 0),
      imageState: readyImageState(verification.ok, rowState.statusCounts, rowState.providerStatusCounts),
      statusCounts: rowState.statusCounts,
      providerCounts: rowState.providerCounts,
      providerStatusCounts: rowState.providerStatusCounts,
      pipelineVersion: meta?.version || null,
      providers,
      updatedAt: row.updated_at || null
    });
  }

  const failures = (activeFailures.results || []).map((row) => ({
    jobId: Number(row.job_id),
    blogId: String(row.blog_id || ''),
    mode: String(row.mode || ''),
    role: String(row.role || ''),
    position: Number(row.position || 0),
    errorCode: safeErrorCode(row.error),
    errorCodes: safeImageErrorCodes(row.error),
    updatedAt: row.updated_at || null
  }));

  const missing = ready.filter((item) => item.imagesEnabled && !item.complete);
  const statusCounts = aggregateCounts(statusRows.results || [], 'status');
  const providerCounts = aggregateCounts(providerRows.results || [], 'provider');
  const attentionRequired = missing.length > 0 || failures.length > 0;
  const configuredProviderMode = imageProviderMode(env);

  return {
    ok: true,
    health: attentionRequired ? 'attention_required' : 'normal',
    pipelineVersion: 'image-pipeline-v2',
    configuredProviderMode,
    kieFallbackRequested: configuredProviderMode === 'auto' || configuredProviderMode === 'kie',
    kieConfigurationOwner: 'api_hub',
    totals: {
      imageRows: Object.values(statusCounts).reduce((sum, value) => sum + Number(value || 0), 0),
      readyJobs: ready.length,
      readyMissingImages: missing.length,
      activeImageJobs: missing.filter((item) => ['generating', 'attaching'].includes(item.imageState)).length,
      activeFailures: failures.length
    },
    statusCounts,
    providerCounts,
    ready,
    missing,
    failures
  };
}
