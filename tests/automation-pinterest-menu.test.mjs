import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const blogs = fs.readFileSync(new URL('../web/blogs.js', import.meta.url), 'utf8');
const shell = fs.readFileSync(new URL('../web/automation-shell.js', import.meta.url), 'utf8');
const external = fs.readFileSync(new URL('../web/external-traffic.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../web/automation.css', import.meta.url), 'utf8');
const sw = fs.readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');

test('automation loads a dedicated Pinterest submenu shell', () => {
  assert.match(blogs, /import '\.\/automation-shell\.js'/);
  assert.match(shell, /블로그 자동화/);
  assert.match(shell, /Pinterest 외부유입/);
  assert.match(shell, /data-automation-section="blog"/);
  assert.match(shell, /data-automation-section="pinterest"/);
});

test('Pinterest panel lives inside automation instead of the home dashboard', () => {
  assert.match(external, /document\.querySelector\('#automation-host'\)/);
  assert.match(external, /Pinterest 외부유입/);
  assert.doesNotMatch(external, /data-view=\\?"home/);
  assert.doesNotMatch(external, /content-strategy-panel/);
});

test('submenu toggles existing automation and Pinterest panels without changing backend routes', () => {
  assert.match(shell, /#automation-panel/);
  assert.match(shell, /#external-traffic-panel/);
  assert.match(external, /\/api\/external\/overview/);
  assert.match(external, /\/api\/external\/settings/);
  assert.match(css, /automation-subnav/);
});

test('PWA caches the complete automation and live-status module set', () => {
  assert.match(sw, /const CACHE = 'content-orchestrator-v\d+'/);
  for (const asset of ['automation-shell.js', 'automation.js', 'automation.css', 'admin-session.js', 'home-live-status.js', 'work-live-progress.js', 'live-work-progress.js', 'external-traffic.js']) {
    assert.match(sw, new RegExp(asset.replace('.', '\\.')));
  }
});