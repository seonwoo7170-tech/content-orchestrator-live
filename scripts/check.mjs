import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const roots = ['worker', 'web', 'api-hub-adapters', 'scripts', 'tests'];
for (const file of roots.flatMap(walk)) {
  if (file.endsWith('.js') || file.endsWith('.mjs')) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log('Syntax check passed.');
