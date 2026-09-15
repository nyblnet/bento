// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * maths-lite — the entry point render.ts calls instead of Temml. Never
 * throws: a formula the parser refuses comes back as null so the caller
 * leaves the author's text exactly as typed (Temml's throwOnError contract).
 *
 * SYNTAX SELECTION (decided by the maintainer, 2026-09-15): a formula is
 * LaTeX unless its source begins with the marker `typst:` — `$typst: a/b$`
 * inline, `$$typst: a/b$$` display. The marker sits immediately after the
 * opening delimiter, is case-sensitive, and may be followed by whitespace.
 * The document stores the source with the marker; nothing in the format
 * changes, and an older shell shows `$typst: a/b$` as typed (degraded,
 * legible — the promise `$…$` already makes). `isTypst(src)` is the one
 * test; render.ts applies it.
 */

import { parseLatex } from './latex.ts'
import { parseTypst } from './typst.ts'
import { toMathML } from './mathml.ts'
import type { MNode } from './ast.ts'

export type Syntax = 'latex' | 'typst'

/** The marker, exactly: `typst:` at the very start, then optional whitespace. */
export const TYPST_MARKER = /^typst:\s*/
export const isTypst = (src: string): boolean => TYPST_MARKER.test(src)
/** Source with the marker removed (unchanged when there is none). */
export const stripMarker = (src: string): string => src.replace(TYPST_MARKER, '')

export function parseMath(src: string, opts: { display?: boolean; syntax?: Syntax } = {}): MNode {
  return (opts.syntax === 'typst' ? parseTypst : parseLatex)(src, !!opts.display)
}

/** MathML for `src`, or null when it is not valid maths in that syntax. */
export function renderMath(src: string, opts: { display?: boolean; syntax?: Syntax } = {}): string | null {
  try {
    return toMathML(parseMath(src, opts), !!opts.display)
  } catch {
    return null
  }
}
