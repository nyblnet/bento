#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Host routing files rig (bento.page on Workers static assets).
//
//   node scripts/test-site-routing.mjs
//
// WHAT THIS PROVES. The site runs with html_handling = "none", so a URL form
// GitHub Pages answered (/x for x.html, /d/ for d/index.html, /d -> /d/) works
// only if the generated _redirects has its rule. A missing rule is a 404 on a
// published URL. So: every HTML file in a fixture tree gets exactly its rules,
// non-HTML files and the host files get none, the output is stable, and the
// staged templates keep the properties the move depends on (ACAO, no routes,
// .git never uploaded).
//
// Content-Type. GitHub Pages sent "; charset=utf-8" on html, md and txt.
// Production Workers sends none, but local `wrangler dev` DOES, so an emulator
// run passed while the real host failed 47 URLs. This rig therefore never
// asks a server. It evaluates the staged _headers with the asset worker's own
// algorithm (rules in file order, the first set replaces the asset's value,
// later sets append with a comma, "! Name" deletes; a repeated path keeps its
// last block) and requires the SAME final Content-Type whatever the platform
// put on the asset: absent, bare, with charset, or something wrong. A result
// that depends on the platform default fails here, before any deploy.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { HEADERS_MARKER, HOST_FILES, stageHostFiles, workersHeaders, workersRedirects } from './site-routing.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let failures = 0
let checks = 0
function ok(cond, msg) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const FILES = [
  'index.html', '404.html', '404.bento.html', 'hello.bento.html',
  'slides/index.html', 'help/index.html', 'gallery/picnic-playful.bento.html',
  'releases/slides/Bento_Slides.bento.html', 'releases/slides/manifest.json',
  'releases/slides/packs/ja.json', 'og.png', 'llms.txt', 'CNAME', '.nojekyll',
  'a/b/index.html', 'a/b/c.html',
  'releases/slides/packs/ko.json', 'schema/s-1.json', 'schema/s-2.json',
  'agents.md', 'skills/x/SKILL.md', 'robots.txt', 'LICENSE', 'sitemap.xml',
  'skills/x.zip', 'mixed/one.json', 'mixed/two.md',
]
const rules = workersRedirects(FILES).trimEnd().split('\n')
const has = (r) => rules.includes(r)

console.log('workersRedirects')
ok(has('/ /index.html 200'), 'root serves index.html')
ok(has('/slides/ /slides/index.html 200') && has('/slides /slides/ 301'), 'a directory index gets a rewrite and a 301')
ok(has('/a/b/ /a/b/index.html 200') && has('/a/b /a/b/ 301'), 'nested directory index')
ok(has('/releases/slides/Bento_Slides.bento /releases/slides/Bento_Slides.bento.html 200'), 'the signed shell gets its extensionless form')
ok(has('/a/b/c /a/b/c.html 200') && has('/404 /404.html 200') && has('/hello.bento /hello.bento.html 200'), 'every other html file gets its extensionless form')
ok(!rules.some((r) => r.startsWith('/index ') || r.startsWith('/slides/index ')), 'index files get no extensionless rule')
const htmlCount = FILES.filter((f) => f.endsWith('.html')).length
const indexCount = FILES.filter((f) => f.endsWith('/index.html')).length
ok(rules.length === htmlCount + indexCount, `rule count = html files + directory 301s (${rules.length})`)
ok(!rules.some((r) => /\.(json|png|txt)\b/.test(r) || r.includes('CNAME')), 'non-html files get no rule')
ok(!rules.some((r) => r.split(' ')[0].endsWith('.html')), 'no rule ever matches a .html URL (exact file wins, never rewritten)')
ok(workersRedirects([...FILES].reverse()) === workersRedirects(FILES), 'output does not depend on walk order')
ok(rules.every((r) => r.length <= 1000 && /^\/\S* \/\S* (200|301)$/.test(r)), 'every rule is well-formed and under the 1,000-char limit')
let threw = false
try { workersRedirects(Array.from({ length: 1000 }, (_, i) => `d${i}/index.html`)) } catch { threw = true }
ok(threw, 'refuses a rule count near the 2,000 static-rule limit')

// ---- the asset worker's _headers semantics, written out independently -----
// wrangler parses _headers into {path: {set, unset}} (a repeated path
// overwrites the earlier block but keeps its position); the asset worker then
// walks the matching rules in order. Splat = .*, :name = one path segment.
function parseHeaders(text) {
  const rules = new Map()
  let cur = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('/')) { cur = { set: {}, unset: [] }; rules.set(line, cur); continue }
    if (line.startsWith('! ')) { cur.unset.push(line.slice(2)); continue }
    const i = line.indexOf(':')
    const name = line.slice(0, i).trim().toLowerCase()
    const value = line.slice(i + 1).trim()
    cur.set[name] = cur.set[name] === undefined ? value : `${cur.set[name]}, ${value}`
  }
  return [...rules].map(([path, r]) => {
    const esc = path.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    return { path, re: new RegExp('^' + esc.replace(/:(\w+)/g, '[^/]+') + '$'), ...r }
  })
}
function contentType(rules, pathname, assetType) {
  const h = new Headers(assetType ? { 'content-type': assetType } : {})
  const setOnce = new Set()
  for (const r of rules.filter((x) => x.re.test(pathname))) {
    for (const k of r.unset) h.delete(k)
    for (const [k, v] of Object.entries(r.set)) {
      if (setOnce.has(k)) h.append(k, v)
      else { h.set(k, v); setOnce.add(k) }
    }
  }
  return h.get('content-type')
}
// What GitHub Pages sent, by URL (independent of site-routing's own table).
const HTML = 'text/html; charset=utf-8'
const EXPECT = {
  html: HTML, md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8', png: 'image/png', xml: 'application/xml',
  zip: 'application/x-zip-compressed', none: 'application/octet-stream',
}
function expectedFor(f) {
  const base = f.split('/').pop()
  const m = /.\.([a-z]+)$/.exec(base)
  return EXPECT[m ? m[1] : 'none']
}
// Platform defaults to try for each URL: production's bare type, the
// emulator's charset type, none at all, and a deliberately wrong one.
const ASSET_DEFAULTS = [undefined, 'text/html', 'text/html; charset=utf-8', 'text/plain', 'application/octet-stream']
function checkHeaders(headersText, files, label) {
  const rules = parseHeaders(headersText)
  const cases = []
  for (const f of files.filter((x) => !HOST_FILES.includes(x))) {
    cases.push([`/${f}`, expectedFor(f)])
    if (f === 'index.html') cases.push(['/', HTML])
    else if (f.endsWith('/index.html')) {
      const d = f.slice(0, -'index.html'.length)
      cases.push([`/${d}`, HTML], [`/${d.slice(0, -1)}`, null]) // rewrite 200; the 301 has no type
    } else if (f.endsWith('.html')) cases.push([`/${f.slice(0, -5)}`, HTML])
  }
  // 404s: their body is 404.html wherever they are.
  for (const p of ['/__missing', '/__missing/deeper.json', '/releases/', '/releases/slides/', '/schema/', '/x.md', '/Index.html', '/_headers', '/wrangler.toml', '/.git/HEAD']) cases.push([p, HTML])
  let bad = []
  for (const [url, want] of cases) {
    const got = ASSET_DEFAULTS.map((a) => contentType(rules, url, a))
    if (got.some((g) => g !== got[0])) bad.push(`${url}: depends on the platform default (${got.join(' | ')})`)
    else if ((got[0] ?? null) !== want) bad.push(`${url}: ${got[0]} (want ${want})`)
    else if (got[0]?.includes(',')) bad.push(`${url}: joined value ${got[0]}`)
  }
  ok(bad.length === 0, `${label}: every URL gets one Content-Type, the GitHub one, whatever the platform default (${cases.length} URLs)${bad.length ? '\n        ' + bad.join('\n        ') : ''}`)
  return rules
}

console.log('workersHeaders')
const tail = workersHeaders(FILES)
ok(tail.startsWith(HEADERS_MARKER + '\n'), 'the generated part starts with its marker')
ok(workersHeaders([...FILES].reverse()) === tail, 'output does not depend on walk order')
ok(/^\/schema\/:file$/m.test(tail) && !/^\/schema\/s-1\.json$/m.test(tail), 'a directory of one non-HTML type gets one rule (schema/)')
ok(/^\/mixed\/one\.json$/m.test(tail) && /^\/mixed\/two\.md$/m.test(tail), 'a directory of mixed types gets a rule per file')
ok(!/\.html$/m.test(tail), 'no rule for an HTML file (the /* rule is right for it)')
ok(tail.split('\n').filter((l) => /^\s+Content-Type:/.test(l)).length === tail.split('\n').filter((l) => /^\s+! Content-Type$/.test(l)).length - indexCount,
  'every rule that sets Content-Type deletes it first (two sets would join)')
let threwType = false
try { workersHeaders(['font.woff2']) } catch { threwType = true }
ok(threwType, 'refuses a file kind with no known Content-Type (it would be served as text/html)')
let threwCount = false
try { workersHeaders(Array.from({ length: 95 }, (_, i) => `d${i}/a.json`)) } catch { threwCount = true }
ok(threwCount, 'refuses a rule count near the 100-rule limit')

// A real-shaped tree, taken from bento.page's file list (2026-11-08).
const REAL = [
  '.nojekyll', '404.bento.html', '404.html', 'agents.md', 'CNAME', 'convert/index.html',
  'gallery/orbital-dark-immersive.bento.html', 'gallery/picnic-playful.bento.html',
  'guestbook/index.html', 'hello.bento.html', 'help/index.html', 'import/index.html',
  'index.html', 'LICENSE', 'llms.txt', 'og.png', 'q/index.html',
  'releases/slides/Bento_Slides.bento.html', 'releases/slides/history.json',
  'releases/slides/manifest.json', 'releases/slides/packs.json',
  ...['ar', 'ko', 'vi'].map((l) => `releases/slides/packs/bento-slides-1.2.12-${l}.pack.json`),
  'releases/tray/manifest.json', 'robots.txt', 'schema/slides-1.2.12.json', 'schema/slides.json',
  'sitemap.xml', 'skills/bento-deck/SKILL.md', 'skills/bento-slides.zip',
  'skills/bento-slides/SKILL.md', 'slides/agents.md', 'slides/index.html',
]

console.log('stageHostFiles')
const site = mkdtempSync(join(tmpdir(), 'site-routing-'))
try {
  for (const f of FILES) { mkdirSync(dirname(join(site, f)), { recursive: true }); writeFileSync(join(site, f), 'x') }
  stageHostFiles(site, root)
  const read = (f) => readFileSync(join(site, f), 'utf8')
  ok(HOST_FILES.every((f) => { try { read(f); return true } catch { return false } }), 'all four host files are written')
  ok(read('_redirects') === workersRedirects(FILES), '_redirects is generated from the staged tree')
  const toml = read('wrangler.toml')
  ok(/^html_handling = "none"$/m.test(toml), 'wrangler.toml: html_handling = "none"')
  ok(/^not_found_handling = "404-page"$/m.test(toml), 'wrangler.toml: 404-page')
  ok(/^directory = "\."$/m.test(toml), 'wrangler.toml: assets are the site root')
  ok(!/^\s*(routes?|custom_domain)\s*=/m.test(toml) && !/^\[\[routes\]\]/m.test(toml), 'wrangler.toml carries no route and no custom domain (cutover stays a dashboard action)')
  const ignore = read('.assetsignore').split('\n').map((l) => l.trim())
  ok(ignore.includes('.git'), '.assetsignore keeps .git out of the upload')
  ok(ignore.includes('wrangler.toml'), '.assetsignore keeps wrangler.toml out of the upload')
  const headers = read('_headers')
  ok(headers.endsWith(workersHeaders(FILES)), '_headers ends with the part generated from the staged tree')
  checkHeaders(headers, FILES, '_headers (fixture tree)')
  const paths = headers.split('\n').filter((l) => l.startsWith('/'))
  ok(new Set(paths).size === paths.length, '_headers names each path once (a repeated path silently drops its first block)')
  ok(paths.length <= 100, `_headers stays within 100 rules (${paths.length})`)
  const realHead = readFileSync(join(root, 'site-src/host/_headers'), 'utf8')
  checkHeaders(realHead.trimEnd() + '\n\n' + workersHeaders(REAL), REAL, '_headers (bento.page tree)')
  const star = headers.split(/\n(?=\S)/).find((b) => b.startsWith('/*\n'))
  ok(star && /^\s+Access-Control-Allow-Origin: \*$/m.test(star), '_headers: ACAO * on every path')
  ok(star && /^\s+Cache-Control: max-age=600$/m.test(star), '_headers: Cache-Control max-age=600 on every path')
  const blocks = headers.split('\n').filter((l) => /^\s+(Access-Control-Allow-Origin|Cache-Control):/.test(l))
  ok(blocks.length === 2, '_headers: ACAO and Cache-Control are set once each (two matching rules would join their values)')
  ok(star && /^\s+Content-Type: text\/html; charset=utf-8$/m.test(star), '_headers: /* sets text/html; charset=utf-8 (every page, rewrite and 404)')
  stageHostFiles(site, root)
  ok(read('_redirects') === workersRedirects(FILES), 'restaging is idempotent (host files never route themselves)')
} finally {
  rmSync(site, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
