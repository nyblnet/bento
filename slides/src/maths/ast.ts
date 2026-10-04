// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * maths-lite — the shared tree. Both front ends (latex.ts, typst.ts) produce
 * this; mathml.ts prints it. A node is what a browser's MathML layout needs
 * to know and nothing more: there is no font metric, no glyph box, no layout
 * here — MathML Core does that part, which is the whole reason a maths engine
 * can be small.
 *
 * Parse → tree → print, no regex chains. What was measured to arrive here
 * is in docs/DECISIONS.md (2026-09-15, maths).
 */

export type MNode =
  | { k: 'row'; c: MNode[] }
  /** an identifier (mi), number (mn) or operator (mo) */
  | { k: 'sym'; cls: 'i' | 'n' | 'o'; t: string; /** upright multi-letter (sin, lim) */ fn?: boolean; /** stretchy fence/accent op */ stretchy?: boolean; /** \mathrm-style upright single letter */ up?: boolean; /** big operator (sum) */ big?: boolean; /** \big family: minsize in em */ size?: number; /** explicit lspace/rspace (\mid) */ pad?: string; /** a different rspace (\colon) */ rpad?: string; /** render-time: operator after an operator */ prefix?: boolean; /** \operatorname*: limits under/over in display mode */ limfn?: boolean }
  | { k: 'text'; t: string }
  | { k: 'space'; em: number }
  | { k: 'frac'; n: MNode; d: MNode; /** no bar (binom, atop) */ nobar?: boolean; /** \dfrac/\tfrac */ display?: boolean; /** \genfrac's script / scriptscript style: 1 or 2 */ level?: number }
  | { k: 'sqrt'; b: MNode; i?: MNode }
  /** scripts; `limits` = under/over placement (sum in display mode, \limits) */
  | { k: 'scr'; b: MNode; sub?: MNode; sup?: MNode; limits?: boolean }
  /** \left … \right and \big fences — l/r may be '' for \left. */
  | { k: 'fence'; l: string; r: string; c: MNode; /** minsize multiplier for \big family */ size?: number; /** \left…\right: say stretchy out loud (plain parens stretch by the operator dictionary anyway) */ explicit?: boolean }
  | { k: 'table'; rows: MNode[][]; l?: string; r?: string; /** the environment's spacing family, e.g. 'rl' for align */ align?: string; /** row lines */ lines?: boolean; /** per-column alignment, one of l/c/r per column (the last repeats); absent = centred */ cols?: string; /** dcases, darray: cells in display style */ display?: boolean
    /** rules between columns (array's `|`, `:`, `||`): one per boundary, 0…ncols; '' = none */
    vlines?: string[]
    /** rules between rows (\hline, \hdashline, \hline\hline): one per boundary, 0…rows */
    hlines?: string[] }
  | { k: 'accent'; b: MNode; a: string; under?: boolean; stretchy?: boolean; /** \varinjlim and family: scripts go under/over in display mode */ lim?: boolean }
  /** \smash, \hphantom/\vphantom, \llap/\rlap/\clap: a box whose ink or
   *  extent is taken away in one dimension (mpadded, as Temml spells it) */
  | { k: 'pad'; c: MNode; phantom?: boolean; w0?: boolean; h0?: boolean; d0?: boolean; lap?: 'l' | 'r' | 'c' }
  /** \sideset / \prescript: scripts on both sides (mmultiscripts) */
  | { k: 'multi'; b: MNode; presub?: MNode; presup?: MNode; sub?: MNode; sup?: MNode }
  /** a command maths-lite does not know, shown as its own name in place so
   *  the rest of the formula still renders (render.ts asks for this) */
  | { k: 'unknown'; t: string }
  /** \xrightarrow[under]{over} and family: a stretchy arrow with labels
   *  (printed the way Temml spells it — the labels padded, a 3.5em minimum) */
  | { k: 'xarrow'; a: string; over?: MNode; under?: MNode }
  /** font/colour/box wrapper */
  | { k: 'style'; c: MNode; font?: Font; color?: string; box?: boolean; /** \cancel (up), \bcancel (down), \xcancel (both), \sout (across) */ cancel?: true | 'down' | 'x' | 'h'; /** \large and family: em */ size?: number; /** \pmb, physics' bold nabla */ bold?: boolean; /** \colorbox */ bg?: string; /** \fcolorbox frame colour */ frame?: string; /** \angl: rules above and to the right; \longdiv: a rule above */ rule?: 'angl' | 'top'; /** \reflectbox */ mirror?: boolean }
  /** mhchem's dashed bonds (\uniDash, \triDash, \tripleDash…): drawn rules */
  | { k: 'bond'; kind: string }

export type Font = 'bb' | 'cal' | 'frak' | 'bf' | 'it' | 'sf' | 'tt' | 'rm' | 'scr' | 'sfit' | 'bfit'

export const row = (c: MNode[]): MNode => (c.length === 1 ? c[0] : { k: 'row', c })
export const mi = (t: string, extra?: Partial<Extract<MNode, { k: 'sym' }>>): MNode => ({ k: 'sym', cls: 'i', t, ...extra })
export const mn = (t: string): MNode => ({ k: 'sym', cls: 'n', t })
export const mo = (t: string, extra?: Partial<Extract<MNode, { k: 'sym' }>>): MNode => ({ k: 'sym', cls: 'o', t, ...extra })

export class MathError extends Error {}

/** A table symbol as a node — the spellings Temml uses, so a deck keeps its look:
 *  Greek capitals upright, \mid a bar with relation spacing, \iff/\implies
 *  padded by a thick space each side. Both front ends go through here. */
export function symNode(s: { tex: string; cp: string; cls: 'i' | 'o' | 'big' }): MNode {
  if (s.cls === 'i') return /^[Α-Ω]$/.test(s.cp) ? mi(s.cp, { up: true }) : mi(s.cp)
  if (s.cls === 'big') return mo(s.cp, { big: true })
  if (s.tex === 'mid') return mo('|', { pad: '0.22em' })
  if (s.tex === 'iff' || s.tex === 'implies' || s.tex === 'impliedby') return { k: 'row', c: [{ k: 'space', em: 0.2778 }, mo(s.cp), { k: 'space', em: 0.2778 }] }
  return mo(s.cp)
}
