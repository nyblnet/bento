#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Per-cell format, type coercion and appearance on a SPREADSHEET sheet.
//
//   node scripts/test-dash-cellprops.ts     (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. The controls are chrome — a dropdown in the wrong order is
// a thing you can see. What you cannot see is what they DECIDE, and every
// failure below leaves a workbook that looks perfectly normal:
//
//   1. A NUMBER THAT WAS A LABEL. `01234` is a part number until something
//      reads it as 1234, and then the zeros are gone from the file forever.
//      Nothing on screen says a digit was dropped. dash's rule 3 keeps them as
//      text in an unformatted cell, which is the ONE rule here that differs
//      from Excel, so it is the one most likely to be "fixed" back.
//   2. A DATE NOBODY CHOSE. `1/2` as a date is a coin flip between January and
//      February, and the coin is flipped silently at entry. Rule 4 says never
//      at entry; rule 8 says refuse the ambiguous spelling even when the Date
//      format is applied deliberately.
//   3. A PATTERN THE RENDERER CANNOT READ. The panel writes format strings and
//      format.ts prints them, and the two are parsed by different code — so
//      every preset is asserted against `formatValue` here rather than against
//      the string it was built from. A preset that round-trips through the
//      dropdown perfectly and prints nothing is the failure this catches.
//   4. TWENTY UNDO STEPS. Formatting a selection is ONE edit to the person who
//      did it. Twenty patches would be twenty undos, twenty CRDT ops, and a
//      ⌘Z that leaves a selection half-formatted.
//   5. A SPREADSHEET THAT IS NOT SPARSE. A control that "changes" forty
//      untouched cells to what they already were must write nothing. Sparseness
//      is the kind's whole claim, and a panel is the easiest place to break it.
//
// Every check calls a PURE function. There is no DOM here; `buildCellProps` is
// the only thing in cellprops.ts this rig does not touch, and it contains no
// decision — it reads the sheet and calls the functions below.

import { registerHooks } from 'node:module'

// cellprops.ts imports its stylesheet, which is Vite's job and not Node's —
// the same stub test-dash-panels.ts uses, for the same reason.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) {
      return { format: 'module', source: 'export {}', shortCircuit: true }
    }
    return next(url, context)
  },
})

const {
  TEXT_PATTERN, DATE_PATTERN, buildPattern, classifyFormat, isCustomPattern, isTextFormat,
  localeSymbol, defaultsFor, readTypedNumber, readTypedDate, coerceInput, recastForFormat,
  rangeKeys, describeSelection, stylePatch, formatPatch, KEY_CAP,
} = await import('../dash/src/cellprops.ts')
type FormatChoice = import('../dash/src/cellprops.ts').FormatChoice
type CellRange = import('../dash/src/cellprops.ts').CellRange

const { formatValue, setViewerLocale } = await import('../dash/src/format.ts')
const { Store } = await import('../dash/src/store.ts')
const { applyPatch } = await import('../dash/src/store.ts')
type Patch = import('../dash/src/store.ts').Patch
type DashDoc = import('../dash/src/model.ts').DashDoc
type CanvasSheet = import('../dash/src/model.ts').CanvasSheet
type CanvasCell = import('../dash/src/model.ts').CanvasCell

// A FIXED LOCALE, or this rig asserts the separators of whatever machine it
// runs on: format.ts punctuates with the VIEWER's locale by design, so a rig
// that leaves it unset passes in London and fails in Berlin.
setViewerLocale('en-US')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const j = (v: unknown): string => JSON.stringify(v)

const sheetOf = (cells: Record<string, CanvasCell> = {}): CanvasSheet =>
  ({ id: 'c1', name: 'Sheet', kind: 'canvas', cells } as CanvasSheet)

const doc = (cells: Record<string, CanvasCell> = {}): DashDoc => ({
  format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId: 'd', title: 'test',
  sheets: [sheetOf(cells)],
} as unknown as DashDoc)

const canvasOf = (d: DashDoc): CanvasSheet => d.sheets[0] as CanvasSheet
const content = (d: DashDoc): string => {
  const { modified: _m, ...rest } = d as Record<string, unknown>
  return JSON.stringify(rest)
}
const at = (r: number, c: number): CellRange =>
  ({ anchor: { row: r, col: c }, head: { row: r, col: c } })
const box = (r0: number, c0: number, r1: number, c1: number): CellRange =>
  ({ anchor: { row: r0, col: c0 }, head: { row: r1, col: c1 } })

const choice = (over: Partial<FormatChoice>): FormatChoice =>
  ({ kind: 'number', dp: 2, group: true, symbol: '$', ...over })

// ============================================================ patterns

console.log('\npatterns — what the presets write, and what format.ts does with it')
{
  ok(buildPattern(choice({ kind: 'general' })) === undefined,
    'General is the ABSENT field, not the string "General" — an additive field where absent means "no format"')
  ok(buildPattern(choice({ kind: 'number', dp: 0, group: true })) === '#,##0',
    'Number, no decimals, grouped')
  ok(buildPattern(choice({ kind: 'number', dp: 2, group: false })) === '0.00',
    'Number, two decimals, ungrouped')
  ok(buildPattern(choice({ kind: 'currency', dp: 2, symbol: '£' })) === '£#,##0.00',
    'Currency puts the symbol in front — the prefix format.ts reads back out')
  ok(buildPattern(choice({ kind: 'percent', dp: 1, group: false })) === '0.0%',
    'Percent carries the mark')
  ok(buildPattern(choice({ kind: 'text' })) === TEXT_PATTERN, 'Text is Excel\'s @')
  ok(buildPattern(choice({ kind: 'date' })) === DATE_PATTERN, 'Date is ISO, because rule 8 stores ISO')
}
{
  // THE CHECK THAT MATTERS: the presets are asserted against the RENDERER, not
  // against the string they were built from. Two different parsers.
  const shows = (v: unknown, fmt: string | undefined, type: 'number' | 'text' = 'number') =>
    formatValue(v, { type, format: fmt })
  ok(shows(1200, '#,##0') === '1,200', '#,##0 prints 1,200 — the panel and format.ts agree')
  ok(shows(1200.5, '£#,##0.00') === '£1,200.50', 'the currency prefix survives into the output')
  ok(shows(0.5, '0%') === '50%', 'a percent pattern prints 50% for the stored 0.5 — the pair rule 5 writes')
  ok(shows(0.125, '0.0%') === '12.5%', 'and decimals in a percent pattern are honoured')
  // This was pinned as a KNOWN LIMITATION and has since been fixed, so the pin
  // became the assertion. `readPattern` answered dp = null for a pattern with
  // no decimal POINT, and null means "decide from the value" — so `#,##0`
  // printed 1,234.50 and `0` printed 7.60, and formatting a column as a whole
  // number had never worked on either kind of sheet. A pattern with digits and
  // no point says something very definite; only a pattern with no digits at
  // all is silent enough to mean "auto".
  ok(shows(1234.5, '#,##0') === '1,235', 'Decimals: 0 rounds a fractional value, as Excel does')
  ok(shows(7.6, '0') === '8', 'and a bare 0 pattern rounds too')
  ok(shows(1234.5, '#,##0.00') === '1,234.50', 'a pattern that asks for decimals still gets them')
  ok(shows(1234, '#,##0') === '1,234', 'though an integer prints without inventing decimals')
  ok(shows(0.125, '0%') === '13%', 'and a percent pattern with no decimals DOES round, because its fallback is 0')
  ok(shows('2026-03-05', DATE_PATTERN, 'text') === '2026-03-05',
    'a date is stored as text and prints as itself — format.ts has no date engine, and the value carries the type')
}
{
  for (const c of [
    choice({ kind: 'number', dp: 0, group: false }),
    choice({ kind: 'number', dp: 3, group: true }),
    choice({ kind: 'currency', dp: 2, group: true, symbol: '£' }),
    choice({ kind: 'percent', dp: 0, group: false }),
    choice({ kind: 'text' }), choice({ kind: 'date' }),
  ]) {
    const p = buildPattern(c)
    const back = classifyFormat(p)
    ok(back.kind === c.kind && (c.kind === 'text' || c.kind === 'date' ||
      (back.dp === c.dp && back.group === c.group)),
      `${p} classifies back to ${c.kind} with its own decimals — the round trip a dropdown needs to show the format a cell already has`)
    ok(!isCustomPattern(p), `${p} is a preset, not "custom"`)
  }
}
{
  ok(isCustomPattern('#,##0.00 "kg"'),
    'a pattern no preset spells reads as Custom — the dropdown then leaves it alone rather than respelling it')
  ok(!isCustomPattern(undefined) && !isCustomPattern(''), 'no format is General, not Custom')
  ok(isTextFormat('@') && !isTextFormat('#,##0') && !isTextFormat(undefined),
    'the Text format is @, and only @')
  ok(classifyFormat('£#,##0.00').symbol === '£', 'the symbol comes back out of the pattern')
  ok(buildPattern({ ...classifyFormat(undefined), ...defaultsFor('percent'), kind: 'percent' }) === '0%',
    'Percent picked on an unformatted cell is 0%, not #,##0.00% — a rate is 50%, and that is what thirty years of muscle memory expects')
  ok(buildPattern({ ...classifyFormat(undefined), ...defaultsFor('number'), kind: 'number' }) === '#,##0.00',
    'while Number picked on an unformatted cell is two decimals, grouped')
  ok(buildPattern({ ...classifyFormat('0.000'), kind: 'currency', symbol: '£' }) === '£0.000',
    'and a cell that ALREADY had 3dp keeps them when the preset changes — a switch must not re-round somebody else\'s column')
  ok(localeSymbol('en-GB') === '£' && localeSymbol('de-DE') === '€' && localeSymbol('en-US') === '$',
    'the currency DEFAULT is guessed from the viewer locale — a starting value, stored explicitly once accepted')
}

// ============================================================ reading a field

console.log('\nreading a typed field')
{
  ok(readTypedNumber('1,200')?.n === 1200, 'a thousands separator is how people type numbers')
  ok(readTypedNumber('$1,200.50')?.n === 1200.5, 'a currency symbol is peeled')
  ok(readTypedNumber('$1,200.50')?.symbol === '$', 'and remembered, so a stamped format can use it')
  ok(readTypedNumber('50%')?.n === 0.5, '50% is 0.5 — reading the mark, not rescaling')
  ok(readTypedNumber('(1,200)')?.n === -1200, 'accounting brackets are a negative')
  ok(readTypedNumber('-£5')?.n === -5 && readTypedNumber('£-5')?.n === -5,
    'the sign may sit either side of the symbol')
  ok(readTypedNumber('1.5e3')?.n === 1500, 'an exponent is a number')
  ok(readTypedNumber('north') === null && readTypedNumber('') === null && readTypedNumber('.') === null,
    'a word, a blank and a lone dot are not numbers')
  ok(readTypedNumber('1/2') === null, 'and neither is 1/2 — rule 4 starts here')
  ok(readTypedNumber('01234', { strict: true }) === null,
    'STRICT refuses a leading zero: in an unformatted cell 01234 is a label (rule 3)')
  ok(readTypedNumber('01234')?.n === 1234,
    'without strict — the cell is explicitly a quantity — the zeros are dropped and the number read')
  ok(readTypedNumber('0.5', { strict: true })?.n === 0.5 && readTypedNumber('0', { strict: true })?.n === 0,
    'and 0 and 0.5 are still numbers: the rule is a leading zero BEFORE another digit')
  ok(readTypedNumber('$1,200.50')?.dp === 2, 'the decimals typed are counted, so a stamped format matches what was written')
}

console.log('\nreading a date — the refusal is the feature')
{
  ok(readTypedDate('2026-03-05') === '2026-03-05', 'ISO is ISO')
  ok(readTypedDate('2026/3/5') === '2026-03-05', 'a four-digit year in front fixes the order')
  ok(readTypedDate('5 Mar 2026') === '2026-03-05' && readTypedDate('Mar 5, 2026') === '2026-03-05',
    'a named month is never ambiguous, either way round')
  ok(readTypedDate('13/2/2026') === '2026-02-13',
    '13 cannot be a month, so the order is decidable and the date is read')
  ok(readTypedDate('1/2/2026') === null,
    'and 1/2/2026 is REFUSED — nothing on screen could say which half is the month (rule 8)')
  ok(readTypedDate('31/2/2026') === null, 'the 31st of February is refused by a real calendar check')
  ok(readTypedDate('1/2') === null && readTypedDate('north') === null, 'and a fragment is not a date')
}

// ============================================================ rule 1..5

console.log('\ncoerceInput — what a cell IS after somebody types into it')
{
  const v = (prev: CanvasCell | undefined, s: string) => coerceInput(prev, s)?.v
  const f = (prev: CanvasCell | undefined, s: string) => coerceInput(prev, s)?.f

  // rule 1
  const text = { format: TEXT_PATTERN }
  ok(v(text, '01234') === '01234', 'rule 1: a Text cell keeps 01234 exactly')
  ok(v(text, '1/2') === '1/2', 'rule 1: and 1/2, which is the owner\'s other example')
  ok(v(text, '=SUM(A1:A2)') === '=SUM(A1:A2)' && f(text, '=SUM(A1:A2)') === undefined,
    'rule 1: a Text cell stores a formula as TEXT — that is what asking for Text means')
  ok(v(text, 'TRUE') === 'TRUE', 'rule 1: and TRUE is a word here, not a boolean')
  ok(coerceInput(text, '')?.format === TEXT_PATTERN && coerceInput(text, '') !== null,
    'rule 9: emptying a Text cell leaves it formatted Text')

  // rule 2
  ok(v(undefined, "'007") === '007', 'rule 2: an apostrophe forces text and is dropped')
  ok(v(undefined, "'=A1") === '=A1', 'rule 2: including for something that would have been a formula')

  // rule 3
  ok(v(undefined, '01234') === '01234',
    'rule 3: an UNFORMATTED cell keeps the leading zeros — the whole point, and where dash differs from Excel')
  ok(v({ format: '#,##0' }, '01234') === 1234,
    'rule 3: a cell explicitly formatted Number reads it as 1234 — the author said it was a quantity')
  ok(v(undefined, '1200') === 1200 && v(undefined, '1,200') === 1200,
    'an ordinary number is still an ordinary number')
  ok(v(undefined, 'north') === 'north', 'and a word is a word')

  // rule 4
  ok(v(undefined, '1/2') === '1/2', 'rule 4: typing 1/2 never makes a date')
  ok(v(undefined, '2026-03-05') === '2026-03-05',
    'rule 4: nor does an ISO-looking string — it is text until a Date format is applied')

  // rule 5
  const pct = coerceInput(undefined, '50%')
  ok(pct?.v === 0.5 && pct?.format === '0%',
    'rule 5: a % MARK stores 0.5 and stamps the format that prints it back as 50%')
  ok(formatValue(pct?.v, { type: 'number', format: pct?.format }) === '50%',
    'and the pair round-trips through the renderer — 50% typed shows 50%')
  const money = coerceInput(undefined, '$1,200.50')
  ok(money?.v === 1200.5 && money?.format === '$#,##0.00',
    'rule 5: a currency symbol stamps a currency format at the decimals typed')
  ok(formatValue(money?.v, { type: 'number', format: money?.format }) === '$1,200.50',
    'and it too round-trips — what was typed is what is shown')
  ok(coerceInput(undefined, '1,200')?.format === undefined,
    'rule 5: but a plain separator stamps NOTHING — a comma is how a person types, not a statement about meaning')
  ok(coerceInput({ format: '#,##0' }, '$5')?.format === '#,##0',
    'rule 5: typing never overwrites a format somebody chose')
  ok(coerceInput({ format: '0.00%' }, '50')?.v === 0.5,
    'a bare number in a PERCENT cell is percent points — Excel\'s rule, and everybody\'s muscle memory')
  ok(coerceInput({ format: '0.00%' }, '50%')?.v === 0.5, 'and an explicit 50% is the same 0.5, not 0.005')

  // formulas and blanks
  ok(f(undefined, '=SUM(A1:A2)') === '=SUM(A1:A2)', 'a formula is still a formula everywhere else')
  ok(coerceInput({ v: 1, format: '0%', bold: true, bg: '#eee' }, '')?.v === undefined,
    'rule 9: clearing empties the value')
  const kept = coerceInput({ v: 1, f: '=A1', format: '0%', bold: true, bg: '#eee' }, '')
  ok(kept?.format === '0%' && kept?.bold === true && kept?.bg === '#eee' && kept?.f === undefined,
    'rule 9: …and keeps the format and the appearance, and drops the formula with the value')
  ok(coerceInput(undefined, '') === null,
    'clearing a cell that never existed writes NOTHING — sparseness, kept at the one place it can be broken')
  ok(coerceInput({ v: 5 }, '=A1+1')?.v === undefined,
    'a value and a formula are alternatives — a file cannot carry a number that disagrees with its own formula')
}

// ============================================================ rule 6..8

console.log('\nrecastForFormat — applying a format re-reads the value')
{
  ok(recastForFormat({ v: 1200 }, TEXT_PATTERN).cell?.v === '1200',
    'rule 7: applying Text to 1200 stores the PLAIN "1200", never the formatted "£1,200.00"')
  ok(recastForFormat({ v: 1200, format: '£#,##0.00' }, TEXT_PATTERN).cell?.v === '1200',
    'and that holds even when the cell was showing a currency')
  ok(recastForFormat({ v: '1,200' }, '#,##0').cell?.v === 1200,
    'applying Number to text that IS a number reads it')
  ok(recastForFormat({ v: '01234' }, '#,##0').cell?.v === 1234,
    'and a deliberate Number format is how 01234 becomes 1234 — rule 3\'s way back')
  const bad = recastForFormat({ v: 'north' }, '#,##0')
  ok(bad.cell?.v === 'north' && bad.refused,
    'rule 7: a value the format cannot read is LEFT ALONE, and the refusal is reported')
  ok(recastForFormat({ v: 50 }, '0%').cell?.v === 50,
    'rule 6: applying Percent to 50 does NOT divide it — it shows 5000%, as everywhere else')
  ok(formatValue(recastForFormat({ v: 50 }, '0%').cell?.v, { type: 'number', format: '0%' }) === '5000%',
    'and that is what the reader sees, so nothing is hidden')
  ok(recastForFormat({ v: '50%' }, '0%').cell?.v === 0.5,
    'rule 6: text carrying the MARK is read as 0.5 — reading a mark is not rescaling')

  ok(recastForFormat({ v: '5 Mar 2026' }, DATE_PATTERN).cell?.v === '2026-03-05',
    'rule 8: an unambiguous date is stored canonical')
  const amb = recastForFormat({ v: '1/2/2026' }, DATE_PATTERN)
  ok(amb.cell?.v === '1/2/2026' && amb.refused,
    'rule 8: an ambiguous one is refused, keeps its value, and says so')
  ok(amb.cell?.format === DATE_PATTERN,
    'the format still lands — the refusal is about the VALUE, and the author gets to fix it')

  const formula = recastForFormat({ f: '=A1+1', v: 7 }, '0.00')
  ok(formula.cell?.f === '=A1+1' && formula.cell?.v === 7 && !formula.refused,
    'a formula cell is never re-read: the value is derived, and rewriting it makes a file disagree with itself')
  ok(recastForFormat({ v: 5, format: '0%' }, undefined).cell?.format === undefined,
    'General DELETES the field rather than storing "General"')
  ok(recastForFormat(undefined, undefined).cell === null,
    'and clearing the format of a cell that does not exist writes nothing at all')
}

// ============================================================ selections

console.log('\nselections, as A1 keys')
{
  ok(j(rangeKeys([box(0, 0, 1, 1)])) === j(['A1', 'B1', 'A2', 'B2']),
    'a range expands in reading order, as A1 addresses — the format\'s key for this kind')
  ok(j(rangeKeys([box(1, 1, 0, 0)])) === j(['A1', 'B1', 'A2', 'B2']),
    'and a range dragged upwards is the same range')
  ok(j(rangeKeys([box(0, 0, 1, 1), box(1, 1, 2, 2)])) ===
    j(['A1', 'B1', 'A2', 'B2', 'C2', 'B3', 'C3']),
    'overlapping ⌘-click ranges yield each address ONCE — a repeat in a patch record would make the inverse read a value the first write had already replaced')
  ok(rangeKeys([box(0, 0, 999, 999)]).length === KEY_CAP,
    'and an enormous selection stops at the cap rather than minting a million-entry patch')
  ok(describeSelection([at(1, 1)]) === 'B2', 'one cell is named')
  ok(describeSelection([box(1, 1, 3, 3)]).startsWith('B2:D4'), 'a range is named by its corners')
}

// ============================================================ patches

console.log('\npatches — one edit, one patch, one undo')
{
  const s = sheetOf({ A1: { v: 1 } })
  const keys = rangeKeys([box(0, 0, 4, 3)])
  const p = stylePatch(s, keys, { bold: true })
  ok(keys.length === 20, 'twenty cells selected')
  ok(p !== null && p.op === 'setCanvasCells' && Object.keys((p as { cells: object }).cells).length === 20,
    'and ONE patch carries all twenty — a paste, a fill and a format are each one edit to a reader')
  ok(j(s.cells) === j({ A1: { v: 1 } }), 'minting the patch did not touch the sheet')
  ok(((p as { cells: Record<string, CanvasCell> }).cells.A1).v === 1,
    'and a cell that already had a value keeps it — a style is not a write of the contents')
}
{
  const s = sheetOf({ A1: { v: 1, bold: true } })
  const p = stylePatch(s, ['A1'], { bold: null })
  const cells = (p as { cells: Record<string, CanvasCell> }).cells
  ok(!('bold' in cells.A1), 'clearing DELETES the field rather than storing false — absent is what "not bold" looks like')
  ok(cells.A1.v === 1, 'and the value is untouched')
}
{
  const s = sheetOf({})
  ok(stylePatch(s, ['A1'], { bold: false }) === null,
    'a style edit that changes nothing writes NOTHING — forty clicks on "auto" must not grow a sparse sheet by forty cells')
  const only = stylePatch(s, ['A1'], { bg: '#fff3cd' })
  ok(only !== null && j((only as { cells: Record<string, CanvasCell> }).cells) === j({ A1: { bg: '#fff3cd' } }),
    'but painting an EMPTY cell does create it — the paint is the content')
  const off = stylePatch(sheetOf({ A1: { bg: '#fff3cd' } }), ['A1'], { bg: null })
  ok(j((off as { cells: Record<string, CanvasCell | null> }).cells) === j({ A1: null }),
    'and clearing the last field REMOVES the cell — null, the spelling that survives JSON to a collaborator')
}
{
  // THE VOCABULARY IS THE DATASET KIND'S TOO NOW. `stylePatch` writes through
  // cellfmt.ts's `applyAppearance`, which is the same function the dataset
  // panel writes through — so the fields below are not four new spreadsheet
  // features, they are the two kinds reaching parity. Their own rig is
  // scripts/test-dash-cellfmt.ts; these checks are here because THIS is the
  // file that pins what the canvas writer does.
  const s = sheetOf({ A1: { v: 1 } })
  const p = stylePatch(s, ['A1'], {
    italic: true, underline: true, wrap: true,
    border: 'trbl', borderColor: '#445566', borderStyle: 'dashed',
  })
  const cell = (p as { cells: Record<string, CanvasCell> }).cells.A1
  ok(cell.italic === true && cell.underline === true && cell.wrap === true,
    'italic, underline and wrap are writable on the spreadsheet kind — they used to be absent from BOTH kinds')
  ok(cell.border === 'trbl' && cell.borderColor === '#445566' && cell.borderStyle === 'dashed',
    'and so are borders, as edges + colour + style')
  ok(cell.v === 1, 'with the value untouched, like every other appearance write')
  const cleared = stylePatch(sheetOf({ A1: { v: 1, italic: true, wrap: true } }), ['A1'],
    { italic: null, wrap: false })
  const after = (cleared as { cells: Record<string, CanvasCell> }).cells.A1
  ok(!('italic' in after) && !('wrap' in after) && after.v === 1,
    'clearing the new fields deletes them too — one rule for the whole vocabulary')
  // The type boundary, from this side: the canvas writer refuses a value key
  // exactly as the dataset one does, so neither panel can smuggle a write.
  ok(stylePatch(sheetOf({ A1: { v: 1 } }), ['A1'], { v: 2, f: '=1+1' } as never) === null,
    'a key outside the appearance vocabulary is ignored — a style control cannot write a value')
}
{
  const s = sheetOf({ A1: { v: 'north' }, A2: { v: '1/2/2026' }, A3: { v: '5 Mar 2026' } })
  const r = formatPatch(s, ['A1', 'A2', 'A3'], DATE_PATTERN)
  ok(r.refused === 2, 'two of three values could not be read as a date, and the panel is told the number')
  const cells = (r.patch as { cells: Record<string, CanvasCell> }).cells
  ok(cells.A1.v === 'north' && cells.A2.v === '1/2/2026' && cells.A3.v === '2026-03-05',
    'the two refusals keep their values; the one that parsed is canonical')
}
{
  // THE UNDO CLAIM, end to end through the real store.
  const st = new Store(doc({ A1: { v: 1 } }))
  const before = content(st.doc)
  const keys = rangeKeys([box(0, 0, 4, 3)])
  const p = stylePatch(canvasOf(st.doc), keys, { bold: true, color: '#b91c1c' })!
  st.commit(p)
  const after = canvasOf(st.doc)
  ok(Object.keys(after.cells).length === 20 && after.cells.D5.bold === true,
    'committing lands all twenty in the document')
  ok(st.undo() && content(st.doc) === before,
    'and ONE undo puts the document back byte-for-byte — twenty cells, one step')
}
{
  // A FORMAT SURVIVES A ROUND TRIP THROUGH THE FILE. The panel writes the
  // format into the document, and the document is what gets saved — so a
  // JSON round trip is the honest stand-in for save → reload here, and the
  // browser check that ⌘S keeps it is the other half.
  const d = doc({ A1: { v: 1200.5 } })
  applyPatch(d, formatPatch(canvasOf(d), ['A1'], '£#,##0.00').patch as Patch)
  applyPatch(d, stylePatch(canvasOf(d), ['A1'], { bold: true, bg: '#fff3cd' }) as Patch)
  const reloaded = JSON.parse(JSON.stringify(d)) as DashDoc
  const cell = canvasOf(reloaded).cells.A1
  ok(cell.format === '£#,##0.00' && cell.bold === true && cell.bg === '#fff3cd' && cell.v === 1200.5,
    'format and appearance survive a save/reload round trip — they are ordinary document fields')
  ok(formatValue(cell.v, { type: 'number', format: cell.format as string }) === '£1,200.50',
    'and the reloaded pattern still prints what it printed before')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
