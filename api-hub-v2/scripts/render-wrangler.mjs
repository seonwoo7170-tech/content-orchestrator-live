import { readFileSync, writeFileSync } from 'node:fs';

const source = readFileSync(new URL('../wrangler.example.jsonc', import.meta.url), 'utf8');
if (!source.includes('"ai"') || !source.includes('"binding": "AI"')) {
  throw new Error('WORKERS_AI_BINDING_MISSING');
}
if (source.includes('REPLACE_WITH_CF_AI_ACCOUNT_ID')) {
  throw new Error('LEGACY_CF_AI_ACCOUNT_PLACEHOLDER_PRESENT');
}

const setupEnabled = String(process.env.GOOGLE_OAUTH_SETUP_ENABLED || 'false') === 'true' ? 'true' : 'false';
const scopeUpgradeEnabled = String(process.env.GOOGLE_OAUTH_SCOPE_UPGRADE_ENABLED || 'false') === 'true' ? 'true' : 'false';
const bloggerWritesEnabled = String(process.env.BLOGGER_WRITES_ENABLED || 'false') === 'true' ? 'true' : 'false';
const bloggerWriteMode = String(process.env.BLOGGER_WRITE_MODE || 'disabled').trim();
const bloggerAllowedBlogIds = String(process.env.BLOGGER_WRITE_ALLOWED_BLOG_IDS || '').trim();

if (!['disabled', 'normal', 'phase1_single_draft', 'phase2_single_publish', 'phase2_single_repair', 'managed_allowlist'].includes(bloggerWriteMode)) {
  throw new Error('BLOGGER_WRITE_MODE_INVALID');
}
if (bloggerWriteMode === 'managed_allowlist') {
  if (bloggerWritesEnabled !== 'true') throw new Error('BLOGGER_MANAGED_ALLOWLIST_REQUIRES_WRITES_ENABLED');
  const ids = bloggerAllowedBlogIds.split(',').map((value) => value.trim()).filter(Boolean);
  if (!ids.length || ids.some((value) => !/^\d+$/.test(value))) throw new Error('BLOGGER_WRITE_ALLOWED_BLOG_IDS_INVALID');
}

const replacements = new Map([
  ['REPLACE_WITH_GOOGLE_OAUTH_SETUP_ENABLED', setupEnabled],
  ['REPLACE_WITH_GOOGLE_OAUTH_SCOPE_UPGRADE_ENABLED', scopeUpgradeEnabled],
  ['REPLACE_WITH_BLOGGER_WRITES_ENABLED', bloggerWritesEnabled],
  ['REPLACE_WITH_BLOGGER_WRITE_MODE', bloggerWriteMode],
  ['REPLACE_WITH_BLOGGER_WRITE_ALLOWED_BLOG_IDS', bloggerAllowedBlogIds]
]);
let rendered = source;
for (const [placeholder, value] of replacements) {
  if (!rendered.includes(placeholder)) throw new Error(`${placeholder}_MISSING`);
  rendered = rendered.replace(placeholder, value);
}
if (rendered.includes('REPLACE_WITH_GOOGLE_OAUTH_') || rendered.includes('REPLACE_WITH_BLOGGER_')) {
  throw new Error('RUNTIME_VAR_RENDER_FAILED');
}

writeFileSync(new URL('../wrangler.jsonc', import.meta.url), rendered);
console.log(`API Hub v2 wrangler.jsonc rendered with native Workers AI binding; Google OAuth setup=${setupEnabled}; scopeUpgrade=${scopeUpgradeEnabled}; Blogger writes=${bloggerWritesEnabled}; mode=${bloggerWriteMode}. No secrets printed.`);
