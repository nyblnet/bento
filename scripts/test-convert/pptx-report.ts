// @bundle — reaches slides' model and maths scanner, whose imports are extensionless
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// What a person learns from an export, and the typefaces PowerPoint is told
// to use:
//   · foldReport/slideRange: one line per kind of loss, dropped first, with
//     the slides it happened on ("slides 3, 5–7"), the whole deck named as such;
//   · formulas are reported (maths-as-source) using slides' own scanner, so
//     prose with dollar signs is not;
//   · the deck's own fonts are named as not embedded;
//   · document JSON exports like a .bento.html;
//   · typefaceOf: CSS generics and one-platform system fonts are skipped.

import { foldReport, slideRange, type FidelityReport } from '../../convert/src/report.ts'
import { bentoToPptx } from '../../convert/src/export.ts'
import { typefaceOf } from '../../convert/src/pptx-write/fonts.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

console.log('slide ranges')
for (const [nums, want] of [
  [[4], 'slide 4'], [[3, 5, 6, 7], 'slides 3, 5–7'], [[2, 3], 'slides 2, 3'],
  [[7, 1, 2, 3, 3], 'slides 1–3, 7'], [[], ''],
] as Array<[number[], string]>) ok(slideRange(nums) === want, `${JSON.stringify(nums)} → "${want}" (got "${slideRange(nums)}")`)

console.log('folding')
{
  const report: FidelityReport = {
    counts: { carried: 1, approximated: 3, dropped: 2 }, provenance: {},
    entries: [
      { code: 'a', verdict: 'approximated', where: 'slide 2', detail: 'A', count: 1 },
      { code: 'a', verdict: 'approximated', where: 'slide 3', detail: 'A', count: 2 },
      { code: 'd', verdict: 'dropped', where: 'document', detail: 'D', count: 1 },
      { code: 'd', verdict: 'dropped', where: 'slide 9', detail: 'D', count: 1 },
      { code: 'c', verdict: 'carried', where: 'slide 1', detail: 'C', count: 1 },
    ],
  }
  const f = foldReport(report)
  ok(f.length === 2 && f[0].code === 'd' && f[1].code === 'a', 'one line per code, dropped first, carried left out')
  ok(f[1].count === 3 && f[1].where === 'slides 2, 3', `counts add up and the slides are kept (${f[1].count}, "${f[1].where}")`)
  ok(f[0].where === 'slide 9; the whole deck', `deck-level and slide-level places both show ("${f[0].where}")`)
}

console.log('typefaces')
for (const [stack, want] of [
  ["'Instrument Sans', 'Helvetica Neue', sans-serif", 'Instrument Sans'],
  ["ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace", 'Consolas'],
  ["ui-monospace, 'SF Mono', Menlo, monospace", 'Courier New'],
  ['system-ui, -apple-system, sans-serif', 'Arial'],
  ['Georgia, serif', 'Georgia'],
  ['serif', 'Times New Roman'],
  ['Menlo', 'Menlo'],
  ['', 'Arial'],
] as Array<[string, string]>) ok(typefaceOf(stack) === want, `${JSON.stringify(stack)} → ${want} (got ${typefaceOf(stack)})`)

console.log('the report, through a real export of document JSON')
const docWith = (elements: unknown[], extra: object = {}) => JSON.stringify({
  format: 'bento/slides', version: 1, title: 'Rig', size: { width: 1280, height: 720 },
  theme: { background: '#ffffff', color: '#1e2a3a', accent: '#ff7a59', fontFamily: 'Inter, sans-serif' },
  slides: [
    { id: 's1', background: '#ffffff', elements: [] },
    { id: 's2', background: '#ffffff', elements },
  ],
  ...extra,
})
const text = (id: string, html: string) => ({
  type: 'text', id, x: 80, y: 80, w: 600, h: 100, rotation: 0, opacity: 1, html,
  fontSize: 24, fontFamily: 'Inter, sans-serif', fontWeight: 400, color: '#1e2a3a', align: 'left', valign: 'top', lineHeight: 1.2,
})
{
  let r: Awaited<ReturnType<typeof bentoToPptx>> | null = null
  let why = ''
  try { r = await bentoToPptx(docWith([text('t1', 'Roots: $$ax^2 + bx + c = 0$$')])) } catch (e) { why = (e as Error).message }
  ok(!!r && r.bytes.length > 1000, `document JSON exports, no .bento.html around it${why ? ` (refused: ${why})` : ''}`)
  const m = r ? foldReport(r.report).find((e) => e.code === 'maths-as-source') : undefined
  ok(!!m && m.where === 'slide 2', `a formula is reported, on its slide (${m ? m.where : 'NOT REPORTED'})`)
  // The counter IS slides' scanner, so it agrees with the app by construction:
  // prices are prose, an escaped \$ is literal. (Together in one run, the
  // scanner pairs "$10, and \$" as a formula — the app's behaviour, filed
  // with slides, and mirrored here rather than second-guessed.)
  for (const p of ['It costs $5 and $10', 'and \\$x\\$ is literal']) {
    const prose = await bentoToPptx(docWith([text('t1', p)]))
    ok(!prose.report.entries.some((e) => e.code === 'maths-as-source'), `prose is not reported as a formula: ${JSON.stringify(p)}`)
  }
}
{
  const r = await bentoToPptx(docWith([], { fonts: [{ family: 'Fraunces', asset: 'f1' }, { family: 'Fraunces', asset: 'f2' }] }))
  const e = r.report.entries.find((x) => x.code === 'fonts-not-embedded')
  ok(!!e && /Fraunces/.test(e.detail) && (e.detail.match(/Fraunces/g) ?? []).length === 1,
    `the deck's own fonts are named once each (${e?.detail ?? 'NOT REPORTED'})`)
  const none = await bentoToPptx(docWith([]))
  ok(!none.report.entries.some((x) => x.code === 'fonts-not-embedded'), 'no own fonts, no entry')
}
{
  let msg = ''
  try { await bentoToPptx('{"format": "bento/slides", ') } catch (e) { msg = (e as Error).message }
  ok(/does not parse/.test(msg), `broken JSON is refused in plain words (${msg})`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
