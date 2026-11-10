#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Serve a home/web build locally: the library and the frame page on two
// different SITES (127.0.0.1 and localhost), each with the headers its
// generated _headers file declares, applied the way Cloudflare applies them
// (rules in file order; the first sets a header, a later match appends with a
// comma). Optionally a release channel from a directory (or set in memory by
// a rig), with Access-Control-Allow-Origin: * as bento.page sends it.
//
//   node home/web/build.mjs --library-origin http://127.0.0.1:5310 \
//        --frame-origin http://localhost:5311 --release-base http://127.0.0.1:5312/releases/
//   node home/web/serve.mjs --dist home/web/dist --library 5310 --frame 5311 [--releases <dir> --release-port 5312]
//
// Any path not in the build answers 404 with no body: the frame site serves
// exactly one page.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cloudflare-style _headers: [{ pattern, headers: [[name, value]] }]. */
export function parseHeaders(text) {
  const rules = []
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) { rules.push({ pattern: line.trim(), headers: [] }); continue }
    const m = /^\s+([^:]+):\s*(.*)$/.exec(line)
    if (m && rules.length) rules[rules.length - 1].headers.push([m[1].trim(), m[2].trim()])
  }
  return rules
}
const matches = (pattern, p) => pattern.endsWith('*') ? p.startsWith(pattern.slice(0, -1)) : pattern === p

function headersFor(rules, p) {
  const out = {}
  for (const r of rules) {
    if (!matches(r.pattern, p)) continue
    for (const [k, v] of r.headers) {
      const key = k.toLowerCase()
      out[key] = out[key] === undefined ? v : `${out[key]}, ${v}`
    }
  }
  return out
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' }

/** A static site from `dir` with its _headers. `onRequest(req)` sees every request first. */
function site(dir, { index = null, onRequest } = {}) {
  const rules = fs.existsSync(path.join(dir, '_headers')) ? parseHeaders(fs.readFileSync(path.join(dir, '_headers'), 'utf8')) : []
  return http.createServer((req, res) => {
    onRequest?.(req)
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    const file = p === '/' && index ? index : p.slice(1)
    const full = path.join(dir, file)
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return }
    if (!file || file.startsWith('_') || file.includes('..') || !full.startsWith(dir + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404).end(); return
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] ?? 'application/octet-stream', ...headersFor(rules, p) })
    res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(full))
  })
}

/**
 * The release channel: `files` maps a path under /releases/ to a body (string
 * or Buffer). A rig changes it between rows; null removes a path.
 */
function releases(files, onRequest) {
  return http.createServer((req, res) => {
    onRequest?.(req)
    const p = new URL(req.url, 'http://x').pathname
    const body = files.get(p)
    const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return }
    if (body == null) { res.writeHead(404, cors).end(); return }
    res.writeHead(200, { ...cors, 'content-type': p.endsWith('.json') ? 'application/json' : 'text/html' })
    res.end(body)
  })
}

const listen = (server, port) => new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '::', () => ok(server.address().port)) })

/**
 * Start all three. Returns { library, frame, release (origins), files (the
 * release map), close() }. Port 0 picks free ports, but the build must name
 * the origins, so rigs pick ports first (freePorts) and build against them.
 */
export async function startServers({ dist, ports, files = new Map(), onRequest }) {
  const lib = site(path.resolve(dist, 'library'), { index: 'index.html', onRequest })
  const frm = site(path.resolve(dist, 'frame'), { onRequest })
  const rel = releases(files, onRequest)
  const [a, b, c] = [await listen(lib, ports.library), await listen(frm, ports.frame), await listen(rel, ports.release ?? 0)]
  return {
    library: `http://127.0.0.1:${a}`, frame: `http://localhost:${b}`, release: `http://127.0.0.1:${c}`, files,
    close: () => Promise.all([lib, frm, rel].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()) }))),
  }
}

/** n free TCP ports. */
export async function freePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, async () => { const s = http.createServer(); await listen(s, 0); return s }))
  const ports = servers.map((s) => s.address().port)
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
  return ports
}

/** Load a directory as release files: <dir>/<app>/<file> → /releases/<app>/<file>. */
export function releaseDir(dir, files = new Map()) {
  for (const app of fs.readdirSync(dir)) {
    const d = path.join(dir, app)
    if (!fs.statSync(d).isDirectory()) continue
    for (const f of fs.readdirSync(d)) files.set(`/releases/${app}/${f}`, fs.readFileSync(path.join(d, f)))
  }
  return files
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d }
  const dist = opt('dist', path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist'))
  const files = opt('releases') ? releaseDir(opt('releases')) : new Map()
  const s = await startServers({ dist, ports: { library: Number(opt('library', 5310)), frame: Number(opt('frame', 5311)), release: Number(opt('release-port', 5312)) }, files })
  console.log(`library ${s.library}/   frame ${s.frame}/frame.html   releases ${s.release}/releases/`)
}
