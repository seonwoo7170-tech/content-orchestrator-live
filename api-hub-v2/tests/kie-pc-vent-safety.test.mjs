import test from 'node:test';
import assert from 'node:assert/strict';
import { safePromptForKie } from '../src/lib/kie-image.js';

test('initial PC hardware scene is reduced to a text-safe exterior ventilation scene', () => {
  const prompt = safePromptForKie('A realistic editorial photograph of an open unbranded desktop computer case on a clean workbench, with one pair of hands inspecting a plain cooling fan and a sleeved cable connection.');
  assert.match(prompt, /matte black unbranded desktop computer side panel/i);
  assert.match(prompt, /ventilation grille/i);
  assert.match(prompt, /soft gray cleaning brush/i);
  assert.match(prompt, /No ports, cables, internal components, screens, keyboards, stickers, labels/i);
  assert.doesNotMatch(prompt, /open unbranded desktop computer case on a clean workbench, with one pair of hands inspecting/i);
});

test('level 2 PC recovery stays distinct and removes internal components', () => {
  const prompt = safePromptForKie('A realistic editorial photograph of an open unbranded desktop computer case on a clean workbench, with a person’s hands checking one plain cooling fan and one sleeved cable connection. No monitor or keyboard is visible, exposed circuit boards are minimized. Close-up view, very simple composition.');
  assert.match(prompt, /smooth matte black exterior side panel/i);
  assert.match(prompt, /rectangular ventilation grille/i);
  assert.match(prompt, /Keep all ports, cables, internal components/i);
});

test('level 3 PC recovery becomes a macro grille-only composition', () => {
  const prompt = safePromptForKie('A realistic editorial photograph in extreme tight close-up of one plain black computer cooling fan housing mounted inside a smooth unbranded metal desktop case, with one sleeved cable. All monitors, keyboards, circuit boards, stickers, labels, packaging, documents, and decorative electronics are completely out of frame.');
  assert.match(prompt, /macro editorial photograph/i);
  assert.match(prompt, /regular round ventilation holes/i);
  assert.match(prompt, /brush bristles, and two fingertips/i);
  assert.match(prompt, /No internal computer components, ports, cables/i);
});
