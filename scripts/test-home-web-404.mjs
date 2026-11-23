#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/home's 404 page (security ruling #956 D1): the library host answers
 * every path it does not serve with a script-free 404, never index.html. A
 * host that falls back to index.html (Cloudflare Pages does, for a site with
 * no 404.html) runs the library's code at any path a link names.
 *
 *   node scripts/test-home-web-404.mjs             the rows
 *   node scripts/test-home-web-404.mjs --mutants   each mutant must turn its row red
 *
 * 1. build: home/web/build.mjs emits library/404.html with no script, no
 *    handler attribute, no shadow root and nothing it loads, never the bytes
 *    of index.html; its header rule names /404.html only (a `/*` rule would be
 *    APPENDED to every path's headers, the pinned CSP and Cache-Control of `/`
 *    and `/index.html` included).
 * 2. serve: home/web/serve.mjs, as the rigs use it, answers an unknown library
 *    path with status 404 and those bytes; the frame site still answers an
 *    empty 404; `/` still answers the library page (the positive control).
 * 3. list: the tripwire's release list (scripts/lib/home-web-served.mjs)
 *    describes /404.html as a document with no scripts.
 *
 * The tripwire row that serves this page at unlisted paths is
 * `unlisted-404-build` in scripts/test-webext-tripwire-browser.mjs.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = path.join(ROOT, 'home/web/build.mjs'), SERVE = path.join(ROOT, 'home/web/serve.mjs')
const { describeBuild } = await import(path.join(ROOT, 'scripts/lib/home-web-served.mjs'))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-home-web-404-'))
const cleanup = []
process.on('exit', () => { fs.rmSync(work, { recursive: true, force: true }); for (const f of cleanup) fs.rmSync(f, { force: true }) })

let checks = 0, failures = 0, quiet = false
const ok = (c, m) => { checks++; if (!c) failures++; if (!quiet) console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }

let n = 0
function build(script = BUILD) {
  const out = path.join(work, `b${++n}`)
  execFileSync(process.execPath, [script, '--out', out, '--library-origin', 'http://127.0.0.1:1', '--frame-origin', 'http://localhost:2',
    '--release-base', 'http://127.0.0.1:3/releases/', '--dev'], { stdio: ['ignore', 'ignore', 'inherit'] })
  return out
}

const ROWS = {
  async build(out) {
    const f = path.join(out, 'library/404.html')
    ok(fs.existsSync(f), 'the build has library/404.html')
    const page = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
    const index = fs.readFileSync(path.join(out, 'library/index.html'), 'utf8')
    ok(/<h1>Not found<\/h1>/.test(page), 'it says what it is (positive control on the file read)')
    ok(page !== index, 'it is not index.html')
    ok(!/<script/i.test(page), 'no <script>')
    ok(!/[\s/"']on[a-z]+\s*=/i.test(page), 'no on* handler attribute')
    ok(!/shadowroot/i.test(page), 'no declarative shadow root')
    ok(!/\ssrc\s*=|<link|<iframe|<object|<embed|<style|url\(|@import/i.test(page), 'nothing it loads (no src, link, frame, object, embed, style)')
    ok(/<meta http-equiv="Content-Security-Policy" content="default-src 'none';/.test(page), "its own meta CSP: default-src 'none' (the host's 404 carries no header rule)")
    const { parseHeaders } = await import(SERVE)
    const rules = parseHeaders(fs.readFileSync(path.join(out, 'library/_headers'), 'utf8'))
    const glob = rules.filter((r) => r.pattern.includes('*'))
    ok(glob.length === 0, `no wildcard header rule (${glob.map((r) => r.pattern).join(', ') || 'none'})`)
    const hit = (p) => rules.filter((r) => (r.pattern.endsWith('*') ? p.startsWith(r.pattern.slice(0, -1)) : r.pattern === p))
    ok(hit('/').length === 1 && hit('/index.html').length === 1, `exactly one rule for / and for /index.html, so their pinned headers are their own (${hit('/').length}, ${hit('/index.html').length})`)
    const csp = (p) => hit(p).flatMap((r) => r.headers).filter(([k]) => k.toLowerCase() === 'content-security-policy').map(([, v]) => v)
    ok(csp('/').length === 1 && /script-src 'sha256-/.test(csp('/')[0]), 'the CSP of / is still the library\'s own (one header, a script hash)')
    ok(csp('/404.html').length === 1 && /^default-src 'none';.*frame-ancestors 'none'/.test(csp('/404.html')[0]), "a direct visit to /404.html gets default-src 'none' and frame-ancestors 'none'")
  },
  async serve(out, serve = SERVE) {
    const { freePorts, startServers } = await import(serve)
    const [l, f] = await freePorts(2)
    const s = await startServers({ dist: out, ports: { library: l, frame: f } })
    try {
      const page = fs.readFileSync(path.join(out, 'library/404.html'))
      const index = fs.readFileSync(path.join(out, 'library/index.html'))
      const miss = `/nope-${randomBytes(6).toString('hex')}`
      const root = await fetch(`${s.library}/`)
      ok(root.status === 200 && Buffer.from(await root.arrayBuffer()).equals(index), 'positive control: / answers 200 with the library page')
      const r = await fetch(`${s.library}${miss}`)
      const body = Buffer.from(await r.arrayBuffer())
      ok(r.status === 404, `an unknown library path (${miss}) answers 404 (${r.status})`)
      ok(body.equals(page) && !body.equals(index), `with the build's 404.html, never index.html (${body.length} bytes)`)
      ok(/text\/html/.test(r.headers.get('content-type') ?? ''), `as HTML (${r.headers.get('content-type')})`)
      const deep = await fetch(`${s.library}/a/b/index.html`)
      ok(deep.status === 404 && Buffer.from(await deep.arrayBuffer()).equals(page), 'a deeper unknown path too')
      const fr = await fetch(`${s.frame}${miss}`)
      ok(fr.status === 404 && (await fr.arrayBuffer()).byteLength === 0, `the frame site still answers an empty 404 (${fr.status})`)
    } finally { await s.close() }
  },
  async list(out) {
    const rel = await describeBuild(out)
    const lib = Object.values(rel.origins).find((o) => o.role === 'library')
    const e = lib.files['/404.html']
    ok(e?.kind === 'document' && Array.isArray(e.scripts) && e.scripts.length === 0, `the release list describes /404.html as a document with no scripts (${JSON.stringify(e && { kind: e.kind, scripts: e.scripts })})`)
    ok(lib.files['/'].scripts.length === 1, 'and / still with its one script')
  },
}

if (!process.argv.includes('--mutants')) {
  const out = build()
  for (const [name, fn] of Object.entries(ROWS)) { console.log(`\n=== ${name}`); await fn(out) }
  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

// --- mutants ----------------------------------------------------------------
const B = 'build', S = 'serve'
const MUTANTS = [
  { name: 'the 404 page is a copy of index.html', row: 'build', file: B, from: "fs.writeFileSync(path.join(out, 'library/404.html'), NOT_FOUND_HTML)", to: "fs.writeFileSync(path.join(out, 'library/404.html'), libHtml)" },
  { name: 'a /* header rule', row: 'build', file: B, from: "['/404.html', notFoundHeaders]]", to: "['/404.html', notFoundHeaders], ['/*', notFoundHeaders]]" },
  { name: 'the 404 page carries a handler', row: 'build', file: B, from: '<p>There is no page at this address.</p>', to: '<p onclick="1">There is no page at this address.</p>' },
  { name: 'the 404 page carries a handler after a slash (<svg/onload>)', row: 'build', file: B, from: '<p>There is no page at this address.</p>', to: '<svg/onload=1></svg><p>There is no page at this address.</p>' },
  { name: 'the 404 page carries a handler after a quote', row: 'build', file: B, from: '<p>There is no page at this address.</p>', to: '<p title="x"onclick=1>There is no page at this address.</p>' },
  { name: 'the local server falls back to index.html', row: 'serve', file: S, from: "const notFound = path.join(dir, '404.html')", to: "const notFound = path.join(dir, 'index.html')" },
  { name: 'the local server answers 200', row: 'serve', file: S, from: "if (fs.existsSync(notFound)) { res.writeHead(404,", to: "if (fs.existsSync(notFound)) { res.writeHead(200," },
  { name: 'the local server sends an empty 404', row: 'serve', file: S, from: "if (fs.existsSync(notFound)) {", to: 'if (false) {' },
]
quiet = true
const out0 = build()
for (const fn of Object.values(ROWS)) await fn(out0)
if (failures) { console.log(`FAIL: ${failures} check(s) red without a mutant`); process.exit(1) }
console.log(`  ok    control: ${checks}/${checks} unmutated`)
let bad = 0
for (const m of MUTANTS) {
  const real = m.file === B ? BUILD : SERVE
  const src = fs.readFileSync(real, 'utf8')
  const hits = src.split(m.from).length - 1
  if (hits !== 1) { bad++; console.log(`  FAIL  ${m.name}: "${m.from.slice(0, 50)}" occurs ${hits} times (NOT APPLIED)`); continue }
  // beside the real file, so its relative imports resolve
  const copy = path.join(path.dirname(real), `.mutant-${path.basename(real, '.mjs')}-${process.pid}-${cleanup.length}.mjs`)
  cleanup.push(copy)
  fs.writeFileSync(copy, src.replace(m.from, () => m.to))
  checks = 0; failures = 0
  try {
    if (m.file === B) await ROWS[m.row](build(copy))
    else await ROWS.serve(out0, copy)
  } catch (e) { failures++; console.log(`        threw: ${String(e?.message ?? e).split('\n')[0]}`) }
  fs.rmSync(copy, { force: true })
  const red = failures > 0
  if (!red) bad++
  console.log(`  ${red ? 'ok  ' : 'FAIL'}  ${m.name} → row ${m.row} ${red ? 'red' : 'GREEN'}`)
}
console.log(`\n${MUTANTS.length - bad}/${MUTANTS.length} mutants red on their row`)
process.exit(bad ? 1 : 0)
