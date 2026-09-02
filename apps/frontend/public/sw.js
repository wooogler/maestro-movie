/*
 * Deliberately caches nothing.
 *
 * Its only job is to satisfy the installability criteria so a tablet can add the
 * booth to its home screen and launch it without browser chrome. Every request
 * goes straight to the network.
 *
 * A caching service worker would be actively harmful here: the booth is
 * redeployed between sessions, and a tablet holding a stale bundle would keep
 * running the previous build with no obvious symptom and no way for an operator
 * to tell. `skipWaiting` + `clients.claim` also mean a redeploy takes effect on
 * the next load rather than after the tab is closed.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Clear anything a previous version of this file may have cached.
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
