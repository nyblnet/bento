// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Worksheet tabs — the bottom strip, where every spreadsheet has kept them.
//
// WHY THIS MOVED. The sheet list used to be a column of cards in the LEFT
// PANEL. That is not where anybody looks for sheets — thirty years of Excel,
// Lotus, Numbers, Sheets and Calc have put them along the bottom edge — and it
// spent a whole 200px panel, permanently, to show three names. The panel is
// gone with them (panels.ts), so the grid is 200px wider on every screen and
// the one control people already know how to find is where they expect it.
//
// WHAT THE CONVENTION ACTUALLY IS, because matching it is the point:
//   · click switches, double-click renames in place, right-click is the menu
//   · order is part of the DOCUMENT, and drag reorders it
//   · ＋ adds; the active tab is unmistakable
//   · ctrl+PgUp / ctrl+PgDn walk sheets
//
// TWO DELIBERATE DEPARTURES, both because the alternative is worse here:
//
// 1. OVERFLOW IS SHEETS', NOT EXCEL'S. Excel gives the strip four scroll
//    arrows that advance one tab per click; twenty sheets is nineteen clicks
//    to the far end, and the arrows eat 70px of a phone. Sheets scrolls the
//    strip and pins an ALL SHEETS menu at the left, which is one gesture to
//    any sheet at any count — so that is what this is. `＋` and `☰` sit
//    OUTSIDE the scroller so neither can scroll out of reach (Excel's trailing
//    `＋` requires scrolling to the end before you can add).
//
// 2. REORDER IS DRIVEN BY MOUSE EVENTS, NOT HTML5 DRAG-AND-DROP. `draggable`
//    would be fewer lines, and it is untestable without a real mouse (the same
//    wall slides' Moveable work documents) and dead on touch. Mouse events with
//    a 4px threshold are drivable synthetically, and `Move left` / `Move right`
//    in the context menu give touch and keyboard users the same operation —
//    which a drag handle alone never does.
//
// EVERY WRITE IS A PATCH. Sheet order is document data: readers must agree on
// it, so a reorder is an undoable `reorderSheets` — a permutation of the ids —
// never a splice. It was a `setSheet` PAIR (remove, then re-insert at the new
// index), which was correct in both directions and cost the whole SHEET in the
// undo entry's byte accounting; see `moveSheetPatches`. Two ops in store.ts's
// union reach the sheet LIST: `setSheet` for adding and removing one, and
// `reorderSheets` for the order.

import './tabs.css'
import { t } from './i18n.ts'
import { lsGet, lsSet } from '../../kernel/src/storage.ts'
import type { Column, DashDoc, Sheet, TableSheet, CanvasSheet } from './model.ts'
import type { Patch, Store } from './store.ts'
import type { Grid } from './grid.ts'
import type { SetSheetProps } from './rowcol.ts'

/** Remembered per browser, never in the document: this is a viewer preference. */
const LS_SHUT = 'bento-dash-tabs-shut'

/** Pixels of horizontal movement before a press becomes a reorder. */
const DRAG_SLOP = 4

/** Blank rows a new sheet starts with — enough to type into, few enough to save. */
const NEW_ROWS = 20

export const isTable = (s: { kind?: unknown }): s is TableSheet => s.kind === 'table'

/**
 * Can the grid SHOW this sheet?
 *
 * Distinct from `isTable`, and the distinction is the whole of the two-kinds
 * design: `isTable` answers "does this have columns and rids" — which is what
 * a row count, a chart binding or a filter needs — while this answers "does
 * clicking the tab do anything". A spreadsheet (`canvas`) has neither columns
 * nor rids and opens perfectly well.
 *
 * Every gate that used `isTable` to mean "openable" greyed the spreadsheet kind
 * out, which was correct while nothing could render one and became the reason
 * the kind looked unimplemented after it was.
 */
export const isOpenable = (s: { kind?: unknown }): boolean =>
  s.kind === 'table' || s.kind === 'canvas'

const rowsOf = (s: TableSheet): number => s.rids.reduce((n, [, c]) => n + c, 0)

// --- patch factories ---------------------------------------------------------
//
// Pure, and exported for `scripts/test-dash-tabs.ts`. None of this needs a DOM,
// and every one of them fails INVISIBLY when it is wrong: a reorder that lands
// one place off looks like a slightly clumsy drag, a delete that shows the
// wrong sheet afterwards looks like the wrong sheet was deleted, and an inverse
// that restores a sheet at the END silently reorders a workbook inside the
// operation meant to undo one.

/** Rename a sheet. An empty name is refused rather than stored — a nameless tab
 *  is unclickable, and the previous name is the only thing left to fall back to. */
export function renameSheetPatch(sheet: { id: string; name: string }, name: string): SetSheetProps | null {
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

/**
 * An empty table sheet.
 *
 * `steps[0]` is the provenance record, and it is present even here: a dash file
 * always answers "where did this come from?", and "somebody typed it" is an
 * answer. Column data is `raw` and exactly `NEW_ROWS` long, because a column
 * shorter than the sheet is malformed to every OTHER reader of the JSON even
 * though it reads correctly inside this build (rowcol.ts `fitToRows`).
 */
/**
 * An empty SPREADSHEET sheet — cells typed one by one, no columns, no rids.
 *
 * `cells` is empty and stays empty until somebody types: the kind is sparse, so
 * a new sheet costs its name. There is no `steps` provenance record because
 * there is no pipeline to record — a spreadsheet is not derived from anything,
 * which is exactly the difference the two kinds exist to express.
 */
export function blankSpreadsheet(id: string, name: string): CanvasSheet {
  return { id, name, kind: 'canvas', cells: {} }
}

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

/**
 * Where a tab being dragged from `from` lands, given the gap it was dropped
 * into. `insertBefore` counts gaps in the CURRENT list (0 = before the first
 * tab, n = after the last); the answer is an index in the list with the dragged
 * sheet already REMOVED, which is what `moveSheetPatches` takes.
 *
 * Off by one in either direction and a tab dropped on its own right-hand
 * neighbour either does not move or jumps two places — which reads as a
 * mis-aimed drag rather than as a bug, so nobody reports it.
 */
export function dropIndex(from: number, insertBefore: number): number {
  return insertBefore > from ? insertBefore - 1 : insertBefore
}

/**
 * Move a sheet to position `dest`, counted in the list WITHOUT it.
 *
 * ONE `reorderSheets`, carrying the ids. This used to be TWO `setSheet`
 * patches in one commit — remove, then re-insert at `dest` — because
 * `setSheet` on a sheet already in the document REPLACES it in place, so no
 * single patch could express a move. That was correct, including its inverse:
 * [remove, re-insert at the ORIGINAL index], so one ⌘Z put the tab back where
 * it was rather than at the end.
 *
 * It was not CHEAP. The sheet travelled by reference, which costs nothing in
 * memory — but the undo history is bounded by BYTES and the accounting is
 * `JSON.stringify` of the inverse, so a re-insert's inverse stringified the
 * whole sheet. On a 12MB workbook one drag spent 12MB of a 24MB budget and
 * evicted every earlier entry. `reorderSheets` pays for the ID LIST instead:
 * twenty sheets is about 200 bytes, whatever the workbook weighs.
 *
 * A second thing falls out of it. tabs.ts's own `beforePatch` hook reads a
 * `setSheet` whose sheet is `undefined` as "the sheet on screen is about to be
 * removed" and jumps the grid to a neighbour — which is right for a delete and
 * was pure noise inside a move, papered over by the drag handler re-selecting
 * the tab afterwards. A reorder removes nothing, so nothing flees.
 */
export function moveSheetPatches(doc: DashDoc, id: string, dest: number): Patch[] {
  const from = doc.sheets.findIndex((s) => s.id === id)
  if (from < 0) return []
  const to = Math.max(0, Math.min(dest, doc.sheets.length - 1))
  if (to === from) return []
  const order = doc.sheets.map((s) => s.id)
  order.splice(from, 1)
  order.splice(to, 0, id)
  return [{ op: 'reorderSheets', order }]
}

/** Move one place left or right. What the context menu offers when there is no
 *  mouse to drag with — a touch screen has no drag gesture that does not fight
 *  the strip's own scrolling. */
export function nudgeSheetPatches(doc: DashDoc, id: string, dir: -1 | 1): Patch[] {
  const from = doc.sheets.findIndex((s) => s.id === id)
  if (from < 0) return []
  return moveSheetPatches(doc, id, from + dir)
}

/**
 * Copy a sheet, land the copy immediately after the original.
 *
 * COLUMN IDS ARE KEPT. They are SHEET-scoped by construction — model.ts says so
 * in as many words, and the sync engine's node ids are `c␟<sheet>␟<col>` — so
 * two sheets holding a column called `c1` is ordinary. Reminting them would
 * mean remapping `data`, `cells`, `totals` and `condfmt` in lockstep, and every
 * key that got missed is a column that renders empty.
 *
 * COMMENTS ARE NOT COPIED. A thread is a conversation somebody had, with an
 * author and a timestamp; two sheets carrying the same thread under the same id
 * is two copies of one conversation, and `window.bento.comments()` would report
 * the id twice. A copy of the DATA is what "duplicate" means here.
 */
export function duplicateSheetPatches(
  doc: DashDoc, id: string, opts: { at?: string; seed?: number } = {},
): { patches: Patch[]; id: string; sheet: Sheet } | null {
  const from = doc.sheets.findIndex((s) => s.id === id)
  if (from < 0) return null
  const src = doc.sheets[from]
  const copy = structuredClone(src) as Sheet & { comments?: unknown; steps?: unknown[] }
  const newId = mintSheetId(doc, opts.seed)
  copy.id = newId
  copy.name = mintSheetName(doc, t('{name} (copy)').replace('{name}', src.name))
  delete copy.comments
  // Provenance, in the same shape an import writes: a dash sheet always answers
  // "where did this come from?", and "it is a copy of that one" is an answer.
  if (Array.isArray(copy.steps)) {
    copy.steps = [...copy.steps, {
      op: 'import',
      from: `duplicated from "${src.name}"`,
      at: opts.at ?? new Date().toISOString(),
      ...(isTable(src) ? { rows: rowsOf(src) } : {}),
    }]
  }
  return {
    patches: [{ op: 'setSheet', id: newId, sheet: copy as Sheet, at: from + 1 }],
    id: newId,
    sheet: copy as Sheet,
  }
}

/**
 * The sheet to show once `deleted` is gone.
 *
 * Excel's rule: the one that slides into its place, or the one to its left when
 * it was last. Only TABLE sheets can be shown — `Grid.sheet` throws on anything
 * else — so a pivot between two tables is stepped over rather than opened, and
 * `null` means the grid has nothing left to point at.
 */
export function sheetAfterDelete(doc: DashDoc, deleted: string, showing: string): string | null {
  if (showing !== deleted) return showing
  const at = doc.sheets.findIndex((s) => s.id === deleted)
  if (at < 0) return showing
  for (let i = at + 1; i < doc.sheets.length; i++) if (isOpenable(doc.sheets[i])) return doc.sheets[i].id
  for (let i = at - 1; i >= 0; i--) if (isOpenable(doc.sheets[i])) return doc.sheets[i].id
  return null
}

/**
 * Deleting a sheet: the patch, and what to show next — or the reason not to.
 *
 * The last TABLE sheet is refused, because the grid needs one to point at.
 * A pivot or a canvas has no such floor: it is a sheet like any other and
 * `setSheet` removes it whatever its kind.
 */
export function deleteSheetPlan(
  doc: DashDoc, id: string, showing: string,
): { patch: Patch; show: string | null } | { refuse: string } {
  const sheet = doc.sheets.find((s) => s.id === id)
  if (!sheet) return { refuse: t('That sheet is not in this workbook.') }
  if (isOpenable(sheet) && doc.sheets.filter(isOpenable).length < 2) {
    return { refuse: t('A workbook needs at least one sheet.') }
  }
  return {
    patch: { op: 'setSheet', id, sheet: undefined },
    show: sheetAfterDelete(doc, id, showing),
  }
}

/**
 * The sheet ctrl+PgUp / ctrl+PgDn lands on, or null at the end of the workbook.
 *
 * NON-TABLE SHEETS ARE STEPPED OVER, not stopped on: this build cannot open a
 * pivot in the grid, so landing the cursor on one would be a keypress that
 * appears to do nothing. It does NOT wrap — Excel's does not either, and a
 * wrap makes "am I at the last sheet?" unanswerable from the keyboard.
 */
export function stepSheet(doc: DashDoc, from: string, dir: -1 | 1): string | null {
  const at = doc.sheets.findIndex((s) => s.id === from)
  if (at < 0) return null
  for (let i = at + dir; i >= 0 && i < doc.sheets.length; i += dir) {
    if (isOpenable(doc.sheets[i])) return doc.sheets[i].id
  }
  return null
}

/** What a non-table tab says it is. The kind is NAMED — everything non-table
 *  used to be called a canvas sheet, which stopped being true when pivots
 *  arrived, and a label that confidently states the wrong thing is worse than
 *  a vague one. */
export function describeKind(kind: string): { chip: string; why: string } {
  if (kind === 'pivot') return { chip: t('Pivot'), why: t('pivot table — open it from ＋ Pivot') }
  // "Canvas" is the WIRE word and does not change (PLATFORM §3). What a reader
  // sees is "Spreadsheet", the same way select() localises display labels while
  // values stay model words.
  if (kind === 'canvas') return { chip: t('Spreadsheet'), why: t('spreadsheet — cells are typed one by one, and it has no columns') }
  return { chip: kind, why: t('{kind} sheet — not editable in this build').replace('{kind}', kind) }
}

// --- WHICH KIND A TAB IS, AT A GLANCE ----------------------------------------
//
// A workbook holds two kinds that behave differently enough that six toolbar
// actions apply to one and not the other — so a tab has to SAY which it is,
// before you click it and find out. It used to say so only by omission: a
// spreadsheet tab carried the word "SPREADSHEET" and a dataset tab carried
// nothing, which marks the rare case and leaves the common one blank.
//
// WHY A DRAWN MARK RATHER THAN A LETTER. Two of the three obvious answers are
// worse for reasons that are not obvious:
//
//   · A LETTER (S / D) IS AN ENGLISH WORD IN DISGUISE, and dash ships in eight
//     languages. S/D is Spreadsheet/Dataset in English alone: German is
//     Tabellenblatt/Datensatz, so the pair becomes T/D, and Japanese
//     (スプレッドシート／データセット) and Chinese (表格／数据集) have no Latin
//     initial to take at all — a translator has to invent one and no two of
//     them will agree. It is also a WORD in a strip whose entire content is
//     words: at twenty sheets the reader parses forty tokens to find out half
//     of them are not sheet names. And letters COLLIDE the moment a third kind
//     lands — dash already has `pivot`, and Spreadsheet and Story both start
//     with S. A mark has no alphabet to run out of.
//     (The six directions are drawn side by side, on both grounds, at 3/8/20
//     sheets, in dist-single/tab-kinds.html.)
//   · COLOUR ALONE is not an option at all — about 8% of men cannot separate
//     two hues reliably, and this is the only thing on screen saying what a
//     sheet IS. The mark is a SHAPE, drawn in the tab's own ink, so it carries
//     no colour information whatsoever.
//
// THE TWO SHAPES DIFFER BY FILL, NOT BY LINE COUNT. At 12px a three-line icon
// and a four-line icon are the same smudge. A SOLID BAND against an EMPTY
// LATTICE survives the size: a dataset is a header row over rows (typed
// columns, one heading each), a spreadsheet is a bare lattice of cells (no
// header, nothing typed about it). That is also what the two kinds actually
// are, so the mark is a diagram rather than a symbol to memorise.
//
// AND THE ACTIVE TAB SAYS THE WORD OUT LOUD. A mark still has to be learned
// once, and a tooltip is a poor teacher: it asks the reader to suspect there is
// something to hover. So the tab you are ON carries the kind in full, in the
// reader's own language — "Pipeline · DATASET" — and every other tab carries
// the mark alone. The named tab is the Rosetta stone for the other nineteen,
// it is the tab the eye is already on, and the word costs its ~60px on exactly
// ONE tab, so a twenty-sheet strip is no narrower than it was. The word is
// translated and the mark is not language at all, which is the pair that
// survives all eight locales.
//
// (The cost, stated: switching sheets re-widens one tab and shifts the tabs to
// its right by a word. That is what a browser tab strip does, it happens on a
// deliberate click, and it buys an answer that is on screen before it is asked
// for. On a phone the word is dropped — see tabs.css — because there the whole
// tab is 140px and the sheet's NAME is the thing that must survive.)
//
// AND IT IS NOT THE ONLY CHANNEL. Every tab that has no visible word ships a
// visually-hidden one — the SAME word — so the tab's accessible name is
// "Q1 actuals Spreadsheet", and the title attribute names the kind too. A
// sighted reader gets the shape, a screen reader gets the word, and nobody
// gets a hue they have to be able to see.

/** The reader-facing word for a kind, or '' for one that has no mark. */
export function kindWord(kind: string): string {
  if (kind === 'table') return t('Dataset')
  if (kind === 'canvas') return t('Spreadsheet')
  return ''
}

/**
 * The 14px mark for a kind — the drawing alone, for a `.dx-tab-mark` span.
 *
 * FOURTEEN PIXELS AND NOT TWELVE, and the marks are redrawn rather than merely
 * scaled. At 12px with a hairline stroke the two drawings differed by one
 * horizontal line, which is not a difference anybody reads at a glance in a
 * strip they are scanning; compared side by side (dist-single/tab-kinds.html,
 * direction A against B) the pair at 14px with a 1.25px stroke is the first one
 * that separates without being looked at. The dataset mark is a SOLID header
 * band over a divided body — typed columns, each with a heading; the
 * spreadsheet mark is an OPEN LATTICE — cells, typed one at a time, with
 * nothing above them. They differ by FILL, which survives the size, rather than
 * by how many lines are inside the box, which does not.
 *
 * Geometry note: every edge sits on a half-pixel so a stroke lands on whole
 * device pixels rather than two grey ones. The band is INSET from the outline
 * rather than filling into it, because the outline is rounded and a square fill
 * would cut its top corners off.
 */
export function kindMarkSvg(kind: string): string {
  const open = '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">'
  const box = '<rect x="1.5" y="2.5" width="11" height="9" rx="2" fill="none"' +
    ' stroke="currentColor" stroke-width="1.25"/>'
  if (kind === 'table') {
    return `${open}${box}<path d="M2.5 3.5h9v2.6h-9z" fill="currentColor"/>` +
      '<path d="M1.5 8.6h11M5.4 6.1v5.4" stroke="currentColor" stroke-width="1.25"/></svg>'
  }
  if (kind === 'canvas') {
    return `${open}${box}` +
      '<path d="M5.2 2.5v9M9 2.5v9M1.5 5.7h11M1.5 8.6h11" stroke="currentColor" stroke-width="1.25"/></svg>'
  }
  return ''
}

// --- what a toolbar action can run on ------------------------------------------
//
// ONE TABLE, AND IT HAS TO BE ONE TABLE. Every control in the top bar answers
// the same question — "can this run on the sheet in front of the reader?" — and
// the answer is a property of the sheet's KIND, not of the button. Written as
// eight guards it was right on the day each was written and wrong afterwards:
// measured on a spreadsheet sheet, Formula, Chart, 3D, Pivot, Story and Export
// were all lit, and four of them threw `Uncaught Error: grid needs a table
// sheet` into a console nobody has open — no message, no column, no chart,
// nothing at all on screen.
//
// A NINTH ACTION MUST LAND HERE. `scripts/test-dash-actions.ts` reads main.ts's
// markup, collects every `data-act`, and fails if one has no row — so the table
// cannot silently fall behind the bar. And the rule type is a UNION: a
// kind-scoped action carries `why` or it does not compile. A control that is
// unavailable without saying why teaches the reader that the toolbar is
// decorative, which is the failure this whole table exists to prevent.
//
// WHY THIS LIVES IN tabs.ts. It is the module that already knows what a kind IS
// (`isTable`, `isOpenable`, `describeKind`), it needs no DOM, and a rig can
// import it. main.ts cannot be imported at all — it boots on evaluation.
//
// DISABLED, NEVER HIDDEN. A control that vanishes reads as a bug in the app; a
// disabled one whose tooltip says "Charts bind to a dataset's columns — this is
// a spreadsheet" teaches the difference the two kinds exist to express.

/** Every `data-act` in the top bar. */
export type ActionId =
  | 'formula' | 'chart' | 'viz3d' | 'pivot' | 'dashboard' | 'story'
  | 'undo' | 'redo'
  | 'import' | 'export' | 'import-xlsx' | 'export-xlsx'
  | 'print'
  | 'save' | 'about' | 'settings' | 'help'

/**
 * `on: 'workbook'` means the action is not about the sheet on screen at all —
 * Save, Undo, Import — so no sheet can make it unavailable and it needs no
 * reason. Anything else names the kinds it runs on and MUST say why it does not
 * run on the others.
 */
export type ActionRule =
  | { on: 'workbook' }
  | { on: readonly string[]; why: (kind: string) => string }

/**
 * The reasons, spelled out per action rather than composed from a noun and a
 * sentence frame: a translator needs the whole sentence, and "{what} needs a
 * {kind}" is not a sentence in every language. Each gated action gets two — one
 * for a spreadsheet, which is the distinction worth teaching, and one for any
 * other kind, which is a pivot today and something else later.
 *
 * t() IS CALLED INSIDE THE FUNCTION, never at module level: a catalogue loaded
 * after this module is imported would otherwise never reach these strings.
 */
export const ACTIONS: Readonly<Record<ActionId, ActionRule>> = {
  formula: {
    on: ['table'],
    why: (k) => k === 'canvas'
      ? t('A formula column fills every row of a dataset. This is a spreadsheet — type = in a cell instead.')
      : t('A formula column fills every row of a dataset, and this sheet is not one.'),
  },
  chart: {
    on: ['table'],
    why: (k) => k === 'canvas'
      ? t('Charts bind to a dataset’s columns — this is a spreadsheet.')
      : t('Charts bind to a dataset’s columns, and this sheet has none.'),
  },
  viz3d: {
    on: ['table'],
    why: (k) => k === 'canvas'
      ? t('A 3D plot binds three of a dataset’s columns — this is a spreadsheet.')
      : t('A 3D plot binds three of a dataset’s columns, and this sheet has none.'),
  },
  pivot: {
    on: ['table'],
    why: (k) => k === 'canvas'
      ? t('A pivot summarises a dataset’s columns — this is a spreadsheet.')
      : t('A pivot summarises a dataset’s columns, and this sheet has none.'),
  },
  story: {
    on: ['table'],
    why: (k) => k === 'canvas'
      ? t('A story step saves a dataset’s view — its filters, sorts and chart. A spreadsheet has none.')
      : t('A story step saves a dataset’s view — its filters, sorts and chart. This sheet has none.'),
  },
  export: {
    on: ['table'],
    why: (k) => k === 'canvas'
      ? t('A CSV is one header row and one row per row. A spreadsheet has no columns to name — make a range into a dataset first.')
      : t('A CSV is one header row and one row per row, and this sheet has no columns to name.'),
  },
  // Workbook-scoped, every one of them: they are about the FILE, and the sheet
  // in front of the reader cannot make them wrong. Excel disables none of these
  // on a worksheet either.
  dashboard: { on: 'workbook' },
  undo: { on: 'workbook' },
  redo: { on: 'workbook' },
  import: { on: 'workbook' },
  'import-xlsx': { on: 'workbook' },
  'export-xlsx': { on: 'workbook' },
  // Print is workbook-scoped even though its default is the sheet on screen:
  // the dialog offers both, prints EITHER kind, and Excel disables Print on no
  // worksheet either. A greyed Print button is the one control whose absence a
  // reader reads as "this app cannot print".
  print: { on: 'workbook' },
  save: { on: 'workbook' },
  about: { on: 'workbook' },
  // Language, appearance and the update check follow the READER and are kept in
  // this browser — none of them is a fact about a sheet, so no sheet kind can
  // make them inapplicable.
  settings: { on: 'workbook' },
  help: { on: 'workbook' },
}

/** The table's own key list — what a caller iterates, and what the rig checks
 *  main.ts's markup against. */
export const ACTION_IDS = Object.keys(ACTIONS) as ActionId[]

/** Does this action run on a sheet of this kind? `''` = the grid points at no
 *  sheet at all, which is a kind nothing sheet-scoped can run on. */
export function actionApplies(id: ActionId, kind: string): boolean {
  const rule = ACTIONS[id]
  if (!rule) return true              // unknown id: never disable what we cannot explain
  if (rule.on === 'workbook') return true
  return rule.on.includes(kind)
}

/**
 * Why it cannot run here — `''` when it can.
 *
 * THE SAME STRING TWICE, deliberately: the tooltip on the disabled button and
 * the banner a stale click reports are one sentence, so a reader who clicks
 * anyway is told exactly what the tooltip already said rather than something
 * new to reconcile.
 */
export function actionReason(id: ActionId, kind: string): string {
  if (actionApplies(id, kind)) return ''
  const rule = ACTIONS[id]
  if (rule.on === 'workbook') return ''
  // The grid points at a sheet that is not in the document any more — a
  // delete, an undo, a remote op. Not "unavailable": say which of the two
  // things is missing, because the reader can fix this one by clicking a tab.
  if (!kind) return t('No sheet is open, so there is nothing for this to run on.')
  return rule.why(kind)
}

// --- mount -------------------------------------------------------------------

export interface TabsHost {
  store: Store
  grid: Grid
  /** the `.dx-body` element — the strip is inserted directly after it, so it
   *  lands between the grid and the status bar without main.ts changing shape */
  body: HTMLElement
}

export interface Tabs {
  /** Rebuild now (a caller that changed the sheet list out of band). */
  refresh(): void
  /** Show or hide the strip — what `[` does now the sheets panel is gone. */
  toggle(): void
}

export function mountTabs(host: TabsHost): Tabs {
  const { store, grid } = host

  const nav = document.createElement('nav')
  nav.className = 'dx-tabs'
  nav.setAttribute('role', 'tablist')
  nav.setAttribute('aria-label', t('Sheets'))

  const addBtn = iconButton('dx-tab-add', '＋', t('New sheet'))
  const allBtn = iconButton('dx-tab-all', '☰', t('All sheets'))
  const strip = document.createElement('div')
  strip.className = 'dx-tab-strip'
  const showBtn = iconButton('dx-tab-show', '⌃', t('Show sheet tabs ([)'))
  const hideBtn = iconButton('dx-tab-hide', '⌄', t('Hide sheet tabs ([)'))

  nav.append(showBtn, addBtn, allBtn, strip, hideBtn)
  host.body.after(nav)

  let shut = lsGet(LS_SHUT) === '1'
  applyShut()

  function applyShut(): void {
    nav.classList.toggle('dx-tabs-shut', shut)
  }

  function toggle(): void {
    shut = !shut
    lsSet(LS_SHUT, shut ? '1' : '0')
    applyShut()
    if (!shut) scrollActiveIntoView()
  }
  showBtn.addEventListener('click', toggle)
  hideBtn.addEventListener('click', toggle)

  const ro = (): boolean => store.readOnly

  /**
   * The sheet the grid is showing, read from the GRID — import and the About
   * dialog switch sheets too, so a local copy goes stale.
   *
   * `showingId()`, NOT `grid.sheet.id`. `sheet` narrows to a dataset and throws
   * on anything else, and the try/catch that used to wrap it turned "I am on a
   * spreadsheet" into "no sheet is open": measured, a workbook sitting on a
   * spreadsheet tab highlighted NO tab at all, `stepSheet` walked from nowhere
   * so ctrl+PgUp did nothing, and the strip could not tell a sheet switch from
   * a repaint. The kind-agnostic accessor is the whole fix.
   */
  function showing(): string {
    return grid.showingId()
  }

  function commit(p: Patch | Patch[]): void {
    if (ro()) return
    store.commit(p)
  }

  // --- painting ---------------------------------------------------------------

  /** What the strip is currently drawing. A `doc` event fires on every
   *  keystroke in a cell; rebuilding twenty tabs for a character typed into one
   *  is work nobody asked for, and it would also destroy an open rename. */
  let drawn = ''
  let renaming = false

  const signature = (): string =>
    `${ro() ? 'r' : 'w'}|${showing()}|` +
    store.doc.sheets.map((s) => `${s.id}${s.name}${String((s as { kind?: unknown }).kind ?? '')}`).join('')

  function refresh(force = false): void {
    if (renaming && !force) return
    const sig = signature()
    if (!force && sig === drawn) return
    drawn = sig
    build()
  }

  function build(): void {
    strip.textContent = ''
    const cur = showing()
    addBtn.hidden = ro()
    for (const sheet of store.doc.sheets) strip.appendChild(tabEl(sheet, sheet.id === cur))
    scrollActiveIntoView()
  }

  function tabEl(sheet: Sheet, active: boolean): HTMLElement {
    const kind = String((sheet as { kind?: unknown }).kind ?? '')
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'dx-tab'
    el.dataset.sheet = sheet.id
    el.setAttribute('role', 'tab')
    el.setAttribute('aria-selected', String(active))
    if (active) el.classList.add('active')

    // THE MARK LEADS. Every tab starts at the same place, so the marks form a
    // column down the strip that can be scanned without reading a single name;
    // trailing them would put each one at a different x, which is a list of
    // marks nobody can compare.
    const svg = kindMarkSvg(kind)
    if (svg) {
      const mark = document.createElement('span')
      mark.className = 'dx-tab-mark'
      mark.innerHTML = svg
      el.appendChild(mark)
    }

    const label = document.createElement('span')
    label.className = 'dx-tab-name'
    label.textContent = sheet.name || t('(untitled sheet)')
    el.appendChild(label)

    // The word: PRINTED on the active tab, hidden on every other one. Either
    // way it comes after the name, so the accessible name reads "Q1 actuals
    // Spreadsheet" — the sheet first, then what it is — and a reader using a
    // screen reader hears the same sentence on all of them, active or not.
    const word = kindWord(kind)
    if (svg && word) {
      const w = document.createElement('span')
      w.className = active ? 'dx-tab-word' : 'dx-tab-sr'
      w.textContent = word
      el.appendChild(w)
    }

    if (!isOpenable(sheet)) {
      // HONEST, NOT HIDDEN. The sheet is really in the file; a tab that is
      // missing reads as a sheet that was deleted. The chip says what it is at
      // a glance and the tooltip says why it will not open.
      const { chip, why } = describeKind(kind)
      el.classList.add('dx-tab-off')
      el.title = `${sheet.name} — ${why}`
      const badge = document.createElement('span')
      badge.className = 'dx-tab-kind'
      badge.textContent = chip
      el.appendChild(badge)
    } else if (isTable(sheet)) {
      // The kind is NAMED in the tooltip as well as drawn: a mark you have not
      // met yet is a mark you can hover.
      el.title = `${sheet.name} — ${kindWord('table')} · ${rowsOf(sheet)} × ${sheet.columns.length}`
    } else {
      // A spreadsheet has no row or column COUNT to report — it is sparse and
      // unbounded, so the only honest number is how many cells hold something.
      // (The existing sentence already opens with the kind, so it needs no
      // second naming.)
      const n = Object.keys((sheet as CanvasSheet).cells ?? {}).length
      el.title = `${sheet.name} — ${t('spreadsheet, {n} cell(s) used').replace('{n}', String(n))}`
    }
    return el
  }

  /**
   * Keep the active tab on screen — after a rebuild, after a resize, after a
   * sheet switch from anywhere else in the app.
   *
   * BY RECTANGLES, not by `offsetLeft`. `offsetLeft` is measured from the
   * nearest POSITIONED ancestor, and the strip is `position: static` — so on
   * this page a tab's `offsetLeft` is measured from `<body>` (1469px for a tab
   * whose left edge is 1291px on screen, with the strip scrolled 178px). The
   * first version of this compared that number against `strip.scrollLeft` and
   * was simply wrong; it looked right only because the answer it computed was
   * usually past the end and got clamped to the maximum scroll.
   *
   * `scrollIntoView` would be shorter and is not an option: it scrolls every
   * scrollable ANCESTOR, up to and including the page.
   */
  function scrollActiveIntoView(): void {
    const el = strip.querySelector<HTMLElement>('.dx-tab.active')
    if (!el || !strip.clientWidth) return
    const pad = 8
    const s = strip.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (r.left < s.left + pad) strip.scrollLeft -= (s.left + pad) - r.left
    else if (r.right > s.right - pad) strip.scrollLeft += r.right - (s.right - pad)
  }

  const tabAt = (e: Event): HTMLElement | null =>
    (e.target as HTMLElement | null)?.closest?.('.dx-tab') ?? null

  const sheetOf = (el: HTMLElement): Sheet | undefined =>
    store.doc.sheets.find((s) => s.id === el.dataset.sheet)

  // --- switching ---------------------------------------------------------------

  strip.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; return }
    const el = tabAt(e)
    if (!el) return
    const sheet = sheetOf(el)
    if (!sheet) return
    // A tab this build cannot open explains itself rather than doing nothing:
    // the menu's first line is what the sheet IS, and the operations that DO
    // work on it (duplicate, delete, move) are right there under it.
    if (!isOpenable(sheet)) { openMenu(el, sheet); return }
    if (sheet.id === showing()) return
    grid.setSheet(sheet.id)
  })

  strip.addEventListener('dblclick', (e) => {
    const el = tabAt(e)
    if (!el || ro()) return
    const sheet = sheetOf(el)
    // A NAME IS A NAME WHATEVER THE KIND, and there is no longer any exception.
    // Renaming writes `setSheetProps`, which touches nothing but the name — but
    // `applyPatch` narrowed that op to a dataset, so a rename of anything else
    // built a valid patch and THREW at commit. The strip papered over the throw
    // by refusing first, in two different voices: "Only a table sheet can be
    // renamed in this build", and later a refusal for sheets the grid cannot
    // open, reasoned as "the rename box is drawn on the tab". Neither was the
    // real reason and the second is not even true — the box is drawn on the
    // tab, and a pivot has a tab. The narrowing is gone (store.ts), so this is
    // too.
    if (!sheet) return
    e.preventDefault()
    startRename(el, sheet)
  })

  strip.addEventListener('contextmenu', (e) => {
    const el = tabAt(e)
    if (!el) return
    e.preventDefault()
    const sheet = sheetOf(el)
    if (sheet) openMenu(el, sheet)
  })

  // A mouse wheel has no horizontal axis, so without this a twenty-sheet strip
  // is reachable only by dragging its scrollbar. Claimed ONLY when the strip
  // actually overflows, or it would swallow a scroll gesture aimed at the page.
  strip.addEventListener('wheel', (e) => {
    if (strip.scrollWidth <= strip.clientWidth) return
    if (e.deltaX !== 0 || e.deltaY === 0) return
    strip.scrollLeft += e.deltaY
    e.preventDefault()
  }, { passive: false })

  // --- rename in place ---------------------------------------------------------

  function startRename(el: HTMLElement, sheet: Sheet): void {
    const label = el.querySelector<HTMLElement>('.dx-tab-name')
    if (!label) return
    // A tab the grid cannot open answers a CLICK with the menu, so a
    // double-click on one opens the menu and then starts the rename underneath
    // it — an input the reader cannot see, taking keystrokes.
    document.querySelector('.dx-tab-menu')?.remove()
    renaming = true
    const input = document.createElement('input')
    input.className = 'dx-tab-rename'
    input.value = sheet.name
    label.replaceWith(input)
    input.focus()
    input.select()
    let done = false
    const finish = (write: boolean): void => {
      if (done) return
      done = true
      renaming = false
      if (write) {
        const p = renameSheetPatch(sheet, input.value)
        if (p) commit(p)
      }
      refresh(true)
    }
    input.addEventListener('blur', () => finish(true))
    input.addEventListener('keydown', (e) => {
      // the grid owns bare keys otherwise, and a typed letter would land in a cell
      e.stopPropagation()
      if (e.key === 'Enter') finish(true)
      else if (e.key === 'Escape') finish(false)
    })
    getSelection()?.removeAllRanges()
  }

  // --- reorder -----------------------------------------------------------------
  //
  // Mouse events with a threshold, so a click is still a click and a synthetic
  // drag still exercises the real code path. See the header for why this is not
  // HTML5 drag-and-drop.

  let suppressClick = false

  strip.addEventListener('mousedown', (down) => {
    if (down.button !== 0 || ro()) return
    const el = tabAt(down)
    if (!el) return
    const id = el.dataset.sheet
    if (!id) return
    const startX = down.clientX
    let dragging = false

    const move = (e: MouseEvent): void => {
      if (!dragging) {
        if (Math.abs(e.clientX - startX) < DRAG_SLOP) return
        dragging = true
        el.classList.add('dx-tab-dragging')
      }
      // near an edge, walk the strip along under the pointer, or a tab can only
      // ever be dropped somewhere already on screen
      const box = strip.getBoundingClientRect()
      if (e.clientX < box.left + 24) strip.scrollLeft -= 12
      else if (e.clientX > box.right - 24) strip.scrollLeft += 12
      paintGap(gapAt(e.clientX))
    }
    const up = (e: MouseEvent): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (!dragging) return
      el.classList.remove('dx-tab-dragging')
      paintGap(-1)
      // The mouseup fires a click and it is not one — and by now the strip has
      // been rebuilt underneath it, so without this the click would land on
      // whatever node took the pressed tab's place.
      suppressClick = true
      const from = store.doc.sheets.findIndex((s) => s.id === id)
      commit(moveSheetPatches(store.doc, id, dropIndex(from, gapAt(e.clientX))))
      // A DRAGGED TAB BECOMES THE OPEN ONE, which is what Excel and Sheets both
      // do (they select on the press that starts the drag). Without it you can
      // move a sheet you cannot see, and the strip has no reason to scroll the
      // tab you just dropped back into view.
      const moved = store.doc.sheets.find((s) => s.id === id)
      if (moved && isOpenable(moved) && id !== showing()) grid.setSheet(id)
      refresh(true)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })

  /** Which GAP the pointer is over: 0 before the first tab, n after the last. */
  function gapAt(clientX: number): number {
    const tabs = [...strip.querySelectorAll<HTMLElement>('.dx-tab')]
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect()
      if (clientX < r.left + r.width / 2) return i
    }
    return tabs.length
  }

  function paintGap(gap: number): void {
    const tabs = [...strip.querySelectorAll<HTMLElement>('.dx-tab')]
    tabs.forEach((el, i) => {
      el.classList.toggle('dx-tab-drop-before', gap === i)
      el.classList.toggle('dx-tab-drop-after', gap === tabs.length && i === tabs.length - 1)
    })
  }

  // --- menus --------------------------------------------------------------------

  /** A popover ABOVE its anchor: the strip is at the bottom of the window, so
   *  a menu dropped downwards would open off the screen. */
  function popover(anchor: HTMLElement): HTMLElement {
    document.querySelector('.dx-tab-menu')?.remove()
    const el = document.createElement('div')
    el.className = 'dx-tab-menu'
    document.body.appendChild(el)
    const r = anchor.getBoundingClientRect()
    el.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - 226))}px`
    el.style.bottom = `${Math.max(6, window.innerHeight - r.top + 4)}px`
    setTimeout(() => {
      const off = (e: Event): void => {
        if (el.contains(e.target as Node)) return
        el.remove()
        document.removeEventListener('mousedown', off)
      }
      document.addEventListener('mousedown', off)
    }, 0)
    return el
  }

  function menuItem(
    host_: HTMLElement, label: string, onClick: () => void, disabled = false, why = '',
  ): void {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.disabled = disabled
    if (why) b.title = why
    b.addEventListener('click', () => {
      host_.remove()
      onClick()
    })
    host_.appendChild(b)
  }

  function menuNote(host_: HTMLElement, text: string): void {
    const p = document.createElement('p')
    p.className = 'dx-tab-note'
    p.textContent = text
    host_.appendChild(p)
  }

  function openMenu(el: HTMLElement, sheet: Sheet): void {
    const menu = popover(el)
    const kind = String((sheet as { kind?: unknown }).kind ?? '')
    const table = isTable(sheet)
    if (!table) menuNote(menu, describeKind(kind).why)
    if (ro()) {
      menuNote(menu, t('This workbook is open read-only, so its sheets cannot be changed.'))
      return
    }
    const at = store.doc.sheets.findIndex((s) => s.id === sheet.id)
    // NEVER DISABLED. Every sheet has a name and every sheet has a tab to draw
    // the rename box on, including the kinds the grid cannot open.
    menuItem(menu, t('Rename'), () => startRename(el, sheet))
    menuItem(menu, t('Duplicate'), () => {
      const r = duplicateSheetPatches(store.doc, sheet.id)
      if (!r) return
      commit(r.patches)
      if (isOpenable(r.sheet)) grid.setSheet(r.id)
      refresh(true)
    })
    sep(menu)
    menuItem(menu, t('Move left'), () => {
      commit(nudgeSheetPatches(store.doc, sheet.id, -1))
      refresh(true)
    }, at <= 0)
    menuItem(menu, t('Move right'), () => {
      commit(nudgeSheetPatches(store.doc, sheet.id, 1))
      refresh(true)
    }, at < 0 || at >= store.doc.sheets.length - 1)
    sep(menu)
    menuItem(menu, t('Delete'), () => removeSheet(sheet))
  }

  function sep(menu: HTMLElement): void {
    const d = document.createElement('div')
    d.className = 'dx-tab-sep'
    menu.appendChild(d)
  }

  function removeSheet(sheet: Sheet): void {
    if (ro()) return
    const plan = deleteSheetPlan(store.doc, sheet.id, showing())
    if ('refuse' in plan) { window.alert(plan.refuse); return }
    // Undoable, so the warning no longer has to say otherwise — but a sheet is
    // a lot of rows to remove on one click, so it still asks.
    const msg = isTable(sheet)
      ? t('Delete "{name}" and its {n} rows?')
        .replace('{name}', sheet.name).replace('{n}', String(rowsOf(sheet)))
      : t('Delete "{name}"?').replace('{name}', sheet.name)
    if (!window.confirm(msg)) return
    commit(plan.patch)
    if (plan.show && plan.show !== showing()) grid.setSheet(plan.show)
    refresh(true)
  }

  /** Make a sheet of either kind and show it. */
  const addSheetOf = (kind: 'table' | 'canvas'): void => {
    if (ro()) return
    const doc = store.doc
    const id = mintSheetId(doc)
    const sheet = kind === 'canvas'
      ? blankSpreadsheet(id, mintSheetName(doc, t('Spreadsheet')))
      : blankSheet(id, mintSheetName(doc, t('Sheet')), new Date().toISOString())
    commit({ op: 'setSheet', id, sheet })
    grid.setSheet(id)
    refresh(true)
  }

  // THE TWO KINDS ARE OFFERED AT THE POINT OF CREATION, because that is the only
  // moment the choice is cheap — and a menu of two is the plainest way to teach
  // that the difference exists at all. A plain click still makes a dataset: it
  // is what the app was, and what an import produces.
  addBtn.addEventListener('click', () => {
    if (ro()) return
    const menu = popover(addBtn)
    // Widens the menu and lets its rows wrap — the explanation is the point of
    // this menu, and at the shared 220px it was ellipsed mid-phrase.
    menu.classList.add('dx-tab-menu-kinds')
    const row = (label: string, why: string, kind: 'table' | 'canvas'): void => {
      const b = document.createElement('button')
      b.className = 'dx-tab-menu-row'
      b.innerHTML = ''
      const strong = document.createElement('span')
      strong.className = 'dx-tab-menu-title'
      strong.textContent = label
      const sub = document.createElement('span')
      sub.className = 'dx-tab-menu-why'
      sub.textContent = why
      b.append(strong, sub)
      b.addEventListener('click', () => { menu.remove(); addSheetOf(kind) })
      menu.appendChild(b)
    }
    row(t('Dataset'), t('Typed columns — for volume, joins and charts'), 'table')
    row(t('Spreadsheet'), t('Typed cells — for a scratch pad, and =SUM anywhere'), 'canvas')
  })

  /**
   * Every sheet in one list — the half of the overflow answer a scrolling strip
   * cannot give. At twenty sheets, "go to the one called Q3" is one gesture
   * here and an unbounded amount of scrolling in the strip.
   */
  allBtn.addEventListener('click', () => {
    const menu = popover(allBtn)
    menu.classList.add('dx-tab-menu-all')
    const cur = showing()
    for (const sheet of store.doc.sheets) {
      // OPENABLE, not table. This list gated on `isTable`, so the one route to
      // a sheet twenty tabs along refused to open a SPREADSHEET — greyed out,
      // with a tooltip explaining what a spreadsheet is as though that were the
      // reason — while clicking its tab opened it perfectly well. Exactly the
      // trap this file's own header names: `isTable` answers "has columns",
      // `isOpenable` answers "does clicking do anything", and only the second
      // one is what a navigation list is asking.
      const open = isOpenable(sheet)
      const kind = String((sheet as { kind?: unknown }).kind ?? '')
      const label = (sheet.id === cur ? '✓ ' : '') + (sheet.name || t('(untitled sheet)')) +
        (isTable(sheet) ? '' : ` · ${describeKind(kind).chip}`)
      menuItem(menu, label, () => {
        if (!open) return
        grid.setSheet(sheet.id)
      }, !open, open ? '' : describeKind(kind).why)
    }
  })

  // --- keyboard -----------------------------------------------------------------
  //
  // ctrl+PgUp / ctrl+PgDn is Excel's binding and the one people have. It is
  // implemented HERE, in the CAPTURE phase, exactly as panels.ts claims `[`:
  // select.ts maps a bare PageUp/PageDown to "move one screen", so a bubble
  // listener would arrive after the grid had already scrolled a page.
  //
  // ctrl+alt is the SECOND chord, and it is not decoration: on Windows and
  // Linux, Chrome reserves ctrl+PgUp/PgDn for switching BROWSER tabs and the
  // page never sees the key. Excel for the web added ctrl+alt+PgUp/PgDn for
  // that exact reason; a shortcut that works on one platform only is a
  // shortcut people learn not to trust.
  /**
   * `[` shows and hides the strip — Excel's "Show sheet tabs" option, on a key.
   *
   * It used to open and close the SHEETS PANEL, and select.ts still declares it
   * as `panel.left`; the panel is gone, so rather than leave a declared binding
   * that does nothing, it toggles the thing the sheets moved into. CAPTURE
   * phase for the same reason panels.ts claims `]` there: main.ts hands any
   * bare printable key to `grid.typeInto`, so a bubble listener would arrive
   * after a cell editor had opened seeded with "[".
   */
  document.addEventListener('keydown', (e) => {
    if (e.key !== '[') return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    toggle()
  }, true)

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'PageUp' && e.key !== 'PageDown') return
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const next = stepSheet(store.doc, showing(), e.key === 'PageUp' ? -1 : 1)
    if (next) grid.setSheet(next)
  }, true)

  // --- keeping up ----------------------------------------------------------------

  /**
   * THE SHEET ON SCREEN IS ABOUT TO BE REMOVED — get off it first.
   *
   * `Grid.sheet` THROWS when the id it holds names nothing, and the grid's own
   * `doc` listener is registered at construction, so it runs before anything
   * here could clean up afterwards. The obvious route in is undo: duplicate a
   * sheet (which opens the copy), press ⌘Z, and the patch that removes the copy
   * takes the grid's own sheet with it. MEASURED before this existed —
   * `Uncaught Error: grid needs a table sheet` out of `applyView`, mid-undo,
   * with the document already half-changed. Adding a sheet and undoing that had
   * the same shape long before the tabs moved; it was simply harder to reach
   * from a panel than it is from a ＋ two pixels from the tab.
   *
   * `beforePatch` is the only hook that runs BEFORE the document changes, and
   * it fires for undo and redo as well as for edits (store.ts `invert`), which
   * is exactly the coverage this needs. `window.bento.commit` comes through
   * here too.
   */
  store.beforePatch((patches) => {
    const cur = showing()
    if (!cur) return
    // `isOpenable`, not `isTable`: a SPREADSHEET renders now, so a patch that
    // replaces the showing sheet with one is not a sheet the grid has to flee.
    // Reading it as doomed jumped the reader to a different tab for no reason;
    // reading a canvas→pivot swap as safe would leave the grid pointing at a
    // sheet it cannot paint, which is the throw this hook exists to prevent.
    const doomed = patches.some((p) =>
      p.op === 'setSheet' && p.id === cur &&
      (p.sheet === undefined || !isOpenable(p.sheet)))
    if (!doomed) return
    // computed against the document as it still is, which is what makes the
    // neighbour the RIGHT neighbour
    const next = sheetAfterDelete(store.doc, cur, cur)
    if (next && next !== cur) grid.setSheet(next)
  })

  // A NARROWER WINDOW HIDES A TAB THAT WAS ON SCREEN. Nothing rebuilds on a
  // resize — the sheet list has not changed — so the strip kept whatever
  // scrollLeft it had and the active tab silently left the visible run.
  // MEASURED at twenty sheets: 1400px → 900px put the current sheet 200px past
  // the right edge with no indication that it existed.
  window.addEventListener('resize', () => scrollActiveIntoView())

  store.on('doc', () => refresh())
  // CHAINED, never replaced: panels.ts hangs its own rebuild off this callback
  // and main.ts's import path is what fires it.
  const announced = grid.onSheetChange
  grid.onSheetChange = (id: string) => {
    announced?.(id)
    refresh()
  }

  refresh(true)
  return { refresh: () => refresh(true), toggle }
}

function iconButton(cls: string, glyph: string, title: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `dx-tab-btn ${cls}`
  b.textContent = glyph
  b.title = title
  b.setAttribute('aria-label', title)
  return b
}
