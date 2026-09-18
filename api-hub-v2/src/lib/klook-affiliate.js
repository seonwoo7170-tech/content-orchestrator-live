// Klook's affiliate program has no public product/data API for approved partners (confirmed
// via the affiliate dashboard - only a UI link converter, dynamic banners, and activity
// banners). The only documented, stable mechanism is URL templating: any www.klook.com page
// becomes a tracked affiliate link by appending "?aid=<affiliate id>". Klook's own dashboard
// copy explicitly warns that the s.klook.com short-link format is NOT tracked, so only
// www.klook.com links are ever accepted here.

function httpError(code, status = 500) {
  return Object.assign(new Error(code), { status });
}

export function klookAffiliateConfigured(env) {
  return Boolean(String(env?.KLOOK_AFFILIATE_ID || '').trim());
}

function requiredAffiliateId(env) {
  const id = String(env?.KLOOK_AFFILIATE_ID || '').trim();
  if (!id || !/^\d+$/.test(id)) throw httpError('KLOOK_AFFILIATE_ID_NOT_CONFIGURED', 503);
  return id;
}

export function buildKlookAffiliateLink(env, targetUrl) {
  const affiliateId = requiredAffiliateId(env);
  const raw = String(targetUrl || '').trim();
  if (!raw) throw httpError('KLOOK_TARGET_URL_REQUIRED', 400);

  let url;
  try { url = new URL(raw); } catch { throw httpError('KLOOK_TARGET_URL_INVALID', 400); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.klook.com') {
    // Klook's own affiliate dashboard states that the s.klook.com short-link format is not
    // tracked, so anything other than the canonical www.klook.com host is rejected rather
    // than silently producing a link that never earns commission.
    throw httpError('KLOOK_TARGET_URL_NOT_ALLOWED', 400);
  }

  url.searchParams.set('aid', affiliateId);
  return url.href;
}

