// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The properties panel — and, since the sheets left, the only panel there is.
//
// THE SHEET LIST IS GONE FROM HERE, and the whole left panel went with it.
// Sheets live along the BOTTOM now (tabs.ts), where every spreadsheet has kept
// them for thirty years. What this file used to spend on them was a permanent
// 200px column showing three names, on every screen, including a phone. The
// grid is that much wider now, and the `[` key — which used to open and close
// the sheets panel — opens and closes the tab strip, so the binding select.ts
// declares still means what it says.
//
// THIS IS SLIDES' CHROME, DELIBERATELY. Two Bento apps that lay themselves out
// differently read as two products, so the geometry here is copied rather than
// reinvented: 11px uppercase section headers, 12.5px rows with the control
// right-aligned at a fixed width, an accordion whose open state is remembered
// per section TITLE, a 5px resizer strip carrying a chevron that docks flush to
// the screen edge when the panel is shut, and `]` to collapse it.
// slides/src/editor/{editor,panels}.ts is the reference; where a rule is
// arbitrary (a radius, a gap) it is copied to the pixel on purpose.
//
// IT OWNS NO STRUCTURE IT DID NOT BUILD. `mountPanels` re-parents `.dx-body`'s
// existing children into a centre column and inserts itself around them, so the
// boot sequence needs one call and no markup change. Nothing here reads or
// writes another module's DOM: the grid keeps its host element, the chart keeps
// its own, and both survive the move because moving a node keeps its subtree.
// The tab strip is mounted from here for the same reason — it is the other half
// of one move, and doing it here costs main.ts no edit at all.
//
// EVERY WRITE IS A PATCH, none of them mutate. Same rule as rowcol.ts, for the
// same reason: the Patch objects are the undo entries and the future CRDT ops,
// so a panel that assigned to a column would be an edit with no inverse.

import './panels.css'
import { t, locale } from './i18n.ts'
import { lsJson, lsSet } from '../../kernel/src/storage.ts'
import { TYPE_LABEL } from './format.ts'
import { buildCellProps, type CellRange, type PanelKit } from './cellprops.ts'
import {
  appearancePatch, buildAppearanceSection, describeOverrideSelection, effectiveFormat,
  overrideFormatPatch, overrideKeys, type Appearance, type AppearanceEdit,
} from './cellfmt.ts'
import {
  buildValidationSection, canvasEntryAt, canvasRulePatch, canvasRules, columnRule,
  countViolations, columnRulePatch, boxRef, type DataRule,
} from './datavalid.ts'
import { mountTabs, renameSheetPatch } from './tabs.ts'
import { inferComputedType } from './computedtype.ts'
import { buildCondFmtSection, condFmtPatch, readCondFmt } from './condfmtui.ts'
import { toast } from './saveui.ts'
import type { CanvasSheet, Column, ColumnType, TableSheet } from './model.ts'
import { readCell, setColumnType, type Patch, type Store } from './store.ts'
import type { Grid } from './grid.ts'
import {
  freezeAt, hiddenSet, readFrozen, resizeColumn, setHidden,
  type SetSheetProps,
} from './rowcol.ts'

/**
 * The sheet-shaped helpers moved to tabs.ts with the sheet list. Re-exported
 * because they are this module's published surface — `scripts/test-dash-panels.ts`
 * imports them from here — and because "where a sheet is minted" is a question
 * about sheets, not about which file happens to draw them today.
 */
export {
  blankSheet, mintSheetId, mintSheetName, renameSheetPatch,
} from './tabs.ts'

/**
 * There is ONE panel now. `[` still has a meaning — it shows and hides the
 * sheet TAB STRIP — but tabs.ts owns that key, beside the thing it toggles,
 * rather than this module reaching across to it.
 */
export type Side = 'right'

/** Column-level totals, spelled as the sheet stores them. */
export type TotalsAgg = NonNullable<TableSheet['totals']>[string]

const TYPES: ColumnType[] = ['text', 'number', 'money', 'percent', 'date', 'bool', 'enum']
const AGGS: Array<'sum' | 'avg' | 'count' | 'min' | 'max'> = ['sum', 'avg', 'count', 'min', 'max']

// Widths are slides' bounds, nudged: a column's controls need a little more
// room than an element's.
const PANEL_BOUNDS = { right: [200, 440] } as const
const PANEL_DEFAULTS = { right: 250 } as const
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
 * Which entry of the totals control is the current one.
 *
 * Two controls set this field now — the panel's dropdown and the footer cell's
 * menu — and both have to read a `{ f }` custom formula the same way, or one of
 * them shows "none" over a total the sheet is plainly displaying and quietly
 * offers to write over it. One function, so there is one answer.
 */
export function totalsChoice(agg: TotalsAgg | undefined): string {
  return typeof agg === 'string' ? agg : agg ? 'custom' : 'none'
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
  /**
   * Open the panel, open the named accordion section and scroll to it.
   *
   * The cell menu's "More conditional formatting…" is the only caller today,
   * and it is why this exists: the full rule editor lives in the panel, the
   * panel can be collapsed and the section can be shut, so a menu item that
   * merely hoped both were open would do nothing at all on the phone layout —
   * which boots with the panel shut, by design.
   */
  reveal(title: string): void
}

export function mountPanels(host: PanelsHost): Panels {
  const { store, grid, body } = host

  // THE STORE'S VOICE. `store.ts` runs in the node rigs and must not reach the
  // DOM, so it refuses through an injected reporter rather than an import —
  // exactly the shape `setColumnType` already takes its `report` in, and this
  // file already hands that one `toast` (see the Type row below). The undo
  // barrier needs the same channel and gets it here rather than growing a
  // second mechanism. Left unlent it swallows: an undo that refuses silently is
  // still honest, but it is only half the sentence.
  store.say = toast

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

  const right = panelEl('dp-right')
  const rightBar = resizer('right')
  body.append(centre, rightBar, right)

  // THE SHEET TABS, mounted from here — and main.ts needs no edit for it.
  // `mountTabs` inserts itself directly AFTER `.dx-body`, which lands the strip
  // between the grid and the status bar in `#app`'s column with no change to
  // the boot markup. This is the module the sheet list left, so this is where
  // the other half of that move is wired; the alternative (a second call in
  // main.ts) mounts the strip TWICE if this line is ever forgotten, which is
  // exactly the shape of bug two people editing one screen produce.
  mountTabs({ store, grid, body })

  // --- widths and collapse, both remembered ---------------------------------

  const widths = { ...PANEL_DEFAULTS } as { right: number }
  const saved = lsJson<Record<string, number>>(LS_WIDTHS, {})
  for (const side of ['right'] as const) {
    const [min, max] = PANEL_BOUNDS[side]
    if (typeof saved[side] === 'number') widths[side] = Math.min(max, Math.max(min, saved[side]))
  }
  applyWidths()

  // A phone boots shut so the grid is what you see — but only if the reader has
  // never said otherwise, or opening the panel on a phone would be forgotten on
  // every reload.
  const shut = lsJson<Record<string, boolean>>(LS_SHUT, {})
  {
    const pref = shut.right
    // A width of ZERO means "not laid out yet", not "phone". A background or
    // freshly-created tab reports 0 before first layout, and `0 < 700` then
    // collapsed the panel on a desktop — with no stored preference to explain
    // it, so it looked like the panel had simply not shipped.
    const vw = window.innerWidth
    const phone = vw > 0 && vw < PHONE_W
    if (pref ?? phone) right.classList.add('dp-shut')
  }
  updateChevrons()

  function panelEl(cls: string): HTMLElement {
    const el = document.createElement('aside')
    el.className = `dp-panel ${cls}`
    return el
  }

  function applyWidths(): void {
    right.style.setProperty('--dp-w', `${widths.right}px`)
  }


  function updateChevrons(): void {
    const btn = chevrons.right
    if (!btn) return
    const closed = right.classList.contains('dp-shut')
    // The arrow points where clicking moves the boundary, not at the panel.
    btn.textContent = closed ? '‹' : '›'
    btn.title = closed ? t('Show properties (])') : t('Hide properties (])')
  }

  function toggle(_side: Side): void {
    const nowShut = right.classList.toggle('dp-shut')
    shut.right = nowShut
    lsSet(LS_SHUT, JSON.stringify(shut))
    updateChevrons()
  }

  function resizer(side: 'right'): HTMLElement {
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
      if (right.classList.contains('dp-shut')) return
      down.preventDefault()
      const startX = down.clientX
      const startW = widths[side]
      const [min, max] = PANEL_BOUNDS[side]
      right.classList.add('dp-noanim')
      document.body.classList.add('dp-resizing')
      const move = (e: MouseEvent): void => {
        widths[side] = Math.min(max, Math.max(min, startW - (e.clientX - startX)))
        applyWidths()
      }
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        right.classList.remove('dp-noanim')
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

  /**
   * What the last cell edit needs to say — "3 values could not be read as this
   * format", almost always. Held here rather than in cellprops.ts because the
   * panel is rebuilt from scratch on every document event, so a message stored
   * inside the section would not survive the commit that produced it.
   */
  let cellMessage = ''

  // --- the properties panel -------------------------------------------------

  function renderProps(): void {
    right.textContent = ''
    const sheet = currentSheet()
    if (!sheet) {
      // A SPREADSHEET IS NOT A MISSING TABLE, and it is not an EMPTY panel
      // either. `currentSheet()` returns only table sheets, so this arm caught
      // the spreadsheet kind too — first with "No table sheet is open", which
      // reads as an error about a sheet you are looking at, and then with an
      // honest sentence saying there was nothing here. There is now: a
      // spreadsheet types and paints each CELL, so the panel shows the cell.
      const canvas = grid.canvas
      if (canvas) {
        buildCellProps({
          host: right,
          kit: KIT,
          sheet: canvas,
          ranges: grid.sel.ranges() as CellRange[],
          cursor: grid.sel.cursor,
          readOnly: ro(),
          locale: locale(),
          commit,
          message: cellMessage,
          say: (m) => {
            // Shown until the next edit or the next selection — a refusal is
            // about the edit that just happened, not about the sheet.
            if (m === cellMessage) return
            cellMessage = m
            render(true)
          },
        })
        buildCanvasValidationSection(canvas)
        buildWorkbookSection()
        applyAccordion(right)
        return
      }
      const p = document.createElement('p')
      p.className = 'dp-empty'
      p.textContent = t('No table sheet is open.')
      right.appendChild(p)
      return
    }
    buildDatasetCellSection(sheet)
    buildColumnSection(sheet)
    buildDatasetValidationSection(sheet)
    buildCondFmtColumnSection(sheet)
    buildSheetSection(sheet)
    buildWorkbookSection()
    applyAccordion(right)
  }

  /**
   * The Cell section on a DATASET — the gap this closes.
   *
   * The spreadsheet kind has had one since cellprops.ts landed; this kind had
   * nothing, so ⌘B and the panel both did different things depending on which
   * tab you were on. The Appearance rows below are literally the same builder
   * (cellfmt.ts `buildAppearanceSection`) the spreadsheet draws, so the two
   * cannot drift again.
   *
   * WHAT IS DELIBERATELY DIFFERENT is the two rows above it, and they are the
   * type boundary made visible rather than merely respected:
   *
   *   * TYPE is READ-ONLY here and says which column decides it. On a dataset
   *     the column owns the type — that is what earns the column formula, the
   *     import refusal and the chart binding — so the cell cannot have its own.
   *     Showing it greyed beside the cell's own appearance is the honest way to
   *     say "this you may change, that you may not"; an absent row would leave
   *     a reader wondering whether the panel simply forgot.
   *   * PATTERN is display only. Typing one here stamps how this cell PRINTS
   *     and never re-reads the value, which is the opposite of what the same
   *     control does on a spreadsheet (there it is a type declaration and rules
   *     6–8 recast). The note says so, because the two controls look identical.
   */
  function buildDatasetCellSection(sheet: TableSheet): void {
    section(right, t('Cell'))
    const visible = visibleColumns(sheet)
    const col = currentColumn(sheet)
    const keys = overrideKeys(sheet, store.order[sheet.id], visible, grid.sel.ranges() as CellRange[])
    const cursorKey = keys.length
      ? overrideKeys(sheet, store.order[sheet.id], visible,
          [{ anchor: grid.sel.cursor, head: grid.sel.cursor }] as CellRange[])[0]
      : undefined
    if (!col || !keys.length || !cursorKey) {
      note(right, t('Select a cell to format it.'))
      return
    }
    const cell = sheet.cells?.[cursorKey]
    readonlyRow(right, t('Selection'),
      describeOverrideSelection(keys, `${col.name} ${grid.sel.cursor.row + 1}`))
    readonlyRow(right, t('Type'), t(TYPE_LABEL[col.type]))

    const own = typeof cell?.format === 'string' ? cell.format : ''
    const pat = text(own, (v) => {
      const next = v.trim()
      if (next === own) return
      const p = overrideFormatPatch(sheet, keys, next || undefined)
      if (p) commit(p)
    })
    // The COLUMN's pattern as the placeholder: what this cell prints with
    // today, when it has said nothing of its own.
    pat.placeholder = effectiveFormat(sheet, cursorKey) ?? '#,##0.00'
    pat.classList.add('dp-mono')
    pat.disabled = ro()
    row(right, t('Pattern'), pat)
    note(right, t('The column decides what these cells ARE. A pattern here only changes how they print.'))
    // …and on a column that prints its values as they are, "how they print" is
    // nothing at all. Read from the CELL's own pattern, not the effective one:
    // the placeholder above shows the column's, and warning about a pattern the
    // reader did not type here would send them to the wrong field.
    patternInertNote(right, col.type, own)

    buildAppearanceSection({
      host: right,
      kit: KIT,
      cell: cell as Appearance | undefined,
      readOnly: ro(),
      write: (edit: AppearanceEdit) => {
        const p = appearancePatch(sheet, keys, edit)
        if (p) commit(p)
      },
    })
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
      // Not a bare commit: a type change can be REFUSED (a value that cannot be
      // read as the new type), and a silent refusal leaves this dropdown showing
      // the type the reader picked while the header chip shows the one the
      // column still has. Report, then rebuild so the control tells the truth.
      (v) => {
        if (!setColumnType(store, sheet.id, col.id, v as ColumnType, toast)) render(true)
      },
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
    patternInertNote(right, col.type, typeof col.format === 'string' ? col.format : '')

    // One expression for the WHOLE column. Editing it here beats the prompt()
    // the grid falls back to, because you can see the column while you type.
    const formula = text(typeof col.formula === 'string' ? col.formula : '', (v) => {
      const next = v.trim()
      if (next === (col.formula ?? '')) return
      if (!next) {
        commit({ op: 'setColumn', sheet: sheet.id, col: col.id, patch: { formula: undefined } })
        return
      }
      // The same rule main.ts's formula dialog follows, for the same reason: a
      // column whose expression now returns text must stop claiming NUMBER, and
      // a type chosen by hand in the dropdown two rows up must not be undone by
      // an unrelated edit here. See computedtype.ts.
      const before = inferComputedType(sheet, col.formula ?? '', col.id)
      const after = inferComputedType(sheet, next, col.id)
      commit({
        op: 'setColumn', sheet: sheet.id, col: col.id,
        patch: col.type === before.type && after.type !== col.type
          ? { formula: next, type: after.type }
          : { formula: next },
      })
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
    const aggValue = totalsChoice(agg)
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

  /**
   * Conditional formatting on a DATASET — attached to the COLUMN, for the same
   * reason validation is: on this kind the column is the thing that owns how
   * every value in it is read, and a per-cell rule here would be a per-cell
   * type through the back door.
   *
   * The engine (condfmt.ts) has implemented six rule kinds since it landed and
   * the app reached two of them. Everything the section needs is passed in, so
   * condfmtui.ts never reads the store: this is where the write is, so this is
   * where the patch is built.
   */
  function buildCondFmtColumnSection(sheet: TableSheet): void {
    const col = currentColumn(sheet)
    if (!col) return
    buildCondFmtSection({
      host: right,
      kit: KIT,
      sheetId: sheet.id,
      colId: col.id,
      scope: col.name,
      columns: sheet.columns.map((c) => c.name),
      rules: readCondFmt(sheet, col.id),
      readOnly: ro(),
      write: (rules) => commit(condFmtPatch(sheet, col.id, rules) as Patch),
      rerender: () => render(true),
    })
  }

  /**
   * Validation on a DATASET — attached to the COLUMN, because on this kind the
   * column is what owns the type and a rule is a NARROWING of it. A per-cell
   * rule here would be a per-cell type through the back door, which is the
   * appearance-leakage argument (cellfmt.ts) run in reverse.
   *
   * The offender count is what makes "existing data is marked, never changed"
   * a promise a reader can see rather than one the code merely keeps: adding a
   * rule to a column of real data says immediately how much of it disagrees.
   * Capped, because it runs on every document event.
   */
  function buildDatasetValidationSection(sheet: TableSheet): void {
    const col = currentColumn(sheet)
    if (!col) return
    const rule = columnRule(col)
    buildValidationSection({
      host: right,
      kit: KIT,
      scope: col.name,
      rule,
      readOnly: ro(),
      offenders: rule ? countViolations(rule, columnValues(sheet, col)) : undefined,
      write: (next: DataRule | null) => commit(columnRulePatch(sheet, col.id, next)),
    })
  }

  /** Every stored value of one column, lazily — `countViolations` stops early
   *  at its own cap and a materialised array would defeat that. */
  function* columnValues(sheet: TableSheet, col: Column): Generator<unknown> {
    const n = rowsOf(sheet)
    const data = sheet.data[col.id]
    for (let i = 0; i < n; i++) yield readCell(data, i)
  }

  /**
   * Validation on a SPREADSHEET — attached to a RANGE, as Excel's `sqref` is,
   * because there is no column here to own it.
   *
   * Editing an EXISTING rule writes back to its own range, not to whatever
   * happens to be selected: the cursor is inside the rule, and re-keying it to
   * the selection would silently shrink a rule over B2:B100 to the one cell
   * somebody clicked while changing its message. A NEW rule takes the
   * selection, which is the range the author has in their hand.
   */
  function buildCanvasValidationSection(sheet: CanvasSheet): void {
    const cur = grid.sel.cursor
    const entry = canvasEntryAt(canvasRules(sheet), cur.row, cur.col)
    const b = grid.sel.bounds()
    const ref = entry?.ref ?? boxRef({ top: b.top, left: b.left, bottom: b.bottom, right: b.right })
    buildValidationSection({
      host: right,
      kit: KIT,
      scope: ref,
      rule: entry?.rule ?? null,
      readOnly: ro(),
      write: (next: DataRule | null) => {
        const p = canvasRulePatch(sheet, ref, next)
        if (p) commit(p as Patch)
      },
    })
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

  // --- the totals row, as a control -----------------------------------------
  //
  // THE MENU IS MOUNTED FROM HERE because the WRITE lives here. `totalsPatch`
  // is the one function that knows a cleared total has to drop the field rather
  // than store `{}`, and a menu that assembled its own patch would be a second
  // spelling of the same edit — the shape of bug where the panel's "none" and
  // the footer's "none" leave two different files. The grid draws the cell and
  // reports the click; nothing about the model crosses back.

  /**
   * Pick an aggregate for one column, from the footer cell itself.
   *
   * PLACED AGAINST THE CELL'S RECT, and flipped ABOVE it by default: the totals
   * row is sticky at the bottom of a scroller that reaches the bottom of the
   * window, so a menu dropped below the cell opens off screen. Measure first,
   * then place — `.dx-pop` is `position: fixed`, so viewport coordinates are
   * the right ones and nothing the grid scrolls can clip it.
   */
  function openTotalsMenu(colId: string, rect: DOMRect): void {
    if (ro()) return
    const sheet = currentSheet()
    const col = sheet?.columns.find((c) => c.id === colId)
    if (!sheet || !col) return
    const cur = totalsChoice(sheet.totals?.[col.id])
    const item = (v: string, label: string): string =>
      `<button data-agg="${v}"${v === cur ? ' class="dx-pop-on"' : ''}>` +
      `${escHtml(label)}${v === cur ? ' ✓' : ''}</button>`
    const el = popAt(rect,
      `<div class="dx-pop-row">${escHtml(col.name)}</div>` +
      AGGS.map((a) => item(a, t(a))).join('') +
      (cur === 'custom' ? item('custom', t('custom formula')) : '') +
      `<div class="dx-pop-sep"></div>` +
      item('none', t('No total')))
    el.querySelectorAll<HTMLElement>('button').forEach((b) => {
      b.addEventListener('click', () => {
        const v = b.dataset.agg!
        el.remove()
        // A hand-written `{ f }` is not ours to rewrite — the same refusal the
        // dropdown makes. Choosing a real aggregate over it IS allowed: that is
        // a decision, and it is undoable.
        if (v === cur || v === 'custom') return
        commit(totalsPatch(sheet, col.id, v === 'none' ? null : v as TotalsAgg))
      })
    })
  }

  grid.onTotalsMenu = openTotalsMenu

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
    if (!a || !right.contains(a)) return false
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
    renderProps()
  }

  right.addEventListener('focusout', () => {
    setTimeout(() => {
      if (stale && !right.matches(':focus-within')) render()
    }, 0)
  })

  store.on('doc', () => render())
  store.on('view', () => render())

  // The grid announces a selection change through ONE callback and main.ts owns
  // it (formula bar + status bar). Chain, never replace.
  const announced = grid.onSelectionChange
  grid.onSelectionChange = (summary, ref, value) => {
    announced?.(summary, ref, value)
    // A refusal describes the cells it happened to. Moving off them takes the
    // sentence with it, or it hangs over a selection it was never about.
    cellMessage = ''
    render()
  }

  // Import switches sheets too, so the properties have to follow the GRID
  // rather than only this panel's own controls — otherwise they keep describing
  // the old sheet until the next unrelated document event. CHAINED, because
  // mountTabs above has already hung the tab strip's rebuild off this callback.
  const switched = grid.onSheetChange
  grid.onSheetChange = (id: string) => {
    switched?.(id)
    render(true)
  }

  /**
   * `]`, in the CAPTURE phase — and that is load-bearing. main.ts's document
   * keydown handler feeds any bare printable key to `grid.typeInto`, which
   * would open a cell editor seeded with "]". Capturing on `document` runs
   * before every bubble listener on it, and `stopImmediatePropagation` (not
   * `stopPropagation` — both handlers are on the same node) is what keeps the
   * keystroke from reaching the grid at all.
   *
   * `[` is tabs.ts's now: it shows and hides the sheet tab strip, which is
   * where the sheets panel it used to open went. Same capture-phase treatment,
   * declared in the same place in select.ts — just next to what it toggles.
   */
  document.addEventListener('keydown', (e) => {
    if (e.key !== ']') return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    toggle('right')
  }, true)

  render(true)

  // SAY WHAT IS SELECTED, ONCE, AT THE START. The grid announces on every
  // selection change and on every view change, and never at boot — so a
  // freshly opened workbook showed `A1` beside an EMPTY formula bar over a
  // cell that plainly contained "North". Announced from here because this is
  // the last thing mounted that chains the callback: by now the formula bar,
  // the status bar and this panel are all listening.
  grid.announce()

  function reveal(title: string): void {
    const open = lsJson<Record<string, boolean>>(LS_SECTIONS, {})
    open[title] = true
    lsSet(LS_SECTIONS, JSON.stringify(open))
    if (right.classList.contains('dp-shut')) toggle('right')
    render(true)
    for (const h of right.querySelectorAll<HTMLElement>('.dp-section')) {
      if (h.textContent === title) { h.scrollIntoView({ block: 'nearest' }); return }
    }
  }

  return { toggle, refresh: () => render(true), reveal }
}

// --- a popover, placed against a rect ---------------------------------------

const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * `.dx-pop` — the app's one floating surface — opened against an element's
 * rect rather than a point.
 *
 * main.ts's `popover(x, y)` clamps with `Math.min(y, innerHeight - 40)`, which
 * is right for a menu hanging off a column header near the top of the window
 * and wrong for one hanging off the totals row, which IS the bottom of the
 * window: six items would open below the fold with 40px showing. So this one
 * measures itself and prefers to sit ABOVE the cell, falling back to below only
 * when there is no room. Fixed positioning, so nothing inside the scrolling
 * grid — sticky header, sticky footer, resize grips, Find's marks — can clip it
 * or be clicked through it.
 */
function popAt(rect: DOMRect, html: string): HTMLElement {
  document.querySelector('.dx-pop')?.remove()
  const el = document.createElement('div')
  el.className = 'dx-pop'
  el.style.visibility = 'hidden'
  el.innerHTML = html
  document.body.appendChild(el)
  const h = el.offsetHeight
  const w = el.offsetWidth
  const above = rect.top - h - 4
  el.style.top = `${above >= 4 ? above : Math.max(4, Math.min(rect.bottom + 4, window.innerHeight - h - 4))}px`
  el.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - w - 4))}px`
  el.style.visibility = ''
  // Next tick: the click that OPENED it is still travelling, and a listener
  // added now would see it and close the menu before it was ever painted.
  setTimeout(() => {
    const off = (e: MouseEvent): void => {
      if (el.contains(e.target as Node)) return
      el.remove()
      document.removeEventListener('mousedown', off)
    }
    document.addEventListener('mousedown', off)
  }, 0)
  return el
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

function note(hostEl: HTMLElement, message: string, cls = ''): void {
  const p = document.createElement('p')
  p.className = cls ? `dp-note ${cls}` : 'dp-note'
  p.textContent = message
  hostEl.appendChild(p)
}

/**
 * Types whose display NEVER goes through the number formatter.
 *
 * `formatValue` (format.ts) answers `String(v)` for these and never reads the
 * pattern at all — so a pattern typed against one of them is accepted, shown
 * back as set, saved into the file, and does nothing. Stated here rather than
 * imported because format.ts exports the formatter and not its shape, and a
 * second implementation of "what counts as a number" is the thing store.ts
 * refuses to have. This is the narrower question — "does this type print
 * through the number path" — and its answer is one `if` in that file.
 */
const PRINTS_AS_TYPED: ReadonlySet<ColumnType> = new Set<ColumnType>(['text', 'enum', 'date', 'bool'])

/**
 * A pattern that only a number can honour: an Excel digit placeholder (`#`/`0`)
 * or a percent sign, which is everything `readPattern` looks for.
 */
const isNumericPattern = (fmt: string): boolean => /[#0%]/.test(fmt)

/**
 * IS THIS PATTERN DOING NOTHING? The decision, separated from the paragraph
 * that reports it, so a rig can assert it — a note nobody can check is how a
 * sentence ends up shown in the wrong case, which is the same defect as not
 * showing it at all pointing the other way.
 */
export const patternIsInert = (type: ColumnType, fmt: string): boolean =>
  !!fmt && PRINTS_AS_TYPED.has(type) && isNumericPattern(fmt)

/**
 * THE PATTERN THAT DOES NOTHING, said where it is typed.
 *
 * Measured: `#,##0.00` typed against a Text column is accepted, redisplayed as
 * set, and changes nothing on screen or on paper. The cell section already
 * carries the sentence that explains why — "The column decides what these cells
 * ARE. A pattern here only changes how they print." — and this is its sibling,
 * shown only in the case where the pattern has nothing to change.
 *
 * DELIBERATELY NOT A REFUSAL. `setColumnType` refuses and says so because
 * converting a column would DESTROY values it cannot read; a display pattern
 * destroys nothing, and a Text column on its way to being a Number column is a
 * reasonable place to be standing with a pattern already typed. So the pattern
 * is kept, and the panel stops pretending it is doing something.
 */
function patternInertNote(hostEl: HTMLElement, type: ColumnType, fmt: string): void {
  if (!patternIsInert(type, fmt)) return
  note(hostEl, t('This column is {type}, so its values print exactly as they are stored and this pattern changes nothing. Set the type to Number, Money or Percent for it to apply.',
    { type: t(TYPE_LABEL[type]) }), 'dp-note-warn')
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

/**
 * The row builders, handed to the sections that live in their own file.
 *
 * PASSED, not re-declared. cellprops.ts draws rows in this panel and could have
 * built its own — and then a control there would be 2px off one here, which is
 * the shape of drift nobody files a bug about and everybody sees. These are the
 * same functions the Column section uses, so there is one spelling of a row and
 * a change to it moves every section at once.
 */
export const KIT: PanelKit = {
  section, row, readonlyRow, note, text, number, select, check: toggle_,
}
