// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Design tokens: named colours and numbers an element property is bound to.
//
// The palette's contract, widened to numbers and to names the author chooses
// (palette.ts explains why it is references and not inheritance). The literal
// always stays on the element; `themeRefs[path] = '$name'` records that it came
// from token `name`. Two derivations keep the pair honest, both pure functions
// of the document so every replica computes the same answer:
//
//   - the tokens moved (a value edited, the mode switched): rewrite every
//     bound literal from its token;
//   - anything else moved and a bound literal no longer equals its token: a
//     person changed it by hand (the inspector, a scrub, a paste, an older
//     shell that never heard of tokens), so the binding is dropped and the
//     literal they chose stays. One rule covers every edit path, where a
//     clear-on-write would have to be taught to each of them.

import type { BentoDoc, DesignTokens, Slide, SlideElement, TokenType, TokenValue } from './model.ts'
import { _readPath, keepAlpha } from './palette.ts'
import { SLIDE_CHECKS, SLIDE_TOKEN_KEYS, TOKEN_KEYS, checkElementProp } from './untrusted.ts'

export const TOKEN_TYPES: readonly TokenType[] = ['color', 'number', 'fontSize', 'opacity', 'fontFamily', 'shadow']

/** A name that would reach into Object.prototype (`toString`, `__proto__`,
 *  `constructor`…) where a plain lookup expects data. Never a token or mode name. */
export const protoName = (k: string): boolean => k in Object.prototype

/** `$name` → `name`; null when the ref is a palette slot or malformed. */
export function tokenName(ref: string | undefined): string | null {
  const m = /^\$([A-Za-z][\w.-]{0,63})$/.exec(ref ?? '')
  return m && !protoName(m[1]) ? m[1] : null
}

const own = (o: unknown, k: string): boolean => !!o && typeof o === 'object' && Object.hasOwn(o, k)

export const modesOf = (t: DesignTokens | undefined): string[] => {
  const modes = (Array.isArray(t?.modes) ? t.modes : []).filter((m) => typeof m === 'string' && !protoName(m))
  return modes.length ? modes : ['default']
}
export const activeMode = (t: DesignTokens | undefined): string => {
  const modes = modesOf(t)
  return t?.mode && modes.includes(t.mode) ? t.mode : modes[0]
}

/** A token's value in the active mode, falling back to the first mode that has one. */
export function tokenValue(doc: BentoDoc, name: string): TokenValue | undefined {
  const tk = doc.theme.tokens
  const tok = own(tk?.set, name) ? tk!.set[name] : undefined
  if (!tok || !own(tok, 'values')) return undefined
  for (const m of [activeMode(tk), ...modesOf(tk)]) if (own(tok.values, m) && tok.values[m] !== undefined) return tok.values[m]
  return undefined
}

/** Cheap signature: the bound literals are re-derived only when this moves. */
export const tokenSignature = (doc: BentoDoc): string => JSON.stringify(doc.theme.tokens ?? null)

type Holder = Record<string, unknown> & { themeRefs?: Record<string, string> }

/**
 * The property `path` on `holder` would hold after `value` is written there —
 * its top-level value, ready to store — or null when the write is refused.
 * A token is a value at the trust level of the file it came from, so every
 * write is held to the rule the property itself is held to on intake
 * (untrusted.ts): only a bindable key (TOKEN_KEYS), only own, non-prototype
 * path segments, only a finite number, and only a result the element (or
 * slide) gate accepts. Creates only the last key, on an existing parent.
 */
function candidate(holder: Holder, path: string, value: unknown): { top: string; next: unknown } | null {
  const segs = path.split('.')
  const top = segs[0]
  const slide = Array.isArray((holder as { elements?: unknown }).elements)
  if (!(slide ? SLIDE_TOKEN_KEYS : TOKEN_KEYS).has(top) || segs.some(protoName)) return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  const fresh = typeof value === 'object' && value ? structuredClone(value) : value // a shadow token is never aliased into elements
  let next: unknown = fresh
  if (segs.length > 1) {
    if (!own(holder, top)) return null
    next = structuredClone(holder[top])
    let cur: any = next
    for (const sg of segs.slice(1, -1)) { if (!own(cur, sg)) return null; cur = cur[sg] }
    if (cur == null || typeof cur !== 'object') return null
    cur[segs[segs.length - 1]] = fresh
  }
  // the gate must take the value AS IS: one it would clamp or trim (0 grid
  // columns, an unknown key) is not a value this property holds
  const gated = slide ? SLIDE_CHECKS[top](next) : (({ ok, value }) => (ok ? value : undefined))(checkElementProp(String(holder.type), top, next))
  return gated !== undefined && same(gated, next) ? { top, next } : null
}

/** Write `value` at `path` if the property accepts it; true when something changed. */
function writeAt(holder: Holder, path: string, value: unknown): boolean {
  if (same(_readPath(holder, path), value)) return false
  const c = candidate(holder, path, value)
  if (!c) return false
  holder[c.top] = c.next
  return true
}

function want(doc: BentoDoc, holder: Holder, path: string, name: string): TokenValue | undefined {
  const v = tokenValue(doc, name)
  // only a colour keeps the property's own opacity; a font stack is a string too
  return typeof v === 'string' && (doc.theme.tokens!.set[name].type ?? 'color') === 'color' ? keepAlpha(_readPath(holder, path), v) : v
}

function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase()
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort() // key order is not a hand edit
    return JSON.stringify(a, keys) === JSON.stringify(b, keys)
  }
  return a === b
}

function dropRef(holder: Holder, path: string) {
  delete holder.themeRefs![path]
  if (!Object.keys(holder.themeRefs!).length) delete holder.themeRefs
}

/**
 * Keep bound literals and their tokens in step. `tokensMoved`: the tokens
 * changed since the last call, so literals follow them; otherwise a literal
 * that disagrees was edited by hand and loses its binding. A ref to a token
 * that does not exist is left alone (validate() reports it). Returns whether
 * anything was written. Idempotent.
 */
export function syncTokenRefs(doc: BentoDoc, tokensMoved: boolean): boolean {
  let changed = false
  const visit = (holder: Holder) => {
    const refs = holder.themeRefs
    if (!refs) return
    for (const [path, ref] of Object.entries(refs)) {
      const name = tokenName(ref)
      if (!name) continue
      const w = want(doc, holder, path, name)
      if (w === undefined) continue
      if (tokensMoved) { if (writeAt(holder, path, w)) changed = true }
      else if (!same(_readPath(holder, path), w)) { dropRef(holder, path); changed = true }
    }
  }
  for (const s of [...doc.slides, ...(doc.layouts ?? [])] as Array<Slide | { elements: SlideElement[] }>) {
    visit(s as unknown as Holder)
    for (const el of s.elements) visit(el as unknown as Holder)
  }
  return changed
}

/** Bind `path` on `holder` to token `name`: writes its value and the ref, one edit. */
export function bindToken(doc: BentoDoc, holder: Holder, path: string, name: string): boolean {
  const v = want(doc, holder, path, name)
  if (v === undefined || !candidate(holder, path, v)) return false // not a property this token can drive
  writeAt(holder, path, v)
  ;(holder.themeRefs ??= {})[path] = `$${name}`
  return true
}

/** Drop a binding; the literal stays. */
export function unbindToken(holder: Holder, path: string): void {
  if (tokenName(holder.themeRefs?.[path])) dropRef(holder, path)
}

/** Rename a token and every ref to it. */
export function renameToken(doc: BentoDoc, from: string, to: string): void {
  const tk = doc.theme.tokens
  if (!own(tk?.set, from) || own(tk?.set, to) || !tokenName(`$${to}`)) return
  tk!.set = Object.fromEntries(Object.entries(tk!.set).map(([k, v]) => [k === from ? to : k, v]))
  eachHolder(doc, (h) => {
    for (const [p, r] of Object.entries(h.themeRefs ?? {})) if (r === `$${from}`) h.themeRefs![p] = `$${to}`
  })
}

/** Delete a token; bound literals keep their current values. */
export function deleteToken(doc: BentoDoc, name: string): void {
  const tk = doc.theme.tokens
  if (!own(tk?.set, name)) return
  delete tk!.set[name]
  eachHolder(doc, (h) => {
    for (const [p, r] of Object.entries(h.themeRefs ?? {})) if (r === `$${name}`) dropRef(h, p)
  })
  if (!Object.keys(tk!.set).length && !tk!.modes?.length) delete doc.theme.tokens
}

/** How many properties are bound to each token (the Tokens view shows it). */
export function tokenUses(doc: BentoDoc): Map<string, number> {
  const n = new Map<string, number>()
  eachHolder(doc, (h) => {
    for (const r of Object.values(h.themeRefs ?? {})) {
      const name = tokenName(r)
      if (name) n.set(name, (n.get(name) ?? 0) + 1)
    }
  })
  return n
}

function eachHolder(doc: BentoDoc, fn: (h: Holder) => void) {
  for (const s of [...doc.slides, ...(doc.layouts ?? [])] as Array<{ elements: SlideElement[] }>) {
    fn(s as unknown as Holder)
    for (const el of s.elements) fn(el as unknown as Holder)
  }
}

/** The colour paths a literal is adopted from: an element's paint and text, a slide's background. */
const COLOR_PATHS = ['fill', 'stroke', 'color'] as const

/** Every element (and slide background) whose literal colour is `hex`, ignoring
 *  its opacity, with no reference on that path yet. */
export function colorUses(doc: BentoDoc, hex: string): Array<{ slide: Slide; element?: SlideElement; path: string }> {
  const out: Array<{ slide: Slide; element?: SlideElement; path: string }> = []
  const want = hex.toLowerCase()
  const is = (v: unknown) => typeof v === 'string' && hexOf(v) === want
  for (const slide of doc.slides) {
    if (is(slide.background) && !(slide as unknown as Holder).themeRefs?.background) out.push({ slide, path: 'background' })
    for (const el of slide.elements) {
      const h = el as unknown as Holder
      for (const path of COLOR_PATHS) if (is(h[path]) && !h.themeRefs?.[path]) out.push({ slide, element: el, path })
    }
  }
  return out
}

/** `#rrggbb` of a CSS colour (hex or rgb[a]); '' when it is neither. */
function hexOf(v: string): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v.trim())
  if (m) return '#' + (m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]).toLowerCase()
  const r = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v.trim())
  return r ? '#' + [r[1], r[2], r[3]].map((n) => Math.min(255, +n).toString(16).padStart(2, '0')).join('') : ''
}

/**
 * Make a colour token from `hex` and bind every literal use of that colour in
 * the deck to it (ponytail: element fill/stroke/colour and slide backgrounds —
 * gradient stops and stacked layers stay literals). Returns how many uses
 * now follow the token; the token is created even when none do.
 */
export function adoptColor(doc: BentoDoc, hex: string, name: string): number {
  const tk = (doc.theme.tokens ??= { set: {} })
  if (own(tk.set, name) || !tokenName(`$${name}`)) return 0
  tk.set[name] = { type: 'color', values: Object.fromEntries(modesOf(tk).map((m) => [m, hex])) }
  let n = 0
  for (const u of colorUses(doc, hex)) if (bindToken(doc, (u.element ?? u.slide) as unknown as Holder, u.path, name)) n++
  return n
}

/** A free token name: `base`, else `base.2`, `base.3`… */
export function freeTokenName(doc: BentoDoc, base: string): string {
  const set = doc.theme.tokens?.set
  if (!own(set, base)) return base
  for (let i = 2; ; i++) if (!own(set, `${base}.${i}`)) return `${base}.${i}`
}

/** Where each token is bound, in deck order: a slide, and the element (absent = the slide itself). */
export function tokenTargets(doc: BentoDoc, name: string): Array<{ slideId: string; elementId?: string }> {
  const out: Array<{ slideId: string; elementId?: string }> = []
  const bound = (h: Holder) => Object.values(h.themeRefs ?? {}).some((r) => tokenName(r) === name)
  for (const s of doc.slides) {
    if (bound(s as unknown as Holder)) out.push({ slideId: s.id })
    for (const el of s.elements) if (bound(el as unknown as Holder)) out.push({ slideId: s.id, elementId: el.id })
  }
  return out
}

/** Why `name` cannot name a token, or null when it can. */
export function tokenNameError(doc: BentoDoc, name: string, except?: string): string | null {
  if (!tokenName(`$${name}`)) return 'Start with a letter; then letters, digits, . - _ (64 at most)'
  if (name !== except && own(doc.theme.tokens?.set, name)) return 'A token already has that name'
  return null
}

