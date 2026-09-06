import { callHub } from './api-hub.js';
import { persistJobResult, persistJobTransition } from './job-store.js';
import { deliveryEvidenceComplete, validateBloggerReadback } from './delivery-evidence.js';
import { buildSchemaAwareDelivery } from './schema-delivery.js';

const MAX_READBACK_ATTEMPTS = 5;
const AUTHORITATIVE_PUBLICATION_STATUSES = new Set(['scheduled', 'published', 'updated']);

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function safeResult(value) {
  try { return JSON.parse(String(value || '')); } catch { return null; }
}

function positiveLimit(value, fallback = 2) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > 20) throw new Error('PUBLICATION_READBACK_LIMIT_INVALID');
  return number;
}

async function listPending(env, limit) {
  const rows = await requireDb(env).prepare(
    `SELECT p.job_id, p.blog_id, p.blogger_post_id, p.url, p.scheduled_time, p.attempts,
            p.status AS publication_status,
            j.mode, j.status AS job_status, j.result_json
       FROM job_publications p
       JOIN jobs j ON j.id = p.job_id
      WHERE p.blogger_post_id IS NOT NULL AND p.blogger_post_id <> ''
        AND j.archived_at IS NULL
        AND (
          (p.status = 'verification_pending' AND j.status IN ('publishing_new', 'updating_existing'))
          OR (j.status = 'publishing_new' AND p.status IN ('scheduled', 'published'))
          OR (j.status = 'updating_existing' AND p.status = 'updated')
        )
      ORDER BY CASE WHEN p.status = 'verification_pending' THEN 0 ELSE 1 END,
               p.updated_at ASC, p.job_id ASC
      LIMIT ?`
  ).bind(limit).all();
  return rows.results || [];
}

async function markVerified(env, row, readback) {
  const current = String(row.publication_status || '');
  const status = String(row.mode) === 'repair_existing'
    ? 'updated'
    : (current === 'published' ? 'published' : 'scheduled');
  const url = readback?.identity?.permalink || row.url || null;
  await requireDb(env).prepare(
    `UPDATE job_publications
        SET status = ?, url = ?, error = NULL, updated_at = datetime('now')
      WHERE job_id = ? AND status IN ('verification_pending', 'scheduled', 'published', 'updated')`
  ).bind(status, url, Number(row.job_id)).run();
  return { status, url };
}

async function markRetry(env, row, reason) {
  const attempts = Number(row.attempts || 0) + 1;
  const exhausted = attempts >= MAX_READBACK_ATTEMPTS;
  const current = String(row.publication_status || '');
  const code = exhausted ? 'BLOGGER_READBACK_VERIFICATION_FAILED' : 'BLOGGER_READBACK_PENDING';

  if (current === 'verification_pending') {
    const status = exhausted ? 'failed' : 'verification_pending';
    await requireDb(env).prepare(
      `UPDATE job_publications
          SET status = ?, attempts = ?, error = ?, updated_at = datetime('now')
        WHERE job_id = ? AND status = 'verification_pending'`
    ).bind(status, attempts, code, Number(row.job_id)).run();
    if (exhausted) {
      try {
        await persistJobTransition(env, row.job_id, 'failed', { error: code });
      } catch { /* publication row remains authoritative for safe manual review */ }
    }
    return { exhausted, attempts, reason: String(reason || code).slice(0, 180) };
  }

  // A publication row that is already scheduled/published/updated is authoritative
  // write evidence. Never downgrade it or issue another Blogger write just because a
  // later read-back is temporarily unavailable. Retry GET-only verification and, if
  // it remains unverifiable, move the orphaned job out of the live lane for review.
  await requireDb(env).prepare(
    `UPDATE job_publications
        SET attempts = ?, error = ?, updated_at = datetime('now')
      WHERE job_id = ? AND status = ?`
  ).bind(attempts, code, Number(row.job_id), current).run();
  if (exhausted) {
    try {
      await persistJobTransition(env, row.job_id, 'needs_review', { error: code });
    } catch { /* keep publication state untouched */ }
  }
  return { exhausted, attempts, reason: String(reason || code).slice(0, 180) };
}

export async function reconcilePendingPublicationReadbacks(env, options = {}) {
  if (!env?.ORCHESTRATOR_DB) return { ok: true, checked: 0, completed: 0, pending: 0, failed: 0, items: [] };
  const limit = positiveLimit(options.limit, 2);
  const callHubFn = options.callHubFn || callHub;
  const rows = await listPending(env, limit);
  const items = [];

  for (const row of rows) {
    const expected = { blogId: String(row.blog_id), bloggerPostId: String(row.blogger_post_id) };
    try {
      const readback = await callHubFn(
        env,
        env.HUB_BLOGGER_GET_PATH || '/api/blogger/post/get',
        expected
      );
      const check = validateBloggerReadback(expected, readback);
      if (!check.passed) {
        const retry = await markRetry(env, row, 'BLOGGER_READBACK_IDENTITY_MISMATCH');
        items.push({ jobId: Number(row.job_id), status: retry.exhausted ? 'failed' : 'pending', attempts: retry.attempts, reason: retry.reason });
        continue;
      }

      const result = safeResult(row.result_json) || {};
      const verifiedPublication = {
        ...(result.publication || {}),
        ok: true,
        blogId: String(row.blog_id),
        bloggerPostId: String(row.blogger_post_id),
        url: readback?.identity?.permalink || row.url || null,
        scheduledAt: result?.publication?.scheduledAt || row.scheduled_time || null
      };
      const schemaDelivery = buildSchemaAwareDelivery({
        mode: row.mode,
        result,
        deterministicQa: result?.qualityGates?.deterministic,
        naturalWritingStatus: result?.qualityGates?.naturalWriting?.status,
        images: result?.qualityGates?.images,
        imagesRequired: Boolean(result?.qualityGates?.images?.required),
        publication: verifiedPublication,
        readback
      });
      const legacyAuthoritative = AUTHORITATIVE_PUBLICATION_STATUSES.has(String(row.publication_status || ''));

      if (!deliveryEvidenceComplete(schemaDelivery.deliveryEvidence) && !legacyAuthoritative) {
        const nextResult = {
          ...result,
          publication: verifiedPublication,
          structuredData: schemaDelivery.structuredData,
          qualityGates: { ...(result.qualityGates || {}), schema: schemaDelivery.schema },
          deliveryEvidence: schemaDelivery.deliveryEvidence
        };
        await persistJobResult(env, row.job_id, nextResult);
        const retry = await markRetry(env, row, 'DELIVERY_EVIDENCE_INCOMPLETE');
        items.push({ jobId: Number(row.job_id), status: retry.exhausted ? 'failed' : 'pending', attempts: retry.attempts, reason: retry.reason });
        continue;
      }

      // Legacy/interrupted workers can commit the publication row before committing
      // jobs.status=completed. If the stored publication state is already authoritative
      // and exact Blogger GET confirms the same blog/post identity, completing the job
      // is safe even when older result_json lacks newer delivery-evidence fields.
      const publication = await markVerified(env, row, readback);
      const nextResult = {
        ...result,
        qualityGates: {
          ...(result.qualityGates || {}),
          schema: schemaDelivery.schema
        },
        structuredData: schemaDelivery.structuredData,
        publication: {
          ...verifiedPublication,
          url: publication.url,
          readbackVerifiedAt: new Date().toISOString()
        },
        publicationVerification: {
          status: legacyAuthoritative && !deliveryEvidenceComplete(schemaDelivery.deliveryEvidence)
            ? 'VERIFIED_LEGACY_PUBLICATION_STATE'
            : 'VERIFIED',
          checkedAt: new Date().toISOString(),
          bloggerStatus: readback?.identity?.status || null,
          recoveredFromPublicationStatus: row.publication_status || null
        },
        deliveryEvidence: schemaDelivery.deliveryEvidence
      };

      await persistJobTransition(env, row.job_id, 'completed', { result: nextResult });
      items.push({
        jobId: Number(row.job_id),
        status: 'completed',
        url: publication.url,
        recoveredFromPublicationStatus: row.publication_status || null,
        legacyEvidenceAccepted: legacyAuthoritative && !deliveryEvidenceComplete(schemaDelivery.deliveryEvidence),
        evidence: schemaDelivery.deliveryEvidence
      });
    } catch (error) {
      const retry = await markRetry(env, row, error?.message || 'BLOGGER_READBACK_FAILED');
      items.push({ jobId: Number(row.job_id), status: retry.exhausted ? 'failed' : 'pending', attempts: retry.attempts, reason: retry.reason });
    }
  }

  return {
    ok: items.every((item) => item.status !== 'failed'),
    checked: rows.length,
    completed: items.filter((item) => item.status === 'completed').length,
    pending: items.filter((item) => item.status === 'pending').length,
    failed: items.filter((item) => item.status === 'failed').length,
    items
  };
}
