const CACHE = 'jarvis-shell-v2'
const SHELL = ['/', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest']

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    await cache.addAll(SHELL)
    // Cache the production bundles on the first visit, before this worker controls the page.
    const html = await (await cache.match('/')).text()
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1])
    await cache.addAll(assets)
    for (const asset of assets.filter(path => path.endsWith('.css'))) {
      const css = await (await cache.match(asset)).text()
      const fonts = [...css.matchAll(/url\((?:["'])?(\/assets\/[^\s)"']+\.woff2)(?:["'])?\)/g)].map(match => match[1])
      await cache.addAll([...new Set(fonts)])
    }
    await self.skipWaiting()
  })())
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api')) return
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone()
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)))
    }
    return response
  }).catch(async () => (await caches.match(event.request)) || (event.request.mode === 'navigate' ? caches.match('/') : Response.error())))
})
