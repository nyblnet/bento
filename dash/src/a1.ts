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
//   • a name followed by `[` — `Table1[Col]` qualifies something, and `Table1`
//     is itself cell-shaped;
//   • anything over 3 letters or 7 digits. That is Excel's bound (XFD1048576),
//     and here it is also what keeps `REVENUE2024` a column name instead of a
//     cell address. `REV2024` is genuinely ambiguous and resolves as a CELL, as
//     it does in every spreadsheet on earth — write `[REV2024]` to mean the
//     column.
//
// A NAME BEFORE `!` IS A SHEET, AND THE REFERENCE AFTER IT IS ONE UNIT. This
// file used to skip the name and then scan `A1` on its own, which meant
// `Sheet1!A1` bound to the LOCAL A1: the qualifier was dropped and the formula
// read a different sheet's cell than the one it named. That is the exact
// failure this file exists to prevent, so a qualified reference is now scanned
// whole and carries its sheet on the `Unit`. `'Q3 pipeline'!A1` is the quoted
// form, for names that are not bare words; `''` inside the quotes is one quote.
//
// A DEFINED NAME IS THE THIRD KIND OF NAME, and the scanner now offers it up
// rather than skipping it. `Sheet1!A1` is a sheet qualifier, `Table1[Col]` is a
// structured reference, and a bare word that is neither — not cell-shaped, not
// a call, not a qualifier — is what `TaxRate` looks like. `mapNames` walks with
// the SAME rules the reference rewrites use, because a second walk would be a
// second definition of what a word is, and the two would disagree about a
// quoted string on some Tuesday. This file does not know what a name MEANS;
// cellformula.ts owns the table and the substitution.
//
// AN ERROR LITERAL IS COPIED VERBATIM. `#REF!`, `#DIV/0!`, `#N/A` — the `REF`
// in `#REF!` is a word followed by `!` and would otherwise read as a sheet
// qualifier now that qualifiers are scanned.

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

// --- Sheet qualifiers -------------------------------------------------------

/** A bare sheet name: a word, and not itself a cell address. */
const BARE_SHEET = /^[A-Za-z_][A-Za-z0-9_.]*$/

/**
 * A sheet name as a reference must write it.
 *
 * Quoted when it is not a bare word — and ALSO when it is cell-shaped, so a
 * sheet somebody called `A1` reads as `'A1'!B2` and can never be mistaken for
 * an address by the scanner that has to read it back.
 */
export function quoteSheet(name: string): string {
  if (BARE_SHEET.test(name) && !parseRef(name)) return name
  return `'${name.replace(/'/g, "''")}'`
}

/** `Sheet1!A1`, `'Q3 pipeline'!A1:B10`, or just `A1` when there is no sheet. */
export const qualify = (sheet: string | undefined, ref: string): string =>
  sheet === undefined ? ref : `${quoteSheet(sheet)}!${ref}`

/** The inverse of `quoteSheet`, for the quoted form only. */
const unquoteSheet = (text: string): string =>
  text.startsWith("'") ? text.slice(1, -1).replace(/''/g, "'") : text

/**
 * Do two sheet names mean the same sheet? Case-insensitively, as Excel has it —
 * `SUM(sheet1!A1)` typed in a hurry names `Sheet1`.
 */
export const sameSheet = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? '').toLowerCase() === (b ?? '').toLowerCase()

/** Error literals — `#REF!`, `#DIV/0!`, `#N/A`. Never references, never touched. */
const ERR_LITERAL = /^#[A-Za-z]+(?:\/[A-Za-z0-9]+)?[!?]?/

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

interface Unit {
  from: CellRef
  to?: CellRef
  /** The sheet named before `!`, unquoted. Absent = this formula's own sheet. */
  sheet?: string
}
type MapUnit = (u: Unit) => string
/** A bare word that is not a reference, not a call and not a qualifier. */
type MapName = (name: string) => string

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

/**
 * Walk `src` and hand every DEFINED-NAME candidate to `map`, splicing its
 * return in place. References, calls, sheet qualifiers, quoted text, bracketed
 * names and error literals are all left exactly as written.
 *
 * A word is offered only when nothing else claims it: `SUM` is followed by `(`,
 * `Sheet1` by `!`, `Table1` by `[`, `B4` is cell-shaped, and the word AFTER a
 * `!` belongs to the qualifier that could not be resolved — none of those are
 * a defined name, and substituting into one corrupts the formula.
 *
 * `map` returning the word unchanged is how "there is no name by that spelling"
 * is said; formula.ts then reports `#NAME?`, which is the honest answer and the
 * one it already gives.
 */
export function mapNames(src: string, map: MapName): string {
  return rewrite(src, null, map)
}

/** A sheet a source named, and the text that followed the `!`. */
export interface SheetQualifier {
  sheet: string
  /** `A1` for `Jan!A1`, `Amount` for `Jan!Amount` — an address, or not one. */
  after: string
}

/**
 * Every sheet a source QUALIFIES, in the order it names them, without
 * duplicates.
 *
 * The point is to be able to answer "this expression reaches another sheet"
 * WITHOUT being the thing that resolves it. formula.ts's column language is
 * defined over the columns of one sheet and has no concept of a workbook, so
 * `Jan!A1` reaches its lexer as the bare word `Jan` and comes back
 * `#NAME? unknown name "Jan"` — which is false twice over: the name is not
 * unknown, it is a sheet, and the reason it cannot be used is a boundary rather
 * than a typo. This is how the column path learns enough to say so.
 *
 * IT IS THE SAME SCANNER, deliberately. A second pass over the source looking
 * for `!` would be a second definition of what a qualifier is, and the two
 * would disagree the first time somebody wrote `="not a sheet!" & A1` — where
 * the `!` is inside a string literal this walk already skips.
 *
 * Both qualifier shapes are reported: `Jan!A1`, where a reference follows, and
 * `Jan!Amount`, where a COLUMN NAME follows. The second is the spelling a
 * dataset author reaches for and the one a naive `!`-hunt would find while a
 * reference-only walk would miss.
 */
export function sheetQualifiers(src: string): SheetQualifier[] {
  // Free when there is no `!` at all, which is almost every expression ever
  // evaluated — this runs in the recalculation hot path.
  if (src.indexOf('!') < 0) return []
  const seen = new Set<string>()
  const out: SheetQualifier[] = []
  rewrite(src, null, undefined, (sheet, after) => {
    const k = sheet.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    out.push({ sheet, after })
  })
  return out
}

/**
 * Is this a spelling a defined name may have?
 *
 * The fence is the same one the header draws around `REVENUE2024`: a name that
 * is CELL-SHAPED is refused, because the scanner resolves `TAX1` as a cell
 * before it ever reaches the name table, so a name spelled that way would be
 * silently unreachable — a definition that exists and never applies is worse
 * than a refusal. The body is formula.ts's identifier, so a name that parses
 * here also lexes there.
 */
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/
export const isNameLike = (s: string): boolean =>
  NAME_RE.test(s) && parseRef(s) === null

/**
 * `map` may be `null`: a walk that is only substituting NAMES must return every
 * reference as the author wrote it, spacing and lower case included. Running
 * them through a mapper that formats a parsed `CellRef` would silently
 * canonicalise `a1 : b2` into `A1:B2` — correct, unasked for, and a diff in
 * every formula a name touches.
 */
function rewrite(
  src: string,
  map: MapUnit | null,
  mapName?: MapName,
  onQualifier?: (sheet: string, after: string) => void,
): string {
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

  /**
   * A reference or a range starting at `j`, and where it ends — or `null` if
   * what is there is not one. The lookahead guards are the same three as
   * below: a name followed by `(`, `!` or `[` qualifies something else.
   */
  const refAt = (j: number): { unit: Unit; end: number } | null => {
    const e = word(j)
    const from = parseRef(src.slice(j, e))
    if (!from) return null
    const k = skipSpace(e)
    if (src[k] === '(' || src[k] === '!' || src[k] === '[') return null
    // A range is ONE unit: deleting the rows under `A3:A5` has to collapse the
    // whole thing to `#REF!`, which an endpoint on its own cannot know.
    if (src[k] === ':') {
      const m = skipSpace(k + 1)
      const e2 = word(m)
      const to = parseRef(src.slice(m, e2))
      const after = skipSpace(e2)
      if (to && src[after] !== '(' && src[after] !== '!' && src[after] !== '[') {
        return { unit: { from, to }, end: e2 }
      }
    }
    return { unit: { from }, end: e }
  }

  /** `'Q3 pipeline'` at `j` — the index after the closing quote, or -1. */
  const quoted = (j: number): number => {
    let p = j + 1
    while (p < n) {
      if (src[p] === "'") {
        if (src[p + 1] === "'") { p += 2; continue }
        return p + 1
      }
      p++
    }
    return -1
  }

  /** `<name>!<ref>` starting at the qualifier's end `q`, or null. */
  const qualified = (name: string, at: number, q: number): { text: string; end: number } | null => {
    const k = skipSpace(q)
    if (src[k] !== '!') return null
    const r = refAt(skipSpace(k + 1))
    if (!r) return null
    return { text: map ? map({ ...r.unit, sheet: name }) : src.slice(at, r.end), end: r.end }
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

    // `'Q3 pipeline'!A1` — the quoted sheet form. A stray quote that does not
    // qualify a reference is copied like any other character.
    if (c === "'") {
      const q = quoted(i)
      const name = q > 0 ? unquoteSheet(src.slice(i, q)) : ''
      if (q > 0 && src[skipSpace(q)] === '!') {
        onQualifier?.(name, src.slice(skipSpace(skipSpace(q) + 1), word(skipSpace(skipSpace(q) + 1))))
      }
      const hit = q > 0 ? qualified(name, i, q) : null
      if (hit) { out += hit.text; i = hit.end; continue }
      out += c
      i++
      continue
    }

    // `#REF!`, `#DIV/0!`, `#N/A` — an error a previous edit left behind. Copied
    // verbatim, and consumed HERE so the `REF` of `#REF!` cannot be read as a
    // sheet qualifier by the branch below.
    if (c === '#') {
      const m = ERR_LITERAL.exec(src.slice(i))
      if (m) { out += m[0]; i += m[0].length; continue }
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
      // `!` = a sheet qualifier. The name AND the reference after it are one
      // unit — dropping the name here is what made `Sheet1!A1` read the local
      // A1. When what follows is not a reference, the name is left alone.
      if (src[k] === '!') {
        // WHOEVER IS WATCHING hears about the qualifier here, in BOTH of the
        // branches below, because both are a formula naming another sheet:
        // `Jan!A1` is one dash cannot mistake, and `Jan!Amount` — a sheet and a
        // COLUMN, which is what a dataset author reaches for — is one it would
        // otherwise pass on to formula.ts as the bare word `Jan`. See
        // `sheetQualifiers`.
        const hit = qualified(text, i, j)
        if (hit) {
          onQualifier?.(text, src.slice(skipSpace(k + 1), hit.end))
          out += hit.text; i = hit.end; continue
        }
        // Not a reference after the `!`, so the whole thing is somebody else's
        // syntax. The WORD AFTER IT is consumed here too, verbatim: leaving it
        // to the loop would offer `Sheet1!Total` up as the defined name
        // `Total`, and substituting a range into it would fabricate
        // `Sheet1!A1:A5` — a reference to a sheet the author never named.
        const after = skipSpace(k + 1)
        const w = word(after)
        // A word DID follow, so this is `Jan!Amount` — a sheet and a column
        // name — and not `a ! b`, which is not this language's syntax at all
        // and must not be reported as somebody reaching for another sheet.
        if (w > after) onQualifier?.(text, src.slice(after, w))
        out += src.slice(i, w)
        i = w
        continue
      }
      // `(` = a call, `[` = a structured reference. Both are followed by a
      // name that is frequently cell-shaped (LOG10, Table1); translating one
      // corrupts the formula.
      if (src[k] === '(' || src[k] === '[') {
        out += text
        i = j
        continue
      }
      const r = refAt(i)
      if (!r) { out += mapName ? mapName(text) : text; i = j; continue }
      out += map ? map(r.unit) : src.slice(i, r.end)
      i = r.end
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
 *
 * A QUALIFIED reference moves like any other: copying `=Sheet1!A1` down a row
 * gives `=Sheet1!A2`, because the formula moved and its reference is relative.
 * The sheet is not what `$` pins — the row is.
 */
export function rewriteFormulaRefs(src: string, dRow: number, dCol: number): string {
  return rewrite(src, (u) => {
    const a = shifted(u.from, dRow, dCol)
    if (!u.to) return a === REF_ERR ? REF_ERR : qualify(u.sheet, a)
    const b = shifted(u.to, dRow, dCol)
    return a === REF_ERR || b === REF_ERR ? REF_ERR : qualify(u.sheet, `${a}:${b}`)
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
 *
 * A REFERENCE TO ANOTHER SHEET DOES NOT MOVE. `scope` says which sheet the edit
 * happened on (`on`) and which sheet the formula lives on (`self`); a reference
 * moves only when those name the same sheet as the reference does. With no
 * scope the edit is taken to be on the formula's own sheet, which is what every
 * caller meant before sheets could be named at all — so an unqualified
 * reference moves and `Other!A5` stays exactly where it points. Moving it would
 * repoint someone else's data at a hole in this sheet, which is the failure
 * this whole file exists to prevent.
 */
export interface ShiftScope {
  /** the sheet the rows or columns were inserted into or removed from */
  on?: string
  /** the sheet whose formula is being rewritten — what an unqualified ref means */
  self?: string
}

export function shiftRefsForInsert(
  src: string,
  axis: 'row' | 'col',
  at: number,
  count: number,
  scope: ShiftScope = {},
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

  // Whose sheet each side names. `undefined` on both is the ordinary case: one
  // sheet, one edit, no qualifiers anywhere.
  const edited = scope.on ?? scope.self

  return rewrite(src, (u) => {
    if (!sameSheet(u.sheet ?? scope.self, edited)) {
      // Another sheet's cells did not move, so neither does this reference.
      return qualify(u.sheet, u.to ? `${formatRef(u.from)}:${formatRef(u.to)}` : formatRef(u.from))
    }
    const a = moved(val(u.from))
    if (!u.to) return a === null ? REF_ERR : qualify(u.sheet, formatRef(put(u.from, a)))
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
    return qualify(u.sheet, `${formatRef(put(u.from, fa))}:${formatRef(put(u.to, fb))}`)
  })
}
