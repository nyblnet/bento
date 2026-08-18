// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A1 addressing — cell references, ranges, and the only place `#REF!` is minted.
//
// dash's COLUMN formulas do not have the `#REF!` problem. A column expression
// names a column by IDENTITY (model.ts `Column.id`), so inserting a row changes
// nothing, deleting a row changes nothing, and dragging a column changes
// nothing. That is the structural win formula.ts's header claims, and it is
// real.
//
// A1 references give it back, and they have to. An invoice, a scratch pad, a
// totals block — the `CanvasSheet` cases — are POSITIONAL by nature, and a
// person typing `=B4*1.2` is not going to be talked out of it. So the two
// coexist, and the entire cost of admitting them is concentrated in this file:
// an A1 reference is a POSITION, positions move, and every structural edit has
// to move them EXACTLY. Close is the dangerous answer, not the safe one — a
// reference left pointing at whatever slid into the deleted row is a wrong
// number wearing a right number's clothes, the same sin as an error that
// becomes a zero.
//
// EVERYTHING HERE IS 0-BASED, columns AND rows: `A1` parses to {col:0, row:0}.
// The `1` in `A1` is display exactly as the `A` is. The grid, the store's row
// indices and `readCell` are all 0-based, so a 1-based row here would put a ±1
// at every call site and one of them would eventually be wrong. `formatRef` is
// the only place the +1 lives.
//
// `$` PINS AGAINST FILL, NOT AGAINST STRUCTURE — the rule that gets
// re-litigated every time someone reads it. `translateRef` (fill-down,
// copy-paste) leaves `$A$1` alone; `shiftRefsForInsert` (a row or column was
// inserted or deleted) MOVES it, because the cell it names physically moved.
// Insert a row above `$A$5` in Excel and you get `$A$6`. A "$ never moves"
// implementation is wrong in the direction that quietly re-points references at
// other people's data.
//
// WHAT IS NOT A REFERENCE, when rewriting an expression:
//   • text inside "quotes" — `="A1 is "&A1` shifted one row is `="A1 is "&A2`;
//   • a [bracketed name] — formula.ts's escape for a column whose name has
//     spaces, and the escape hatch for a column named like a cell;
//   • a name followed by `(` — `LOG10(x)` is a call, and `LOG10` is otherwise
//     a perfectly good cell address;
//   • a name followed by `!` or `[` — `Sheet1!A1` and `Table1[Col]` qualify
//     something, and `Sheet1`/`Table1` are both cell-shaped;
//   • anything over 3 letters or 7 digits. That is Excel's bound (XFD1048576),
//     and here it is also what keeps `REVENUE2024` a column name instead of a
//     cell address. `REV2024` is genuinely ambiguous and resolves as a CELL, as
//     it does in every spreadsheet on earth — write `[REV2024]` to mean the
//     column.

/** The one error this file can produce. Visible, never a silent fallback. */
export const REF_ERR = '#REF!'

/**
 * Cells `expandRange` will materialise before refusing.
 *
 * Excel's sheet is 1,048,576 rows, so `A1:A1048576` is a thing a person can
 * type — and expanding it as objects is a ~200 MB allocation and a dead tab.
 * Refusing with `null` is answerable; a hang is not.
 */
export const RANGE_CELL_MAX = 1_000_000

/** Excel's bound (XFD = 16383), and the fence that keeps `REVENUE2024` a name. */
const MAX_LETTERS = 3
const MAX_DIGITS = 7

export interface CellRef {
  /** 0-based. A = 0. */
  col: number
  /** 0-based. The `1` of `A1` is display. */
  row: number
  absCol: boolean
  absRow: boolean
}

export interface RangeRef { from: CellRef; to: CellRef }

// --- Column letters ---------------------------------------------------------
// BIJECTIVE base-26, which is the part everyone gets wrong. There is no zero
// digit: after Z comes AA, not BA. Plain base-26 (A=0) makes 26 into "BA" and
// gives two spellings for every column, so the round trip stops holding at the
// 27th column — where nobody looks.

/** 0→A, 25→Z, 26→AA, 701→ZZ, 702→AAA. `''` for a non-address. */
export function colToLetters(i: number): string {
  if (!Number.isInteger(i) || i < 0) return ''
  let s = ''
  let n = i
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  }
  return s
}

/** The inverse, case-insensitive. `-1` for anything that is not letters. */
export function lettersToCol(s: string): number {
  if (!s) return -1
  let n = 0
  for (let i = 0; i < s.length; i++) {
    // | 32 lowercases a letter and moves everything else out of range, so the
    // rejection is the same branch as the fold.
    const c = s.charCodeAt(i) | 32
    if (c < 97 || c > 122) return -1
    n = n * 26 + (c - 96)
  }
  return n - 1
}

// --- References -------------------------------------------------------------

const REF_RE = new RegExp(`^(\\$?)([A-Za-z]{1,${MAX_LETTERS}})(\\$?)([0-9]{1,${MAX_DIGITS}})$`)

/** `A1`, `$A$1`, `A$1`, `$A1`, any case. `null` if it is not an address. */
export function parseRef(s: string): CellRef | null {
  const m = REF_RE.exec(s.trim())
  if (!m) return null
  const col = lettersToCol(m[2])
  // `A0` is not a cell: rows are 1-based on the page, so 0 is a typo, and
  // parsing it to row -1 would let it format straight back out as `A0`.
  const row = Number(m[4]) - 1
  if (col < 0 || row < 0) return null
  return { col, row, absCol: m[1] === '$', absRow: m[3] === '$' }
}

/**
 * The inverse. Canonical: letters uppercase, `$` where the ref says.
 *
 * An address that cannot exist formats as `#REF!` rather than as `A0` or `''`.
 * This is deliberately the ONLY place the error is minted — every shift below
 * builds a CellRef and hands it here, so no caller can forget the check and
 * emit a plausible address for a cell that fell off the sheet.
 */
export function formatRef(r: CellRef): string {
  const letters = colToLetters(r.col)
  if (!letters || !Number.isInteger(r.row) || r.row < 0) return REF_ERR
  return `${r.absCol ? '$' : ''}${letters}${r.absRow ? '$' : ''}${r.row + 1}`
}

// --- Ranges -----------------------------------------------------------------

/** `A1:B10`. `null` unless BOTH ends are addresses. */
export function parseRange(s: string): RangeRef | null {
  const i = s.indexOf(':')
  if (i < 0) return null
  const from = parseRef(s.slice(0, i))
  const to = parseRef(s.slice(i + 1))
  return from && to ? { from, to } : null
}

export const formatRange = (r: RangeRef): string => `${formatRef(r.from)}:${formatRef(r.to)}`

/**
 * Every cell in the rectangle, in reading order (row-major), or `null` past
 * RANGE_CELL_MAX.
 *
 * The corners are normalised, so `B10:A1` expands the same rectangle as
 * `A1:B10` — a range is an area, and the order it was typed in is not data.
 * The count is computed before anything is allocated; that is the whole point
 * of the cap.
 *
 * Expanded cells carry `absCol/absRow: false`. They are ADDRESSES, and `$` is a
 * property of how a reference was WRITTEN, not of the cell it lands on.
 */
export function expandRange(r: RangeRef): CellRef[] | null {
  const c0 = Math.min(r.from.col, r.to.col)
  const c1 = Math.max(r.from.col, r.to.col)
  const r0 = Math.min(r.from.row, r.to.row)
  const r1 = Math.max(r.from.row, r.to.row)
  if (c0 < 0 || r0 < 0) return null
  if ((c1 - c0 + 1) * (r1 - r0 + 1) > RANGE_CELL_MAX) return null
  const out: CellRef[] = []
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) out.push({ col, row, absCol: false, absRow: false })
  }
  return out
}

// --- Translation (fill, copy/paste) -----------------------------------------

const shifted = (r: CellRef, dRow: number, dCol: number): string => formatRef({
  col: r.absCol ? r.col : r.col + dCol,
  row: r.absRow ? r.row : r.row + dRow,
  absCol: r.absCol,
  absRow: r.absRow,
})

/**
 * Move a reference by a fill/paste offset: relative parts shift, `$` parts do
 * not. This is what dragging a formula down a column does.
 *
 * Off the top or left edge is `#REF!` — filling `=A1` upward has no answer, and
 * clamping it to `A1` would silently make every row of the fill read the same
 * cell.
 *
 * A string that is not an address comes back UNCHANGED: callers hand this whole
 * tokens, and mangling `SUM` would be worse than ignoring it.
 */
export function translateRef(ref: string, dRow: number, dCol: number): string {
  const r = parseRef(ref)
  return r ? shifted(r, dRow, dCol) : ref
}

// --- The expression scanner -------------------------------------------------
// One walk over the source, used by both rewrites below. It is a SCANNER and
// not the parser from formula.ts on purpose: rewriting must return the author's
// text with only the references changed — comments, spacing and any syntax this
// build does not understand have to survive, and a parse→print round trip would
// quietly normalise all of it away.

interface Unit { from: CellRef; to?: CellRef }
type MapUnit = (u: Unit) => string

const isAlpha = (c: string): boolean => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
const isDigit = (c: string): boolean => c >= '0' && c <= '9'
/** The identifier body formula.ts's lexer accepts, so words break identically. */
const isWord = (c: string): boolean => isAlpha(c) || isDigit(c) || c === '_' || c === '.'

/**
 * Walk `src` and hand every reference to `map`, splicing its return in place.
 *
 * Exported because cellformula.ts substitutes references for bound names using
 * the SAME walk the shifting rewrites use. A second scanner would be a second
 * definition of what counts as a reference, and the two would disagree about a
 * quoted string or a `[bracketed name]` on some Tuesday.
 */
export function mapRefs(src: string, map: MapUnit): string { return rewrite(src, map) }
export type { Unit as RefUnit }

function rewrite(src: string, map: MapUnit): string {
  const n = src.length
  const skipSpace = (j: number): number => {
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++
    return j
  }
  /** A maximal word, `$` included so `$A$1` is one token. */
  const word = (j: number): number => {
    while (j < n && (isWord(src[j]) || src[j] === '$')) j++
    return j
  }

  let out = ''
  let i = 0
  while (i < n) {
    const c = src[i]

    // A string literal is copied byte for byte. `="A1 is "&A1` shifted a row is
    // `="A1 is "&A2`: the text is a label a human wrote, not an address.
    if (c === '"') {
      let j = i + 1
      while (j < n) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { j += 2; continue } // "" is an escaped quote
          j++
          break
        }
        j++
      }
      out += src.slice(i, j)
      i = j
      continue
    }

    // [Bracketed name] — formula.ts's column escape, and the way to say "the
    // column called REV2024, not the cell".
    if (c === '[') {
      const close = src.indexOf(']', i)
      const end = close < 0 ? n : close + 1
      out += src.slice(i, end)
      i = end
      continue
    }

    // A number, and anything glued to it. Keeps `2024A1` from contributing a
    // reference nobody wrote.
    if (isDigit(c)) {
      let j = i
      while (j < n && isWord(src[j])) j++
      out += src.slice(i, j)
      i = j
      continue
    }

    if (isAlpha(c) || c === '$' || c === '_') {
      const j = word(i)
      const text = src.slice(i, j)
      const k = skipSpace(j)
      // `(` = a call, `!` = a sheet qualifier, `[` = a structured reference.
      // All three are followed by a name that is frequently cell-shaped
      // (LOG10, Sheet1, Table1); translating one corrupts the formula.
      if (src[k] === '(' || src[k] === '!' || src[k] === '[') {
        out += text
        i = j
        continue
      }
      const from = parseRef(text)
      if (!from) { out += text; i = j; continue }

      // A range is mapped as ONE unit: deleting the rows under `A3:A5` has to
      // collapse the whole thing to `#REF!`, which an endpoint on its own
      // cannot know.
      if (src[k] === ':') {
        const m = skipSpace(k + 1)
        const e = word(m)
        const to = parseRef(src.slice(m, e))
        const after = skipSpace(e)
        if (to && src[after] !== '(' && src[after] !== '!' && src[after] !== '[') {
          out += map({ from, to })
          i = e
          continue
        }
      }
      out += map({ from })
      i = j
      continue
    }

    out += c
    i++
  }
  return out
}

/**
 * Translate every reference in an expression — what fill-down of a cell formula
 * does. Quoted text, bracketed names, function names and sheet qualifiers are
 * left exactly as written.
 *
 * A range with an off-sheet corner becomes `#REF!` whole. `#REF!:B1` is not a
 * smaller range, it is not a range.
 */
export function rewriteFormulaRefs(src: string, dRow: number, dCol: number): string {
  return rewrite(src, (u) => {
    const a = shifted(u.from, dRow, dCol)
    if (!u.to) return a
    const b = shifted(u.to, dRow, dCol)
    return a === REF_ERR || b === REF_ERR ? REF_ERR : `${a}:${b}`
  })
}

/**
 * Move every reference for a structural edit: `count` rows/columns inserted at
 * 0-based index `at`, or REMOVED if `count` is negative.
 *
 * `$` DOES NOT PROTECT A REFERENCE HERE. The cell moved; `$` only ever meant
 * "do not renumber me when I am copied". Excel agrees, and a reader who expects
 * otherwise is expecting their totals to point one row short.
 *
 * A reference INTO a deleted row becomes `#REF!` — never the row that slid into
 * that position, which is the failure this whole file exists to prevent.
 *
 * A RANGE spanning the hole SHRINKS instead: deleting three rows out of the
 * middle of `A1:A10` gives `A1:A7`, because the range still means "the numbers
 * under this heading" and the surviving ones are still there. It becomes
 * `#REF!` only when both ends are gone.
 */
export function shiftRefsForInsert(
  src: string,
  axis: 'row' | 'col',
  at: number,
  count: number,
): string {
  const val = (r: CellRef): number => (axis === 'row' ? r.row : r.col)
  const put = (r: CellRef, v: number): CellRef =>
    (axis === 'row' ? { ...r, row: v } : { ...r, col: v })
  const gone = count < 0 ? -count : 0

  /** New index, or `null` if this line was one of the deleted ones. */
  const moved = (v: number): number | null => {
    if (!gone) return v >= at ? v + count : v
    if (v < at) return v
    if (v < at + gone) return null
    return v - gone
  }

  return rewrite(src, (u) => {
    const a = moved(val(u.from))
    if (!u.to) return a === null ? REF_ERR : formatRef(put(u.from, a))
    const b = moved(val(u.to))
    if (a === null && b === null) return REF_ERR
    // One end survived, so the range clamps to the surviving side of the hole:
    // the low end to the first line after it (`at`), the high end to the last
    // line before it (`at - 1`). Clamping both to `at` would extend the range
    // over whatever moved up into the gap.
    const lowFirst = val(u.from) <= val(u.to)
    const fa = a ?? (lowFirst ? at : at - 1)
    const fb = b ?? (lowFirst ? at - 1 : at)
    if (fa < 0 || fb < 0) return REF_ERR
    return `${formatRef(put(u.from, fa))}:${formatRef(put(u.to, fb))}`
  })
}
