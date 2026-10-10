// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// `code` elements → an editable PowerPoint text box.
//
// One paragraph per line, in a monospace face that PowerPoint machines have
// (fonts.ts: slides' monospace stack becomes Consolas), at the element's
// size, colour, alignment and line height. What slides paints, kept:
//   - indentation: slides sets white-space: pre, so every space counts. The
//     text writer collapses ordinary whitespace (as the canvas does for
//     ordinary text), so spaces that would collapse become no-break spaces;
//     tabs expand to 8-column stops, the browser's default, which slides
//     does not change. Lines are line breaks within one paragraph.
//   - no wrapping: a long line runs on rather than folding (wrap="none").
//   - no fill: slides paints no background behind code.
//   - {{tokens}} stay literal: code is never a field.
// What is lost, and reported: syntax colouring. The tokens' colours come from
// the highlighting theme at render time; here the code is one colour, the
// element's own ('code-colours-flattened').

import type { ElementWriter, ElFrame } from './contract.ts'
import { textSp, type TextElIn } from './text.ts'
import type { XNode, XChild } from '../xmlout.ts'

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
  /** the highlighting grammar and theme, by name or asset */
  grammarName?: string
  grammarAssetId?: string
  themeName?: string
  themeAssetId?: string
}

const NBSP = ' '
const TAB = 8

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** One source line as the text writer's html, every column kept. A space
 *  becomes a no-break space only where ordinary whitespace would collapse
 *  (at the start of a line, or after another space), so code copied back out
 *  of PowerPoint keeps ordinary spaces between words. */
function lineHtml(line: string): string {
  let out = ''
  let col = 0
  let prevSpace = true // a line start collapses like a preceding space
  for (const ch of line.replace(/\r$/, '')) {
    if (ch === '\t') {
      const n = TAB - (col % TAB)
      out += NBSP.repeat(n)
      col += n
      prevSpace = true
    } else if (ch === ' ') {
      out += prevSpace ? NBSP : ' '
      col++
      prevSpace = true
    } else {
      out += esc(ch)
      col++
      prevSpace = false
    }
  }
  return out
}

/** Set an attribute on the first descendant with this name (the trees are
 *  plain data, so the integrator-style post-edit is safe). */
function setOn(node: XNode, name: string, attrs: Record<string, string>): boolean {
  if (node.name === name) { node.attrs = { ...(node.attrs ?? {}), ...attrs }; return true }
  for (const k of (node.kids ?? []) as XChild[]) if (typeof k === 'object' && k && setOn(k as XNode, name, attrs)) return true
  return false
}

export const writeCode: ElementWriter<CodeElIn> = (el, ctx) => {
  const lines = (el.content ?? '').split('\n')
  const text: TextElIn = {
    id: el.id, morphId: el.morphId,
    x: el.x, y: el.y, w: el.w, h: el.h, rotation: el.rotation, opacity: el.opacity,
    html: lines.map(lineHtml).join('<br>'),
    fontSize: el.fontSize, fontFamily: el.fontFamily, fontWeight: 400,
    color: el.color, align: el.align, valign: el.valign, lineHeight: el.lineHeight,
  }
  // no `fields`: {{tokens}} in code stay literal; no `link`: the integrator wires it
  const node = textSp(text, { shapeId: ctx.shapeId, themeFontFamily: ctx.theme.fontFamily, report: ctx.report, where: ctx.where })
  if (!node) return null
  setOn(node, 'a:bodyPr', { wrap: 'none' })
  if (el.content?.trim() && (el.grammarName || el.grammarAssetId || el.themeName || el.themeAssetId)) {
    ctx.report.add('approximated', 'code-colours-flattened', ctx.where,
      'code exports as editable text in one colour; its syntax highlighting is not carried')
  }
  return node
}
