// @bundle — reaches slides' model, compact expander and gate (extensionless imports)
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The conversion table behind bento.page/convert, run under node: what each
// input is recognised as, what it is offered, why something is refused, and
// each pair run end to end. Running it here, with no DOM, is also the proof
// that every conversion path is DOM-free (the page only adds the File API).

import fs from 'node:fs'
import path from 'node:path'
import { detect, describe, optionsFor, nothingFor, CONVERSIONS, type Env } from '../../convert/src/pairs.ts'
import { extractDoc } from '../../convert/src/deliver.ts'
import { loadDocJson } from '../../convert/page/load-json.ts'
import { SAMPLE_DECK } from '../../convert/page/sample-deck.ts'
import { fxMinimal } from './_fixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// Bundled rigs run from a temp copy, so find the repo from where we were run.
let root = process.cwd()
while (!fs.existsSync(path.join(root, 'scripts/test-convert')) && path.dirname(root) !== root) root = path.dirname(root)
const shellPath = path.join(root, 'slides/dist-single/Bento_Slides.bento.html')
const inCI = !!process.env.CI || !!process.env.GITHUB_ACTIONS
const haveShell = fs.existsSync(shellPath)
if (!haveShell && inCI) { console.log('  FAIL  no built slides shell — cannot skip in CI'); process.exit(1) }
let shellCalls = 0
const env: Env = {
  async shell() { shellCalls++; return { version: 'local', html: fs.readFileSync(shellPath, 'utf8') } },
  loadDocJson,
}
const enc = new TextEncoder()
const ids = (d: ReturnType<typeof detect>) => optionsFor(d).filter((o) => o.ok).map((o) => o.conversion.id)
const BLOCK = '<script type="application/bento+json" id="bento-doc">'
const wrap = (doc: unknown) => `<!doctype html><html><head>${BLOCK}${JSON.stringify(doc).replace(/</g, '\\u003c')}</` + `script></head></html>`
const sample = JSON.parse(SAMPLE_DECK)

console.log('recognising inputs')
const pptx = await fxMinimal()
{
  const d = detect('deck.pptx', pptx)
  ok(d.kind === 'pptx' && JSON.stringify(ids(d)) === '["pptx-to-slides"]', `a .pptx is offered a bento/slides deck (${ids(d)})`)
  ok(detect('deck.xlsx', pptx).kind === 'unknown', 'a zip that is not a .pptx is not taken for one')
  const html = detect('deck.bento.html', enc.encode(wrap(sample)))
  ok(html.kind === 'bento' && html.source === 'html' && JSON.stringify(ids(html)) === '["slides-to-pptx"]', `a .bento.html deck is offered PowerPoint (${ids(html)})`)
  const json = detect('deck.json', enc.encode(SAMPLE_DECK))
  ok(json.kind === 'bento' && json.source === 'json' && JSON.stringify(ids(json)) === '["slides-to-pptx","json-to-slides"]',
    `document JSON is offered PowerPoint AND a deck (${ids(json)})`)
  ok(describe(json).meta.startsWith('3 slides · 1280 × 720 px'), `the file card says what it is ("${describe(json).meta}")`)
  const compact = detect('c.json', enc.encode(JSON.stringify({ format: 'bento/slides', compact: true, slides: [] })))
  const c = optionsFor(compact)
  const pp = c.find((o) => o.conversion.id === 'slides-to-pptx')
  ok(!!pp && !pp.ok && /compact/.test(pp.why) && c.some((o) => o.ok && o.conversion.id === 'json-to-slides'),
    'compact JSON: PowerPoint is shown but explained, and making a deck is offered')
  const spaces = detect('notes.bento.html', enc.encode(wrap({ format: 'bento/spaces', pages: [] })))
  ok(spaces.kind === 'bento' && optionsFor(spaces).length === 0 && /^There is no conversion for bento\/spaces files yet\.$/.test(nothingFor(spaces)),
    `another app's file is recognised and told plainly ("${nothingFor(spaces)}")`)
  const locked = detect('locked.bento.html', enc.encode(wrap({ format: 'bento/enc', v: 1 })))
  ok(optionsFor(locked).length === 0 && /password/.test(nothingFor(locked)), 'a password-protected file is told what to do')
  ok(detect('x.html', enc.encode('<p>hello</p>')).kind === 'unknown', 'an ordinary web page is not a Bento file')
  ok(detect('x.json', enc.encode('{"a":')).kind === 'unknown', 'broken JSON is refused in words')
}

console.log('choices a pair takes')
{
  const flagFor = (doc: unknown) => (CONVERSIONS.find((c) => c.id === 'slides-to-pptx')!.flags ?? []).filter((f) => f.applies(detect('d.json', enc.encode(JSON.stringify(doc))))).map((f) => f.id)
  const withState = { ...sample, slides: [...sample.slides, { ...sample.slides[0], id: 'st', stateOf: sample.slides[0].id }] }
  ok(JSON.stringify(flagFor(sample)) === '[]' && JSON.stringify(flagFor(withState)) === '["states"]',
    'the states choice is offered only for a deck that has states')
  const c = CONVERSIONS.find((x) => x.id === 'slides-to-pptx')!
  ok(c.flags!.find((f) => f.id === 'states')!.default === true, 'the states choice starts ticked (maintainer\'s ruling)')
  const d = detect('d.json', enc.encode(JSON.stringify(withState)))
  const plain = await c.run(d, env), off = await c.run(d, env, { states: false })
  const n = (r: typeof off) => r.stats.find((s) => s.label === 'slides')!.value
  ok(n(plain) === 4 && n(off) === 3, `states come along unless unticked (${n(plain)} with, ${n(off)} unticked)`)
  ok(plain.report.entries.some((e) => e.code === 'states-as-hidden-slides') && off.report.entries.some((e) => e.code === 'state-slides-omitted'),
    'the report says which way it went')
}

console.log('running each pair')
{
  const d = detect('sample.json', enc.encode(SAMPLE_DECK))
  const toPptx = CONVERSIONS.find((c) => c.id === 'slides-to-pptx')!
  shellCalls = 0
  const r = await toPptx.run(d, env)
  ok(r.fileName === 'sample.pptx' && r.bytes[0] === 0x50 && shellCalls === 0, `slides → .pptx needs no network (${r.fileName}, shell fetched ${shellCalls}×)`)
  const st = Object.fromEntries(r.stats.map((s) => [s.label, s.value]))
  ok(st.slides === 3 && st['editable objects'] > 10, `with stats (${JSON.stringify(st)})`)
}
if (haveShell) {
  const toDeck = CONVERSIONS.find((c) => c.id === 'pptx-to-slides')!
  const r = await toDeck.run(detect('deck.pptx', pptx), env)
  const doc = extractDoc(new TextDecoder().decode(r.bytes)) as { format?: string }
  ok(r.fileName === 'deck.bento.html' && doc.format === 'bento/slides', '.pptx → .bento.html builds a deck on the shell')
  const json = CONVERSIONS.find((c) => c.id === 'json-to-slides')!
  const compactDoc = { format: 'bento/slides', compact: true, title: 'C', slides: [{ elements: [{ type: 'text', html: 'Hello' }] }] }
  const cr = await json.run(detect('c.json', enc.encode(JSON.stringify(compactDoc))), env)
  const cdoc = extractDoc(new TextDecoder().decode(cr.bytes)) as { format?: string; slides?: unknown[] }
  ok(cdoc.format === 'bento/slides' && cdoc.slides?.length === 1, 'compact JSON → .bento.html expands into a full deck')
  ok(cr.report.entries.some((e) => e.code === 'text-height-provisional' && e.where === 'slide 1'),
    'a text box nothing measured is reported, on its slide')
} else console.log('  ⚠ SKIPPED shell pairs — no built shell (cd slides && npm run build:single)')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
