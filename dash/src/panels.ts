// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The side panels: sheets on the left, properties on the right.
//
// THIS IS SLIDES' CHROME, DELIBERATELY. Two Bento apps that lay themselves out
// differently read as two products, so the geometry here is copied rather than
// reinvented: 11px uppercase section headers, 12.5px rows with the control
// right-aligned at a fixed width, an accordion whose open state is remembered
// per section TITLE, 5px resizer strips carrying a chevron that docks flush to
// the screen edge when its panel is shut, and `[` / `]` to collapse them.
// slides/src/editor/{editor,panels}.ts is the reference; where a rule is
// arbitrary (a radius, a gap) it is copied to the pixel on purpose.
//
// IT OWNS NO STRUCTURE IT DID NOT BUILD. `mountPanels` re-parents `.dx-body`'s
// existing children into a centre column and inserts itself around them, so the
// boot sequence needs one call and no markup change. Nothing here reads or
// writes another module's DOM: the grid keeps its host element, the chart keeps
// its own, and both survive the move because moving a node keeps its subtree.
//
// EVERY WRITE IS A PATCH, none of them mutate. Same rule as rowcol.ts, for the
// same reason — the Patch objects are the undo entries and the future CRDT ops,
// so a panel that assigned to a column would be an edit with no inverse. The
// two exceptions are `addSheet`/`removeSheet`, which have NO patch op to mint
// (store.ts's union reaches cells, columns, sheet props and doc.title, never
// the sheet LIST). They go through `replaceDoc`, which is what import already
// does — and which clears the undo stack, so the delete asks first. That is the
// one hook this module wants and cannot have yet.

import './panels.css'
import { t } from './i18n.ts'
import { lsJson, lsSet } from '../../kernel/src/storage.ts'
import { TYPE_LABEL } from './format.ts'
import type { Column, ColumnType, DashDoc, TableSheet } from './model.ts'
import type { Patch, Store } from './store.ts'
import type { Grid } from './grid.ts'
import {
  freezeAt, hiddenSet, readFrozen, resizeColumn, setHidden,
  type SetSheetProps,
} from './rowcol.ts'

export type Side = 'left' | 'right'

/** Column-level totals, spelled as the sheet stores them. */
export type TotalsAgg = NonNullable<TableSheet['totals']>[string]

const TYPES: ColumnType[] = ['text', 'number', 'money', 'percent', 'date', 'bool', 'enum']
const AGGS: Array<'sum' | 'avg' | 'count' | 'min' | 'max'> = ['sum', 'avg', 'count', 'min', 'max']

// Widths are slides' bounds, nudged: a sheet name needs less room than a slide
// thumbnail and a column's controls need a little more than an element's.
const PANEL_BOUNDS = { left: [140, 380], right: [200, 440] } as const
const PANEL_DEFAULTS = { left: 200, right: 250 } as const
/** Below this the panels boot shut, so the GRID is what you see. Slides' rule. */
const PHONE_W = 700

const LS_WIDTHS = 'bento-dash-panels'
const LS_SHUT = 'bento-dash-panels-shut'
/** Per-app, NOT slides' 'bento-panel-open': same origin, different section names. */
const LS_SECTIONS = 'bento-dash-panel-open'

/** Sections that start closed until the reader opens one (then it is remembered). */
const CLOSED_BY_DEFAULT = new Set(['Workbook'])

const rowsOf = (s: TableSheet): number => s.rids.reduce((n, [, c]) => n + c, 0)

const isTable = (s: { kind?: unknown }): s is TableSheet => s.kind === 'table'

// --- patch factories --------------------------------------------------------
//
// Pure, so `scripts/test-dash-panels.ts` can hold them to the two rules that
// are easy to get wrong from a UI and impossible to see afterwards: a cleared
// setting must leave the file as it found it, and a delete must be spelled
// `drop` rather than `props: {k: undefined}` — which rowcol's applySheetProps
// refuses outright, because that spelling evaporates in `JSON.stringify` and
// would reach every other replica as a no-op.

/**
 * Set or clear one column's totals aggregate.
 *
 * Clearing the LAST one drops `totals` entirely rather than storing `{}`: an
 * additive field that means "no totals" should be ABSENT, or turning the row on
 * and off again leaves the workbook changed, every reader diffs it, and collab
 * ships an op for a document that is back where it started. Same argument
 * `freezeAt` makes for frozen panes.
 */
export function totalsPatch(
  sheet: TableSheet, colId: string, agg: TotalsAgg | null,
): SetSheetProps {
  const next: NonNullable<TableSheet['totals']> = { ...(sheet.totals ?? {}) }
  if (agg === null) delete next[colId]
  else next[colId] = agg
  return Object.keys(next).length
    ? { op: 'setSheetProps', sheet: sheet.id, props: { totals: next } }
    : { op: 'setSheetProps', sheet: sheet.id, props: {}, drop: ['totals'] }
}

/**
 * Freeze up to and including `colId`, or unfreeze if it is already the edge.
 *
 * The count is VISIBLE position, which is what the reader pointed at — a hidden
 * column between the gutter and this one would otherwise freeze one column more
 * than the control named. Frozen ROWS are carried through untouched; the filter
 * menu's version of this drops them, which is a second setting silently reset
 * by a first.
 */
export function freezeThroughPatch(sheet: TableSheet, colId: string): SetSheetProps {
  const hidden = hiddenSet(sheet)
  const at = sheet.columns.filter((c) => !hidden.has(c.id)).findIndex((c) => c.id === colId)
  const now = readFrozen(sheet)
  if (at < 0) return freezeAt(sheet, now.rows, now.cols) as SetSheetProps
  const already = now.cols === at + 1
  return freezeAt(sheet, now.rows, already ? 0 : at + 1) as SetSheetProps
}

/** Rename a sheet. An empty name is refused rather than stored — a nameless tab
 *  is unclickable, and the previous name is the only thing left to fall back to. */
export function renameSheetPatch(sheet: TableSheet, name: string): SetSheetProps | null {
  const n = name.trim()
  if (!n || n === sheet.name) return null
  return { op: 'setSheetProps', sheet: sheet.id, props: { name: n } }
}

/**
 * A sheet id nothing in the workbook has taken.
 *
 * `seed` is a parameter so this is deterministic under test; the collision walk
 * matters because a duplicate sheet id makes `doc.sheets.find` return the FIRST
 * one and the second sheet becomes unreachable — its data still in the file,
 * nothing able to open it.
 */
export function mintSheetId(doc: DashDoc, seed: number = Date.now()): string {
  const taken = new Set(doc.sheets.map((s) => s.id))
  let n = Math.floor(Math.abs(seed) % 1e8)
  for (;;) {
    const id = `sheet-${n.toString(36)}`
    if (!taken.has(id)) return id
    n++
  }
}

/** "Sheet 2", "Sheet 3" — the first spelling nothing else is using. */
export function mintSheetName(doc: DashDoc, base: string): string {
  const taken = new Set(doc.sheets.map((s) => s.name))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const n = `${base} ${i}`
    if (!taken.has(n)) return n
  }
}

/** Blank rows a new sheet starts with — enough to type into, few enough to save. */
const NEW_ROWS = 20

/**
 * An empty table sheet.
 *
 * `steps[0]` is the provenance record, and it is present even here: a dash file
 * always answers "where did this come from?", and "somebody typed it" is an
 * answer. Column data is `raw` and exactly `NEW_ROWS` long, because a column
 * shorter than the sheet is malformed to every OTHER reader of the JSON even
 * though it reads correctly inside this build (rowcol.ts `fitToRows`).
 */
export function blankSheet(id: string, name: string, at: string): TableSheet {
  const cols: Column[] = ['A', 'B', 'C'].map((letter, i) => ({
    id: `${id}-c${i + 1}`, name: `${t('Column')} ${letter}`, type: 'text', w: 130,
  }))
  const data: TableSheet['data'] = {}
  for (const c of cols) data[c.id] = { enc: 'raw', v: Array.from({ length: NEW_ROWS }, () => null) }
  return {
    id, name, kind: 'table',
    rids: [[1, NEW_ROWS]],
    columns: cols,
    data,
    steps: [{ op: 'import', from: 'created in dash', at, rows: 0, note: 'A blank sheet — nothing was imported.' }],
  }
}

// --- mount ------------------------------------------------------------------

export interface PanelsHost {
  store: Store
  grid: Grid
  /** the `.dx-body` element — panels wrap whatever is already inside it */
  body: HTMLElement
}

export interface Panels {
  /** Collapse or reopen one panel (what `[` and `]` do). */
  toggle(side: Side): void
  /** Rebuild both panels now. */
  refresh(): void
}

export function mountPanels(host: PanelsHost): Panels {
  const { store, grid, body } = host

  // DECLARED FIRST, and it has to be: `resizer()` writes into this while
  // building the strips below, and the strips are built before any of the
  // sections that follow. A `const` further down the closure is in its temporal
  // dead zone at that point — mounting threw `Cannot access 'chevrons' before
  // initialization`, which took the whole boot with it (the panels had already
  // emptied `.dx-body`, so the grid vanished too).
  const chevrons: Partial<Record<Side, HTMLElement>> = {}

  // Everything that was in `.dx-body` — the grid and the chart pane — becomes
  // the centre column, so the panels can sit either side of BOTH. Moving the
  // nodes keeps their listeners and their subtrees, so the references main.ts
  // captured at boot stay live.
  const centre = document.createElement('div')
  centre.className = 'dp-centre'
  while (body.firstChild) centre.appendChild(body.firstChild)

  const left = panelEl('dp-left')
  const right = panelEl('dp-right')
  const leftBar = resizer('left')
  const rightBar = resizer('right')
  body.append(left, leftBar, centre, rightBar, right)

  // --- widths and collapse, both remembered ---------------------------------

  const widths = { ...PANEL_DEFAULTS } as { left: number; right: number }
  const saved = lsJson<Record<string, number>>(LS_WIDTHS, {})
  for (const side of ['left', 'right'] as const) {
    const [min, max] = PANEL_BOUNDS[side]
    if (typeof saved[side] === 'number') widths[side] = Math.min(max, Math.max(min, saved[side]))
  }
  applyWidths()

  // A phone boots with both shut so the grid is what you see — but only if the
  // reader has never said otherwise, or opening one panel on a phone would be
  // forgotten on every reload.
  const shut = lsJson<Record<string, boolean>>(LS_SHUT, {})
  for (const side of ['left', 'right'] as const) {
    const el = side === 'left' ? left : right
    const pref = shut[side]
    // A width of ZERO means "not laid out yet", not "phone". A background or
    // freshly-created tab reports 0 before first layout, and `0 < 700` then
    // collapsed both panels on a desktop — with no stored preference to
    // explain it, so it looked like the panels had simply not shipped.
    const vw = window.innerWidth
    const phone = vw > 0 && vw < PHONE_W
    if (pref ?? phone) el.classList.add('dp-shut')
  }
  updateChevrons()

  function panelEl(cls: string): HTMLElement {
    const el = document.createElement('aside')
    el.className = `dp-panel ${cls}`
    return el
  }

  function applyWidths(): void {
    left.style.setProperty('--dp-w', `${widths.left}px`)
    right.style.setProperty('--dp-w', `${widths.right}px`)
  }


  function updateChevrons(): void {
    for (const side of ['left', 'right'] as const) {
      const btn = chevrons[side]
      if (!btn) continue
      const closed = (side === 'left' ? left : right).classList.contains('dp-shut')
      // The arrow points where clicking moves the boundary, not at the panel.
      btn.textContent = side === 'left' ? (closed ? '›' : '‹') : (closed ? '‹' : '›')
      btn.title = side === 'left'
        ? closed ? t('Show sheets ([)') : t('Hide sheets ([)')
        : closed ? t('Show properties (])') : t('Hide properties (])')
    }
  }

  function toggle(side: Side): void {
    const el = side === 'left' ? left : right
    const nowShut = el.classList.toggle('dp-shut')
    shut[side] = nowShut
    lsSet(LS_SHUT, JSON.stringify(shut))
    updateChevrons()
  }

  function resizer(side: Side): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'dp-resizer'
    bar.title = t('Drag to resize · double-click to reset')
    const btn = document.createElement('button')
    btn.className = 'dp-toggle'
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(side) })
    chevrons[side] = btn
    bar.appendChild(btn)

    bar.addEventListener('mousedown', (down) => {
      if (down.target === btn) return         // the chevron is a click, not a drag
      const panel = side === 'left' ? left : right
      if (panel.classList.contains('dp-shut')) return
      down.preventDefault()
      const startX = down.clientX
      const startW = widths[side]
      const [min, max] = PANEL_BOUNDS[side]
      panel.classList.add('dp-noanim')
      document.body.classList.add('dp-resizing')
      const move = (e: MouseEvent): void => {
        const dx = e.clientX - startX
        widths[side] = Math.min(max, Math.max(min, startW + (side === 'left' ? dx : -dx)))
        applyWidths()
      }
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        panel.classList.remove('dp-noanim')
        document.body.classList.remove('dp-resizing')
        lsSet(LS_WIDTHS, JSON.stringify(widths))
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
    bar.addEventListener('dblclick', () => {
      widths[side] = PANEL_DEFAULTS[side]
      applyWidths()
      lsSet(LS_WIDTHS, JSON.stringify(widths))
    })
    return bar
  }

  // --- what is current ------------------------------------------------------

  /**
   * The sheet the grid is showing.
   *
   * Read from the grid rather than tracked here: `Grid.sheetId` is private and
   * `setSheet` is called by import as well as by this panel, so a local copy
   * goes stale the first time a CSV lands.
   */
  function currentSheet(): TableSheet | null {
    try {
      return grid.sheet
    } catch {
      return null                             // mid-replaceDoc, or a canvas sheet
    }
  }

  function visibleColumns(sheet: TableSheet): Column[] {
    const hidden = hiddenSet(sheet)
    return sheet.columns.filter((c) => !hidden.has(c.id))
  }

  /** The column under the cursor. The selection counts VISIBLE positions. */
  function currentColumn(sheet: TableSheet): Column | null {
    return visibleColumns(sheet)[grid.sel.cursor.col] ?? null
  }

  // --- rendering ------------------------------------------------------------

  const ro = (): boolean => store.readOnly

  function renderSheets(): void {
    left.textContent = ''
    const head = document.createElement('h3')
    head.className = 'dp-section dp-static'
    head.textContent = t('Sheets')
    left.appendChild(head)

    const cur = currentSheet()
    for (const sheet of store.doc.sheets) {
      const item = document.createElement('div')
      item.className = 'dp-sheet'
      if (cur && sheet.id === cur.id) item.classList.add('active')

      const name = document.createElement('div')
      name.className = 'dp-sheet-name'
      name.textContent = sheet.name || t('(untitled sheet)')
      const meta = document.createElement('div')
      meta.className = 'dp-sheet-meta'
      // Read the discriminant BEFORE isTable() narrows it away — in the else
      // branch the union has collapsed and `sheet.kind` is unreachable.
      const kind = String((sheet as { kind?: unknown }).kind ?? '')

      if (isTable(sheet)) {
        meta.textContent = `${rowsOf(sheet)} × ${sheet.columns.length}`
        item.addEventListener('click', () => {
          if (cur && sheet.id === cur.id) return
          grid.setSheet(sheet.id)
        })
        // Rename in place. The right panel has the same field; this is the one
        // people reach for, because it is where the name already is.
        item.addEventListener('dblclick', (e) => {
          e.preventDefault()
          if (ro()) return
          startRename(name, sheet)
        })
      } else {
        // A sheet this panel cannot edit. Showing it greyed is honest; hiding
        // it would make a sheet that is really there look deleted.
        //
        // NAME THE KIND IT ACTUALLY IS. Everything non-table used to be
        // labelled a canvas sheet, which was true until pivots existed — and
        // then a pivot, generated by the app's own ＋ Pivot button, sat in the
        // list describing itself as something else entirely. A label that
        // confidently states the wrong thing is worse than a vague one.
        item.classList.add('dp-sheet-off')
        meta.textContent = kind === 'pivot'
          ? t('pivot table — open it from ＋ Pivot')
          : kind === 'canvas'
            ? t('canvas sheet — not editable in this build')
            : t('{kind} sheet — not editable in this build').replace('{kind}', kind)
      }
      item.append(name, meta)

      if (!ro() && isTable(sheet)) {
        const tools = document.createElement('div')
        tools.className = 'dp-sheet-tools'
        tools.appendChild(iconBtn('✕', t('Delete this sheet'), (e) => {
          e.stopPropagation()
          removeSheet(sheet)
        }))
        item.appendChild(tools)
      }
      left.appendChild(item)
    }

    if (!ro()) {
      const add = document.createElement('button')
      add.className = 'dp-btn dp-add'
      add.textContent = t('＋ New sheet')
      add.addEventListener('click', addSheet)
      left.appendChild(add)
    }
  }

  function startRename(name: HTMLElement, sheet: TableSheet): void {
    const input = document.createElement('input')
    input.className = 'dp-sheet-rename'
    input.value = sheet.name
    name.replaceWith(input)
    input.focus()
    input.select()
    let done = false
    const finish = (write: boolean): void => {
      if (done) return
      done = true
      if (write) {
        const p = renameSheetPatch(sheet, input.value)
        if (p) store.commit(p)
      }
      renderSheets()
    }
    input.addEventListener('blur', () => finish(true))
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()                     // the grid owns bare keys otherwise
      if (e.key === 'Enter') finish(true)
      else if (e.key === 'Escape') finish(false)
    })
    // the double-click also selected the row's text; clear it or the two
    // selections fight over the caret
    getSelection()?.removeAllRanges()
  }

  /**
   * Add a sheet — a PATCH, so it is undoable.
   *
   * This used to go through `replaceDoc`, which clears the undo stack: adding a
   * sheet silently threw away every edit you could previously take back.
   */
  function addSheet(): void {
    if (ro()) return
    const doc = store.doc
    const id = mintSheetId(doc)
    store.commit({
      op: 'setSheet', id,
      sheet: blankSheet(id, mintSheetName(doc, t('Sheet')), new Date().toISOString()),
    } as never)
    grid.setSheet(id)
  }

  function removeSheet(sheet: TableSheet): void {
    if (ro()) return
    const doc = store.doc
    if (doc.sheets.filter(isTable).length < 2) {
      window.alert(t('A workbook needs at least one sheet.'))
      return
    }
    // Undoable now, so the warning no longer has to say otherwise — but a
    // sheet is a lot of rows to remove on one click, so it still asks.
    const rows = rowsOf(sheet)
    const msg = t('Delete "{name}" and its {n} rows?')
      .replace('{name}', sheet.name)
      .replace('{n}', String(rows))
    if (!window.confirm(msg)) return
    const cur = currentSheet()
    store.commit({ op: 'setSheet', id: sheet.id, sheet: undefined } as never)
    if (cur && cur.id === sheet.id) {
      const next = doc.sheets.find(isTable)
      if (next) grid.setSheet(next.id)
    }
    render()
  }

  // --- the properties panel -------------------------------------------------

  function renderProps(): void {
    right.textContent = ''
    const sheet = currentSheet()
    if (!sheet) {
      const p = document.createElement('p')
      p.className = 'dp-empty'
      p.textContent = t('No table sheet is open.')
      right.appendChild(p)
      return
    }
    buildColumnSection(sheet)
    buildSheetSection(sheet)
    buildWorkbookSection()
    applyAccordion(right)
  }

  function buildColumnSection(sheet: TableSheet): void {
    section(right, t('Column'))
    const col = currentColumn(sheet)
    if (!col) {
      note(right, t('Select a cell to see its column.'))
      return
    }

    row(right, t('Name'), text(col.name, (v) => {
      if (v.trim() && v !== col.name) commit({ op: 'setColumn', sheet: sheet.id, col: col.id, patch: { name: v.trim() } })
    }))

    row(right, t('Type'), select(
      TYPES.map((tp) => [tp, t(TYPE_LABEL[tp])] as const),
      col.type,
      (v) => commit({ op: 'setColumn', sheet: sheet.id, col: col.id, patch: { type: v as ColumnType } }),
    ))

    // The Excel-style pattern (format.ts readPattern): a currency prefix,
    // thousands grouping and a fixed number of decimals. The GLYPHS stay the
    // viewer's, so this really is only "what to show".
    const fmt = text(typeof col.format === 'string' ? col.format : '', (v) => {
      const next = v.trim()
      if (next === (col.format ?? '')) return
      // `undefined` clears it: JSON.stringify drops the key, so the file comes
      // back exactly as it was before anyone typed a pattern. (Over a wire that
      // spelling would arrive as a no-op — the hazard rowcol.ts documents for
      // `hidden` — which is a live concern the day dash gets collab.)
      commit({ op: 'setColumn', sheet: sheet.id, col: col.id, patch: { format: next || undefined } })
    })
    fmt.placeholder = '£#,##0.00'
    row(right, t('Format'), fmt)

    // One expression for the WHOLE column. Editing it here beats the prompt()
    // the grid falls back to, because you can see the column while you type.
    const formula = text(typeof col.formula === 'string' ? col.formula : '', (v) => {
      const next = v.trim()
      if (next === (col.formula ?? '')) return
      commit({ op: 'setColumn', sheet: sheet.id, col: col.id, patch: { formula: next || undefined } })
    })
    formula.placeholder = t('Value * Probability')
    formula.classList.add('dp-mono')
    row(right, t('Formula'), formula)

    row(right, t('Width'), number(col.w ?? 130, 10, (v) => {
      // resizeColumn clamps and rounds — a width is a drag's output, so out of
      // range is ordinary and refusing it would be the bug.
      commit(resizeColumn(sheet, col.id, v))
    }))

    const agg = sheet.totals?.[col.id]
    const aggValue = typeof agg === 'string' ? agg : agg ? 'custom' : 'none'
    const aggSel = select(
      [['none', t('none')] as const, ...AGGS.map((a) => [a, t(a)] as const),
        ...(aggValue === 'custom' ? [['custom', t('custom formula')] as const] : [])],
      aggValue,
      (v) => {
        if (v === 'custom') return              // a hand-written {f} is not ours to rewrite
        commit(totalsPatch(sheet, col.id, v === 'none' ? null : v as TotalsAgg))
      },
    )
    row(right, t('Total'), aggSel)

    const frozen = readFrozen(sheet)
    const upTo = visibleColumns(sheet).findIndex((c) => c.id === col.id) + 1
    row(right, t('Freeze to here'), toggle_(frozen.cols === upTo, () =>
      commit(freezeThroughPatch(sheet, col.id))))

    row(right, t('Hidden'), toggle_(col.hidden === true, (on) =>
      commit(setHidden(sheet, col.id, on))))

    if (typeof col.failed === 'number' && col.failed > 0) {
      note(right, t('{n} value(s) could not be read as this type.').replace('{n}', String(col.failed)))
    }
  }

  function buildSheetSection(sheet: TableSheet): void {
    section(right, t('Sheet'))
    row(right, t('Name'), text(sheet.name, (v) => {
      const p = renameSheetPatch(sheet, v)
      if (p) commit(p)
    }))
    readonlyRow(right, t('Rows'), String(rowsOf(sheet)))
    readonlyRow(right, t('Columns'), String(sheet.columns.length))

    const frozen = readFrozen(sheet)
    row(right, t('Frozen rows'), number(frozen.rows, 1, (v) =>
      commit(freezeAt(sheet, v, frozen.cols) as Patch)))
    row(right, t('Frozen columns'), number(frozen.cols, 1, (v) =>
      commit(freezeAt(sheet, frozen.rows, v) as Patch)))

    // The way BACK from "Hide this column". Without it a hidden column is
    // unreachable from the interface — it is still in the file, and nothing on
    // screen can say so or bring it back.
    const hidden = sheet.columns.filter((c) => c.hidden === true)
    if (hidden.length) {
      note(right, t('Hidden columns'))
      for (const c of hidden) {
        const btn = document.createElement('button')
        btn.className = 'dp-btn dp-block'
        btn.textContent = `${c.name} — ${t('show')}`
        btn.disabled = ro()
        btn.addEventListener('click', () => commit(setHidden(sheet, c.id, false)))
        right.appendChild(btn)
      }
    }

    if (grid.filters.length || grid.sorts.length) {
      const clear = document.createElement('button')
      clear.className = 'dp-btn dp-block'
      clear.textContent = t('Clear filters and sorts')
      clear.addEventListener('click', () => { grid.clearView(); render() })
      right.appendChild(clear)
    }
  }

  function buildWorkbookSection(): void {
    section(right, t('Workbook'))
    const doc = store.doc
    readonlyRow(right, t('Sheets'), String(doc.sheets.length))
    readonlyRow(right, t('Rows'), String(
      doc.sheets.reduce((n, s) => n + (isTable(s) ? rowsOf(s) : 0), 0)))
    readonlyRow(right, t('Measures'), String(Object.keys(doc.measures ?? {}).length))
    readonlyRow(right, t('Format'), `${doc.format} v${doc.version}`)
  }

  function commit(p: Patch | Patch[]): void {
    if (ro()) return
    store.commit(p)
  }

  // --- the accordion --------------------------------------------------------

  /**
   * Retrofit the flat panel into an accordion: every `.dp-section` header
   * gathers the siblings that follow it into a collapsible body, and the open
   * state is remembered by section TITLE. Copied from slides' `applyAccordion`
   * including that detail — keying by title (not by index) is what lets a
   * section keep its state when the panel above it changes shape.
   *
   * `.dp-static` opts a header out: the left panel's "Sheets" label is a
   * heading, not a drawer.
   */
  function applyAccordion(hostEl: HTMLElement): void {
    const open = lsJson<Record<string, boolean>>(LS_SECTIONS, {})
    for (const h of [...hostEl.querySelectorAll<HTMLElement>('.dp-section:not(.dp-static)')]) {
      const key = h.textContent ?? ''
      const bodyEl = document.createElement('div')
      bodyEl.className = 'dp-section-body'
      let n: ChildNode | null = h.nextSibling
      while (n && !(n instanceof HTMLElement && n.classList.contains('dp-section'))) {
        const next: ChildNode | null = n.nextSibling
        bodyEl.appendChild(n)
        n = next
      }
      h.after(bodyEl)
      const isOpen = open[key] ?? !CLOSED_BY_DEFAULT.has(key)
      h.classList.add('dp-sec-toggle')
      if (!isOpen) {
        h.classList.add('closed')
        bodyEl.style.display = 'none'
      }
      h.addEventListener('click', () => {
        const nowClosed = h.classList.toggle('closed')
        bodyEl.style.display = nowClosed ? 'none' : ''
        open[key] = !nowClosed
        lsSet(LS_SECTIONS, JSON.stringify(open))
      })
    }
  }

  // --- keeping up with the app ----------------------------------------------

  let stale = false

  /**
   * True while the reader is mid-edit in a field a rebuild would rip out.
   * Discrete controls (select, checkbox, button) commit atomically and want the
   * rebuild immediately — that is how a type change reveals the rows it adds.
   */
  function editing(): boolean {
    const a = document.activeElement as HTMLElement | null
    if (!a || !right.contains(a) && !left.contains(a)) return false
    if (a.tagName === 'TEXTAREA' || a.isContentEditable) return true
    if (a.tagName === 'INPUT') {
      const type = (a as HTMLInputElement).type
      return type !== 'checkbox' && type !== 'radio' && type !== 'button'
    }
    return false
  }

  function render(force = false): void {
    if (!force && editing()) { stale = true; return }
    stale = false
    renderSheets()
    renderProps()
  }

  for (const el of [left, right]) {
    el.addEventListener('focusout', () => {
      setTimeout(() => {
        if (stale && !left.matches(':focus-within') && !right.matches(':focus-within')) render()
      }, 0)
    })
  }

  store.on('doc', () => render())
  store.on('view', () => render())

  // The grid announces a selection change through ONE callback and main.ts owns
  // it (formula bar + status bar). Chain, never replace.
  const announced = grid.onSelectionChange
  grid.onSelectionChange = (summary, ref, value) => {
    announced?.(summary, ref, value)
    render()
  }

  // Import switches sheets too, so the list has to follow the GRID rather than
  // only its own clicks — otherwise it keeps highlighting the old sheet until
  // the next unrelated document event.
  grid.onSheetChange = () => render(true)

  /**
   * `[` and `]`, in the CAPTURE phase — and that is load-bearing. main.ts's
   * document keydown handler feeds any bare printable key to `grid.typeInto`,
   * which would open a cell editor seeded with "[". Capturing on `document`
   * runs before every bubble listener on it, and `stopImmediatePropagation`
   * (not `stopPropagation` — both handlers are on the same node) is what keeps
   * the keystroke from reaching the grid at all.
   */
  document.addEventListener('keydown', (e) => {
    if (e.key !== '[' && e.key !== ']') return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    toggle(e.key === '[' ? 'left' : 'right')
  }, true)

  render(true)

  return { toggle, refresh: () => render(true) }
}

// --- row builders -----------------------------------------------------------
// Deliberately the same shapes slides' panel uses: a label on the left, one
// control on the right at a fixed width. Anything wider than that reads as a
// different application.

function section(hostEl: HTMLElement, title: string): void {
  const h = document.createElement('h3')
  h.className = 'dp-section'
  h.textContent = title
  hostEl.appendChild(h)
}

function row(hostEl: HTMLElement, label: string, control: HTMLElement): void {
  const r = document.createElement('label')
  r.className = 'dp-row'
  const span = document.createElement('span')
  span.textContent = label
  r.append(span, control)
  hostEl.appendChild(r)
}

function readonlyRow(hostEl: HTMLElement, label: string, value: string): void {
  const r = document.createElement('div')
  r.className = 'dp-row dp-row-ro'
  const span = document.createElement('span')
  span.textContent = label
  const v = document.createElement('span')
  v.className = 'dp-value'
  v.textContent = value
  r.append(span, v)
  hostEl.appendChild(r)
}

function note(hostEl: HTMLElement, message: string): void {
  const p = document.createElement('p')
  p.className = 'dp-note'
  p.textContent = message
  hostEl.appendChild(p)
}

/** Commits on `change` — blur or Enter — never per keystroke. */
function text(value: string, onChange: (v: string) => void): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.value = value
  input.spellcheck = false
  input.addEventListener('change', () => onChange(input.value))
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()                       // the grid owns bare keys otherwise
    if (e.key === 'Enter') input.blur()
  })
  return input
}

function number(value: number, step: number, onChange: (v: number) => void): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'number'
  input.step = String(step)
  input.value = String(value)
  input.addEventListener('keydown', (e) => e.stopPropagation())
  input.addEventListener('change', () => {
    const v = parseFloat(input.value)
    if (Number.isFinite(v)) onChange(v)
  })
  return input
}

/** Values stay MODEL words; only the labels are localized (PLATFORM §8). */
function select(
  options: ReadonlyArray<readonly [string, string]>,
  value: string,
  onChange: (v: string) => void,
): HTMLSelectElement {
  const sel = document.createElement('select')
  for (const [v, label] of options) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = label
    if (v === value) o.selected = true
    sel.appendChild(o)
  }
  sel.addEventListener('change', () => onChange(sel.value))
  return sel
}

// `toggle_`: `toggle` is the panel API's own verb, and shadowing it inside
// mountPanels would silently make the checkbox collapse a panel.
function toggle_(value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.className = 'dp-check'
  cb.checked = value
  cb.addEventListener('change', () => onChange(cb.checked))
  return cb
}

function iconBtn(glyph: string, title: string, onClick: (e: MouseEvent) => void): HTMLElement {
  const b = document.createElement('button')
  b.className = 'dp-btn dp-icon'
  b.textContent = glyph
  b.title = title
  b.addEventListener('click', onClick)
  return b
}
