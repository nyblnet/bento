// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * maths-lite — the shared tree. Both front ends (latex.ts, typst.ts) produce
 * this; mathml.ts prints it. A node is what a browser's MathML layout needs
 * to know and nothing more: there is no font metric, no glyph box, no layout
 * here — MathML Core does that part, which is the whole reason a maths engine
 * can be small.
 *
 * SPIKE code: parse → tree → print, no regex chains. See
 * working/team/handoffs/spike-maths-lite.md for what was measured.
 */

export type MNode =
  | { k: 'row'; c: MNode[] }
  /** an identifier (mi), number (mn) or operator (mo) */
  | { k: 'sym'; cls: 'i' | 'n' | 'o'; t: string; /** upright multi-letter (sin, lim) */ fn?: boolean; /** stretchy fence/accent op */ stretchy?: boolean; /** \mathrm-style upright single letter */ up?: boolean; /** big operator (sum) */ big?: boolean; /** \big family: minsize in em */ size?: number }
  | { k: 'text'; t: string }
  | { k: 'space'; em: number }
  | { k: 'frac'; n: MNode; d: MNode; /** no bar (binom, atop) */ nobar?: boolean; /** \dfrac/\tfrac */ display?: boolean }
  | { k: 'sqrt'; b: MNode; i?: MNode }
  /** scripts; `limits` = under/over placement (sum in display mode, \limits) */
  | { k: 'scr'; b: MNode; sub?: MNode; sup?: MNode; limits?: boolean }
  /** \left … \right and \big fences — l/r may be '' for \left. */
  | { k: 'fence'; l: string; r: string; c: MNode; /** minsize multiplier for \big family */ size?: number; /** \left…\right: say stretchy out loud (plain parens stretch by the operator dictionary anyway) */ explicit?: boolean }
  | { k: 'table'; rows: MNode[][]; l?: string; r?: string; /** column aligns, e.g. 'rl' for align */ align?: string; /** row lines */ lines?: boolean }
  | { k: 'accent'; b: MNode; a: string; under?: boolean; stretchy?: boolean }
  /** font/colour/box wrapper */
  | { k: 'style'; c: MNode; font?: Font; color?: string; box?: boolean; /** \cancel */ cancel?: boolean }

export type Font = 'bb' | 'cal' | 'frak' | 'bf' | 'it' | 'sf' | 'tt' | 'rm' | 'scr'

export const row = (c: MNode[]): MNode => (c.length === 1 ? c[0] : { k: 'row', c })
export const mi = (t: string, extra?: Partial<Extract<MNode, { k: 'sym' }>>): MNode => ({ k: 'sym', cls: 'i', t, ...extra })
export const mn = (t: string): MNode => ({ k: 'sym', cls: 'n', t })
export const mo = (t: string, extra?: Partial<Extract<MNode, { k: 'sym' }>>): MNode => ({ k: 'sym', cls: 'o', t, ...extra })

export class MathError extends Error {}
