// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The library host's kill route for service workers, emulated locally: the
// specification the hosting of bento/home in your browser must meet, and what
// scripts/test-home-web-kill-drill.mjs measures in each engine.
//
// The threat. A worker registered on the library origin with scope / survives
// the deploy that fixes whatever let it in: the browser keeps it, serves every
// navigation through it, and asks the host for its script only to update it.
// If that script's path now answers 404 the update fails and the worker stays
// (the drill measures, per engine, whether and how long). A static host cannot
// say anything else about a path it does not know. So the host itself needs a
// route the attacker cannot choose away:
//
//   1. ANY request carrying `Service-Worker: script` (the header every engine
//      sends when it fetches a worker script, to register or to update) gets a
//      200 cleaning worker, at whatever path the attacker registered, except
//      the build's own worker path(s). The answer carries
//      `Service-Worker-Allowed: /` (an update is held to the same scope rule
//      as a registration) and `Cache-Control: no-store`. The cleaning worker
//      deletes every cache, unregisters itself, and reloads the windows it
//      controlled, so they come back from the server.
//   2. A reset page (`/reset` here) answering `Clear-Site-Data: "cache",
//      "storage"`, and carrying one script (allowed by its hash) that
//      unregisters every worker and deletes every cache: the person's way out
//      when a worker will not update. Both, because WebKit honours the header's
//      "storage" for caches but leaves the worker registered (measured by the
//      drill). Neither helps against a HOSTILE worker, which answers /reset
//      itself: only route 1 reaches past one.
//
// Everything else is served as home/web/serve.mjs serves a build: files from
// the build directory with its _headers. The rig can plant files (the
// attacker's deploy) in `extra`, a map from path to { body, headers }.

import { createHash } from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { parseHeaders } from '../../home/web/serve.mjs'

/** The cleaning worker: caches gone, registration gone, controlled windows reloaded. */
export const CLEANING_WORKER = `// bento/home: this worker removes itself.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) await caches.delete(k)
  await self.registration.unregister()
  for (const c of await self.clients.matchAll({ type: 'window' })) { try { await c.navigate(c.url) } catch {} }
})()))
`

export const RESET_PATH = '/reset'
export const RESET_SCRIPT = "(async () => { try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister() } catch {} try { for (const k of await caches.keys()) await caches.delete(k) } catch {} document.documentElement.dataset.reset = 'done' })()"
const RESET_HASH = `'sha256-${createHash('sha256').update(RESET_SCRIPT).digest('base64')}'`
export const RESET_PAGE = `<!doctype html><meta charset="utf-8"><title>bento/home reset</title><p>bento/home has been reset in this browser. <a href="/">Open bento/home</a></p><script>${RESET_SCRIPT}</script>`

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' }
const matches = (pattern, p) => pattern.endsWith('*') ? p.startsWith(pattern.slice(0, -1)) : pattern === p

/**
 * The route's decision for one request, kept apart from the server so it reads
 * as the specification: { status, headers, body } or null (serve normally).
 * `ownWorkers` are the build's own worker paths (/sw.js), never answered here.
 * `mutant` (rigs only): one or a list of 'route-404' | 'no-cache-delete' |
 * 'reset-no-header' | 'reset-no-script' (both together: a reset page that does nothing).
 */
export function killRoute({ method, path: p, headers }, { ownWorkers = ['/sw.js'], mutant = null } = {}) {
  const has = (m) => [].concat(mutant ?? []).includes(m)
  if (method !== 'GET' && method !== 'HEAD') return null
  if (String(headers['service-worker'] ?? '').toLowerCase() === 'script' && !ownWorkers.includes(p)) {
    if (has('route-404')) return { status: 404, headers: {}, body: '' }
    const body = has('no-cache-delete') ? CLEANING_WORKER.replace('  for (const k of await caches.keys()) await caches.delete(k)\n', '') : CLEANING_WORKER
    return { status: 200, headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store', 'service-worker-allowed': '/', 'content-security-policy': "default-src 'none'" }, body }
  }
  if (p === RESET_PATH) {
    const h = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': `default-src 'none'; script-src ${RESET_HASH}` }
    if (!has('reset-no-header')) h['clear-site-data'] = '"cache", "storage"'
    return { status: 200, headers: h, body: has('reset-no-script') ? RESET_PAGE.replace(/<script>[\s\S]*<\/script>/, '') : RESET_PAGE }
  }
  return null
}

/**
 * Serve the library directory `dir` on `port` (127.0.0.1), with or without the
 * kill route. Returns { origin, seen, extra, set(o), close() }: `extra` holds
 * planted files by path; `set({ route, mutant })` switches the route between
 * rows. Files and _headers are read per request, as serve.mjs does.
 */
export async function startKillHost({ dir, port = 0, route = true, mutant = null }) {
  const st = { route, mutant }
  const seen = []
  const extra = new Map()
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    seen.push({ method: req.method, path: p, sw: req.headers['service-worker'] ?? null, at: Date.now() })
    if (st.route) {
      const a = killRoute({ method: req.method, path: p, headers: req.headers }, { mutant: st.mutant })
      if (a) { res.writeHead(a.status, a.headers); res.end(req.method === 'HEAD' ? undefined : a.body); return }
    }
    const x = extra.get(p)
    if (x) { res.writeHead(200, x.headers); res.end(x.body); return }
    const rules = fs.existsSync(path.join(dir, '_headers')) ? parseHeaders(fs.readFileSync(path.join(dir, '_headers'), 'utf8')) : []
    const file = p === '/' ? 'index.html' : p.slice(1)
    const full = path.join(dir, file)
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return }
    if (!file || file.startsWith('_') || file.includes('..') || !full.startsWith(dir + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404).end(); return }
    const h = {}
    for (const r of rules) if (matches(r.pattern, p)) for (const [k, v] of r.headers) { const key = k.toLowerCase(); h[key] = h[key] === undefined ? v : `${h[key]}, ${v}` }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] ?? 'application/octet-stream', ...h })
    res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(full))
  })
  await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok) })
  return {
    origin: `http://127.0.0.1:${server.address().port}`, seen, extra,
    set: (o) => Object.assign(st, o),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }),
  }
}
