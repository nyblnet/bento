// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// `code` elements → PowerPoint. NOT YET WRITTEN: today a code element is
// reported as dropped and nothing is emitted. This file is the place to write
// it; convert/CONTRIBUTING.md has the walkthrough.
//
// What a good first version looks like: a p:sp text box at the element's
// frame, the content one paragraph per line, in a monospace face (the
// element's fontFamily, else "Consolas"), at its fontSize, alignment and
// colour. Syntax colouring is optional — a first version that drops it says
// so with an 'approximated' entry ('code-colours-flattened'). textSp in
// text.ts shows how a text box is built; shapes.ts emu() converts px.
//
// When it emits something, move 'code' from NOT_YET to MAPPED in
// scripts/test-convert/pptx-coverage.ts, and add its own checks there.

import type { ElementWriter, ElFrame } from './contract.ts'

/** The fields of slides' CodeElement a writer reads (restated from
 *  slides/src/model.ts; the writer never imports an app). */
export interface CodeElIn extends ElFrame {
  type: 'code'
  fontSize: number
  fontFamily: string
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
  lineHeight: number
  color: string
  /** the code itself, lines separated by \n */
  content: string
  /** the highlighting grammar and theme, by name (colours are optional) */
  grammarName?: string
  themeName?: string
}

export const writeCode: ElementWriter<CodeElIn> = (_el, ctx) => {
  ctx.report.add('dropped', 'element-unsupported', ctx.where, "element type 'code' has no pptx mapping")
  return null
}
