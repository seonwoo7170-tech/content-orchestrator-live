import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('stored R2 image rows are selected for attachment before any paid/provider work', async () => {
  const source = await readFile(new URL('../worker/lib/image-completion.js', import.meta.url), 'utf8');
  assert.match(source, /si\.status = 'stored'/);
  assert.match(source, /WHEN has_stored_images = 1 THEN 0/);
  assert.match(source, /const storedBeforeGeneration = images\.some/);
  assert.match(source, /if \(!state\.complete && !storedBeforeGeneration\) \{/);
  assert.match(source, /const article = attachStoredImages\(result\.article, images\)/);
});
