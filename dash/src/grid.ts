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
import { readCell, type Store } from './store.ts'

const ROW_H = 30
const OVERSCAN = 8

export interface GridHost {
  el: HTMLElement
  store: Store
  sheetId: string
}

const cols = (s: TableSheet) => s.columns
const rowCount = (s: TableSheet) => s.rids.reduce((n, [, c]) => n + c, 0)

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
  /** set by the app so a type change can be routed through one place */
  onRetype?: (col: Column) => void

  constructor(opts: GridHost) {
    this.host = opts.el
    this.store = opts.store
    this.sheetId = opts.sheetId
    this.build()
    this.store.on('doc', () => this.paint())
    this.store.on('view', () => this.paint())
  }

  /** Point the grid at a different sheet — an import adds one and shows it. */
  setSheet(id: string): void {
    this.sheetId = id
    this.sort = null
    this.scroller.scrollTop = 0
    this.paint()
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
    this.scroller = this.host.querySelector('.dg-scroll')!
    this.table = this.host.querySelector('.dg-sizer')!
    this.head = this.host.querySelector('.dg-head-row')!
    this.foot = this.host.querySelector('.dg-foot-row')!
    this.scroller.addEventListener('scroll', () => this.paint(), { passive: true })
    this.paint()
  }

  /** Header: name, a type control, and a sort affordance. */
  private header(): string {
    const s = this.sheet
    return `${cols(s).map((c) => {
      const arrow = this.sort?.col === c.id ? (this.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''
      return `<div class="dg-cell dg-h" style="width:${c.w ?? 130}px" data-col="${c.id}">` +
        `<span class="dg-name" title="${esc(c.name)}">${esc(c.name)}${arrow}</span>` +
        `<button class="dg-type" data-retype="${c.id}" title="${esc(TYPE_LABEL[c.type])} — click to change">${esc(TYPE_LABEL[c.type])}</button>` +
        (c.failed ? `<span class="dg-warn" title="${c.failed} value(s) could not be read as ${esc(TYPE_LABEL[c.type])}">!</span>` : '') +
        `</div>`
    }).join('')}`
  }

  private totalsRow(): string {
    const s = this.sheet
    if (!s.totals) return ''
    const n = rowCount(s)
    return `${cols(s).map((c) => {
      const spec = s.totals?.[c.id]
      if (!spec) return `<div class="dg-cell" style="width:${c.w ?? 130}px"></div>`
      const data = s.data[c.id]
      let acc = 0
      let seen = 0
      for (let i = 0; i < n; i++) {
        const v = readCell(data, i)
        if (typeof v !== 'number') continue
        seen++
        if (spec === 'min') acc = seen === 1 ? v : Math.min(acc, v)
        else if (spec === 'max') acc = seen === 1 ? v : Math.max(acc, v)
        else acc += v
      }
      const out = spec === 'avg' ? (seen ? acc / seen : 0) : spec === 'count' ? seen : acc
      return `<div class="dg-cell" style="width:${c.w ?? 130}px;text-align:${alignFor(c.type)}">` +
        `<span class="dg-agg">${esc(String(spec))}</span> ${esc(formatValue(out, c))}</div>`
    }).join('')}`
  }

  paint(): void {
    const s = this.sheet
    const n = rowCount(s)
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
      body.push(`<div class="dg-row" data-rid="${rid}" style="top:${i * ROW_H}px">` +
        cols(s).map((c) => {
          const over = s.cells?.[`${c.id}:${rid}`]
          const v = over && 'v' in over ? over.v : readCell(s.data[c.id], r)
          const note = over?.note ? ' dg-noted' : ''
          return `<div class="dg-cell${note}" data-col="${c.id}" ` +
            `style="width:${c.w ?? 130}px;text-align:${alignFor(c.type)}">${esc(formatValue(v, c))}</div>`
        }).join('') + '</div>')
    }
    this.head.innerHTML = this.header()
    this.table.innerHTML = body.join('')
    this.foot.innerHTML = this.totalsRow()
    this.wire()
  }

  private wire(): void {
    this.head.querySelectorAll<HTMLElement>('.dg-name').forEach((el) => {
      el.onclick = () => this.toggleSort(el.parentElement!.dataset.col!)
    })
    this.head.querySelectorAll<HTMLElement>('[data-retype]').forEach((el) => {
      el.onclick = (e) => {
        e.stopPropagation()
        const col = this.sheet.columns.find((c) => c.id === el.dataset.retype)
        if (col) this.onRetype?.(col)
      }
    })
    this.table.querySelectorAll<HTMLElement>('.dg-row[data-rid] .dg-cell').forEach((el) => {
      el.ondblclick = () => this.edit(Number(el.parentElement!.dataset.rid), el.dataset.col!, el)
    })
  }

  /**
   * Sorting is VIEW state. It sorts the order vector and never the data, so it
   * takes no checkpoint, sets no dirty flag and produces no op.
   */
  private toggleSort(colId: string): void {
    const s = this.sheet
    const dir = this.sort?.col === colId && this.sort.dir === 'asc' ? 'desc' : 'asc'
    this.sort = { col: colId, dir }
    const n = rowCount(s)
    const data = s.data[colId]
    const idx = Array.from({ length: n }, (_, i) => i)
    const sign = dir === 'asc' ? 1 : -1
    idx.sort((a, b) => {
      const x = readCell(data, a)
      const y = readCell(data, b)
      if (x == null) return 1        // blanks sink, both directions — a blank is
      if (y == null) return -1       // not "smallest", it is "not a value"
      return x < y ? -sign : x > y ? sign : 0
    })
    this.store.view(() => { this.store.order[s.id] = idx })
  }

  private edit(rid: number, colId: string, cell: HTMLElement): void {
    const s = this.sheet
    const col = s.columns.find((c) => c.id === colId)
    if (!col || this.store.readOnly) return
    this.editing = { rid, col: colId }
    const r = dataRow(s, rid)
    const raw = readCell(s.data[colId], r)
    cell.classList.add('dg-editing')
    cell.contentEditable = 'true'
    cell.textContent = raw == null ? '' : String(raw)
    cell.focus()
    const range = document.createRange()
    range.selectNodeContents(cell)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)

    const commit = () => {
      if (!this.editing) return
      this.editing = null
      cell.contentEditable = 'false'
      cell.classList.remove('dg-editing')
      const text = cell.textContent ?? ''
      const v = coerceForColumn(text, col.type)
      this.store.runEdit(`${colId}:${rid}`, {
        op: 'setCells', sheet: s.id, col: colId, rids: [rid], v: [v],
      })
      this.store.endRun()
    }
    cell.onblur = commit
    cell.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); return }
      if (e.key === 'Escape') {
        e.preventDefault()
        this.editing = null
        cell.contentEditable = 'false'
        cell.classList.remove('dg-editing')
        this.paint()
      }
    }
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

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
