// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Find, and Replace.
//
// WHY THIS IS NOT OPTIONAL, AND WHY THE BROWSER'S ⌘F IS WORSE THAN NOTHING.
//
// The grid is WINDOWED (grid.ts: only the visible slice exists, two spacers
// hold the scrollbar honest). On a 5,000-row sheet about 55 rows are in the
// DOM. So an unclaimed ⌘F hands the search to the browser, the browser scans
// the ~55 rows it can see, and it reports "0/0" for a value that is sitting in
// the file. Measured on the rig sheet: the value in the LAST row is absent from
// `document.body.innerText` until the grid is scrolled to it. That is not a
// missing feature, it is the application telling the user their data is not
// there. Virtualisation bought the row count; this is the bill.
//
// FOUR DECISIONS, each of which has a wrong answer that looks right:
//
//  1. WHAT IS SEARCHED — what the reader SEES, and also what the file STORES.
//     A money cell holding 12400 shows "£12,400.00". Someone typing "12,400"
//     means the thing on their screen; someone typing "12400" means the number
//     they typed in. Matching only the display fails the second; matching only
//     the stored value fails the first — and a search that answers "not found"
//     about a value on screen is the exact failure this file exists to fix. So
//     a cell offers TWO haystacks and either may match. The `Formulas` mode is
//     the separate question: it searches what the FORMULA BAR would show (the
//     per-cell formula, the column's expression) — because somebody hunting a
//     formula is hunting the source, not its result. The control is on the bar,
//     labelled, because a search mode nobody can see is a search mode nobody
//     trusts.
//
//  2. WHICH ROWS — the ones the reader can SEE, in the order they are shown.
//     `store.order[sheetId]` is the view vector (filters and sorts write it
//     without touching the document), and hidden columns are out of the visible
//     column list. A find that jumps to a row the filter has hidden lands the
//     selection on a DIFFERENT row than the one that matched, silently, because
//     visible position and canonical position are the same number right up
//     until somebody sorts. Everything below walks visible positions and
//     converts to rid only at the edge — the same discipline select.ts states.
//
//  3. HOW FAR — this sheet by default, the whole workbook on request.
//     Excel offers both and defaults to the sheet, and that is the right
//     default here for a reason particular to dash: the view vector, the
//     selection and the scroll position all belong to the sheet on screen, so
//     an all-sheets default would let an innocent ⌘F rearrange what the reader
//     is looking at. The scope control names the answer in words ("This sheet"
//     / "All sheets") rather than leaving it to be inferred, and the match
//     counter names the sheet a cross-workbook hit landed on.
//
//  4. REPLACE, ONLY WHERE IT CAN BE HONEST. A Replace that writes through a
//     filter incorrectly is far worse than no Replace, so this one is built out
//     of the same rid-keyed patches the rest of the app writes: a match knows
//     its rid, and a rid does not move when a filter does. What it REFUSES is
//     the interesting half — a cell whose value is produced by a formula
//     (column expression or per-cell `f`) is not rewritten, because the write
//     would be overwritten by the next recalculation and the user would watch
//     their edit evaporate; and a match found ONLY in the formatted text
//     ("£12,400.00") is not rewritten, because there is no defensible way to
//     push a substring of a rendering back into a number. Both are COUNTED and
//     reported, never skipped in silence. A hand correction (`cells[k].v`) is
//     rewritten in place as an override, so the layer that wins on screen is
//     the layer that changes.
//
// Everything above the UI section is pure and runs in node —
// `scripts/test-dash-find.ts` is the guard.

import './find.css'
import { formatValue } from './format.ts'
import { readCell, type Patch, type Store } from './store.ts'
import type { CellOverride, Column, ColumnType, DashDoc, TableSheet } from './model.ts'
import { recalc, isErr, type Vec } from './formula.ts'
import { recalcCells, cellKey, type CellSource } from './cellformula.ts'
import { hiddenSet } from './rowcol.ts'
import { colToLetters } from './a1.ts'
import { keyToAction } from './select.ts'
import { t } from './i18n.ts'
// TYPE-ONLY, and deliberately. grid.ts imports this module for real (it mounts
// the bar), so a value import back would be a runtime cycle between the two
// biggest modules in the app. What Replace needs from the grid — the coercion
// that decides what "1,200" means in a money column — is INJECTED instead,
// which also leaves `planReplace` a pure function the rig can drive in node.
import type { Grid } from './grid.ts'

// --- what a query is ---------------------------------------------------------

/** Which layer of a cell the query is asked about. */
export type LookIn = 'values' | 'formulas'

export interface FindQuery {
  query: string
  /** default false: people type lowercase and mean either */
  caseSensitive?: boolean
  /** the whole cell must equal the query — Excel's "match entire cell contents" */
  wholeCell?: boolean
  look?: LookIn
}

/**
 * Does one haystack answer the query?
 *
 * Trimmed on the WHOLE-CELL path only. "Acme " and "Acme" are the same answer
 * to "is this cell Acme?", and they are not the same answer to "does this cell
 * contain 'me '?" — so the trim belongs to equality and nowhere else.
 */
export function matchText(hay: string, q: FindQuery): boolean {
  if (q.query === '') return false
  const a = q.caseSensitive ? hay : hay.toLowerCase()
  const b = q.caseSensitive ? q.query : q.query.toLowerCase()
  return q.wholeCell ? a.trim() === b.trim() : a.includes(b)
}

/**
 * Substitute every occurrence in one cell's text.
 *
 * Hand-rolled rather than a RegExp because the query is USER TEXT: `.` and `(`
 * and `$` are all things people search a spreadsheet for, and an escaping bug
 * in a replace is a data-loss bug. Whole-cell mode replaces the cell outright,
 * which is what "match entire cell contents" has to mean on the write side.
 */
export function replaceIn(
  hay: string, find: string, repl: string, caseSensitive = false, wholeCell = false,
): string {
  if (wholeCell) return repl
  if (find === '') return hay
  const h = caseSensitive ? hay : hay.toLowerCase()
  const f = caseSensitive ? find : find.toLowerCase()
  let out = ''
  let i = 0
  for (;;) {
    const k = h.indexOf(f, i)
    if (k < 0) return out + hay.slice(i)
    out += hay.slice(i, k) + repl
    i = k + f.length
  }
}

/**
 * The next match index, wrapping at both ends.
 *
 * WRAPPING IS THE WHOLE CONTRACT of a find bar's Enter key, and the off-by-one
 * lives at the start: with nothing selected yet (`cur < 0`) the first Enter
 * must land on match 0 going forward and on the LAST match going back, not on
 * match 1 and match -1.
 */
export function stepIndex(n: number, cur: number, dir: 1 | -1): number {
  if (n <= 0) return -1
  if (cur < 0) return dir === 1 ? 0 : n - 1
  return ((cur + dir) % n + n) % n
}

// --- what a search reads -----------------------------------------------------

/** The subset of a column a search needs. Kept minimal so a rig can supply one. */
export interface SearchColumn {
  id: string
  name: string
  type: ColumnType
  format?: string
  /** a COMPUTED column: its cells are derived and Replace refuses them */
  formula?: string
}

/**
 * A sheet, flattened to what a search walks — and nothing else.
 *
 * `order` is the VIEW VECTOR: visible row → canonical row, or null for "the
 * sheet's own order". `columns` are the VISIBLE columns in visible order. Both
 * are the caller's job precisely because they are the two things a find gets
 * wrong: the grid paints through them, so the search has to as well.
 */
export interface SearchTarget {
  sheetId: string
  sheetName: string
  columns: SearchColumn[]
  order: number[] | null
  rows: number
  /** canonical row → the value the reader SEES (formula result, override, stored) */
  valueAt: (colId: string, row: number) => unknown
  /** canonical row → the STORED value, which is the only thing Replace may rewrite */
  storedAt: (colId: string, row: number) => unknown
  /** canonical row → what the formula bar shows, if the cell has a source */
  sourceAt?: (colId: string, row: number) => string | undefined
  /** canonical row → the cell's hand-correction override, if it carries a value */
  overrideAt?: (colId: string, row: number) => CellOverride | undefined
  ridAt: (row: number) => number
}

/** Why a match cannot be rewritten. Counted and reported, never silently dropped. */
export type Locked = 'computed' | 'formula' | 'display-only'

export interface Hit {
  sheetId: string
  sheetName: string
  /** VISIBLE coordinates — what the grid selects and scrolls to */
  row: number
  col: number
  colId: string
  /** the sheet's own row index, for reading and for writing an override key */
  canonRow: number
  rid: number
  /** the text that matched, for a preview line */
  text: string
  /** absent = Replace may rewrite this cell */
  locked?: Locked
  /** rewrite the OVERRIDE rather than the column: that is the layer on screen */
  viaOverride?: boolean
}

/**
 * What one cell shows, exactly as grid.ts paints it.
 *
 * The error branch mirrors the grid's (`isErr(v) ? String(v) : formatValue`) so
 * that searching "#CYCLE!" finds the cells displaying it — the one thing a
 * reader is most likely to hunt for and the one a formatter would swallow.
 */
export function displayOf(v: unknown, col: SearchColumn): string {
  if (v == null || v === '') return ''
  if (isErr(v)) return String(v)
  // text, enum and date are returned by formatValue unchanged (format.ts), and
  // formatValue builds an Intl.NumberFormat per call — 30,000 of them on a
  // 5,000-row sheet. Skipping the ones that cannot differ from the raw string
  // is most of the search's budget on a typical wide sheet.
  if (col.type === 'text' || col.type === 'enum' || col.type === 'date') return String(v)
  return formatValue(v, col as Pick<Column, 'type' | 'format'>)
}

const rawText = (v: unknown): string => (v == null ? '' : String(v))

/**
 * Every match in one sheet, in the order the reader would walk them:
 * top to bottom of the VISIBLE rows, left to right across the VISIBLE columns.
 */
export function searchTarget(target: SearchTarget, q: FindQuery): Hit[] {
  const out: Hit[] = []
  if (q.query === '') return out
  const look = q.look ?? 'values'
  const n = target.order ? target.order.length : target.rows
  for (let vis = 0; vis < n; vis++) {
    const canon = target.order ? target.order[vis] : vis
    if (canon == null || canon < 0 || canon >= target.rows) continue
    for (let ci = 0; ci < target.columns.length; ci++) {
      const col = target.columns[ci]
      const src = target.sourceAt?.(col.id, canon)
      const stored = target.storedAt(col.id, canon)
      const over = target.overrideAt?.(col.id, canon)
      const hasOverrideValue = over !== undefined && 'v' in over

      if (look === 'formulas') {
        // The formula bar's own precedence (grid.ts announce): a per-cell
        // source, then the column's expression, then the raw value. Searching
        // the RESULT here would make the two modes the same mode for every
        // cell that is not a formula, which is most of them.
        const hay = src !== undefined ? src
          : col.formula ? `= ${col.formula}`
            : rawText(hasOverrideValue ? over!.v : stored)
        if (!matchText(hay, q)) continue
        out.push({
          sheetId: target.sheetId, sheetName: target.sheetName,
          row: vis, col: ci, colId: col.id, canonRow: canon,
          rid: target.ridAt(vis), text: hay,
          ...lockOf(col, src, hasOverrideValue, true),
        })
        continue
      }

      const shown = target.valueAt(col.id, canon)
      const display = displayOf(shown, col)
      // The stored text is the second haystack, and it is what Replace can
      // actually rewrite — so which one matched is recorded, not just that one
      // did.
      const under = rawText(hasOverrideValue ? over!.v : stored)
      const inStored = matchText(under, q)
      const inDisplay = under === display ? inStored : matchText(display, q)
      if (!inStored && !inDisplay) continue
      out.push({
        sheetId: target.sheetId, sheetName: target.sheetName,
        row: vis, col: ci, colId: col.id, canonRow: canon,
        rid: target.ridAt(vis), text: display || under,
        ...lockOf(col, src, hasOverrideValue, !inStored),
      })
    }
  }
  return out
}

function lockOf(
  col: SearchColumn, src: string | undefined, viaOverride: boolean, displayOnly: boolean,
): { locked?: Locked; viaOverride?: boolean } {
  if (col.formula) return { locked: 'computed' }
  if (src !== undefined) return { locked: 'formula' }
  if (displayOnly) return { locked: 'display-only' }
  return viaOverride ? { viaOverride: true } : {}
}

/** A1-style label for a hit, for the "found it here" line. */
export const hitRef = (h: Hit): string => `${colToLetters(h.col)}${h.row + 1}`

// --- building a target out of a real sheet -----------------------------------

/**
 * One code path for the sheet on screen and for every other sheet in the book.
 *
 * `computed` is the grid's already-recalculated formula columns for the sheet
 * it is showing; without it the columns are recalculated here. Doing it in two
 * different ways is how the sheet you are looking at and the sheet you are not
 * come to disagree about what a formula column contains.
 */
export function buildTarget(
  doc: DashDoc, sheet: TableSheet, order: number[] | null, computed?: Map<string, Vec>,
): SearchTarget {
  const hidden = hiddenSet(sheet)
  const visible = sheet.columns.filter((c) => !hidden.has(c.id))
  const rows = sheet.rids.reduce((a, [, c]) => a + c, 0)

  const comp = computed ?? (sheet.columns.some((c) => c.formula)
    ? recalc(sheet, doc.modified).values
    : new Map<string, Vec>())

  const rid = (row: number): number => {
    let i = 0
    for (const [start, count] of sheet.rids) {
      if (row < i + count) return start + (row - i)
      i += count
    }
    return -1
  }
  const over = (colId: string, row: number): CellOverride | undefined =>
    sheet.cells?.[`${colId}:${rid(row)}`]
  const source = (colId: string, row: number): string | undefined => {
    const f = over(colId, row)?.f
    return typeof f === 'string' && f !== '' ? f : undefined
  }

  // Per-cell formula results, over CANONICAL positions — the same addressing
  // grid.ts uses, because A1 names the document and not one reader's view.
  let cellValues: Map<string, unknown> = new Map()
  const hasCellFormulas = (() => {
    const cells = sheet.cells
    if (!cells) return false
    for (const k in cells) if (typeof cells[k]?.f === 'string') return true
    return false
  })()
  if (hasCellFormulas) {
    const src: CellSource = {
      rows, cols: sheet.columns.length,
      formulaAt: (r, c) => {
        const col = sheet.columns[c]
        return col ? source(col.id, r) : undefined
      },
      valueAt: (r, c) => {
        const col = sheet.columns[c]
        if (!col) return null
        const o = over(col.id, r)
        if (o && 'v' in o) return o.v as never
        const v = comp.get(col.id)
        return (v ? v[r] : readCell(sheet.data[col.id], r)) as never
      },
    }
    const vecs = new Map<string, Vec>()
    for (const c of sheet.columns) {
      const v = comp.get(c.id)
        ?? Array.from({ length: rows }, (_, i) => readCell(sheet.data[c.id], i) as never)
      vecs.set(c.id, v); vecs.set(c.id.toLowerCase(), v)
      vecs.set(c.name, v); vecs.set(c.name.toLowerCase(), v)
    }
    cellValues = recalcCells(src, doc.modified, vecs).values as Map<string, unknown>
  }

  const colIndex = new Map(sheet.columns.map((c, i) => [c.id, i]))

  return {
    sheetId: sheet.id,
    sheetName: sheet.name,
    columns: visible.map((c) => ({
      id: c.id, name: c.name, type: c.type, format: c.format, formula: c.formula,
    })),
    order,
    rows,
    storedAt: (colId, row) => readCell(sheet.data[colId], row),
    overrideAt: over,
    sourceAt: source,
    valueAt: (colId, row) => {
      if (cellValues.size) {
        const k = cellKey(row, colIndex.get(colId) ?? -1)
        if (cellValues.has(k)) return cellValues.get(k)
      }
      const o = over(colId, row)
      if (o && 'v' in o) return o.v
      const v = comp.get(colId)
      return v ? v[row] : readCell(sheet.data[colId], row)
    },
    ridAt: (vis) => rid(order ? order[vis] : vis),
  }
}

// --- Replace -----------------------------------------------------------------

/**
 * What a typed value means in a column of this type — grid.ts's
 * `coerceForColumn`, handed in rather than imported. A replacement lands in a
 * cell exactly as a typed value does, and two copies of that rule is two
 * answers to "is 1,200 a number here?".
 */
export type Coerce = (text: string, type: ColumnType) => unknown

export interface ReplacePlan {
  patches: Patch[]
  /** cells that will change */
  done: number
  /** matches that will not, by reason — every one of these is shown to the user */
  skipped: Record<Locked, number>
}

/**
 * Turn a list of hits into ONE undo step.
 *
 * Keyed by RID throughout, which is what makes this safe under a filter and a
 * sort alike: `setCells` names rows the document knows about, so the vector the
 * reader is looking through cannot re-target the write. The one case that reads
 * the view at all is choosing WHICH hits to rewrite, and the hits came from the
 * view on purpose.
 */
export function planReplace(
  hits: Hit[], sheets: Map<string, TableSheet>, q: FindQuery, repl: string,
  coerce: Coerce,
): ReplacePlan {
  const skipped: Record<Locked, number> = { computed: 0, formula: 0, 'display-only': 0 }
  const byCol = new Map<string, { sheet: string; col: string; rids: number[]; v: unknown[] }>()
  const byOver = new Map<string, { sheet: string; keys: string[]; v: Array<CellOverride | null> }>()
  let done = 0

  for (const h of hits) {
    if (h.locked) { skipped[h.locked]++; continue }
    const sheet = sheets.get(h.sheetId)
    if (!sheet) continue
    const col = sheet.columns.find((c) => c.id === h.colId)
    if (!col) continue
    const key = `${h.colId}:${h.rid}`
    const existing = sheet.cells?.[key]
    const before = h.viaOverride && existing && 'v' in existing
      ? existing.v
      : readCell(sheet.data[h.colId], h.canonRow)
    const text = rawText(before)
    const next = replaceIn(text, q.query, repl, q.caseSensitive === true, q.wholeCell === true)
    if (next === text) continue
    const value = coerce(next, col.type)
    done++
    if (h.viaOverride) {
      const e = byOver.get(h.sheetId) ?? { sheet: h.sheetId, keys: [], v: [] }
      e.keys.push(key)
      e.v.push({ ...(existing ?? {}), v: value })
      byOver.set(h.sheetId, e)
    } else {
      const k = `${h.sheetId}\u001F${h.colId}`
      const e = byCol.get(k) ?? { sheet: h.sheetId, col: h.colId, rids: [], v: [] }
      e.rids.push(h.rid)
      e.v.push(value)
      byCol.set(k, e)
    }
  }

  const patches: Patch[] = []
  for (const e of byCol.values()) {
    patches.push({ op: 'setCells', sheet: e.sheet, col: e.col, rids: e.rids, v: e.v })
  }
  for (const e of byOver.values()) {
    patches.push({ op: 'setOverrides', sheet: e.sheet, keys: e.keys, v: e.v, dropEmpty: true })
  }
  return { patches, done, skipped }
}

// --- the bar -----------------------------------------------------------------

export interface FindHost {
  store: Store
  grid: Grid
  /** where the bar is mounted — the grid's own host, which is `position: relative` */
  el: HTMLElement
  /** grid.ts's `coerceForColumn` — see `Coerce` */
  coerce: Coerce
}

export interface FindUI {
  open(select?: boolean): void
  close(): void
  isOpen(): boolean
  /**
   * Set the query (and any option) and search NOW, skipping the debounce.
   *
   * The scripting entry point — and the one a rig can drive deterministically,
   * because everything else about this bar is deliberately time-based. It
   * writes the controls as well as the state: a bar that is searching
   * case-sensitively while its own Aa button is off is a bar that lies about
   * what it just told you.
   */
  setQuery(query: string, opts?: Partial<Omit<FindQuery, 'query'>> & { scope?: 'sheet' | 'book' }): void
  /** ⌘G / ⇧⌘G, and Enter inside the field */
  step(back: boolean): void
  /** the grid changed sheets under us */
  sheetChanged(): void
  /** the current results, for scripting and for the rig */
  results(): Hit[]
  index(): number
  destroy(): void
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Re-searching on every keystroke of a 5,000-row sheet is the one thing that would make this feel slow. */
const DEBOUNCE_MS = 120

class FindBar implements FindUI {
  private store: Store
  private grid: Grid
  private coerce: Coerce
  private root: HTMLElement
  private q: HTMLInputElement
  private r!: HTMLInputElement
  private countEl: HTMLElement
  private noteEl: HTMLElement
  private opts: FindQuery = { query: '', caseSensitive: false, wholeCell: false, look: 'values' }
  private scope: 'sheet' | 'book' = 'sheet'
  private hits: Hit[] = []
  private at = -1
  private timer: ReturnType<typeof setTimeout> | undefined
  /** guards the re-search that a sheet switch of our OWN making would trigger */
  private jumping = false
  private offDoc: () => void
  private offView: () => void
  private onKey: (e: KeyboardEvent) => void

  constructor(host: FindHost) {
    this.store = host.store
    this.grid = host.grid
    this.coerce = host.coerce
    this.root = document.createElement('div')
    this.root.className = 'dx-find'
    this.root.hidden = true
    this.root.setAttribute('role', 'search')
    this.root.innerHTML = this.markup()
    host.el.appendChild(this.root)

    this.q = this.root.querySelector<HTMLInputElement>('.dx-find-q')!
    this.countEl = this.root.querySelector<HTMLElement>('.dx-find-count')!
    this.noteEl = this.root.querySelector<HTMLElement>('.dx-find-note')!
    this.wire()

    // A LISTENER, NOT A KEY LIST. `keyToAction` in select.ts is the single
    // description of this application's keyboard (help.ts's card is generated
    // from it), so the bar asks the map what a keystroke means rather than
    // testing for 'f' itself. CAPTURE phase, exactly as help.ts claims '?':
    // main.ts's own document handler bails out when focus is in an input, so a
    // bubble-phase ⌘F would not open the bar from the title field, and Escape
    // inside the bar would never reach anything.
    this.onKey = (e: KeyboardEvent) => this.handleKey(e)
    document.addEventListener('keydown', this.onKey, true)

    // The results describe a document and a view. When either moves — an edit,
    // a filter, a sort — they are stale, and a stale hit list points the
    // selection at rows that have moved.
    const refresh = () => { if (this.open_) this.schedule(true) }
    this.offDoc = this.store.on('doc', refresh)
    this.offView = this.store.on('view', refresh)
  }

  private open_ = false

  private markup(): string {
    // Read-only workbooks get the whole FIND half and none of the Replace half.
    // Find is a read; a Replace control that is present and refuses is a worse
    // answer than one that was never offered.
    const ro = this.store.readOnly
    return `<div class="dx-find-line">` +
      `<input class="dx-find-q" type="search" spellcheck="false" autocomplete="off" ` +
      `placeholder="${esc(t('Find in this sheet'))}" aria-label="${esc(t('Find'))}">` +
      `<span class="dx-find-count" aria-live="polite"></span>` +
      `<button class="dx-find-b dx-find-prev" title="${esc(t('Previous match (⇧⏎)'))}">↑</button>` +
      `<button class="dx-find-b dx-find-next" title="${esc(t('Next match (⏎)'))}">↓</button>` +
      `<button class="dx-find-b dx-find-x" title="${esc(t('Close find (Esc)'))}">✕</button>` +
      `</div>` +
      `<div class="dx-find-line dx-find-opts">` +
      `<button class="dx-find-t" data-o="case" title="${esc(t('Match case'))}">Aa</button>` +
      `<button class="dx-find-t" data-o="whole" title="${esc(t('Match the whole cell'))}">${esc(t('Whole cell'))}</button>` +
      `<select class="dx-find-look" title="${esc(t('Search the values on screen, or the formulas behind them'))}">` +
      `<option value="values">${esc(t('Values'))}</option>` +
      `<option value="formulas">${esc(t('Formulas'))}</option></select>` +
      `<select class="dx-find-scope" title="${esc(t('How far to search'))}">` +
      `<option value="sheet">${esc(t('This sheet'))}</option>` +
      `<option value="book">${esc(t('All sheets'))}</option></select>` +
      (ro ? '' : `<button class="dx-find-t dx-find-rt">${esc(t('Replace…'))}</button>`) +
      `</div>` +
      (ro ? '' : `<div class="dx-find-line dx-find-rep" hidden>` +
        `<input class="dx-find-r" spellcheck="false" autocomplete="off" ` +
        `placeholder="${esc(t('Replace with'))}" aria-label="${esc(t('Replace with'))}">` +
        `<button class="dx-find-b dx-find-r1">${esc(t('Replace'))}</button>` +
        `<button class="dx-find-b dx-find-ra">${esc(t('Replace all'))}</button>` +
        `</div>`) +
      `<div class="dx-find-note" aria-live="polite"></div>`
  }

  private wire(): void {
    this.q.addEventListener('input', () => {
      this.opts = { ...this.opts, query: this.q.value }
      this.schedule(false)
    })
    this.q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.step(e.shiftKey) }
    })
    const on = (sel: string, fn: () => void): void => {
      this.root.querySelector<HTMLElement>(sel)?.addEventListener('click', (e) => {
        e.preventDefault(); fn()
      })
    }
    on('.dx-find-next', () => this.step(false))
    on('.dx-find-prev', () => this.step(true))
    on('.dx-find-x', () => this.close())
    for (const b of this.root.querySelectorAll<HTMLElement>('.dx-find-t[data-o]')) {
      b.addEventListener('click', () => {
        const o = b.dataset.o
        if (o === 'case') this.opts = { ...this.opts, caseSensitive: !this.opts.caseSensitive }
        else this.opts = { ...this.opts, wholeCell: !this.opts.wholeCell }
        b.classList.toggle('on',
          o === 'case' ? this.opts.caseSensitive === true : this.opts.wholeCell === true)
        this.schedule(false)
      })
    }
    const look = this.root.querySelector<HTMLSelectElement>('.dx-find-look')!
    look.addEventListener('change', () => {
      this.opts = { ...this.opts, look: look.value as LookIn }
      this.schedule(false)
    })
    const scope = this.root.querySelector<HTMLSelectElement>('.dx-find-scope')!
    scope.addEventListener('change', () => {
      this.scope = scope.value === 'book' ? 'book' : 'sheet'
      // The placeholder is the plainest place to say what is being searched —
      // it is in the field the user is typing into.
      this.q.placeholder = this.scope === 'book' ? t('Find in all sheets') : t('Find in this sheet')
      this.schedule(false)
    })
    const rt = this.root.querySelector<HTMLElement>('.dx-find-rt')
    if (rt) {
      const row = this.root.querySelector<HTMLElement>('.dx-find-rep')!
      this.r = this.root.querySelector<HTMLInputElement>('.dx-find-r')!
      rt.addEventListener('click', () => {
        row.hidden = !row.hidden
        rt.classList.toggle('on', !row.hidden)
        if (!row.hidden) this.r.focus()
      })
      this.r.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.replaceCurrent() }
      })
      on('.dx-find-r1', () => this.replaceCurrent())
      on('.dx-find-ra', () => this.replaceAll())
    }
  }

  private handleKey(e: KeyboardEvent): void {
    // Escape closes, from anywhere the bar can be reached from. A cell editor
    // stops its own keydown before it ever gets here (grid.ts `edit`), so this
    // cannot steal the Esc that cancels an edit.
    if (e.key === 'Escape' && this.open_) {
      e.preventDefault(); e.stopPropagation(); this.close(); return
    }
    const mod = e.metaKey || e.ctrlKey
    if (!mod || e.altKey) return
    const a = keyToAction(e)
    if (!a) return
    // GIVE ⌘F BACK when the grid is not on screen — the dashboard hides it.
    // The claim to this key is earned by the virtualiser: where the browser's
    // own find would be WRONG, we take it, and where the browser can see
    // everything there is to see (a dashboard renders its whole content) taking
    // it would be a downgrade, plus a focused field nobody can see.
    if ((a.kind === 'find' || a.kind === 'findNext') && !this.gridVisible()) return
    if (a.kind === 'find') { e.preventDefault(); e.stopPropagation(); this.open(true); return }
    if (a.kind === 'findNext') { e.preventDefault(); e.stopPropagation(); this.step(a.back) }
  }

  /** Is the grid this bar belongs to actually painted? */
  private gridVisible(): boolean {
    const host = this.root.parentElement
    return !!host && host.offsetParent !== null
  }

  open(select = true): void {
    this.open_ = true
    this.root.hidden = false
    // Seed from the selection the way every editor does: whatever is in the
    // active cell is overwhelmingly what you were about to type.
    this.q.focus()
    if (select) this.q.select()
    this.schedule(true)
  }

  close(): void {
    this.open_ = false
    this.root.hidden = true
    this.hits = []
    this.at = -1
    this.grid.clearFindMarks()
    this.grid.focusGrid()
  }

  isOpen(): boolean { return this.open_ }
  results(): Hit[] { return this.hits }
  index(): number { return this.at }

  setQuery(
    query: string, o: Partial<Omit<FindQuery, 'query'>> & { scope?: 'sheet' | 'book' } = {},
  ): void {
    if (!this.open_) this.open(false)
    this.q.value = query
    this.opts = {
      query,
      caseSensitive: o.caseSensitive ?? this.opts.caseSensitive,
      wholeCell: o.wholeCell ?? this.opts.wholeCell,
      look: o.look ?? this.opts.look,
    }
    if (o.scope) this.scope = o.scope
    this.syncControls()
    this.at = -1
    this.schedule(true)
  }

  /** Push the current options back onto the controls, so the bar cannot misreport itself. */
  private syncControls(): void {
    const set = (sel: string, on: boolean): void => {
      this.root.querySelector<HTMLElement>(sel)?.classList.toggle('on', on)
    }
    set('.dx-find-t[data-o="case"]', this.opts.caseSensitive === true)
    set('.dx-find-t[data-o="whole"]', this.opts.wholeCell === true)
    const look = this.root.querySelector<HTMLSelectElement>('.dx-find-look')
    if (look) look.value = this.opts.look ?? 'values'
    const scope = this.root.querySelector<HTMLSelectElement>('.dx-find-scope')
    if (scope) scope.value = this.scope
    this.q.placeholder = this.scope === 'book' ? t('Find in all sheets') : t('Find in this sheet')
  }

  sheetChanged(): void {
    if (this.jumping || !this.open_) return
    this.at = -1
    this.schedule(true)
  }

  private schedule(now: boolean): void {
    clearTimeout(this.timer)
    if (now) { this.run(); return }
    this.timer = setTimeout(() => this.run(), DEBOUNCE_MS)
  }

  /** Every sheet a search may walk — table sheets only; a pivot holds no cells. */
  private targets(): SearchTarget[] {
    const doc = this.store.doc
    const here = this.grid.sheet
    const build = (sh: TableSheet): SearchTarget => buildTarget(
      doc, sh, this.store.order[sh.id] ?? null,
      sh.id === here.id ? (this.grid.computed as Map<string, Vec>) : undefined,
    )
    if (this.scope === 'sheet') return [build(here)]
    // The sheet on screen goes FIRST, so Enter walks forward from where the
    // reader is rather than from wherever the workbook happens to start.
    const rest = doc.sheets.filter((s): s is TableSheet => s.kind === 'table' && s.id !== here.id)
    return [build(here), ...rest.map(build)]
  }

  private run(): void {
    if (!this.open_) return
    const q = this.opts
    this.ranSig = this.sig()
    if (q.query === '') {
      this.hits = []; this.at = -1
      this.grid.clearFindMarks()
      this.paintCount()
      return
    }
    const t0 = performance.now()
    const keep = this.at >= 0 ? this.hits[this.at] : null
    this.hits = this.targets().flatMap((tg) => searchTarget(tg, q))
    // Hold the reader's place across a re-search where we can: an edit
    // elsewhere in the sheet should not throw them back to match 1.
    this.at = keep
      ? this.hits.findIndex((h) =>
          h.sheetId === keep.sheetId && h.rid === keep.rid && h.colId === keep.colId)
      : -1
    this.lastMs = performance.now() - t0
    // INCREMENTAL: land on the first match as the query is typed, the way ⌘F
    // behaves everywhere else. Two reasons it is not a nicety here. The counter
    // said "1 of 1" while the reader was on nothing at all — a position claimed
    // and not held, which is the small kind of lie this app is built against.
    // And the whole reason this feature exists is that a match may be nowhere
    // near the viewport: answering "how many" while leaving "where" for a
    // second keystroke is answering the easier half of the question.
    if (this.at < 0 && this.hits.length) { this.at = 0; this.jumpTo(0); return }
    this.marks()
    this.paintCount()
  }

  /** how long the last search took — reported in the bar's title, and measurable */
  lastMs = 0

  private marks(): void {
    const id = this.grid.sheet.id
    const here = this.hits.filter((h) => h.sheetId === id)
    const cur = this.at >= 0 && this.hits[this.at]?.sheetId === id ? this.hits[this.at] : null
    this.grid.setFindMarks(here, cur)
  }

  private paintCount(): void {
    const n = this.hits.length
    if (this.opts.query === '') { this.countEl.textContent = ''; this.noteEl.hidden = true; return }
    // `at` is 0-based and is never -1 while there are hits (run() lands on the
    // first one), so the position shown is one the reader is actually on.
    this.countEl.textContent = n === 0
      ? t('No matches')
      : t('{i} of {n}').replace('{i}', String(this.at + 1)).replace('{n}', String(n))
    this.countEl.classList.toggle('none', n === 0)
    this.countEl.title = t('{n} match(es) in {ms} ms').replace('{n}', String(n))
      .replace('{ms}', String(Math.round(this.lastMs)))
    const cur = this.at >= 0 ? this.hits[this.at] : null
    // In workbook scope the sheet a match landed on is half the answer.
    if (cur && this.scope === 'book') {
      this.noteEl.hidden = false
      this.noteEl.textContent = `${cur.sheetName} · ${hitRef(cur)}`
    } else if (this.noteEl.dataset.sticky !== '1') {
      this.noteEl.hidden = true
    }
  }

  /**
   * What produced the hit list currently held. Enter cancels the pending
   * debounce, so without this a reader who types and presses Enter inside 120ms
   * — which is most readers — walked the PREVIOUS query's matches: the count
   * said one thing and the grid jumped somewhere else entirely. Measured in the
   * browser before this existed.
   */
  private ranSig = '\u0000'
  private sig(): string {
    const o = this.opts
    return JSON.stringify([o.query, o.caseSensitive ?? false, o.wholeCell ?? false,
      o.look ?? 'values', this.scope])
  }

  step(back: boolean): void {
    if (!this.open_) { this.open(true); return }
    clearTimeout(this.timer)
    if (this.opts.query !== this.q.value) this.opts = { ...this.opts, query: this.q.value }
    if (!this.hits.length || this.ranSig !== this.sig()) this.run()
    if (!this.hits.length) { this.paintCount(); return }
    this.at = stepIndex(this.hits.length, this.at, back ? -1 : 1)
    this.jumpTo(this.at)
  }

  private jumpTo(i: number): void {
    const h = this.hits[i]
    if (!h) return
    this.noteEl.dataset.sticky = ''
    if (h.sheetId !== this.grid.sheet.id) {
      this.jumping = true
      try { this.grid.setSheet(h.sheetId) } finally { this.jumping = false }
    }
    // THE WHOLE POINT: the row may not be in the DOM at all. `revealCell`
    // scrolls it into the window and selects it, and does NOT take focus —
    // the reader is still typing in the find field.
    this.grid.revealCell(h.row, h.col, { focus: false })
    this.marks()
    this.paintCount()
  }

  // --- Replace ---------------------------------------------------------------

  private replaceCurrent(): void {
    if (this.store.readOnly) return
    if (this.at < 0) { this.step(false); if (this.at < 0) return }
    this.apply([this.hits[this.at]], true)
  }

  private replaceAll(): void {
    if (this.store.readOnly) return
    if (!this.hits.length) this.run()
    this.apply(this.hits, false)
  }

  private apply(hits: Hit[], single: boolean): void {
    const sheets = new Map<string, TableSheet>()
    for (const s of this.store.doc.sheets) if (s.kind === 'table') sheets.set(s.id, s)
    const plan = planReplace(
      hits, sheets, { ...this.opts, query: this.q.value }, this.r?.value ?? '', this.coerce,
    )
    if (plan.patches.length) this.store.commit(plan.patches)
    const skipped = plan.skipped.computed + plan.skipped.formula + plan.skipped['display-only']
    const parts: string[] = [t('{n} replaced').replace('{n}', String(plan.done))]
    // SAY WHAT WAS REFUSED, and why. A Replace all that quietly rewrites 40 of
    // 47 matches is the failure mode this whole feature is guarding against.
    if (plan.skipped.computed) {
      parts.push(t('{n} in computed columns left alone').replace('{n}', String(plan.skipped.computed)))
    }
    if (plan.skipped.formula) {
      parts.push(t('{n} hold formulas and were left alone').replace('{n}', String(plan.skipped.formula)))
    }
    if (plan.skipped['display-only']) {
      parts.push(t('{n} matched only the formatted text, not the stored value')
        .replace('{n}', String(plan.skipped['display-only'])))
    }
    this.noteEl.hidden = false
    this.noteEl.dataset.sticky = '1'
    this.noteEl.textContent = parts.join(' · ')
    this.noteEl.classList.toggle('warn', skipped > 0)
    // the commit re-runs the search through the `doc` listener; step on so a
    // single Replace lands the reader on the NEXT match, as Excel does
    if (single) setTimeout(() => this.step(false), 0)
  }

  destroy(): void {
    clearTimeout(this.timer)
    document.removeEventListener('keydown', this.onKey, true)
    this.offDoc(); this.offView()
    this.root.remove()
  }
}

export function mountFind(host: FindHost): FindUI {
  const bar = new FindBar(host)
  // The scripting handle, beside main.ts's `__sync`. An agent (and the browser
  // rig) needs a way to drive a search and read its results without synthesising
  // keystrokes.
  ;(globalThis as unknown as Record<string, unknown>).__find = bar
  return bar
}
