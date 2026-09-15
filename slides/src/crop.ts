// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Image crop → CSS (discussion #319). One mapping, used by the single
 * renderer for canvas, thumbnails, present, print and the file-manager
 * preview, so a crop looks the same everywhere.
 *
 * The model (model.ts ImageCrop): the picture covers the frame, `scale` ≥ 1
 * enlarges it, `x`/`y` in 0..1 pick which edge the frame aligns to. The CSS:
 * the <img> is `scale × 100%` of the frame on both axes with `object-fit:
 * cover`, offset by `-(scale − 1) × x` of the frame so 0 shows the left/top
 * edge and 1 the right/bottom, and `object-position: x% y%` moves the cover
 * overflow by the same fraction. Both moves use the same number, so the
 * mapping is monotonic and — because the img box is never smaller than the
 * frame and cover never leaves a gap — the frame can never show empty space
 * at any x, y or scale. The frame clips (overflow hidden) and carries the
 * corner radius.
 *
 * Pure: no DOM. scripts/test-slides-crop.ts drives it in node.
 */

import type { ImageCrop } from './model.ts'

export const CROP_MAX_SCALE = 8

/** A crop with every number in range; null for absent. Out-of-range values
 *  clamp rather than drop — a hand-edited 1.2 means "the right edge". */
export function normalizeCrop(c: ImageCrop | null | undefined): ImageCrop | null {
  if (!c || typeof c !== 'object') return null
  const n = (v: unknown, lo: number, hi: number, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt
  return { x: n(c.x, 0, 1, 0.5), y: n(c.y, 0, 1, 0.5), scale: n(c.scale, 1, CROP_MAX_SCALE, 1) }
}

/** Is this crop the same picture as no crop at all (cover, centred, 1×)? */
export const isIdentityCrop = (c: ImageCrop | null | undefined): boolean => {
  const n = normalizeCrop(c)
  return !n || (n.scale === 1 && n.x === 0.5 && n.y === 0.5)
}

/** Inline style for the <img> inside a frame that carries `crop`. */
export function cropImgStyle(c: ImageCrop): string {
  const n = normalizeCrop(c)!
  const pct = (v: number) => `${Math.round(v * 10000) / 100}%`
  const size = pct(n.scale)
  const off = (v: number) => pct(-(n.scale - 1) * v)
  return `position:absolute;left:${off(n.x)};top:${off(n.y)};width:${size};height:${size};` +
    `object-fit:cover;object-position:${pct(n.x)} ${pct(n.y)};display:block;max-width:none`
}

/**
 * The visible window, as fractions of the enlarged picture's cover box:
 * [left, top, width, height]. What a crop editor draws and what a test can
 * check against pixels — at x=1,y=0,scale=2 the window is the top-right
 * quarter.
 */
export function cropWindow(c: ImageCrop): [number, number, number, number] {
  const n = normalizeCrop(c)!
  const size = 1 / n.scale
  return [(1 - size) * n.x, (1 - size) * n.y, size, size]
}

/** Interpolate two crops (present.ts morph). Absent on either side = no
 *  tween: the picture snaps, because there is no honest midpoint between
 *  "the whole cover-fitted picture as `fit` says" and a window into it. */
export function lerpCrop(a: ImageCrop, b: ImageCrop, p: number): ImageCrop {
  const A = normalizeCrop(a)!
  const B = normalizeCrop(b)!
  return { x: A.x + (B.x - A.x) * p, y: A.y + (B.y - A.y) * p, scale: A.scale + (B.scale - A.scale) * p }
}
