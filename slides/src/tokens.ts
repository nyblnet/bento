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

import type { BentoDoc, DesignTokens, Slide, SlideElement } from './model.ts'
import { _readPath, keepAlpha } from './palette.ts'

/** `$name` → `name`; null when the ref is a palette slot or malformed. */
export function tokenName(ref: string | undefined): string | null {
  const m = /^\$([A-Za-z][\w.-]{0,63})$/.exec(ref ?? '')
  return m ? m[1] : null
}

export const modesOf = (t: DesignTokens | undefined): string[] => t?.modes?.length ? t.modes : ['default']
export const activeMode = (t: DesignTokens | undefined): string => {
  const modes = modesOf(t)
  return t?.mode && modes.includes(t.mode) ? t.mode : modes[0]
}

/** A token's value in the active mode, falling back to the first mode that has one. */
export function tokenValue(doc: BentoDoc, name: string): string | number | undefined {
  const tk = doc.theme.tokens
  const tok = tk?.set[name]
  if (!tok) return undefined
  const v = tok.values[activeMode(tk)]
  if (v !== undefined) return v
  for (const m of modesOf(tk)) if (tok.values[m] !== undefined) return tok.values[m]
  return undefined
}

/** Cheap signature: the bound literals are re-derived only when this moves. */
export const tokenSignature = (doc: BentoDoc): string => JSON.stringify(doc.theme.tokens ?? null)

type Holder = Record<string, unknown> & { themeRefs?: Record<string, string> }

/** Write a dotted path, creating only the last key on an existing parent. */
function writeAt(obj: unknown, path: string, value: unknown): boolean {
  const segs = path.split('.')
  let cur: any = obj
  for (const s of segs.slice(0, -1)) {
    if (cur == null || typeof cur !== 'object') return false
    cur = cur[s]
  }
  const last = segs[segs.length - 1]
  if (cur == null || typeof cur !== 'object' || cur[last] === value) return false
  cur[last] = value
  return true
}

function want(doc: BentoDoc, holder: Holder, path: string, name: string): string | number | undefined {
  const v = tokenValue(doc, name)
  return typeof v === 'string' ? keepAlpha(_readPath(holder, path), v) : v
}

const same = (a: unknown, b: unknown) =>
  typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b

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
export function bindToken(doc: BentoDoc, holder: Holder, path: string, name: string): void {
  const v = want(doc, holder, path, name)
  if (v === undefined) return
  writeAt(holder, path, v)
  ;(holder.themeRefs ??= {})[path] = `$${name}`
}

/** Drop a binding; the literal stays. */
export function unbindToken(holder: Holder, path: string): void {
  if (tokenName(holder.themeRefs?.[path])) dropRef(holder, path)
}

/** Rename a token and every ref to it. */
export function renameToken(doc: BentoDoc, from: string, to: string): void {
  const tk = doc.theme.tokens
  if (!tk?.set[from] || tk.set[to] || !tokenName(`$${to}`)) return
  tk.set = Object.fromEntries(Object.entries(tk.set).map(([k, v]) => [k === from ? to : k, v]))
  eachHolder(doc, (h) => {
    for (const [p, r] of Object.entries(h.themeRefs ?? {})) if (r === `$${from}`) h.themeRefs![p] = `$${to}`
  })
}

/** Delete a token; bound literals keep their current values. */
export function deleteToken(doc: BentoDoc, name: string): void {
  const tk = doc.theme.tokens
  if (!tk?.set[name]) return
  delete tk.set[name]
  eachHolder(doc, (h) => {
    for (const [p, r] of Object.entries(h.themeRefs ?? {})) if (r === `$${name}`) dropRef(h, p)
  })
  if (!Object.keys(tk.set).length && !tk.modes?.length) delete doc.theme.tokens
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
