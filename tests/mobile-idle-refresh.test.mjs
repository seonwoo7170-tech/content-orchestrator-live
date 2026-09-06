import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const cards = fs.readFileSync('web/work-cards.js', 'utf8');
const live = fs.readFileSync('web/work-live-progress.js', 'utf8');
const home = fs.readFileSync('web/home-live-status.js', 'utf8');
const sw = fs.readFileSync('web/sw.js', 'utf8');

test('work-card observer cannot retrigger itself from status-pill subtree mutations', () => {
  assert.match(cards, /observe\(jobList, \{ childList: true \}\)/);
  assert.doesNotMatch(cards, /observe\(jobList, \{ childList: true, subtree: true \}\)/);
  assert.match(cards, /if \(pill\.textContent !== label\) pill\.textContent = label/);
  const enhanceStart = cards.indexOf('function enhanceCard');
  const enhanceEnd = cards.indexOf('function enhanceAll');
  const enhanceSource = cards.slice(enhanceStart, enhanceEnd);
  assert.match(enhanceSource, /if \(card\.dataset\.enhanced === 'true'\) return/);
  assert.doesNotMatch(enhanceSource, /refreshReadyCardState\(card\)/);
});

test('idle live progress is bounded to visible work view and four cards every thirty seconds', () => {
  assert.match(live, /function workViewVisible\(\)/);
  assert.match(live, /!workViewVisible\(\)/);
  assert.match(live, /filter\(shouldTrack\)\.slice\(0, 4\)/);
  assert.match(live, /setInterval\(\(\) => void refreshTrackableCards\(\), 30000\)/);
  assert.match(live, /observe\(jobList, \{ childList: true \}\)/);
  assert.doesNotMatch(live, /observe\(jobList, \{ childList: true, subtree: true \}\)/);
});

test('home status polling sleeps while home is hidden or document is backgrounded', () => {
  assert.match(home, /if \(!homeView \|\| homeView\.hidden \|\| document\.hidden\) return/);
  assert.match(home, /\[data-open-view="home"\], \[data-nav-target="home"\]/);
});

test('PWA cache replaces stale idle-loop builds while keeping live progress offline', () => {
  assert.match(sw, /const CACHE = 'content-orchestrator-v\d+'/);
  assert.match(sw, /live-work-progress\.js/);
});