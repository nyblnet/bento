// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The grid's three context menus — cell, row gutter, column header — and the
// popover they are drawn in.
//
// WHY THIS IS ITS OWN FILE. The cell menu used to live in main.ts, and main.ts
// BOOTS ON EVALUATION: a rig cannot import it, so nothing could ever assert
// what a right-click actually produces. Two of this app's menus have shipped
// unreachable (findings 5 and 8) precisely because "the builder returns the
// right items" and "the item appears when a person right-clicks" are different
// facts and only the first one was ever checked. Everything here — the items,
// the wiring that puts them on the DOM handlers, and what each item commits —
// is reachable from a test that mounts a real Grid. `scripts/test-dash-menu.ts`
// is that test, and it drives real `contextmenu` events.
//
// WHAT IS AND IS NOT ON EACH MENU. The three menus are about three different
// things and are deliberately not one menu with three headings:
//
//   CELL — the cell and the block around it. Clipboard, insert/delete on both
//     axes (a cell sits at the crossing of two), Fill down, Clear contents,
//     Paste special, Split into columns, and the conditional formats. This is
//     the long one because a cell is where every gesture in the app converges.
//   ROW GUTTER — a whole row, or every row the selection covers. Clipboard,
//     insert above/below, delete, clear. NO Fill down (a row is not a fill
//     direction — a fill runs down a column), NO conditional formats (dash's
//     rules are per COLUMN; offering them from a row would be a control that
//     silently acted on something else), NO Split into columns (a column op).
//   COLUMN HEADER — a whole column, or every column the selection covers.
//     Clipboard, insert left/right, delete, clear, Split into columns, the
//     conditional formats (which ARE column-scoped, and this is their honest
//     home), and a way back into the sort/filter menu the caret already owns —
//     routed to the SAME function the caret calls, because two implementations
//     of "hide this column" is how the two start to disagree.
//
// The counts come off the SELECTION and are spelled into the labels ("Insert 3
// rows above"), which is Excel's rule and is also the only way the reader can
// tell, before clicking, what the menu thinks it is about.

import { t } from './i18n.ts'
import {
  insertRowsAt, deleteRowsAt, insertColumn, deleteColumn, setHidden,
} from './rowcol.ts'
import type { Store, Patch } from './store.ts'
import type { Column, TableSheet } from './model.ts'
import type { Grid } from './grid.ts'
import {
  blankCondFmtRule, condFmtPatch, describeCondFmtRule, readCondFmt, readOperand,
} from './condfmtui.ts'

/** Local, because gridmenu.ts must not import main.ts — see the note above. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The app-shaped things a menu item needs and this module must not own: a
 * modal dialog, the findings strip, a toast, and the three commands whose
 * implementations are closures over the live app.
 */
export interface MenuHooks {
  askForm(opts: {
    title: string
    fields: Array<{ key: string; label: string; value?: string; placeholder?: string; mono?: boolean }>
    hint?: string
    submit?: string
    check?: (values: Record<string, string>) => string | null
  }): Promise<Record<string, string> | null>
  /** the amber strip — sentences the reader has to be able to re-read */
  notice(messages: string[]): void
  /** the transient confirmation — "a rule was added", and it is visible on screen */
  toast(message: string): void
  /** ⌘C / ⌘X, through the same path the keyboard takes */
  copy(cut: boolean): void
  /** ⌘V, through the same path the document paste listener takes */
  paste(): void
  pasteSpecial(x: number, y: number): void
  split(): void
  /** open the panel's full rule editor — every kind the engine implements */
  condFmt(): void
  /** the caret menu, from the header's right-click — one implementation, two doors */
  filterMenu(colId: string, x: number, y: number): void
}

/**
 * A menu, anchored at a point.
 *
 * ESCAPE CLOSES IT. It did not, which is finding 13: every other dismissable
 * surface in the app takes Escape, the menu is opened by a gesture that leaves
 * the hand nowhere near the mouse, and a menu that can only be dismissed by
 * clicking somewhere harmless is a menu people click something in by accident.
 * The listener is CAPTURE-phase and removes itself with the popover, so it
 * cannot outlive the thing it closes and cannot swallow an Escape meant for a
 * cell editor that opened afterwards.
 */
export function popover(x: number, y: number, html: string): HTMLElement {
  document.querySelector('.dx-pop')?.remove()
  const el = document.createElement('div')
  el.className = 'dx-pop'
  el.style.left = `${Math.min(x, innerWidth - 260)}px`
  el.style.top = `${Math.min(y, innerHeight - 40)}px`
  el.innerHTML = html
  document.body.appendChild(el)
  // DETACHED MEANS GONE. A menu can leave the document by four routes — an
  // item was clicked, a click landed outside, Escape, or the next `popover`
  // replaced it — and only one of them runs `close`. A listener still holding
  // an Escape for a menu that is no longer on screen SWALLOWS the Escape the
  // reader meant for the cell editor or the help card, which is a worse bug
  // than the one Escape was added to fix. So both listeners stand down the
  // moment the node is detached.
  return dismissable(el) && el
}

/**
 * Give a popover the four ways out, for anything that builds its own element.
 *
 * `filterui.ts` does exactly that — `el.className = 'dx-pop dfx'` — so it took
 * the STYLING of a popover and none of the behaviour, and Escape did nothing on
 * the column menu while working everywhere else. One class name, two builders,
 * one of them with listeners: measured in a browser, not caught by either
 * rig, because each rig only knew about its own menu.
 *
 * Exported so there is one answer rather than a second copy of these listeners.
 */
export function dismissable(el: HTMLElement): true {
  const gone = (): boolean => el.parentElement === null
  const onKey = (e: KeyboardEvent): void => {
    if (gone()) { close(); return }
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    close()
  }
  const off = (e: MouseEvent): void => {
    if (gone() || !el.contains(e.target as Node)) close()
  }
  function close(): void {
    el.remove()
    document.removeEventListener('mousedown', off)
    document.removeEventListener('keydown', onKey, true)
  }
  document.addEventListener('keydown', onKey, true)
  // The click that OPENED the menu must not also close it, which is what the
  // zero-delay timeout is for: mousedown is still travelling when this runs.
  setTimeout(() => document.addEventListener('mousedown', off), 0)
  return true
}

const sep = '<div class="dx-pop-sep"></div>'

/**
 * The clipboard verbs, first on every menu.
 *
 * "The menu is also missing Copy, Cut and Paste, which is the other reason
 * people right-click" — finding 8. They go at the TOP because that is where
 * every other application in the world puts them, and a reader scanning for
 * Copy who finds Insert row first concludes this menu is not the one.
 */
const clipboardItems = (): string =>
  `<button data-a="cut">${esc(t('Cut'))}</button>` +
  `<button data-a="copy">${esc(t('Copy'))}</button>` +
  `<button data-a="paste">${esc(t('Paste'))}</button>`

/** True when this item was one of the three above, and it has been handled. */
function runClipboard(a: string | undefined, hooks: MenuHooks): boolean {
  if (a === 'cut') { hooks.copy(true); return true }
  if (a === 'copy') { hooks.copy(false); return true }
  if (a === 'paste') { hooks.paste(); return true }
  return false
}

/**
 * How many rows this menu is about, and where they start — in CANONICAL data
 * positions, which is the only coordinate a structural op accepts.
 *
 * `clicked` is a VIEW row. When it is inside the selection the menu is about
 * the whole selection; when it is not (right-clicking away from a selection)
 * it is about that one row. And under a SORT the selected view rows need not
 * be canonically contiguous — three rows on screen can be rows 2, 7 and 9 of
 * the file — so that case falls back to one row rather than deleting a range
 * the reader never selected. The labels are built from this same answer, so
 * what the menu says is what the menu does.
 */
export function rowSpan(grid: Grid, clicked: number): { at: number; count: number } {
  const one = (): { at: number; count: number } => {
    const at = grid.canonicalRow(clicked)
    return at < 0 ? { at: -1, count: 0 } : { at, count: 1 }
  }
  const b = grid.sel.bounds()
  if (clicked < b.top || clicked > b.bottom) return one()
  const rows: number[] = []
  for (let r = b.top; r <= b.bottom; r++) {
    const c = grid.canonicalRow(r)
    if (c >= 0) rows.push(c)
  }
  if (!rows.length) return one()
  rows.sort((p, q) => p - q)
  const contiguous = rows[rows.length - 1] - rows[0] === rows.length - 1
  return contiguous ? { at: rows[0], count: rows.length } : one()
}

/**
 * The same question for columns. `clicked` is a column ID; the answer is a run
 * of positions in `sheet.columns` — which is NOT the visible index, because a
 * hidden column sits in the first and not the second.
 */
export function colSpan(grid: Grid, clicked: string): { at: number; count: number; ids: string[] } {
  const s = grid.sheet
  const vis = grid.visibleColumns()
  const pos = (id: string): number => s.columns.findIndex((c) => c.id === id)
  const one = (): { at: number; count: number; ids: string[] } => {
    const at = pos(clicked)
    return at < 0 ? { at: -1, count: 0, ids: [] } : { at, count: 1, ids: [clicked] }
  }
  const b = grid.sel.bounds()
  const ci = vis.findIndex((c) => c.id === clicked)
  if (ci < 0 || ci < b.left || ci > b.right) return one()
  const ids = vis.slice(b.left, b.right + 1).map((c) => c.id)
  const at = ids.map(pos).filter((p) => p >= 0).sort((p, q) => p - q)
  if (!at.length) return one()
  const contiguous = at[at.length - 1] - at[0] === at.length - 1
  return contiguous ? { at: at[0], count: at.length, ids } : one()
}

/** "row" / "3 rows" — the noun the labels are built out of. */
const rowsWord = (n: number): string =>
  (n === 1 ? t('row') : t('{n} rows').replace('{n}', String(n)))
const colsWord = (n: number): string =>
  (n === 1 ? t('column') : t('{n} columns').replace('{n}', String(n)))

/** The conditional-format block, which is about a COLUMN wherever it is opened from. */
const condFmtItems = (): string =>
  `<button data-a="cf-gt">${esc(t('Highlight cells greater than…'))}</button>` +
  `<button data-a="cf-dup">${esc(t('Highlight duplicate values'))}</button>` +
  `<button data-a="cf-scale">${esc(t('Colour scale'))}</button>` +
  `<button data-a="cf-bar">${esc(t('Data bars'))}</button>` +
  `<button data-a="cf-more">${esc(t('More conditional formatting…'))}</button>` +
  `<button data-a="cf-off">${esc(t('Remove formatting'))}</button>`

/**
 * The conditional-format items, run. Returns true when `a` was one of them.
 *
 * ONE implementation, reached from the cell menu and the column menu, because
 * these rules are stored per column and a second copy of the writing is how
 * two menus start to disagree about what a rule is.
 */
function runCondFmt(
  a: string | undefined, store: Store, sheet: TableSheet, col: Column | undefined, hooks: MenuHooks,
): boolean {
  if (a === 'cf-more') { hooks.condFmt(); return true }
  if (!col) return a?.startsWith('cf-') ?? false
  if (a === 'cf-gt') {
    // THE ONE EVERYBODY REACHES FOR, one click from where they right-clicked.
    // "Flag anyone over 40 hours" was the task that found this feature
    // unreachable, and routing it through the panel would answer it in three
    // moves. The panel is still there for the other five kinds and for the
    // colours; this is the shortcut, and it writes the same rule object.
    void hooks.askForm({
      title: t('Highlight cells greater than…'),
      fields: [{ key: 'n', label: t('Value'), value: '0' }],
      submit: t('Highlight'),
      check: (v) => (v.n.trim() === '' ? t('A value to compare against.') : null),
    }).then((got) => {
      if (!got) return
      const rule = blankCondFmtRule('cellValue')
      if (rule.kind === 'cellValue') rule.value = readOperand('>', got.n)
      const next = [...readCondFmt(sheet, col.id), rule]
      store.commit(condFmtPatch(sheet, col.id, next) as Patch)
      hooks.toast(describeCondFmtRule(rule))
    })
    return true
  }
  if (a === 'cf-dup') {
    // Job 4's other half, and the same story: implemented, persisted, painted,
    // and unreachable.
    const rule = blankCondFmtRule('duplicates')
    store.commit(condFmtPatch(sheet, col.id, [...readCondFmt(sheet, col.id), rule]) as Patch)
    hooks.toast(describeCondFmtRule(rule))
    return true
  }
  if (a === 'cf-scale' || a === 'cf-bar' || a === 'cf-off') {
    // Conditional formats are DOCUMENT data — they travel with the file — and
    // live in an additive field, so an older build keeps them. The two presets
    // REPLACE the column's rules rather than appending, which is what they have
    // always done: a colour scale is a whole-column treatment and stacking two
    // of them is never what the click meant.
    const rules = a === 'cf-off' ? [] : [blankCondFmtRule(a === 'cf-scale' ? 'colorScale' : 'dataBar')]
    store.commit(condFmtPatch(sheet, col.id, rules) as Patch)
    return true
  }
  return false
}

/**
 * Ask for a name and insert a column at `at`.
 *
 * The dialog is the whole reason the column appender is a click and not a
 * keystroke: a column needs a name before it can hold anything, so there is
 * nothing to type into on the header strip.
 */
function askInsertColumn(store: Store, grid: Grid, at: number, hooks: MenuHooks): void {
  const sheet = grid.sheet
  void hooks.askForm({
    title: t('New column'),
    fields: [{ key: 'name', label: t('Column name'), value: t('New column') }],
    submit: t('Insert'),
  }).then((got) => {
    if (!got) return
    const id = `c-${Math.floor(Date.now() % 1e8).toString(36)}`
    store.commit([
      ...insertColumn(sheet, at, { id, name: got.name.trim() || t('New column'), type: 'text' }),
      ...grid.shiftFormulas('col', at, 1),
    ])
  })
}

/** Wire every item's click to the one action it names. */
function onPick(el: HTMLElement, run: (a: string | undefined) => void): void {
  el.querySelectorAll<HTMLElement>('button').forEach((b) => {
    b.onclick = () => { run(b.dataset.a); el.remove() }
  })
}

/** The CELL menu — a cell is the crossing of a row and a column, so it has both. */
export function openCellMenu(
  store: Store, grid: Grid, row: number, ci: number, x: number, y: number, hooks: MenuHooks,
): void {
  const sheet = grid.sheet
  // THE VISIBLE list, not `sheet.columns`. `ci` counts shown columns, so on a
  // sheet with one column hidden the old `sheet.columns[ci]` named — and
  // deleted — the column to its right.
  const col = grid.visibleColumns()[ci]
  const el = popover(x, y,
    clipboardItems() + sep +
    `<button data-a="irow-above">${esc(t('Insert row above'))}</button>` +
    `<button data-a="irow-below">${esc(t('Insert row below'))}</button>` +
    `<button data-a="drow">${esc(t('Delete row'))}</button>` +
    sep +
    `<button data-a="icol">${esc(t('Insert column'))}</button>` +
    `<button data-a="dcol">${esc(t('Delete column'))}</button>` +
    sep +
    `<button data-a="fill">${esc(t('Fill down'))}</button>` +
    `<button data-a="clear">${esc(t('Clear contents'))}</button>` +
    sep +
    `<button data-a="paste-special">${esc(t('Paste special…'))}</button>` +
    `<button data-a="split">${esc(t('Split into columns…'))}</button>` +
    sep + condFmtItems())
  onPick(el, (a) => {
    if (runClipboard(a, hooks)) return
    if (runCondFmt(a, store, sheet, col, hooks)) return
    // `row` is a VISIBLE index and every structural op takes a canonical one.
    // They differ the moment somebody sorts, and passing the wrong one deletes
    // the wrong row — silently, because the view re-sorts over the evidence.
    // Each edit also carries the reference shift for the cell formulas, in the
    // SAME commit: a document where the rows have moved and the formulas have
    // not is a workbook of plausible wrong numbers.
    const at = grid.canonicalRow(row)
    if (a === 'irow-above') insertRows(store, grid, at, 1)
    else if (a === 'irow-below') insertRows(store, grid, at + 1, 1)
    else if (a === 'drow') deleteRows(store, grid, at, 1)
    else if (a === 'icol') {
      askInsertColumn(store, grid, sheet.columns.findIndex((c) => c.id === col?.id) + 1, hooks)
    } else if (a === 'dcol' && col) {
      deleteColumns(store, grid, [col.id])
    } else if (a === 'fill') grid.fillDownSelection()
    else if (a === 'clear') grid.clearSelection()
    else if (a === 'paste-special') hooks.pasteSpecial(x, y)
    else if (a === 'split') hooks.split()
  })
}

/** The ROW gutter menu — about whole rows, and it says how many. */
export function openRowMenu(
  store: Store, grid: Grid, row: number, x: number, y: number, hooks: MenuHooks,
): void {
  const { at, count } = rowSpan(grid, row)
  if (at < 0) return
  const n = rowsWord(count)
  const el = popover(x, y,
    clipboardItems() + sep +
    `<button data-a="above">${esc(t('Insert {n} above').replace('{n}', n))}</button>` +
    `<button data-a="below">${esc(t('Insert {n} below').replace('{n}', n))}</button>` +
    `<button data-a="del">${esc(t('Delete {n}').replace('{n}', n))}</button>` +
    sep +
    `<button data-a="clear">${esc(t('Clear contents'))}</button>`)
  onPick(el, (a) => {
    if (runClipboard(a, hooks)) return
    if (a === 'above') insertRows(store, grid, at, count)
    else if (a === 'below') insertRows(store, grid, at + count, count)
    else if (a === 'del') deleteRows(store, grid, at, count)
    else if (a === 'clear') grid.clearSelection()
  })
}

/** The COLUMN header menu — about whole columns, and it says how many. */
export function openColMenu(
  store: Store, grid: Grid, colId: string, x: number, y: number, hooks: MenuHooks,
): void {
  const sheet = grid.sheet
  const { at, count, ids } = colSpan(grid, colId)
  if (at < 0) return
  const col = sheet.columns.find((c) => c.id === colId)
  const n = colsWord(count)
  const el = popover(x, y,
    clipboardItems() + sep +
    `<button data-a="left">${esc(t('Insert {n} to the left').replace('{n}', n))}</button>` +
    `<button data-a="right">${esc(t('Insert {n} to the right').replace('{n}', n))}</button>` +
    `<button data-a="del">${esc(t('Delete {n}').replace('{n}', n))}</button>` +
    sep +
    `<button data-a="clear">${esc(t('Clear contents'))}</button>` +
    `<button data-a="split">${esc(t('Split into columns…'))}</button>` +
    sep +
    `<button data-a="sort">${esc(t('Sort and filter…'))}</button>` +
    `<button data-a="hide">${esc(t('Hide this column'))}</button>` +
    sep + condFmtItems())
  onPick(el, (a) => {
    if (runClipboard(a, hooks)) return
    if (runCondFmt(a, store, sheet, col, hooks)) return
    if (a === 'left') askInsertColumn(store, grid, at, hooks)
    else if (a === 'right') askInsertColumn(store, grid, at + count, hooks)
    else if (a === 'del') deleteColumns(store, grid, ids)
    else if (a === 'clear') grid.clearSelection()
    else if (a === 'split') hooks.split()
    else if (a === 'sort') hooks.filterMenu(colId, x, y)
    else if (a === 'hide') store.commit(setHidden(sheet, colId, true))
  })
}

/**
 * Insert, with the reference shift and — on a row that follows a run of
 * per-cell formulas — the formula those rows prove repeats (grid.carryFormulas,
 * finding 11). ONE commit, so one ⌘Z puts all three back.
 */
function insertRows(store: Store, grid: Grid, at: number, count: number): void {
  if (at < 0 || count < 1) return
  const sheet = grid.sheet
  const patches = insertRowsAt(sheet, at, count)
  if (!patches.length) return
  const rid = (patches[0] as { rids?: number[] }).rids?.[0]
  // Only for a single row, and only when there is a row ABOVE it to read the
  // pattern from — inserting at the top of the sheet has no preceding run and
  // inserting several rows would need a pattern per row, which is a fill and
  // not an insert.
  const carried = count === 1 && rid !== undefined && at > 0
    ? grid.carryFormulas(rid, at - 1)
    : { patches: [] as Patch[], messages: [] as string[] }
  store.commit([...patches, ...grid.shiftFormulas('row', at, count), ...carried.patches])
  if (carried.messages.length) grid.onNotice?.(carried.messages)
}

function deleteRows(store: Store, grid: Grid, at: number, count: number): void {
  if (at < 0 || count < 1) return
  const sheet = grid.sheet
  store.commit([...deleteRowsAt(sheet, at, count), ...grid.shiftFormulas('row', at, -count)])
}

/**
 * Delete columns, right to left.
 *
 * RIGHT TO LEFT and one at a time, because both `deleteColumn` and
 * `shiftFormulas` are computed against the sheet as it is NOW: computing three
 * deletions up front against one snapshot and applying them in sequence
 * deletes the wrong two columns. Still one commit, so it is one ⌘Z.
 */
function deleteColumns(store: Store, grid: Grid, ids: string[]): void {
  const sheet = grid.sheet
  const order = ids
    .map((id) => ({ id, at: sheet.columns.findIndex((c) => c.id === id) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => b.at - a.at)
  const patches: Patch[] = []
  for (const { id, at } of order) {
    patches.push(...deleteColumn(sheet, id), ...grid.shiftFormulas('col', at, -1))
  }
  if (patches.length) store.commit(patches)
}

/**
 * THE WIRING, and it lives here rather than in main.ts on purpose.
 *
 * A menu nobody hooked up is the failure mode this whole file is organised
 * against, so the hook-up is in the same module as the menus and a rig that
 * calls this function has tested the real path from `contextmenu` to items.
 * main.ts's whole share of these three menus is one call to this.
 */
export function installGridMenus(store: Store, grid: Grid, hooks: MenuHooks): void {
  grid.onContextMenu = (row, ci, x, y) => openCellMenu(store, grid, row, ci, x, y, hooks)
  grid.onRowMenu = (row, x, y) => openRowMenu(store, grid, row, x, y, hooks)
  grid.onColMenu = (colId, x, y) => openColMenu(store, grid, colId, x, y, hooks)
  // The header's `+`. It appends at the END, which is the only position the
  // control's position on screen could mean.
  grid.onAddColumn = () => {
    if (store.readOnly || grid.isCanvas) return
    askInsertColumn(store, grid, grid.sheet.columns.length, hooks)
  }
}
