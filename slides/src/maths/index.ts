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

export function parseMath(src: string, opts: { display?: boolean; syntax?: Syntax; lenient?: boolean } = {}): MNode {
  return opts.syntax === 'typst' ? parseTypst(src, !!opts.display) : parseLatex(src, !!opts.display, !!opts.lenient)
}

/**
 * MathML for `src`, or null when it is not valid maths in that syntax.
 *
 * `lenient` (what slides render with, #551): a command maths-lite does not
 * know is drawn as its own name in a warning colour and the rest of the
 * formula renders — one unfamiliar word no longer throws the whole formula
 * back as raw LaTeX in front of an audience. Malformed input (an unclosed
 * brace, a stray \end) is still null. Strict is the default so the rigs
 * measure what the engine actually knows.
 */
export function renderMath(src: string, opts: { display?: boolean; syntax?: Syntax; lenient?: boolean } = {}): string | null {
  try {
    return toMathML(parseMath(src, opts), !!opts.display)
  } catch {
    return null
  }
}

/**
 * Why `src` does not render, or null when it does: the unknown command
 * (`\foo`) when that is the reason — the usual one — else the parser's own
 * message. For the editor's "Not rendered" hint; never shown in a document.
 */
export function mathError(src: string, opts: { display?: boolean; syntax?: Syntax } = {}): string | null {
  try {
    toMathML(parseMath(src, opts), !!opts.display)
    return null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const unknown = /^unknown command (\\\S+)/.exec(msg)
    return unknown ? unknown[1] : msg
  }
}
