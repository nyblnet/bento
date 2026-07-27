// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors

import type PptxGenJS from 'pptxgenjs'
import type { BentoDoc, MediaElement } from '../../model'
import { resolveAsset } from '../../render'
import type { PptxGeometry } from './geometry'
import type { ReportBuilder } from './report'

export function addMedia(slide: PptxGenJS.Slide, el: MediaElement, doc: BentoDoc, geometry: PptxGeometry, report: ReportBuilder, slideIndex: number) {
  const src = resolveAsset(doc, el.src)
  const frame = geometry.frame(el)
  if (!src) return report.warn(slideIndex, 'missing-media', el.id)
  // PptxGenJS can embed file paths and URLs. Data URIs are intentionally kept
  // as poster/link fallbacks because its media API expects a path/extension.
  if (!src.startsWith('data:')) {
    slide.addMedia({ type: el.kind, path: src, ...frame, objectName: `bento:${el.morphId || el.id}` })
    report.editable++
    return
  }
  const poster = el.poster ? resolveAsset(doc, el.poster) : ''
  if (poster) slide.addImage({ ...(poster.startsWith('data:') ? { data: poster } : { path: poster }), ...frame, objectName: `bento:${el.morphId || el.id}` })
  else slide.addText(el.kind === 'video' ? '▶' : '♪', { ...frame, fontSize: 28, align: 'center', valign: 'middle', fill: { color: 'E7EDF4' }, margin: 0 })
  report.warn(slideIndex, 'embedded-media-poster-only', el.id)
}
