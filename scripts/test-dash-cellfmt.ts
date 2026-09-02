#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Per-cell APPEARANCE on BOTH kinds of sheet — the dataset half especially.
//
//   node scripts/test-dash-cellfmt.ts     (Node ≥ 23.6 strips types natively)
//
// scripts/test-dash-cellprops.ts already covers the SPREADSHEET kind's cell
// types and its nine coercion rules. This rig is about the thing those rules
// are deliberately NOT about: appearance, which both kinds now carry, and the
// boundary that keeps appearance from becoming a type on the kind that is
// typed by its COLUMN.
//
// WHAT THIS PROVES, and why each failure is invisible without it:
//
//   1. A BOLD THAT CHANGED A NUMBER. On a dataset, appearance rides in the
//      same `cells` overlay as HAND CORRECTIONS — the record of where a human
//      disagreed with the imported data. Every reader of that overlay asks
//      `'v' in over` rather than "is there an override", so an appearance-only
//      entry must be inert to totals, pipelines, previews and exports. If one
//      writer ever spreads a `v` into an appearance patch, a formatting click
//      silently becomes a data edit that every replica converges on. So the
//      rig sums a column through `sourceOf` before and after bolding every
//      cell in the sheet, and asserts the number did not move.
//
//   2. A PATTERN THAT RECAST A VALUE. The same-looking Pattern control means
//      two different things on the two kinds: on a spreadsheet it declares
//      what the cell IS (and rules 6–8 re-read the value); on a dataset the
//      COLUMN says what the cell is and the pattern is display only. A dataset
//      pattern that quietly re-read values would be per-cell typing through
//      the back door — the one thing the two-kinds design exists to prevent.
//
//   3. TWENTY UNDO STEPS. Formatting a selection is ONE edit to the person who
//      did it. test-dash-cellprops.ts pins this for the spreadsheet kind; the
//      dataset kind has to match, or ⌘Z leaves a selection half-formatted.
//
//   4. AN OVERLAY THAT GREW FOR NOTHING. A control applied to cells it does
//      not change must write NOTHING. On this kind the cost is worse than
//      size: validate.ts reports overrides as hand corrections, so forty inert
//      entries are forty false findings about data nobody touched.
//
//   5. A FILE AN OLDER BUILD DAMAGED. Every field added here is optional and
//      absent-means-off (PLATFORM §3). A build that has never heard of
//      `underline` must round-trip a file carrying it untouched.
//
//   6. A BOLD THAT ATE A COLLABORATOR'S CORRECTION. An override is TWO CRDT
//      registers now (`o␟col` content, `q␟col` presentation — the split
//      docs/dash-collab.md §6.9 already made for the spreadsheet kind). As one
//      register, bolding a cell while somebody else retyped it kept whichever
//      landed second and lost the other, with both replicas' sync states in
//      perfect agreement about it.
//
//   7. AN OVERRIDE THAT SURVIVED ITS ROW'S RESURRECTION ON ONE REPLICA ONLY.
//      Found while building 6, and older than it: `applyOvr` has always
//      refused an override older than the row's birth, but nothing swept the
//      overrides ALREADY IN THE DOCUMENT when the rebirth arrived.
//
// Everything below calls a PURE function or drives the real `Store`/`DashSync`.
// There is no DOM: `buildAppearanceSection` is the only export this rig does
// not touch, and it contains no decision — it reads a cell and calls the
// functions that are checked here.

import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'

// cellfmt.ts imports the panel stylesheet, which is Vite's job and not Node's —
// the same stub test-dash-cellprops.ts uses, for the same reason.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const {
  APPEARANCE_FIELDS, appearanceCss, appearancePatch, applyAppearance, effectiveFormat,
  normaliseEdges, overrideFormatPatch, overrideKeys, ridAt, sameCell, toggleTarget,
} = await import('../dash/src/cellfmt.ts')
const { stylePatch } = await import('../dash/src/cellprops.ts')
const { parseDoc } = await import('../dash/src/model.ts')
const { Store, applyPatch } = await import('../dash/src/store.ts')
const { sourceOf } = await import('../dash/src/steps.ts')
const { keyToAction } = await import('../dash/src/select.ts')
const { DashSync } = await import('../dash/src/sync/crdt.ts')

type Patch = import('../dash/src/store.ts').Patch
type DashDoc = import('../dash/src/model.ts').DashDoc
type TableSheet = import('../dash/src/model.ts').TableSheet
type CanvasSheet = import('../dash/src/model.ts').CanvasSheet
type Column = import('../dash/src/model.ts').Column
type CellRange = import('../dash/src/cellfmt.ts').CellRange
type Op = import('../dash/src/sync/crdt.ts').Op

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/**
 * Key-ORDER-independent serialization, which is what "converged" means here.
 *
 * A merged cell is rebuilt half by half, so two replicas that won opposite
 * halves store the same fields in a different insertion order. Both spreadsheet
 * halves have always had this property (`cvMerge` does the same thing, and
 * scripts/test-dash-canvassync.ts compares the same way), and it is the same
 * concession the dictionary encoding already makes: replicas agree on VALUES,
 * not on bytes.
 */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

/** A four-row dataset with a number column worth totalling. */
const fresh = (extra: Record<string, unknown> = {}): DashDoc => {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 'test',
    sheets: [{
      id: 'sh1', name: 'S', kind: 'table',
      rids: [[1, 4]],
      nextRid: 5,
      columns: [
        { id: 'region', name: 'Region', type: 'text' },
        { id: 'amount', name: 'Amount', type: 'number', format: '#,##0' },
      ],
      data: {
        region: { enc: 'raw', v: ['North', 'South', 'North', 'South'] },
        amount: { enc: 'raw', v: [10, 20, 30, 40] },
      },
      steps: [{ op: 'import', from: 'q3.csv', at: '2026-08-03T00:00:00Z', rows: 4 }],
      ...extra,
    }],
  }))
  return r.doc
}

const table = (d: DashDoc): TableSheet => d.sheets[0] as TableSheet
const cols = (d: DashDoc): Column[] => table(d).columns
const at = (r: number, c: number): CellRange =>
  ({ anchor: { row: r, col: c }, head: { row: r, col: c } })
const box = (r0: number, c0: number, r1: number, c1: number): CellRange =>
  ({ anchor: { row: r0, col: c0 }, head: { row: r1, col: c1 } })
const content = (d: DashDoc): string => {
  const { modified: _m, ...rest } = d as unknown as Record<string, unknown>
  return JSON.stringify(rest)
}

// ============================================================ the vocabulary

console.log('\nthe vocabulary — one list, two interfaces, and nothing outside it')
{
  // model.ts spells the appearance fields TWICE (once in CanvasCell, once in
  // CellOverride) on purpose: those interfaces are the FORMAT, and a field
  // reachable only through an `extends` two screens away is a field a reader
  // of the file misses. The cost of that choice is that the two can drift —
  // which is precisely the release-note gap this whole change closes, so it
  // would be a poor joke to reintroduce it one layer down. This is the check
  // an `extends` would have bought.
  const src = readFileSync(new URL('../dash/src/model.ts', import.meta.url), 'utf8')
  const bodyOf = (name: string): string => {
    const start = src.indexOf(`export interface ${name} {`)
    return start < 0 ? '' : src.slice(start, src.indexOf('\n}', start))
  }
  const canvas = bodyOf('CanvasCell')
  const override = bodyOf('CellOverride')
  ok(canvas.length > 0 && override.length > 0, 'both cell interfaces are found in model.ts')
  const missing = APPEARANCE_FIELDS.filter((f) =>
    !new RegExp(`\\b${f}\\?:`).test(canvas) || !new RegExp(`\\b${f}\\?:`).test(override))
  ok(missing.length === 0,
    `every appearance field is declared on BOTH CanvasCell and CellOverride${missing.length ? ` — missing ${missing.join(', ')}` : ''}`)
  const optional = APPEARANCE_FIELDS.every((f) =>
    new RegExp(`\\b${f}\\?:`).test(canvas) && new RegExp(`\\b${f}\\?:`).test(override))
  ok(optional, 'and every one is OPTIONAL — absent means off, which is what makes old files render as before')
}
{
  ok(applyAppearance({ v: 5 }, { bold: true })?.bold === true, 'setting a field writes it')
  ok(applyAppearance({ v: 5, bold: true }, { bold: null })?.bold === undefined,
    'clearing DELETES the key rather than storing false')
  ok(applyAppearance({ v: 5, bold: true }, { bold: false })?.bold === undefined,
    '`false` clears too — a stored `bold: false` says what absence already says')
  ok(JSON.stringify(applyAppearance({ bold: true }, { bold: null })) === 'null',
    'a cell left with nothing at all is null — the sparse overlay never holds an empty object')
  // THE TYPE BOUNDARY, mechanically. cellfmt.ts writes through this function,
  // so a caller that passes `v` cannot smuggle a value edit into a formatting
  // patch even by accident.
  const smuggled = applyAppearance({ bold: true }, { v: 99, f: '=SUM(A1)' } as never)
  ok(smuggled !== null && smuggled.v === undefined && smuggled.f === undefined,
    'a key outside APPEARANCE_FIELDS is IGNORED — appearance cannot be a back door to a value')
  ok(sameCell(null, undefined) && !sameCell(null, { bold: true }), 'sameCell: absent equals absent')
}
{
  ok(toggleTarget([{ bold: true }, { bold: true }], 'bold') === false,
    'every cell already bold → ⌘B turns it OFF')
  ok(toggleTarget([{ bold: true }, undefined], 'bold') === true,
    'a mixed selection turns it ALL ON, so the keystroke does not depend on where the drag started')
  ok(toggleTarget([], 'bold') === true, 'an empty selection is harmless')
}

// ============================================================ painting

console.log('\npainting — the one CSS answer both grids need')
{
  ok(appearanceCss(undefined) === '' && appearanceCss({}) === '',
    'a cell with no appearance emits NOTHING — the common row costs no string')
  const css = appearanceCss({ bold: true, italic: true, underline: true, wrap: true })
  ok(css.includes('font-weight:600') && css.includes('font-style:italic') &&
    css.includes('text-decoration:underline') && css.includes('white-space:normal'),
    'bold, italic, underline and wrap each emit their declaration')
  const b = appearanceCss({ border: 'tb', borderStyle: 'dashed', borderColor: '#112233' })
  ok(b.includes('border-top:1px dashed #112233') && b.includes('border-bottom:1px dashed #112233') &&
    !b.includes('border-left'), 'borders paint exactly the edges the string names, in the style named')
  ok(normaliseEdges('LBx') === 'bl' && normaliseEdges(7) === '',
    'an edge string is normalised to known edges in a fixed order, and a non-string is no edges')
  // A DOCUMENT IS UNTRUSTED INPUT (PLATFORM, and the kernel's rule since #277).
  // These values are concatenated into a style="" attribute, so a colour that
  // is not a colour is a stylesheet somebody else wrote.
  const evil = appearanceCss({ bg: 'red;background:url(http://x)', color: 'expression(1)' })
  ok(evil === '', 'a colour that is not #rrggbb is DROPPED, not interpolated into the style attribute')
}

// ============================================================ dataset keys

console.log('\naddressing — a dataset selection is <colId>:<rid>, not a position')
{
  const d = fresh()
  const s = table(d)
  ok(ridAt(s, undefined, 0) === 1 && ridAt(s, undefined, 3) === 4, 'row index → rid, unsorted')
  ok(ridAt(s, [3, 2, 1, 0], 0) === 4, 'and through the view\'s order vector, which is what the grid shows')
  ok(ridAt(s, undefined, 9) === -1, 'past the end is -1, not a rid nobody has')

  ok(JSON.stringify(overrideKeys(s, undefined, cols(d), [box(0, 0, 1, 1)])) ===
    '["region:1","amount:1","region:2","amount:2"]',
    'a 2×2 selection is four keys in reading order')
  // THE HIDDEN-COLUMN TRAP. The selection counts PAINTED positions, so passing
  // the full column list where a column is hidden lands every write one column
  // to the left — a bold on the wrong data, silently.
  const visible = cols(d).filter((c) => c.id !== 'region')
  ok(JSON.stringify(overrideKeys(s, undefined, visible, [at(0, 0)])) === '["amount:1"]',
    'column 0 of a sheet whose first column is hidden is the SECOND column')
  ok(overrideKeys(s, undefined, cols(d), [box(0, 0, 99, 99)]).length === 8,
    'a selection running past the data yields only the cells that exist — a dataset ends')
  const dup = overrideKeys(s, undefined, cols(d), [at(0, 0), at(0, 0)])
  ok(dup.length === 1, 'overlapping ranges yield each key once — a repeat would build the inverse from a value already replaced')
}

// ============================================================ one patch, one undo

console.log('\none patch, one undo — the rule the spreadsheet kind already keeps')
{
  const store = new Store(fresh())
  const s = table(store.doc)
  const keys = overrideKeys(s, undefined, cols(store.doc), [box(0, 0, 3, 1)])
  ok(keys.length === 8, 'eight cells selected')
  const before = content(store.doc)
  const p = appearancePatch(s, keys, { bold: true, bg: '#fff3cd' })
  ok(p !== null && p.op === 'setOverrides' && (p as { keys: string[] }).keys.length === 8,
    'formatting eight cells is ONE setOverrides patch')
  store.commit(p as Patch)
  ok(Object.keys(table(store.doc).cells ?? {}).length === 8, 'and all eight carry it')
  store.undo()
  ok(content(store.doc) === before,
    'ONE undo puts the document back byte-for-byte — including dropping the `cells` container that never existed')
}
{
  // SPARSENESS. A control that changes nothing must write nothing, or the
  // overlay grows entries that validate.ts will report as hand corrections.
  const d = fresh()
  const keys = overrideKeys(table(d), undefined, cols(d), [box(0, 0, 3, 1)])
  ok(appearancePatch(table(d), keys, { align: null }) === null,
    'clearing a field nobody set writes NOTHING at all')
  applyPatch(d, appearancePatch(table(d), keys, { bold: true }) as Patch)
  ok(appearancePatch(table(d), keys, { bold: true }) === null,
    'and setting what is already there writes nothing either')
  const half = appearancePatch(table(d), keys, { bold: null })
  ok(half !== null && (half as { keys: string[] }).keys.length === 8, 'un-bolding all eight is one patch')
  applyPatch(d, half as Patch)
  ok(table(d).cells === undefined || Object.keys(table(d).cells).length === 0,
    'un-bolding removes the entries entirely — the file returns to the one before anyone bolded')
}

// ============================================================ appearance is not type

console.log('\nappearance is not type — the line this kind cannot cross')
{
  // (1) The number the pipeline reads must not move when every cell is bolded.
  const d = fresh()
  const sum = (doc: DashDoc): number => {
    const vec = sourceOf(table(doc)).vec('amount')
    return (vec ?? []).reduce((a: number, v: unknown) => a + (typeof v === 'number' ? v : 0), 0)
  }
  const before = sum(d)
  const keys = overrideKeys(table(d), undefined, cols(d), [box(0, 0, 3, 1)])
  applyPatch(d, appearancePatch(table(d), keys, {
    bold: true, italic: true, underline: true, wrap: true, align: 'center',
    color: '#112233', bg: '#fff3cd', border: 'trbl', borderColor: '#445566', borderStyle: 'dotted',
  }) as Patch)
  ok(Object.keys(table(d).cells ?? {}).length === 8, 'every cell now carries every appearance field')
  ok(sum(d) === before && before === 100,
    'and the column still totals 100 — an appearance-only override carries no `v`, so `sourceOf` skips it')
  const anyValue = Object.values(table(d).cells ?? {}).some((o) => 'v' in (o as object))
  ok(!anyValue, 'not one of the eight overrides has a `v` in it')

  // (2) The COLUMN still says what the cells are. Nothing above touched type.
  ok(cols(d).every((c) => c.type === (c.id === 'amount' ? 'number' : 'text')),
    'the column types are untouched — appearance never writes to a column')
}
{
  // A dataset PATTERN is display only. The spreadsheet kind's `formatPatch`
  // re-reads the value (rules 6-8); this one must not, or per-cell typing has
  // arrived on the kind whose whole claim is that the column decides.
  const d = fresh()
  applyPatch(d, {
    op: 'setOverrides', sheet: 'sh1', keys: ['amount:1'],
    v: [{ v: '1,234', why: 'restated' }], dropEmpty: true,
  } as Patch)
  applyPatch(d, overrideFormatPatch(table(d), ['amount:1'], '0.00%') as Patch)
  const cell = table(d).cells!['amount:1']
  ok(cell.v === '1,234', 'applying a pattern to a dataset cell does NOT re-read its value')
  ok(cell.format === '0.00%', 'it stamps the pattern')
  ok(cell.why === 'restated', 'and leaves the hand correction and its provenance alone')
}
{
  // A pattern equal to the column's own is stored as ABSENCE: an override that
  // repeats what the column already says means nothing, and would later read
  // as a cell mysteriously refusing to follow a change to the column format.
  const d = fresh()
  ok(overrideFormatPatch(table(d), ['amount:1'], '#,##0') === null,
    'a pattern identical to the column\'s writes nothing')
  applyPatch(d, overrideFormatPatch(table(d), ['amount:1'], '0.00') as Patch)
  ok(effectiveFormat(table(d), 'amount:1') === '0.00', 'a cell pattern wins over the column\'s')
  ok(effectiveFormat(table(d), 'amount:2') === '#,##0', 'and a cell without one falls back to the column\'s')
  applyPatch(d, overrideFormatPatch(table(d), ['amount:1'], undefined) as Patch)
  ok(table(d).cells === undefined, 'clearing it removes the override completely')
}

// ============================================================ the same gesture, both kinds

console.log('\nthe same gesture on both kinds')
{
  ok(JSON.stringify(keyToAction({ key: 'b', metaKey: true })) === '{"kind":"style","field":"bold"}',
    '⌘B is a style action in the ONE key map, so the shortcut card describes it without anyone writing the row')
  ok(keyToAction({ key: 'i', ctrlKey: true })?.kind === 'style', 'ctrl+I too — the map folds the two modifiers')
  ok(keyToAction({ key: 'u', metaKey: true })?.kind === 'style', '⌘U as well')
  ok(keyToAction({ key: 'b' }) === null, 'and a bare "b" still types a "b" into the cell')
}
{
  // The canvas writer and the dataset writer are different functions over the
  // same vocabulary. Both must produce the same SHAPE of change, or the two
  // kinds have drifted again one layer below the panel.
  const canvas: CanvasSheet = { id: 'c1', name: 'S', kind: 'canvas', cells: { A1: { v: 1 } } } as CanvasSheet
  const cp = stylePatch(canvas, ['A1'], { italic: true, border: 'b' })
  ok(cp !== null && cp.op === 'setCanvasCells', 'the spreadsheet kind writes italic and a border through the same edit type')
  const cell = (cp as { cells: Record<string, Record<string, unknown>> }).cells.A1
  ok(cell.italic === true && cell.border === 'b' && cell.v === 1,
    'and it keeps the value beside the new appearance')
  ok(stylePatch(canvas, ['A1'], { v: 99 } as never) === null,
    'the canvas writer refuses a non-appearance key too — one guard, both kinds')
}

// ============================================================ additivity

console.log('\nformat additivity — an older build must not damage a newer file')
{
  // PLATFORM §3. `parseDoc` is the door every file comes through, and the
  // `[extra: string]: unknown` index signature on both cell shapes is what
  // makes an unknown field survive it. The stand-in for "a build that does not
  // know these fields" is a document carrying a field NO build knows, run
  // through the same door beside the real ones.
  const withFields = {
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 'test',
    sheets: [{
      id: 'sh1', name: 'S', kind: 'table', rids: [[1, 2]], nextRid: 3,
      columns: [{ id: 'amount', name: 'Amount', type: 'number' }],
      data: { amount: { enc: 'raw', v: [10, 20] } },
      cells: {
        'amount:1': {
          v: 42, why: 'restated',
          bold: true, italic: true, underline: true, wrap: true, align: 'center',
          color: '#112233', bg: '#fff3cd', border: 'trbl', borderColor: '#445566',
          borderStyle: 'dotted', format: '0.00',
          strikethrough: true,          // a field from a build that does not exist yet
        },
      },
      steps: [],
    }, {
      id: 'c1', name: 'Model', kind: 'canvas',
      cells: { A1: { v: 1, underline: true, border: 'b', vibe: 'loud' } },
    }],
  }
  const first = parseDoc(JSON.stringify(withFields))
  const round = parseDoc(JSON.stringify(first.doc))
  const ov = (table(round.doc).cells ?? {})['amount:1'] as Record<string, unknown>
  ok(ov !== undefined && ov.underline === true && ov.borderStyle === 'dotted' && ov.wrap === true,
    'every new appearance field survives parse → serialize → parse on the dataset kind')
  ok(ov.strikethrough === true,
    'and so does a field this build has never heard of — which is what says an OLDER build keeps ours')
  const cv = (round.doc.sheets[1] as CanvasSheet).cells.A1 as Record<string, unknown>
  ok(cv.underline === true && cv.border === 'b' && cv.vibe === 'loud',
    'same on the spreadsheet kind')
  ok(JSON.stringify(first.doc.sheets) === JSON.stringify(round.doc.sheets),
    'the second trip changes nothing at all — the round trip is a fixed point')
  ok((first.findings ?? []).every((f) => f.code !== 'bad-override-key' && f.code !== 'orphan-override'),
    'and validate raises no finding about an override that carries only appearance')
}
{
  // The other direction: a file written BEFORE any of this must render exactly
  // as it did. Absent means off, everywhere.
  const old = fresh()
  ok(appearanceCss(old.sheets[0].cells?.['amount:1']) === '',
    'a document with no overlay produces no styling at all')
  ok(table(old).cells === undefined, 'and no overlay is created by reading one')
}

// ============================================================ collaboration

console.log('\ncollaboration — an override is two registers, not one')

/** Two replicas over one document, delivered by hand so the order is the test. */
function pair(): {
  a: { sync: InstanceType<typeof DashSync>; doc: DashDoc; out: Op[] }
  b: { sync: InstanceType<typeof DashSync>; doc: DashDoc; out: Op[] }
  commit(who: 'a' | 'b', p: Patch): void
  deliver(from: 'a' | 'b', to: 'a' | 'b'): void
} {
  const base = fresh()
  const mk = (id: string) => {
    const sync = new DashSync(id)
    const doc = clone(base)
    sync.adopt(doc)
    return { sync, doc, out: [] as Op[] }
  }
  const a = mk('a')
  const b = mk('b')
  const side = { a, b }
  return {
    a, b,
    commit(who, p) {
      const r = side[who]
      r.out.push(...r.sync.local(r.doc, [p]))
      applyPatch(r.doc, p)
      r.sync.settle(r.doc)
    },
    deliver(from, to) {
      const ops = side[from].out.splice(0)
      side[to].sync.apply(side[to].doc, clone(ops))
      // the sender keeps its own copy of what it sent, for a later replay
      side[from].out.push()
      side[to].sync.settle(side[to].doc)
    },
  }
}

{
  // THE CASE THE SPLIT EXISTS FOR. Concurrently: A bolds a cell, B retypes it.
  // As one register the second delivery threw one of the two away — and both
  // replicas' sync states agreed about it, so nothing anywhere said so.
  const p = pair()
  p.commit('a', appearancePatch(table(p.a.doc), ['amount:1'], { bold: true }) as Patch)
  p.commit('b', {
    op: 'setOverrides', sheet: 'sh1', keys: ['amount:1'],
    v: [{ v: 99, why: 'restated' }], dropEmpty: true,
  } as Patch)
  p.deliver('a', 'b')
  p.deliver('b', 'a')
  const ca = (table(p.a.doc).cells ?? {})['amount:1'] as Record<string, unknown> | undefined
  const cb = (table(p.b.doc).cells ?? {})['amount:1'] as Record<string, unknown> | undefined
  ok(stable(ca) === stable(cb), 'the two replicas converge')
  ok(ca?.bold === true && ca?.v === 99,
    'bolding a cell while somebody else retypes it keeps BOTH — the content and presentation halves are independent registers')
  ok(ca?.why === 'restated', 'and the correction\'s provenance rides with the value it is about')
}
{
  // The other half of the same claim: the halves are independent, not merged
  // field by field. Two people setting DIFFERENT appearance fields is still
  // one register, so one of the two wins — stated here so nobody reads the
  // check above as promising more than it does.
  const p = pair()
  p.commit('a', appearancePatch(table(p.a.doc), ['amount:1'], { bold: true }) as Patch)
  p.commit('b', appearancePatch(table(p.b.doc), ['amount:1'], { italic: true }) as Patch)
  p.deliver('a', 'b')
  p.deliver('b', 'a')
  const ca = (table(p.a.doc).cells ?? {})['amount:1'] as Record<string, unknown> | undefined
  const cb = (table(p.b.doc).cells ?? {})['amount:1'] as Record<string, unknown> | undefined
  ok(stable(ca) === stable(cb),
    'two concurrent appearance edits to one cell converge (last writer wins the whole presentation half)')
}
{
  // A pure appearance write must claim ONLY the presentation register, or it
  // re-asserts a value the author never touched. Checked on the wire.
  const p = pair()
  p.commit('a', {
    op: 'setOverrides', sheet: 'sh1', keys: ['amount:1'],
    v: [{ v: 7, why: 'restated' }], dropEmpty: true,
  } as Patch)
  p.a.out.splice(0)
  p.commit('a', appearancePatch(table(p.a.doc), ['amount:1'], { bold: true }) as Patch)
  const op = p.a.out[0] as unknown as { op: string; m: number[] }
  ok(op.op === 'ovr' && op.m[0] === 2,
    'a bold claims the presentation half ONLY (mask 2) — it never re-asserts the value')
  p.a.out.splice(0)
  p.commit('a', {
    op: 'setOverrides', sheet: 'sh1', keys: ['amount:1'],
    v: [{ ...(table(p.a.doc).cells ?? {})['amount:1'], v: 8 }], dropEmpty: true,
  } as Patch)
  const op2 = p.a.out[0] as unknown as { m: number[] }
  ok(op2.m[0] === 1, 'and retyping the value claims the content half only, even though the payload is whole')
}
{
  // AN OVERRIDE DOES NOT SURVIVE ITS ROW'S RESURRECTION. `applyOvr` has always
  // refused an override older than the row's birth; this is the same rule for
  // the overrides ALREADY IN THE DOCUMENT when the rebirth lands, which is the
  // half that was missing. Without it the write survives on whoever heard it
  // before the resurrection and vanishes everywhere else — identical sync
  // states, one workbook with an extra hand correction.
  //
  // Built by hand rather than left to the fuzzer because it needs a delete
  // that LOSES to a newer insert, which is a narrow interleaving.
  const p = pair()
  // A writes an override on row 1 and keeps it to itself for now.
  p.commit('a', appearancePatch(table(p.a.doc), ['amount:1'], { bold: true }) as Patch)
  p.commit('a', {
    op: 'setOverrides', sheet: 'sh1', keys: ['amount:1'],
    v: [{ ...(table(p.a.doc).cells ?? {})['amount:1'], v: 5 }], dropEmpty: true,
  } as Patch)
  // B deletes row 1 and undoes the delete — a resurrection, newer than A's writes.
  p.commit('b', { op: 'deleteRows', sheet: 'sh1', rids: [1] } as Patch)
  p.commit('b', {
    op: 'insertRows', sheet: 'sh1', rids: [1], at: [0], values: { amount: [10], region: ['North'] },
  } as Patch)
  p.deliver('b', 'a')
  p.deliver('a', 'b')
  const ca = (table(p.a.doc).cells ?? {})['amount:1']
  const cb = (table(p.b.doc).cells ?? {})['amount:1']
  ok(stable(ca ?? null) === stable(cb ?? null),
    'a row resurrected under an override converges — the rebirth supersedes it on BOTH replicas')
  ok(ca === undefined, 'and the answer is that the override is gone, which is what applyOvr already told late arrivals')
}
{
  // THE SWEEP, and the interleaving it takes to need one.
  //
  // The case above is repaired inside the STASH (the row's death parked the
  // override, and the replay weighs it against the rebirth). This one is the
  // other road: the override is sitting in the DOCUMENT, on a row that is
  // LIVE, when a newer resurrection of that row arrives. It takes two
  // concurrent resurrections to reach — the first makes the row live again,
  // the write lands on it, and the second out-stamps the first.
  //
  // Without `supersedeRowOverrides` the write survives on whoever applied it
  // before the second resurrection and is refused (by `applyOvr`'s own birth
  // gate) by whoever heard the resurrection first. Nothing in the sync state
  // differs: same registers, same births, same tombs, one workbook with an
  // extra hand correction on a row that was rebuilt underneath it.
  const base = fresh()
  const mk = (id: string) => {
    const sync = new DashSync(id)
    const doc = clone(base)
    sync.adopt(doc)
    return { id, sync, doc, out: [] as Op[] }
  }
  const A = mk('A')      // deletes the row, then writes the override
  const B = mk('B')      // resurrects it first
  const C = mk('C')      // resurrects it again, concurrently, and wins
  const all = [A, B, C]
  const emit = (r: typeof A, p: Patch) => {
    const ops = r.sync.local(r.doc, [p])
    applyPatch(r.doc, p)
    r.sync.settle(r.doc)
    return clone(ops)
  }
  const give = (r: typeof A, ops: Op[]) => { r.sync.apply(r.doc, clone(ops)); r.sync.settle(r.doc) }

  const del = emit(A, { op: 'deleteRows', sheet: 'sh1', rids: [1] } as Patch)
  give(B, del); give(C, del)
  const rB = emit(B, {
    op: 'insertRows', sheet: 'sh1', rids: [1], at: [0], values: { amount: [10], region: ['North'] },
  } as Patch)
  give(A, rB)            // A's row is live again, under B's rebirth
  const ov = emit(A, appearancePatch(table(A.doc), ['amount:1'], { bold: true }) as Patch)
  ok(((table(A.doc).cells ?? {})['amount:1'] as { bold?: boolean } | undefined)?.bold === true,
    'the override lands on a row that is live on its author')
  give(B, ov)            // B applies it to a live row too, on B's own rebirth

  // C works on unrelated cells for a while, so ITS resurrection is minted at a
  // higher lamport than A's override without C ever having heard of it. That
  // ordering is the whole case: a rebirth that LOSES to the override must not
  // sweep it, and this is the one that wins.
  const fromC: Op[] = []
  for (let i = 0; i < 6; i++) {
    fromC.push(...emit(C, { op: 'setCells', sheet: 'sh1', col: 'amount', rids: [3], v: [100 + i] } as Patch))
  }
  fromC.push(...emit(C, {
    op: 'insertRows', sheet: 'sh1', rids: [1], at: [0], values: { amount: [10], region: ['North'] },
  } as Patch))
  give(C, ov)            // C already holds the LATER rebirth: its birth gate refuses the override
  give(A, fromC); give(B, fromC); give(C, rB)

  const seen = all.map((r) => stable((table(r.doc).cells ?? {})['amount:1'] ?? null))
  ok(seen[0] === seen[1] && seen[1] === seen[2],
    'two concurrent resurrections of one row: every replica agrees about the override written between them')
  ok(seen[0] === 'null',
    'and the winning rebirth SWEEPS it, exactly as applyOvr refuses one that arrives late — an assignment that only filters later ops is not an assignment')
  ok(all.every((r) => stable(r.sync.toJSON().regs) === stable(A.sync.toJSON().regs)),
    'with identical registers on all three, which is why this cannot be found by comparing sync state')
}

// --- the grid actually PAINTS it ---------------------------------------------
//
// Everything above proves `appearanceCss` computes the right declaration. None
// of it proved the grid ever CALLS it — and measured, it did not have to:
// deleting BOTH `st += appearanceCss(…)` lines from grid.ts's two paint loops
// left every check in this file, and in test-dash-cellprops.ts, green. The
// feature would have been invisible on screen with CI reporting success.
//
// That is a shape this repo has shipped before. `--accent-ink` was a token the
// stylesheet never declared: the class was applied, the rule was dead, and the
// check that "covered" it asserted the class rather than the colour. A unit
// test of a pure function tests the function, not the feature.
//
// So these mount the REAL Grid over the DOM shim the a11y rig uses and read the
// emitted markup. It cannot say a cell LOOKS bold — only that the declaration
// reached the element, which is exactly the link the checks above skip.
{
  const { installDom } = await import('./lib/dash-dom.ts')
  const { Grid } = await import('../dash/src/grid.ts')
  const dom = installDom()

  const paintHtml = (doc: DashDoc, sheetId: string): string => {
    const host = dom.doc.createElement('div')
    dom.doc.body.appendChild(host)
    const grid = new Grid({ el: host as never, store: new Store(doc), sheetId })
    const scroll = host.querySelector('.dg-scroll')!
    scroll.clientHeight = 600
    scroll.clientWidth = 900
    grid.paint()
    return host.innerHTML
  }

  // DATASET — the kind that could carry no appearance at all until this change.
  {
    const doc = fresh({ cells: { 'amount:1': { bold: true, italic: true, color: '#b3261e' } } })
    const html = paintHtml(doc, 'sh1')
    ok(/font-weight:\s*600/.test(html),
      'a dataset cell marked bold emits font-weight — the GRID calls appearanceCss, not only the rig')
    ok(/#b3261e/i.test(html), 'and its colour reaches the element')
    ok(/font-style:\s*italic/.test(html), 'and italic, which the dataset kind could not carry before at all')
  }

  // SPREADSHEET — the same vocabulary through the OTHER paint loop. Two loops
  // with two ideas of what "bold" means is how the kinds drifted the first time.
  {
    const r = parseDoc(JSON.stringify({
      format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 'test',
      sheets: [{ id: 'cv1', name: 'Scratch', kind: 'canvas',
        cells: { A1: { v: 1, bold: true, underline: true } } }],
    }))
    const html = paintHtml(r.doc, 'cv1')
    ok(/font-weight:\s*600/.test(html), 'a spreadsheet cell marked bold emits font-weight from the other paint loop')
    ok(/underline/.test(html), 'and underline, which neither kind carried before')
  }

  // Nothing set must emit nothing: appearance is applied AFTER a conditional
  // format, so a non-additive implementation would silently erase one.
  {
    const html = paintHtml(fresh(), 'sh1')
    ok(!/font-weight:\s*600/.test(html) && !/font-style:\s*italic/.test(html),
      'and a sheet with no appearance emits none of it — or appearance would overwrite conditional formats')
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
