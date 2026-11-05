// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Arithmetic typed into a numeric field: `360/2`, `(1920-96)/3`, and the
// relative forms `+24`, `*2`, `/2` that start from the field's current value.
// A hand-written parser, never eval: what a field accepts is exactly this.

/** A relative entry: what to do to each value it applies to. */
export interface RelOp { op: '+' | '*' | '/'; x: number }

/** A relative entry applied to one value (a multi-selection applies it to each). */
export const applyRel = (r: RelOp, v: number) => r.op === '+' ? v + r.x : r.op === '*' ? v * r.x : v / r.x

/** The value an entry means, given the field's `prev` value, or null when it
 *  is not arithmetic. `rel` is the change from `prev` and `op` the operation
 *  when the entry was relative (it began with + * or /); a leading − is a
 *  negative number, as in every design tool. A unit the field shows (px, °,
 *  deg, %) may be typed. A comma is a decimal point ("1,5") only when it
 *  cannot be a thousands separator: "1,000" and "1.000,5" are refused, not
 *  guessed, because either reading may be the one meant — unless `dec`, the
 *  interface language's decimal mark, says which reading is meant. */
export function evalNumber(text: string, prev: number, dec?: '.' | ','): { v: number; rel?: number; op?: RelOp } | null {
  if (/[\d.]\s+[\d.]/.test(text)) return null // "3 4" is two numbers, not 34
  // Knowing the interface language's decimal mark settles what a guess
  // cannot: in English "1,000" is a thousand, in German "1.000" is. The
  // grouping mark is dropped only before exactly three digits; any other use
  // of it is still a decimal point ("2.5" in German, "1,5" in English).
  if (dec === '.') text = text.replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
  if (dec === ',') text = text.replace(/(\d)\.(?=\d{3}(?!\d))/g, '$1')
  if (dec !== ',' && (/\d,\d{3}(?!\d)/.test(text) || (/,/.test(text) && /\d\.\d/.test(text)))) return null
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
  const op: RelOp = { op: rel, x }
  const v = applyRel(op, prev)
  return Number.isFinite(v) ? { v, rel: v - prev, op } : null
}
