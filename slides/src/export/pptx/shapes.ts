// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors

import type PptxGenJS from 'pptxgenjs'
import type { BentoDoc, ShapeElement } from '../../model'
import { combineTransparency, pptxColor } from './color'
import { pxToPt, type PptxGeometry } from './geometry'
import type { ReportBuilder } from './report'
import { addSvgFallback } from './svg'

const arrow = (tip?: string): PptxGenJS.ShapeLineProps['beginArrowType'] => {
  if (tip === 'arrow') return 'triangle'
  if (tip === 'dot') return 'oval'
  if (tip === 'bar') return 'diamond'
  return 'none'
}

function shadow(el: ShapeElement): PptxGenJS.ShadowProps | undefined {
  const s = Array.isArray(el.shadow) ? el.shadow[0] : el.shadow
  if (!s) return undefined
  const c = pptxColor(s.color)
  const x = s.x ?? 0
  const y = s.y ?? 0
  return {
    type: 'outer', color: c.color, opacity: 1 - c.transparency / 100,
    blur: Math.min(pxToPt(s.blur), 100), offset: Math.min(pxToPt(Math.hypot(x, y)), 200),
    angle: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360,
  }
}

export function addShape(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  el: ShapeElement,
  doc: BentoDoc,
  geometry: PptxGeometry,
  link: PptxGenJS.HyperlinkProps | undefined,
  report: ReportBuilder,
  slideIndex: number,
) {
  if (el.shape === 'path' || el.fillGradient || el.blur || el.blend || el.backdropFilter) {
    addSvgFallback(slide, el, doc, geometry, link, report, slideIndex)
    report.warn(slideIndex, el.shape === 'path' ? 'path-vector-object' : 'shape-effects-vector-object', el.id)
    return
  }
  const opacity = el.opacity
  const fill = combineTransparency(pptxColor(el.fill), opacity)
  const stroke = combineTransparency(pptxColor(el.shape === 'line' ? el.fill : el.stroke), opacity)
  const common: PptxGenJS.ShapeProps = {
    ...geometry.frame(el),
    fill: fill.transparency >= 100 ? { type: 'none' } : fill,
    line: el.strokeWidth <= 0 && el.shape !== 'line' ? { type: 'none' } : {
      color: stroke.color, transparency: stroke.transparency, width: pxToPt(el.strokeWidth),
      dashType: el.strokeStyle === 'dotted' ? 'sysDot' : el.strokeStyle === 'dashed' || el.strokeDash ? 'dash' : 'solid',
      beginArrowType: arrow(el.lineStart), endArrowType: arrow(el.lineEnd),
    },
    shadow: shadow(el),
    objectName: `bento:${el.morphId || el.id}`,
    ...(link ? { hyperlink: link } : {}),
  }
  const shape = el.shape === 'ellipse' ? pptx.ShapeType.ellipse
    : el.shape === 'triangle' ? pptx.ShapeType.triangle
      : el.shape === 'arrow' ? pptx.ShapeType.rightArrow
        : el.shape === 'line' ? pptx.ShapeType.line
          : el.radius > 0 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect
  if (shape === pptx.ShapeType.roundRect) common.rectRadius = Math.min(el.radius / Math.max(Math.min(el.w, el.h), 1), 0.5)
  slide.addShape(shape, common)
  if (Array.isArray(el.shadow) && el.shadow.length > 1) report.warn(slideIndex, 'multiple-shadows-simplified', el.id)
  report.editable++
}
