// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Conditional formatting — rules in, styles out.
//
// PURE FUNCTIONS, NO DOM. A rule evaluates to a style and the grid applies it.
// That split is what makes the feature testable in node, and it is also what
// makes it cheap: the grid is windowed (grid.ts), so it asks for the styles of
// the ~40 rows it is about to paint, not of 100,000 it is not.
//
// RULES COMPOSE, THEY DO NOT SHADOW. Excel's rule list is first-match-wins with
// a "Stop If True" checkbox, and the result is the single most common complaint
// about the feature: a colour scale and a "highlight negatives in red" rule are
// both correct, both wanted, and one of them silently does nothing. Here the
// LAST rule to set a PROPERTY wins that property, so a scale under a cell-value
// rule keeps its background and takes the later rule's text colour. Composing
// wrongly is visible; discarding silently is not.
//
// COLOURS BLEND IN LINEAR LIGHT, not by averaging the encoded bytes. sRGB is
// gamma-encoded (~2.2), so the byte 128 is NOT half the light of 255 — it is
// about 21.6% of it. Averaging bytes therefore loses about half the luminance
// at the midpoint, which is why so many three-colour heatmaps have a dark muddy
// band through the middle. The working, for red→green at t = 0.5:
//
//   naive   (255+0)/2 = 128         → #808000, a dark olive-brown
//   linear  lin(255)=1, lin(0)=0
//           mid = 0.5 in LIGHT
//           enc(0.5) = 1.055·0.5^(1/2.4) − 0.055 = 0.7354 → 188
//                                   → #bcbc00, the yellow a person expects
//
// Alpha is NOT gamma-encoded — it is a coverage fraction — so it interpolates
// linearly while the colour channels do not. Getting that backwards makes
// translucent scales wrong in the opposite direction.
//
// DATA BARS SHARE ONE ZERO AXIS. This is the part naive implementations get
// wrong: they map each value onto (v − min)/(max − min) from the LEFT EDGE, so
// the most negative row gets a bar of length zero (invisible — the row that
// most needs to be seen) and −50 beside +100 draws two-thirds as long as it
// should. Zero belongs at |min|/(|min| + max) of the width, with one scale for
// both sides and negatives running left from it. `axis` rides on every entry
// because the renderer cannot recompute it from a single row.
//
// NO SPREAD MEANS NO RANKING. When every value is identical the fraction is
// 0/0. Every cell is simultaneously the minimum and the maximum, so the only
// non-arbitrary answer is the middle of the ramp — it claims neither "lowest"
// nor "highest". What it must never be is NaN, which reaches CSS as
// `#NaNNaNNaN` and paints nothing, on the day the data happened to be flat.
//
// A CELL WITH NO NUMBER GETS NO COLOUR. Text in a numeric column has no
// position on a scale; giving it the min colour reads as "this is the lowest
// value", which is a claim about data that is not there.
//
// Never `Math.min(...values)`: the spread is one argument per row and blows the
// stack somewhere past ~125k of them, which is inside the row target the format
// was sized for. Every reduction here is a loop.

import { evaluate, isErr, type Cell, type EvalCtx, type Vec } from './formula.ts'

// --- styles ------------------------------------------------------------------

/**
 * What a rule can say about one cell. Every property is optional because
 * composition merges by PROPERTY: an absent one means "this rule has no opinion
 * here", which is not the same as "clear it".
 */
export interface CellStyle {
  color?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  bar?: BarStyle
}

export interface BarStyle {
  /** 0–100, as a fraction of the WHOLE cell width, measured FROM `axis`. */
  pct: number
  color: string
  /** draw leftwards from the axis */
  negative?: boolean
  /**
   * Where zero sits, 0–100 from the left edge. Carried per cell rather than
   * returned once because the grid paints one row at a time and a bar drawn
   * without its axis is drawn in the wrong place.
   */
  axis?: number
}

// --- rules -------------------------------------------------------------------

export type CompareOp =
  | '>' | '>=' | '<' | '<=' | '=' | '<>'
  | 'between' | 'contains' | 'startsWith' | 'endsWith' | 'blank' | 'notBlank'

export interface CellValueRule {
  kind: 'cellValue'
  op: CompareOp
  value?: unknown
  /** the upper bound of `between`; ignored by every other op */
  to?: unknown
  style: CellStyle
}

/** `colors` is [low, high] or [low, mid, high]. */
export type ScaleColors = [string, string, string?]

export interface ColorScaleRule {
  kind: 'colorScale'
  /** Absent means "from the data". Present pins the domain, so two columns can
   *  be coloured on the SAME scale and compared — which is the whole reason a
   *  fixed domain exists. */
  min?: number
  mid?: number
  max?: number
  colors: ScaleColors
}

export interface DataBarRule {
  kind: 'dataBar'
  color: string
  /** Absent = negatives use `color`. A different colour is the honest default
   *  for a signed column, but it is the author's call, not ours. */
  negativeColor?: string
  min?: number
  max?: number
}

export interface TopNRule {
  kind: 'topN'
  n: number
  bottom?: boolean
  style: CellStyle
}

export interface DuplicatesRule { kind: 'duplicates'; style: CellStyle }

/**
 * An arbitrary expression, evaluated by the formula engine with the column
 * bound to `value` — `value > AVERAGE(value)` is one vectorised pass, not one
 * parse per row.
 */
export interface FormulaRule { kind: 'formula'; expr: string; style: CellStyle }

export type Rule =
  | CellValueRule | ColorScaleRule | DataBarRule
  | TopNRule | DuplicatesRule | FormulaRule

// --- numbers -----------------------------------------------------------------

/**
 * The numeric position of a cell, or null if it has none.
 *
 * Deliberately STRICTER than formula.ts's `num`, which strips `%`, `,` and
 * currency glyphs so that arithmetic over a scruffy import still works. Ranking
 * is a different job: `num` puts "50%" at 50, which on a scale beside 0.5 is a
 * category error — the two would sit at opposite ends of a colour ramp while
 * meaning the same thing. So only a real number, or text that is unambiguously
 * one, gets a position. Booleans do not: a tick column has no magnitude.
 */
function numOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  return null
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

/** min/max in one loop. Spreading into Math.min overflows the stack at 100k. */
function extent(values: unknown[]): { lo: number; hi: number; any: boolean } {
  let lo = Infinity
  let hi = -Infinity
  let any = false
  for (const v of values) {
    const n = numOf(v)
    if (n === null) continue
    any = true
    if (n < lo) lo = n
    if (n > hi) hi = n
  }
  return { lo, hi, any }
}

// --- colour ------------------------------------------------------------------

interface RGBA { r: number; g: number; b: number; a: number }

/**
 * Hex (3/4/6/8) and rgb()/rgba() with numeric channels. Named colours and
 * `var(--accent)` return null ON PURPOSE: resolving them needs a DOM, this file
 * has none, and inventing black would be a wrong colour rather than a missing
 * one. `mixColors` degrades to the nearest stop instead — still a colour the
 * author actually chose.
 */
function parseColor(s: string): RGBA | null {
  const t = s.trim()
  const hex = /^#([0-9a-f]+)$/i.exec(t)
  if (hex) {
    const h = hex[1]
    if (h.length === 3 || h.length === 4) {
      const ch = [...h].map((c) => parseInt(c + c, 16))
      return { r: ch[0], g: ch[1], b: ch[2], a: h.length === 4 ? ch[3] / 255 : 1 }
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      }
    }
    return null
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(t)
  if (!fn) return null
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number)
  if (parts.length < 3 || !parts.slice(0, 3).every((x) => Number.isFinite(x))) return null
  const a = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1
  return { r: parts[0], g: parts[1], b: parts[2], a }
}

const hex2 = (x: number): string =>
  Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0')

/** `#rrggbb` while opaque — shortest, and what a colour input round-trips. */
function formatColor(c: RGBA): string {
  if (c.a >= 1) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`
  const a = Math.round(clamp(c.a, 0, 1) * 1000) / 1000
  return `rgba(${Math.round(clamp(c.r, 0, 255))}, ${Math.round(clamp(c.g, 0, 255))}, ${Math.round(clamp(c.b, 0, 255))}, ${a})`
}

// The sRGB transfer function, both directions. The 0.04045/0.0031308 elbow is
// the linear segment near black — dropping it (a plain 2.2 power) is close but
// visibly wrong in the darkest few percent, which is exactly where a "low"
// colour usually lives.
const toLinear = (c: number): number => {
  const x = clamp(c, 0, 255) / 255
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}
const toSrgb = (x: number): number => {
  const c = x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055
  return Math.round(clamp(c, 0, 1) * 255)
}

/**
 * Blend two colours in linear light. `t` outside [0,1] clamps, and t exactly at
 * an endpoint returns that endpoint EXACTLY — a stop must never drift by a
 * rounding unit as it passes through the encode/decode round trip, or the
 * author's chosen midpoint colour is not the colour anybody sees at the middle.
 */
export function mixColors(a: string, b: string, t: number): string {
  const ca = parseColor(a)
  const cb = parseColor(b)
  // Unparseable: snap, do not invent. See parseColor.
  if (!ca || !cb) return t < 0.5 ? a : b
  if (t <= 0) return formatColor(ca)
  if (t >= 1) return formatColor(cb)
  const ch = (x: number, y: number): number => toSrgb(toLinear(x) + (toLinear(y) - toLinear(x)) * t)
  return formatColor({
    r: ch(ca.r, cb.r),
    g: ch(ca.g, cb.g),
    b: ch(ca.b, cb.b),
    // coverage, not light: linear in the encoded value
    a: ca.a + (cb.a - ca.a) * t,
  })
}

export interface ScaleOpts { min?: number; mid?: number; max?: number }

/**
 * One colour per value. Non-numeric cells get `''` — no colour, not the low
 * colour.
 *
 * Two stops ramp low→high. Three ramp low→mid→high with `mid` at the VALUE the
 * author names (default: halfway between the bounds), so a diverging scale can
 * be pinned to zero on a column that runs −20…+300 and the neutral colour lands
 * on zero rather than on 140.
 */
export function colorScale(values: unknown[], colors: ScaleColors, opts: ScaleOpts = {}): string[] {
  // A rule is DOCUMENT data, so `colors` is whatever the file said it was.
  // Two stops are the minimum a ramp can have; below that there is nothing to
  // interpolate and no colour is the honest answer. Nothing here may throw —
  // this runs inside the grid's paint path, and an exception there blanks the
  // whole grid over one bad rule.
  const list: unknown[] = Array.isArray(colors) ? colors : []
  if (typeof list[0] !== 'string' || typeof list[1] !== 'string') return values.map(() => '')

  const { lo: dataLo, hi: dataHi } = extent(values)
  const lo = opts.min ?? dataLo
  const hi = opts.max ?? dataHi
  const three = typeof list[2] === 'string'
  const c0 = list[0]
  const c1 = list[1]
  const c2 = three ? (list[2] as string) : list[1]

  // With no numeric values at all lo/hi are ±Infinity, so the span is negative
  // and this falls into the degenerate branch below — where every cell is
  // non-numeric and therefore uncoloured anyway. No special case needed, and no
  // NaN can escape.
  const span = hi - lo
  if (!(span > 0)) {
    // No spread, so no ranking (header). Middle of the ramp, and for a
    // three-stop scale that is exactly the author's mid colour.
    const flat = three ? mixColors(c1, c1, 0) : mixColors(c0, c2, 0.5)
    return values.map((v) => (numOf(v) === null ? '' : flat))
  }

  const mid = opts.mid ?? (lo + hi) / 2
  return values.map((v) => {
    const n = numOf(v)
    if (n === null) return ''
    const x = clamp(n, lo, hi)
    if (!three) return mixColors(c0, c2, (x - lo) / span)
    if (x <= mid) {
      const sub = mid - lo
      // mid pinned AT the low bound: everything at or below it is the mid colour
      return mixColors(c0, c1, sub > 0 ? clamp((x - lo) / sub, 0, 1) : 1)
    }
    const sub = hi - mid
    return mixColors(c1, c2, sub > 0 ? clamp((x - mid) / sub, 0, 1) : 0)
  })
}

// --- data bars ---------------------------------------------------------------

export interface BarOpts { min?: number; max?: number }

export interface BarWidth {
  /** 0–100 of the whole cell width, measured from `axis`. */
  pct: number
  negative: boolean
  /** 0–100 from the left edge: where zero is. Identical for every row. */
  axis: number
}

/**
 * Bar geometry for a column, sharing ONE zero axis and ONE scale.
 *
 * The domain includes zero by default (`min(0, …)`, `max(0, …)`) — Excel's
 * automatic rule, and the right one twice over: a column of 10…20 draws bars in
 * proportion to their VALUES rather than making 10 invisible because it happens
 * to be the smallest, and an all-equal column gets full bars instead of 0/0.
 */
export function dataBarWidths(values: unknown[], opts: BarOpts = {}): BarWidth[] {
  const { lo: dataLo, hi: dataHi, any } = extent(values)
  const lo = opts.min ?? (any ? Math.min(0, dataLo) : 0)
  const hi = opts.max ?? (any ? Math.max(0, dataHi) : 0)
  const span = hi - lo
  if (!(span > 0)) return values.map(() => ({ pct: 0, negative: false, axis: 0 }))

  // Zero's share of the width. All-positive data puts it at the left edge (0),
  // all-negative at the right (100), and a signed column somewhere between —
  // which is the only way a −50 and a +100 can be read against each other.
  const axis = clamp((-lo / span) * 100, 0, 100)
  return values.map((v) => {
    const n = numOf(v)
    if (n === null) return { pct: 0, negative: false, axis }
    const x = clamp(n, lo, hi)
    return { pct: clamp((Math.abs(x) / span) * 100, 0, 100), negative: x < 0, axis }
  })
}

// --- predicates --------------------------------------------------------------

const isBlank = (v: unknown): boolean =>
  v == null || (typeof v === 'string' && v.trim() === '')

const text = (v: unknown): string => (v == null ? '' : String(v).trim().toLowerCase())

/**
 * Numeric when BOTH sides are numeric, otherwise a case-insensitive text
 * compare — Excel's rule, and the one people expect when a rule written for a
 * number column meets a column that turned out to be text.
 */
function compare(op: CompareOp, a: unknown, b: unknown): boolean {
  const x = numOf(a)
  const y = numOf(b)
  if (x !== null && y !== null) {
    switch (op) {
      case '>': return x > y
      case '>=': return x >= y
      case '<': return x < y
      case '<=': return x <= y
      case '=': return x === y
      case '<>': return x !== y
      default: return false
    }
  }
  const s = text(a)
  const t = text(b)
  switch (op) {
    case '>': return s > t
    case '>=': return s >= t
    case '<': return s < t
    case '<=': return s <= t
    case '=': return s === t
    case '<>': return s !== t
    default: return false
  }
}

function matchCellValue(rule: CellValueRule, v: unknown): boolean {
  switch (rule.op) {
    case 'blank': return isBlank(v)
    case 'notBlank': return !isBlank(v)
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      const needle = text(rule.value)
      // An empty needle matches every cell — a rule that says nothing while
      // looking like it says something. Refuse it.
      if (needle === '') return false
      const s = text(v)
      return rule.op === 'contains' ? s.includes(needle)
        : rule.op === 'startsWith' ? s.startsWith(needle)
          : s.endsWith(needle)
    }
    case 'between': {
      const n = numOf(v)
      const a = numOf(rule.value)
      const b = numOf(rule.to)
      if (n === null || a === null || b === null) return false
      // bounds sort themselves: "between 100 and 10" is a typo, not an empty set
      return n >= Math.min(a, b) && n <= Math.max(a, b)
    }
    default: return compare(rule.op, v, rule.value)
  }
}

/**
 * The n largest (or smallest) values, TIES INCLUDED.
 *
 * Excluding a tie means the rule picks arbitrarily between two identical
 * numbers, and the grid then shows one of two visibly equal cells highlighted —
 * which reads as a difference in the data that does not exist. So "top 1" of
 * 10, 10, 9 is both tens.
 */
function topNMask(values: unknown[], n: number, bottom: boolean): boolean[] {
  const none = values.map(() => false)
  if (!(n > 0)) return none
  const nums: number[] = []
  for (const v of values) {
    const x = numOf(v)
    if (x !== null) nums.push(x)
  }
  if (!nums.length) return none
  nums.sort((a, b) => (bottom ? a - b : b - a))
  const cut = nums[Math.min(n, nums.length) - 1]
  return values.map((v) => {
    const x = numOf(v)
    return x !== null && (bottom ? x <= cut : x >= cut)
  })
}

/**
 * Values appearing more than once.
 *
 * Compared as trimmed, case-insensitive text, so what LOOKS the same counts as
 * the same — the rule exists to catch what the eye should have caught, and a
 * reader who sees "ACME" twice does not care that one of them is a number or
 * has a trailing space. Blanks are never duplicates: absence repeated is still
 * absence, and flagging it lights up every empty cell in a sparse column.
 */
function duplicatesMask(values: unknown[]): boolean[] {
  const seen = new Map<string, number>()
  const keys = values.map((v) => (isBlank(v) ? null : text(v)))
  for (const k of keys) if (k !== null) seen.set(k, (seen.get(k) ?? 0) + 1)
  return keys.map((k) => k !== null && (seen.get(k) ?? 0) > 1)
}

const toCell = (v: unknown): Cell => {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' || typeof v === 'boolean') return v
  return String(v)
}

/**
 * Spreadsheet truth, not JavaScript truth. Only TRUE, a non-zero number, or the
 * word "true" match; an error never does. JS would call every non-empty string
 * truthy, so `expr: 'UPPER(value)'` would light up the entire column.
 */
const truthy = (c: Cell | undefined): boolean => {
  if (c == null || isErr(c)) return false
  if (typeof c === 'boolean') return c
  if (typeof c === 'number') return c !== 0
  return c.trim().toLowerCase() === 'true'
}

function formulaMask(expr: string, values: unknown[], cols?: Record<string, unknown[]>): boolean[] {
  const map = new Map<string, Vec>()
  if (cols) {
    for (const [k, v] of Object.entries(cols)) {
      const vec: Vec = v.map(toCell)
      map.set(k, vec)
      map.set(k.toLowerCase(), vec)
    }
  }
  // last, so `value` always means the column being formatted
  map.set('value', values.map(toCell))
  const ctx: EvalCtx = { cols: map, n: values.length }
  const out = evaluate(expr, ctx)
  return values.map((_, i) => truthy(out[i]))
}

// --- evaluation --------------------------------------------------------------

/**
 * Merge one rule's opinion over what earlier rules said.
 *
 * Property by property, and NOT by spreading `next`: an object that carries an
 * explicit `bg: undefined` (which is what `{...rule.style}` produces after a
 * property is cleared in the UI) would spread that undefined straight over a
 * background an earlier rule set, deleting it. Silently.
 */
function mergeStyle(base: CellStyle | null, next: CellStyle): CellStyle {
  const out: CellStyle = base ? { ...base } : {}
  if (next.color !== undefined) out.color = next.color
  if (next.bg !== undefined) out.bg = next.bg
  if (next.bold !== undefined) out.bold = next.bold
  if (next.italic !== undefined) out.italic = next.italic
  if (next.bar !== undefined) out.bar = next.bar
  return out
}

function stylesFor(
  rule: Rule,
  values: unknown[],
  cols?: Record<string, unknown[]>,
): Array<CellStyle | null> {
  // A rule with no `style` cannot say anything, and a file can carry one.
  const mask = (m: boolean[], style: CellStyle | undefined): Array<CellStyle | null> =>
    style && typeof style === 'object' ? m.map((hit) => (hit ? style : null)) : values.map(() => null)

  switch (rule.kind) {
    case 'colorScale':
      return colorScale(values, rule.colors, rule).map((bg) => (bg ? { bg } : null))

    case 'dataBar': {
      const widths = dataBarWidths(values, rule)
      return widths.map((w, i) => (numOf(values[i]) === null ? null : {
        bar: {
          pct: w.pct,
          color: w.negative ? (rule.negativeColor ?? rule.color) : rule.color,
          ...(w.negative ? { negative: true } : {}),
          axis: w.axis,
        },
      }))
    }

    case 'cellValue':
      return mask(values.map((v) => matchCellValue(rule, v)), rule.style)

    case 'topN':
      return mask(topNMask(values, rule.n, rule.bottom === true), rule.style)

    case 'duplicates':
      return mask(duplicatesMask(values), rule.style)

    case 'formula':
      return mask(formulaMask(rule.expr, values, cols), rule.style)

    default:
      // A rule kind from a later build. Ignored, never thrown on and never
      // guessed at — model.ts's policy for unknown ops, for the same reason: a
      // file must open, and a formatting rule nobody can read must not paint
      // something that is merely plausible.
      return values.map(() => null)
  }
}

/**
 * One style per row, or null where no rule had anything to say.
 *
 * Rules apply IN ORDER and the last one to set a property wins it, so ordering
 * is meaningful without any rule being able to silence another (header).
 *
 * `cols` is the cross-column escape hatch: with it, a formula rule can say
 * `value > [Target] * 1.1` and colour the Actual column by comparing it against
 * another. Without it a formula sees `value` alone, which covers the common
 * case and keeps the caller free of the whole sheet.
 */
export function evaluateRules(
  rules: Rule[],
  values: unknown[],
  cols?: Record<string, unknown[]>,
): Array<CellStyle | null> {
  const out: Array<CellStyle | null> = values.map(() => null)
  if (!values.length || !Array.isArray(rules)) return out
  for (const rule of rules) {
    // The list came out of the document. A hand edit can put anything in it,
    // and the rules AROUND a broken one are still the author's intent.
    if (!rule || typeof rule !== 'object') continue
    const styles = stylesFor(rule, values, cols)
    for (let i = 0; i < values.length; i++) {
      const s = styles[i]
      // mergeStyle always builds a fresh object, so a caller can never mutate a
      // rule's own style through the result
      if (s) out[i] = mergeStyle(out[i], s)
    }
  }
  return out
}
