import { readFileSync, writeFileSync } from 'node:fs';

const databaseId = String(process.env.D1_DATABASE_ID || '').trim();
if (!/^[0-9a-f-]{36}$/i.test(databaseId)) {
  throw new Error('D1_DATABASE_ID_INVALID');
}

const source = readFileSync('wrangler.example.jsonc', 'utf8');
if (!source.includes('REPLACE_WITH_D1_DATABASE_ID')) {
  throw new Error('D1_DATABASE_PLACEHOLDER_MISSING');
}

const rendered = source.replace('REPLACE_WITH_D1_DATABASE_ID', databaseId);
if (rendered.includes('REPLACE_WITH_D1_DATABASE_ID')) {
  throw new Error('D1_DATABASE_PLACEHOLDER_REMAINED');
}
writeFileSync('wrangler.jsonc', rendered);
console.log('wrangler.jsonc rendered without printing secrets.');
