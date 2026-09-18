import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKlookAffiliateLink, klookAffiliateConfigured } from '../src/lib/klook-affiliate.js';

const ENV = { KLOOK_AFFILIATE_ID: '135747' };

test('Klook affiliate configuration is based on a numeric affiliate id being present', () => {
  assert.equal(klookAffiliateConfigured({ KLOOK_AFFILIATE_ID: '135747' }), true);
  assert.equal(klookAffiliateConfigured({ KLOOK_AFFILIATE_ID: '' }), false);
  assert.equal(klookAffiliateConfigured({}), false);
});

test('an aid query parameter is appended to a plain www.klook.com URL', () => {
  const link = buildKlookAffiliateLink(ENV, 'https://www.klook.com/city/16-seoul-things-to-do/');
  assert.equal(link, 'https://www.klook.com/city/16-seoul-things-to-do/?aid=135747');
});

test('aid is added alongside existing query parameters instead of replacing them', () => {
  const link = buildKlookAffiliateLink(ENV, 'https://www.klook.com/activity/12345-some-tour/?lang=en');
  const url = new URL(link);
  assert.equal(url.searchParams.get('lang'), 'en');
  assert.equal(url.searchParams.get('aid'), '135747');
});

test('a pre-existing aid parameter is overwritten with ours rather than duplicated', () => {
  const link = buildKlookAffiliateLink(ENV, 'https://www.klook.com/activity/1/?aid=999');
  const url = new URL(link);
  assert.deepEqual(url.searchParams.getAll('aid'), ['135747']);
});

test('the s.klook.com short-link format is rejected because Klook does not track it', () => {
  assert.throws(
    () => buildKlookAffiliateLink(ENV, 'https://s.klook.com/abc123'),
    /KLOOK_TARGET_URL_NOT_ALLOWED/
  );
});

test('a non-Klook URL is rejected instead of producing an affiliate link to an arbitrary site', () => {
  assert.throws(
    () => buildKlookAffiliateLink(ENV, 'https://evil.example.com/?x=1'),
    /KLOOK_TARGET_URL_NOT_ALLOWED/
  );
});

test('an http (non-https) Klook URL is rejected', () => {
  assert.throws(
    () => buildKlookAffiliateLink(ENV, 'http://www.klook.com/city/16-seoul-things-to-do/'),
    /KLOOK_TARGET_URL_NOT_ALLOWED/
  );
});

test('a missing affiliate id configuration fails loudly instead of silently omitting aid', () => {
  assert.throws(
    () => buildKlookAffiliateLink({}, 'https://www.klook.com/'),
    /KLOOK_AFFILIATE_ID_NOT_CONFIGURED/
  );
});

test('an empty or malformed target URL is rejected', () => {
  assert.throws(() => buildKlookAffiliateLink(ENV, ''), /KLOOK_TARGET_URL_REQUIRED/);
  assert.throws(() => buildKlookAffiliateLink(ENV, 'not a url'), /KLOOK_TARGET_URL_INVALID/);
});
