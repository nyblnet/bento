// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Export slides as images — the decisions, DOM-free (discussions #243, #261;
 * the design follows lazyeo's #306, kept to the thin in-app half — the heavy
 * version belongs to bento/convert). editor/exportimages.ts does the pixels.
 *
 * Which slides: the same set print gets, in the same order — the linear flow.
 * A state slide is reachable only through interaction and a hidden slide is
 * material the audience was not handed, so neither becomes a page.
 *
 * File names: `<title>-page-NN.<ext>`, the title sanitised by the SAME rule a
 * saved deck's name uses (kernel suggestedFileName → fileBase), so a deck and
 * its pages sort together in a folder. No ZIP: one file per page, and the
 * browser's own download or directory-picker path carries them.
 */

import { inLinearFlow, type BentoDoc, type Slide } from './model.ts'
import { fileBase, suggestedFileName } from '../../kernel/src/save.ts'

export type ImageFormat = 'png' | 'jpeg'
export type ImageScale = 1 | 2
export const IMAGE_FORMATS: ReadonlyArray<ImageFormat> = ['png', 'jpeg']
export const IMAGE_SCALES: ReadonlyArray<ImageScale> = [1, 2]

/** The pages: linear slides in deck order, the set print uses. */
export const exportableSlides = (doc: BentoDoc): Slide[] => doc.slides.filter(inLinearFlow)

/** The sanitised title a saved copy of this deck would carry. */
export const exportBase = (doc: BentoDoc): string => fileBase(suggestedFileName(doc))

/** `<base>-page-NN.<ext>` — two digits, so a folder lists pages in order. */
export const exportFileName = (base: string, page: number, format: ImageFormat): string =>
  `${base}-page-${String(page).padStart(2, '0')}.${format === 'jpeg' ? 'jpg' : 'png'}`

export const mimeOf = (format: ImageFormat): string => (format === 'jpeg' ? 'image/jpeg' : 'image/png')

/** JPEG has no alpha: a transparent slide background would come out black
 *  without a matte. PNG keeps transparency and gets none. */
export const matteFor = (format: ImageFormat): string | null => (format === 'jpeg' ? '#ffffff' : null)

/** Pixel size of a page: the deck's size × the chosen scale (2× for a
 *  high-DPI screen or a print). Integers — a canvas has no fractional pixels. */
export const pixelSize = (doc: BentoDoc, scale: ImageScale): { width: number; height: number } =>
  ({ width: Math.round(doc.size.width * scale), height: Math.round(doc.size.height * scale) })
