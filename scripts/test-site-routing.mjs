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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { HOST_FILES, stageHostFiles, workersRedirects } from './site-routing.mjs'

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
  const star = headers.split(/\n(?=\S)/).find((b) => b.startsWith('/*\n'))
  ok(star && /^\s+Access-Control-Allow-Origin: \*$/m.test(star), '_headers: ACAO * on every path')
  ok(star && /^\s+Cache-Control: max-age=600$/m.test(star), '_headers: Cache-Control max-age=600 on every path')
  const blocks = headers.split('\n').filter((l) => /^\s+(Access-Control-Allow-Origin|Cache-Control):/.test(l))
  ok(blocks.length === 2, '_headers: ACAO and Cache-Control are set once each (two matching rules would join their values)')
  stageHostFiles(site, root)
  ok(read('_redirects') === workersRedirects(FILES), 'restaging is idempotent (host files never route themselves)')
} finally {
  rmSync(site, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
