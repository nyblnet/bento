// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// P2: the app's worker. Keeps the app's files for offline use, and answers the
// share_target POST itself (sitting E3 asks whether that works offline): the
// shared file goes into this site's Cache Storage and the app reads it from
// there. Nothing is sent anywhere.
const CACHE = 'probe-p2-v1'
const FILES = ['/', '/app.js', '/probe-common.js', '/probe.css', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()) })

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== self.location.origin) return
  if (e.request.method === 'POST' && url.pathname === '/share-target') {
    e.respondWith((async () => {
      let name = 'none'
      try {
        const form = await e.request.formData()
        const f = form.get('file')
        if (f && typeof f !== 'string') {
          name = f.name
          await (await caches.open('probe-p2-shared')).put('/shared-file', new Response(f, {
            headers: { 'content-type': 'text/html', 'x-probe-name': f.name, 'x-probe-sw-online': String(self.navigator.onLine) },
          }))
        }
      } catch { /* the page reports "nothing stored" */ }
      return Response.redirect('/?shared=1' + (name === 'none' ? '&empty=1' : ''), 303)
    })())
    return
  }
  if (e.request.method !== 'GET') return
  const key = url.pathname.replace(/\.html$/, '').replace(/^\/index$/, '/')
  if (!FILES.includes(key)) return
  e.respondWith((async () => {
    try {
      const net = await fetch(e.request)
      if (net.ok && !net.redirected) (await caches.open(CACHE)).put(key, net.clone())
      return net
    } catch {
      return (await (await caches.open(CACHE)).match(key)) || Response.error()
    }
  })())
})
