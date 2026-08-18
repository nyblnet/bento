// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Selection, keyboard motion, the clipboard's TSV, and the fill handle.
//
// A SELECTION IS DATA. Nothing here touches the DOM: the grid renders what this
// says, and this never reads what the grid drew. That is what makes every rule
// below provable in node — which matters more here than anywhere else in the
// app, because these are the behaviours nobody writes down and everybody
// notices the instant they are wrong.
//
// COORDINATES ARE VISIBLE POSITIONS, not row ids. The grid reads through an
// order vector (grid.ts: sorting sorts the vector, not the data), so row 3 of a
// sorted view is not rid 3. A selection that stored rids would silently
// re-target the moment somebody clicked a column header — the cells stay
// selected, the highlight jumps. The grid maps position → rid at the edge;
// everything in here is (row, col) into what the reader can see.
//
// THE CURSOR IS NOT THE HEAD, and conflating them is what breaks Tab inside a
// selected block. A range has an anchor and a head — the end shift+arrow moves
// — and, SEPARATELY, one active cell where typing lands. Tab inside a block
// walks the active cell while the block stays perfectly still; if Tab moved the
// head, the selection would grow by one cell per keystroke.
//
// THE TAB RUN is the piece implementations miss. Tab across a row, press Enter,
// and you must land under the cell the run STARTED in — not under the last one
// you typed. Without it, entering a table row by row walks diagonally down and
// to the right, and the grid feels broken in a way people cannot name.
//
// A JUMP IS BOUNDED. ⌘↓ runs to the far end of the data BLOCK, and where there
// is no more data it stops at the last row of the sheet. This grid HAS a last
// row — that is the point of a columnar sheet over an infinite canvas — so
// there is no Excel row 1,048,576 to fall into and no way back from.
//
// TSV IS NOT CSV, and this is deliberately not import.ts's parser. Clipboard
// text is the one format every spreadsheet on earth speaks and it has to
// round-trip EXACTLY. import.ts sniffs a delimiter (wrong here: the delimiter
// is a tab, always, and a column of "a,b" values must not become two columns)
// and drops a trailing empty row (right for a file, wrong here: a copied blank
// cell must paste as a blank and CLEAR what it lands on, and a paste that
// quietly does nothing is an edit the user believes landed).

// --- Ranges ----------------------------------------------------------------

export interface CellRef { row: number; col: number }

/**
 * `anchor` is where the drag began and `head` is where it is now; either may be
 * the smaller. Storing them un-normalised is what lets shift+arrow shrink a
 * selection back through its anchor instead of flipping it inside out.
 *
 * NOTE this shadows the DOM's `Range` inside any module that imports it. That
 * is the name the whole spreadsheet world uses and renaming it to `CellRange`
 * would be a worse trade than the shadow.
 */
export interface Range { anchor: CellRef; head: CellRef }

export interface Box { top: number; left: number; bottom: number; right: number }

export const normalize = (r: Range): Box => ({
  top: Math.min(r.anchor.row, r.head.row),
  left: Math.min(r.anchor.col, r.head.col),
  bottom: Math.max(r.anchor.row, r.head.row),
  right: Math.max(r.anchor.col, r.head.col),
})

export function contains(r: Range, row: number, col: number): boolean {
  const b = normalize(r)
  return row >= b.top && row <= b.bottom && col >= b.left && col <= b.right
}

export function size(r: Range): { rows: number; cols: number } {
  const b = normalize(r)
  return { rows: b.bottom - b.top + 1, cols: b.right - b.left + 1 }
}

/** A range from a box, for callers that think in corners (row/col headers). */
export const rangeOf = (top: number, left: number, bottom: number, right: number): Range =>
  ({ anchor: { row: top, col: left }, head: { row: bottom, col: right } })

// --- Keys ------------------------------------------------------------------

/**
 * What a key MEANS, decided once and away from the DOM.
 *
 * Split from what a key DOES so the mapping is testable without a grid and so
 * the clipboard and history verbs — which are not selection operations at all —
 * come out of the same switch instead of a second one that drifts from it.
 */
export type Action =
  /** `unit` is the distance: one cell, one screen, or to the edge of the data
   *  block. `dr`/`dc` stay ±1 and the caller multiplies, because only the grid
   *  knows how many rows a page is. */
  | { kind: 'move'; dr: number; dc: number; unit: 'cell' | 'page' | 'edge'; extend: boolean }
  | { kind: 'tab'; back: boolean }
  | { kind: 'enter'; back: boolean }
  /** `whole` is the ⌘ variant: ⌘Home is the first cell of the sheet, not of the row. */
  | { kind: 'home'; whole: boolean; extend: boolean }
  | { kind: 'end'; whole: boolean; extend: boolean }
  | { kind: 'selectAll' }
  | { kind: 'selectRow' }
  | { kind: 'selectCol' }
  | { kind: 'clear' }
  | { kind: 'edit' }
  | { kind: 'cancel' }
  | { kind: 'copy' }
  | { kind: 'cut' }
  | { kind: 'paste' }
  | { kind: 'undo' }
  | { kind: 'redo' }

/** Structurally a KeyboardEvent, so a real event passes straight in. */
export interface KeyLike {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}

const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
}

/**
 * The real spreadsheet key set, or null for a key this model does not own.
 *
 * NULL IS THE IMPORTANT RETURN. A grid that claims every keystroke swallows the
 * ones that should start an edit (typing a digit), and one that claims a
 * modified key it does not implement turns a shortcut into a cursor move.
 */
export function keyToAction(e: KeyLike): Action | null {
  const shift = e.shiftKey === true
  // ⌘ on a Mac, ctrl everywhere else. Treating them as one is right for every
  // binding here — there is no combination where they must differ.
  const cmd = e.metaKey === true || e.ctrlKey === true

  // A modifier we do not own is NOT the unmodified key. Alt+↓ opens the filter
  // menu in every spreadsheet on earth; reading it as "move down" is how a
  // shortcut silently becomes a cursor move.
  if (e.altKey === true) return null

  const arrow = ARROWS[e.key]
  if (arrow) {
    return { kind: 'move', dr: arrow[0], dc: arrow[1], unit: cmd ? 'edge' : 'cell', extend: shift }
  }

  switch (e.key) {
    case 'Tab': return { kind: 'tab', back: shift }
    case 'Enter': return { kind: 'enter', back: shift }
    case 'Home': return { kind: 'home', whole: cmd, extend: shift }
    case 'End': return { kind: 'end', whole: cmd, extend: shift }
    case 'PageUp': return { kind: 'move', dr: -1, dc: 0, unit: 'page', extend: shift }
    case 'PageDown': return { kind: 'move', dr: 1, dc: 0, unit: 'page', extend: shift }
    case 'Escape': return { kind: 'cancel' }
    // Mac keyboards send Backspace where a PC sends Delete, and both mean
    // "empty these cells" in a grid.
    case 'Delete': case 'Backspace': return { kind: 'clear' }
    case 'F2': return { kind: 'edit' }
    // A bare space types a space; only the modified forms select.
    case ' ': return shift ? { kind: 'selectRow' } : cmd ? { kind: 'selectCol' } : null
  }

  if (!cmd) return null
  // Shift changes the KEY, not just the flag: ⌘⇧Z arrives as 'Z'. Comparing
  // against 'z' without folding case is why redo stops working on the one
  // shortcut users reach for after an undo they did not mean.
  switch (e.key.toLowerCase()) {
    case 'a': return { kind: 'selectAll' }
    case 'c': return { kind: 'copy' }
    case 'x': return { kind: 'cut' }
    case 'v': return { kind: 'paste' }
    case 'z': return shift ? { kind: 'redo' } : { kind: 'undo' }
    case 'y': return { kind: 'redo' }
  }
  return null
}

// --- Selection -------------------------------------------------------------

export interface MoveOpts {
  /** shift held: move the head and leave the anchor and the cursor where they are */
  extend?: boolean
  /** ⌘/ctrl held: run to the edge of the data block rather than one cell */
  jump?: boolean
  /**
   * What counts as data, for a jump. Absent, a jump runs to the grid boundary —
   * the honest degenerate, and a bounded one, because this sheet has a last row.
   */
  filled?: (row: number, col: number) => boolean
}

export class Selection {
  rows: number
  cols: number
  /** the live range: the one shift+arrow extends and ⌘-click replaces */
  active: Range
  /** earlier ⌘-clicked ranges, oldest first. The active range is not in here. */
  extra: Range[]
  /** the one cell typing lands in — inside the active range, never the head */
  cursor: CellRef

  /**
   * Where the current Tab run began, or null when there is no run.
   *
   * This is the whole of Enter's "return home" behaviour and it is one field.
   * Any navigation that is not a Tab or an Enter clears it, because a run is a
   * sequence of entries and a click or an arrow ends the sequence.
   */
  private run: CellRef | null

  constructor(rows: number, cols: number) {
    this.rows = Math.max(0, rows)
    this.cols = Math.max(0, cols)
    this.active = { anchor: { row: 0, col: 0 }, head: { row: 0, col: 0 } }
    this.extra = []
    this.cursor = { row: 0, col: 0 }
    this.run = null
  }

  /** Rows/columns changed under us (an import, a delete). Nothing may point off the grid. */
  resize(rows: number, cols: number): this {
    this.rows = Math.max(0, rows)
    this.cols = Math.max(0, cols)
    const fix = (r: Range): Range => ({
      anchor: this.clamp(r.anchor.row, r.anchor.col),
      head: this.clamp(r.head.row, r.head.col),
    })
    this.active = fix(this.active)
    this.extra = this.extra.map(fix)
    this.cursor = this.clamp(this.cursor.row, this.cursor.col)
    this.run = null
    return this
  }

  clamp(row: number, col: number): CellRef {
    return {
      row: Math.max(0, Math.min(this.rows - 1, row)),
      col: Math.max(0, Math.min(this.cols - 1, col)),
    }
  }

  /** Every selected range, oldest first, with the active one last. */
  ranges(): Range[] { return [...this.extra, this.active] }

  /** More than one cell is selected — the test Tab and Enter branch on. */
  isRange(): boolean {
    const b = normalize(this.active)
    return b.top !== b.bottom || b.left !== b.right
  }

  /** Collapse to one cell. This is a click. */
  moveTo(row: number, col: number): this {
    const p = this.clamp(row, col)
    this.active = { anchor: { ...p }, head: { ...p } }
    this.extra = []
    this.cursor = { ...p }
    this.run = null
    return this
  }

  /** Drag or shift+click: the anchor stays, the head goes here. */
  extendTo(row: number, col: number): this {
    this.active = { anchor: { ...this.active.anchor }, head: this.clamp(row, col) }
    // The active cell must stay inside the selection. Shrinking a range back
    // past the cursor would otherwise leave typing landing outside the
    // highlight — visible nowhere, wrong everywhere.
    if (!contains(this.active, this.cursor.row, this.cursor.col)) {
      this.cursor = { ...this.active.anchor }
    }
    this.run = null
    return this
  }

  move(dr: number, dc: number, opts: MoveOpts = {}): this {
    const from = opts.extend ? this.active.head : this.cursor
    const to = opts.jump
      ? this.edge(from, dr, dc, opts.filled)
      : this.clamp(from.row + dr, from.col + dc)
    return opts.extend ? this.extendTo(to.row, to.col) : this.moveTo(to.row, to.col)
  }

  extend(dr: number, dc: number): this { return this.move(dr, dc, { extend: true }) }

  /**
   * Excel's ⌘↓, exactly: three cases, and the third is the one that matters.
   *
   *   next cell filled → run to the LAST filled cell of that block
   *   next cell blank  → skip the blanks and land on the first filled cell
   *   nothing ahead    → stop at the sheet's boundary
   *
   * The naive version — "walk until blank" — collapses the second case: from a
   * blank cell it never moves at all, which is the half of the shortcut people
   * use to get from the end of one block to the start of the next.
   */
  private edge(
    from: CellRef, dr: number, dc: number,
    filled?: (row: number, col: number) => boolean,
  ): CellRef {
    // Stepping a whole grid's worth and clamping IS the far edge, in any
    // direction, without a second sign-dependent branch to get wrong.
    const boundary = this.clamp(
      from.row + dr * Math.max(1, this.rows),
      from.col + dc * Math.max(1, this.cols),
    )
    if (!filled) return boundary

    const inside = (p: CellRef): boolean =>
      p.row >= 0 && p.row < this.rows && p.col >= 0 && p.col < this.cols
    const step = (p: CellRef): CellRef => ({ row: p.row + dr, col: p.col + dc })

    let p = step(from)
    if (!inside(p)) return { ...from }

    if (filled(p.row, p.col)) {
      for (;;) {
        const next = step(p)
        if (!inside(next) || !filled(next.row, next.col)) return p
        p = next
      }
    }
    while (inside(p)) {
      if (filled(p.row, p.col)) return p
      p = step(p)
    }
    return boundary
  }

  /**
   * Tab.
   *
   * With a RANGE selected it walks the active cell inside the block and wraps —
   * that is how a person fills in a form-shaped selection, and the block must
   * not move while they do it. With a SINGLE cell it moves plainly and stops at
   * the last column: there is no range to wrap inside, and teleporting to the
   * next row's first cell would be a jump the typist did not ask for.
   */
  tab(back = false): this {
    const step = back ? -1 : 1
    if (this.isRange()) return this.cycle(0, step)
    // The run starts at the cell Tab was pressed FROM, and survives the move —
    // moveTo clears it, so it is restored deliberately rather than by accident.
    const start = this.run ?? { ...this.cursor }
    const col = this.cursor.col + step
    if (col >= 0 && col < this.cols) this.moveTo(this.cursor.row, col)
    this.run = start
    return this
  }

  /**
   * Enter.
   *
   * Down one, except that after a Tab run it comes home to the column the run
   * started in — and the landing cell becomes the new run start, so the next
   * Tab/Tab/Enter lands under it too. Inside a selected range it cycles the
   * range instead, wrapping into the next column at the bottom.
   */
  enter(back = false): this {
    const step = back ? -1 : 1
    if (this.isRange()) return this.cycle(step, 0)
    if (this.run) {
      const row = this.run.row + step
      if (row < 0 || row >= this.rows) return this
      const home = { row, col: this.run.col }
      this.moveTo(home.row, home.col)
      this.run = home
      return this
    }
    const row = this.cursor.row + step
    if (row >= 0 && row < this.rows) this.moveTo(row, this.cursor.col)
    return this
  }

  /**
   * Walk the active cell inside the active range, wrapping at the edge and
   * again at the corner. The range itself never moves.
   *
   * Only the ACTIVE range cycles. ⌘-clicked extras are left out because
   * ordering disjoint rectangles is a decision with no obvious right answer,
   * and guessing it would be worse than not having it.
   */
  private cycle(dr: number, dc: number): this {
    const b = normalize(this.active)
    let { row, col } = this.cursor
    if (!contains(this.active, row, col)) { row = b.top; col = b.left }
    if (dc) {
      col += dc
      if (col > b.right) { col = b.left; row = row + 1 > b.bottom ? b.top : row + 1 }
      else if (col < b.left) { col = b.right; row = row - 1 < b.top ? b.bottom : row - 1 }
    } else {
      row += dr
      if (row > b.bottom) { row = b.top; col = col + 1 > b.right ? b.left : col + 1 }
      else if (row < b.top) { row = b.bottom; col = col - 1 < b.left ? b.right : col - 1 }
    }
    this.cursor = { row, col }
    this.run = null
    return this
  }

  /** ⌘A. The active cell stays put — you selected everything to act on it, not to move. */
  selectAll(): this {
    this.active = { anchor: { row: 0, col: 0 }, head: this.clamp(this.rows - 1, this.cols - 1) }
    this.extra = []
    this.cursor = this.clamp(this.cursor.row, this.cursor.col)
    this.run = null
    return this
  }

  selectRow(r: number): this {
    const { row } = this.clamp(r, 0)
    this.active = { anchor: { row, col: 0 }, head: this.clamp(row, this.cols - 1) }
    this.extra = []
    this.cursor = this.clamp(row, this.cursor.col)
    this.run = null
    return this
  }

  selectCol(c: number): this {
    const { col } = this.clamp(0, c)
    this.active = { anchor: { row: 0, col }, head: this.clamp(this.rows - 1, col) }
    this.extra = []
    this.cursor = this.clamp(this.cursor.row, col)
    this.run = null
    return this
  }

  /**
   * ⌘-click a second block.
   *
   * The NEW range becomes the active one and the old active joins `extra`,
   * because the range you just drew is the one the next shift+arrow must
   * extend. Pushing the new one into `extra` instead reads the same on screen
   * and behaves wrongly the moment a key is pressed.
   */
  addRange(r: Range): this {
    this.extra.push(this.active)
    this.active = {
      anchor: this.clamp(r.anchor.row, r.anchor.col),
      head: this.clamp(r.head.row, r.head.col),
    }
    this.cursor = { ...this.active.anchor }
    this.run = null
    return this
  }

  /**
   * Every selected cell, row-major within each range.
   *
   * Deduplication costs a Set the size of the selection, and ⌘A on a 250k-row
   * sheet is millions of keys — so it is paid ONLY when there is more than one
   * range, since a single rectangle cannot overlap itself.
   */
  *cells(): Generator<CellRef> {
    const all = this.ranges()
    const seen = all.length > 1 ? new Set<string>() : null
    for (const r of all) {
      const b = normalize(r)
      for (let row = b.top; row <= b.bottom; row++) {
        for (let col = b.left; col <= b.right; col++) {
          if (seen) {
            const k = `${row}:${col}`
            if (seen.has(k)) continue
            seen.add(k)
          }
          yield { row, col }
        }
      }
    }
  }

  /** The bounding box over every range — what a paste or a chart binds to. */
  bounds(): Box {
    const boxes = this.ranges().map(normalize)
    return {
      top: Math.min(...boxes.map((b) => b.top)),
      left: Math.min(...boxes.map((b) => b.left)),
      bottom: Math.max(...boxes.map((b) => b.bottom)),
      right: Math.max(...boxes.map((b) => b.right)),
    }
  }
}

// --- Driving a selection from an Action ------------------------------------

export interface MotionCtx {
  /** rows a PageUp/PageDown covers — the grid's visible row count */
  page?: number
  filled?: (row: number, col: number) => boolean
}

/**
 * Apply the motion half of an Action, and report whether it was consumed.
 *
 * FALSE IS A REAL ANSWER: copy, paste, undo and clear are not selection
 * operations, and this returning true for them would let a caller believe the
 * selection had handled a paste.
 */
export function applyMotion(sel: Selection, a: Action, ctx: MotionCtx = {}): boolean {
  switch (a.kind) {
    case 'move': {
      const k = a.unit === 'page' ? Math.max(1, Math.floor(ctx.page ?? 1)) : 1
      sel.move(a.dr * k, a.dc * k, {
        extend: a.extend, jump: a.unit === 'edge', filled: ctx.filled,
      })
      return true
    }
    case 'tab': sel.tab(a.back); return true
    case 'enter': sel.enter(a.back); return true
    case 'home': {
      const row = a.whole ? 0 : sel.cursor.row
      if (a.extend) sel.extendTo(row, 0)
      else sel.moveTo(row, 0)
      return true
    }
    case 'end': {
      const row = a.whole ? sel.rows - 1 : sel.cursor.row
      if (a.extend) sel.extendTo(row, sel.cols - 1)
      else sel.moveTo(row, sel.cols - 1)
      return true
    }
    case 'selectAll': sel.selectAll(); return true
    case 'selectRow': sel.selectRow(sel.cursor.row); return true
    case 'selectCol': sel.selectCol(sel.cursor.col); return true
    default: return false
  }
}

// --- The clipboard ---------------------------------------------------------

const NEEDS_QUOTE = /[\t\n\r"]/

const quoteTsv = (v: unknown): string => {
  const s = v == null ? '' : String(v)
  return NEEDS_QUOTE.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * The selection as clipboard text.
 *
 * `get` is a callback rather than a grid because this must serialise DISPLAYED
 * values — a formula column's computed number, an override's corrected value —
 * and only the caller knows which layer wins.
 */
export function tsvFromRange(get: (row: number, col: number) => unknown, r: Range): string {
  const b = normalize(r)
  const lines: string[] = []
  for (let row = b.top; row <= b.bottom; row++) {
    const cells: string[] = []
    for (let col = b.left; col <= b.right; col++) cells.push(quoteTsv(get(row, col)))
    lines.push(cells.join('\t'))
  }
  return lines.join('\n')
}

/**
 * Clipboard text back into a grid of strings.
 *
 * A quote only OPENS a field at the start of one: Excel writes bare `5" pipe`
 * unquoted, and treating that quote as an opener eats the rest of the row into
 * one field. Same rule as import.ts, and it is the rule for the same reason.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQ = false
  let i = 0
  const push = (): void => { row.push(field); field = '' }
  const endRow = (): void => { push(); rows.push(row); row = [] }

  while (i < text.length) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue } // doubled = literal
        inQ = false; i++; continue
      }
      // A line break INSIDE a cell is one character, whichever pair of bytes
      // the source used. Excel writes CRLF; a cell that came back carrying a
      // stray CR compares unequal to the one that was copied.
      if (c === '\r') {
        if (text[i + 1] === '\n') i++
        field += '\n'; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"' && field === '') { inQ = true; i++; continue }
    if (c === '\t') { push(); i++; continue }
    if (c === '\r') { if (text[i + 1] === '\n') i++; endRow(); i++; continue }
    if (c === '\n') { endRow(); i++; continue }
    field += c; i++
  }

  // A trailing newline ends the last row rather than starting an empty one —
  // but EMPTY INPUT is one empty cell, not nothing. A copied blank cell has to
  // paste as a blank and clear what it lands on; returning [] here makes that
  // paste a silent no-op, and the old value stays while the user believes it
  // went.
  if (field !== '' || row.length || !rows.length) endRow()
  return rows
}

// --- The fill handle -------------------------------------------------------
//
// `target` is the TOTAL length of the result, seeds included — a drag covers
// rows 5..20, so the caller asks for 16 and gets 16, with no off-by-one
// arithmetic at the call site. Asking for fewer than there are seeds truncates.

/** Repeat the seeds until the target is covered. The fill handle's plain drag. */
export function fillDown(values: unknown[], target: number): unknown[] {
  if (target <= 0 || !values.length) return []
  const out: unknown[] = []
  for (let i = 0; i < target; i++) out.push(values[i % values.length])
  return out
}

/**
 * Continue the seeds as a series where one can be read out of them, and repeat
 * where one cannot.
 *
 * ONE NUMBER IS NOT ONE DATE, deliberately. Dragging a lone `1` gives 1, 1, 1;
 * a lone `2026-01-01` gives consecutive days and a lone `Q1` gives Q2, Q3. It
 * reads as inconsistent written down and it is exactly right in the hand — a
 * lone number is as likely to be a constant as the start of a count, while a
 * lone date or a numbered label almost never is. Excel and Sheets both make
 * this distinction, and users have twenty years of muscle memory in it.
 */
export function fillSeries(values: unknown[], target: number): unknown[] {
  if (target <= 0 || !values.length) return []
  const term = detectSeries(values)
  if (!term) return fillDown(values, target)
  const out = values.slice(0, target)
  for (let i = values.length; i < target; i++) out.push(term(i))
  return out
}

/** How many decimals a number is written with — the precision to round back to. */
function decimals(n: number): number {
  const s = String(n)
  const dot = s.indexOf('.')
  return dot < 0 || s.includes('e') ? 0 : s.length - dot - 1
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const TRAILING_NUM = /^(.*?)(\d+)$/

const pad2 = (n: number): string => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`

const DAY_MS = 86_400_000
/** UTC throughout: a local-time Date turns 2026-01-01 into 2025-12-31 west of Greenwich. */
const dayNumber = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / DAY_MS
function fromDayNumber(n: number): string {
  const t = new Date(n * DAY_MS)
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/** Month arithmetic clamps: one month after 31 January is 28 February, not 3 March. */
function addMonths(y: number, m: number, d: number, k: number): string {
  const t = y * 12 + (m - 1) + k
  const ny = Math.floor(t / 12)
  const nm = ((t % 12) + 12) % 12 + 1
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return iso(ny, nm, Math.min(d, last))
}

/** Every gap is the same one, within float slop. */
function constantStep(xs: number[]): number | null {
  if (xs.length < 2) return null
  const d = xs[1] - xs[0]
  for (let i = 2; i < xs.length; i++) {
    // Exact equality refuses an obviously arithmetic column: 0.3 - 0.2 and
    // 0.2 - 0.1 are different doubles, so [0.1, 0.2, 0.3] would fill by
    // repetition. A relative tolerance is the whole fix.
    if (Math.abs((xs[i] - xs[i - 1]) - d) > 1e-9 * Math.max(1, Math.abs(d))) return null
  }
  return d
}

/**
 * A function giving the i-th term (i is a 0-based index into the FILLED range,
 * so i >= values.length for everything this produces), or null when the seeds
 * are not a series and the honest answer is to repeat them.
 */
function detectSeries(values: unknown[]): ((i: number) => unknown) | null {
  // --- numbers
  if (values.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    const xs = values as number[]
    const d = constantStep(xs)
    // A single number, or a flat run, is a CONSTANT until something says
    // otherwise — filling 5,5,5 with 5,6,7 invents data nobody asked for.
    if (d === null || d === 0) return null
    // Precision comes from the SEEDS, never from the step. 0.9 - 0.8 is
    // 0.09999999999999998 in binary floating point, so decimals(step) reports
    // 17 and the fill emits "1.000000000000" — a float artefact presented to
    // the user as significant figures.
    const dp = Math.min(12, xs.reduce((n, x) => Math.max(n, decimals(x)), 0))
    const f = 10 ** dp
    // Multiply rather than accumulate: repeated addition drifts, and the drift
    // shows up as 0.30000000000000004 in a cell somebody is about to total.
    return (i) => Math.round((xs[0] + i * d) * f) / f
  }

  if (!values.every((v) => typeof v === 'string' && v !== '')) return null
  const ss = values as string[]

  // --- ISO dates: months first, because a month step is not a constant number
  // of days and the day check would happily "fit" 31 to a January→February pair
  // and then land on 4 March.
  const parts: Array<{ y: number; m: number; d: number }> = []
  for (const s of ss) {
    const m = ISO_DATE.exec(s)
    if (!m) { parts.length = 0; break }
    parts.push({ y: +m[1], m: +m[2], d: +m[3] })
  }
  if (parts.length === ss.length) {
    const first = parts[0]
    const day0 = dayNumber(first.y, first.m, first.d)
    if (parts.length === 1) return (i) => fromDayNumber(day0 + i)
    if (parts.every((p) => p.d === first.d)) {
      const km = constantStep(parts.map((p) => p.y * 12 + p.m))
      if (km !== null && km !== 0) return (i) => addMonths(first.y, first.m, first.d, i * km)
    }
    const kd = constantStep(parts.map((p) => dayNumber(p.y, p.m, p.d)))
    if (kd === null || kd === 0) return null
    return (i) => fromDayNumber(day0 + i * kd)
  }

  // --- numeric STRINGS. A text column can still hold numbers — an import that
  // could not settle a type leaves them as text, which is the case this whole
  // app is built around. They must be continued NUMERICALLY, because the label
  // path below splits on a trailing digit run and would read "0.8" as the label
  // "0." followed by 8: the fill then emits 0.10, 0.11, which is not merely
  // wrong, it is SMALLER than the value it follows.
  if (ss.every((x) => x.trim() !== '' && Number.isFinite(Number(x.trim())))) {
    const xs = ss.map((x) => Number(x.trim()))
    const d = constantStep(xs)
    if (d === null || d === 0) return null
    const dp = Math.min(12, xs.reduce((n, x) => Math.max(n, decimals(x)), 0))
    const f = 10 ** dp
    // back to a STRING, at the seeds' own precision: the column is text, and a
    // fill must not change what type the cells hold
    return (i) => (Math.round((xs[0] + i * d) * f) / f).toFixed(dp)
  }

  // --- text ending in a number: "Q1" → "Q2", "Item 01" → "Item 02"
  const nums: number[] = []
  let prefix: string | null = null
  let digits = ''
  for (const s of ss) {
    const m = TRAILING_NUM.exec(s)
    if (!m) return null
    if (prefix === null) prefix = m[1]
    else if (m[1] !== prefix) return null   // "Q1" then "P2" is two labels, not a series
    nums.push(Number(m[2]))
    digits = m[2]
  }
  const k = nums.length === 1 ? 1 : constantStep(nums)
  if (k === null || k === 0) return null
  // Zero padding is part of the label: "item09" continues "item10", not "item1 0".
  const width = digits.startsWith('0') ? digits.length : 0
  const head = prefix ?? ''
  return (i) => `${head}${String(nums[0] + i * k).padStart(width, '0')}`
}
