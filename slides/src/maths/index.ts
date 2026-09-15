// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * maths-lite — the entry point render.ts calls instead of Temml. Never
 * throws: a formula the parser refuses comes back as null so the caller
 * leaves the author's text exactly as typed (Temml's throwOnError contract).
 */

import { parseLatex } from './latex.ts'
import { parseTypst } from './typst.ts'
import { toMathML } from './mathml.ts'
import type { MNode } from './ast.ts'

export type Syntax = 'latex' | 'typst'

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
