#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento check rig: drives scripts/bento-check.mjs as a child process against
// the built shell, the way an agent would.
//
//   node scripts/test-bento-check.ts
//
// WHAT THIS PROVES. The CLI loads a real deck in headless Chrome and reports
// what validate() finds, with element ids and paths; a deck with an off-canvas
// element and an overflowing text box names both; --json parses and carries
// the same findings; --png writes one PNG per shown slide at the deck's pixel
// size plus a contact sheet; exit codes follow --fail-on; a compact document
// loads, expands and reports what was filled and dropped (#484/#490) rather
// than a stack trace. A browser rig: it needs Chrome and the built shell, and
// SKIPS (with the reason printed) where either is missing locally — in CI
// both exist and a skip is a failure.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'scripts/bento-check.mjs')
const shell = path.join(root, 'slides/dist-single/Bento_Slides.bento.html')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const CHROME = [
  process.env.BENTO_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p): p is string => !!p && fs.existsSync(p))
  ?? (spawnSync('which', ['google-chrome']).status === 0 ? 'google-chrome' : undefined)

const inCI = !!process.env.CI || !!process.env.GITHUB_ACTIONS
if (!CHROME || !fs.existsSync(shell)) {
  const why = !CHROME ? 'no Chrome found (set BENTO_CHROME)' : `no built shell at ${shell} (cd slides && npm run build:single)`
  if (inCI) { console.log(`  FAIL  ${why} — a browser rig cannot skip in CI`); process.exit(1) }
  console.log(`  ⚠ SKIPPED — ${why}`)
  process.exit(0)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-check-rig-'))
const run = (args: string[]) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 120_000 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const write = (name: string, obj: unknown) => { const p = path.join(tmp, name); fs.writeFileSync(p, JSON.stringify(obj)); return p }

// a full document with the two mistakes an agent makes most
const full = {
  format: 'bento/slides', version: 1, title: 'Check me', size: { width: 1280, height: 720 },
  theme: { background: '#0f1724', color: '#fff', accent: '#f7a600', fontFamily: 'system-ui, sans-serif' },
  slides: [
    { id: 's1', background: '#0f1724', transition: 'fade', notes: '', elements: [
      { id: 't1', type: 'text', x: 96, y: 80, w: 600, h: 40, rotation: 0, opacity: 1,
        html: 'This is a paragraph of text that is far too long for a box that is only forty pixels tall, so it overflows by several lines.',
        fontSize: 32, fontFamily: 'system-ui, sans-serif', fontWeight: 400, color: '#fff', align: 'left', valign: 'top', lineHeight: 1.3 },
      { id: 'r1', type: 'shape', shape: 'rect', x: 1200, y: 600, w: 300, h: 300, rotation: 0, opacity: 1, fill: '#f7a600', stroke: 'none', strokeWidth: 0 },
    ] },
    { id: 's2', background: '#0f1724', transition: 'fade', notes: '', hidden: true, elements: [] },
    { id: 's3', background: '#0f1724', transition: 'fade', notes: '', stateOf: 's1', elements: [] },
  ],
}

console.log('the starter deck\n')
const t0 = Date.now()
const starter = run([shell, '--json'])
const starterMs = Date.now() - t0
ok(starter.code === 0, `exits 0 on the starter deck with --fail-on error (exit ${starter.code})`)
let sj: any = null
try { sj = JSON.parse(starter.out) } catch {}
ok(!!sj && sj.ok === true && Array.isArray(sj.findings), '--json parses into { ok, findings, … }')
ok(sj?.slides === 19 && sj?.shown === 15, `19 slides, 15 shown — states and hidden slides excluded (${sj?.slides}/${sj?.shown})`)
ok(sj?.counts?.error === 0, `the starter deck has no errors (${sj?.counts?.error})`)
// its known warnings: the showcase's deliberate bleeds and a few tight boxes —
// pinned by kind, not count, so a starter-deck edit does not fail this rig
ok((sj?.findings ?? []).every((f: any) => ['text-overflow', 'out-of-canvas', 'collab-secrets-present', 'font-not-embedded'].includes(f.code) || f.severity !== 'warning'),
  'every starter-deck warning is a known kind (text-overflow / out-of-canvas)')
ok(sj?.measured === true, 'text was measured (the shell had layout)')
ok(starterMs < 30_000, `the whole run took ${starterMs} ms (budget: a 30-slide deck under 15 s; this one has 19)`)

console.log('\na deck with mistakes\n')
const p = write('full.json', full)
const r = run([p, '--json', '--fail-on', 'warning'])
let j: any = null
try { j = JSON.parse(r.out) } catch {}
ok(r.code === 1, `--fail-on warning exits 1 when there is a warning (exit ${r.code})`)
ok(!!j && j.ok === false, 'the JSON says ok: false')
const over = (j?.findings ?? []).find((f: any) => f.code === 'text-overflow' && f.element === 't1')
ok(!!over && /needs (\d+)px/.test(over.message), `the overflowing text box is named with the px it needs: ${over?.message?.slice(0, 60)}…`)
ok((j?.overflow ?? []).length === 1 && j.overflow[0].element === 't1', 'overflow is surfaced as its own list')
const off = (j?.findings ?? []).find((f: any) => f.code === 'out-of-canvas' && f.element === 'r1')
ok(!!off, 'the off-canvas rect is named')
ok(over?.slide === 's1' && off?.slide === 's1', 'both carry the slide id')
ok(j?.shown === 1 && j?.slides === 3, 'the hidden slide and the state slide are not shown')
const r2 = run([p, '--fail-on', 'error'])
ok(r2.code === 0, `the same deck exits 0 with --fail-on error (warnings only) (exit ${r2.code})`)
ok(/warning text-overflow \[t1\]/.test(r2.out) && /out-of-canvas \[r1\]/.test(r2.out), 'the human summary lists both with their ids')

console.log('\nimages\n')
const outDir = path.join(tmp, 'png')
const r3 = run([p, '--png', outDir, '--json'])
let j3: any = null
try { j3 = JSON.parse(r3.out) } catch {}
ok(fs.existsSync(path.join(outDir, 'page-01.png')) && !fs.existsSync(path.join(outDir, 'page-02.png')), 'one PNG per SHOWN slide (page-01 only: s2 hidden, s3 a state)')
ok(fs.existsSync(path.join(outDir, 'contact.png')), 'a contact sheet is written')
const png = fs.readFileSync(path.join(outDir, 'page-01.png'))
const dims = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) })
ok(png.subarray(1, 4).toString() === 'PNG' && dims(png).w === 1280 && dims(png).h === 720, `page-01.png is a 1280×720 PNG (${JSON.stringify(dims(png))})`)
const contact = fs.readFileSync(path.join(outDir, 'contact.png'))
ok(dims(contact).w > 300 && dims(contact).h > 150, `contact.png has real dimensions (${JSON.stringify(dims(contact))})`)
ok(Array.isArray(j3?.pages) && j3.pages.length === 1 && j3.contact?.endsWith('contact.png'), 'the JSON lists the page paths and the contact sheet')
// not blank: a PNG of a dark slide with orange and white ink is not one colour
ok(png.length > 5_000, `the page is not a blank image (${png.length} bytes)`)

console.log('\ncompact input\n')
const c = write('compact.json', { compact: true, format: 'bento/slides', version: 1, title: 'C', slides: [{ id: 's1', elements: [{ id: 't1', type: 'text', x: 96, y: 80, w: 600, h: 80, html: 'Hi', fontSize: 32 }] }] })
const r4 = run([c, '--json'])
let j4: any = null
try { j4 = JSON.parse(r4.out) } catch {}
// Since #484 every shell accepts compact input: the doc loads, expands, and
// the report says how much was filled and that nothing was dropped. (The
// earlier case pinned the pre-#484 world by sniffing the shell for a plaintext
// marker — which the deflated shell never carries — and went stale the day
// #484 landed. The plain-words refusal on an older shell stays in the CLI but
// is not rigged: building a pre-#484 shell here is not cheap.)
ok(r4.code === 0 && j4?.ok === true && j4.slides === 1, `a compact document loads and checks clean (exit ${r4.code})`)
ok(typeof j4?.expanded === 'number' && j4.expanded > 0, `compact expansion filled fields (${j4?.expanded})`)
ok(Array.isArray(j4?.dropped) && j4.dropped.length === 0, 'nothing was dropped by the gate')
// the checked-in agent decks (#490) go through the same path
const agentDir = path.join(root, 'scripts/fixtures/agent-decks')
for (const f of fs.readdirSync(agentDir).filter((f) => f.endsWith('.json')).sort()) {
  const r = run([path.join(agentDir, f), '--json'])
  let j: any = null
  try { j = JSON.parse(r.out) } catch {}
  ok(r.code === 0 && j?.ok === true && j.dropped?.length === 0 && j.expanded > 0, `agent deck ${f}: loads, ${j?.expanded ?? '?'} fields filled, zero drops (exit ${r.code})`)
}

console.log('\nerrors are exits, not traces\n')
ok(run(['/nonexistent.json']).code === 2, 'a missing file exits 2')
const bad = write('bad.json', { hello: 'world' })
const r5 = run([bad, '--json'])
ok(r5.code === 2, `a non-deck JSON exits 2 (exit ${r5.code})`)
ok(run([p, '--fail-on', 'maybe']).code === 2, 'an unknown --fail-on value exits 2')
ok(fs.readFileSync(cli, 'utf8').includes("rasterizeSlide") && fs.readFileSync(cli, 'utf8').includes('editor/exportimages.ts'), 'pixels come from #480\'s rasterizeSlide, not a second renderer')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
