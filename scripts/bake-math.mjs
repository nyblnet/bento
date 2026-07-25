#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Bake LaTeX into the SVG markup a MathElement carries, OUTSIDE the editor —
// the piece a deck generator otherwise cannot produce (see docs/agents.md:
// `source` alone renders an empty placeholder, because there is no engine at
// view time to fall back on).
//
//   node scripts/bake-math.mjs scripts/<name>.tex.mjs [--out scripts/<name>.math.mjs]
//
// The input module exports `MATH`: an array of
//   { key, source, mode?: 'equation'|'note', display?: boolean, tags?: [{tex,tag}] }
// The output module exports `BAKED`: { [key]: { baked, wEx, hEx, valign } } —
// `baked` goes straight into MathElement.baked, and wEx/hEx are the formula's
// intrinsic size so a generator can shape its box to the right aspect ratio.
//
// HOW, and why this way: it drives the app's OWN src/mathjax.ts in a real
// browser rather than reimplementing the bake. That module's output is not just
// "MathJax SVG" — it strips the container's inline sizing, drops the literal
// xmlns MathJax writes onto an element already in the SVG namespace, rewrites
// xlink:href to plain href, and resolves morph tags into data-bento-tag. Every
// one of those is load-bearing downstream (see CLAUDE.md), and a second
// implementation here would drift from the editor silently. So: vite serves the
// real module, headless Chrome runs it, we read the result back.
//
// It also reports the per-symbol morph pairing between consecutive entries —
// the number that says whether a derivation will actually animate symbol by
// symbol or fall back to a box morph. That check runs the real mathmorph.ts.
//
// Requirements: a Chrome/Chromium binary (PATH, CHROME env, or the
// com.google.Chrome flatpak) and vite — spawned here unless one is already
// serving on the port.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.BAKE_PORT || 5199)

// ——— cli ————————————————————————————————————————————————————————————
const args = process.argv.slice(2)
const input = args.find((a) => !a.startsWith('--'))
if (!input) {
  console.error('usage: node scripts/bake-math.mjs <input.tex.mjs> [--out <output.math.mjs>]')
  process.exit(1)
}
const outFlag = args.indexOf('--out')
const inputPath = resolve(input)
const outPath = outFlag >= 0 ? resolve(args[outFlag + 1]) : inputPath.replace(/\.tex\.mjs$/, '.math.mjs')

const { MATH } = await import(pathToFileURL(inputPath).href)
if (!Array.isArray(MATH) || !MATH.length) throw new Error(`${input} exports no MATH array`)
const keys = MATH.map((m) => m.key)
if (new Set(keys).size !== keys.length) throw new Error('duplicate keys in MATH')

// ——— locate chrome ——————————————————————————————————————————————————
function chromeCommand() {
  if (process.env.CHROME) return [process.env.CHROME, []]
  for (const bin of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    const hit = spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' })
    if (hit.status === 0 && hit.stdout.trim()) return [hit.stdout.trim(), []]
  }
  const flat = spawnSync('flatpak', ['info', 'com.google.Chrome'], { encoding: 'utf8' })
  if (flat.status === 0) return ['flatpak', ['run', 'com.google.Chrome']]
  throw new Error('No Chrome/Chromium found — set CHROME=/path/to/chrome')
}

// ——— dev server ————————————————————————————————————————————————————
const alive = async () => {
  try {
    const res = await fetch(`http://localhost:${PORT}/src/mathjax.ts`)
    return res.ok
  } catch { return false }
}

let vite = null
if (await alive()) {
  console.log(`• using the vite dev server already on :${PORT}`)
} else {
  console.log(`• starting vite on :${PORT}`)
  vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: join(root, 'slides'), stdio: 'ignore', detached: true,
  })
  const deadline = Date.now() + 30000
  while (!(await alive())) {
    if (Date.now() > deadline) { stopVite(); throw new Error('vite did not come up') }
    await new Promise((r) => setTimeout(r, 300))
  }
}
function stopVite() {
  if (!vite) return
  try { process.kill(-vite.pid) } catch { /* already gone */ }
  vite = null
}

// ——— the harness page ————————————————————————————————————————————————
// Written into slides/ because vite serves that as its root; removed in the
// finally below. It imports the real modules by URL, so nothing is duplicated.
const harnessPath = join(root, 'slides', '__bake-harness.html')
const payload = JSON.stringify(MATH).replace(/</g, '\\u003c')
writeFileSync(harnessPath, `<!doctype html><meta charset="utf-8"><title>baking</title>
<script id="in" type="application/json">${payload}</scr` + `ipt>
<script id="out" type="application/json"></scr` + `ipt>
<script type="module">
import { bakeEquation, bakeMathCell } from '/src/mathjax.ts'
import { glyphAtoms, pairAtoms } from '/src/mathmorph.ts'

const done = (o) => {
  // escape '<' so the JSON can never close its own script block, exactly as
  // save.ts does for the document block
  document.getElementById('out').textContent = JSON.stringify(o).replace(/</g, '\\\\u003c')
  document.title = 'BAKE-DONE'
}
try {
  const items = JSON.parse(document.getElementById('in').textContent)
  const baked = {}
  for (const it of items) {
    if (it.mode === 'note') {
      baked[it.key] = { baked: await bakeMathCell(it.source), note: true }
      continue
    }
    const r = await bakeEquation(it.source, { display: it.display !== false, tags: it.tags })
    const m = /width="([\\d.]+)ex"[^>]*height="([\\d.]+)ex"/.exec(r.svg)
    baked[it.key] = {
      baked: r.svg,
      wEx: m ? Number(m[1]) : 0,
      hEx: m ? Number(m[2]) : r.heightEx,
      valign: r.valign,
    }
  }
  // Morph QA: how many glyphs pair between each consecutive EQUATION pair.
  // This is the real mathmorph, so a low number here is a real warning that
  // the step will look like a crossfade instead of symbols travelling.
  const pairs = []
  const eqs = items.filter((i) => i.mode !== 'note')
  const frame = { x: 0, y: 0, w: 800, h: 200 }
  for (let i = 0; i + 1 < eqs.length; i++) {
    const A = { type: 'math', mode: 'equation', align: 'center', baked: baked[eqs[i].key].baked }
    const B = { type: 'math', mode: 'equation', align: 'center', baked: baked[eqs[i + 1].key].baked }
    const a = glyphAtoms(A, frame), b = glyphAtoms(B, frame)
    pairs.push({
      from: eqs[i].key, to: eqs[i + 1].key,
      a: a ? a.length : -1, b: b ? b.length : -1,
      paired: a && b ? pairAtoms(a, b).length : -1,
    })
  }
  done({ ok: true, baked, pairs })
} catch (ex) {
  done({ ok: false, error: String(ex && ex.stack || ex) })
}
</scr` + `ipt>
`)

// ——— run it ——————————————————————————————————————————————————————————
try {
  const [bin, pre] = chromeCommand()
  console.log(`• baking ${MATH.length} entries with ${bin}`)
  const res = spawnSync(bin, [
    ...pre,
    '--headless=new', '--no-sandbox', '--disable-gpu',
    // the page's work is async (fetch the engine, then typeset); virtual time
    // lets Chrome wait for it before dumping instead of racing the load event
    '--virtual-time-budget=120000',
    '--run-all-compositor-stages-before-draw',
    '--dump-dom', `http://localhost:${PORT}/__bake-harness.html`,
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (res.error) throw res.error

  const dom = res.stdout || ''
  const m = /<script id="out" type="application\/json">([\s\S]*?)<\/script>/.exec(dom)
  if (!m || !m[1].trim()) {
    console.error(res.stderr?.slice(-2000) || '(no stderr)')
    throw new Error('the harness produced no output — see the Chrome log above')
  }
  const out = JSON.parse(m[1])
  if (!out.ok) throw new Error(`bake failed in the page:\n${out.error}`)

  // Scored against min(a,b), which is the most that CAN pair: a step that
  // collapses 19 glyphs into 7 and pairs all 7 is a total success, and scoring
  // it against the larger side would flag the deck's best moment as a problem.
  for (const p of out.pairs) {
    const most = Math.min(p.a, p.b)
    const pct = most > 0 ? Math.round((p.paired / most) * 100) : 0
    const flag = p.paired < 0 ? '  ⚠ declined → box morph' : pct < 60 ? '  ⚠ low' : ''
    console.log(`  ${p.from} → ${p.to}: ${p.paired}/${most} pairable glyphs (${pct}%), ${p.a}→${p.b}${flag}`)
  }

  const body = Object.entries(out.baked)
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
    .join('\n')
  writeFileSync(outPath, `// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// GENERATED — do not edit. Baked MathJax ${'3.2.2'} output for the formulas in
// ${input.replace(/\\/g, '/')}.
//
//   node scripts/bake-math.mjs ${input.replace(/\\/g, '/')}
//
// This is exactly what the editor writes into MathElement.baked. It is stored
// verbatim so that viewing and presenting need no engine and no network.
export const BAKED = {
${body}
}
`)
  const kb = Math.round(readFileSync(outPath).length / 1024)
  console.log(`✓ ${outPath.replace(root + '/', '')} — ${Object.keys(out.baked).length} entries, ${kb} KB`)
} finally {
  rmSync(harnessPath, { force: true })
  stopVite()
}
