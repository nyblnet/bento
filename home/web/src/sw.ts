// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/home in your browser: the library's service worker, so a returning
// visit opens offline. It runs on the LIBRARY origin only; the frame site has
// `worker-src 'none'` and never gets one.
//
// It does one thing: keep the library's own files, exactly the ones the build
// listed below with their sha256, and serve them when the network cannot.
//
//   - The list is compiled into this script. Nothing a page says can add a
//     URL, bytes or code: there is no message listener.
//   - Each file is fetched once at install and cached only if it hashes to its
//     pin; one mismatch and the install fails, so nothing is cached.
//   - Network first: online, every listed path comes from the server as if
//     there were no worker, so a fixed deploy (or a withdrawn build's
//     replacement) wins on the next online visit. The cache answers only when
//     the network fails.
//   - Every other request (the release channel, the frame site, any other
//     path) is left alone: no respondWith, never cached. Documents never pass
//     through here: they are read from the person's device, never fetched.
//   - The cache's name is the build's content hash; activating deletes every
//     other cache on this origin.
//   - No importScripts, no eval, no dynamic import (its own CSP header is
//     default-src 'none' plus connect-src 'self').

declare const __CACHE__: string
declare const __PRECACHE__: { path: string; sha256: string }[]

interface ExtendableEvent extends Event { waitUntil(p: Promise<unknown>): void }
interface FetchEvent extends ExtendableEvent { request: Request; respondWith(r: Promise<Response> | Response): void }
declare const self: {
  location: Location
  skipWaiting(): Promise<void>
  clients: { claim(): Promise<void> }
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void
}

const CACHE = __CACHE__
const PRECACHE = __PRECACHE__
const PATHS = new Set(PRECACHE.map((p) => p.path))

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const got: [string, Response][] = []
    for (const p of PRECACHE) {
      const r = await fetch(p.path, { cache: 'no-store', credentials: 'omit', redirect: 'error' })
      if (!r.ok) throw new Error(`precache: ${p.path} answered ${r.status}`)
      const sum = hex(await crypto.subtle.digest('SHA-256', await r.clone().arrayBuffer()))
      if (sum !== p.sha256) throw new Error(`precache: ${p.path} is not the build's bytes`)
      got.push([p.path, r])
    }
    // all or nothing: write only once every file has matched its pin
    const c = await caches.open(CACHE)
    for (const [path, r] of got) await c.put(path, r)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !PATHS.has(url.pathname)) return
  e.respondWith(fetch(e.request).catch(async () => {
    const hit = await (await caches.open(CACHE)).match(url.pathname)
    return hit ?? Response.error()
  }))
})
