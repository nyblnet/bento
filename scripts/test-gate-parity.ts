#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Gate parity: with the load-report collector OFF, the untrusted gate on this
// branch must make byte-identical accept/drop decisions to the gate on main
// for every fixture. The collector (withDropReport) is an observation hook;
// this is the proof it observes and never changes.
//
//   node scripts/test-gate-parity.ts      (needs origin/main fetched)
//
// HOW. main's slides/src/untrusted.ts is taken from git at rig time
// (`git show origin/main:…`), written beside the branch's copy so its
// relative imports resolve to the same model/palette/modelkeys/tips, and the
// two are esbuild-bundled as separate entries; each fixture goes through
// both sanitizeSlide (and, element by element, sanitizeElement) and the JSON
// outputs are compared. The temporary file is removed afterwards.
//
// FIXTURES. Every checked-in deck (starter, the two gallery fixtures, the
// three agent decks — expanded with the pure compact.ts first), plus a
// hostile/edge corpus in the shapes the gate rigs already cover
// (test-clipboard, test-embed, test-slides-crop): unknown keys, wrong types,
// missing required keys, half-objects, url() backgrounds, javascript: and
// http: sources, oversized lists, __proto__, unknown element types and
// tip/shape enum values, every element type at its minimum.

import { readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainCopy = join(root, 'slides/src/untrusted.__main__.ts')
const esbuild = join(root, 'slides/node_modules/.bin/esbuild')
const out = join(tmpdir(), `bento-gate-parity-${process.pid}`)

// ---- main's gate, frozen at rig time --------------------------------------
// GIT= lets a machine whose `git` on PATH is a shim point at a real binary
const GIT = process.env.GIT ?? 'git'
const mainSrc = execFileSync(GIT, ['show', 'origin/main:slides/src/untrusted.ts'], { cwd: root, encoding: 'utf8' })
const mainSha = execFileSync(GIT, ['rev-parse', '--short', 'origin/main'], { cwd: root, encoding: 'utf8' }).trim()
writeFileSync(mainCopy, mainSrc)
const bundle = (entry: string, name: string) => {
  const file = join(out, name)
  execFileSync(esbuild, [entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${file}`, '--log-level=error'], { cwd: root })
  return file
}
let branchGate: { sanitizeSlide: (v: unknown) => unknown; sanitizeElement: (v: unknown) => unknown }
let mainGate: typeof branchGate
let compact: { expandDoc: (v: unknown) => { slides: Array<{ elements: unknown[] }> } }
try {
  mkdirSync(out, { recursive: true })
  const b = bundle(join(root, 'slides/src/untrusted.ts'), 'branch.mjs')
  const m = bundle(mainCopy, 'main.mjs')
  const c = bundle(join(root, 'slides/src/compact.ts'), 'compact.mjs')
  branchGate = await import(pathToFileURL(b).href)
  mainGate = await import(pathToFileURL(m).href)
  compact = await import(pathToFileURL(c).href)
} finally {
  if (existsSync(mainCopy)) unlinkSync(mainCopy)
}
console.log(`main's gate frozen from origin/main ${mainSha}\n`)

// ---- fixtures ---------------------------------------------------------------
const box = { x: 10, y: 10, w: 100, h: 50 }
const slides: Array<[string, unknown]> = []
const add = (name: string, slide: unknown) => slides.push([name, slide])

// real decks
const { starterDoc } = await import(pathToFileURL(bundle(join(root, 'slides/src/starterdeck.ts'), 'starter.mjs')).href)
starterDoc().slides.forEach((s: unknown, i: number) => add(`starter/${i}`, s))
for (const f of readdirSync(join(root, 'scripts/fixtures/compact-decks')).filter((f) => f.endsWith('.json'))) {
  JSON.parse(readFileSync(join(root, 'scripts/fixtures/compact-decks', f), 'utf8')).slides.forEach((s: unknown, i: number) => add(`${f}/${i}`, s))
}
for (const f of readdirSync(join(root, 'scripts/fixtures/agent-decks')).filter((f) => f.endsWith('.json'))) {
  compact.expandDoc(JSON.parse(readFileSync(join(root, 'scripts/fixtures/agent-decks', f), 'utf8'))).slides.forEach((s, i) => add(`${f}/${i}`, s))
}

// hostile / edge, in the gate rigs' shapes
const el = (p: Record<string, unknown>) => ({ id: 'e', ...box, ...p })
const hostile: Record<string, unknown>[] = [
  el({ type: 'text', html: 'h', bogus: 1, onclick: 'alert(1)' }),
  el({ type: 'text', html: 'h', fontSize: 'big', opacity: 2, rotation: 'x' }),
  el({ type: 'text', html: 'h', colorGradient: { angle: 90 } }),
  el({ type: 'text', html: 'h', shadow: { x: 1, y: 1 } }),
  el({ type: 'text', html: 'h', fx: { enter: 'fade', step: -1, loop: { kind: 'nope' } } }),
  el({ type: 'text', html: 'h', link: 'javascript:alert(1)' }),
  el({ type: 'text', html: 'h', link: 'https://example.com', themeRefs: { color: 'accent2' } }),
  el({ type: 'text', html: 'h', themeRefs: { color: 'not-a-slot' } }),
  el({ type: 'text' }),
  el({ type: 'shape', shape: 'rect', fill: 'url(https://evil/x.png)', stroke: 'red; }' }),
  el({ type: 'shape', shape: 'arrow', heads: 2 }),
  el({ type: 'shape', shape: 'arrow2' }),
  el({ type: 'shape', shape: 'line', lineEnd: 'diamond-open', lineStart: 'nope' }),
  el({ type: 'shape', shape: 'path', d: 'M0 0 L10 10 <script>' }),
  el({ type: 'shape', shape: 'line', from: { el: 'a', side: 'top' }, to: { el: 'b', side: 'sideways' } }),
  el({ type: 'image', src: 'javascript:alert(1)' }),
  el({ type: 'image', src: 'http://example.com/a.png', crop: { x: 2, y: 0, scale: 0.5 } }),
  el({ type: 'image', src: 'data:image/png;base64,AAAA', crop: { x: 0.5, y: 0.5, scale: 2 }, keepAspectRatio: false }),
  el({ type: 'image', src: 'asset:k', fit: 'stretch' }),
  el({ type: 'media', kind: 'video', src: 'https://example.com/v.mp4', autoplay: 'yes' }),
  el({ type: 'media', kind: 'radio', src: 'asset:m' }),
  el({ type: 'table', columns: [{ w: 1 }], rows: [{ cells: [{ html: 'a', bg: 'url(x)' }] }] }),
  el({ type: 'table', columns: [{ w: 1 }], rows: [{ cells: [{ html: 'a' }] }, { cells: 'nope' }] }),
  el({ type: 'table', columns: [], rows: [] }),
  el({ type: 'chart', option: { series: [{ type: 'bar', data: [1, 2] }], tooltip: { formatter: 'function(){}' } } }),
  el({ type: 'chart', option: 'not an object' }),
  el({ type: 'code', content: 'x', grammarName: 'javascript', themeAssetId: '../x' }),
  el({ type: 'svg', asset: 'k', markup: '<svg onload=alert(1)>' }),
  el({ type: 'embed', doc: { format: 'bento/dash', slides: [] } }),
  el({ type: 'embed', doc: 'https://example.com' }),
  el({ type: 'sparkle' }),
  el({ type: 5 }),
  { type: 'text', ...box, html: 'no id' },
  { type: 'text', id: '', ...box, html: 'empty id' },
  { ['__proto__']: { polluted: true }, type: 'text', id: 'p', ...box, html: 'x' },
  'not an object',
  null,
]
const slideCases: Array<[string, unknown]> = [
  ['plain', { id: 's', elements: hostile }],
  ['gradient background', { id: 'sl', background: 'linear-gradient(180deg, rgba(15,20,27,1) 0%, rgba(30,42,58,1) 100%)', elements: [] }],
  ['url background', { id: 'sl', background: 'url(https://evil.example/beacon.png)', elements: [] }],
  ['unknown slide keys', { id: 'sl', elements: [], bogus: 1, transition: 'spin', hover: { type: 'reveal' }, hidden: 'yes', unnumbered: true }],
  ['comments', { id: 'sl', elements: [], comments: [{ id: 'c', author: 'a', text: 't', at: 'now', replies: [{ id: 'r', author: 'b', text: 'u', at: 'now' }] }, { id: 'bad' }] }],
  ['half hover', { id: 'sl', elements: [], hover: { dim: 0.5 } }],
  ['no id', { elements: [] }],
  ['elements not a list', { id: 'sl', elements: 'nope' }],
  ['too many elements', { id: 'sl', elements: Array.from({ length: 5000 }, (_, i) => el({ id: `e${i}`, type: 'text', html: 'x' })) }],
  ['not an object', 42],
]
for (const [n, s] of slideCases) add(`hostile/${n}`, s)

// ---- compare -----------------------------------------------------------------
const j = (v: unknown) => JSON.stringify(v === undefined ? null : v)
let same = 0, elementsCompared = 0
for (const [name, slide] of slides) {
  const a = j(branchGate.sanitizeSlide(slide))
  const b = j(mainGate.sanitizeSlide(slide))
  if (a === b) same++
  else ok(false, `slide ${name}: branch and main disagree\n    branch: ${a.slice(0, 300)}\n    main:   ${b.slice(0, 300)}`)
  const els = (slide as { elements?: unknown }).elements
  if (Array.isArray(els)) for (const e of els) {
    elementsCompared++
    const ea = j(branchGate.sanitizeElement(e)), eb = j(mainGate.sanitizeElement(e))
    if (ea !== eb) ok(false, `element in ${name}: branch and main disagree\n    branch: ${ea.slice(0, 300)}\n    main:   ${eb.slice(0, 300)}`)
  }
}
ok(same === slides.length, `${same}/${slides.length} slide fixtures byte-identical through both gates (${elementsCompared} elements compared individually)`)
ok(slides.length >= 45 && elementsCompared >= 250, `fixture count: ${slides.length} slides, ${elementsCompared} elements`)
// ---- and with the collector ON: the report may differ, the DOCUMENT must not
const { withDropReport } = branchGate as unknown as { withDropReport: <T>(fn: () => T) => { result: T; dropped: Array<{ path: string }> } }
let sameOn = 0, elementsOn = 0, drops = 0
for (const [name, slide] of slides) {
  const { result, dropped } = withDropReport(() => branchGate.sanitizeSlide(slide))
  drops += dropped.length
  if (j(result) === j(mainGate.sanitizeSlide(slide))) sameOn++
  else ok(false, `slide ${name}: with the collector ON the branch's document differs from main's`)
  const els = (slide as { elements?: unknown }).elements
  if (Array.isArray(els)) for (const e of els) {
    elementsOn++
    const on = withDropReport(() => branchGate.sanitizeElement(e)).result
    if (j(on) !== j(mainGate.sanitizeElement(e))) ok(false, `element in ${name}: with the collector ON the branch's element differs from main's`)
  }
}
ok(sameOn === slides.length, `collector ON: ${sameOn}/${slides.length} slide fixtures still byte-identical to main (${elementsOn} elements individually); ${drops} drops reported along the way`)
ok(drops > 50, 'the report is not empty — the hook observed; it did not decide')
// nesting: an inner report must not truncate the outer one's paths
const nested = withDropReport(() => {
  branchGate.sanitizeSlide({ id: 'outer', elements: [{ type: 'text', id: 'a', ...box, html: 'x', bogus: 1 }] })
  const inner = withDropReport(() => branchGate.sanitizeSlide({ id: 'inner', elements: [{ type: 'text', id: 'b', ...box, html: 'x', bogus2: 1 }] }))
  branchGate.sanitizeSlide({ id: 'outer2', elements: [{ type: 'text', id: 'c', ...box, html: 'x', bogus3: 1 }] })
  return inner
})
ok(nested.result.dropped.length === 1 && nested.result.dropped[0].path === '/elements/0/bogus2', 'a nested report sees only its own drops with a fresh trail')
ok(nested.dropped.length === 2 && nested.dropped.every((d) => /^\/elements\/0\/bogus3?$/.test(d.path)), `the outer report keeps its own two drops with intact paths after the inner one (${nested.dropped.map((d) => d.path).join(', ')})`)

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
