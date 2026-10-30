// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Arithmetic typed into a numeric field: `360/2`, `(1920-96)/3`, and the
// relative forms `+24`, `*2`, `/2` that start from the field's current value.
// A hand-written parser, never eval: what a field accepts is exactly this.

/** The value an entry means, given the field's `prev` value, or null when it
 *  is not arithmetic. `rel` is the change from `prev` when the entry was
 *  relative (it began with + * or /); a leading − is a negative number, as in
 *  every design tool. A unit the field shows (px, °, deg, %) may be typed. */
export function evalNumber(text: string, prev: number): { v: number; rel?: number } | null {
  if (/[\d.]\s+[\d.]/.test(text)) return null // "3 4" is two numbers, not 34
  let s = text.trim().replace(/\s+/g, '').replace(/,/g, '.').replace(/(px|°|deg|%)$/i, '')
  if (!s) return null
  let rel: '+' | '*' | '/' | null = null
  if (/^[+*/]/.test(s)) { rel = s[0] as '+' | '*' | '/'; s = s.slice(1) }
  let i = 0
  const num = (): number => {
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i))
    if (!m) throw 0
    i += m[0].length
    return parseFloat(m[0])
  }
  const factor = (): number => {
    if (s[i] === '-') { i++; return -factor() }
    if (s[i] === '+') { i++; return factor() }
    if (s[i] === '(') { i++; const v = expr(); if (s[i++] !== ')') throw 0; return v }
    return num()
  }
  const term = (): number => {
    let v = factor()
    while (s[i] === '*' || s[i] === '/') {
      const op = s[i++]
      const r = factor()
      v = op === '*' ? v * r : v / r
    }
    return v
  }
  const expr = (): number => {
    let v = term()
    while (s[i] === '+' || s[i] === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r }
    return v
  }
  let x: number
  try { x = expr() } catch { return null }
  if (i !== s.length || !Number.isFinite(x)) return null
  if (!rel) return { v: x }
  const v = rel === '+' ? prev + x : rel === '*' ? prev * x : prev / x
  return Number.isFinite(v) ? { v, rel: v - prev } : null
}
