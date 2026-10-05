// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Export coverage: every bento/slides element type is either written to
// PowerPoint (MAPPED) or honestly reported as not yet (NOT_YET). Nothing is
// silently lost, and a type slides adds later cannot slip past the exporter.
//
//   node scripts/test-convert/pptx-coverage.ts
//
// The element types are read from slides/src/model.ts (the SlideElement
// union), not listed here by hand. So when slides adds an element type, this
// rig fails until the exporter has a `case` for it in pptx-write/index.ts
// and the type is listed below.
//
// FOR CONTRIBUTORS: when you write code.ts or embed.ts, this rig is where you
// say so. Move the type from NOT_YET to MAPPED and give it a SAMPLE; the rig
// then requires that it emits a shape with a clean package, and that it no
// longer reports itself unsupported. Your writer's own detailed checks go in
// a rig of its own (pptx-code.ts, say), built on ./_export-harness.ts.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportOne, frame } from './_export-harness.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** A minimal element of each type the exporter writes. */
const SAMPLE: Record<string, object> = {
  text: { type: 'text', html: 'Hello', fontSize: 24, fontFamily: 'Inter, sans-serif', fontWeight: 400,
    color: '#1E2A3A', align: 'left', valign: 'top', lineHeight: 1.2 },
  shape: { type: 'shape', shape: 'rect', fill: '#FF7A59', stroke: '#000000', strokeWidth: 0, radius: 0 },
  image: { type: 'image', fit: 'cover',
    src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
  svg: { type: 'svg', markup: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' },
  chart: { type: 'chart', option: { xAxis: { data: ['A', 'B'] }, yAxis: {}, series: [{ type: 'bar', name: 'S', data: [1, 2] }] } },
  table: { type: 'table', columns: [{ w: 1 }], header: false, rows: [{ cells: [{ html: 'x' }] }], style: { radius: 0 } },
  // media exports its poster as a picture; playback itself is not written yet
  // (reported 'media-dropped' — a contributor task, see CONTRIBUTING.md)
  media: { type: 'media', kind: 'video', src: 'data:video/mp4;base64,AAAA',
    poster: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
}
const MAPPED = Object.keys(SAMPLE)

/** Types with no writer yet. Each is a task a contributor can take; see
 *  convert/CONTRIBUTING.md. Their writers report them dropped. */
const NOT_YET: Record<string, object> = {
  code: { type: 'code', fontSize: 18, fontFamily: 'Menlo, monospace', align: 'left', valign: 'top',
    lineHeight: 1.4, color: '#1E2A3A', content: 'let x = 1\nx += 1' },
  embed: { type: 'embed', app: 'bento/dash', view: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' },
}

// --- what slides says exists -------------------------------------------------
const model = fs.readFileSync(path.join(root, 'slides/src/model.ts'), 'utf8')
const union = /export type SlideElement =([^;]*?)(?:\n\n|\n\/\*\*|\nexport )/.exec(model)?.[1] ?? ''
const ifaceNames = [...union.matchAll(/\b([A-Z]\w*Element)\b/g)].map((m) => m[1])
const typeOf = (iface: string): string | undefined =>
  new RegExp(`export interface ${iface}\\b[^{]*\\{[^}]*?\\btype: '([a-z]+)'`).exec(model)?.[1]
const modelTypes = ifaceNames.map(typeOf)

console.log('every element type slides defines is accounted for')
ok(ifaceNames.length >= 9 && modelTypes.every(Boolean),
  `read ${ifaceNames.length} element types from slides' SlideElement union (${modelTypes.join(', ')})`)
const index = fs.readFileSync(path.join(root, 'convert/src/pptx-write/index.ts'), 'utf8')
const cases = new Set([...index.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]))
for (const t of modelTypes as string[]) {
  const listed = MAPPED.includes(t) ? 'MAPPED' : t in NOT_YET ? 'NOT_YET' : ''
  ok(cases.has(t) && listed !== '',
    `'${t}': ${cases.has(t) ? 'has a case in pptx-write/index.ts' : 'NO case in pptx-write/index.ts'}, ${listed || 'listed in neither MAPPED nor NOT_YET in this rig'}`)
}
for (const t of [...MAPPED, ...Object.keys(NOT_YET)])
  ok((modelTypes as string[]).includes(t), `'${t}' still exists in slides' model`)

// cNvPr ids above 1: the spTree's own group is 1, so any id ≥ 2 is an element
const shapesIn = (xml: string) => [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].filter((m) => m[1] !== '1').length

console.log('mapped types emit a shape and a clean package')
for (const t of MAPPED) {
  const r = await exportOne(SAMPLE[t])
  ok(r.problems.length === 0 && shapesIn(r.slideXml) === 1 && !r.codes.has('element-unsupported'),
    `${t}: one shape, nothing wrong with the package${r.problems.length ? ` (${r.problems.join('; ')})` : ''}`)
}

console.log('not-yet types are reported, never silently lost')
for (const [t, el] of Object.entries(NOT_YET)) {
  const r = await exportOne(el)
  const said = r.report.entries.find((e) => e.code === 'element-unsupported' && e.detail.includes(`'${t}'`))
  ok(!!said && shapesIn(r.slideXml) === 0 && r.problems.length === 0,
    `${t}: reported dropped ("${said?.detail ?? 'NO REPORT'}"), no shape, the rest of the package clean`)
}

console.log('a type nobody has heard of')
{
  const r = await exportOne({ type: 'hologram' })
  ok(r.codes.has('element-unsupported') && r.problems.length === 0,
    'an unknown future element type degrades to a report entry; the export still succeeds')
}

console.log(`\nopen for contributors: ${Object.keys(NOT_YET).join(', ')}`)
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
