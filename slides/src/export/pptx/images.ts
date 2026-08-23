// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors

import type PptxGenJS from 'pptxgenjs'
import type { BentoDoc, ImageElement } from '../../model'
import { resolveAsset } from '../../render'
import type { PptxGeometry } from './geometry'
import type { ReportBuilder } from './report'

export function addImage(
  slide: PptxGenJS.Slide,
  el: ImageElement,
  doc: BentoDoc,
  geometry: PptxGeometry,
  link: PptxGenJS.HyperlinkProps | undefined,
  report: ReportBuilder,
  slideIndex: number,
) {
  const src = resolveAsset(doc, el.src)
  if (!src) return report.warn(slideIndex, 'missing-image', el.id)
  const frame = geometry.frame(el)
  const source = src.startsWith('data:') ? { data: src } : { path: src }
  slide.addImage({
    ...source, ...frame,
    sizing: el.fit === 'fill' ? undefined : { type: el.fit, w: frame.w, h: frame.h },
    transparency: Math.round((1 - el.opacity) * 100),
    objectName: `bento:${el.morphId || el.id}`,
    ...(link ? { hyperlink: link } : {}),
  })
  if (el.radius) report.warn(slideIndex, 'image-radius-not-preserved', el.id)
  if (el.shadow || el.blur || el.blend || el.backdropFilter) report.warn(slideIndex, 'image-effects-simplified', el.id)
  report.editable++
}
