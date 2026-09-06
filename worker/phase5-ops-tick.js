import { runScheduledAutoPublish } from './entry.js';
import { runScheduledImageCompletion } from './lib/image-completion.js';
import { adoptManualReadyArticles } from './lib/manual-ready-adoption.js';

function publishParts(value = {}) {
  return {
    ok: value.ok !== false,
    attempted: Number(value.attempted || 0),
    scheduled: Number(value.scheduled || 0),
    blocked: Number(value.blocked || 0),
    outcomes: Array.isArray(value.outcomes) ? value.outcomes : []
  };
}

export function summarizePublishTick({ image = {}, publish = null, publishBefore = null, publishAfter = null } = {}) {
  const parts = publish ? [publishParts(publish)] : [publishParts(publishBefore || {}), publishParts(publishAfter || {})];
  const scheduledByJob = new Map();
  for (const part of parts) {
    for (const item of part.outcomes) {
      if (item?.status !== 'scheduled') continue;
      scheduledByJob.set(Number(item.jobId), {
        jobId: Number(item.jobId),
        status: 'scheduled',
        url: item.url || null,
        scheduledAt: item.scheduledAt || null
      });
    }
  }
  return {
    ok: image.ok !== false && parts.every((part) => part.ok),
    images: {
      attempted: Number(image.attempted || 0),
      completed: Number(image.completed || 0)
    },
    publications: {
      attempted: parts.reduce((sum, part) => sum + part.attempted, 0),
      scheduled: parts.reduce((sum, part) => sum + part.scheduled, 0),
      blocked: parts.reduce((sum, part) => sum + part.blocked, 0)
    },
    links: [...scheduledByJob.values()]
  };
}

export async function runPublishTick(env, ctx, options = {}) {
  const now = options.now || new Date();

  // Manual jobs have no daily slot by definition. Adopt only into spare slots
  // after the ordinary plan exists so they can use the same publish safety path.
  await adoptManualReadyArticles(env, { now });

  // Never make an already-ready post wait behind a slow image provider call.
  const publishBefore = await runScheduledAutoPublish(env, now);

  // Recovery workflows can request a publish-only pass so already image-complete
  // work leaves immediately without consuming another long-running provider task.
  const image = options.skipImages === true
    ? { ok: true, attempted: 0, completed: 0, items: [] }
    : await runScheduledImageCompletion(env, {
        // One KIE generation can legitimately approach the provider timeout.
        // Never batch multiple provider-bound jobs inside this synchronous request.
        maxJobs: 1,
        maxImages: 1,
        staleMinutes: 0,
        executionContext: ctx
      });

  // Anything that became image-complete in this pass can leave immediately.
  const publishAfter = await runScheduledAutoPublish(env, new Date());
  return summarizePublishTick({ image, publishBefore, publishAfter });
}
