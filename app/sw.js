/* Catherine's Corner service worker — offline app shell.
   Bump VERSION on every deploy so clients pick up new code. */

const VERSION = 'cc-v1.4.0';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'db.js', 'backup.js', 'export.js', 'manifest.json', 'icon-180.png', 'icon-512.png', 'check.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'cc-shared-inbox' && k.startsWith('cc-')).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Share target: audio shared from another app (e.g. a voice memo) lands here,
// is parked in a cache inbox, and the app turns it into a reading.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-inbox')) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        let file = form.get('audio');
        if (!(file instanceof File)) file = [...form.values()].find(v => v instanceof File);
        if (file) {
          const cache = await caches.open('cc-shared-inbox');
          await cache.put('./__shared-audio', new Response(file, {
            headers: { 'content-type': file.type || 'application/octet-stream', 'x-name': encodeURIComponent(file.name || 'shared recording') },
          }));
        }
      } catch (err) { /* fall through to the app either way */ }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.open(VERSION).then(cache =>
      cache.match(req, { ignoreSearch: true }).then(hit => {
        const refresh = fetch(req).then(res => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => hit);
        return hit || refresh;
      })
    )
  );
});
