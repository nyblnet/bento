// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Per-cell APPEARANCE, on BOTH kinds of sheet.
//
// dash has two kinds of sheet and the difference is where the TYPE lives
// (docs/dash-sheet-kinds.md): a spreadsheet (`kind:'canvas'`) is typed by the
// CELL, a dataset (`kind:'table'`) is typed by the COLUMN. That difference is
// real and worth keeping. It is not a reason for one of them to be unable to
// bold a cell — which is where this file starts: the spreadsheet kind had
// format, bold, align and colours per cell and the dataset kind had none, so
// ⌘B did different things depending on which tab you were looking at.
//
// ═══ THE ONE LINE THIS FILE EXISTS TO HOLD ════════════════════════════════
//
//   ON A DATASET, APPEARANCE IS NOT A BACK DOOR TO A TYPE.
//
// The column type is what earns a dataset its column formulas, its refusal to
// guess on import, its chart binding and its columnar speed. So everything
// here changes how a cell is DRAWN and nothing here changes what it IS:
//
//   * Nothing in this file ever writes `v`, `f`, `was`, `xlsxF`, `froze`,
//     `by`, `at` or `why` on a `CellOverride`. `APPEARANCE_FIELDS` is the
//     complete set of keys it may touch, and `appearancePatch` writes through
//     it rather than spreading an object.
//   * `format` on a dataset cell is a DISPLAY PATTERN AND NOTHING ELSE.
//     `overrideFormatPatch` stamps the pattern and never re-reads the value.
//     That is the whole difference from the spreadsheet kind, where applying a
//     format DOES re-read (cellprops.ts rules 6–8) because on that kind the
//     format is how an author declares what the cell is. Same control, same
//     word on screen, deliberately different depth — and the dataset panel
//     says so in a note rather than leaving the reader to find out.
//   * An appearance-only override carries no `v`, so every reader of the
//     overlay skips it: they all ask `'v' in over` (grid.ts, preview.ts,
//     steps.ts `applyOverrides`, xlsx export) rather than testing the
//     override's existence. Bolding a cell therefore cannot change a total, a
//     chart, a pivot or an export by one digit. That is checked, not assumed —
//     `scripts/test-dash-cellfmt.ts` runs a sum through `sourceOf` before and
//     after bolding every cell in the sheet.
//
// The one place the line is genuinely blurry is worth naming rather than
// hiding: `wrap` changes a row's HEIGHT, so it is appearance that has a layout
// consequence, and on a dataset the row heights are uniform. It is stored per
// cell (a wrapped cell is what the author marked) and the grid grows the row it
// is in — the same thing a column width does, and nobody calls a width a type.
//
// ═══ WHY A SEPARATE FILE FROM cellprops.ts ════════════════════════════════
//
// cellprops.ts is the SPREADSHEET kind's file and its header says so: nine
// coercion rules about what a cell IS, which are meaningless on a dataset. If
// appearance had been added there, the dataset would have had to import the
// spreadsheet's type engine to bold a cell — and the first person to reuse a
// helper across that seam would have carried the coercion with it. So the
// vocabulary lives here, both kinds import it, and cellprops.ts keeps the
// rules. cellprops.ts's `stylePatch` still exists and is still the canvas
// writer; it now writes through `applyAppearance` so the two kinds cannot
// drift on what "clear" means.
//
// NOTHING HERE IMPORTS grid.ts, for the reason cellprops.ts gives: the grid is
// meant to call in, and a module the grid imports must not import it back.

import './cellprops.css'
import { t } from './i18n.ts'
import { APPEARANCE_FIELDS, type AppearanceField } from './model.ts'
import type { CellOverride, Column, TableSheet } from './model.ts'
import type { Patch } from './store.ts'

// --- the vocabulary ---------------------------------------------------------

/**
 * The field list lives in model.ts, because sync/crdt.ts needs it too and that
 * file may not import this one (it runs in a node rig with no DOM). Re-exported
 * here because this is the module every writer and painter goes through, and
 * "which fields are appearance" is a question about this file.
 */
export { APPEARANCE_FIELDS }
export type { AppearanceField }

const IS_APPEARANCE = new Set<string>(APPEARANCE_FIELDS)

/** Is this key one this file is allowed to write? The guard, not a hint. */
export const isAppearanceField = (k: string): k is AppearanceField => IS_APPEARANCE.has(k)

/**
 * What a cell can look like. Structurally a subset of BOTH `CanvasCell` and
 * `CellOverride`, which is what lets one painter and one panel serve the two.
 */
export interface Appearance {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  wrap?: boolean
  align?: string
  color?: string
  bg?: string
  border?: string
  borderColor?: string
  borderStyle?: string
}

/** A write. `null` CLEARS — and clearing DELETES the key (see `applyAppearance`). */
export type AppearanceEdit = Partial<Record<AppearanceField, string | boolean | null>>

export const ALIGNS = ['left', 'center', 'right'] as const
export const BORDER_STYLES = ['solid', 'dashed', 'dotted'] as const
/** Edges, in the order `border` spells them. */
export const EDGES = ['t', 'r', 'b', 'l'] as const

/**
 * The edge sets the dropdown offers. Anything else a file carries is "custom"
 * and the dropdown stays out of it, exactly as cellprops.ts does with a
 * hand-written number pattern.
 *
 * "Box" is every edge OF EVERY SELECTED CELL, not a perimeter around the
 * selection — those are different pictures and the label has to be the one
 * that is true. A perimeter needs to know which cell is on which side of the
 * selection, which is a per-cell edge decision this control does not make.
 */
export const BORDER_PRESETS = ['', 'trbl', 'b', 't', 'l', 'r'] as const

/** A `border` string, normalised: known edges, in `EDGES` order, no repeats. */
export function normaliseEdges(spec: unknown): string {
  if (typeof spec !== 'string') return ''
  const has = new Set(spec.toLowerCase().split(''))
  return EDGES.filter((e) => has.has(e)).join('')
}

// --- writing ----------------------------------------------------------------

/**
 * Apply an edit to a cell, returning the cell to store — or `null` when there
 * is nothing left in it at all.
 *
 * A CLEARED FIELD IS DELETED. `false`, `''` and `null` all mean absent, and
 * absent is what gets written: a stored `bold: false` says what absence
 * already says, and it makes an un-bolded cell unequal to a cell nobody ever
 * bolded — which is a difference in the saved file and, under collaboration, a
 * fingerprint that does not match. cellprops.ts made this argument for the
 * canvas kind first; this is the same rule, now in one place for both.
 *
 * Keys OUTSIDE `APPEARANCE_FIELDS` are ignored rather than written. On a
 * dataset that is the type boundary made mechanical: a caller that passes `v`
 * cannot smuggle it through this function.
 */
export function applyAppearance<T extends Record<string, unknown>>(
  prev: T | undefined, edit: AppearanceEdit,
): T | null {
  const next = { ...(prev ?? {}) } as Record<string, unknown>
  for (const [k, v] of Object.entries(edit)) {
    if (!isAppearanceField(k)) continue
    if (v === null || v === undefined || v === '' || v === false) delete next[k]
    else next[k] = v
  }
  return Object.keys(next).length ? next as T : null
}

/** Shallow equality over a cell's own keys — is this write a no-op? */
export function sameCell(
  a: Record<string, unknown> | null, b: Record<string, unknown> | undefined,
): boolean {
  if (a === null) return b === undefined
  if (b === undefined) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => a[k] === b[k])
}

/**
 * What ⌘B should DO to this selection.
 *
 * Every cell already on → turn it off; anything else → turn it all on. The
 * alternative (follow the anchor cell) is Excel's, and it means the same
 * keystroke over the same pixels does opposite things depending on which
 * corner the drag started in. Whole-selection agreement is the rule a person
 * can predict without looking at their own cursor.
 */
export function toggleTarget(
  cells: ReadonlyArray<Record<string, unknown> | undefined>, field: AppearanceField,
): boolean {
  if (!cells.length) return true
  return !cells.every((c) => c?.[field] === true)
}

// --- painting ---------------------------------------------------------------

const cssColor = (v: unknown): string | null =>
  typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim()) ? v.trim() : null

/**
 * The inline CSS a cell's appearance produces — the ONE answer both grids need.
 *
 * Returned as a `;`-prefixed fragment because both of grid.ts's paint loops
 * build a style string by `+=`, which is the shape the hook has to fit. It
 * emits nothing at all for a cell with no appearance, so the common row costs
 * one function call and no string.
 *
 * COLOURS ARE FILTERED, and that is not paranoia about our own panel — a
 * document is untrusted input (docs/PLATFORM.md, and the kernel's own rule
 * since #277). These values are interpolated into a `style="…"` attribute
 * built by string concatenation, so a `bg` of `red;background:url(...)` would
 * be a stylesheet somebody else wrote. Only `#rrggbb`-shaped strings pass.
 */
export function appearanceCss(cell: Appearance | undefined | null): string {
  if (!cell) return ''
  let st = ''
  const bg = cssColor(cell.bg)
  if (bg) st += `;background:${bg}`
  const fg = cssColor(cell.color)
  if (fg) st += `;color:${fg}`
  if (cell.bold) st += ';font-weight:600'
  if (cell.italic) st += ';font-style:italic'
  if (cell.underline) st += ';text-decoration:underline'
  if (cell.wrap) st += ';white-space:normal;overflow-wrap:anywhere'
  const edges = normaliseEdges(cell.border)
  if (edges) {
    const style = (BORDER_STYLES as readonly string[]).includes(String(cell.borderStyle))
      ? String(cell.borderStyle) : 'solid'
    const col = cssColor(cell.borderColor) ?? 'currentColor'
    const side = { t: 'top', r: 'right', b: 'bottom', l: 'left' } as const
    for (const e of EDGES) {
      if (edges.includes(e)) st += `;border-${side[e]}:1px ${style} ${col}`
    }
  }
  return st
}


// --- dataset addressing -----------------------------------------------------

export interface Pos { row: number; col: number }
export interface CellRange { anchor: Pos; head: Pos }

/**
 * Row index → rid, honouring the view's order vector.
 *
 * A COPY of grid.ts's private `ridAt`, and the duplication is deliberate for
 * now: this file must stay callable from a rig with no DOM, and grid.ts drags
 * in the whole editor. Exporting the grid's one is the tidier end state and is
 * named in this task's report as a hook worth having.
 */
export function ridAt(sheet: TableSheet, order: number[] | undefined, i: number): number {
  const idx = order ? order[i] : i
  if (idx === undefined) return -1
  let seen = 0
  for (const [start, count] of sheet.rids) {
    if (idx < seen + count) return start + (idx - seen)
    seen += count
  }
  return -1
}

/** More cells than one edit should carry — cellprops.ts's cap, shared. */
export const KEY_CAP = 50_000

/**
 * Every `<colId>:<rid>` the selection covers, once, in reading order.
 *
 * `visible` is the VISIBLE column list, because the selection counts painted
 * positions and a hidden column would otherwise shift every key one to the
 * left — a bold landing on the wrong column, silently. panels.ts already
 * computes exactly this list for the Column section.
 *
 * A row or column the selection runs past yields nothing rather than a key
 * with `-1` in it: a dataset ends, and the selection model does not know that.
 */
export function overrideKeys(
  sheet: TableSheet, order: number[] | undefined,
  visible: readonly Column[], ranges: readonly CellRange[],
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of ranges) {
    const top = Math.min(r.anchor.row, r.head.row)
    const bottom = Math.max(r.anchor.row, r.head.row)
    const left = Math.min(r.anchor.col, r.head.col)
    const right = Math.max(r.anchor.col, r.head.col)
    for (let row = top; row <= bottom; row++) {
      const rid = ridAt(sheet, order, row)
      if (rid < 0) continue
      for (let col = left; col <= right; col++) {
        const c = visible[col]
        if (!c) continue
        if (out.length >= KEY_CAP) return out
        const k = `${c.id}:${rid}`
        if (seen.has(k)) continue
        seen.add(k)
        out.push(k)
      }
    }
  }
  return out
}

/** "12 cells", or the single address, for the panel's header row. */
export function describeOverrideSelection(keys: readonly string[], cursor: string): string {
  if (keys.length <= 1) return cursor
  return t('{n} cells').replace('{n}', String(keys.length))
}

// --- dataset patches --------------------------------------------------------
//
// ONE PATCH FOR THE WHOLE SELECTION, always — the rule cellprops.ts already
// holds for the spreadsheet kind and `test-dash-cellprops.ts` already pins
// ("formatting twenty cells is ONE patch and ONE undo"). `setOverrides` carries
// many keys for exactly this reason, so the dataset kind gets it for free and
// must not be allowed to lose it: twenty patches would be twenty undo steps,
// twenty CRDT ops and a ⌘Z that leaves a selection half-formatted.

/**
 * Set or clear appearance across a dataset selection, as ONE `setOverrides`.
 *
 * Cells the edit would not change are left OUT — applying "align: auto" to
 * forty untouched cells must write nothing, or the sparse overlay grows forty
 * entries because somebody clicked a control that did nothing. On this kind
 * that matters more than on the spreadsheet: the overlay is the file's record
 * of where a human disagreed with the data, and forty inert entries are forty
 * false positives in `validate.ts`'s override findings.
 *
 * `dropEmpty` is set when the sheet had no overlay at all, so clearing the last
 * one leaves the sheet exactly as it was found rather than carrying `cells: {}`
 * — twelve bytes, and a document that does not equal the same document reached
 * another way (store.ts and crdt.ts are both emphatic about this one).
 */
export function appearancePatch(
  sheet: TableSheet, keys: readonly string[], edit: AppearanceEdit,
): Patch | null {
  const outKeys: string[] = []
  const vals: Array<CellOverride | null> = []
  for (const key of keys) {
    const prev = sheet.cells?.[key]
    const next = applyAppearance<CellOverride>(prev, edit)
    if (sameCell(next as Record<string, unknown> | null, prev as Record<string, unknown> | undefined)) continue
    outKeys.push(key)
    vals.push(next)
  }
  if (!outKeys.length) return null
  return {
    op: 'setOverrides', sheet: sheet.id, keys: outKeys, v: vals,
    dropEmpty: true,
  }
}

/**
 * Stamp a display pattern across a dataset selection. DISPLAY ONLY.
 *
 * The spreadsheet kind's `formatPatch` re-reads every value the new format
 * touches, because there the format is the cell's type declaration. Here the
 * COLUMN says what the value is, so this writes the pattern and stops. There
 * is no `refused` count to report because nothing was attempted on a value.
 *
 * A pattern equal to the column's own is stored as ABSENCE: an override that
 * repeats what the column already says is an entry in the overlay that means
 * nothing, and it would survive a later change to the column format as a cell
 * that mysteriously refuses to follow.
 */
export function overrideFormatPatch(
  sheet: TableSheet, keys: readonly string[], fmt: string | undefined,
): Patch | null {
  const outKeys: string[] = []
  const vals: Array<CellOverride | null> = []
  const colFormat = new Map(sheet.columns.map((c) => [c.id, typeof c.format === 'string' ? c.format : undefined]))
  for (const key of keys) {
    const prev = sheet.cells?.[key]
    const want = fmt === (colFormat.get(key.slice(0, key.indexOf(':'))) ?? undefined) ? undefined : fmt
    const next: CellOverride = { ...(prev ?? {}) }
    if (want === undefined || want === '') delete next.format
    else next.format = want
    const out = Object.keys(next).length ? next : null
    if (sameCell(out as Record<string, unknown> | null, prev as Record<string, unknown> | undefined)) continue
    outKeys.push(key)
    vals.push(out)
  }
  if (!outKeys.length) return null
  return {
    op: 'setOverrides', sheet: sheet.id, keys: outKeys, v: vals,
    dropEmpty: true,
  }
}

/** The pattern a dataset cell prints with: its own, else its column's. */
export function effectiveFormat(sheet: TableSheet, key: string): string | undefined {
  const own = sheet.cells?.[key]?.format
  if (typeof own === 'string' && own !== '') return own
  const col = sheet.columns.find((c) => c.id === key.slice(0, key.indexOf(':')))
  return typeof col?.format === 'string' && col.format !== '' ? col.format : undefined
}

// --- the panel section, drawn once for both kinds ---------------------------

/** The row builders panels.ts owns. Structurally the same shape cellprops.ts
 *  declares — passed in so there is ONE spelling of a row (see its PanelKit). */
export interface AppearanceKit {
  section(host: HTMLElement, title: string): void
  row(host: HTMLElement, label: string, control: HTMLElement): void
  note(host: HTMLElement, message: string): void
  select(
    options: ReadonlyArray<readonly [string, string]>, value: string,
    onChange: (v: string) => void,
  ): HTMLSelectElement
  check(value: boolean, onChange: (v: boolean) => void): HTMLInputElement
}

export interface AppearanceCtx {
  host: HTMLElement
  kit: AppearanceKit
  /** the cell under the cursor, whichever kind it came from */
  cell: Appearance | undefined
  readOnly: boolean
  write(edit: AppearanceEdit): void
}

const alignLabel = (a: string): string =>
  a === 'left' ? t('Left') : a === 'center' ? t('Center') : t('Right')

const borderLabel = (b: string): string =>
  b === '' ? t('None')
    : b === 'trbl' ? t('Box')
      : b === 'b' ? t('Bottom')
        : b === 't' ? t('Top')
          : b === 'l' ? t('Left') : t('Right')

const styleLabel = (s: string): string =>
  s === 'solid' ? t('Solid') : s === 'dashed' ? t('Dashed') : t('Dotted')

/**
 * The Appearance section — ONE builder, both kinds.
 *
 * Written as a function over a kit rather than duplicated in cellprops.ts and
 * panels.ts, because the release note this closes was itself about the two
 * kinds drifting. Two copies of this section would drift again inside a month,
 * and the way you find out is a reader saying "underline is missing on the
 * other tab".
 */
export function buildAppearanceSection(ctx: AppearanceCtx): void {
  const { host, kit, cell, readOnly } = ctx
  const w = (edit: AppearanceEdit): void => { if (!readOnly) ctx.write(edit) }

  kit.section(host, t('Appearance'))

  for (const [field, label] of [
    ['bold', t('Bold')], ['italic', t('Italic')], ['underline', t('Underline')],
  ] as const) {
    const cb = kit.check(cell?.[field] === true, (v) => w({ [field]: v ? true : null }))
    cb.disabled = readOnly
    kit.row(host, label, cb)
  }

  const align = kit.select(
    [['auto', t('Auto')] as const, ...ALIGNS.map((a) => [a, alignLabel(a)] as const)],
    typeof cell?.align === 'string' && (ALIGNS as readonly string[]).includes(cell.align)
      ? cell.align : 'auto',
    (v) => w({ align: v === 'auto' ? null : v }),
  )
  align.disabled = readOnly
  kit.row(host, t('Align'), align)

  const wrap = kit.check(cell?.wrap === true, (v) => w({ wrap: v ? true : null }))
  wrap.disabled = readOnly
  kit.row(host, t('Wrap text'), wrap)

  kit.row(host, t('Text colour'), colourControl(
    typeof cell?.color === 'string' ? cell.color : '', '#1e2a3a', readOnly,
    (v) => w({ color: v }), t('Use the default colour')))
  kit.row(host, t('Background'), colourControl(
    typeof cell?.bg === 'string' ? cell.bg : '', '#fff3cd', readOnly,
    (v) => w({ bg: v }), t('No background')))

  // Borders. An edge set a file carries that no preset spells shows as Custom
  // and the dropdown leaves it alone — cellprops.ts's rule for a hand-written
  // number pattern, and for the same reason: a control that cannot express
  // what is stored must not silently respell it on the next click.
  const edges = normaliseEdges(cell?.border)
  const known = (BORDER_PRESETS as readonly string[]).includes(edges)
  const bsel = kit.select(
    [
      ...BORDER_PRESETS.map((b) => [b || 'none', borderLabel(b)] as const),
      ...(known ? [] : [['custom', t('Custom')] as const]),
    ],
    known ? (edges || 'none') : 'custom',
    (v) => { if (v !== 'custom') w({ border: v === 'none' ? null : v }) },
  )
  bsel.disabled = readOnly
  kit.row(host, t('Borders'), bsel)

  if (edges) {
    kit.row(host, t('Border colour'), colourControl(
      typeof cell?.borderColor === 'string' ? cell.borderColor : '', '#9aa7b4', readOnly,
      (v) => w({ borderColor: v }), t('Use the default colour')))

    const ssel = kit.select(
      BORDER_STYLES.map((s) => [s, styleLabel(s)] as const),
      (BORDER_STYLES as readonly string[]).includes(String(cell?.borderStyle))
        ? String(cell?.borderStyle) : 'solid',
      (v) => w({ borderStyle: v === 'solid' ? null : v }),
    )
    ssel.disabled = readOnly
    kit.row(host, t('Border style'), ssel)
  }
}

/**
 * A colour with an OFF state, which `<input type="color">` does not have.
 *
 * MOVED here from cellprops.ts, which now imports it: two copies of this
 * control is two × buttons that drift apart, and it is the only control in
 * either section that is not a plain kit row.
 */
export function colourControl(
  value: string, fallback: string, readOnly: boolean,
  onChange: (v: string | null) => void, clearTitle: string,
): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = 'dc-colour'
  const input = document.createElement('input')
  input.type = 'color'
  input.value = /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
  input.disabled = readOnly
  if (!value) wrap.classList.add('dc-colour-off')
  // `change`, never `input`: a drag through the OS colour wheel fires input on
  // every pixel, and every one of those would be an undo step.
  input.addEventListener('change', () => onChange(input.value))
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'dc-clear'
  clear.textContent = '×'
  clear.title = clearTitle
  clear.disabled = readOnly || !value
  clear.addEventListener('click', () => onChange(null))
  wrap.append(input, clear)
  return wrap
}

