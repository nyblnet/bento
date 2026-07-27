// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors

import PptxGenJS from 'pptxgenjs'
import type { BentoDoc, Slide, SlideElement } from '../../model'
import { pptxColor } from './color'
import { pptxGeometry } from './geometry'
import { ReportBuilder, type PptxExportReport } from './report'
import { addText } from './text'
import { addShape } from './shapes'
import { addImage } from './images'
import { addTable } from './tables'
import { addChart } from './charts'
import { addSvgFallback } from './svg'
import { addMedia } from './media'

export interface PptxExportOptions {
  includeStates?: boolean
  download?: boolean
  fileName?: string
}

export interface PptxExportResult {
  blob: Blob
  fileName: string
  report: PptxExportReport
}

const safeName = (title: string) => (title || 'presentation').replace(/[\\/:*?"<>|]/g, '-').trim() || 'presentation'

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function hyperlink(el: SlideElement, slideNumbers: Map<string, number>): PptxGenJS.HyperlinkProps | undefined {
  if (!el.link) return undefined
  if (/^(https?:|mailto:|tel:)/i.test(el.link)) return { url: el.link }
  const target = slideNumbers.get(el.link)
  return target ? { slide: target } : undefined
}

function hasUnsupportedFx(el: SlideElement) {
  return !!(el.fx?.enter || el.fx?.countUp || el.fx?.ambient || el.fx?.loop || el.showOnHover)
}

async function addSlideElements(
  pptx: PptxGenJS,
  pptSlide: PptxGenJS.Slide,
  source: Slide,
  doc: BentoDoc,
  sourceIndex: number,
  slideNumbers: Map<string, number>,
  report: ReportBuilder,
) {
  const g = pptxGeometry(doc)
  const page = sourceIndex + 1
  for (const el of source.elements) {
    const link = hyperlink(el, slideNumbers)
    if (el.link && !link) report.warn(page, 'missing-link-target', el.id)
    if (hasUnsupportedFx(el)) report.warn(page, 'presentation-effects-static', el.id)
    switch (el.type) {
      case 'text': addText(pptSlide, el, doc, page, g, link, report); break
      case 'shape': addShape(pptx, pptSlide, el, doc, g, link, report, page); break
      case 'image': addImage(pptSlide, el, doc, g, link, report, page); break
      case 'table': addTable(pptSlide, el, g, report, page); break
      case 'chart': addChart(pptx, pptSlide, el, doc, g, report, page); break
      case 'svg': addSvgFallback(pptSlide, el, doc, g, link, report, page); break
      case 'media': addMedia(pptSlide, el, doc, g, report, page); break
    }
  }
}

/** Model-driven BentoDoc → editable OOXML. This never scrapes the editor DOM,
 * so export is deterministic and works for slides that have never been shown. */
export async function buildPptx(doc: BentoDoc, options: PptxExportOptions = {}): Promise<PptxExportResult> {
  const pptx = new PptxGenJS()
  const g = pptxGeometry(doc)
  pptx.defineLayout({ name: 'BENTO', width: g.width, height: g.height })
  pptx.layout = 'BENTO'
  pptx.author = doc.meta?.author || 'bento/slides'
  pptx.company = doc.meta?.company || ''
  pptx.subject = doc.meta?.subject || ''
  pptx.title = doc.title
  pptx.theme = {
    headFontFace: (doc.theme.fontFamily.split(',')[0] ?? 'Arial').replace(/['"]/g, '').trim(),
    bodyFontFace: (doc.theme.fontFamily.split(',')[0] ?? 'Arial').replace(/['"]/g, '').trim(),
  }
  const selected = doc.slides.filter((s) => options.includeStates || !s.stateOf)
  const slideNumbers = new Map(selected.map((s, i) => [s.id, i + 1]))
  // Links to hidden interactive states degrade to their visible parent when
  // states are omitted, preserving a meaningful navigation target.
  if (!options.includeStates) {
    for (const state of doc.slides.filter((s) => s.stateOf)) {
      const parent = state.stateOf ? slideNumbers.get(state.stateOf) : undefined
      if (parent) slideNumbers.set(state.id, parent)
    }
  }
  const report = new ReportBuilder()
  for (const source of selected) {
    const pptSlide = pptx.addSlide()
    const sourceIndex = doc.slides.indexOf(source)
    const bg = pptxColor(source.background, pptxColor(doc.theme.background).color)
    pptSlide.background = { color: bg.color, transparency: bg.transparency }
    if (!/^\s*(?:#(?:[0-9a-f]{3,8})|rgba?\(|transparent\s*$)/i.test(source.background)) {
      report.warn(sourceIndex + 1, 'slide-background-simplified')
    }
    if (source.stateOf) pptSlide.hidden = true
    if (source.notes) pptSlide.addNotes(source.notes)
    await addSlideElements(pptx, pptSlide, source, doc, sourceIndex, slideNumbers, report)
    if (source.transition === 'morph') report.warn(sourceIndex + 1, 'morph-not-exported')
    if (source.hover) report.warn(sourceIndex + 1, 'hover-static')
  }
  const output = await pptx.write({ outputType: 'blob', compression: true })
  const blob = output instanceof Blob ? output : new Blob([output as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
  const fileName = options.fileName ?? `${safeName(doc.title)}.pptx`
  if (options.download !== false) download(blob, fileName)
  return { blob, fileName, report: report.finish(selected.length) }
}

export type { PptxExportReport, PptxWarning } from './report'
