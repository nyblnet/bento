#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Build bento.page/import — the public .pptx → .bento.html page.
//
//   node scripts/build-import-page.mjs <out/index.html>
//
// Bundles convert/page/import-page.ts (which runs the same convert/src/api.ts
// as the CLI) and inlines it into site-src/import.html, then writes a Content
// Security Policy built from the SHA-256 of the exact inline script and style.
//
// THE CSP IS THE PRIVACY PROMISE, ENFORCED. The page says the file never leaves
// the device. `connect-src 'self'` makes that the browser's rule rather than
// this code's intention: the page can talk to bento.page and nothing else, and
// it only ever does so twice — the signed release manifest and the shell it
// pins. `default-src 'none'` removes everything not named. Scripts and styles
// run only by hash, so nothing injected into the page — by a CDN edge, a
// browser extension rewriting markup, or a future edit that forgets — can run.
// `frame-ancestors` is not settable from a meta tag and is omitted rather than
// written somewhere it would be silently ignored.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = process.argv[2]
if (!out) { console.error('usage: build-import-page.mjs <out/index.html>'); process.exit(2) }

const esbuild = path.join(root, 'slides/node_modules/.bin/esbuild')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-import-page-'))
const bundle = path.join(tmp, 'page.js')
const built = spawnSync(esbuild, [
  path.join(root, 'convert/page/import-page.ts'), '--bundle', '--format=esm', '--minify',
  '--platform=browser', '--target=es2022', '--log-level=error', `--outfile=${bundle}`,
], { encoding: 'utf8' })
if (built.status !== 0) { console.error(built.stderr); process.exit(1) }
let js = fs.readFileSync(bundle, 'utf8')
fs.rmSync(tmp, { recursive: true, force: true })

// Same belt as save.ts (PLATFORM hard-won detail #4): the bundle is inlined into
// a <script>, so it must never contain a literal close tag.
const CLOSE = '</' + 'script'
if (js.toLowerCase().includes(CLOSE)) js = js.replace(/<\/(script)/gi, '<\\/$1')

let html = fs.readFileSync(path.join(root, 'site-src/import.html'), 'utf8')
const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1]
if (style === undefined) { console.error('site-src/import.html has no <style> block'); process.exit(1) }
const sha = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`

const csp = [
  "default-src 'none'",
  `script-src ${sha(js)}`,
  `style-src ${sha(style)}`,
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

// REPLACER FUNCTIONS, not replacement strings. A string replacement interprets
// `$&`, `$'` and `` $` `` — and a minified bundle is full of `$`. The first
// build used strings: a `` $` `` in the bundle spliced a second copy of the page
// head (CSP included) into the output, so the inline script was no longer the
// script that had been hashed and the page's own CSP would have blocked it.
html = html
  .replace('<!--IMPORT_CSP-->', () => `<meta http-equiv="Content-Security-Policy" content="${csp}">`)
  .replace('<!--IMPORT_SCRIPT-->', () => `<script type="module">${js}</script>`)

// Belt: the page must carry exactly one CSP, and the script it runs must be the
// one the CSP names. Cheap, and it is precisely the check that would have
// caught the bug above at build time rather than in a visitor's console.
if (html.split('http-equiv="Content-Security-Policy"').length !== 2)
  { console.error('built page does not carry exactly one CSP'); process.exit(1) }
const inline = /<script type="module">([\s\S]*)<\/script>/.exec(html)?.[1]
if (inline !== js || !csp.includes(sha(inline)))
  { console.error('inline script does not match its CSP hash'); process.exit(1) }

fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, html)
console.log(`import page: ${out} (${Math.round(html.length / 1024)}KB, script ${Math.round(js.length / 1024)}KB)`)
