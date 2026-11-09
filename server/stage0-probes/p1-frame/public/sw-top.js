// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// P1: the top page's worker. Keeps this site's own files (including its copy
// of frame.js, which the "worker-served frame" mode inlines into a srcdoc) so
// the probe opens offline. Network first, so a redeploy shows up online.
const CACHE = 'probe-p1-top-v1'
const FILES = ['/', '/top.js', '/frame.js', '/frame-url.js', '/probe-common.js', '/probe.css', '/storage', '/storage.js', '/webmcp', '/webmcp.js']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()) })

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return
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
