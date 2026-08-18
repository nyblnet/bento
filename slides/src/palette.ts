// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The document's BRAND palette, and the references that point at it.
//
// Not to be confused with `kernel/src/theme.ts`, which is the viewer's
// light/dark chrome preference and never document data. This is the opposite:
// it is the author's palette, it travels in the file, and every reader sees it.
//
// WHY REFERENCES AND NOT INHERITANCE. A deck is re-brandable when its colours
// point at a palette instead of repeating hex literals. The obvious way to get
// that is render-time inheritance — leave `fill` absent and look it up. We do
// not do that, for three reasons that are all fatal on their own:
//
//   1. It is not additive. Every shipped shell reads `el.fill` directly, so an
//      absent value renders as `undefined` — the frozen splice contract means
//      those shells exist forever and cannot be fixed.
//   2. Property ABSENCE would gain meaning, and absence is where this codebase's
//      CRDT has been bitten three times (1.0.15 and the two before it, all the
//      same one-line defect around a value that can legitimately be missing).
//   3. Resolution would have to run inside render, on every element, forever.
//
// So the literal always stays in the document, exactly as today, and a
// `themeRefs` map alongside it records where the literal CAME FROM. Changing
// the palette re-derives the literals. Old shells see an ordinary deck of
// ordinary hex colours; new shells can re-brand it. This is the same
// derive-not-commit shape `syncLinkedCharts` already uses: a pure function of
// document state, so every collaborating replica computes the same answer
// without exchanging a single operation.

import type { BentoDoc, Slide, SlideElement } from './model.ts'

/** The named slots, mirroring OOXML's scheme so an importer is a 1:1 map. */
export interface Palette {
  bg1: string; tx1: string; bg2: string; tx2: string
  accent1: string; accent2: string; accent3: string
  accent4: string; accent5: string; accent6: string
  hlink?: string; folHlink?: string
}

export const PALETTE_SLOTS = [
  'bg1', 'tx1', 'bg2', 'tx2',
  'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6',
  'hlink', 'folHlink',
] as const

export type PaletteSlot = (typeof PALETTE_SLOTS)[number]

/**
 * A parsed reference: a slot, plus an optional lightness shift in percent.
 *
 * `accent1` · `accent1 -20%` (darker) · `accent1 +40%` (lighter)
 *
 * ONE adjustment, in HSL, deliberately. PowerPoint distinguishes shade/tint
 * (linear-light RGB) from lumMod/lumOff/satOff (HSL); reproducing all four
 * faithfully is a colour-science exercise whose failure mode is a colour that
 * is plausible, consistently a little wrong, and invisible in review. An
 * importer resolves the source transform to a literal ALWAYS, and records a
 * reference only when the result is reproducible here within tolerance.
 * Everything else imports as a plain literal: correct on screen, simply not
 * re-brandable. A colour that would silently drift on the first palette edit is
 * worse than one that stays put.
 */
export interface ThemeRef {
  slot: PaletteSlot
  /** -100..100; 0 when omitted */
  shift: number
}

const SLOT_SET = new Set<string>(PALETTE_SLOTS)

/** Parse a token. Returns null for anything malformed — callers keep the literal. */
export function parseThemeRef(token: string): ThemeRef | null {
  const m = /^\s*([A-Za-z][A-Za-z0-9]*)\s*(?:([+-])\s*(\d{1,3})\s*%)?\s*$/.exec(token)
  if (!m) return null
  const slot = m[1]
  if (!SLOT_SET.has(slot)) return null
  if (!m[2]) return { slot: slot as PaletteSlot, shift: 0 }
  const n = Math.min(100, Number(m[3]))
  return { slot: slot as PaletteSlot, shift: m[2] === '-' ? -n : n }
}

export const formatThemeRef = (ref: ThemeRef): string =>
  ref.shift === 0 ? ref.slot : `${ref.slot} ${ref.shift > 0 ? '+' : '-'}${Math.abs(ref.shift)}%`

// --- colour maths ------------------------------------------------------------
// Hex in, hex out. Alpha is preserved verbatim: a palette shift changes
// lightness, never opacity, so `#RRGGBBAA` keeps its AA byte.

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

function parseHex(hex: string): { r: number; g: number; b: number; a: string } | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim())
  if (!m) return null
  let s = m[1]
  if (s.length <= 4) s = s.split('').map((c) => c + c).join('') // #abc → #aabbcc
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
    a: s.length === 8 ? s.slice(6, 8) : '',
  }
}

function rgbToHsl(r: number, g: number, b: number) {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6
  else if (max === G) h = ((B - R) / d + 2) / 6
  else h = ((R - G) / d + 4) / 6
  return { h, s, l }
}

function hslToRgb(h: number, s: number, l: number) {
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v } }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return {
    r: Math.round(hue(h + 1 / 3) * 255),
    g: Math.round(hue(h) * 255),
    b: Math.round(hue(h - 1 / 3) * 255),
  }
}

const hex2 = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')

/**
 * Apply a lightness shift. Positive moves toward white, negative toward black,
 * proportionally to the room available — so `+50%` on an already-light colour
 * does not blow out, and the operation is stable under repetition from the
 * SOURCE value (which is what makes derivation idempotent).
 */
export function shiftLightness(hex: string, shift: number): string {
  const c = parseHex(hex)
  if (!c) return hex // not a hex colour (a CSS name, a gradient) — leave it alone
  if (!shift) return hex
  const { h, s, l } = rgbToHsl(c.r, c.g, c.b)
  const t = clamp(shift, -100, 100) / 100
  const nl = t > 0 ? l + (1 - l) * t : l + l * t
  const { r, g, b } = hslToRgb(h, s, clamp(nl, 0, 1))
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${c.a}`
}

// --- resolution --------------------------------------------------------------

/** The palette a document resolves against, synthesised when it has none. */
export function paletteOf(doc: BentoDoc): Palette {
  const t = doc.theme
  const p = t.palette
  // The three canonical fields are the source of truth for their slots, always.
  // A document with no palette still resolves `bg1`/`tx1`/`accent1`, so a
  // reference is never dangling merely because nobody opened the theme editor.
  return {
    bg1: t.background, tx1: t.color, accent1: t.accent,
    bg2: p?.bg2 ?? t.color, tx2: p?.tx2 ?? t.background,
    accent2: p?.accent2 ?? t.accent, accent3: p?.accent3 ?? t.accent,
    accent4: p?.accent4 ?? t.accent, accent5: p?.accent5 ?? t.accent,
    accent6: p?.accent6 ?? t.accent,
    hlink: p?.hlink, folHlink: p?.folHlink,
  }
}

/** The literal a reference resolves to, or null when the slot is empty. */
export function resolveRef(token: string, palette: Palette): string | null {
  const ref = parseThemeRef(token)
  if (!ref) return null
  const base = palette[ref.slot]
  if (!base) return null
  return shiftLightness(base, ref.shift)
}

/** Read a dotted path (`fillGradient.stops.0.color`) off an object. */
function readPath(obj: unknown, path: string): unknown {
  let cur: any = obj
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}

/** Write a dotted path, refusing to CREATE anything that is not already there. */
function writePath(obj: unknown, path: string, value: string): boolean {
  const segs = path.split('.')
  let cur: any = obj
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return false
    cur = cur[segs[i]]
  }
  const last = segs[segs.length - 1]
  // Only overwrite an existing string. A ref whose target has been removed
  // (the gradient deleted, the shadow cleared) must not resurrect it.
  if (cur == null || typeof cur !== 'object' || typeof cur[last] !== 'string') return false
  if (cur[last] === value) return false
  cur[last] = value
  return true
}

type RefHolder = { themeRefs?: Record<string, string> }

function applyRefs(holder: RefHolder, palette: Palette): boolean {
  const refs = holder.themeRefs
  if (!refs) return false
  let changed = false
  for (const [path, token] of Object.entries(refs)) {
    const literal = resolveRef(token, palette)
    if (literal === null) continue // unknown slot / malformed — validate() reports it
    if (writePath(holder, path, literal)) changed = true
  }
  return changed
}

/**
 * Rewrite every referenced literal from the palette. Pure, idempotent, and
 * MUTATES the document in place.
 *
 * Idempotence matters more than it looks: this runs on the `doc` event behind a
 * signature guard, and a derivation that never settles is an infinite loop.
 * It holds because each literal is computed from the PALETTE value, never from
 * the literal's current contents — running twice recomputes the same answer.
 */
export function resolveThemeRefs(doc: BentoDoc): boolean {
  const palette = paletteOf(doc)
  let changed = false
  for (const slide of doc.slides) {
    if (applyRefs(slide as unknown as RefHolder, palette)) changed = true
    for (const el of slide.elements) {
      if (applyRefs(el as unknown as RefHolder, palette)) changed = true
    }
  }
  for (const layout of doc.layouts ?? []) {
    if (applyRefs(layout as unknown as RefHolder, palette)) changed = true
    for (const el of layout.elements) {
      if (applyRefs(el as unknown as RefHolder, palette)) changed = true
    }
  }
  return changed
}

/** Cheap signature: re-derive only when the palette actually moved. */
export function paletteSignature(doc: BentoDoc): string {
  const t = doc.theme
  return JSON.stringify([t.background, t.color, t.accent, t.palette])
}

/**
 * Set a colour AND its reference together — the one place the editor should go
 * through, so the two can never disagree. Passing `null` for the ref clears it,
 * which is what choosing a custom colour must do: otherwise the next palette
 * edit silently overwrites a colour somebody chose deliberately.
 */
export function setColor(
  holder: RefHolder & Record<string, unknown>,
  path: string,
  literal: string,
  ref: string | null,
): void {
  writePath(holder, path, literal)
  if (ref) (holder.themeRefs ??= {})[path] = ref
  else if (holder.themeRefs) {
    delete holder.themeRefs[path]
    if (!Object.keys(holder.themeRefs).length) delete holder.themeRefs
  }
}

/** The reference on a path, if any. */
export const refAt = (holder: RefHolder, path: string): string | undefined =>
  holder.themeRefs?.[path]

/** Every (holder, path, token) triple in the document — for validate(). */
export function eachRef(
  doc: BentoDoc,
  fn: (ctx: { slide: Slide; element?: SlideElement; path: string; token: string }) => void,
): void {
  for (const slide of doc.slides) {
    for (const [path, token] of Object.entries((slide as unknown as RefHolder).themeRefs ?? {})) {
      fn({ slide, path, token })
    }
    for (const el of slide.elements) {
      for (const [path, token] of Object.entries((el as unknown as RefHolder).themeRefs ?? {})) {
        fn({ slide, element: el, path, token })
      }
    }
  }
}

export { readPath as _readPath }
