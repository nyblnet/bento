// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// P1: the frame site's own worker ("frame-site worker" mode, sitting A4). It
// keeps a copy of the frame page and its script. Online it passes requests
// through; offline it answers from the copy and marks the page as served by
// the worker, so the probe can tell which one booted.
const CACHE = 'probe-p1-frame-v1'
const FILES = ['/frame', '/frame.js']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()) })

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return
  const path = url.pathname.replace(/\.html$/, '')
  if (!FILES.includes(path)) return
  e.respondWith((async () => {
    try {
      const net = await fetch(e.request)
      if (net.ok && !net.redirected) (await caches.open(CACHE)).put(path, net.clone())
      return net
    } catch {
      const hit = await (await caches.open(CACHE)).match(path)
      if (!hit) return Response.error()
      if (path !== '/frame') return hit
      const text = (await hit.text()).replace('content="network"', 'content="frame-site worker (offline copy)"')
      return new Response(text, { status: 200, headers: hit.headers })
    }
  })())
})
