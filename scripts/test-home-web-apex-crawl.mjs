#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * bento/home is opt-in (page-as-app T7, the crawl row): nothing on the apex
 * site moves a person into the library (home.bento.page) without a click.
 * Crawls every page and script under site-src/ (and its _headers and
 * _redirects files) for the ways a page can move someone on its own:
 *
 *   - a <meta http-equiv="refresh"> naming the library;
 *   - script that assigns location (href, assign, replace, location =) or
 *     calls window.open with the library's address in the same statement;
 *   - a <form> whose action is the library (a script can submit it);
 *   - a Refresh or Location header, or a redirect rule, to the library.
 *
 * Links to the library are fine: a link needs a click.
 *
 *   node scripts/test-home-web-apex-crawl.mjs            the real site-src
 *   node scripts/test-home-web-apex-crawl.mjs --mutants  each mutant, in a copy, must turn the crawl red
 *
 * Positive controls: a planted meta refresh and a planted Refresh header are
 * found, so a crawl that finds nothing has looked.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELF = fileURLToPath(import.meta.url)
const SITE = process.env.BENTO_APEX_ROOT || path.join(ROOT, 'site-src')
const LIBRARY = /home\.bento\.page/i

const MUTANTS = [
  { name: 'auto-redirect', why: 'an automatic redirect from /slides into the library', file: 'landing.html',
    from: '</head>', to: '<script>if (location.pathname.startsWith("/slides")) location.href = "https://home.bento.page/"</script></head>' },
  { name: 'meta-refresh', why: 'a meta refresh into the library', file: '404.html',
    from: '</head>', to: '<meta http-equiv="refresh" content="0; url=https://home.bento.page/open"></head>' },
  { name: 'refresh-header', why: 'a Refresh header into the library', file: 'host/_headers',
    from: null, to: '\n/slides\n  Refresh: 0; url=https://home.bento.page/\n' },
]

if (process.argv.includes('--mutants')) {
  let n = 0, bad = 0
  for (const m of MUTANTS) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-apex-'))
    fs.cpSync(path.join(ROOT, 'site-src'), copy, { recursive: true })
    const f = path.join(copy, m.file)
    const t = fs.readFileSync(f, 'utf8')
    if (m.from !== null && t.split(m.from).length !== 2) throw new Error(`mutant ${m.name}: "${m.from}" is not in ${m.file} exactly once`)
    fs.writeFileSync(f, m.from === null ? t + m.to : t.replace(m.from, () => m.to))
    const r = spawnSync(process.execPath, [SELF], { env: { ...process.env, BENTO_APEX_ROOT: copy }, encoding: 'utf8' })
    fs.rmSync(copy, { recursive: true, force: true })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    const caught = r.status !== 0 && out.split('\n').some((l) => l.includes('FAIL') && l.includes('moves a person into the library'))
    n++
    if (!caught) bad++
    console.log(`  ${caught ? 'ok  ' : 'FAIL'}  ${m.name}: ${m.why} — ${caught ? 'red on its row' : 'SURVIVED'}`)
  }
  console.log(`\n${n - bad}/${n} mutants killed`)
  process.exit(bad ? 1 : 0)
}

let checks = 0, failures = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name)
  return e.isDirectory() ? walk(p) : [p]
})

/** Every way a file moves someone into the library without a click: [file, what]. */
function crawl(files) {
  const found = []
  for (const [name, text] of files) {
    const base = path.basename(name)
    if (base === '_headers') {
      // header lines are "  Name: value" under a path line
      for (const l of text.split('\n')) if (/^\s+(refresh|location)\s*:/i.test(l) && LIBRARY.test(l)) found.push([name, `header ${l.trim()}`])
      continue
    }
    if (base === '_redirects') {
      for (const l of text.split('\n')) if (!/^\s*#/.test(l) && LIBRARY.test(l)) found.push([name, `redirect ${l.trim()}`])
      continue
    }
    if (!/\.(html?|m?js)$/i.test(base)) continue
    for (const m of text.matchAll(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi)) if (LIBRARY.test(m[0])) found.push([name, `meta refresh ${m[0].slice(0, 80)}`])
    for (const m of text.matchAll(/<form\b[^>]*>/gi)) if (LIBRARY.test(m[0])) found.push([name, `form ${m[0].slice(0, 80)}`])
    // script statements: split on ; and newlines, look for a navigation sink beside the library's address
    const scripts = /\.m?js$/i.test(base) ? [text] : [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])
    for (const sc of scripts) {
      for (const st of sc.split(/[;\n]/)) {
        if (!LIBRARY.test(st)) continue
        if (/\blocation\s*(\.\s*(href|assign|replace)\b|=(?!=))|\bwindow\s*\.\s*open\s*\(|\.submit\s*\(/.test(st)) found.push([name, `script ${st.trim().slice(0, 100)}`])
      }
    }
  }
  return found
}

const files = walk(SITE).filter((p) => /\.(html?|m?js)$|_headers$|_redirects$/i.test(p)).map((p) => [path.relative(SITE, p), fs.readFileSync(p, 'utf8')])
console.log(`=== [T7] the apex site (${files.length} pages, scripts and header files under ${path.relative(ROOT, SITE) || SITE})`)
ok(files.length > 3 && files.some(([n]) => n === 'landing.html'), `the crawl reads the site's pages (${files.length}, landing.html among them)`)
const hits = crawl(files)
ok(hits.length === 0, `nothing on the apex site moves a person into the library without a click${hits.length ? ': ' + hits.map(([f, w]) => `${f}: ${w}`).join('; ') : ''}`)
// positive controls: the same crawl, on planted files
ok(crawl([['planted.html', '<head><meta http-equiv="refresh" content="0; url=https://home.bento.page/"></head>']]).length === 1, 'positive control: a planted meta refresh into the library is found')
ok(crawl([['_headers', '/x\n  Refresh: 0; url=https://home.bento.page/\n']]).length === 1, 'positive control: a planted Refresh header into the library is found')
ok(crawl([['planted.html', '<script>\nwindow.location.replace("https://home.bento.page/open")\n</script>']]).length === 1, 'positive control: a planted script redirect into the library is found')
ok(crawl([['planted.html', '<a href="https://home.bento.page/">Open bento/home</a>']]).length === 0, 'a plain link into the library is allowed: it needs a click')
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
