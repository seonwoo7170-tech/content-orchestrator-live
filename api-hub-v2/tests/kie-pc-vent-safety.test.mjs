import test from 'node:test';
import assert from 'node:assert/strict';
import { safePromptForKie } from '../src/lib/kie-image.js';

test('initial PC hardware scene keeps the requested fan and cable subject', () => {
  const prompt = safePromptForKie('A realistic editorial photograph of an open unbranded desktop computer case on a clean workbench, with one pair of hands inspecting a plain cooling fan and a sleeved cable connection.');
  assert.match(prompt, /open unbranded desktop computer case/i);
  assert.match(prompt, /cooling fan and a sleeved cable connection/i);
  assert.doesNotMatch(prompt, /cleaning brush|ventilation grille/i);
  assert.match(prompt, /Do not substitute a different troubleshooting action/i);
});

test('level 2 PC recovery keeps the requested close fan inspection', () => {
  const prompt = safePromptForKie('A realistic editorial photograph of an open unbranded desktop computer case on a clean workbench, with a person’s hands checking one plain cooling fan and one sleeved cable connection. No monitor or keyboard is visible, exposed circuit boards are minimized. Close-up view, very simple composition.');
  assert.match(prompt, /hands checking one plain cooling fan/i);
  assert.match(prompt, /Close-up view, very simple composition/i);
  assert.doesNotMatch(prompt, /cleaning brush|ventilation grille/i);
});

test('level 3 PC recovery keeps the requested fan housing close-up', () => {
  const prompt = safePromptForKie('A realistic editorial photograph in extreme tight close-up of one plain black computer cooling fan housing mounted inside a smooth unbranded metal desktop case, with one sleeved cable. All monitors, keyboards, circuit boards, stickers, labels, packaging, documents, and decorative electronics are completely out of frame.');
  assert.match(prompt, /extreme tight close-up/i);
  assert.match(prompt, /computer cooling fan housing/i);
  assert.match(prompt, /one sleeved cable/i);
  assert.doesNotMatch(prompt, /cleaning brush|ventilation grille/i);
});
