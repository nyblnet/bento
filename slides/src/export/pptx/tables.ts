// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors

import type PptxGenJS from 'pptxgenjs'
import type { TableElement } from '../../model'
import { sanitizeHtml } from '../../render'
import { combineTransparency, pptxColor } from './color'
import { pxToPt, type PptxGeometry } from './geometry'
import type { ReportBuilder } from './report'

const plainText = (html: string) => {
  const box = document.createElement('div')
  box.innerHTML = sanitizeHtml(html)
  return box.innerText
}

export function addTable(slide: PptxGenJS.Slide, el: TableElement, geometry: PptxGeometry, report: ReportBuilder, slideIndex: number) {
  const st = el.style
  const total = el.columns.reduce((sum, c) => sum + Math.max(c.w, 0), 0) || 1
  const frame = geometry.frame(el)
  const body = combineTransparency(pptxColor(st.color), el.opacity)
  const rows: PptxGenJS.TableRow[] = el.rows.map((row, ri) => row.cells.map((cell) => {
    const isHeader = el.header && ri === 0
    const bg = cell.bg ?? (isHeader ? st.headerBg : st.zebra && ri % 2 === 0 ? st.zebra : 'transparent')
    const fg = cell.color ?? (isHeader ? st.headerColor : st.color)
    const fill = combineTransparency(pptxColor(bg, 'FFFFFF'), el.opacity)
    const color = combineTransparency(pptxColor(fg), el.opacity)
    return {
      text: plainText(cell.html),
      options: {
        align: cell.align ?? 'left', bold: cell.bold ?? isHeader,
        color: color.color, transparency: color.transparency,
        fill: fill.transparency >= 100 ? { type: 'none' } : fill,
        margin: [geometry.y(st.cellPadY), geometry.x(st.cellPadX), geometry.y(st.cellPadY), geometry.x(st.cellPadX)],
      },
    }
  }))
  const { rotate: _rotate, ...tableFrame } = frame
  slide.addTable(rows, {
    ...tableFrame,
    objectName: `bento:${el.morphId || el.id}`,
    colW: el.columns.map((c) => frame.w * Math.max(c.w, 0) / total),
    rowH: el.rows.map(() => frame.h / Math.max(el.rows.length, 1)),
    border: { type: st.borderWidth > 0 ? 'solid' : 'none', color: pptxColor(st.borderColor).color, pt: pxToPt(st.borderWidth) },
    fontFace: (st.fontFamily ?? '').split(',')[0].replace(/['"]/g, '') || undefined,
    fontSize: pxToPt(st.fontSize),
    color: body.color,
    margin: 0,
    autoPage: false,
  })
  if (el.rotation) report.warn(slideIndex, 'table-rotation-not-preserved', el.id)
  if (st.radius) report.warn(slideIndex, 'table-radius-not-preserved', el.id)
  report.editable++
}
