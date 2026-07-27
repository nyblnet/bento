// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors

import type { BentoDoc, ElementBase } from '../../model'

/** PowerPoint's wide layout is 13.333×7.5in. Keeping that width makes Bento's
 * usual 1280px canvas map at exactly 96px/in while custom deck aspects remain
 * exact through a custom PptxGenJS layout. */
export const PPT_WIDTH_IN = 13.333333

export interface PptxGeometry {
  width: number
  height: number
  x: (px: number) => number
  y: (px: number) => number
  frame: (el: Pick<ElementBase, 'x' | 'y' | 'w' | 'h' | 'rotation'>) => {
    x: number; y: number; w: number; h: number; rotate: number
  }
}

export function pptxGeometry(doc: Pick<BentoDoc, 'size'>): PptxGeometry {
  const width = PPT_WIDTH_IN
  const height = width * doc.size.height / doc.size.width
  const sx = width / doc.size.width
  const sy = height / doc.size.height
  return {
    width,
    height,
    x: (px) => px * sx,
    y: (px) => px * sy,
    frame: (el) => ({
      x: el.x * sx,
      y: el.y * sy,
      w: el.w * sx,
      h: el.h * sy,
      rotate: el.rotation || 0,
    }),
  }
}

/** CSS px at 96dpi → typographic points. */
export const pxToPt = (px: number) => px * 0.75
