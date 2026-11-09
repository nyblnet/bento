#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Build bento/home in your browser (stage 1): two static sites.
//
//   node home/web/build.mjs --frame-origin https://<frame site> [options]
//
//   --out <dir>              default home/web/dist
//   --library-origin <url>   where the library is served (default https://home.bento.page)
//   --frame-origin <url>     where the frame page is served: a DIFFERENT SITE
//                            from the library. Required; there is no default,
//                            because the domain is the maintainer's to choose.
//   --release-base <url>     the signed release channel (default https://bento.page/releases/)
//   --history <file>         a signed release history to bundle (repeatable).
//                            Default: the frozen slides 1.2.10 history in
//                            home/fixtures/gate1, which is only right for
//                            development: a release passes the published ones.
//   --key <jwk.json>         TEST SEAM: verify with this public key instead of
//                            the release key. Rigs only; never for a release.
//
// Output:
//   <out>/library/index.html + _headers   the library (home.bento.page)
//   <out>/frame/frame.html + _headers     the frame page, ONE static path
//   <out>/build.json                      the settings and sizes, for rigs
//
// Every script and style in both pages runs by hash. The _headers files are
// Cloudflare's format (one rule per exact path, no /* rule, so no header is
// ever appended to another: two CSP headers are two policies, both enforced).
// The frame's protection lives in its HEADER (a meta CSP cannot sandbox, and
// cannot set frame-ancestors), so whatever host serves it must send them.
//
// BENTO_HOME_WEB_MUTANT='{"file":"verify.ts","from":"…","to":"…"}' builds a
// mutant for the mutant rig: the build fails unless `from` occurs exactly once.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.lastIndexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt }
const many = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []))
const die = (m) => { console.error(`home/web build: ${m}`); process.exit(2) }

const out = path.resolve(opt('out', path.join(here, 'dist')))
const origin = (u, what) => {
  let x
  try { x = new URL(u) } catch { die(`${what} is not a URL: ${u}`) }
  if (x.origin !== u.replace(/\/$/, '')) die(`${what} must be an origin (scheme, host, port), not ${u}`)
  return x.origin
}
const libraryOrigin = origin(opt('library-origin', 'https://home.bento.page'), '--library-origin')
const frameArg = opt('frame-origin')
if (!frameArg) die('--frame-origin is required (the frame site is a separate domain; it is the maintainer\'s to choose)')
const frameOrigin = origin(frameArg, '--frame-origin')
const site = (o) => { const h = new URL(o).hostname; return /^[\d.]+$/.test(h) || h === 'localhost' ? h : h.split('.').slice(-2).join('.') }
if (site(frameOrigin) === site(libraryOrigin)) die(`the frame (${frameOrigin}) must be on a different site from the library (${libraryOrigin})`)
const releaseBase = (() => { const u = opt('release-base', 'https://bento.page/releases/'); try { new URL(u) } catch { die(`--release-base is not a URL: ${u}`) } return u.endsWith('/') ? u : u + '/' })()
const SIGNED_BASE = 'https://bento.page/releases/'
const histories = many('history')
if (!histories.length) {
  histories.push(path.join(root, 'home/fixtures/gate1/real/slides-1.2.10/history.json'))
  console.warn('home/web build: bundling the frozen slides 1.2.10 history (development only; a release passes --history)')
}
const historyTexts = histories.map((f) => fs.readFileSync(f, 'utf8'))
for (const [i, t] of historyTexts.entries()) {
  const e = JSON.parse(t)
  if (typeof e.payload !== 'string' || typeof e.sig !== 'string') die(`${histories[i]} is not a signed envelope`)
}
let key = null
const keyFile = opt('key')
if (keyFile) {
  key = JSON.parse(fs.readFileSync(keyFile, 'utf8'))
  console.warn('home/web build: TEST KEY build: not for release')
} else {
  // the release key, as home/webext/src/release.js (pinned to kernel's) exports it
  const src = fs.readFileSync(path.join(root, 'home/webext/src/release.js'), 'utf8')
  const m = /export const RELEASE_KEY = (\{[\s\S]*?\n\})/.exec(src)
  if (!m) die('could not read RELEASE_KEY from home/webext/src/release.js')
  key = Function(`return (${m[1]})`)()
}

// --- bundle ---------------------------------------------------------------
const esbuild = process.env.ESBUILD || path.join(root, 'slides/node_modules/.bin/esbuild')
if (!fs.existsSync(esbuild)) die(`esbuild not found at ${esbuild} (npm ci --prefix slides, or set ESBUILD)`)

const mutant = process.env.BENTO_HOME_WEB_MUTANT ? JSON.parse(process.env.BENTO_HOME_WEB_MUTANT) : null
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-home-web-'))
let srcDir = path.join(here, 'src')
if (mutant) {
  // a copy of src/ beside the real one, so relative imports still resolve
  const copy = path.join(here, `.mutant-src-${process.pid}`)
  fs.rmSync(copy, { recursive: true, force: true })
  fs.cpSync(srcDir, copy, { recursive: true })
  const f = path.join(copy, mutant.file)
  const text = fs.readFileSync(f, 'utf8')
  const n = text.split(mutant.from).length - 1
  if (n !== 1) { fs.rmSync(copy, { recursive: true, force: true }); die(`mutant: "${mutant.from}" occurs ${n} times in ${mutant.file} (exactly one required)`) }
  fs.writeFileSync(f, text.replace(mutant.from, () => mutant.to))
  srcDir = copy
  process.on('exit', () => fs.rmSync(copy, { recursive: true, force: true }))
}

const defines = {
  __LIBRARY_ORIGIN__: libraryOrigin,
  __FRAME_URL__: `${frameOrigin}/frame.html`,
  __RELEASE_BASE__: releaseBase,
  __SIGNED_BASE__: SIGNED_BASE,
}
function bundle(entry, extra = {}) {
  const outfile = path.join(tmp, path.basename(entry) + '.js')
  const d = { ...defines, ...extra }
  const r = spawnSync(esbuild, [
    path.join(srcDir, entry), '--bundle', '--format=iife', '--minify', '--platform=browser', '--target=es2022',
    '--log-level=error', '--legal-comments=none', `--outfile=${outfile}`,
    ...Object.entries(d).map(([k, v]) => `--define:${k}=${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`),
  ], { encoding: 'utf8' })
  if (r.status !== 0) die(r.stderr || `esbuild failed on ${entry}`)
  let js = fs.readFileSync(outfile, 'utf8')
  // Inline, so the HTML tokenizer must end the element where we mean it to:
  // no literal close tag (PLATFORM hard-won detail 4), and no "<!--" or
  // "<script", which together put script data into its double-escaped state,
  // where the real close tag no longer ends it. gate 1's own scanner checks
  // the result below. These only ever occur in string and regex literals,
  // where \x3C means the same character.
  js = js.replace(/<\/(script)/gi, '<\\/$1').replace(/<(!--|script)/gi, '\\x3C$1')
  return js.trim()
}
const libJs = bundle('library.ts', { __RELEASE_KEY__: key, __HISTORIES__: historyTexts })
const frameJs = bundle('frame.ts')
fs.rmSync(tmp, { recursive: true, force: true })

// --- pages ------------------------------------------------------------------
const sha = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`
let libHtml = fs.readFileSync(path.join(here, 'library.html'), 'utf8')
const style = /<style>([\s\S]*?)<\/style>/.exec(libHtml)?.[1]
if (style === undefined) die('library.html has no <style>')

const libraryPolicy = [
  "default-src 'none'",
  `script-src ${sha(libJs)}`,
  `style-src ${sha(style)}`,
  'img-src data:',
  `connect-src ${releaseBase}`,
  `frame-src ${frameOrigin}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join('; ')
// replacer functions: a minified bundle is full of `$`
libHtml = libHtml
  .replace('<!--LIBRARY_CSP-->', () => `<meta http-equiv="Content-Security-Policy" content="${libraryPolicy}">`)
  .replace('<!--LIBRARY_SCRIPT-->', () => `<script>${libJs}</script>`)
const { scanBlocks, markupProblems } = await import('../../kernel/src/gate1.ts')
const oneScript = (html, js, what) => {
  const scripts = scanBlocks(html).filter((b) => b.tag === 'script')
  if (scripts.length !== 1 || scripts[0].text !== js) die(`${what}: the tokenizer does not see exactly the one script we wrote`)
  // our own page carries one meta CSP on purpose; anything else gate 1 objects to is refused
  const p = markupProblems(html).filter((x) => x !== 'a <meta> refresh or CSP' || html.split('http-equiv="Content-Security-Policy"').length !== 2)
  if (p.length) die(`${what}: ${p[0]}`)
}
oneScript(libHtml, libJs, 'library page')

const frameHtml = fs.readFileSync(path.join(here, 'frame.html'), 'utf8').replace('<!--FRAME_SCRIPT-->', () => `<script>${frameJs}</script>`)
oneScript(frameHtml, frameJs, 'frame page')

// The frame's policy: the sandbox directive makes it opaque whoever embeds it
// or navigates to it; frame-ancestors names only the library; no workers; the
// one script is this page's own, and blob: for the verified blocks it writes.
// Document resources follow the served-path policy every host uses
// (kernel/src/gate1.ts hostPolicy), with connect-src narrowed to the release
// channel: no relay, no directory in stage 1.
const framePolicy = [
  'sandbox allow-scripts allow-popups allow-modals',
  "default-src 'none'",
  `script-src ${sha(frameJs)} blob:`,
  "style-src 'unsafe-inline'",
  'img-src data: blob: https:',
  'media-src data: blob: https:',
  'font-src data: blob:',
  `connect-src ${releaseBase}`,
  'frame-src https:',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  `frame-ancestors ${libraryOrigin}`,
].join('; ')

const headers = (rules) => rules.map(([p, hs]) => `${p}\n${Object.entries(hs).map(([k, v]) => `  ${k}: ${v}`).join('\n')}`).join('\n') + '\n'
const common = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
}
const libraryHeaders = {
  'Content-Security-Policy': `${libraryPolicy}; frame-ancestors 'none'`,
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Origin-Agent-Cluster': '?1',
  ...common,
}
const frameHeaders = { 'Content-Security-Policy': framePolicy, ...common }

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, 'library'), { recursive: true })
fs.mkdirSync(path.join(out, 'frame'), { recursive: true })
fs.writeFileSync(path.join(out, 'library/index.html'), libHtml)
fs.writeFileSync(path.join(out, 'library/_headers'),
  '# bento/home library: every path it serves. Generated by home/web/build.mjs.\n' +
  headers([['/', libraryHeaders], ['/index.html', libraryHeaders]]))
fs.writeFileSync(path.join(out, 'frame/frame.html'), frameHtml)
fs.writeFileSync(path.join(out, 'frame/_headers'),
  '# bento/home frame site: ONE static path. Generated by home/web/build.mjs.\n' +
  '# Serve nothing else on this site, and never a service worker.\n' +
  headers([['/frame.html', frameHeaders]]))

const historyBytes = historyTexts.reduce((n, t) => n + Buffer.byteLength(JSON.stringify(t)), 0)
const info = {
  libraryOrigin, frameOrigin, releaseBase, testKey: !!keyFile, mutant: mutant ? mutant.from : null,
  histories: histories.map((h) => path.relative(root, h)),
  bytes: {
    library: Buffer.byteLength(libHtml),
    libraryWithoutHistories: Buffer.byteLength(libHtml) - historyBytes,
    frame: Buffer.byteLength(frameHtml),
  },
  libraryPolicy, framePolicy,
}
fs.writeFileSync(path.join(out, 'build.json'), JSON.stringify(info, null, 2) + '\n')
console.log(`home/web: ${path.relative(process.cwd(), out) || '.'} (library ${Math.round(info.bytes.libraryWithoutHistories / 1024)}KB + ${Math.round(historyBytes / 1024)}KB histories, frame ${Math.round(info.bytes.frame / 1024)}KB)`)
