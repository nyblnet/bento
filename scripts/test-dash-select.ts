#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash selection + keyboard rig.
//
//   node scripts/test-dash-select.ts
//
// WHAT THIS PROVES. Selection is the only part of a grid that is judged by
// FEEL, and feel is not a thing you can eyeball once and call done — every one
// of these behaviours is invisible when it is right and infuriating when it is
// wrong, in a way users report as "it's weird" rather than as a bug. So the
// motor memory gets written down as assertions:
//
//   1. TAB AND ENTER ARE A PAIR. Tab across a row, Enter, and you land under
//      where the run STARTED. An implementation that moves Enter down from
//      wherever Tab left off walks the user diagonally across their own table,
//      and it looks plausible in every single-cell test.
//   2. TAB MEANS TWO DIFFERENT THINGS. Inside a selected block it walks the
//      active cell and wraps, and the block must not move. On a single cell it
//      moves plainly. One implementation for both is always wrong for one.
//   3. ⌘↓ IS BOUNDED AND HAS THREE CASES. Run to the end of a block, cross the
//      blanks to the next one, stop at the sheet's last row. "Walk until blank"
//      passes the first case and never moves from an empty cell.
//   4. THE CLIPBOARD ROUND-TRIPS. A cell holding a tab, a newline or a quote is
//      the whole reason TSV has quoting; a naive split() loses the row count and
//      the paste lands shifted, silently.
//   5. FILL READS A SERIES OR ADMITS IT CANNOT. 1,2,3 continues 4,5,6; "a","b"
//      repeats. Continuing a non-series invents data, and repeating a series is
//      the thing people notice within one second of dragging.

import { readFileSync } from 'node:fs'
import {
  Selection, normalize, contains, size, rangeOf, keyToAction, applyMotion,
  tsvFromRange, parseTsv, fillDown, fillSeries,
  type Action, type CellRef,
} from '../dash/src/select.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const j = (v: unknown): string => JSON.stringify(v)
function eq(got: unknown, want: unknown, msg: string) {
  const same = j(got) === j(want)
  ok(same, same ? msg : `${msg} — got ${j(got)}, wanted ${j(want)}`)
}
const at = (s: Selection): [number, number] => [s.cursor.row, s.cursor.col]

// ------------------------------------------------------------------ ranges
{
  const r = rangeOf(1, 2, 4, 5)
  eq(normalize(r), { top: 1, left: 2, bottom: 4, right: 5 }, 'normalize of a forward range')
  // a range dragged up-and-left has its head BEFORE its anchor
  const back = { anchor: { row: 4, col: 5 }, head: { row: 1, col: 2 } }
  eq(normalize(back), { top: 1, left: 2, bottom: 4, right: 5 },
    'normalize of a BACKWARDS range gives the same box — anchor and head are not min and max')
  eq(size(r), { rows: 4, cols: 4 }, 'size counts both endpoints')
  ok(contains(r, 1, 2) && contains(r, 4, 5) && contains(r, 3, 3), 'contains includes the corners')
  ok(!contains(r, 0, 2) && !contains(r, 1, 6), 'and excludes what is outside')
  ok(!contains(r, 4, 1), 'a cell on the right row but the wrong column is NOT contained')
}

// -------------------------------------------------------------- key mapping
{
  const a = (key: string, mods: Partial<Record<'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {}) =>
    keyToAction({ key, ...mods })

  eq(a('ArrowDown'), { kind: 'move', dr: 1, dc: 0, unit: 'cell', extend: false }, 'ArrowDown moves one cell')
  eq(a('ArrowRight', { shiftKey: true }), { kind: 'move', dr: 0, dc: 1, unit: 'cell', extend: true },
    'shift+Arrow EXTENDS')
  eq(a('ArrowDown', { metaKey: true }), { kind: 'move', dr: 1, dc: 0, unit: 'edge', extend: false },
    '⌘Arrow jumps to the edge of the data')
  eq(a('ArrowDown', { ctrlKey: true }), { kind: 'move', dr: 1, dc: 0, unit: 'edge', extend: false },
    'ctrl+Arrow is the same jump — one binding for both platforms')
  eq(a('ArrowDown', { metaKey: true, shiftKey: true }), { kind: 'move', dr: 1, dc: 0, unit: 'edge', extend: true },
    '⌘⇧Arrow jumps AND extends')
  // the wrong answer: a modifier we do not own must not become the bare key
  ok(a('ArrowDown', { altKey: true }) === null,
    'alt+ArrowDown is NOT a move — alt opens a menu in every spreadsheet, and swallowing it steals the shortcut')

  eq(a('Tab'), { kind: 'tab', back: false }, 'Tab')
  eq(a('Tab', { shiftKey: true }), { kind: 'tab', back: true }, 'shift+Tab goes back')
  eq(a('Enter'), { kind: 'enter', back: false }, 'Enter')
  eq(a('Enter', { shiftKey: true }), { kind: 'enter', back: true }, 'shift+Enter goes up')
  eq(a('Home'), { kind: 'home', whole: false, extend: false }, 'Home')
  eq(a('Home', { metaKey: true }), { kind: 'home', whole: true, extend: false }, '⌘Home is the whole sheet')
  eq(a('End', { shiftKey: true }), { kind: 'end', whole: false, extend: true }, 'shift+End extends to the row end')
  eq(a('PageDown'), { kind: 'move', dr: 1, dc: 0, unit: 'page', extend: false }, 'PageDown is a page-unit move')
  eq(a('PageUp'), { kind: 'move', dr: -1, dc: 0, unit: 'page', extend: false }, 'PageUp')
  eq(a('Escape'), { kind: 'cancel' }, 'Escape')
  eq(a('Delete'), { kind: 'clear' }, 'Delete clears')
  eq(a('Backspace'), { kind: 'clear' }, 'Backspace clears too — a Mac keyboard has no Delete key')
  eq(a('F2'), { kind: 'edit' }, 'F2 edits')

  eq(a('a', { metaKey: true }), { kind: 'selectAll' }, '⌘A selects all')
  eq(a('c', { metaKey: true }), { kind: 'copy' }, '⌘C')
  eq(a('x', { metaKey: true }), { kind: 'cut' }, '⌘X')
  eq(a('v', { metaKey: true }), { kind: 'paste' }, '⌘V')
  eq(a('z', { metaKey: true }), { kind: 'undo' }, '⌘Z undoes')
  eq(a('Z', { metaKey: true, shiftKey: true }), { kind: 'redo' },
    '⌘⇧Z redoes — and the key arrives UPPERCASE, which is why the mapping folds case')
  eq(a('y', { metaKey: true }), { kind: 'redo' }, '⌘Y redoes (Windows)')
  eq(a(' ', { shiftKey: true }), { kind: 'selectRow' }, '⇧Space selects the row')
  eq(a(' ', { ctrlKey: true }), { kind: 'selectCol' }, '^Space selects the column')

  // the wrong answers: unmodified typing must reach the cell, not the shortcut
  ok(a('a') === null, 'a bare "a" is NOT select-all — it is the user typing')
  ok(a('z') === null, 'a bare "z" is not undo')
  ok(a(' ') === null, 'a bare space is not a selection command')
  ok(a('F5') === null, 'a key this model does not own returns null rather than being swallowed')
}

// ------------------------------------------------- moving, clamping, extend
{
  const s = new Selection(10, 4)
  eq(at(s), [0, 0], 'a fresh selection sits on the first cell')
  s.move(1, 1)
  eq(at(s), [1, 1], 'move is relative')
  s.move(-5, -5)
  eq(at(s), [0, 0], 'and clamps at the top-left rather than going negative')
  s.move(99, 99)
  eq(at(s), [9, 3], 'and at the bottom-right rather than off the sheet')

  s.moveTo(2, 2)
  s.extend(1, 1)
  eq(normalize(s.active), { top: 2, left: 2, bottom: 3, right: 3 }, 'shift+arrow grows the range')
  eq(at(s), [2, 2], 'and the ACTIVE CELL does not move — only the head does')
  s.extend(-2, -2)
  eq(normalize(s.active), { top: 1, left: 1, bottom: 2, right: 2 },
    'extending back THROUGH the anchor flips the box rather than collapsing it')
}
{
  // the cursor may never be left outside the highlight
  const s = new Selection(10, 10)
  s.moveTo(0, 0)
  s.extendTo(5, 5)
  s.tab()
  eq(at(s), [0, 1], 'Tab inside a range walks the active cell')
  s.extendTo(0, 0)
  eq(at(s), [0, 0], 'shrinking the range past the active cell snaps it back to the anchor')
}

// ------------------------------------------------- Tab: single cell vs range
{
  const s = new Selection(6, 3)
  s.moveTo(1, 0)
  s.tab()
  eq(at(s), [1, 1], 'with ONE cell selected, Tab moves plainly right')
  eq(size(s.active), { rows: 1, cols: 1 }, 'and the selection stays a single cell')
  s.tab()
  s.tab()
  eq(at(s), [1, 2], 'and stops at the last column')
  ok(!(s.cursor.row === 2), 'a single-cell Tab does NOT wrap to the next row — that is a jump nobody asked for')
  s.tab(true)
  eq(at(s), [1, 1], 'shift+Tab goes back')
}
{
  const s = new Selection(8, 6)
  s.moveTo(1, 1)
  s.extendTo(3, 3)                                   // a 3×3 block
  const box = normalize(s.active)
  s.tab(); s.tab()
  eq(at(s), [1, 3], 'inside a range, Tab walks to the range edge')
  s.tab()
  eq(at(s), [2, 1], 'and WRAPS to the next row of the range — this is how data entry works')
  ok(!(s.cursor.col === 4), 'it does not walk out of the right-hand side of the block')
  eq(normalize(s.active), box, 'and the block itself never moved')
  // round the corner
  for (let i = 0; i < 6; i++) s.tab()
  eq(at(s), [1, 1], 'tabbing past the bottom-right corner comes back to the top-left')
  s.tab(true)
  eq(at(s), [3, 3], 'shift+Tab from the top-left wraps back round to the bottom-right')

  s.moveTo(1, 1); s.extendTo(3, 3)
  s.enter(); s.enter()
  eq(at(s), [3, 1], 'inside a range, Enter walks down it')
  s.enter()
  eq(at(s), [1, 2], 'and wraps into the next COLUMN at the bottom')
}

// ------------------------------------------------------------- the Tab run
{
  const s = new Selection(10, 5)
  s.moveTo(2, 0)
  s.tab(); s.tab()
  eq(at(s), [2, 2], 'Tab, Tab across a row')
  s.enter()
  eq(at(s), [3, 0], 'Enter returns to the COLUMN THE RUN STARTED IN, one row down')
  ok(!(s.cursor.col === 2),
    'and NOT under the last cell typed — that is the bug that walks a typist diagonally across their table')
  s.tab()
  s.enter()
  eq(at(s), [4, 0], 'the landing cell becomes the new run start, so the next row does the same')
  s.enter()
  eq(at(s), [5, 0], 'Enter with no Tab since simply moves down')

  s.moveTo(2, 0)
  s.tab(); s.tab()
  s.move(1, 0)                                       // an arrow key
  s.enter()
  eq(at(s), [4, 2], 'an arrow key ENDS the run: Enter then moves plainly down from where it is')
  ok(!(s.cursor.col === 0), 'it does not come home to a run that was abandoned')

  s.moveTo(0, 0)
  s.enter(true)
  eq(at(s), [0, 0], 'shift+Enter at the top row stays put rather than clamping into a lie')
  s.moveTo(3, 1)
  s.enter(true)
  eq(at(s), [2, 1], 'shift+Enter moves up')
}

// ------------------------------------------------------------ the ⌘↓ jump
{
  // one column of data: rows 0-4 filled, 5-7 blank, 8-9 filled, 10-11 blank
  const ROWS = 12
  const filled = (row: number, col: number): boolean =>
    col === 0 && ((row >= 0 && row <= 4) || row === 8 || row === 9)
  const s = new Selection(ROWS, 3)
  const jump = (row: number, col: number, dr: number, dc = 0): [number, number] => {
    s.moveTo(row, col)
    s.move(dr, dc, { jump: true, filled })
    return at(s)
  }

  eq(jump(0, 0, 1), [4, 0], '⌘↓ from inside a block lands on the LAST filled cell of the block')
  ok(!(s.cursor.row === 1), 'it is not a one-cell move')
  ok(!(s.cursor.row === ROWS - 1), 'and it does not run past the block to the end of the sheet')
  eq(jump(4, 0, 1), [8, 0], '⌘↓ from the end of a block crosses the blanks to the next block')
  eq(jump(5, 0, 1), [8, 0], '⌘↓ from a BLANK cell lands on the next filled cell')
  ok(!(s.cursor.row === 5), 'the naive "walk while filled" never leaves a blank cell; this does')
  eq(jump(8, 0, 1), [9, 0], '⌘↓ inside the second block runs to its end')
  eq(jump(9, 0, 1), [ROWS - 1, 0], 'with nothing below, ⌘↓ stops at the last row OF THIS SHEET')
  ok(s.cursor.row === ROWS - 1,
    'the jump lands EXACTLY on this sheet\'s last row — not one past it, and not at some notional Excel row limit')
  eq(jump(ROWS - 1, 0, 1), [ROWS - 1, 0], '⌘↓ already at the boundary stays put')
  eq(jump(9, 0, -1), [8, 0], '⌘↑ runs to the near end of the block it is in')
  eq(jump(6, 0, -1), [4, 0], '⌘↑ from a blank crosses back to the previous block')
  eq(jump(2, 1, 1), [ROWS - 1, 1], 'an entirely empty column jumps to the sheet boundary')

  s.moveTo(0, 0)
  s.move(1, 0, { jump: true })
  eq(at(s), [ROWS - 1, 0], 'a jump with no data probe degenerates to the boundary — bounded, not stuck')

  s.moveTo(0, 0)
  s.move(1, 0, { jump: true, extend: true, filled })
  eq(normalize(s.active), { top: 0, left: 0, bottom: 4, right: 0 }, '⌘⇧↓ selects the block')
  eq(at(s), [0, 0], 'and leaves the active cell at the anchor')
}

// --------------------------------------------- select all / row / col / add
{
  const s = new Selection(5, 4)
  s.moveTo(2, 2)
  s.selectAll()
  eq(normalize(s.active), { top: 0, left: 0, bottom: 4, right: 3 }, '⌘A selects the whole grid')
  eq(at(s), [2, 2], 'and leaves the active cell where it was')

  s.selectRow(3)
  eq(normalize(s.active), { top: 3, left: 0, bottom: 3, right: 3 }, 'selectRow spans every column')
  eq(at(s), [3, 2], 'and the active cell moves onto that ROW, keeping its column')
  s.selectCol(1)
  eq(normalize(s.active), { top: 0, left: 1, bottom: 4, right: 1 }, 'selectCol spans every row')
  eq(at(s), [3, 1], 'and onto that COLUMN, keeping its row — the active cell is never outside the selection')

  s.moveTo(0, 0)
  s.addRange(rangeOf(2, 2, 3, 3))
  eq(normalize(s.active), { top: 2, left: 2, bottom: 3, right: 3 },
    'a ⌘-clicked range becomes the ACTIVE one — it is what the next shift+arrow must extend')
  eq(s.extra.length, 1, 'and the previous range is kept alongside')
  eq(s.bounds(), { top: 0, left: 0, bottom: 3, right: 3 }, 'bounds covers every range')
}
{
  const s = new Selection(5, 5)
  s.moveTo(0, 0); s.extendTo(1, 1)                   // 4 cells
  s.addRange(rangeOf(1, 1, 2, 2))                    // 4 cells, overlapping at (1,1)
  const list = [...s.cells()]
  eq(list.length, 7, 'cells() yields each cell ONCE across overlapping ranges')
  ok(!(list.length === 8), 'the shared corner is not counted twice')
  const key = (c: CellRef) => `${c.row}:${c.col}`
  ok(new Set(list.map(key)).size === list.length, 'and there are no duplicates in the output')

  const one = new Selection(3, 3)
  one.moveTo(0, 0); one.extendTo(2, 2)
  eq([...one.cells()].length, 9, 'a single range yields its whole box')
  eq(key([...one.cells()][1]), '0:1', 'in row-major order')
}
{
  const s = new Selection(20, 5)
  s.moveTo(19, 4)
  s.resize(4, 2)
  eq(at(s), [3, 1], 'resize pulls a selection that is now off the grid back on to it')
  eq(normalize(s.active), { top: 3, left: 1, bottom: 3, right: 1 }, 'range included')
}

// ----------------------------------------------------- key → motion, joined
{
  const s = new Selection(30, 5)
  const filled = (row: number, col: number) => col === 0 && row <= 6
  const press = (key: string, mods: Record<string, boolean> = {}): boolean => {
    const a: Action | null = keyToAction({ key, ...mods })
    return a ? applyMotion(s, a, { page: 10, filled }) : false
  }
  s.moveTo(0, 0)
  press('ArrowDown')
  eq(at(s), [1, 0], 'a plain ArrowDown, all the way from a key event')
  press('ArrowDown', { metaKey: true })
  eq(at(s), [6, 0], 'and ⌘↓ through the same path lands on the end of the block')
  press('PageDown')
  eq(at(s), [16, 0], 'PageDown moves by the caller-supplied page size, not by one')
  press('Home')
  eq(at(s), [16, 0], 'Home goes to the first column of the row')
  press('End')
  eq(at(s), [16, 4], 'End goes to the last column of the row')
  press('Home', { metaKey: true })
  eq(at(s), [0, 0], '⌘Home is the first cell of the sheet')
  press('End', { metaKey: true })
  eq(at(s), [29, 4], '⌘End is the last cell of the sheet')
  ok(press('ArrowUp') === true, 'applyMotion reports a motion it handled')
  ok(press('c', { metaKey: true }) === false,
    'and reports FALSE for ⌘C — the clipboard is not a selection operation, and pretending it is loses the copy')
  ok(press('F5') === false, 'an unmapped key is not consumed')
}

// ----------------------------------------------------------------- TSV out
{
  const g = [['a', 'b'], ['c', 'd']]
  const text = tsvFromRange((r, c) => g[r][c], rangeOf(0, 0, 1, 1))
  eq(text, 'a\tb\nc\td', 'a plain block serialises tab-separated, newline-delimited')
  eq(parseTsv(text), g, 'and parses straight back')

  eq(tsvFromRange(() => null, rangeOf(0, 0, 0, 1)), '\t', 'an empty cell is an empty field, not the word "null"')
  eq(tsvFromRange((r, c) => (r * 10 + c), rangeOf(1, 1, 2, 2)), '11\t12\n21\t22',
    'a range that does not start at the origin serialises its own box')
}

// ---------------------------------------------------------- TSV round trip
{
  const nasty = [
    ['plain', 'has\ttab'],
    ['has\nnewline', 'has"quote'],
    ['', 'a,b'],
  ]
  const text = tsvFromRange((r, c) => nasty[r][c], rangeOf(0, 0, 2, 1))
  eq(parseTsv(text), nasty,
    'a cell containing a TAB, a NEWLINE or a QUOTE survives tsvFromRange → parseTsv unchanged')
  ok(text.includes('"has\ttab"'), 'the tab cell is quoted on the way out')
  ok(text.includes('"has""quote"'), 'and an embedded quote is doubled')
  // the assertion that proves the quoting is load-bearing
  ok(text.split('\n').length !== nasty.length,
    'the serialised text has MORE newlines than rows — a naive split() would paste the block shifted')

  eq(parseTsv('a,b'), [['a,b']], 'a comma is data here: TSV is not CSV and there is no delimiter sniffing')
  eq(parseTsv('5" pipe\tx'), [['5" pipe', 'x']],
    'a quote in the MIDDLE of a field is literal — only a leading quote opens a quoted field')
  eq(parseTsv('"a""b"'), [['a"b']], 'a doubled quote inside a quoted field is one quote')
  eq(parseTsv('a\r\nb'), [['a'], ['b']], 'CRLF rows (what Excel puts on the clipboard)')
  eq(parseTsv('"x\r\ny"'), [['x\ny']], 'and a CRLF INSIDE a quoted cell is one line break, not two characters')
  eq(parseTsv('a\n'), [['a']], 'a trailing newline ends the last row rather than starting an empty one')
  eq(parseTsv('a\t'), [['a', '']], 'but a trailing TAB is a real trailing empty cell')
  eq(parseTsv(''), [['']],
    'empty text is ONE EMPTY CELL: a copied blank must paste as a blank and clear what it lands on')
  ok(!(j(parseTsv('')) === j([])),
    'returning nothing there would make pasting a blank a silent no-op over a value the user thinks they replaced')
  eq(parseTsv('a\n\nb'), [['a'], [''], ['b']], 'a blank row inside a paste is a blank row')
}

// ------------------------------------------------------------------- fills
{
  eq(fillDown([1, 2, 3], 6), [1, 2, 3, 1, 2, 3], 'fillDown repeats the seeds')
  eq(fillDown([1, 2, 3], 2), [1, 2], 'a target shorter than the seeds truncates')
  eq(fillDown(['x'], 3), ['x', 'x', 'x'], 'one seed repeats')
  eq(fillDown([], 3), [], 'no seeds, nothing to fill')
  eq(fillDown([1], 0), [], 'no target, nothing to fill')

  eq(fillSeries([1, 2, 3], 6), [1, 2, 3, 4, 5, 6], 'fillSeries continues an arithmetic progression')
  eq(fillSeries([1, 2, 3], 6).slice(3), [4, 5, 6], 'fillSeries on [1,2,3] gives 4,5,6')
  ok(!(j(fillSeries([1, 2, 3], 6)) === j([1, 2, 3, 1, 2, 3])), 'and NOT 1,2,3 repeated')
  eq(fillSeries([10, 20], 4), [10, 20, 30, 40], 'a step of ten continues by ten')
  eq(fillSeries([1, 3, 5], 5), [1, 3, 5, 7, 9], 'odd numbers')
  eq(fillSeries([5, 3, 1], 5), [5, 3, 1, -1, -3], 'a DESCENDING progression keeps descending, through zero')
  eq(fillSeries([1, 2, 4], 5), [1, 2, 4, 1, 2], 'a non-progression repeats rather than inventing a rule')
  // THREE seeds, not two: constantStep only compares gaps from the third
  // element onward, so a two-seed fixture never reaches the tolerance branch
  // and the check passes against an exact-equality implementation. Mutation
  // testing proved the two-seed version vacuous.
  eq(fillSeries([0.1, 0.2, 0.3], 6), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    'a decimal progression continues — 0.3-0.2 and 0.2-0.1 are DIFFERENT doubles, so exact equality refuses it')
  eq(fillSeries([0.8, 0.9], 4), [0.8, 0.9, 1, 1.1],
    'and the step is rounded to the SEEDS precision, not the float artefact (0.09999999999999998)')
  eq(fillSeries(['0.8', '0.9'], 4), ['0.8', '0.9', '1.0', '1.1'],
    'a TEXT column of decimals continues numerically — the label path would read "0." + 8 and emit "0.10", which is SMALLER than what it follows')
  eq(fillSeries([7], 3), [7, 7, 7], 'a LONE number is a constant, not the start of a count')
  eq(fillSeries([5, 5], 4), [5, 5, 5, 5], 'and a flat run stays flat')

  eq(fillSeries(['a', 'b'], 4), ['a', 'b', 'a', 'b'], 'text with no progression repeats')
  ok(!(j(fillSeries(['a', 'b'], 4)) === j(['a', 'b', 'c', 'd'])), 'it does not invent an alphabet')
  eq(fillSeries(['Q1'], 4), ['Q1', 'Q2', 'Q3', 'Q4'], 'a LONE numbered label continues — "Q1" → "Q2"')
  eq(fillSeries(['Q1', 'Q3'], 4), ['Q1', 'Q3', 'Q5', 'Q7'], 'and honours the step it was given')
  eq(fillSeries(['Item 01', 'Item 02'], 4), ['Item 01', 'Item 02', 'Item 03', 'Item 04'],
    'zero padding is part of the label and is kept')
  eq(fillSeries(['Q1', 'P2'], 4), ['Q1', 'P2', 'Q1', 'P2'], 'two different labels are not a series')
  eq(fillSeries(['1', '2'], 4), ['1', '2', '3', '4'], 'numeric TEXT continues as text — a text column stays text')
  ok(typeof fillSeries(['1', '2'], 4)[3] === 'string', 'and does not quietly become a number')

  eq(fillSeries(['2026-01-01'], 3), ['2026-01-01', '2026-01-02', '2026-01-03'],
    'a LONE date continues by a day — the one place a single seed is a series')
  eq(fillSeries(['2026-01-01', '2026-01-08'], 4),
    ['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22'], 'a weekly step')
  eq(fillSeries(['2026-01-01', '2026-02-01'], 4),
    ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'], 'a MONTHLY step stays on the first of the month')
  ok(!(fillSeries(['2026-01-01', '2026-02-01'], 3)[2] === '2026-03-04'),
    'a month is not 31 days — reading the gap as days would land on 4 March')
  eq(fillSeries(['2025-12-31', '2026-01-31'], 3), ['2025-12-31', '2026-01-31', '2026-02-28'],
    'a month step CLAMPS to the end of a short month rather than spilling into March')
  eq(fillSeries(['2026-02-27', '2026-02-28'], 4),
    ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02'], 'a daily step crosses a month boundary')
  eq(fillSeries(['2026-12-30', '2026-12-31'], 4),
    ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'], 'and a year boundary')
  eq(fillSeries(['not-a-date', 'either'], 3), ['not-a-date', 'either', 'not-a-date'], 'text that is not a date repeats')

  eq(fillSeries([1, 'a'], 4), [1, 'a', 1, 'a'], 'mixed types are not a series')
  eq(fillSeries([true, false], 3), [true, false, true], 'booleans repeat')
  eq(fillSeries([null, null], 3), [null, null, null], 'blanks repeat')
  eq(fillSeries([1, 2, 3], 2), [1, 2], 'a series target shorter than the seeds truncates too')
}

// ROW HEIGHT IS DECLARED TWICE and the two must agree.
//
// grid.ts positions every virtualised row at `top: i * ROW_H` while its height
// comes from the stylesheet's `--row-h`. When they disagree the grid
// PERFORATES — cells shrink, row boxes do not — and that is what stopped the
// Excel-density change the first time it was attempted. The grid writes the
// property from the constant when it mounts, so the running app cannot drift;
// this guards the stylesheet FALLBACK, which is what renders in the moment
// before the grid exists.
{
  const src = readFileSync(new URL('../dash/src/grid.ts', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../dash/src/styles.css', import.meta.url), 'utf8')
  const fromTs = Number(src.match(/^const ROW_H = (\d+)$/m)?.[1])
  const fromCss = Number(css.match(/--row-h:\s*(\d+)px/)?.[1])
  ok(Number.isFinite(fromTs), `grid.ts declares ROW_H (${fromTs})`)
  ok(Number.isFinite(fromCss), `styles.css declares --row-h (${fromCss})`)
  ok(fromTs === fromCss,
    `and they AGREE (${fromTs} vs ${fromCss}) — disagreement perforates the grid`)
  ok(fromTs <= 26,
    `row height is spreadsheet density, not web-table density (${fromTs}px; Excel is 20, Sheets 21)`)
  ok(src.includes("setProperty('--row-h'"),
    'and grid.ts WRITES the property from the constant, so the running app cannot drift at all')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
