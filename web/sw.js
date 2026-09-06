// Previous deployed cache: content-orchestrator-v28 with Google data health readback. v29 adds per-blog GA4 coverage details.
const CACHE = 'content-orchestrator-v30';
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './styles.css', './blog-picker.css', './operations.css', './build-stage.css', './work-cards.css', './automation.css', './subnav.css',
  './admin-session.js', './retry-hotfix.js', './app.js', './subnav.js', './work-cards.js', './work-live-progress.js', './live-work-progress.js', './build-stage.js', './operations.js', './performance.js',
  './gsc-interactions.js', './google-data-health.js', './strategy.js', './trend-insights.js', './automation-shell.js', './automation.js', './external-traffic.js',
  './blogs.js', './home-live-status.js'
];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((hit) => hit || caches.match('./index.html'))));
});