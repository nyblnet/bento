#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash A1 addressing rig.
//
//   node scripts/test-dash-a1.ts
//
// WHAT THIS PROVES. dash's COLUMN formulas cannot produce `#REF!`: they name a
// column by identity, so structural edits move nothing. A1 references
// reintroduce the whole class, and every failure in it is a plausible number
// rather than a crash:
//
//   1. A REFERENCE THAT DOES NOT MOVE. Insert a row above `A5` and it must be
//      `A6`. If it stays `A5` it now reads the inserted blank row — a total
//      that is short by one row and looks entirely normal.
//   2. A DEAD REFERENCE THAT STAYS ALIVE. Delete row 5 and `A5` must become
//      `#REF!`, NOT keep pointing at whatever slid up into that position. This
//      is the headline check: the wrong answer here is another customer's
//      number in your invoice.
//   3. `$` MISREAD. `$A$1` must NOT move under fill and MUST move under insert.
//      Both halves are asserted, because implementations get exactly one of
//      them right.
//   4. A LABEL TREATED AS AN ADDRESS. `="A1 is "&A1` shifted a row is
//      `="A1 is "&A2`. Text inside quotes is not a reference, and neither is
//      `LOG10(`, `Sheet1!` or `[REV2024]`.
//   5. THE 27th COLUMN. Plain base-26 puts `BA` where `AA` belongs, and nobody
//      notices until a workbook is 27 columns wide.

import {
  colToLetters, lettersToCol, parseRef, formatRef, parseRange, formatRange,
  expandRange, translateRef, rewriteFormulaRefs, shiftRefsForInsert,
  REF_ERR, RANGE_CELL_MAX, type CellRef,
} from '../dash/src/a1.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// ------------------------------------------------------- column letters
ok(colToLetters(0) === 'A' && colToLetters(25) === 'Z', '0 is A, 25 is Z')
ok(colToLetters(26) === 'AA', '26 is AA — bijective base-26, the 27th column')
ok(colToLetters(26) !== 'BA', 'and NOT BA, which plain base-26 would give')
ok(colToLetters(701) === 'ZZ' && colToLetters(702) === 'AAA', '701 is ZZ, 702 is AAA')
ok(lettersToCol('A') === 0 && lettersToCol('Z') === 25, 'letters back to 0 and 25')
ok(lettersToCol('AA') === 26, 'AA is 26, not 27 — there is no zero digit')
ok(lettersToCol('ZZ') === 701 && lettersToCol('AAA') === 702, 'ZZ and AAA')
ok(lettersToCol('aa') === 26, 'letters are case-insensitive')

{
  // the whole point of a bijective encoding: it round-trips at EVERY index,
  // including the ones either side of each carry (25/26, 701/702)
  let bad = -1
  for (let i = 0; i <= 1000; i++) {
    if (lettersToCol(colToLetters(i)) !== i) { bad = i; break }
  }
  ok(bad < 0, 'colToLetters → lettersToCol round-trips for every index 0..1000')

  // and no two indices share a spelling — the failure a non-bijective scheme
  // actually produces
  const seen = new Set<string>()
  for (let i = 0; i <= 1000; i++) seen.add(colToLetters(i))
  ok(seen.size === 1001, 'and all 1001 spellings are distinct')
}

ok(colToLetters(-1) === '' && colToLetters(1.5) === '', 'a non-index has no letters')
ok(lettersToCol('') === -1 && lettersToCol('A1') === -1 && lettersToCol('$A') === -1,
  'anything that is not letters is -1, not NaN — NaN would compute a plausible ref')

// -------------------------------------------------------------- parseRef
{
  const a1 = parseRef('A1')!
  ok(a1.col === 0 && a1.row === 0, 'A1 is {col:0,row:0} — rows are 0-BASED here')
  ok(!(a1.row === 1), 'the 1 in A1 is display, and is not stored')
  ok(!a1.absCol && !a1.absRow, 'A1 is relative in both axes')
}
{
  const r = parseRef('$A$1')!
  ok(r.absCol && r.absRow && r.col === 0 && r.row === 0, '$A$1 is absolute in both')
  ok(parseRef('A$1')!.absRow && !parseRef('A$1')!.absCol, 'A$1 pins the row only')
  ok(parseRef('$A1')!.absCol && !parseRef('$A1')!.absRow, '$A1 pins the column only')
}
{
  const r = parseRef('bc12')!
  ok(r.col === lettersToCol('BC') && r.row === 11, 'lowercase parses')
  ok(parseRef('$b$2')!.absCol && parseRef('$b$2')!.absRow, 'and so does lowercase with $')
}
ok(parseRef('A0') === null, 'A0 is not a cell — rows start at 1 on the page')
ok(parseRef('A') === null && parseRef('1') === null && parseRef('') === null,
  'half an address is not an address')
ok(parseRef('A1:B2') === null, 'a range is not a single reference')
ok(parseRef('REVENUE2024') === null,
  'over 3 letters is a NAME, not a cell — dash columns live in the same expression')
ok(parseRef('A12345678') === null, 'over 7 digits is past any sheet, so not a cell')
ok(parseRef('REV2024') !== null,
  'but REV2024 IS cell-shaped and resolves as a cell, as it does in every spreadsheet')
ok(parseRef(' A1 ') !== null, 'surrounding space is tolerated')

// ------------------------------------------------------------- formatRef
ok(formatRef({ col: 0, row: 0, absCol: false, absRow: false }) === 'A1', 'formatRef is the inverse')
ok(formatRef(parseRef('$A$1')!) === '$A$1', '$A$1 round-trips')
ok(formatRef(parseRef('a$1')!) === 'A$1', 'and canonicalises the case')
ok(formatRef(parseRef('$B$27')!) === '$B$27', 'a two-digit row round-trips')
{
  let bad = ''
  for (const s of ['A1', '$A$1', 'A$1', '$A1', 'ZZ100', 'AAA1', 'B12']) {
    if (formatRef(parseRef(s)!) !== s) { bad = s; break }
  }
  ok(!bad, `parseRef → formatRef round-trips every $ shape (${bad || 'all'})`)
}
ok(formatRef({ col: -1, row: 0, absCol: false, absRow: false }) === REF_ERR,
  'a column off the left edge formats as #REF!')
ok(formatRef({ col: 0, row: -1, absCol: false, absRow: false }) === REF_ERR,
  'and a row off the top — never A0, which would parse back as nothing')

// ---------------------------------------------------------------- ranges
{
  const r = parseRange('A1:B10')!
  ok(r.from.col === 0 && r.from.row === 0 && r.to.col === 1 && r.to.row === 9, 'A1:B10 parses')
  ok(formatRange(r) === 'A1:B10', 'and formats back')
  ok(parseRange('$A$1:$B$10') !== null, 'absolute ranges parse')
  ok(parseRange('A1') === null, 'a lone reference is not a range')
  ok(parseRange('A1:') === null && parseRange('A1:nope!') === null,
    'half a range is not a range')
}
{
  const cells = expandRange(parseRange('A1:B10')!)!
  ok(cells.length === 20, 'A1:B10 expands to 20 cells')
  ok(formatRef(cells[0]) === 'A1' && formatRef(cells[1]) === 'B1',
    'in reading order — row-major, so the second cell is B1 not A2')
  ok(formatRef(cells[19]) === 'B10', 'and ends at the far corner')
  ok(!cells.some((c) => c.col > 1 || c.row > 9), 'and nothing outside the rectangle')
  ok(!cells.some((c: CellRef) => c.absCol || c.absRow),
    'expanded cells are ADDRESSES — $ describes a written reference, not a cell')
  ok(expandRange(parseRange('$A$1:$B$2')!)!.length === 4, '$ does not change what a range covers')
}
{
  const back = expandRange(parseRange('B10:A1')!)!
  ok(back.length === 20 && formatRef(back[0]) === 'A1',
    'the corners normalise — B10:A1 is the same area as A1:B10')
}
{
  const atCap = expandRange({
    from: { col: 0, row: 0, absCol: false, absRow: false },
    to: { col: 999, row: 999, absCol: false, absRow: false },
  })
  ok(atCap !== null && atCap.length === RANGE_CELL_MAX, `exactly ${RANGE_CELL_MAX} cells still expands`)
  const over = expandRange({
    from: { col: 0, row: 0, absCol: false, absRow: false },
    to: { col: 999, row: 1000, absCol: false, absRow: false },
  })
  ok(over === null, 'one cell past the cap returns null rather than allocating')
  // the one a person actually types
  ok(expandRange(parseRange('A1:A1048576')!) === null,
    'a whole-column range is refused, not expanded into a dead tab')
}

// ------------------------------------------------- translateRef (fill)
ok(translateRef('A1', 1, 0) === 'A2', 'fill down moves the row')
ok(translateRef('A1', 0, 1) === 'B1', 'fill right moves the column')
ok(translateRef('B2', 2, 3) === 'E4', 'both at once')
ok(translateRef('$A$1', 1, 0) === '$A$1', '$A$1 does NOT move under fill')
ok(!(translateRef('$A$1', 1, 0) === '$A$2'), 'specifically: it does not become $A$2')
ok(translateRef('A$1', 5, 2) === 'C$1', 'A$1 moves sideways only')
ok(translateRef('$A1', 5, 2) === '$A6', '$A1 moves down only')
ok(translateRef('a1', 1, 0) === 'A2', 'case is canonicalised on the way out')
ok(translateRef('A1', -1, 0) === REF_ERR, 'filling A1 upward is #REF!, not A1')
ok(translateRef('A1', 0, -1) === REF_ERR, 'and off the left edge is #REF!')
ok(translateRef('B2', -1, -1) === 'A1', 'but a legal negative offset is fine')
ok(translateRef('SUM', 1, 0) === 'SUM', 'a non-address comes back untouched')
ok(translateRef('A1', 0, 0) === 'A1', 'a zero offset is identity')

// -------------------------------------------------- rewriteFormulaRefs
ok(rewriteFormulaRefs('=A1+B1', 1, 0) === '=A2+B2', 'every reference in the expression moves')
ok(rewriteFormulaRefs('=SUM(A1:A10)', 1, 0) === '=SUM(A2:A11)', 'both ends of a range move')
ok(rewriteFormulaRefs('=$A$1*B2', 3, 2) === '=$A$1*D5', '$ survives beside a relative ref')
ok(rewriteFormulaRefs('=A$1+$A1', 2, 2) === '=C$1+$A3', 'mixed anchoring, one row and one column')
ok(rewriteFormulaRefs('=A1+B1', 0, 0) === '=A1+B1', 'a zero offset changes nothing')

// the string-literal case, spelled out in the task
ok(rewriteFormulaRefs('="A1 is "&A1', 1, 0) === '="A1 is "&A2',
  '="A1 is "&A1 shifted a row is ="A1 is "&A2 — quoted text is a LABEL')
ok(!rewriteFormulaRefs('="A1 is "&A1', 1, 0).includes('A2 is'),
  'and the label is definitely not rewritten')
ok(rewriteFormulaRefs('="a""A1""b"', 1, 0) === '="a""A1""b"',
  'an escaped quote does not end the literal early')

ok(rewriteFormulaRefs('=LOG10(A1)', 1, 0) === '=LOG10(A2)',
  'LOG10 is a function name, not cell LOG10 — it must not become LOG11')
ok(rewriteFormulaRefs('=Sheet1!A1', 1, 0) === '=Sheet1!A2',
  'Sheet1 qualifies, A1 moves — the sheet name is cell-shaped and must survive')
ok(rewriteFormulaRefs('=[REV2024]*A1', 1, 0) === '=[REV2024]*A2',
  'a [bracketed] name is the escape hatch for a column named like a cell')
ok(rewriteFormulaRefs('=REV2024*2', 1, 0) === '=REV2025*2',
  'unbracketed, REV2024 IS a cell — documented, and why the escape hatch exists')
ok(rewriteFormulaRefs('=REVENUE2024*A1', 1, 0) === '=REVENUE2024*A2',
  'a name over 3 letters is never a cell, so ordinary dash columns are safe')
ok(rewriteFormulaRefs('=Price*Qty', 1, 0) === '=Price*Qty',
  'a column formula passes through untouched — the two systems coexist')
ok(rewriteFormulaRefs('=A1+#REF!', 1, 0) === '=A2+#REF!',
  'an existing #REF! stays #REF! and does not become a reference')
ok(rewriteFormulaRefs('=A1:B2', -1, 0) === `=${REF_ERR}`,
  'a range with a corner off the sheet is #REF! whole, not #REF!:B1')
ok(!rewriteFormulaRefs('=A1:B2', -1, 0).includes(':'),
  'specifically: no half-range survives')
ok(rewriteFormulaRefs('=IF(A1>0,"A1","B1")', 1, 0) === '=IF(A2>0,"A1","B1")',
  'inside a call: the argument moves, the two labels do not')

// -------------------------------------------- shiftRefsForInsert (rows)
ok(shiftRefsForInsert('=A5', 'row', 0, 1) === '=A6', 'inserting a row above pushes the ref down')
ok(shiftRefsForInsert('=A5', 'row', 9, 1) === '=A5', 'inserting BELOW it changes nothing')
ok(shiftRefsForInsert('=A5', 'row', 4, 1) === '=A6',
  'inserting AT the referenced row pushes it down — the cell moved')
ok(shiftRefsForInsert('=A5', 'row', 0, 3) === '=A8', 'three rows move it three')

// $ under structure: the half everyone gets wrong
ok(shiftRefsForInsert('=$A$5', 'row', 0, 1) === '=$A$6',
  '$A$5 DOES move when a row is inserted above it — $ pins against fill, not structure')
ok(!(shiftRefsForInsert('=$A$5', 'row', 0, 1) === '=$A$5'),
  'specifically: $ does not freeze it in place while the cell moves')
ok(shiftRefsForInsert('=A$5', 'row', 0, 1) === '=A$6', 'and the same for a pinned row alone')

// deletion — the headline
{
  const after = shiftRefsForInsert('=A5+A10', 'row', 4, -1)
  ok(after === '=#REF!+A9',
    'deleting row 5: the reference INTO it is #REF!, and the live one moves up')
  ok(!after.includes('=A5'),
    'and A5 does NOT survive pointing at whatever slid into that position')
  ok(after !== '=A5+A9', 'specifically: not the silent re-point, which is the wrong number')
}
ok(shiftRefsForInsert('=A1', 'row', 4, -1) === '=A1', 'a reference above the deletion is untouched')
ok(shiftRefsForInsert('=A5+A6+A7', 'row', 4, -3) === '=#REF!+#REF!+#REF!',
  'every reference inside a multi-row deletion dies')
ok(shiftRefsForInsert('=A8', 'row', 4, -3) === '=A5', 'and the row below it moves up by three')
ok(shiftRefsForInsert('=B7', 'row', 3, -1) === '=B6',
  'a row edit never touches the column letter')
ok(!(shiftRefsForInsert('=B7', 'row', 3, -1) === '=A6'), 'specifically: B does not become A')
ok(shiftRefsForInsert('=A5', 'row', 0, 0) === '=A5', 'a zero-count edit is identity')

// ranges across a structural edit
ok(shiftRefsForInsert('=SUM(A1:A10)', 'row', 2, -3) === '=SUM(A1:A7)',
  'deleting three rows from inside a range SHRINKS it — the other numbers are still there')
ok(shiftRefsForInsert('=SUM(A3:A5)', 'row', 2, -3) === '=SUM(#REF!)',
  'but a range whose every row was deleted is #REF!, not an empty range summing to 0')
ok(shiftRefsForInsert('=SUM(A1:A4)', 'row', 2, -4) === '=SUM(A1:A2)',
  'a range whose BOTTOM fell into the hole ends at the last surviving row')
ok(!(shiftRefsForInsert('=SUM(A1:A4)', 'row', 2, -4) === '=SUM(A1:A3)'),
  'specifically: it does not stretch over the row that moved up into the gap')
ok(shiftRefsForInsert('=SUM(A3:A10)', 'row', 2, -3) === '=SUM(A3:A7)',
  'and a range whose TOP fell in starts at the first surviving row')
ok(shiftRefsForInsert('=SUM(A1:A10)', 'row', 5, 2) === '=SUM(A1:A12)',
  'inserting inside a range EXTENDS it')
ok(shiftRefsForInsert('=SUM(A1:A10)', 'row', 10, 1) === '=SUM(A1:A10)',
  'inserting directly below a range does not extend it — the classic append trap')

// ----------------------------------------- shiftRefsForInsert (columns)
ok(shiftRefsForInsert('=B7', 'col', 0, 1) === '=C7', 'inserting a column moves the letter')
ok(shiftRefsForInsert('=B7', 'col', 0, 1) !== '=B8', 'and does NOT touch the row')
ok(shiftRefsForInsert('=B1', 'col', 1, -1) === '=#REF!', 'deleting column B kills a ref into it')
ok(shiftRefsForInsert('=C1', 'col', 1, -1) === '=B1', 'and C slides into B')
ok(shiftRefsForInsert('=Z1', 'col', 0, 1) === '=AA1',
  'a column insert that crosses the Z/AA carry')
ok(shiftRefsForInsert('=$B$7', 'col', 0, 1) === '=$C$7', '$ moves under a column insert too')
ok(shiftRefsForInsert('=SUM(B1:D1)', 'col', 2, -1) === '=SUM(B1:C1)',
  'a horizontal range shrinks the same way')

// what must survive a structural edit untouched
ok(shiftRefsForInsert('=IF(A5="A5","x","y")', 'row', 4, -1) === '=IF(#REF!="A5","x","y")',
  'the reference dies, the identical text in quotes does not')
ok(shiftRefsForInsert('=LOG10(A5)', 'row', 4, -1) === '=LOG10(#REF!)',
  'and a cell-shaped function name is not a casualty')
ok(shiftRefsForInsert('=Price*Qty', 'row', 0, 1) === '=Price*Qty',
  'a column formula is immune to structural edits — which is the whole point of dash')
ok(shiftRefsForInsert('=#REF!+A9', 'row', 0, 1) === '=#REF!+A10',
  'an already-dead reference stays dead while the live one moves')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
