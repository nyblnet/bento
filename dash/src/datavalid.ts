// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// DATA VALIDATION — what may be ENTERED into a cell, and what happens when
// something else is.
//
// Excel's feature of the same name: a list (which draws an in-cell dropdown),
// a number range, a date range, a text length, or a formula. This is the
// single most common thing in a SHARED workbook — "Status must be one of
// Open/Won/Lost" earns its keep precisely when four people are typing into the
// same sheet — which is why it belongs in dash rather than being an Excel
// nicety to copy later.
//
// ═══ THREE THINGS IN THIS REPO ARE CALLED VALIDATION AND THIS IS NONE OF THE
//     OTHER TWO ══════════════════════════════════════════════════════════════
//
//   * `validate.ts` is DOCUMENT validation — `window.bento.validate()`, "does
//     this workbook agree with itself": a column shorter than the sheet has
//     rows, a dictionary index past the end of its dict. It answers a question
//     about a FILE. This file answers a question about a KEYSTROKE. Nothing
//     here is added to its findings and nothing there reads these rules.
//   * `isOneOf` (model.ts) is a FILTER predicate — which rows to SHOW. A list
//     rule and a one-of filter both hold a set of strings and mean opposite
//     things: one hides rows that do not match, the other refuses values that
//     do not match and hides nothing.
//   * This file.
//
// Where a rule LIVES, and why the two sheet kinds are not symmetric, is
// argued in model.ts's DATA VALIDATION block beside the types. The short
// version: a dataset's rule is on the COLUMN (a narrowing of the column type,
// written with `setColumn`), a spreadsheet's is on a RANGE in a sheet-level
// list (written with `setSheetProps`). No new patch op exists, because a rule
// belongs to a thing the format already has an op for.
//
// ═══ REJECT vs WARN, WHICH IS THE DECISION THIS FILE EXISTS TO HOLD ════════
//
// Excel offers "Stop" (refuse the entry) and "Warning" (allow it). Both make
// sense on one machine with one keyboard. On a LIVE COLLABORATIVE document a
// hard reject is a trap, and it has to be said exactly where the trap is:
//
//   A REJECT THAT RUNS ON APPLY IS EITHER A DIVERGENCE OR A SILENT DISCARD.
//
// A remote op has already been committed by the peer who made it, and every
// other replica will apply it. A replica that refused it would hold different
// content from everyone else while being certain it was right — which is worse
// than a wrong value, because a wrong value is visible and a divergence is
// not. And if the refusal happened quietly, the peer's edit would be gone from
// one screen and present on another with nothing on either saying so.
//
// So dash's reject is scoped to the one place refusing costs nobody anything:
//
//   * `reject` refuses AT THE KEYBOARD, in the cell editor, while the text is
//     still under the author's own hands. The editor stays OPEN with what they
//     typed and says why. Nothing is committed, so nothing is discarded — the
//     author still has their text, and Escape abandons it as it always did.
//   * EVERY OTHER PATH DEGRADES TO WARN: a paste, a fill, an import, an undo,
//     and above all a remote CRDT op. The value lands and the cell is MARKED.
//     (Rejecting one cell of a five-hundred-cell paste would also be its own
//     small disaster: a hole in the middle of a block nobody can see.)
//
// That is the whole rule, and it is why `DataRule.on` is not simply Excel's
// `errorStyle` under another name.
//
// ═══ DATA THAT ALREADY BREAKS A RULE YOU JUST ADDED ════════════════════════
//
// It is MARKED, never deleted and never suspended. Deleting is data loss;
// silently accepting makes the rule a lie. Excel's answer is a one-shot
// "Circle Invalid Data" command; dash's marker is always on, because a circle
// you have to ask for is a circle nobody asks for.
//
// The mark is DERIVED AT PAINT TIME and never stored. A stored flag is stale
// the instant either the value or the rule changes, it costs bytes in a map
// whose promise is sparseness, and under collaboration it would be a second
// register saying something the first two already imply. `violationOf` is
// called for the painted window only — tens of cells — and the panel's
// whole-column count is capped (`SCAN_CAP`) so a rule on a million-row sheet
// cannot cost a frame.
//
// ═══ WHAT THIS BUILD DOES NOT CHECK ════════════════════════════════════════
//
// `kind: 'formula'`. It is parsed, kept verbatim, shown in the panel, and
// round-tripped to and from .xlsx — the `CellOverride.xlsxF` bargain exactly:
// keeping what the file said is what stops a round trip from quietly deleting
// somebody's model. It is not EVALUATED, and the panel says so in a note
// rather than leaving a reader to discover it. Excel evaluates a custom
// formula with the cell under test as an implicit argument in that worksheet's
// coordinate space; doing that here needs a substitution hook in
// cellformula.ts (evaluate this expression with THIS cell holding a candidate
// value that is not in the document yet), which does not exist. A rule that is
// right most of the time is worse than one that says it is not checked —
// xlsx.ts makes the identical argument about translating column formulas.

// NO STYLESHEET IMPORT HERE, deliberately. xlsx.ts imports this module for the
// import/export mapping, and xlsx.ts's rig runs in plain node with no Vite and
// no css loader — so a `import './datavalid.css'` in this file breaks a rig
// that has nothing to do with stylesheets. The sheet is imported by grid.ts,
// which is where the markup it styles is emitted, and every rig that mounts the
// grid already stubs css because find.ts has always brought one along.
import { t } from './i18n.ts'
import { colToLetters, parseRange, parseRef } from './a1.ts'
import type {
  CanvasSheet, Column, DataRule, DataRuleKind, RangeValidation, TableSheet,
} from './model.ts'
import type { Patch } from './store.ts'
import type { SetSheetProps } from './rowcol.ts'

export type { DataRule, DataRuleKind, RangeValidation }

/** Rule kinds this build offers in the panel. `formula` is carried, not made. */
export const RULE_KINDS = ['list', 'number', 'date', 'textLength'] as const

/** Cells the panel's "how many already break this" count will read. The status
 *  bar's `SUMMARY_MAX` reasoning: a dataset is bounded by the file, and a count
 *  recomputed on every document event must not be O(million). */
export const SCAN_CAP = 200_000

/** How many list entries the in-cell dropdown will draw before it stops. A
 *  list is a hand-written set of choices; ten thousand of them is a lookup
 *  table someone pasted, and a menu that long is unusable rather than useful. */
export const LIST_CAP = 500

// --- reading a rule out of an untrusted document ----------------------------
//
// A document is untrusted input (kernel #277, docs/PLATFORM.md). Everything
// below comes out of the file, reaches a `title=` attribute and a menu label,
// and decides whether an edit is refused — so it is read through a guard
// rather than cast. An unreadable rule is treated as NO RULE: refusing to open
// the sheet would be a file nobody can repair, and enforcing a rule we could
// not parse would refuse entries for a reason nobody can see.

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined

const bound = (v: unknown): number | string | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const s = str(v)
  return s === undefined ? undefined : s
}

/**
 * Read one rule. Returns `null` for anything this build cannot make sense of.
 *
 * UNKNOWN KEYS SURVIVE. The returned object is the stored one re-read field by
 * field PLUS whatever else it carried, because a rule written by a later build
 * must round-trip untouched (PLATFORM §3) — including the extras it holds.
 */
export function readRule(v: unknown): DataRule | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const raw = v as Record<string, unknown>
  const kind = str(raw.kind)
  if (kind === undefined) return null
  const out: DataRule = { ...raw, kind }
  const list = Array.isArray(raw.list)
    ? raw.list.filter((x): x is string => typeof x === 'string')
    : undefined
  if (list) out.list = list
  else delete out.list
  const min = bound(raw.min)
  const max = bound(raw.max)
  if (min === undefined) delete out.min; else out.min = min
  if (max === undefined) delete out.max; else out.max = max
  const f = str(raw.formula)
  if (f === undefined) delete out.formula; else out.formula = f
  const msg = str(raw.message)
  if (msg === undefined) delete out.message; else out.message = msg
  if (raw.blank === false) out.blank = false; else delete out.blank
  if (raw.noDropdown === true) out.noDropdown = true; else delete out.noDropdown
  out.on = raw.on === 'reject' ? 'reject' : 'warn'
  // A list rule with no list refuses everything, which is not a rule anyone
  // meant to write — and it would make every cell in the column red the moment
  // a `list: []` reached the file.
  if (kind === 'list' && !out.list?.length) return null
  return out
}

/** The rule on a DATASET column, if it carries a readable one. */
export const columnRule = (col: Column | undefined): DataRule | null =>
  col ? readRule((col as { validate?: unknown }).validate) : null

/**
 * A SPREADSHEET's rule list, read defensively.
 *
 * Entries whose `ref` will not parse are DROPPED from the working list and
 * left in the file: a range this build cannot read is not a range it should
 * enforce, and deleting it on the next save would throw away a rule a
 * different build understands.
 */
export function canvasRules(sheet: CanvasSheet | undefined): RangeValidation[] {
  const raw = (sheet as { validations?: unknown } | undefined)?.validations
  if (!Array.isArray(raw)) return []
  const out: RangeValidation[] = []
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue
    const ref = str((e as Record<string, unknown>).ref)
    const rule = readRule((e as Record<string, unknown>).rule)
    if (!ref || !rule || !refBox(ref)) continue
    out.push({ ...(e as RangeValidation), ref, rule })
  }
  return out
}

export interface RefBox { top: number; left: number; bottom: number; right: number }

/** `B2:B100`, `B2`, or nothing. Zero-based and inclusive, normalised so a
 *  range dragged upwards means the same thing as one dragged down. */
export function refBox(ref: string): RefBox | null {
  const r = parseRange(ref)
  if (r) {
    return {
      top: Math.min(r.from.row, r.to.row), bottom: Math.max(r.from.row, r.to.row),
      left: Math.min(r.from.col, r.to.col), right: Math.max(r.from.col, r.to.col),
    }
  }
  const one = parseRef(ref)
  return one ? { top: one.row, bottom: one.row, left: one.col, right: one.col } : null
}

export const boxRef = (b: RefBox): string =>
  b.top === b.bottom && b.left === b.right
    ? `${colToLetters(b.left)}${b.top + 1}`
    : `${colToLetters(b.left)}${b.top + 1}:${colToLetters(b.right)}${b.bottom + 1}`

const inBox = (b: RefBox, row: number, col: number): boolean =>
  row >= b.top && row <= b.bottom && col >= b.left && col <= b.right

/**
 * The rule covering one spreadsheet cell.
 *
 * LAST MATCH WINS, which is the same answer a stacking order gives everywhere
 * else in this app: a rule added later over a range that overlaps an older one
 * is the author's newer decision, and searching from the front would make a
 * broad early rule permanently shadow a narrow correction to it.
 */
export function canvasEntryAt(
  rules: readonly RangeValidation[], row: number, col: number,
): RangeValidation | null {
  for (let i = rules.length - 1; i >= 0; i--) {
    const b = refBox(rules[i].ref)
    if (b && inBox(b, row, col)) return rules[i]
  }
  return null
}

/** The rule alone — what every painter and every editor wants. */
export const canvasRuleAt = (
  rules: readonly RangeValidation[], row: number, col: number,
): DataRule | null => canvasEntryAt(rules, row, col)?.rule ?? null

// --- checking a value -------------------------------------------------------

/** Is a rule one this build actually enforces? `formula` is not — see header. */
export const enforced = (rule: DataRule): boolean =>
  rule.kind === 'list' || rule.kind === 'number'
  || rule.kind === 'date' || rule.kind === 'textLength'

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

/** Loose, because a list is written by hand and typed by hand: leading space
 *  and a capital letter are not what "Won" vs "Lost" is about. */
const listKey = (s: string): string => s.trim().toLowerCase()

const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v !== 'string') return null
  const s = v.trim().replace(/[,\s£$€¥%]/g, '')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** A date as a day number, so a bound and a value compare without a timezone
 *  ever entering it. `YYYY-MM-DD` and anything `Date` will take. */
const asDay = (v: unknown): number | null => {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? Math.floor(v.getTime() / 86_400_000) : null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s === '') return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  const ms = iso
    ? Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    : Date.parse(s)
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null
}

const numBound = (v: number | string | undefined): number | null =>
  v === undefined ? null : asNumber(v)

const dayBound = (v: number | string | undefined): number | null =>
  v === undefined ? null : asDay(v)

/**
 * Why this value breaks this rule, or `null` if it does not.
 *
 * The string is what a reader sees, in a `title=`, in the panel and in the
 * editor's refusal — so `rule.message` wins when the author wrote one, exactly
 * as Excel's custom error message does.
 *
 * A value the rule cannot READ is a violation ("must be a number"), never a
 * pass. Treating an unreadable value as acceptable is how a rule becomes
 * decoration: the one entry it exists to catch is the one it cannot parse.
 */
export function violationOf(rule: DataRule, v: unknown): string | null {
  if (isBlank(v)) {
    return rule.blank === false ? (rule.message ?? t('This cell may not be empty.')) : null
  }
  if (!enforced(rule)) return null
  const say = (generated: string): string => rule.message ?? generated

  if (rule.kind === 'list') {
    const allowed = rule.list ?? []
    const key = listKey(String(v))
    if (allowed.some((a) => listKey(a) === key)) return null
    return say(t('Must be one of: {list}').replace('{list}', allowed.join(', ')))
  }

  if (rule.kind === 'number') {
    const n = asNumber(v)
    if (n === null) return say(t('Must be a number.'))
    return rangeWhy(n, numBound(rule.min), numBound(rule.max), say, (x) => String(x))
  }

  if (rule.kind === 'date') {
    const d = asDay(v)
    if (d === null) return say(t('Must be a date.'))
    return rangeWhy(d, dayBound(rule.min), dayBound(rule.max), say,
      () => '', String(rule.min ?? ''), String(rule.max ?? ''))
  }

  // textLength
  const len = String(v).length
  const lo = numBound(rule.min)
  const hi = numBound(rule.max)
  if (lo !== null && len < lo) {
    return say(t('Must be at least {n} characters.').replace('{n}', String(lo)))
  }
  if (hi !== null && len > hi) {
    return say(t('Must be at most {n} characters.').replace('{n}', String(hi)))
  }
  return null
}

function rangeWhy(
  n: number, lo: number | null, hi: number | null,
  say: (s: string) => string, show: (x: number) => string,
  loText?: string, hiText?: string,
): string | null {
  if (lo !== null && n < lo) {
    return say(t('Must be {min} or more.').replace('{min}', loText || show(lo)))
  }
  if (hi !== null && n > hi) {
    return say(t('Must be {max} or less.').replace('{max}', hiText || show(hi)))
  }
  return null
}

/** The list a dropdown draws, capped. */
export const listOptions = (rule: DataRule): string[] =>
  rule.kind === 'list' ? (rule.list ?? []).slice(0, LIST_CAP) : []

/** Does this rule draw an in-cell arrow? */
export const hasDropdown = (rule: DataRule | null): boolean =>
  !!rule && rule.kind === 'list' && rule.noDropdown !== true && (rule.list?.length ?? 0) > 0

/** One line describing the rule, for the panel and for a cell's tooltip. */
export function describeRule(rule: DataRule): string {
  if (rule.kind === 'list') {
    return t('One of: {list}').replace('{list}', (rule.list ?? []).join(', '))
  }
  if (rule.kind === 'formula') return t('Custom formula (not checked by this build)')
  const lo = rule.min
  const hi = rule.max
  const what = rule.kind === 'number' ? t('Number')
    : rule.kind === 'date' ? t('Date')
      : rule.kind === 'textLength' ? t('Text length') : rule.kind
  if (lo !== undefined && hi !== undefined) {
    return `${what} ${t('between {min} and {max}').replace('{min}', String(lo)).replace('{max}', String(hi))}`
  }
  if (lo !== undefined) return `${what} ≥ ${lo}`
  if (hi !== undefined) return `${what} ≤ ${hi}`
  return what
}

// --- how many rows already break it -----------------------------------------

/**
 * Existing values that violate a rule, capped at `SCAN_CAP`.
 *
 * `capped` is reported rather than swallowed: "at least 200,000" is a true
 * sentence and "200,000" is not.
 */
export function countViolations(
  rule: DataRule, values: Iterable<unknown>,
): { n: number; capped: boolean } {
  let n = 0
  let seen = 0
  for (const v of values) {
    if (seen++ >= SCAN_CAP) return { n, capped: true }
    if (violationOf(rule, v) !== null) n++
  }
  return { n, capped: false }
}

// --- patches ----------------------------------------------------------------
//
// No new patch op. A dataset rule is a COLUMN field (`setColumn`) and a
// spreadsheet rule is a SHEET field (`setSheetProps`), both of which already
// exist, already invert correctly and are already minted as CRDT ops.

/**
 * Set or clear a dataset column's rule.
 *
 * Clearing writes `validate: undefined`, which is `setColumn`'s spelling for a
 * delete (store.ts's `setColumn` case displaces the old value and removes the
 * key), so adding a rule and removing it again leaves the file exactly as it
 * was found — the rule `freezeAt` and `totalsPatch` both hold.
 */
export const columnRulePatch = (
  sheet: TableSheet, colId: string, rule: DataRule | null,
): Patch => ({
  op: 'setColumn', sheet: sheet.id, col: colId,
  patch: { validate: rule ?? undefined },
})

/**
 * Set, replace or remove the rule over one range on a spreadsheet.
 *
 * Keyed by `ref`: setting a rule on a range that already has one REPLACES it
 * rather than stacking a second, or the panel's own control would silently
 * grow the list on every change and `canvasRuleAt`'s last-match-wins would
 * quietly become last-EDIT-wins with a hundred dead entries underneath.
 *
 * Removing the last rule DROPS the field instead of storing `[]`, for the
 * reason every other optional container in this format is dropped: an empty
 * array is a diff, a byte cost and a document that does not equal the same
 * document reached another way.
 */
export function canvasRulePatch(
  sheet: CanvasSheet, ref: string, rule: DataRule | null,
): SetSheetProps | null {
  const box = refBox(ref)
  if (!box) return null
  const norm = boxRef(box)
  const kept = canvasRules(sheet).filter((e) => {
    const b = refBox(e.ref)
    return !b || boxRef(b) !== norm
  })
  const next = rule ? [...kept, { ref: norm, rule }] : kept
  if (!next.length) {
    if (!Array.isArray((sheet as { validations?: unknown }).validations)) return null
    return { op: 'setSheetProps', sheet: sheet.id, props: {}, drop: ['validations'] }
  }
  return { op: 'setSheetProps', sheet: sheet.id, props: { validations: next } }
}

// --- the in-cell dropdown ---------------------------------------------------

/** The marker the grid puts inside a cell whose rule draws an arrow. Both
 *  paint loops emit exactly this, so there is one thing to click and one thing
 *  to assert. */
export const DROPDOWN_HTML = '<span class="dv-arrow" data-dv-open="1">▾</span>'

/** Class on a cell whose CURRENT value breaks its rule — the always-on
 *  equivalent of Excel's "Circle Invalid Data", painted rather than stored. */
export const INVALID_CLASS = 'dv-bad'

let openMenu: (() => void) | null = null

/** Close whatever list menu is open. Safe to call when none is. */
export function closeListMenu(): void {
  const f = openMenu
  openMenu = null
  f?.()
}

/**
 * Drop a list menu under a cell.
 *
 * Mounted on `document.body` rather than inside the cell, for the reason every
 * floating surface in this repo is: the grid's cells clip, and a menu inside
 * one is a menu with two visible entries and a scrollbar.
 */
export function openListMenu(opts: {
  anchor: { getBoundingClientRect(): { left: number; bottom: number; width: number } }
  options: readonly string[]
  current?: unknown
  onPick: (v: string) => void
}): HTMLElement {
  closeListMenu()
  const menu = document.createElement('div')
  menu.className = 'dv-menu'
  menu.setAttribute('role', 'listbox')
  const rect = opts.anchor.getBoundingClientRect()
  menu.style.left = `${Math.round(rect.left)}px`
  menu.style.top = `${Math.round(rect.bottom)}px`
  menu.style.minWidth = `${Math.max(90, Math.round(rect.width))}px`
  const cur = opts.current === null || opts.current === undefined ? '' : listKey(String(opts.current))
  for (const v of opts.options) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'dv-opt'
    b.setAttribute('role', 'option')
    b.textContent = v
    if (listKey(v) === cur) {
      b.classList.add('dv-opt-on')
      b.setAttribute('aria-selected', 'true')
    }
    b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
    b.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      closeListMenu()
      opts.onPick(v)
    })
    menu.appendChild(b)
  }
  // A "clear" entry, because a list rule that allows blanks has no other way
  // to say so from the menu — and typing over the cell to empty it is exactly
  // the gesture the dropdown was supposed to replace.
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'dv-opt dv-opt-clear'
  clear.textContent = t('Clear')
  clear.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
  clear.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation(); closeListMenu(); opts.onPick('')
  })
  menu.appendChild(clear)

  document.body.appendChild(menu)
  const away = (): void => closeListMenu()
  document.addEventListener('mousedown', away)
  openMenu = () => {
    document.removeEventListener('mousedown', away)
    menu.parentElement?.removeChild(menu)
  }
  return menu
}

// --- the panel section, drawn once for both kinds ---------------------------

/** The row builders panels.ts owns — the same shape cellfmt.ts declares, and
 *  passed in for the same reason: ONE spelling of a row. */
export interface ValidationKit {
  section(host: HTMLElement, title: string): void
  row(host: HTMLElement, label: string, control: HTMLElement): void
  readonlyRow(host: HTMLElement, label: string, value: string): void
  note(host: HTMLElement, message: string): void
  text(value: string, onChange: (v: string) => void): HTMLInputElement
  select(
    options: ReadonlyArray<readonly [string, string]>, value: string,
    onChange: (v: string) => void,
  ): HTMLSelectElement
  check(value: boolean, onChange: (v: boolean) => void): HTMLInputElement
}

export interface ValidationCtx {
  host: HTMLElement
  kit: ValidationKit
  /** what the rule is attached to, in the reader's words: a column name, or an
   *  A1 range. Shown so "this applies to" is never a guess. */
  scope: string
  /** absent when the panel has nothing selected to attach a rule to */
  rule: DataRule | null
  readOnly: boolean
  /** how many stored values already break the rule; omitted when unknown */
  offenders?: { n: number; capped: boolean }
  write(rule: DataRule | null): void
}

const kindLabel = (k: string): string =>
  k === 'list' ? t('List')
    : k === 'number' ? t('Number')
      : k === 'date' ? t('Date')
        : k === 'textLength' ? t('Text length')
          : k === 'formula' ? t('Custom formula') : k

/**
 * The Validation section — ONE builder, both kinds, exactly as
 * `buildAppearanceSection` is. Two copies would drift, and the way you find
 * out is a reader saying "the dropdown toggle is missing on the other tab".
 */
export function buildValidationSection(ctx: ValidationCtx): void {
  const { host, kit, rule, readOnly } = ctx
  kit.section(host, t('Validation'))
  kit.readonlyRow(host, t('Applies to'), ctx.scope)

  const kind = rule?.kind ?? 'none'
  const known = kind === 'none' || (RULE_KINDS as readonly string[]).includes(kind)
  const sel = kit.select(
    [
      ['none', t('No rule')] as const,
      ...RULE_KINDS.map((k) => [k, kindLabel(k)] as const),
      // `formula` is offered as a CURRENT value only, never as a choice: this
      // build cannot check one, so a control that let someone create one would
      // be a control that manufactures a rule the app ignores. An imported one
      // stays visible and stays selectable-back-to, which is what keeps it from
      // being deleted by accident.
      ...(known ? [] : [[kind, kindLabel(kind)] as const]),
    ],
    kind,
    (v) => {
      if (v === kind) return
      if (v === 'none') { ctx.write(null); return }
      if (!(RULE_KINDS as readonly string[]).includes(v)) return
      ctx.write({ ...(rule ?? {}), kind: v as DataRuleKind, on: rule?.on ?? 'warn' })
    },
  )
  sel.disabled = readOnly
  kit.row(host, t('Rule'), sel)

  if (!rule) {
    kit.note(host, t('A rule says what may be TYPED here. Existing values are never changed by adding one — anything that breaks it is marked instead.'))
    return
  }

  const put = (edit: Partial<DataRule>): void => { if (!readOnly) ctx.write({ ...rule, ...edit }) }

  if (rule.kind === 'list') {
    const items = kit.text((rule.list ?? []).join(', '), (v) => {
      const list = v.split(',').map((s) => s.trim()).filter(Boolean)
      if (!list.length) return               // an empty list is not a rule
      put({ list })
    })
    items.placeholder = t('Open, Won, Lost')
    items.disabled = readOnly
    kit.row(host, t('Values'), items)

    const dd = kit.check(rule.noDropdown !== true, (v) => put({ noDropdown: v ? undefined : true }))
    dd.disabled = readOnly
    kit.row(host, t('In-cell dropdown'), dd)
  } else if (rule.kind === 'formula') {
    const f = kit.text(rule.formula ?? '', (v) => put({ formula: v.trim() || undefined }))
    f.disabled = true
    kit.row(host, t('Formula'), f)
    kit.note(host, t('This rule came from a spreadsheet that evaluates it. dash keeps it and writes it back out unchanged, and does not check entries against it.'))
  } else {
    const lo = kit.text(rule.min === undefined ? '' : String(rule.min), (v) => {
      put({ min: v.trim() === '' ? undefined : coerceBound(rule.kind, v) })
    })
    lo.placeholder = rule.kind === 'date' ? '2026-01-01' : t('no minimum')
    lo.disabled = readOnly
    kit.row(host, t('Minimum'), lo)

    const hi = kit.text(rule.max === undefined ? '' : String(rule.max), (v) => {
      put({ max: v.trim() === '' ? undefined : coerceBound(rule.kind, v) })
    })
    hi.placeholder = rule.kind === 'date' ? '2026-12-31' : t('no maximum')
    hi.disabled = readOnly
    kit.row(host, t('Maximum'), hi)
  }

  const blank = kit.check(rule.blank !== false, (v) => put({ blank: v ? undefined : false }))
  blank.disabled = readOnly
  kit.row(host, t('Allow empty'), blank)

  const on = kit.select(
    [['warn', t('Warn and allow')] as const, ['reject', t('Refuse the entry')] as const],
    rule.on === 'reject' ? 'reject' : 'warn',
    (v) => put({ on: v === 'reject' ? 'reject' : 'warn' }),
  )
  on.disabled = readOnly
  kit.row(host, t('On a bad value'), on)

  const msg = kit.text(rule.message ?? '', (v) => put({ message: v.trim() || undefined }))
  msg.placeholder = describeRule(rule)
  msg.disabled = readOnly
  kit.row(host, t('Message'), msg)

  if (rule.on === 'reject') {
    kit.note(host, t('Refusing applies while you type. A pasted or imported value, and an edit arriving from a collaborator, is always kept and marked — a refusal there would discard somebody else’s work or leave the two copies disagreeing.'))
  }

  const off = ctx.offenders
  if (off && off.n > 0) {
    kit.note(host, (off.capped
      ? t('At least {n} existing value(s) break this rule. They are marked, never changed.')
      : t('{n} existing value(s) break this rule. They are marked, never changed.')
    ).replace('{n}', String(off.n)))
  }
}

/** A typed bound from a panel field. A date stays the text the author typed —
 *  `2026-03-01` is what Excel stores and what a reader can read back. */
function coerceBound(kind: DataRuleKind, v: string): number | string {
  const s = v.trim()
  if (kind === 'date') return s
  const n = Number(s)
  return Number.isFinite(n) ? n : s
}
