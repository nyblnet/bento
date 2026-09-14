// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The controls for conditional formatting — over an engine that was already
// finished.
//
// WHY THIS FILE EXISTS. `condfmt.ts` implements six rule kinds, `validate.ts`
// accepts all six, the grid and the printer both paint all six, and a saved
// workbook round-trips all six. The application offered TWO: a right-click gave
// "Colour scale" and "Data bars" with hardcoded colours, and nothing anywhere
// in `src/` constructed a `cellValue`, `topN`, `duplicates` or `formula` rule.
// So "highlight cells greater than 40" — the most-used conditional format there
// is, and the literal task the bounce test tried to do — was missing from a
// product that had already built it, tested it and shipped it in the file
// format. This is the dialog, and nothing below changes the engine.
//
// A PANEL SECTION, NOT A MODAL. Formatting is a thing you judge by looking at
// the grid, and a modal sits on top of the grid. The panel is already where a
// column's type, pattern, total and validation live, it rebuilds on every
// document event, and the colour you pick appears in the rows behind it while
// the control still has focus. It also means this section is built out of
// `PanelKit` — the same `row`, `select`, `text` and `check` every other section
// uses — so it cannot drift 2px away from them.
//
// THE LIST IS THE POINT. Rules compose (condfmt.ts's header explains why that
// beats Excel's first-match-wins), so a column holds an ARRAY and the UI has to
// be able to say which rule the rows below belong to. One rule is open at a
// time; the others are listed above it as buttons carrying their own
// description. Which one is open is VIEW state, not document state — it is
// remembered in memory per (sheet, column) and never written to the file, for
// the same reason the sort order is not a document edit.
//
// AN UNKNOWN KIND IS OFFERED BACK, NEVER SILENTLY REWRITTEN. A rule kind from a
// later build (or a hand-edited file, which PLATFORM §7 makes a first-class way
// in) keeps its slot in the list and its own entry in the dropdown, exactly as
// datavalid.ts does with an imported `formula` validation. The alternative is a
// control that deletes what it cannot read.
//
// EVERY WRITE REPLACES THE WHOLE LIST for one column and goes through
// `condFmtPatch`, which DROPS `condfmt` when the last rule goes. An additive
// field that means "no formatting" must be ABSENT, or turning a rule on and off
// again leaves the workbook changed — panels.ts `totalsPatch` makes the same
// argument at length.

import './condfmt.css'
import { t } from './i18n.ts'
import { colourControl } from './cellfmt.ts'
import { dependencies, FUNCTIONS } from './formula.ts'
import type { CellStyle, CompareOp, Rule } from './condfmt.ts'
import type { PanelKit } from './cellprops.ts'
import type { TableSheet } from './model.ts'
import type { SetSheetProps } from './rowcol.ts'

/** The six the engine implements, in the order the dropdown offers them. */
export const CF_KINDS = [
  'cellValue', 'colorScale', 'dataBar', 'topN', 'duplicates', 'formula',
] as const
export type CfKind = (typeof CF_KINDS)[number]

const OPS: CompareOp[] = [
  '>', '>=', '<', '<=', '=', '<>', 'between',
  'contains', 'startsWith', 'endsWith', 'blank', 'notBlank',
]

/** Ops whose operand is read as a number when it reads as one. */
const NUMERIC_OPS = new Set<CompareOp>(['>', '>=', '<', '<=', '=', '<>', 'between'])
/** Ops that take no operand at all. */
const NULLARY_OPS = new Set<CompareOp>(['blank', 'notBlank'])

// A LITERAL t() per label rather than one over a lookup table: the extraction
// rig sweeps literal calls out of the source, and a call whose argument is a
// table lookup is invisible to it unless the table is also declared in its
// INDIRECT list — a second place to remember. cellprops.ts `kindLabel` makes
// the same argument.
export function cfKindLabel(kind: string): string {
  switch (kind) {
    case 'cellValue': return t('Highlight cells')
    case 'colorScale': return t('Colour scale')
    case 'dataBar': return t('Data bars')
    case 'topN': return t('Top or bottom')
    case 'duplicates': return t('Duplicate values')
    case 'formula': return t('Formula')
    default: return kind
  }
}

function opLabel(op: CompareOp): string {
  switch (op) {
    case '>': return t('greater than')
    case '>=': return t('greater than or equal to')
    case '<': return t('less than')
    case '<=': return t('less than or equal to')
    case '=': return t('equal to')
    case '<>': return t('not equal to')
    case 'between': return t('between')
    case 'contains': return t('contains')
    case 'startsWith': return t('starts with')
    case 'endsWith': return t('ends with')
    case 'blank': return t('is empty')
    default: return t('is not empty')
  }
}

/**
 * One line naming a rule — the list buttons, and the toast that reports what a
 * one-click preset just did.
 */
export function describeCondFmtRule(rule: Rule): string {
  switch (rule.kind) {
    case 'cellValue': {
      const op = opLabel(rule.op)
      if (NULLARY_OPS.has(rule.op)) return `${t('Highlight cells')} ${op}`
      if (rule.op === 'between') {
        return `${t('Highlight cells')} ${op} ${String(rule.value ?? '')} / ${String(rule.to ?? '')}`
      }
      return `${t('Highlight cells')} ${op} ${String(rule.value ?? '')}`
    }
    case 'topN':
      return (rule.bottom ? t('Bottom {n}') : t('Top {n}')).replace('{n}', String(rule.n))
    default:
      return cfKindLabel(rule.kind)
  }
}

/** The style a fresh highlight wears: Excel's light red fill, dark red text. */
const HIT: CellStyle = { bg: '#fee2e2', color: '#991b1b' }

/** A new rule of one kind, with defaults somebody can actually use unedited. */
export function blankCondFmtRule(kind: CfKind): Rule {
  switch (kind) {
    case 'cellValue': return { kind: 'cellValue', op: '>', value: 0, style: { ...HIT } }
    case 'colorScale': return { kind: 'colorScale', colors: ['#fee2e2', '#fef9c3', '#dcfce7'] }
    case 'dataBar': return { kind: 'dataBar', color: '#F7A600', negativeColor: '#E1616C' }
    case 'topN': return { kind: 'topN', n: 10, style: { bg: '#dcfce7', color: '#14532d' } }
    case 'duplicates': return { kind: 'duplicates', style: { ...HIT } }
    default: return {
      kind: 'formula', expr: 'value > AVERAGE(value)',
      style: { bg: '#fef9c3', color: '#713f12' },
    }
  }
}

/** One column's rules, as the file holds them — never a shared reference. */
export function readCondFmt(sheet: TableSheet, colId: string): Rule[] {
  const cf = (sheet as unknown as { condfmt?: Record<string, unknown> }).condfmt
  const list = cf && typeof cf === 'object' ? cf[colId] : undefined
  return Array.isArray(list) ? (list.filter((r) => r && typeof r === 'object') as Rule[]) : []
}

/**
 * Set (or clear) one column's rules.
 *
 * The empty list DROPS the column's entry, and the last column dropped takes
 * `condfmt` with it — see the header. `drop` is spelled as a key list rather
 * than `props: {condfmt: undefined}` because that spelling evaporates in
 * `JSON.stringify` and would reach another replica as a no-op (rowcol.ts).
 */
export function condFmtPatch(
  sheet: TableSheet, colId: string, rules: readonly Rule[],
): SetSheetProps {
  const cf: Record<string, unknown> = {
    ...((sheet as unknown as { condfmt?: Record<string, unknown> }).condfmt ?? {}),
  }
  if (rules.length) cf[colId] = [...rules]
  else delete cf[colId]
  return Object.keys(cf).length
    ? { op: 'setSheetProps', sheet: sheet.id, props: { condfmt: cf } }
    : { op: 'setSheetProps', sheet: sheet.id, props: {}, drop: ['condfmt'] }
}

/**
 * Read a typed operand out of a text field.
 *
 * A numeric op given the STRING "40" falls into condfmt.ts's text-compare
 * branch, where "9" > "40" — the classic string-ordering bug, and it shows up
 * as the wrong rows highlighted rather than as an error anybody can see.
 */
export function readOperand(op: CompareOp, raw: string): unknown {
  const s = raw.trim()
  if (s === '') return undefined
  if (!NUMERIC_OPS.has(op)) return raw
  const n = Number(s)
  return Number.isFinite(n) ? n : raw
}

// --- which rule is open ------------------------------------------------------
//
// VIEW state. In memory, keyed by sheet and column, never in the document: the
// bytes on disk must not differ because somebody clicked a different rule.

const openIndex = new Map<string, number>()
const slotKey = (sheetId: string, colId: string): string => `${sheetId}/${colId}`

export function openRule(sheetId: string, colId: string, i: number): void {
  openIndex.set(slotKey(sheetId, colId), i)
}

const currentIndex = (sheetId: string, colId: string, n: number): number => {
  const i = openIndex.get(slotKey(sheetId, colId)) ?? 0
  return i >= 0 && i < n ? i : 0
}

// --- the section -------------------------------------------------------------

export interface CondFmtCtx {
  host: HTMLElement
  kit: PanelKit
  sheetId: string
  colId: string
  /** the column's name, for "Applies to" */
  scope: string
  /** column names a formula rule may bind, beside `value` */
  columns: readonly string[]
  rules: readonly Rule[]
  readOnly: boolean
  write(rules: Rule[]): void
  /** rebuild the panel — the rows below the dropdown depend on the kind */
  rerender(): void
}

export function buildCondFmtSection(ctx: CondFmtCtx): void {
  const { host, kit, rules, readOnly } = ctx
  kit.section(host, t('Conditional formatting'))
  kit.readonlyRow(host, t('Applies to'), ctx.scope)

  const at = currentIndex(ctx.sheetId, ctx.colId, rules.length)

  // The other rules, above the one being edited. Only when there is more than
  // one: a single rule needs no navigation, and a list of one reads as though
  // something is missing.
  if (rules.length > 1) {
    const list = document.createElement('div')
    list.className = 'dp-cf-list'
    rules.forEach((r, i) => {
      const b = document.createElement('button')
      b.className = `dp-btn dp-block${i === at ? ' dp-cf-on' : ''}`
      b.textContent = `${i + 1}. ${describeCondFmtRule(r)}`
      b.addEventListener('click', () => { openRule(ctx.sheetId, ctx.colId, i); ctx.rerender() })
      list.appendChild(b)
    })
    host.appendChild(list)
    kit.note(host, t('Rules apply in order and the last one to set a colour wins it — none of them silences another.'))
  }

  const rule: Rule | undefined = rules[at]
  // `string`, not the Rule union: the kind in a file can be one this build has
  // never heard of, and that is exactly the case the dropdown has to preserve.
  const kind: string = rule ? rule.kind : 'none'
  const known = kind === 'none' || (CF_KINDS as readonly string[]).includes(kind)

  const sel = kit.select(
    [
      ['none', t('No formatting')] as const,
      ...CF_KINDS.map((k) => [k, cfKindLabel(k)] as const),
      // A kind this build does not implement stays selectable-back-to, so it
      // cannot be deleted by opening the dropdown and closing it again.
      ...(known ? [] : [[kind, cfKindLabel(kind)] as const]),
    ],
    kind,
    (v) => {
      if (v === kind) return
      const next = [...rules]
      if (v === 'none') next.splice(at, 1)
      else if ((CF_KINDS as readonly string[]).includes(v)) next[at] = blankCondFmtRule(v as CfKind)
      else return
      openRule(ctx.sheetId, ctx.colId, Math.min(at, Math.max(0, next.length - 1)))
      ctx.write(next)
    },
  )
  sel.disabled = readOnly
  kit.row(host, t('Rule'), sel)

  if (!rule) {
    kit.note(host, t('A rule colours cells by what they CONTAIN, so the colour follows the data — sort, filter or edit a value and it moves with it.'))
    return
  }

  const put = (edit: Record<string, unknown>): void => {
    if (readOnly) return
    const next = [...rules]
    next[at] = { ...rule, ...edit } as Rule
    ctx.write(next)
  }
  const putStyle = (edit: Partial<CellStyle>): void => {
    const base = (rule as { style?: CellStyle }).style ?? {}
    put({ style: { ...base, ...edit } })
  }

  const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v))

  if (rule.kind === 'cellValue') {
    const op = kit.select(OPS.map((o) => [o, opLabel(o)] as const), rule.op, (v) => {
      const nextOp = v as CompareOp
      // The operand is re-read under the NEW op, so switching "greater than 40"
      // to "contains" keeps the 40 as the text "40" rather than as a number the
      // text branch would then compare by its digits.
      put({ op: nextOp, value: readOperand(nextOp, str(rule.value)) })
    })
    op.disabled = readOnly
    kit.row(host, t('Condition'), op)

    if (!NULLARY_OPS.has(rule.op)) {
      const val = kit.text(str(rule.value), (v) => put({ value: readOperand(rule.op, v) }))
      val.disabled = readOnly
      kit.row(host, t('Value'), val)
    }
    if (rule.op === 'between') {
      const hi = kit.text(str(rule.to), (v) => put({ to: readOperand(rule.op, v) }))
      hi.disabled = readOnly
      // NOT a row labelled "and". A bare conjunction is the worst possible
      // translation key — it is a fragment of an English sentence that no other
      // language builds the same way, and seven translators would each have to
      // guess what it joins.
      kit.row(host, t('Upper bound'), hi)
    }
    styleRows(host, kit, rule.style, readOnly, putStyle)
  } else if (rule.kind === 'colorScale') {
    // A HAND-EDITED OR IMPORTED RULE MAY HAVE NO `colors` AT ALL, and reading
    // `rule.colors[2]` off `undefined` threw out of the whole section — so the
    // properties panel went blank for the sheet, not just for the rule. The
    // panel is where you would go to REPAIR such a rule, which makes losing it
    // the worst possible response to a malformed one.
    //
    // `blankCondFmtRule` always supplies the array, so nothing this app creates
    // can reach here without it; the format is additive and PLATFORM §7 makes
    // hand-edited JSON a first-class way in, so "we always write it" is not the
    // same as "it is always there".
    const colors: Array<string | undefined> = Array.isArray(rule.colors) ? rule.colors : []
    const three = typeof colors[2] === 'string'
    const stop = (i: 0 | 1 | 2, fallback: string): HTMLElement =>
      colourControl(String(colors[i] ?? ''), fallback, readOnly, (v) => {
        const cols = [...colors] as [string, string, string?]
        cols[i] = v ?? fallback
        put({ colors: cols })
      }, t('Use the default colour'))

    kit.row(host, t('Lowest'), stop(0, '#fee2e2'))
    if (three) kit.row(host, t('Middle'), stop(1, '#fef9c3'))
    kit.row(host, t('Highest'), stop(three ? 2 : 1, '#dcfce7'))

    const mid = kit.check(three, (on) => {
      const cols: [string, string, string?] = on
        ? [rule.colors[0], '#fef9c3', rule.colors[1]]
        : [rule.colors[0], String(rule.colors[2] ?? rule.colors[1])]
      put({ colors: cols })
    })
    mid.disabled = readOnly
    kit.row(host, t('Middle colour'), mid)
    boundRows(host, kit, rule.min, rule.max, readOnly, put)
    if (three) {
      const pin = kit.text(str(rule.mid), (v) => {
        const n = Number(v.trim())
        put({ mid: v.trim() === '' || !Number.isFinite(n) ? undefined : n })
      })
      pin.disabled = readOnly
      kit.row(host, t('Middle at'), pin)
    }
    kit.note(host, t('Leave the bounds empty to scale from this column’s own data. Set them and two columns can be coloured on one scale, and compared.'))
  } else if (rule.kind === 'dataBar') {
    kit.row(host, t('Bar colour'), colourControl(rule.color, '#F7A600', readOnly,
      (v) => put({ color: v ?? '#F7A600' }), t('Use the default colour')))
    kit.row(host, t('Negative colour'), colourControl(String(rule.negativeColor ?? ''), '#E1616C', readOnly,
      (v) => put({ negativeColor: v ?? undefined }), t('Use the bar colour')))
    boundRows(host, kit, rule.min, rule.max, readOnly, put)
    kit.note(host, t('Zero sits where the data puts it and negatives run left from it, so one bar can be read against another.'))
  } else if (rule.kind === 'topN') {
    const n = kit.number(rule.n, 1, (v) => put({ n: Math.max(1, Math.round(v)) }))
    n.disabled = readOnly
    kit.row(host, t('How many'), n)
    const from = kit.select(
      [['top', t('Highest values')] as const, ['bottom', t('Lowest values')] as const],
      rule.bottom ? 'bottom' : 'top',
      (v) => put({ bottom: v === 'bottom' ? true : undefined }),
    )
    from.disabled = readOnly
    kit.row(host, t('Which end'), from)
    styleRows(host, kit, rule.style, readOnly, putStyle)
    kit.note(host, t('Ties are included: the top 1 of 10, 10, 9 is both tens, because highlighting one of two equal cells claims a difference the data does not have.'))
  } else if (rule.kind === 'duplicates') {
    styleRows(host, kit, rule.style, readOnly, putStyle)
    kit.note(host, t('Values that LOOK the same count as the same — trimmed, and ignoring case. Empty cells are never duplicates.'))
  } else if (rule.kind === 'formula') {
    const f = kit.text(rule.expr, (v) => put({ expr: v }))
    f.classList.add('dp-mono')
    f.disabled = readOnly
    kit.row(host, t('Expression'), f)
    styleRows(host, kit, rule.style, readOnly, putStyle)
    kit.note(host, t('“value” is this column, and other columns bind by name — so “value > [Target] * 1.1” colours one column by comparing it with another.'))
    const bad = unknownName(rule.expr, ctx.columns)
    if (bad) {
      kit.note(host, t('Nothing on this sheet is called {name}, so this rule matches no rows.')
        .replace('{name}', `“${bad}”`))
    }
  } else {
    kit.note(host, t('This rule came from a later build of dash. It is kept in the file and written back out unchanged, and this build paints nothing for it.'))
  }

  const add = document.createElement('button')
  add.className = 'dp-btn dp-block'
  add.textContent = t('Add another rule')
  add.disabled = readOnly
  add.addEventListener('click', () => {
    const next: Rule[] = [...rules, blankCondFmtRule('cellValue')]
    openRule(ctx.sheetId, ctx.colId, next.length - 1)
    ctx.write(next)
  })
  host.appendChild(add)
}

/** min/max, shared by the two rules that take a pinned domain. */
function boundRows(
  host: HTMLElement, kit: PanelKit,
  min: number | undefined, max: number | undefined,
  readOnly: boolean, put: (edit: Record<string, unknown>) => void,
): void {
  const one = (v: number | undefined, k: 'min' | 'max'): HTMLInputElement => {
    const el = kit.text(v === undefined ? '' : String(v), (s) => {
      const n = Number(s.trim())
      put({ [k]: s.trim() === '' || !Number.isFinite(n) ? undefined : n })
    })
    el.placeholder = t('from the data')
    el.disabled = readOnly
    return el
  }
  kit.row(host, t('Minimum'), one(min, 'min'))
  kit.row(host, t('Maximum'), one(max, 'max'))
}

/**
 * The four things a matching cell can be told to look like.
 *
 * Shared by every rule that carries a `style`, so a highlight, a top-10 and a
 * duplicates rule cannot end up offering three different sets of colours.
 */
function styleRows(
  host: HTMLElement, kit: PanelKit, style: CellStyle | undefined,
  readOnly: boolean, put: (edit: Partial<CellStyle>) => void,
): void {
  const s = style ?? {}
  kit.row(host, t('Text colour'), colourControl(String(s.color ?? ''), '#991b1b', readOnly,
    (v) => put({ color: v ?? undefined }), t('Leave the text colour alone')))
  kit.row(host, t('Background'), colourControl(String(s.bg ?? ''), '#fee2e2', readOnly,
    (v) => put({ bg: v ?? undefined }), t('Leave the background alone')))
  const b = kit.check(s.bold === true, (v) => put({ bold: v ? true : undefined }))
  b.disabled = readOnly
  kit.row(host, t('Bold'), b)
  const i = kit.check(s.italic === true, (v) => put({ italic: v ? true : undefined }))
  i.disabled = readOnly
  kit.row(host, t('Italic'), i)
}

/**
 * The first name in `expr` that is neither a column, a function, nor `value`.
 *
 * A misspelt column in a formula RULE has no error to show — the rule simply
 * matches nothing, and a rule that quietly matches nothing is indistinguishable
 * from one that is working on data that happens not to trigger it. validate.ts
 * reports this about a saved file; this reports it while it is being typed.
 */
export function unknownName(expr: string, columns: readonly string[]): string | null {
  if (!expr.trim()) return null
  const known = new Set(columns.map((c) => c.toLowerCase()))
  known.add('value')
  const fns = new Set(FUNCTIONS.map((f) => f.toUpperCase()))
  for (const d of dependencies(expr)) {
    if (!known.has(d.toLowerCase()) && !fns.has(d.toUpperCase())) return d
  }
  return null
}
