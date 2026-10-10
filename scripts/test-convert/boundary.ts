// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Boundary rig: convert/ is a LIBRARY BESIDE the apps, never inside a shell.
//
// The maintainer's rule for #88 was "no app UI, nothing added to any shell".
// Two things keep that true after today:
//   1. No app or kernel source imports top-level convert/. Only the CLI, the
//      /import page and the rigs may. (kernel/src/convert/zip.ts is kernel
//      machinery the engine borrows — that direction is allowed.)
//   2. The engine is DOM-free, so the CLI can run it in node and the page in a
//      browser from the same code. Checked on the minified bundle — comments
//      and strings like "window" (a DrawingML colour name) cannot false-alarm
//      there, and every reachable file is covered, not just the ones listed.

import { spawnSync } from 'node:child_process'
import zlib from 'node:zlib'
// @ts-expect-error plain .mjs helper, no types
import { decode as b86decode } from '../lib/b86.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const convertDir = path.join(root, 'convert') + path.sep

console.log('nothing in a shell reaches convert/')
function* walk(d: string): Generator<string> {
  if (!fs.existsSync(d)) return
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('dist')) continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) yield p
  }
}
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g
for (const zone of ['slides/src', 'dash/src', 'spaces/src', 'type/src', 'kernel/src']) {
  const bad: string[] = []
  let files = 0
  for (const f of walk(path.join(root, zone))) {
    files++
    for (const m of fs.readFileSync(f, 'utf8').matchAll(SPEC)) {
      if (!m[1].startsWith('.')) continue
      if (path.resolve(path.dirname(f), m[1]).startsWith(convertDir)) bad.push(`${path.relative(root, f)} → ${m[1]}`)
    }
  }
  ok(files > 0 ? bad.length === 0 : true, `${zone}: ${files} files, none import convert/ ${bad.length ? '(' + bad.join('; ') + ')' : ''}`)
}

console.log('the engine is DOM-free')
const esbuild = path.join(root, 'slides/node_modules/.bin/esbuild')
const DOM = /(?<![.\w$"'`])(document|window|DOMParser|XMLSerializer|localStorage|sessionStorage|navigator|HTMLElement|Image|FileReader|createElement)(?=\s*[.(\[])/g
for (const entry of ['convert/src/pptx.ts', 'convert/src/pptx-write/index.ts', 'convert/src/limits.ts']) {
  const r = spawnSync(esbuild, [path.join(root, entry), '--bundle', '--format=esm', '--minify', '--platform=neutral', '--log-level=error'], { encoding: 'utf8' })
  const hits = [...new Set([...(r.stdout ?? '').matchAll(DOM)].map(m => m[1]))]
  ok(r.status === 0 && r.stdout.length > 1000 && hits.length === 0, `${entry} and all it reaches use no DOM global (${hits.join(', ') || 'none'})`)
}

console.log('no app shell carries the converter')
{
  // The rule is about what SHIPS in a document. Source imports are checked
  // above; this checks the built shells themselves, for any app that has
  // been built. These strings exist only in the PowerPoint writer and the
  // importer (package part names), never in an app.
  const shells: Record<string, string> = {
    slides: 'slides/dist-single/Bento_Slides.bento.html', dash: 'dash/dist-single/Bento_Dash.bento.html',
    spaces: 'spaces/dist-single/Bento_Spaces.bento.html', type: 'type/dist-single/Bento_Type.bento.html',
  }
  const inCI = !!process.env.CI || !!process.env.GITHUB_ACTIONS
  let seen = 0
  for (const [app, rel] of Object.entries(shells)) {
    const f = path.join(root, rel)
    if (!fs.existsSync(f)) continue
    seen++
    // the runtime ships deflated, so look inside the payloads, not the text
    const html = fs.readFileSync(f, 'utf8')
    // (base-86 since 1.1.1, base64 before; scripts/lib/b86.mjs is the codec)
    const blocks = [...html.matchAll(/<script[^>]*type="bento\/deflate-(b64|b86)"[^>]*>([^<]*)<\/script>/g)]
    const payloads = blocks.map((m) => zlib.inflateRawSync(m[1] === 'b86' ? Buffer.from(b86decode(m[2].trim())) : Buffer.from(m[2].trim(), 'base64')).toString('utf8')).join('\n')
    // non-vacuous: the runtime really was found and inflated (an unreadable
    // payload once made this check pass by looking at nothing)
    ok(blocks.length > 0 && payloads.length > 100_000, `${app}: ${blocks.length} runtime payload(s) inflated, ${Math.round(payloads.length / 1024)} KB of code read`)
    const hits = ['presProps.xml', 'notesMaster', 'ppt/slides/', 'slideLayout'].filter((w) => html.includes(w) || payloads.includes(w))
    ok(hits.length === 0, `${app}: the built shell carries no converter (${hits.join(', ') || 'none found'})`)
  }
  ok(seen > 0 || !inCI, `checked ${seen} built shell(s)${seen ? '' : ' (none built locally; CI builds slides first)'}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
