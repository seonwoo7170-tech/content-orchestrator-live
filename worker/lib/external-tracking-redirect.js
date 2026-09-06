import { destinationWithUtm } from './external-traffic.js';

function requireDb(env) {
  if (!env?.ORCHESTRATOR_DB) throw new Error('DB_NOT_BOUND');
  return env.ORCHESTRATOR_DB;
}

function text(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function isLikelyAutomatedRequest(request) {
  const headers = request?.headers;
  const purpose = String(headers?.get?.('purpose') || headers?.get?.('sec-purpose') || '').toLowerCase();
  if (purpose.includes('prefetch') || purpose.includes('preview')) return true;
  const ua = String(headers?.get?.('user-agent') || '').toLowerCase();
  if (!ua) return false;
  return /(bot\b|crawler|spider|preview|pinterestbot|facebookexternalhit|slackbot|discordbot|telegrambot|whatsapp)/i.test(ua);
}

export async function resolveExternalTrackingDestination(env, trackingCode) {
  const asset = await requireDb(env).prepare(
    `SELECT id, job_id, channel, variant_no, destination_url
       FROM external_content_assets WHERE tracking_code=? LIMIT 1`
  ).bind(text(trackingCode, 80)).first();
  if (!asset) return null;
  return {
    assetId: Number(asset.id),
    location: destinationWithUtm(asset.destination_url, asset),
    tracked: false
  };
}
