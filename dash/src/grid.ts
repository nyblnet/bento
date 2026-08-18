// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The grid.
//
// WINDOWED, not because 100k rows is slow to compute — a full scan is 5.9 ms —
// but because 100k × 6 is 600,000 DOM nodes, and that is what actually stops
// the browser. Only the visible slice exists; two spacer rows hold the
// scrollbar honest. This is the whole reason the grid can claim the row target
// the format was sized for.
//
// IT READS THROUGH AN ORDER VECTOR. Sorting sorts the vector, not the data:
// `store.view()` mutates it, emits an invalidation, and takes no checkpoint —
// so a sort does not dirty the file and does not produce an op. Writing the
// first sort as a `commit` is the easy mistake, and nobody notices until a
// workbook saves itself every time somebody clicks a column header.
//
// THE TYPE ROW IS THE DEMO. Import guesses, and where it cannot decide — a date
// column that fits both DD/MM and MM/DD — it refuses and says so. That refusal
// is only honest if changing the type is one click away, so the header carries
// the type as a control, not a label.

import { formatValue, alignFor, TYPE_LABEL } from './format.ts'
import type { Column, ColumnType, TableSheet } from './model.ts'
import { readCell, type Patch, type Store } from './store.ts'
import { recalc, isErr, type Vec } from './formula.ts'
import {
  Selection, keyToAction, applyMotion, contains, tsvFromRange, parseTsv,
  fillSeries, type Range,
} from './select.ts'
import { buildOrder, type ColumnFilter } from './filter.ts'
import { evaluateRules, type CellStyle } from './condfmt.ts'
import { colToLetters } from './a1.ts'
import { t } from './i18n.ts'
import { resizeColumn, autoFitWidth, hiddenSet, readFrozen } from './rowcol.ts'
import {
  cellKey, isFormula, recalcCells, translateCellFormula, shiftSheetFormulas,
  type CellSource,
} from './cellformula.ts'

/**
 * Row height, in px — SPREADSHEET density, not web-table density.
 *
 * Excel's default row is exactly this at 96dpi; Google Sheets' is 21px. dash
 * sat at 30, which is why the grid read as a table on a web page: a third fewer
 * rows on screen, and the eye has to travel further for every comparison a
 * spreadsheet exists to make. 22 was an intermediate step; 20 is the target,
 * chosen with the 'dense pro' direction.
 *
 * THIS CONSTANT AND THE `--row-h` CUSTOM PROPERTY MUST AGREE. They are two
 * declarations of one number — the rows are absolutely positioned at
 * `top: i * ROW_H` from here while their height comes from the stylesheet — so
 * a change to one alone perforates the grid: the cells shrink and the row
 * boxes do not. That drift is not hypothetical; it is what stopped the density
 * fix the first time it was tried. So the grid WRITES the property from this
 * constant at build time, and the value in styles.css is only a fallback for
 * anything that renders before the grid mounts.
 */
const ROW_H = 20
const GUTTER_W = 52
const OVERSCAN = 8

export interface GridHost {
  el: HTMLElement
  store: Store
  sheetId: string
}

const cols = (s: TableSheet) => {
  const hidden = hiddenSet(s)
  return s.columns.filter((c) => !hidden.has(c.id))
}
const rowCount = (s: TableSheet) => s.rids.reduce((n, [, c]) => n + c, 0)

/** Shared empty map, so "no cell formulas" costs no allocation on every paint. */
const EMPTY_CELLS: ReadonlyMap<string, unknown> = new Map()

/** Canonical row index → rid. The inverse of `dataRow`, ignoring the view. */
function ridForDataRow(sheet: TableSheet, r: number): number {
  let i = 0
  for (const [start, count] of sheet.rids) {
    if (r < i + count) return start + (r - i)
    i += count
  }
  return -1
}

/** Row index → rid, honouring the view's order vector when one exists. */
function ridAt(store: Store, sheet: TableSheet, i: number): number {
  const order = store.order[sheet.id]
  const idx = order ? order[i] : i
  let seen = 0
  for (const [start, count] of sheet.rids) {
    if (idx < seen + count) return start + (idx - seen)
    seen += count
  }
  return -1
}

const dataRow = (sheet: TableSheet, rid: number): number => {
  let i = 0
  for (const [start, count] of sheet.rids) {
    if (rid >= start && rid < start + count) return i + (rid - start)
    i += count
  }
  return -1
}

export class Grid {
  private host: HTMLElement
  private store: Store
  private sheetId: string
  private scroller!: HTMLElement
  private table!: HTMLElement
  private editing: { rid: number; col: string } | null = null
  private sort: { col: string; dir: 'asc' | 'desc' } | null = null
  /** formula columns, recomputed on every document change. Never stored: the
   *  document holds the EXPRESSION, and the values are derived from it, so a
   *  file cannot carry a number that disagrees with its own formula. */
  computed = new Map<string, Vec>()
  cycles: string[] = []
  /** per-cell formula results, keyed by CANONICAL position (see cellformula.ts) */
  private cellValues: ReadonlyMap<string, unknown> = EMPTY_CELLS
  /** the selection model — visible positions, never rids (see select.ts) */
  sel!: Selection
  filters: ColumnFilter[] = []
  sorts: Array<{ col: string; dir: 'asc' | 'desc' }> = []
  /** conditional-format styles for the painted window, keyed colId */
  private styles = new Map<string, Array<CellStyle | null>>()
  onSelectionChange?: (summary: string, ref: string, value: string) => void
  onContextMenu?: (row: number, col: number, x: number, y: number) => void
  onFilterMenu?: (colId: string, x: number, y: number) => void
  /** set by the app so a type change can be routed through one place */
  onRetype?: (col: Column, x: number, y: number) => void
  /** double-clicking a computed cell edits the FORMULA, not the value */
  onEditFormula?: (col: Column) => void

  constructor(opts: GridHost) {
    this.host = opts.el
    this.store = opts.store
    this.sheetId = opts.sheetId
    this.sel = new Selection(rowCount(this.sheet), cols(this.sheet).length)
    this.build()
    this.store.on('doc', () => {
      // A structural edit invalidates the order VECTOR: it holds row indices,
      // and insert/delete renumber the rows underneath them. Leaving it alone
      // left the grid drawing blanks and rows in an order matching nothing.
      if (this.store.lastTouched.structural || this.store.lastTouched.all) this.applyView()
      this.sel.resize(this.store.order[this.sheet.id]?.length ?? rowCount(this.sheet),
        cols(this.sheet).length)
      this.paint()
    })
    this.store.on('view', () => this.paint())
  }

  /**
   * The patch that keeps every cell formula pointing at the right cells after
   * `count` rows or columns are inserted at canonical index `at` (removed, if
   * negative). Returns nothing when no formula moved.
   *
   * This must be committed IN THE SAME step as the structural patch. Two steps
   * would put a document on screen — and on the undo stack, and over collab —
   * in which the rows have moved and the formulas have not, which is a workbook
   * of wrong numbers that each look perfectly reasonable.
   */
  shiftFormulas(axis: 'row' | 'col', at: number, count: number): Patch[] {
    const s = this.sheet
    const cells = s.cells
    if (!cells) return []
    const pairs: Array<[string, string]> = []
    for (const k in cells) {
      const f = cells[k]?.f
      if (typeof f === 'string') pairs.push([k, f])
    }
    const moved = shiftSheetFormulas(pairs, axis, at, count)
    if (!moved.length) return []
    return [{
      op: 'setOverrides', sheet: s.id,
      keys: moved.map(([k]) => k),
      v: moved.map(([k, f]) => ({ ...cells[k], f })),
    }]
  }

  /**
   * A VISIBLE row index → the sheet's own row index.
   *
   * These are the same number until somebody sorts or filters, and then they
   * are not. Every structural op in rowcol.ts takes a CANONICAL index — it has
   * to, because a document edit cannot be expressed in one reader's view — so
   * anything acting on "the row the user clicked" has to convert here first.
   * It did not, and right-clicking the top row of a Value-sorted grid and
   * choosing Delete row deleted a DIFFERENT row: measured, £22,750 selected and
   * £12,400 destroyed, with the re-sorted view hiding the evidence.
   */
  canonicalRow(visible: number): number {
    const rid = ridAt(this.store, this.sheet, visible)
    return rid < 0 ? -1 : dataRow(this.sheet, rid)
  }

  /** Fires whenever the grid points at a different sheet — the sheet list follows it. */
  onSheetChange?: (id: string) => void

  /** Point the grid at a different sheet — an import adds one and shows it. */
  setSheet(id: string): void {
    this.sheetId = id
    this.sort = null
    this.filters = []
    this.sorts = []
    this.scroller.scrollTop = 0
    this.sel = new Selection(rowCount(this.sheet), cols(this.sheet).length)
    this.paint()
    this.onSheetChange?.(id)
  }

  get sheet(): TableSheet {
    const s = this.store.doc.sheets.find((x) => x.id === this.sheetId)
    if (!s || s.kind !== 'table') throw new Error('grid needs a table sheet')
    return s
  }

  private head!: HTMLElement
  private foot!: HTMLElement

  /**
   * Header and totals are in normal FLOW and stick to the scroller; only the
   * body rows are absolutely positioned, inside a sizer between them.
   *
   * Mixing the two in one stacking context was the first attempt and it hid
   * the first two rows behind the header — `position: sticky` resolves against
   * the scroll container, and an absolutely-positioned sibling at `top: 0`
   * lands underneath it.
   */
  private build(): void {
    this.host.innerHTML =
      '<div class="dg-scroll">' +
      '<div class="dg-table">' +
      '<div class="dg-head-row"></div>' +
      '<div class="dg-sizer"></div>' +
      '<div class="dg-foot-row"></div>' +
      '</div></div>'
    // One number, written where the stylesheet can see it. See ROW_H.
    this.host.style.setProperty('--row-h', `${ROW_H}px`)
    this.scroller = this.host.querySelector('.dg-scroll')!
    this.table = this.host.querySelector('.dg-sizer')!
    this.head = this.host.querySelector('.dg-head-row')!
    this.foot = this.host.querySelector('.dg-foot-row')!
    this.scroller.addEventListener('scroll', () => this.paint(), { passive: true })
    this.paint()
  }

  /** Header: the corner box, then a letter, name, type control and sort mark. */
  /**
   * Sticky offsets for the frozen columns, indexed by visible position.
   *
   * Frozen COLUMNS only. Frozen rows would need a second pane — the rows are
   * absolutely positioned by index so a subset cannot simply stick — and they
   * buy much less here, because the header is sticky already. Losing the label
   * column when you scroll right is the gap a reader actually hits.
   */
  private frozenLefts(): number[] {
    const n = readFrozen(this.sheet).cols
    const out: number[] = []
    let left = GUTTER_W
    const vis = cols(this.sheet)
    for (let i = 0; i < n && i < vis.length; i++) {
      out.push(left)
      left += vis[i].w ?? 130
    }
    return out
  }

  /** `style`/`class` fragments that stick column `ci` if it is frozen. */
  private freeze(ci: number): { st: string; cls: string } {
    const lefts = this.frozenLefts()
    if (lefts[ci] === undefined) return { st: '', cls: '' }
    const last = ci === lefts.length - 1 ? ' dg-freeze-edge' : ''
    return { st: `position:sticky;left:${lefts[ci]}px;`, cls: ` dg-frozen${last}` }
  }

  private header(): string {
    const s = this.sheet
    return `<div class="dg-cell dg-corner" data-all="1" title="Select all"></div>` +
      `${cols(s).map((c, ci) => {
      const arrow = this.sort?.col === c.id ? (this.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''
      const filtered = this.filters.some((f) => f.col === c.id)
      const fz = this.freeze(ci)
      // The COLUMN header lights with the selection, as the row gutter already
      // did. Excel and Sheets both mark the selected row AND column headers,
      // and with only one of the two the eye keeps losing which column it is
      // in on a wide sheet — the header is the only thing still on screen once
      // the cursor has scrolled away.
      const box = this.sel.bounds()
      const on = ci >= box.left && ci <= box.right ? ' dg-h-on' : ''
      return `<div class="dg-cell dg-h${filtered ? ' dg-filtered' : ''}${on}${fz.cls}" style="${fz.st}width:${c.w ?? 130}px" data-col="${c.id}" data-ci="${ci}">` +
        // TWO LINES, because one could not hold them: the letter, the name,
        // the type control, the filter arrow and the resize grip were sharing
        // 130px and the NAME lost — every column read "A R", "B O", "C :".
        // A spreadsheet whose column names are unreadable is not a spreadsheet.
        // The letter goes on its own strip, where Excel puts it and where it is
        // also the obvious click target for selecting the column.
        // The TYPE rides on the letter strip, which has room going spare, and
        // not beside the name, which does not: a full-width `PERCENT` badge is
        // what clipped `Probability` down to `P.`. It stays a button — the type
        // being one click away is what makes import's refusal to guess honest.
        `<span class="dg-hstrip">` +
        `<span class="dg-letter" title="${esc(t('Select column'))}">${colToLetters(ci)}</span>` +
        `<button class="dg-type" data-retype="${c.id}" title="${esc(TYPE_LABEL[c.type])} — click to change">${esc(TYPE_LABEL[c.type])}</button>` +
        `</span>` +
        `<span class="dg-hmain">` +
        `<span class="dg-name" title="${esc(c.formula ? `= ${c.formula}` : c.name)}">${esc(c.name)}${arrow}</span>` +
        (c.formula ? `<span class="dg-fx" title="${esc('= ' + c.formula)}">fx</span>` : '') +
        (c.failed ? `<span class="dg-warn" title="${c.failed} value(s) could not be read as ${esc(TYPE_LABEL[c.type])}">!</span>` : '') +
        `<span class="dg-filter" data-filter="${c.id}" title="Filter and sort">▾</span>` +
        `</span>` +
        `<span class="dg-grip" data-grip="${c.id}" title="Drag to resize, double-click to fit"></span>` +
        `</div>`
    }).join('')}`
  }

  private totalsRow(): string {
    const s = this.sheet
    if (!s.totals) return ''
    const n = rowCount(s)
    return `<div class="dg-cell dg-gutter"></div>` + `${cols(s).map((c, ci) => {
      const spec = s.totals?.[c.id]
      const fz = this.freeze(ci)
      if (!spec) return `<div class="dg-cell${fz.cls}" style="${fz.st}width:${c.w ?? 130}px"></div>`
      const data = s.data[c.id]
      const comp = this.computed.get(c.id)
      let acc = 0
      let seen = 0
      for (let i = 0; i < n; i++) {
        const v = comp ? comp[i] : readCell(data, i)
        if (typeof v !== 'number') continue
        seen++
        if (spec === 'min') acc = seen === 1 ? v : Math.min(acc, v)
        else if (spec === 'max') acc = seen === 1 ? v : Math.max(acc, v)
        else acc += v
      }
      const out = spec === 'avg' ? (seen ? acc / seen : 0) : spec === 'count' ? seen : acc
      return `<div class="dg-cell${fz.cls}" style="${fz.st}width:${c.w ?? 130}px;text-align:${alignFor(c.type)}">` +
        `<span class="dg-agg">${esc(String(spec))}</span> ${esc(formatValue(out, c))}</div>`
    }).join('')}`
  }

  /**
   * Rebuild the view order from the current filters and sorts.
   *
   * VIEW state: it writes `store.order`, which `store.view()` mutates without
   * a checkpoint — so filtering and sorting never dirty the file and never
   * produce an op. Formula columns are read through `computed`, so you can
   * sort by a calculated column that is nowhere in the document.
   */
  applyView(): void {
    const s = this.sheet
    const n = rowCount(s)
    const get = (col: string, row: number): unknown => {
      const comp = this.computed.get(col)
      return comp ? comp[row] : readCell(s.data[col], row)
    }
    const order = this.filters.length || this.sorts.length
      ? buildOrder(n, get, this.filters, this.sorts)
      : undefined
    this.store.view(() => { this.store.order[s.id] = order })
  }

  paint(): void {
    const s = this.sheet
    const all = rowCount(s)
    if (s.columns.some((c) => c.formula)) {
      // `now` is frozen from the document so TODAY() shows every reader the
      // same date rather than each reader's own
      const r = recalc(s, this.store.doc.modified)
      this.computed = r.values
      this.cycles = r.cycles
    } else if (this.computed.size) { this.computed = new Map(); this.cycles = [] }

    // Per-cell formulas, over CANONICAL positions.
    //
    // A1 addressing counts `s.columns` (every column, hidden included) and the
    // sheet's own row order — NOT the visible grid. Sorting and filtering are
    // view state (store.view()), so a formula must not change meaning when a
    // reader sorts: `=B4*1.2` names a cell in the document, and two people
    // looking at the same file through different sorts have to see the same
    // number. Hiding a column is document state but still editorial, and
    // renumbering every reference behind it would be a silent rewrite.
    this.cellValues = this.hasCellFormulas()
      ? recalcCells(this.cellSource(), this.store.doc.modified, this.columnVectors()).values
      : EMPTY_CELLS

    // Conditional formats are evaluated over the WHOLE column, not the painted
    // window: a colour scale needs the real min and max, and top-N needs every
    // candidate. Evaluating the ~40 visible rows would rescale the ramp on every
    // scroll — the same data would change colour as you moved.
    this.styles.clear()
    const rules = (s as unknown as { condfmt?: Record<string, unknown[]> }).condfmt
    if (rules) {
      for (const c of cols(s)) {
        const rs = rules[c.id]
        if (!Array.isArray(rs) || !rs.length) continue
        const comp = this.computed.get(c.id)
        const vals = Array.from({ length: all }, (_, i) => comp ? comp[i] : readCell(s.data[c.id], i))
        this.styles.set(c.id, evaluateRules(rs as never, vals))
      }
    }
    const order = this.store.order[s.id]
    const n = order ? order.length : all
    this.sel.resize(n, cols(s).length)
    this.table.style.height = `${n * ROW_H}px`

    // Only the visible slice exists. 100k x 6 would be 600,000 nodes, and that
    // — not the arithmetic — is what stops the browser.
    const top = Math.max(0, Math.floor(this.scroller.scrollTop / ROW_H) - OVERSCAN)
    const visible = Math.ceil(this.scroller.clientHeight / ROW_H) + OVERSCAN * 2
    const end = Math.min(n, top + visible)

    const body: string[] = []
    for (let i = top; i < end; i++) {
      const rid = ridAt(this.store, s, i)
      const r = dataRow(s, rid)
      const box = this.sel.bounds()
      const rowSelected = i >= box.top && i <= box.bottom
      body.push(`<div class="dg-row" data-rid="${rid}" data-row="${i}" style="top:${i * ROW_H}px">` +
        `<div class="dg-cell dg-gutter${rowSelected ? ' dg-gutter-on' : ''}" data-rowhead="${i}">${i + 1}</div>` +
        cols(s).map((c, ci) => {
          const over = s.cells?.[`${c.id}:${rid}`]
          const comp = this.computed.get(c.id)
          const fv = this.cellFormulaValue(r, c.id)
          const v = fv !== undefined ? fv
            : comp ? comp[r]
              : over && 'v' in over ? over.v
                : readCell(s.data[c.id], r)
          const note = over?.note ? ' dg-noted' : ''
          const bad = isErr(v) ? ' dg-err' : ''
          const inSel = this.sel.ranges().some((rg) => contains(rg, i, ci))
          const isCursor = this.sel.cursor.row === i && this.sel.cursor.col === ci
          const cf = this.styles.get(c.id)?.[r] ?? null
          let st = `width:${c.w ?? 130}px;text-align:${alignFor(c.type)}`
          if (cf?.bg) st += `;background:${cf.bg}`
          if (cf?.color) st += `;color:${cf.color}`
          if (cf?.bold) st += ';font-weight:600'
          const bar = cf?.bar
            ? `<span class="dg-bar" style="left:${bar0(cf)}%;width:${cf.bar.pct}%;background:${cf.bar.color}"></span>`
            : ''
          const shown = isErr(v) ? String(v) : formatValue(v, c)
          const fz = this.freeze(ci)
          return `<div class="dg-cell${note}${bad}${inSel ? ' dg-sel' : ''}${isCursor ? ' dg-cursor' : ''}${fz.cls}" ` +
            `data-col="${c.id}" data-ci="${ci}" style="${fz.st}${st}">${bar}<span class="dg-v">${esc(shown)}</span></div>`
        }).join('') + '</div>')
    }
    this.paintEmptyGrid()
    this.head.innerHTML = this.header()
    this.table.innerHTML = body.join('') + this.outline()
    this.foot.innerHTML = this.totalsRow()
    this.wire()
  }

  /**
   * Every column as a vector, under BOTH its id and its name.
   *
   * A cell formula has to be able to say `SUMIFS(value, region, "North")` —
   * naming columns is half of what makes one worth writing. Only the COMPUTED
   * columns were being passed, so every reference to an ordinary column was an
   * unknown name: `SUMIFS` then matched nothing and returned 0, `XLOOKUP` gave
   * #N/A, and a formula that mentioned no column at all (a PMT, say) worked
   * perfectly — which is exactly the pattern that makes this look like four
   * unrelated bugs instead of one.
   */
  private columnVectors(): Map<string, Vec> {
    const s = this.sheet
    const n = rowCount(s)
    const out = new Map<string, Vec>()
    const put = (k: string, v: Vec) => { out.set(k, v); out.set(k.toLowerCase(), v) }
    for (const c of s.columns) {
      const comp = this.computed.get(c.id)
      const v = comp ?? Array.from({ length: n }, (_, i) => readCell(s.data[c.id], i) as never)
      put(c.id, v)
      put(c.name, v)
    }
    return out
  }

  /** The formula stored at a canonical position, if any. */
  private formulaAtPos(row: number, col: number): string | undefined {
    const s = this.sheet
    const c = s.columns[col]
    if (!c) return undefined
    const rid = ridForDataRow(s, row)
    const f = s.cells?.[`${c.id}:${rid}`]?.f
    return typeof f === 'string' && f !== '' ? f : undefined
  }

  private hasCellFormulas(): boolean {
    const cells = this.sheet.cells
    if (!cells) return false
    for (const k in cells) if (typeof cells[k]?.f === 'string') return true
    return false
  }

  /** The sheet as a plain grid of positions, which is all cellformula.ts wants. */
  private cellSource(): CellSource {
    const s = this.sheet
    return {
      rows: rowCount(s),
      cols: s.columns.length,
      formulaAt: (r, c) => this.formulaAtPos(r, c),
      valueAt: (r, c) => {
        const col = s.columns[c]
        if (!col) return null
        const rid = ridForDataRow(s, r)
        const over = s.cells?.[`${col.id}:${rid}`]
        if (over && 'v' in over) return over.v as never
        const comp = this.computed.get(col.id)
        return (comp ? comp[r] : readCell(s.data[col.id], r)) as never
      },
    }
  }

  /** The computed value of a cell formula at a canonical position, if it has one. */
  private cellFormulaValue(row: number, colId: string): unknown {
    if (this.cellValues === EMPTY_CELLS) return undefined
    const ci = this.sheet.columns.findIndex((c) => c.id === colId)
    if (ci < 0) return undefined
    const k = cellKey(row, ci)
    return this.cellValues.has(k) ? this.cellValues.get(k) : undefined
  }

  /**
   * Rule the EMPTY space past the last row and the last column.
   *
   * A spreadsheet's grid does not stop where the data stops — Excel and Sheets
   * both rule the whole window, and that continuing lattice is a good part of
   * what makes a grid read as a sheet rather than as a table someone put on a
   * web page. dash drew rows only where rows existed, so an eight-row workbook
   * ended in a large white rectangle.
   *
   * Painted as a BACKGROUND on the scrolling element rather than as filler
   * rows: empty rows would be real DOM, would have to be virtualised, and would
   * be selectable and editable — a grid you can type into a thousand rows below
   * your data is a different product decision, and not one to make by accident.
   * The background costs nothing and cannot be clicked.
   *
   * It lives on `.dg-table`, which scrolls WITH the content, so the lines stay
   * aligned to the rows. `background-position` steps it down past the header,
   * which is in normal flow above the sizer.
   */
  private paintEmptyGrid(): void {
    const vis = cols(this.sheet)
    const line = 'var(--grid-line, #edf0f4)'
    // vertical rules at each column boundary, starting after the gutter
    const stops: string[] = []
    let x = GUTTER_W
    stops.push(`transparent 0 ${x - 1}px`, `${line} ${x - 1}px ${x}px`)
    for (const c of vis) {
      const w = c.w ?? 130
      stops.push(`transparent ${x}px ${x + w - 1}px`, `${line} ${x + w - 1}px ${x + w}px`)
      x += w
    }
    const headH = ROW_H + 20
    this.table.parentElement!.style.backgroundImage =
      `repeating-linear-gradient(to bottom, transparent 0 ${ROW_H - 1}px, ${line} ${ROW_H - 1}px ${ROW_H}px),` +
      `linear-gradient(to right, ${stops.join(',')}, transparent ${x}px)`
    this.table.parentElement!.style.backgroundPosition = `0 ${headH}px, 0 0`
    // The ruled area is exactly as WIDE as the sheet. Excel rules to the window
    // edge because its columns go on forever; dash's do not, and ruling past
    // the last one draws cells that cannot be typed into. So the row rules tile
    // down within the sheet's width and stop, and past the final column is
    // plain background — which is the truthful answer to "is there anything
    // over there".
    this.table.parentElement!.style.backgroundSize = `${x}px auto, auto auto`
    this.table.parentElement!.style.backgroundRepeat = 'repeat-y, repeat-y'
  }

  /** Value at a VISIBLE position — what the clipboard and the status bar read. */
  private valueAt(row: number, ci: number): unknown {
    const s = this.sheet
    const c = cols(s)[ci]
    if (!c) return null
    const rid = ridAt(this.store, s, row)
    const r = dataRow(s, rid)
    const fv = this.cellFormulaValue(r, c.id)
    if (fv !== undefined) return fv
    const over = s.cells?.[`${c.id}:${rid}`]
    if (over && 'v' in over) return over.v
    const comp = this.computed.get(c.id)
    return comp ? comp[r] : readCell(s.data[c.id], r)
  }

  /** Write a block of values starting at a visible position. One undo step. */
  private writeBlock(row: number, ci: number, block: unknown[][], extra: Patch[] = []): void {
    const s = this.sheet
    const vis = cols(s)
    const patches: Patch[] = [...extra]
    const byCol = new Map<string, { rids: number[]; v: unknown[] }>()
    block.forEach((line, dr) => {
      line.forEach((val, dc) => {
        const c = vis[ci + dc]
        if (!c || c.formula) return          // a computed column is defined by
        const rid = ridAt(this.store, s, row + dr)  // its expression, not by a paste
        if (rid < 0) return
        const e = byCol.get(c.id) ?? { rids: [], v: [] }
        e.rids.push(rid); e.v.push(val)
        byCol.set(c.id, e)
      })
    })
    for (const [col, e] of byCol) patches.push({ op: 'setCells', sheet: s.id, col, rids: e.rids, v: e.v })
    if (patches.length) this.store.commit(patches)
  }

  /** Clear every selected cell — one undo step, formula COLUMNS untouched. */
  clearSelection(): void {
    const s = this.sheet
    const b = this.sel.bounds()
    const block: unknown[][] = []
    for (let r = b.top; r <= b.bottom; r++) block.push(new Array(b.right - b.left + 1).fill(null))
    // Clearing a cell has to drop its FORMULA too, not just blank the stored
    // value underneath it. Writing nulls alone left the formula in place and it
    // simply recomputed, so a cut appeared to do nothing and Delete on a
    // formula cell was a no-op.
    const keys: string[] = []
    const overs: Array<Record<string, unknown> | null> = []
    const vis = cols(s)
    for (let r = b.top; r <= b.bottom; r++) {
      for (let c = b.left; c <= b.right; c++) {
        const col = vis[c]
        if (!col) continue
        const rid = ridAt(this.store, s, r)
        const key = `${col.id}:${rid}`
        const had = s.cells?.[key]
        if (had?.f === undefined) continue
        const { f: _f, ...rest } = had
        keys.push(key)
        overs.push(Object.keys(rest).length ? rest : null)
      }
    }
    // ONE commit, so one ⌘Z puts back both the values and the formulas.
    this.writeBlock(b.top, b.left, block, keys.length
      ? [{ op: 'setOverrides', sheet: s.id, keys, v: overs as never, dropEmpty: true }]
      : [])
  }

  /** Write the formula bar's contents into the active cell. */
  setActiveCell(text: string): void {
    const s = this.sheet
    const c = cols(s)[this.sel.cursor.col]
    if (!c || this.store.readOnly) return
    const rid = ridAt(this.store, s, this.sel.cursor.row)
    if (rid < 0) return
    if (text.trim().startsWith('=')) {
      // a leading = in the formula bar sets the COLUMN's expression: dash's
      // formulas are per column, so this is the honest place for it to land
      this.store.commit({ op: 'setColumn', sheet: s.id, col: c.id, patch: { formula: text.trim().slice(1).trim() } })
      return
    }
    if (c.formula) return  // typing a value over a computed column would be
    this.writeBlock(this.sel.cursor.row, this.sel.cursor.col, [[coerceForColumn(text, c.type)]])
  }

  /**
   * The clip this grid last copied — formulas and all.
   *
   * The SYSTEM clipboard carries values, because that is what every other
   * application expects to receive: paste into Numbers or a mail message and
   * `=D1*3` is not useful there, £37,200 is. But pasting back into a
   * spreadsheet has to preserve the formula, so the copy is remembered here and
   * a paste whose text still MATCHES what we wrote is recognised as our own.
   * That is how Excel and Sheets behave, and the text comparison is what makes
   * it honest: copy something else in between and the match fails, so a stale
   * internal clip can never be pasted in place of what the user actually
   * copied.
   */
  private clip: {
    tsv: string
    block: Array<Array<{ v: unknown; f?: string }>>
    /** a CUT, not a copy — see writeClip for why that changes the answer */
    cut?: boolean
  } | null = null

  copyTsv(): string {
    const b = this.sel.bounds()
    const tsv = tsvFromRange((r, c) => this.valueAt(r, c),
      { anchor: { row: b.top, col: b.left }, head: { row: b.bottom, col: b.right } } as Range)
    const s = this.sheet
    const block: Array<Array<{ v: unknown; f?: string }>> = []
    for (let r = b.top; r <= b.bottom; r++) {
      const line: Array<{ v: unknown; f?: string }> = []
      for (let c = b.left; c <= b.right; c++) {
        const col = cols(s)[c]
        const dr = dataRow(s, ridAt(this.store, s, r))
        line.push({
          v: this.valueAt(r, c),
          f: col ? this.formulaAtPos(dr, s.columns.findIndex((x) => x.id === col.id)) : undefined,
        })
      }
      block.push(line)
    }
    this.clip = { tsv, block }
    this.clipTop = dataRow(s, ridAt(this.store, s, b.top))
    this.clipLeft = s.columns.findIndex((x) => x.id === cols(s)[b.left]?.id)
    return tsv
  }

  pasteTsv(text: string): void {
    const cur = this.sel.cursor
    // our own clip, still intact on the system clipboard? then formulas ride
    // along, TRANSLATED by how far the block moved
    if (this.clip && this.clip.tsv === text) {
      this.writeClip(cur.row, cur.col, this.clip.block)
      return
    }
    const grid = parseTsv(text)
    if (!grid.length) return
    this.writeBlock(cur.row, cur.col, grid)
  }

  /**
   * Paste a remembered block, translating each formula by the offset it moved.
   *
   * The offset is measured in CANONICAL positions, not visible ones: A1
   * addresses name the document, so a block copied and pasted while a sort is
   * on must shift by the distance the cells actually moved, not by the distance
   * they appear to have moved.
   */
  private writeClip(
    row: number, ci: number, block: Array<Array<{ v: unknown; f?: string }>>,
  ): void {
    const s = this.sheet
    const vis = cols(s)
    const srcTop = this.clipTop ?? row
    const srcLeft = this.clipLeft ?? ci
    const cut = this.clip?.cut === true
    const patches: Patch[] = []
    const byCol = new Map<string, { rids: number[]; v: unknown[] }>()
    const keys: string[] = []
    const overs: Array<Record<string, unknown> | null> = []
    block.forEach((line, dr) => {
      line.forEach((cellv, dc) => {
        const c = vis[ci + dc]
        if (!c || c.formula) return
        const rid = ridAt(this.store, s, row + dr)
        if (rid < 0) return
        const key = `${c.id}:${rid}`
        if (cellv.f !== undefined) {
          // A CUT does not translate. Copying makes a second formula that
          // should mean the same thing in its new place, so its references
          // move; cutting moves the ONE formula, and a formula that travels
          // with its cells still means exactly what it did. Excel agrees, and
          // getting this backwards silently re-points a moved formula at the
          // wrong data.
          //
          // NOT DONE, and a real limitation: formulas ELSEWHERE that referenced
          // the cut cells should follow them to the new location. They do not —
          // they keep pointing at the old, now-empty positions.
          const dRow = cut ? 0 : dataRow(s, rid) - (srcTop + dr)
          const dColIdx = cut ? 0 : s.columns.findIndex((x) => x.id === c.id) - (srcLeft + dc)
          keys.push(key)
          overs.push({ ...(s.cells?.[key] ?? {}), f: translateCellFormula(cellv.f, dRow, dColIdx) })
        } else {
          const e = byCol.get(c.id) ?? { rids: [], v: [] }
          e.rids.push(rid); e.v.push(cellv.v)
          byCol.set(c.id, e)
          // pasting a plain value over a formula cell must REMOVE the formula
          const had = s.cells?.[key]
          if (had?.f !== undefined) {
            const { f: _f, ...rest } = had
            keys.push(key)
            overs.push(Object.keys(rest).length ? rest : null)
          }
        }
      })
    })
    for (const [col, e] of byCol) patches.push({ op: 'setCells', sheet: s.id, col, rids: e.rids, v: e.v })
    if (keys.length) {
      patches.push({ op: 'setOverrides', sheet: s.id, keys, v: overs as never, dropEmpty: true })
    }
    if (patches.length) this.store.commit(patches)
  }

  /** Canonical top-left of the remembered clip, for measuring the paste offset. */
  private clipTop: number | null = null
  private clipLeft: number | null = null

  /** Fill the selection down from its first row, continuing a series if there is one. */
  fillDownSelection(): void {
    const b = this.sel.bounds()
    if (b.bottom <= b.top) return
    const block: unknown[][] = []
    for (let c = b.left; c <= b.right; c++) {
      const seeds = [this.valueAt(b.top, c)]
      if (b.bottom - b.top >= 1) seeds.push(this.valueAt(b.top + 1, c))
      const filled = fillSeries(seeds, b.bottom - b.top + 1)
      filled.forEach((v, i) => { (block[i] ??= [])[c - b.left] = v })
    }
    this.writeBlock(b.top, b.left, block)
  }

  /** Tell the app what is selected, for the formula bar and the status bar. */
  private announce(): void {
    if (!this.onSelectionChange) return
    const s = this.sheet
    const vis = cols(s)
    const cur = this.sel.cursor
    const c = vis[cur.col]
    const ref = c ? `${colToLetters(cur.col)}${cur.row + 1}` : ''
    const v = this.valueAt(cur.row, cur.col)
    const raw = v == null ? '' : isErr(v) ? String(v) : String(v)
    const b = this.sel.bounds()
    let summary = ''
    if (b.bottom > b.top || b.right > b.left) {
      // the status-bar aggregate people select cells specifically to see
      const nums: number[] = []
      for (let r = b.top; r <= b.bottom; r++) {
        for (let cc = b.left; cc <= b.right; cc++) {
          const x = this.valueAt(r, cc)
          if (typeof x === 'number' && Number.isFinite(x)) nums.push(x)
        }
      }
      const cells = (b.bottom - b.top + 1) * (b.right - b.left + 1)
      summary = nums.length
        ? `Sum ${fmtNum(nums.reduce((a, x) => a + x, 0))}  ·  Avg ${fmtNum(nums.reduce((a, x) => a + x, 0) / nums.length)}  ·  Count ${nums.length}  ·  Cells ${cells}`
        : `Cells ${cells}`
    }
    // The formula bar shows the SOURCE when there is one — a per-cell formula
    // first, then the column's expression, then the value. A bar that shows the
    // computed number for a formula cell is the one place a spreadsheet user
    // looks to find out whether a number was typed or derived.
    const cellSrc = c
      ? this.formulaAtPos(dataRow(s, ridAt(this.store, s, cur.row)),
          s.columns.findIndex((x) => x.id === c.id))
      : undefined
    this.onSelectionChange(summary, ref,
      cellSrc !== undefined ? cellSrc : c?.formula ? `= ${c.formula}` : raw)
  }

  /** The full keyboard set, routed through select.ts's typed actions. */
  handleKey(e: KeyboardEvent): boolean {
    if (this.editing) return false
    const a = keyToAction(e)
    if (!a) return false
    if (a.kind === 'edit') return this.editActive()
    if (a.kind === 'clear') { this.clearSelection(); return true }
    if (a.kind === 'copy' || a.kind === 'cut') {
      void navigator.clipboard?.writeText(this.copyTsv())
      if (a.kind === 'cut') { if (this.clip) this.clip.cut = true; this.clearSelection() }
      return true
    }
    if (a.kind === 'paste') return false          // the document paste listener has the data
    if (a.kind === 'undo') { this.store.undo(); return true }
    if (a.kind === 'redo') { this.store.redo(); return true }

    const moved = applyMotion(this.sel, a, {
      page: Math.max(1, Math.floor(this.scroller.clientHeight / ROW_H) - 1),
      filled: (row, col) => {
        const v = this.valueAt(row, col)
        return v != null && v !== ''
      },
    })
    if (!moved) return false
    this.scrollIntoView()
    this.paint()
    this.announce()
    return true
  }

  private cellEl(row: number, ci: number): HTMLElement | null {
    return this.table.querySelector<HTMLElement>(`.dg-row[data-row="${row}"] .dg-cell[data-ci="${ci}"]`)
  }

  private scrollIntoView(): void {
    const y = this.sel.cursor.row * ROW_H
    const top = this.scroller.scrollTop
    const h = this.scroller.clientHeight - ROW_H * 2
    if (y < top) this.scroller.scrollTop = y
    else if (y + ROW_H > top + h) this.scroller.scrollTop = y + ROW_H - h
  }

  /**
   * The selection's outline and its fill handle, as ONE absolutely-positioned
   * box over the rows.
   *
   * A per-cell tint alone does not read as a selection — the eye needs the
   * rectangle. And the handle is how a spreadsheet user expects to fill: not a
   * menu item, a square in the corner you drag.
   */
  private outline(): string {
    const b = this.sel.bounds()
    const vis = cols(this.sheet)
    if (!vis.length) return ''
    const w = (i: number) => vis[i]?.w ?? 130
    let left = GUTTER_W
    for (let i = 0; i < b.left; i++) left += w(i)
    let width = 0
    for (let i = b.left; i <= b.right && i < vis.length; i++) width += w(i)
    const top = b.top * ROW_H
    const height = (b.bottom - b.top + 1) * ROW_H
    return `<div class="dg-outline" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px">` +
      `<span class="dg-handle" title="Drag to fill"></span></div>`
  }

  private wire(): void {
    // the fill handle: drag down to extend the selection and fill it
    const handle = this.table.querySelector<HTMLElement>('.dg-handle')
    if (handle) {
      handle.onmousedown = (e) => {
        e.preventDefault(); e.stopPropagation()
        const start = this.sel.bounds()
        const move = (m: MouseEvent) => {
          const t = (m.target as HTMLElement)?.closest?.('.dg-row[data-row]') as HTMLElement | null
          if (!t) return
          const r2 = Number(t.dataset.row)
          if (Number.isFinite(r2) && r2 >= start.top) {
            this.sel.moveTo(start.top, start.left)
            this.sel.extendTo(r2, start.right)
            this.paint()
          }
        }
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          this.fillDownSelection()
          this.announce()
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }
    }
    this.head.querySelectorAll<HTMLElement>('.dg-name').forEach((el) => {
      el.onclick = () => {
        const col = el.closest<HTMLElement>('[data-col]')?.dataset.col
        if (col) this.toggleSort(col)
      }
    })
    // select a whole column by its letter, the whole sheet by the corner
    this.head.querySelectorAll<HTMLElement>('.dg-letter').forEach((el) => {
      el.onclick = () => {
        // `closest`, not `parentElement`: the letter sits inside a strip now,
        // and reading `ci` off the immediate parent gave NaN the moment the
        // header grew a second line.
        const ci = Number(el.closest<HTMLElement>('[data-ci]')?.dataset.ci)
        if (!Number.isFinite(ci)) return
        this.sel.selectCol(ci)
        this.paint(); this.announce()
      }
    })
    const corner = this.head.querySelector<HTMLElement>('.dg-corner')
    if (corner) corner.onclick = () => { this.sel.selectAll(); this.paint(); this.announce() }
    // filter caret
    this.head.querySelectorAll<HTMLElement>('[data-filter]').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation()
        const r = el.getBoundingClientRect()
        this.onFilterMenu?.(el.dataset.filter!, r.left, r.bottom)
      }
    })
    // column resize: drag the grip, double-click to fit the content
    this.head.querySelectorAll<HTMLElement>('[data-grip]').forEach((el) => {
      const id = el.dataset.grip!
      el.onmousedown = (e) => {
        e.preventDefault(); e.stopPropagation()
        const col = this.sheet.columns.find((c) => c.id === id)!
        const startX = e.clientX
        const startW = col.w ?? 130
        const cell = el.parentElement as HTMLElement
        const move = (m: MouseEvent) => {
          // live width during the drag, committed once on release — a commit
          // per mousemove would be one undo entry per pixel
          const w = Math.max(48, Math.round(startW + m.clientX - startX))
          cell.style.width = `${w}px`
          this.table.querySelectorAll<HTMLElement>(`.dg-cell[data-col="${id}"]`)
            .forEach((c) => { c.style.width = `${w}px` })
        }
        const up = (m: MouseEvent) => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          const w = Math.max(48, Math.round(startW + m.clientX - startX))
          if (w !== startW) this.store.commit(resizeColumn(this.sheet, id, w))
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }
      el.ondblclick = (e) => {
        e.stopPropagation()
        const s2 = this.sheet
        const col = s2.columns.find((c) => c.id === id)!
        const comp = this.computed.get(id)
        const w = autoFitWidth(
          (row) => comp ? comp[row] : readCell(s2.data[id], row),
          col, rowCount(s2))
        this.store.commit(resizeColumn(s2, id, w))
      }
    })
    // row header selects the row
    this.table.querySelectorAll<HTMLElement>('[data-rowhead]').forEach((el) => {
      el.onmousedown = () => {
        this.sel.selectRow(Number(el.dataset.rowhead))
        this.paint(); this.announce()
      }
    })
    this.head.querySelectorAll<HTMLElement>('[data-retype]').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation()
        const col = this.sheet.columns.find((c) => c.id === el.dataset.retype)
        const r = el.getBoundingClientRect()
        if (col) this.onRetype?.(col, r.left, r.bottom)
      }
    })
    this.table.querySelectorAll<HTMLElement>('.dg-row[data-rid] .dg-cell[data-ci]').forEach((el) => {
      const row = Number(el.parentElement!.dataset.row)
      const ci = Number(el.dataset.ci)
      el.onmousedown = (e) => {
        if (e.button !== 0) return
        if (e.shiftKey) this.sel.extendTo(row, ci)
        else this.sel.moveTo(row, ci)
        this.paint(); this.announce()
        // drag to extend
        const move = (m: MouseEvent) => {
          const t = (m.target as HTMLElement)?.closest?.('.dg-cell[data-ci]') as HTMLElement | null
          if (!t) return
          const r2 = Number(t.parentElement!.dataset.row)
          const c2 = Number(t.dataset.ci)
          if (Number.isFinite(r2) && Number.isFinite(c2)) {
            this.sel.extendTo(r2, c2); this.paint(); this.announce()
          }
        }
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }
      el.oncontextmenu = (e) => {
        e.preventDefault()
        if (!this.sel.ranges().some((rg) => contains(rg, row, ci))) {
          this.sel.moveTo(row, ci); this.paint()
        }
        this.onContextMenu?.(row, ci, e.clientX, e.clientY)
      }
      el.ondblclick = () => this.edit(Number(el.parentElement!.dataset.rid), el.dataset.col!, el)
    })
  }

  /**
   * Sorting is VIEW state. It sorts the order vector and never the data, so it
   * takes no checkpoint, sets no dirty flag and produces no op.
   */
  private toggleSort(colId: string): void {
    const dir = this.sort?.col === colId && this.sort.dir === 'asc' ? 'desc' : 'asc'
    this.sort = { col: colId, dir }
    // Shift-click accumulates keys; a plain click replaces them. filter.ts's
    // buildOrder does the multi-key comparison and sinks blanks in BOTH
    // directions, which the hand-rolled single-key sort here did not.
    this.sorts = [{ col: colId, dir }]
    this.applyView()
  }

  /** Add or replace a sort key without clearing the others — shift-click. */
  addSort(colId: string, dir: 'asc' | 'desc'): void {
    this.sorts = this.sorts.filter((k) => k.col !== colId).concat({ col: colId, dir })
    this.sort = { col: colId, dir }
    this.applyView()
  }

  setFilter(colId: string, f: ColumnFilter | null): void {
    this.filters = this.filters.filter((x) => x.col !== colId)
    if (f) this.filters.push(f)
    this.applyView()
  }

  clearView(): void { this.filters = []; this.sorts = []; this.sort = null; this.applyView() }

  /**
   * Open a cell for editing.
   *
   * `seed` is the character that STARTED the edit. Typing over a selected cell
   * replaces its contents in every spreadsheet ever made — it is the single
   * most-used interaction in the whole application, and requiring a
   * double-click first is the difference between "a grid" and "a spreadsheet".
   * When seed is undefined the existing value is loaded and selected, which is
   * what F2 and a double-click do instead.
   */
  private edit(rid: number, colId: string, cell: HTMLElement, seed?: string): void {
    const s = this.sheet
    const col = s.columns.find((c) => c.id === colId)
    if (!col || this.store.readOnly) return
    // a computed column is defined by its expression; typing over one cell
    // would be a value the formula immediately contradicts
    if (col.formula) { this.onEditFormula?.(col); return }
    this.editing = { rid, col: colId }
    const r = dataRow(s, rid)
    const raw = readCell(s.data[colId], r)
    cell.classList.add('dg-editing')
    cell.contentEditable = 'true'
    // A formula cell edits its SOURCE. Showing the computed value would make
    // every edit of a formula silently replace it with its own last result —
    // the cell would look unchanged and the formula would be gone.
    const src = this.formulaAtPos(dataRow(s, rid), s.columns.findIndex((c) => c.id === colId))
    cell.textContent = seed !== undefined ? seed
      : src !== undefined ? src
        : (raw == null ? '' : String(raw))
    cell.focus()
    const range = document.createRange()
    range.selectNodeContents(cell)
    if (seed !== undefined) range.collapse(false)   // caret AFTER the typed char
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)

    let done = false
    const finish = (write: boolean, move?: 'down' | 'up' | 'right' | 'left') => {
      if (done || !this.editing) return
      done = true
      this.editing = null
      const text = cell.textContent ?? ''
      cell.contentEditable = 'false'
      cell.classList.remove('dg-editing')
      cell.onblur = null
      if (write) {
        const key = `${colId}:${rid}`
        const had = s.cells?.[key]
        if (isFormula(text)) {
          // A formula rides on the cell OVERRIDE (`CellOverride.f`), which the
          // format reserved for exactly this. The stored value is left alone:
          // the document holds the expression and the number is derived, so a
          // file can never carry a result that disagrees with its own formula.
          this.store.runEdit(key, {
            op: 'setOverrides', sheet: s.id, keys: [key], v: [{ ...had, f: text }],
          })
        } else {
          const v = coerceForColumn(text, col.type)
          const patches: Patch[] = [
            { op: 'setCells', sheet: s.id, col: colId, rids: [rid], v: [v] },
          ]
          // Typing over a formula REMOVES it. Leaving `f` in place would show
          // the typed number for one paint and then quietly recompute over it.
          if (had?.f !== undefined) {
            const { f: _f, ...rest } = had
            patches.push({
              op: 'setOverrides', sheet: s.id, keys: [key],
              v: [Object.keys(rest).length ? rest : null], dropEmpty: true,
            })
          }
          this.store.runEdit(key, patches)
        }
        this.store.endRun()
      }
      // COMMIT AND MOVE. Enter goes down, Tab goes right — a spreadsheet that
      // leaves the cursor where it was makes you reach for the mouse between
      // every value, which is most of what data entry is.
      if (move) {
        const d = move === 'down' ? [1, 0] : move === 'up' ? [-1, 0] : move === 'right' ? [0, 1] : [0, -1]
        this.sel.move(d[0], d[1], {})
        this.scrollIntoView()
      }
      this.paint()
      this.announce()
      this.focusGrid()
    }
    cell.onblur = () => finish(true)
    cell.onkeydown = (e) => {
      // stopPropagation on EVERY branch, including the ones that close the
      // editor. finish() clears contentEditable synchronously, so by the time
      // the event reaches the document the "is something being edited?" guard
      // there no longer sees an editor — and Enter moved the cursor twice.
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); finish(true, e.shiftKey ? 'up' : 'down'); return }
      if (e.key === 'Tab') { e.preventDefault(); finish(true, e.shiftKey ? 'left' : 'right'); return }
      if (e.key === 'Escape') { e.preventDefault(); finish(false) }
    }
  }

  /** Keep keystrokes coming to the grid after an edit closes. */
  private focusGrid(): void {
    if (this.scroller.tabIndex < 0) this.scroller.tabIndex = 0
    this.scroller.focus({ preventScroll: true })
  }

  /**
   * A printable key over a selected cell starts an edit with that character.
   * Called from the app's keydown handler BEFORE keyToAction, because
   * keyToAction deliberately returns null for bare printable keys so that
   * typing can reach exactly here.
   */
  typeInto(ch: string): boolean {
    if (this.editing || this.store.readOnly) return false
    const vis = cols(this.sheet)
    const col = vis[this.sel.cursor.col]
    if (!col) return false
    const rid = ridAt(this.store, this.sheet, this.sel.cursor.row)
    if (rid < 0) return false
    const cell = this.cellEl(this.sel.cursor.row, this.sel.cursor.col)
    if (!cell) return false
    this.edit(rid, col.id, cell, ch)
    return true
  }

  /** F2 / double-click: edit the existing value rather than replacing it. */
  editActive(): boolean {
    if (this.editing) return false
    const vis = cols(this.sheet)
    const col = vis[this.sel.cursor.col]
    const rid = ridAt(this.store, this.sheet, this.sel.cursor.row)
    const cell = this.cellEl(this.sel.cursor.row, this.sel.cursor.col)
    if (!col || rid < 0 || !cell) return false
    this.edit(rid, col.id, cell)
    return true
  }
}

/** What the user typed, under the column's declared type. */
function coerceForColumn(text: string, type: ColumnType): unknown {
  const s = text.trim()
  if (s === '') return null
  if (type === 'number' || type === 'money' || type === 'percent') {
    const n = Number(s.replace(/[,\s£$€¥%]/g, ''))
    if (!Number.isFinite(n)) return s        // keep what they typed rather than
    return type === 'percent' && s.includes('%') ? n / 100 : n  // silently zeroing
  }
  if (type === 'bool') return /^(y|yes|true|1|✓)$/i.test(s)
  return s
}

/** Where a data bar starts, as a percentage — negatives run left of the axis. */
const bar0 = (cf: CellStyle): number =>
  cf.bar ? (cf.bar.negative ? Math.max(0, (cf.bar as { axis?: number }).axis ?? 0) - cf.bar.pct : (cf.bar as { axis?: number }).axis ?? 0) : 0

const fmtNum = (n: number): string =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n)

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
