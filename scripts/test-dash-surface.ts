#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash GRID SURFACE rig — the sheet is an object, and the ground is not rows.
//
//   node scripts/test-dash-surface.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. At 1440x900 the starter workbook's eight rows filled the top
// 180px and the remaining two thirds of the window was blank paper, the same
// white as the sheet, edge to edge. Nothing on screen distinguished "the table
// ended here" from "the app stopped drawing", and the second reading is the one
// people had.
//
// The fix is NOT more rows — `scripts/test-dash-frontier.ts` guards the decision
// that the lattice stops at the data and one appender sits below it, and every
// check there still holds. The fix is that a DATASET is drawn as an object with
// an extent, lying on a ground that is visibly not the sheet. Each check below
// guards a way that can quietly come undone:
//
//   1. THE GROUND HAS TO BE A DIFFERENT COLOUR FROM THE PAPER. --desk is the
//      whole mechanism; delete it or point it at --bg and the app is back to
//      one white field with a table dissolved into it. So both halves are
//      MEASURED against --bg rather than merely required to be present — a
//      "different" colour that is 1.02:1 away is the same colour.
//   2. THE OBJECT HAS TO SHRINK-WRAP. `.dg-table` was a plain block, so it
//      stretched to the window and its paper bled to both edges no matter what
//      the ground behind it was. `width: max-content` plus the right/bottom
//      edges is what makes the columns end somewhere.
//   3. THE GROUND MUST NEVER BE RULED. A gradient, a repeat, a band or a fade
//      under the last row draws rows that are not there, which is precisely the
//      lie the frontier work removed. Flat colour, or nothing.
//   4. THE TWO KINDS MUST STAY DIFFERENT. A spreadsheet is unbounded — it
//      reports its size to ARIA as unknown — so a bounding box round it would
//      claim an extent the kind does not have. `.dg-canvas` puts the full bleed
//      back, and if that override is lost the product's own argument stops
//      being visible in the one place it is easiest to see.
//   5. THE EMPTY STATES HAVE TO SAY SOMETHING. Three screens that cannot
//      explain themselves by showing their contents, and all three used to be a
//      rectangle of nothing. Each now names its kind and its next gesture — and
//      in a READ-ONLY workbook the gesture is replaced rather than offered,
//      the same rule `frontierRow` already follows.
//   6. AND NONE OF IT MAY COST PER-ROW WORK. The note is ONE node, built once
//      in `build()` and updated in place; a 5,000-row sheet must still paint a
//      window's worth of rows and exactly one (hidden) note.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'

registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'dash/src/styles.css'), 'utf8')
/** the stylesheet with its prose removed — every check below reads CODE */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '')

const { installDom } = await import('./lib/dash-dom.ts')
type El = import('./lib/dash-dom.ts').El

const dom = installDom()

const { parseDoc } = await import('../dash/src/model.ts')
const { Store } = await import('../dash/src/store.ts')
const { Grid } = await import('../dash/src/grid.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc

let failures = 0
let checks = 0
function ok(cond: unknown, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// --------------------------------------------------------------- css helpers

/** The declaration block of the FIRST rule whose selector list matches exactly. */
function rule(selector: string): string | null {
  for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].trim().replace(/\s+/g, ' ') === selector) return m[2]
  }
  return null
}

/** Every `--name: value;` declared anywhere in a :root block. */
function tokens(): Map<string, string> {
  const out = new Map<string, string>()
  for (const block of code.matchAll(/(^|\})\s*([^{}]*:root[^{}]*)\{([\s\S]*?)\n\}/gm)) {
    for (const m of block[3].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim())
  }
  return out
}

/** Both halves of a `light-dark(a, b)` token, as hex. */
function pair(name: string): [string, string] {
  const v = tokens().get(name)
  if (!v) throw new Error(`${name} is not declared`)
  const m = /^light-dark\(\s*([^,]+),\s*([^)]+)\)/.exec(v)
  return m ? [m[1].trim(), m[2].trim()] : [v.trim(), v.trim()]
}

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// ------------------------------------------------- 1 · the ground is not the paper

console.log('\nthe dataset lies on a ground that is not its own paper')

{
  const scroll = rule('.dg-scroll')
  ok(scroll && /background:\s*var\(--desk\)/.test(scroll),
    'the scroller — everything around and below the sheet — is painted with --desk')

  const t = tokens()
  ok(t.has('--desk'), '--desk is declared in the palette, with both of its halves')
  ok(/^light-dark\(/.test(t.get('--desk') ?? ''),
    'and it varies by theme, so the desk is not a light-mode-only idea')

  // The measurement is the check. "A different token" is satisfied by a token
  // whose value happens to equal --bg, and that renders as the defect.
  const [dl, dd] = pair('--desk')
  const [bl, bd] = pair('--bg')
  for (const [d, b, theme] of [[dl, bl, 'light'], [dd, bd, 'dark']] as const) {
    const r = contrast(d, b)
    ok(r >= 1.1,
      `${theme}: the desk is a visible step from the sheet — ${r.toFixed(2)}:1 against --bg, floor 1.10`)
  }

  // ONE RULE for both halves: the desk is one step FURTHER from the paper than
  // the chrome band is. On light that means darker, on dark lighter — and if
  // the two ever stop being monotone the app has three greys with no order.
  const [pl, pd] = pair('--panel')
  ok(luminance(bl) > luminance(pl) && luminance(pl) > luminance(dl),
    'light: paper → chrome → desk descends in luminance, so the three grounds are ordered')
  ok(luminance(bd) < luminance(pd) && luminance(pd) < luminance(dd),
    'dark: the same order, inverted — the same inversion --grid-line and --panel already make')

  // The empty-state note is the only thing that ever lands on the desk.
  for (const [ink, floor, what] of [['--ink', 4.5, 'the note heading'], ['--muted', 4.5, 'the note body']] as const) {
    const [il, id] = pair(ink)
    for (const [i, d, theme] of [[il, dl, 'light'], [id, dd, 'dark']] as const) {
      const r = contrast(i, d)
      ok(r >= floor, `${theme}: ${what} — ${ink} on --desk is ${r.toFixed(2)}:1, floor ${floor}`)
    }
  }
}

// ------------------------------------------------------ 2 · the object has edges

console.log('\nand it is an object with an extent, not a page that stopped')

{
  const table = rule('.dg-table')
  ok(table && /(^|[;\s])width:\s*max-content/.test(table),
    'the table SHRINK-WRAPS. As a plain block it stretched to the window and its ' +
    'paper bled to both edges, which is what made the columns stop in mid-air')
  ok(table && /min-width:\s*max-content/.test(table),
    'and it still keeps its min-width, so a wide sheet scrolls rather than squashing')
  ok(table && /background:\s*var\(--bg\)/.test(table),
    'the paper is stated on the table itself, now that the scroller behind it is not white')
  ok(table && /border-right:\s*1px solid var\(--line-strong\)/.test(table) &&
    /border-bottom:\s*1px solid var\(--line-strong\)/.test(table),
    'the RIGHT and BOTTOM edges are drawn — the two sides where a dataset\'s ' +
    'extent is a claim. Top-left is the grid\'s origin and has no desk beside it')
  ok(table && /margin-bottom:/.test(table),
    'and there is ground under it even when the sheet is taller than the window')
}

// --------------------------------------------- 3 · the ground is never ruled

console.log('\nthe ground is plain, and can never be mistaken for rows')

{
  const scroll = rule('.dg-scroll') ?? ''
  ok(!/gradient|repeat|background-image/.test(scroll),
    'the desk is FLAT COLOUR. A gradient, a repeat or a fade under the last row ' +
    'would draw rows that do not exist — the exact lie the frontier work removed, ' +
    're-told one layer further out')
  const note = rule('.dg-note') ?? ''
  ok(!/gradient|repeat/.test(note), 'and the empty-state note does not rule anything either')
  // …and no rule in the whole grid section reaches for a raw colour.
  for (const sel of ['.dg-scroll', '.dg-table', '.dg-note', '.dg-note b', '.dg-note-float',
    '.dg-canvas .dg-scroll', '.dg-canvas .dg-table']) {
    const body = rule(sel)
    ok(body !== null, `${sel} exists`)
    ok(!/#[0-9a-f]{3,8}\b|\brgba?\(/i.test(body ?? ''),
      `${sel} states no raw colour — every one of them resolves through the palette`)
  }
}

// ------------------------------------------------- 4 · the two kinds differ

console.log('\nthe spreadsheet kind keeps its full bleed, because its extent is a frontier')

{
  const cvScroll = rule('.dg-canvas .dg-scroll')
  ok(cvScroll && /background:\s*var\(--bg\)/.test(cvScroll),
    'a SPREADSHEET has no desk: its grid is unbounded and reports its size to ARIA ' +
    'as unknown, so a ground behind it would be a ground behind nothing')
  ok(cvScroll && !/var\(--desk\)/.test(cvScroll),
    'and it names a different token from the dataset — the kinds are not the same surface')
  const cvTable = rule('.dg-canvas .dg-table')
  ok(cvTable && /width:\s*auto/.test(cvTable),
    'its table stretches again, so the lattice reaches the window edge as Excel\'s does')
  ok(cvTable && /border-right:\s*0/.test(cvTable) && /border-bottom:\s*0/.test(cvTable),
    'and it draws NO bounding edges — a border round a frontier is a bound the kind ' +
    'does not have')
}

// --------------------------------------------------------------- fixtures

function dataset(rows: number, colCount = 2, readOnly = false): DashDoc {
  const columns = ['region', 'value'].slice(0, colCount)
    .map((id) => ({ id, name: id, type: id === 'value' ? 'number' : 'text' }))
  const data: Record<string, unknown> = {}
  for (const c of columns) {
    data[c.id] = { enc: 'raw', v: Array.from({ length: rows }, (_, i) => (c.id === 'value' ? i : `R${i}`)) }
  }
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
    readonly: readOnly || undefined,
    sheets: [{
      id: 's1', name: 'Sales', kind: 'table', columns,
      rids: rows ? [[1, rows]] : [], data,
    }],
  }))
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.findings)}`)
  return r.doc
}

function spreadsheet(cells: Record<string, unknown>): DashDoc {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 't',
    sheets: [{ id: 's1', name: 'Sheet', kind: 'canvas', cells }],
  }))
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.findings)}`)
  return r.doc
}

function mount(doc: DashDoc, opts: { readOnly?: boolean } = {}) {
  const host = dom.doc.createElement('div')
  dom.doc.body.appendChild(host)
  const store = new Store(doc)
  if (opts.readOnly) store.readOnly = true
  const grid = new Grid({ el: host as never, store, sheetId: 's1' })
  const scroll = host.querySelector('.dg-scroll')!
  scroll.clientHeight = 600
  scroll.clientWidth = 900
  grid.paint()
  return { host, store, grid, scroll }
}

const note = (host: El): El => host.querySelector('.dg-note')!

// ------------------------------------------------------- 5 · the empty states

console.log('\nthe three empty states say which kind they are and what to do next')

{
  const { host } = mount(dataset(8))
  ok(note(host).hidden,
    'a sheet WITH rows says nothing — the desk under it is the whole statement, and ' +
    'a permanent caption under every table would be furniture nobody asked for')
}

{
  const { host } = mount(dataset(0, 2))
  const n = note(host)
  ok(!n.hidden, 'a dataset with NO ROWS shows a note rather than a heading strip and silence')
  ok(n.textContent.includes('no rows'), 'it names the state — "This dataset has no rows"')
  ok(/\+ above/.test(n.textContent),
    'and points at the appender that is already on screen, which is the next gesture')
  ok(n.querySelectorAll('b').length === 1,
    'a heading and a body, not one grey paragraph — the heading is what gets read')
}

{
  const { host } = mount(dataset(0, 0))
  const n = note(host)
  ok(!n.hidden, 'a dataset with NO COLUMNS shows one too — and this is the emptiest screen ' +
    'in the app: no appender either, because frontierRow correctly refuses one when ' +
    'there is nothing to type into')
  ok(n.textContent.includes('no columns'), 'it names that state, and not the row one')
  ok(/typed by column/.test(n.textContent),
    'and teaches the kind — this is the only moment the reader has nothing else to look at')
}

{
  const { host } = mount(spreadsheet({}))
  const n = note(host)
  ok(!n.hidden, 'a brand-new SPREADSHEET shows one over its lattice')
  ok(n.textContent.includes('typed by cell') && n.textContent.includes('=SUM('),
    'and says the opposite thing about types, because it is the opposite kind')
  ok(n.className.includes('dg-note-float'),
    'floating, not in flow: this kind has no desk and its content box is a thousand rows tall')
}

{
  const { host } = mount(spreadsheet({ A1: { v: 1 } }))
  ok(note(host).hidden, 'one cell is enough to make a spreadsheet not empty')
}

{
  const { host } = mount(dataset(0, 2), { readOnly: true })
  const n = note(host)
  ok(!n.hidden && n.textContent.includes('no rows'),
    'READ-ONLY: the state is still named — a reader is owed the fact')
  ok(!/\+ above/.test(n.textContent) && n.textContent.includes('read-only'),
    'but the INVITATION is replaced, not offered. "Type here" in a workbook that ' +
    'refuses every keystroke is the same lie frontierRow refuses to tell')
}

{
  // The note must also go away again — it is updated in place, not rebuilt, so
  // a stale one would simply stay on screen over a sheet that now has rows.
  const { host, grid } = mount(dataset(0, 2))
  ok(!note(host).hidden, 'empty to start')
  grid.sel.moveTo(0, 0)
  grid.typeInto('x')
  grid.paint()
  ok(note(host).hidden, 'and it clears the moment the first row exists')
  ok(note(host).innerHTML === '',
    'and it is EMPTIED as well as hidden. A note that only loses its attribute keeps ' +
    'its old sentence in the DOM, where a screen reader and a find-in-page still ' +
    'read a state the sheet has left')
}

// -------------------------------------------- 6 · none of this costs per-row work

console.log('\nand none of it is paid for per row')

{
  const { host, grid } = mount(dataset(5000))
  const rows = host.querySelectorAll('.dg-row').length
  ok(rows > 0 && rows < 80,
    `a 5,000-row sheet still paints a WINDOW of rows (${rows}), not a sheet of them`)
  ok(host.querySelectorAll('.dg-note').length === 1,
    'and exactly one note node exists, whatever the sheet is')
  ok(note(host).hidden, 'hidden, because the sheet is not empty')

  // Built ONCE. If a paint ever recreated it the identity would change, and the
  // per-paint cost would have quietly become per-paint DOM construction.
  const before = note(host)
  grid.paint()
  grid.paint()
  ok(note(host) === before,
    'the same node survives repeated paints — it is updated in place, never rebuilt')
  ok(before.innerHTML === '',
    'and a hidden note holds no markup, so nothing is serialized for a state nobody sees')
}

console.log('\nnothing elsewhere cancels the shrink-wrap')
{
  // THE HALF THAT WAS SILENTLY CANCELLED. `width: max-content` shrink-wraps the
  // dataset horizontally, and 700 lines further down `.dg-table { min-height:
  // 100% }` was still forcing it to the full height of the scroller. So the
  // object ended where its columns ended and ran to the BOTTOM OF THE WINDOW:
  // measured at 1440x900 with the starter open, 521px of white paper past the
  // last row, with the "bottom edge" drawn at the foot of the viewport instead
  // of under the data. Half a fix, looking from one side like a whole one.
  //
  // That rule outlived its reason. It was written so `paintEmptyGrid`'s lattice
  // could reach the bottom — behaviour the FRONTIER work deliberately removed
  // from the table kind, because rows that are not there must not be drawn. It
  // is still right for the canvas kind, whose grid genuinely does not end.
  //
  // Checked as text rather than layout: `scripts/lib/dash-dom.ts` is a parser
  // and a node tree, not a layout engine, so it cannot measure a rendered
  // height. What it CAN pin is that no unscoped rule sets a minimum height on
  // the shrink-wrapped element, which is the exact shape of the regression.
  const sheet = readFileSync(new URL('../dash/src/styles.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  for (const rule of sheet.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const sel = rule[1].trim()
    if (!/(^|,|\s)\.dg-table\b/.test(sel)) continue
    if (/\.dg-canvas/.test(sel)) continue
    ok(!/min-height\s*:\s*100%/.test(rule[2]),
      `"${sel}" must not force the dataset table to full height — that cancels the ` +
      'shrink-wrap and the paper bleeds to the bottom of the window')
  }
  ok(/\.dg-canvas\s+\.dg-table\s*\{[^}]*min-height:\s*100%/.test(sheet),
    'and the SPREADSHEET kind still fills the scroller, because its grid really does not end')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
