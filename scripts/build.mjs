import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { MASTER_V45_SHA256 } from '../worker/lib/contracts.js';

const manifest = JSON.parse(readFileSync('prompts/master-v4.5.integrity.json', 'utf8'));
if (manifest.sha256 !== MASTER_V45_SHA256) throw new Error('MASTER_V45_MANIFEST_HASH_MISMATCH');

const promptPath = 'prompts/universal_blog_master_prompt_ko_en_verified_v4_5_final.md';
if (existsSync(promptPath)) {
  const digest = createHash('sha256').update(readFileSync(promptPath)).digest('hex');
  if (digest !== MASTER_V45_SHA256) throw new Error(`MASTER_V45_HASH_MISMATCH: ${digest}`);
  console.log(`Master v4.5 source verified: ${digest}`);
} else {
  console.log(`Master v4.5 runtime pin verified from manifest: ${MASTER_V45_SHA256}`);
}

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/web', { recursive: true });
cpSync('web', 'dist/web', { recursive: true });
cpSync('worker', 'dist/worker', { recursive: true });
console.log('Build complete.');
