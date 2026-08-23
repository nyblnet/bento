// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors

import type PptxGenJS from 'pptxgenjs'
import type { BentoDoc, TextElement } from '../../model'
import { fieldContext, resolveFields, sanitizeHtml } from '../../render'
import { combineTransparency, pptxColor } from './color'
import { pxToPt, type PptxGeometry } from './geometry'
import type { ReportBuilder } from './report'

type TextRun = PptxGenJS.TextProps

const firstFont = (stack: string) => (stack.split(',')[0] ?? 'Arial').trim().replace(/^['"]|['"]$/g, '')

function richRuns(html: string): TextRun[] {
  const tpl = document.createElement('template')
  tpl.innerHTML = sanitizeHtml(html)
  const runs: TextRun[] = []
  const walk = (node: Node, style: PptxGenJS.TextBaseProps = {}) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.textContent) runs.push({ text: node.textContent, options: { ...style } })
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return
    if (node instanceof HTMLElement && node.tagName === 'BR') {
      if (runs.length) runs[runs.length - 1].options = { ...(runs[runs.length - 1].options ?? {}), breakLine: true }
      else runs.push({ text: '', options: { breakLine: true } })
      return
    }
    const tag = node instanceof HTMLElement ? node.tagName : ''
    const next = { ...style }
    if (tag === 'B' || tag === 'STRONG') next.bold = true
    if (tag === 'I' || tag === 'EM') next.italic = true
    if (tag === 'U') next.underline = { style: 'sng' }
    // PptxGenJS does not currently expose strike-through on text runs.
    if (tag === 'CODE') next.fontFace = 'Courier New'
    for (const child of Array.from(node.childNodes)) walk(child, next)
    if (tag === 'DIV' || tag === 'P') {
      if (runs.length) runs[runs.length - 1].options = { ...(runs[runs.length - 1].options ?? {}), breakLine: true }
    }
  }
  walk(tpl.content)
  if (runs.at(-1)?.options?.breakLine) runs[runs.length - 1].options!.breakLine = false
  return runs.length ? runs : [{ text: '' }]
}

export function addText(
  pptSlide: PptxGenJS.Slide,
  el: TextElement,
  doc: BentoDoc,
  slideIndex: number,
  geometry: PptxGeometry,
  link: PptxGenJS.HyperlinkProps | undefined,
  report: ReportBuilder,
) {
  if (el.placeholder && !el.html.replace(/<[^>]+>/g, '').trim()) return
  const resolved = resolveFields(el.html, fieldContext(doc, doc.slides[slideIndex - 1]))
  const c = combineTransparency(pptxColor(el.color), el.opacity)
  const opts: PptxGenJS.TextPropsOptions = {
    ...geometry.frame(el),
    objectName: `bento:${el.morphId || el.id}`,
    fontFace: firstFont(el.fontFamily || doc.theme.fontFamily),
    fontSize: pxToPt(el.fontSize),
    bold: el.fontWeight >= 600,
    color: c.color,
    transparency: c.transparency,
    align: el.align,
    valign: el.valign,
    margin: 0,
    breakLine: false,
    fit: 'shrink',
    lineSpacingMultiple: el.lineHeight,
    // OOXML character spacing is expressed in points. LibreOffice interprets
    // large values more aggressively than browsers, so cap tracking to keep
    // short all-caps labels inside their authored Bento boxes.
    charSpacing: Math.min(pxToPt(el.letterSpacing ?? 0), 0.1),
  }
  if (el.textStroke?.width) opts.outline = { color: pptxColor(el.textStroke.color).color, size: pxToPt(el.textStroke.width) }
  if (el.colorGradient) report.warn(slideIndex, 'text-gradient-flattened', el.id)
  if (el.shadow || el.blur || el.blend || el.backdropFilter) report.warn(slideIndex, 'text-effects-simplified', el.id)
  const runs = richRuns(resolved)
  // PptxGenJS does not create a relationship for a top-level hyperlink when
  // addText receives rich-text runs, leaving an invalid `rIdundefined` in the
  // slide XML. Apply the link to each run so it emits valid relationships.
  const linkedRuns = link
    ? runs.map(run => ({
      ...run,
      options: {
        ...(run.options ?? {}),
        hyperlink: { ...link },
      },
    }))
    : runs
  pptSlide.addText(linkedRuns, opts)
  report.editable++
}
