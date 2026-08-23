#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The starter workbook — the first ten seconds, and for most people the last.
//
//   node scripts/test-dash-starter.ts     (Node ≥ 23.6 strips types natively)
//
// WHY THIS EXISTS. The starter ships INSIDE the shell: it is what bento.page
// shows and what every downloaded copy opens with. Nothing guarded it, and it
// is the one document in the repo that a stranger is guaranteed to see.
//
// Two families of check, and the second is the one that will actually catch
// something:
//
//   1. IT MUST BE A VALID, SELF-CONSISTENT WORKBOOK. A starter that trips
//      `validateDoc` ships the app's own warning banner to every new reader on
//      first open, which is worse than a plain grid.
//   2. THE NUMBERS ON SCREEN MUST BE RIGHT. The Scratch sheet reads across into
//      the dataset by ADDRESS — `Pipeline!D1:D8` — so the cross-sheet sums are
//      silently wrong if anybody reorders, inserts or hides a column over
//      there. Nothing about that is visible in a diff of `starter.ts`: the
//      columns array changes and two numbers on another sheet quietly start
//      describing the wrong data. So the addresses are pinned BY COLUMN NAME,
//      and the totals are computed through the shipping code and compared to
//      arithmetic done here.
//
// It also pins what the starter is FOR. It opens with one sheet of each kind
// because the difference between them is the thing to teach first, and a
// regression to "one table again" would pass every other rig in this repo.

import { registerHooks } from 'node:module'
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

import { readFileSync } from 'node:fs'
const { starterDoc } = await import('../dash/src/starter.ts')
const { parseDoc } = await import('../dash/src/model.ts')
const { validateDoc } = await import('../dash/src/validate.ts')
const { recalc } = await import('../dash/src/formula.ts')
const { recalcWorkbook, workbookSources, cellKey } = await import('../dash/src/cellformula.ts')

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const doc: any = starterDoc()
const pipeline: any = doc.sheets[0]
const scratch: any = doc.sheets[1]

console.log('1 · a workbook the app will not complain about')
{
  ok(parseDoc(JSON.stringify(doc)).ok, 'the starter parses as a bento/dash document')
  const findings = validateDoc(doc).findings
  ok(findings.length === 0,
    `and the validator is silent — a starter that trips it ships a warning banner to every ` +
    `new reader${findings.length ? ': ' + findings.map((f: any) => f.code).join(', ') : ''}`)
  ok(doc.docId !== starterDoc().docId,
    'each starter mints its own docId — a shared one would make recovery restore a stranger’s work')
  const a = starterDoc() as any
  a.sheets[0].data.value.v[0] = 999999
  ok((starterDoc() as any).sheets[0].data.value.v[0] === 12400,
    'and editing one starter does not reach the next — the arrays are copied, not handed out')
}

console.log('\n2 · one sheet of EACH KIND, which is the whole lesson')
{
  ok(doc.sheets.length === 2, 'the starter has two sheets')
  ok(pipeline.kind === 'table', 'the first is a DATASET — typed by column')
  ok(scratch.kind === 'canvas', 'the second is a SPREADSHEET — typed by cell, unbounded')
  ok(pipeline.name === 'Pipeline' && scratch.name === 'Scratch', 'and they are named for what they are for')
  // Pipeline first is not arbitrary: preview.ts renders page one into the shell
  // for file-manager thumbnails, and a grid of real numbers says more at 200px
  // than a sheet of labels.
  ok(doc.sheets[0].kind === 'table', 'the DATASET is first, because that is what the file thumbnail draws')
}

console.log('\n3 · the things a spreadsheet cannot do, actually doing something')
{
  const col = (id: string) => pipeline.columns.find((c: any) => c.id === id)
  ok(col('weighted')?.formula === 'value * prob',
    'a COLUMN formula — one expression for the column, not one per row filled down')
  ok(pipeline.data.weighted === undefined,
    'and it stores no values, so the bytes and the declaration cannot disagree')
  ok(pipeline.totals?.value === 'sum' && pipeline.totals?.weighted === 'sum',
    'a totals row that is a column PROPERTY, so it cannot fall out of range when a row is appended')
  ok(col('stage')?.validate?.kind === 'list',
    'a validation list on Stage — the column three people would otherwise spell three ways')
  ok(col('stage')?.validate?.on !== 'reject',
    'and it WARNS rather than rejects, because a reject on apply can discard a peer’s committed edit')
  ok(Array.isArray(pipeline.condfmt?.value) && pipeline.condfmt.value[0].kind === 'cellValue',
    'a conditional format of the most-used kind there is — highlight over a number')
  ok(pipeline.steps?.[0]?.op === 'import',
    'and a provenance step, so the sheet answers "where did this come from?" from the first second')
}

console.log('\n4 · THE NUMBERS. Computed through the shipping code, checked against arithmetic')
{
  const VALUE = [12400, 8200, 15600, 4300, 9100, 22750, 6400, 18300]
  const PROB = [1, 0.4, 1, 0.25, 0, 1, 0.6, 1]
  const total = VALUE.reduce((a, b) => a + b, 0)
  const weightedTotal = VALUE.reduce((a, v, i) => a + v * PROB[i], 0)

  const r: any = recalc(pipeline)
  ok(r.cycles.length === 0, 'the column formula is not in a cycle')
  const w = r.values.get('weighted') ?? []
  ok(Math.round(w.reduce((a: number, b: number) => a + (b as number), 0)) === Math.round(weightedTotal),
    `the Weighted column sums to ${Math.round(weightedTotal)}`)

  // THE ADDRESS CHECK. The Scratch sums name columns by POSITION, so this
  // asserts which column each letter is — by NAME, so a reorder fails here
  // rather than silently re-pointing two numbers on another sheet.
  const letter = (i: number) => String.fromCharCode(65 + i)
  const nameAt = (l: string) => pipeline.columns[l.charCodeAt(0) - 65]?.name
  ok(nameAt('D') === 'Value', `Pipeline!D is still Value (it is ${nameAt('D')})`)
  ok(nameAt('G') === 'Weighted', `Pipeline!G is still Weighted (it is ${nameAt('G')})`)
  ok(letter(pipeline.columns.findIndex((c: any) => c.id === 'value')) === 'D',
    'and the Scratch sheet’s D1:D8 therefore covers the eight deals, not seven and a heading')

  const rc: any = recalcWorkbook(workbookSources(doc), doc.modified)
  const cv = rc.get('sheet-scratch')
  const at = (a1: string) => cv?.values.get(cellKey(Number(a1.slice(1)) - 1, a1.charCodeAt(0) - 65))
  ok(at('B4') === total, `=SUM(Pipeline!D1:D8) is ${total}, the real total`)
  ok(Math.round(at('B5') as number) === Math.round(weightedTotal),
    `=SUM(Pipeline!G1:G8) is ${Math.round(weightedTotal)}, reading the COMPUTED column across sheets`)
  ok(Math.abs((at('B6') as number) - weightedTotal / total) < 1e-9, '=B5/B4 is the confidence ratio')
  // The gap must be POSITIVE. At a 60,000 target the weighted pipeline already
  // beat it and the row read "Gap to target −£17,245" — arithmetically right,
  // and it reads as a mistake in the first ten seconds, which is the only
  // ten seconds this document gets.
  ok((at('B10') as number) > 0,
    `"Gap to target" is positive (${Math.round(at('B10') as number)}) — a negative gap reads as a bug`)
}

console.log('\n5 · a wrapped cell in a tall row shows all of its text')
{
  // FOUND BY BUILDING THIS DOCUMENT, which is the argument for a starter that
  // uses the app rather than demonstrating it.
  //
  // The grid sets `line-height` to the ROW HEIGHT so one line sits centred in a
  // tall row. On a WRAPPED cell that becomes the height of every line: the
  // sentence in D1 measured 165px of content inside a 55px box and lines two
  // and three were not on screen at all. Nothing looked broken — the first line
  // rendered and stopped mid-sentence, which reads as text that was too long
  // rather than a layout that ate it.
  //
  // Row heights predate wrapping and each is right alone; they had simply never
  // met. Checked on the source because the collision is in the emitted style.
  const grid = readFileSync(new URL('../dash/src/grid.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  ok(/if \(h !== ROW_H && !cell\?\.wrap\)/.test(grid),
    'a tall row only pins line-height when the cell does NOT wrap')
  ok(/else if \(cell\?\.wrap\)/.test(grid),
    'and a wrapped cell gets normal leading instead, so every line is visible')

  const d1: any = (starterDoc() as any).sheets[1].cells.D1
  ok(d1?.wrap === true, 'the starter’s explanatory cell wraps rather than being trimmed to fit')
  ok(((starterDoc() as any).sheets[1].rows ?? {})['1'] > 40,
    'and its row is tall enough to hold the wrapped lines')
  ok(d1.v.length > 90,
    'the sentence is written for meaning, not tuned to a pixel width — it has to survive ' +
    'seven translations of the UI around it and a reader who enlarged their font')
}

console.log('\n6 · it stays small, because it is bytes in every shell')
{
  const bytes = JSON.stringify(doc).length
  ok(bytes < 8000, `the starter is ${bytes} bytes — boot was fought from 952ms to 93ms and this is on that path`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
