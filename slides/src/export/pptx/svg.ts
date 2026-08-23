// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors

import type PptxGenJS from 'pptxgenjs'
import type { BentoDoc, ShapeElement, SvgElement } from '../../model'
import { shapeSvg } from '../../render'
import { type PptxGeometry } from './geometry'
import type { ReportBuilder } from './report'

export const svgDataUri = (markup: string) =>
  `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(markup)))}`

function serializeSvg(svg: SVGSVGElement): string {
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return new XMLSerializer().serializeToString(svg)
}

export function addSvgFallback(
  slide: PptxGenJS.Slide,
  el: ShapeElement | SvgElement,
  doc: BentoDoc,
  geometry: PptxGeometry,
  link: PptxGenJS.HyperlinkProps | undefined,
  report: ReportBuilder,
  slideIndex: number,
) {
  let markup = ''
  if (el.type === 'shape') {
    markup = serializeSvg(shapeSvg(el))
  } else {
    markup = (el.asset ? doc.assets?.[el.asset] : el.markup) ?? ''
    if (el.css) markup = markup.replace(/<svg([^>]*)>/i, `<svg$1><style>${el.css}</style>`)
  }
  if (!markup.trim()) {
    report.warn(slideIndex, 'missing-svg', el.id)
    return
  }
  slide.addImage({
    data: svgDataUri(markup),
    ...geometry.frame(el),
    transparency: Math.round((1 - el.opacity) * 100),
    objectName: `bento:${el.morphId || el.id}`,
    ...(link ? { hyperlink: link } : {}),
  })
  report.vectorFallbacks++
  if (el.type === 'svg' && el.css) report.warn(slideIndex, 'svg-css-static', el.id)
}
