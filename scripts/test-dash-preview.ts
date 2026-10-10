#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash first-sheet preview rig.
//
//   node scripts/test-dash-preview.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Every save writes a static rendering of the first sheet
// into the shell so file managers can thumbnail the workbook (kernel/src/save.ts
// for the placement, dash/src/preview.ts for the drawing). Everything about
// that feature fails SILENTLY — nobody proofreads markup they cannot see — and
// none of it is recoverable once files are on disk:
//
//   1. THE ENCRYPTION VETO. A `bento/enc` workbook must never carry a plaintext
//      rendering of its first sheet. Getting this wrong publishes real rows of
//      real numbers beside the ciphertext that exists to hide them, in every
//      password-protected workbook ever saved, and the owner has no way to
//      notice. The kernel owns the real gate (two independent signals, one of
//      which a provider cannot see); dash repeats the half it CAN see, and this
//      pins that it still does.
//   2. THE OUTPUT REFUSAL. The preview is drawn from author data — cell values,
//      column names, the sheet name, the title. A script tag reaching the file
//      unbalances it and breaks the frozen splice contract every shipped
//      updater relies on (PLATFORM §2).
//   3. CSS INJECTION, which is the refusal HTML escaping does not cover. Theme
//      colours are author data too and they land inside a `<style>` block,
//      where `}` ends a rule and `<` means nothing. A workbook whose accent is
//      `#fff}body{display:none` would otherwise ship a preview that blanks the
//      page it sits in — or, with `url(…)`, one that phones home from a file
//      the reader believed was self-contained (PLATFORM §1).
//   4. NUMBERS NOBODY COMPUTED. Formula columns store an expression, not
//      values. Past the recalculation ceiling the preview must draw them EMPTY
//      — never 0, never a stale figure. A partial totals row is the same
//      failure with a bigger audience: it is dash's answer to `=SUM(B2:B41)`
//      falling out of range, so a total computed over the sixteen rows the
//      thumbnail happens to draw would put exactly that bug into the picture.
//   5. THE BYTE BUDGET, which is paid in every saved file and cannot be
//      compressed (the audience never runs the loader). It must hold against
//      adversarial content, and the last tier must be reachable — a budget with
//      no terminating fallback is an infinite loop or an overrun.
//
// Laying the page out and fitting it to a viewport need a DOM and are verified
// in a browser and against the real macOS thumbnailer (`qlmanage -t`). Every
// check below is a pure decision, so it gets pinned here where a regression
// costs one CI run instead of one release. `scripts/test-preview.ts` is the
// slides counterpart and covers the kernel gate itself.

import { previewAllowed, previewIsSafe, setEncryptionPassword } from '../kernel/src/save.ts'
import { previewMarkup, cssColor, byteLength, PREVIEW_BUDGET } from '../dash/src/preview.ts'
import { FORMAT, FORMAT_VERSION, type DashDoc, type Sheet } from '../dash/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) {
    failures++
    console.error(`  ✗ ${msg}`)
  } else {
    console.log(`  ✓ ${msg}`)
  }
}

// Never write these literals (AGENTS.md #1): this file is not bundled, but the
// fixtures need them as data, and the habit is the rule.
const SCRIPT_OPEN = '<scr' + 'ipt>'
const SCRIPT_CLOSE = '</scr' + 'ipt>'
const NOSCRIPT_CLOSE = '</nosc' + 'ript>'

const wb = (sheets: Sheet[], extra: Partial<DashDoc> = {}): DashDoc => ({
  format: FORMAT,
  version: FORMAT_VERSION,
  docId: 'doc-test',
  title: 'Q3 pipeline',
  sheets,
  ...extra,
} as DashDoc)

const simple = (): Sheet => ({
  id: 'sh1',
  name: 'Pipeline',
  kind: 'table',
  rids: [[1, 3]],
  columns: [
    { id: 'region', name: 'Region', type: 'text' },
    { id: 'value', name: 'Value', type: 'money', format: '£#,##0' },
  ],
  data: {
    region: { enc: 'dict', dict: ['North', 'South'], idx: [0, 1, 0] },
    value: { enc: 'raw', v: [12400, 8200, 15600] },
  },
  steps: [],
})

/**
 * Run a check that might THROW, and turn a throw into a failed check.
 *
 * A rig that dies mid-run reports one crash and leaves everything after it
 * unverified — which is what happened the first time the no-sheets guard was
 * deliberately removed: the degenerate-document checks took the process down
 * and the whole "scope" section silently stopped existing.
 */
const attempt = <T>(fn: () => T): T | 'threw' => {
  try { return fn() } catch { return 'threw' }
}

const markup = (doc: DashDoc): string => {
  const html = previewMarkup(doc)
  if (html === null) throw new Error('expected a preview, got none')
  return html
}

// --- 1. the encryption veto -------------------------------------------------

console.log('\nencryption veto')

setEncryptionPassword(null)
ok(previewMarkup(wb([simple()])) !== null, 'a plain workbook previews')

setEncryptionPassword('hunter2')
ok(previewMarkup(wb([simple()])) === null,
  'an active password vetoes the preview at the provider, not only at the kernel')

setEncryptionPassword(null)
ok(previewMarkup(wb([simple()])) !== null, 'clearing the password restores the preview')

// The other half of the gate is the kernel's and dash cannot see it — a
// provider is handed a document, never the block that will be written. Pinned
// here so the pairing is visible from dash's side too.
const ENVELOPE = JSON.stringify({
  format: 'bento/enc', v: 1, it: 300000, salt: 'c2FsdA==', iv: 'aXY=', data: 'ZGF0YQ==',
})
ok(previewAllowed(ENVELOPE) === false,
  'the kernel still vetoes an already-encrypted body with no password flag set')

// --- 2. the output refusal --------------------------------------------------

console.log('\noutput refusal')

ok(previewIsSafe(markup(wb([simple()]))) === true, 'an ordinary workbook produces safe markup')

const hostile = (): Sheet => ({
  id: 'sh1',
  name: `Sheet ${SCRIPT_CLOSE}`,
  kind: 'table',
  rids: [[1, 2]],
  columns: [
    { id: 'a', name: `${SCRIPT_OPEN}alert(1)${SCRIPT_CLOSE}`, type: 'text' },
    { id: 'b', name: `${NOSCRIPT_CLOSE}x`, type: 'text' },
  ],
  data: {
    // both encodings: a dictionary hides the string one level down, and it is
    // the encoding import chooses for repetitive columns — i.e. the likely one
    a: { enc: 'dict', dict: [`${SCRIPT_OPEN}steal()${SCRIPT_CLOSE}`, '"><b>'], idx: [0, 1] },
    b: { enc: 'raw', v: [`x${NOSCRIPT_CLOSE}`, `<scr` + `ipt src=//evil>`] },
  },
  steps: [],
})

const nasty = markup(wb([hostile()], {
  title: `Deck ${SCRIPT_CLOSE}`,
  meta: { author: SCRIPT_OPEN },
}))
ok(previewIsSafe(nasty) === true, 'script tags in values, names, the sheet name and the title are neutralised')
ok(!nasty.toLowerCase().includes('<scr' + 'ipt'), 'no script open survives into the markup')
ok(!nasty.toLowerCase().includes('</scr' + 'ipt'), 'no script close survives into the markup')
ok(!nasty.toLowerCase().includes('</nosc' + 'ript'), 'no noscript close survives into the markup')
ok(nasty.includes('&lt;'), 'the hostile content is present — escaped, not silently dropped')

// A cell override carries a hand-typed value and wins over the stored one
// (grid.ts precedence), so it is its own path into the markup.
const overridden = wb([{
  ...(simple() as Record<string, unknown>),
  cells: { 'region:1': { v: `OVERRIDDEN${SCRIPT_CLOSE}`, by: 'someone' } },
} as unknown as Sheet])
const overHtml = markup(overridden)
ok(previewIsSafe(overHtml) === true, 'a hand override reaches the markup escaped too')
// …and is actually HONOURED. Asserting only that the markup is safe passed
// against an implementation that ignored overrides entirely — a preview that
// shows the imported value where a human wrote a correction is a wrong number
// in the one artefact nobody proofreads.
ok(overHtml.includes('OVERRIDDEN'), 'a hand override BEATS the stored value, as it does in the grid')

// The canvas sheet is a second renderer with a second set of call sites.
const canvas = wb([{
  id: 'c1', name: 'Scratch', kind: 'canvas',
  cells: { A1: { v: `${SCRIPT_OPEN}x${SCRIPT_CLOSE}` }, B2: { v: 42 }, C3: { f: '=A1' } },
} as Sheet])
const canvasHtml = markup(canvas)
ok(previewIsSafe(canvasHtml) === true, 'a canvas sheet escapes its cells')
ok(canvasHtml.includes('>42<'), 'a canvas sheet draws its values')
ok(canvasHtml.includes('>A<') && canvasHtml.includes('>B<'), 'a canvas sheet draws A1 headers')

// --- 3. CSS injection through the theme -------------------------------------

console.log('\nCSS injection')

ok(cssColor('#F7A600', '#000') === '#F7A600', 'an ordinary hex colour passes')
ok(cssColor('rgb(30, 41, 59)', '#000') === 'rgb(30, 41, 59)', 'rgb() passes')
ok(cssColor('hsl(20 30% 40% / 0.5)', '#000') === 'hsl(20 30% 40% / 0.5)', 'modern hsl() passes')
ok(cssColor('#fff}body{display:none', '#000') === '#000', 'a rule-closing brace is refused')
ok(cssColor('red;position:fixed', '#000') === '#000', 'a declaration separator is refused')
ok(cssColor('url(https://evil.example/x.png)', '#000') === '#000', 'url() is refused — a preview never fetches')
ok(cssColor('#'.repeat(64), '#000') === '#000', 'an absurdly long colour is refused')
ok(cssColor(42, '#000') === '#000', 'a non-string colour is refused')

const poisoned = markup(wb([simple()], {
  theme: {
    background: 'url(https://evil.example/beacon)',
    color: '#111',
    accent: '#fff}body{display:none;background:url(https://evil.example/b)',
    fontFamily: 'x',
  },
}))
ok(!poisoned.includes('display:none'), 'an injected declaration never reaches the stylesheet')
ok(!poisoned.includes('evil.example'), 'no external URL reaches the stylesheet')
ok(poisoned.includes('#111'), 'a legitimate theme colour in the same document still applies')

// --- 4. numbers nobody computed ---------------------------------------------

console.log('\nnumbers nobody computed')

const withFormula = (rows: number): Sheet => ({
  id: 'sh1', name: 'Model', kind: 'table',
  rids: [[1, rows]],
  columns: [
    { id: 'value', name: 'Value', type: 'number' },
    { id: 'dbl', name: 'Doubled', type: 'number', formula: 'value * 2' },
  ],
  // Only the first rows carry data; a huge sheet is faked by its rid runs,
  // which is what every row count in the app reads.
  //
  // The numbers are chosen so that no stored value, no doubled value and no
  // total collide. They did once — 111 doubled is 222, which is also the second
  // stored value — and "a stored value is drawn" passed against an
  // implementation that drew no stored values at all.
  data: { value: { enc: 'raw', v: [111, 205, 337] } },
  steps: [],
})

const small = markup(wb([withFormula(3)]))
ok(small.includes('>205<'), 'a stored value is drawn')
ok(small.includes('>410<'), 'a formula column IS computed when the sheet is small enough to be free')
// Assert on the CLASS ATTRIBUTE, never the bare class name: every class also
// appears in the preview's own stylesheet, so `includes('dxp-fx')` is true of
// any preview at all. Three checks here were vacuous until the rig's negative
// control showed them passing against an implementation that drew no chip.
ok(small.includes('class="dxp-fx"'), 'a formula column is marked fx')

const huge = markup(wb([withFormula(250_000)]))
ok(huge.includes('class="dxp-fx"'), 'a formula column past the recalculation ceiling is still marked fx')
ok(!huge.includes('>0<'), 'and its cells are EMPTY — never zero, which would be a number, which would be a lie')
ok(huge.includes('>111<'), 'the stored column beside it is still drawn')
ok(huge.includes('250,000 rows'), 'the real row count is reported even though only a window is drawn')

const totals = (rows: number): Sheet => ({
  ...(withFormula(rows) as Record<string, unknown>),
  totals: { value: 'sum' },
} as unknown as Sheet)

const totalled = markup(wb([totals(3)]))
ok(totalled.includes('class="dxp-tot"') && totalled.includes('>653<'),
  'a totals row is computed over the whole column')

const bigTotals = markup(wb([totals(250_000)]))
ok(!bigTotals.includes('class="dxp-tot"'),
  'past the scan ceiling the totals row is OMITTED — a partial total is the bug dash exists to refuse')

// --- 5. the byte budget ------------------------------------------------------

console.log('\nbyte budget')

const fat = (): Sheet => ({
  id: 'sh1', name: 'Wide', kind: 'table',
  rids: [[1, 400]],
  columns: Array.from({ length: 60 }, (_, i) => ({
    id: `c${i}`, name: `A very long column heading number ${i} `.repeat(4), type: 'text' as const, w: 400,
  })),
  data: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [
    `c${i}`,
    { enc: 'raw' as const, v: Array.from({ length: 400 }, (_, r) => `value ${i}/${r} `.repeat(30)) },
  ])),
  steps: [],
})

const wide = markup(wb([fat()]))
ok(byteLength(wide) <= PREVIEW_BUDGET,
  `an adversarially wide workbook fits the budget (${byteLength(wide)} ≤ ${PREVIEW_BUDGET})`)

// The last tier has to be REACHABLE, and bounded by construction: a title is
// unbounded in the format, so a workbook can defeat every table tier.
const monstrous = markup(wb([fat()], { title: 'T'.repeat(200_000) }))
ok(monstrous.includes('class="dxp-card"'), 'a workbook that defeats every tier falls back to the title card')
ok(byteLength(monstrous) <= PREVIEW_BUDGET,
  `and the card itself is bounded (${byteLength(monstrous)} ≤ ${PREVIEW_BUDGET})`)
ok(previewIsSafe(monstrous) === true, 'the card is safe markup too')

const ordinary = markup(wb([simple()]))
ok(byteLength(ordinary) < 6_000, `an ordinary workbook costs little (${byteLength(ordinary)} bytes)`)

// --- 6. what it draws, and what it must not ---------------------------------

console.log('\nscope')

const two = markup(wb([simple(), {
  id: 'sh2', name: 'Second', kind: 'table', rids: [[1, 1]],
  columns: [{ id: 'x', name: 'Secret', type: 'text' }],
  data: { x: { enc: 'raw', v: ['SENTINEL'] } }, steps: [],
} as Sheet]))
ok(two.includes('North'), 'the FIRST sheet is what a workbook opens on, and what it thumbnails as')
ok(!two.includes('SENTINEL'), 'later sheets are not drawn')

const hiddenCol = markup(wb([{
  ...(simple() as Record<string, unknown>),
  columns: [
    { id: 'region', name: 'Region', type: 'text' },
    { id: 'value', name: 'Value', type: 'money', hidden: true },
  ],
} as unknown as Sheet]))
ok(!hiddenCol.includes('12,400') && !hiddenCol.includes('£12,400'),
  'a hidden column stays hidden — the preview shows what the grid shows')

ok(attempt(() => previewMarkup(wb([]))) === null,
  'a workbook with no sheets has no preview rather than an empty frame')
ok(attempt(() => previewMarkup({ format: FORMAT, version: 1, docId: 'x', title: 'T' } as DashDoc)) === null,
  'a document with no sheets array at all does not throw')

const emptySheet = attempt(() => markup(wb([{
  id: 'e', name: 'Empty', kind: 'table', rids: [], columns: [], data: {}, steps: [],
} as Sheet])))
ok(emptySheet !== 'threw' && emptySheet.includes('0 rows'), 'an empty sheet still identifies the workbook')

// A width read straight out of a hand-edited file must not reach the CSS as
// NaN — that one token takes the whole preview down, in every saved file.
const badWidth = markup(wb([{
  ...(simple() as Record<string, unknown>),
  columns: [{ id: 'region', name: 'Region', type: 'text', w: 'wide' }],
} as unknown as Sheet]))
ok(!badWidth.includes('NaN') && !badWidth.includes('Infinity'), 'a nonsense column width falls back')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
