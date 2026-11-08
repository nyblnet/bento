#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// No frame a document can cause may run with scripts AND its own origin.
//
//   node scripts/test-frame-sandbox.mjs [--require-built]
//
// WHY. A sandboxed frame is only a sandbox while it lacks `allow-same-origin`.
// Add that one token next to `allow-scripts` and the framed page gets the
// embedding document's origin: it can reach the parent's storage and handles,
// and it can remove its own sandbox attribute from the outside. A frame with
// NO sandbox attribute is the same thing by default. Every app opens files
// someone else made, so any frame built from document content (an embed, an
// attachment, a preview) must stay opaque-origin. This rig makes the
// combination a CI failure instead of a review catch.
//
// WHAT IT SCANS. Every app's source (slides, spaces, dash, type, kernel) and
// every built shell, INCLUDING the deflated runtime payloads, because the
// shipped code is only visible there.
//   1. Any string carrying both `allow-same-origin` and `allow-scripts`.
//   2. Every frame-creating site (createElement of iframe/frame/object/embed,
//      iframe/frame/object/embed markup, srcdoc): its nearby `sandbox` value
//      must be a readable literal. A site with no sandbox, or one whose value
//      is computed, FAILS (computed is unreadable here, and unreadable is not
//      safe).
//   3. The one exception is allow-listed BY NAME below: type's print frame, a
//      hidden same-origin frame holding the user's own paginated document for
//      window.print(). The entry must still match (a stale entry fails), and
//      a second unsandboxed frame in the same file still fails.
//
// MUTANTS. The self-test runs the real scanner over the real render.ts with
// the sandbox value swapped to the unsafe pair, over copies with the sandbox
// dropped or computed, over the allow-listed frame renamed, moved and
// duplicated, and over every built shell with the pair injected; each must be
// caught, and the unmutated text must be clean.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { decode as b86decode } from './lib/b86.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const requireBuilt = process.argv.includes('--require-built')

const APPS = ['slides', 'spaces', 'dash', 'type', 'kernel']
const SHELLS = {
  slides: 'slides/dist-single/Bento_Slides.bento.html',
  spaces: 'spaces/dist-single/Bento_Spaces.bento.html',
  dash: 'dash/dist-single/Bento_Dash.bento.html',
  type: 'type/dist-single/Bento_Type.bento.html',
}

// The only frame allowed to be unsandboxed, by file and by the function that
// builds it. `sig` is how the same frame is recognised in a minified shell,
// where function names are gone.
const ALLOW = [
  { file: 'type/src/print.ts', fn: 'printDocument', shell: 'type',
    sig: 'position:fixed;right:0;bottom:0;width:1px;height:1px' },
]

const SITE = /createElement\(\s*['"`](?:iframe|frame|object|embed)['"`]\s*\)|<(?:iframe|frame|object|embed)\b[^>]*|\bsrcdoc\s*[=:]|\.srcdoc\b/gi
const BOTH = /allow-same-origin[^'"`<>]*allow-scripts|allow-scripts[^'"`<>]*allow-same-origin/i
// sandbox="..." in markup, setAttribute('sandbox', '..'), sandbox: '..', .sandbox = '..'
const SB_LIT = /sandbox['"`]?\s*(?:=|:|,)\s*\\?['"`]([^'"`\\]*)\\?['"`]/i
const SB_ANY = /\bsandbox\b/i

/** Blank out block comments and line comments (sources only). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p)
}

/** Name of the nearest `function name(` at or before `at` (sources only). */
function fnAround(src, at) {
  const all = [...src.slice(0, at).matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)]
  return all.length ? all[all.length - 1][1] : ''
}

/** → [{line, why}] for one text. `id` is a repo path or `shell:<app>`. */
export function scanText(text, id, { minified = false, allowSeen = new Set() } = {}) {
  const out = []
  const src = minified ? text : stripComments(text)
  const lineOf = (i) => src.slice(0, i).split('\n').length
  const bothAt = src.search(BOTH)
  if (bothAt >= 0) out.push({ line: lineOf(bothAt), why: 'allow-same-origin together with allow-scripts' })
  for (const m of src.matchAll(SITE)) {
    const at = m.index
    const win = src.slice(Math.max(0, at - 500), at + 700)
    const near = win.match(SB_LIT)
    const line = lineOf(at)
    const allowed = ALLOW.find((a) => (a.file === id || `shell:${a.shell}` === id)
      && (minified ? win.includes(a.sig) : fnAround(src, at) === a.fn))
    if (allowed) {
      if (near) out.push({ line, why: `allow-listed frame ${allowed.fn} gained a sandbox value; remove the allow-list entry` })
      else allowSeen.add(allowed.fn)
      continue
    }
    if (!near) {
      out.push({ line, why: SB_ANY.test(win)
        ? 'frame sandbox value is not a readable literal'
        : 'frame with no sandbox attribute is same-origin with scripts' })
      continue
    }
    const toks = near[1].split(/\s+/)
    if (toks.includes('allow-same-origin') && toks.includes('allow-scripts')) {
      out.push({ line, why: 'frame sandbox has allow-same-origin and allow-scripts' })
    }
  }
  return out
}

function walk(dir, acc = []) {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n.startsWith('dist')) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|js|mjs|html)$/.test(n)) acc.push(p)
  }
  return acc
}

const PAYLOAD = /<script\b[^>]*type="bento\/deflate-(b64|b86)"[^>]*>([\s\S]*?)<\/script>/g
function shellTexts(html) {
  const parts = [html]
  for (const m of html.matchAll(PAYLOAD)) {
    const t = m[2].trim()
    const bytes = m[1] === 'b86' ? Buffer.from(b86decode(t)) : Buffer.from(t, 'base64')
    parts.push(inflateRawSync(bytes).toString('utf8'))
  }
  return parts
}

let fails = 0
const fail = (m) => { fails++; console.error(`  FAIL  ${m}`) }
const ok = (m) => console.log(`  ok    ${m}`)

// ---- 1. sources ----
const seen = new Set()
let files = 0
for (const app of APPS) {
  const dir = join(root, app)
  if (!existsSync(dir)) continue
  const list = [...walk(join(dir, 'src')), ...(existsSync(join(dir, 'index.html')) ? [join(dir, 'index.html')] : [])]
  for (const f of list) {
    files++
    const rel = relative(root, f)
    for (const v of scanText(readFileSync(f, 'utf8'), rel, { allowSeen: seen })) fail(`${rel}:${v.line} ${v.why}`)
  }
}
if (!files) fail('scanned no source files')
ok(`${files} source files scanned`)
for (const a of ALLOW) {
  if (!seen.has(a.fn)) fail(`allow-list entry ${a.file} ${a.fn} no longer matches: remove it or fix the rig`)
}

// ---- 2. built shells ----
const shellSeen = {}
const shellHtml = {}
for (const [app, p] of Object.entries(SHELLS)) {
  const full = join(root, p)
  if (!existsSync(full)) {
    if (requireBuilt) fail(`${p} is not built, and this run requires it`)
    else console.log(`  note  ${app} shell not built here (${p})`)
    continue
  }
  const html = readFileSync(full, 'utf8')
  shellHtml[app] = html
  const seenHere = new Set()
  for (const t of shellTexts(html)) {
    for (const v of scanText(t, `shell:${app}`, { minified: true, allowSeen: seenHere })) fail(`${p} ${v.why}`)
  }
  shellSeen[app] = seenHere
  ok(`${p} scanned (payloads inflated)`)
}
for (const a of ALLOW) {
  if (shellSeen[a.shell] && !shellSeen[a.shell].has(a.fn)) fail(`allow-list entry for the ${a.shell} shell no longer matches`)
}

// ---- 3. mutants: the scanner must have teeth ----
const render = readFileSync(join(root, 'slides/src/render.ts'), 'utf8')
const SAFE = `frame.setAttribute('sandbox', 'allow-scripts allow-forms')`
if (!render.includes(SAFE)) fail('mutant base: render.ts embed frame line moved; update the rig')
else {
  const expect = (label, text, id, want) => {
    const n = scanText(text, id).length
    if ((n > 0) === want) ok(`${label}: ${want ? 'caught' : 'clean'}`)
    else fail(`${label}: ${want ? 'MUTANT SURVIVED' : 'false positive'}`)
  }
  const R = 'slides/src/render.ts'
  expect('control, real render.ts', render, R, false)
  expect('mutant: same-origin + scripts', render.replace(SAFE, `frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')`), R, true)
  expect('mutant: tokens reordered', render.replace(SAFE, `frame.setAttribute('sandbox', 'allow-same-origin allow-forms allow-scripts')`), R, true)
  expect('mutant: sandbox dropped', render.replace(SAFE, ''), R, true)
  expect('mutant: computed sandbox value', render.replace(SAFE, `frame.setAttribute('sandbox', flags.join(' '))`), R, true)
  expect('mutant: srcdoc markup, no sandbox', `el.innerHTML = '<iframe srcdoc="x"></iframe>'`, 'spaces/src/x.ts', true)
  expect('mutant: markup with both tokens', `el.innerHTML = '<iframe sandbox="allow-scripts allow-same-origin"></iframe>'`, 'dash/src/x.ts', true)
  const print = readFileSync(join(root, 'type/src/print.ts'), 'utf8')
  expect('control, allow-listed print frame', print, 'type/src/print.ts', false)
  expect('mutant: same frame under another name', print.replace('function printDocument(', 'function printSomethingElse('), 'type/src/print.ts', true)
  expect('mutant: print frame copied to another file', print, 'type/src/other.ts', true)
  const second = print + `\nfunction another(){ const f = document.createElement('iframe'); document.body.appendChild(f) }\n`
  expect('mutant: second unsandboxed frame in print.ts', second, 'type/src/print.ts', true)
}
for (const [app, html] of Object.entries(shellHtml)) {
  const texts = shellTexts(html)
  const rt = texts.length - 1 // the last inflated payload is the runtime
  const extra = ';var __f=document.createElement("iframe");document.body.appendChild(__f);'
  if (scanText(texts[rt] + extra, `shell:${app}`, { minified: true }).length) ok(`${app} shell mutant (extra unsandboxed frame): caught`)
  else fail(`${app} shell mutant (extra unsandboxed frame): SURVIVED`)
  const both = ';x.setAttribute("sandbox","allow-same-origin allow-scripts");'
  if (scanText(texts[rt] + both, `shell:${app}`, { minified: true }).length) ok(`${app} shell mutant (same-origin + scripts): caught`)
  else fail(`${app} shell mutant (same-origin + scripts): SURVIVED`)
}

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1) }
console.log('\nframe sandbox: all clean')
