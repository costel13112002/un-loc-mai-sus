'use strict';

const SHELL_CACHE = 'un-loc-shell-v1';
const SHARED_CACHE = 'un-loc-shared';
const SHELL_FILES = ['./', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names
        .filter((name) => name !== SHELL_CACHE && name !== SHARED_CACHE)
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

async function receiveShot(request) {
  const form = await request.formData();
  const file = form.get('shot');
  if (file) {
    const cache = await caches.open(SHARED_CACHE);
    await cache.put('shot', new Response(file));
  }
  return Response.redirect('./?shared=1', 303);
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const saved = await cache.match(request, { ignoreSearch: true });
    if (saved) return saved;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method === 'POST' && url.pathname.endsWith('/share')) {
    event.respondWith(receiveShot(event.request));
  } else if (event.request.method === 'GET') {
    event.respondWith(networkFirst(event.request));
  }
});
