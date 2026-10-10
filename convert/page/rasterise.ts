// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A picture PowerPoint cannot take (WebP, AVIF, BMP, TIFF) → a PNG data: URI,
// with the browser's own decoder and a canvas. The writer has no DOM, so the
// page passes this in (ExportOpts.rasterise). Same pixels, PNG-encoded.
//
// Guards, in order:
//   1. data: URIs only (the CSP's img-src allows data:, and nothing is fetched);
//   2. the size is read from the header BEFORE anything decodes it
//      (image-size.ts), and a header declaring more than 40 megapixels, or one
//      that cannot be read, is refused: the browser's decoder never sees it;
//   3. after decoding, the real size is checked again, before the canvas.
// A refusal returns null, and the writer reports the picture dropped.

import { headerBytes, imageSize } from './image-size.ts'

export const MAX_PIXELS = 40_000_000

/** Whether a picture may be decoded at all: its header must be readable and
 *  declare at most MAX_PIXELS. Exported for the rig. */
export function mayDecode(dataUri: string): boolean {
  if (!/^data:image\//i.test(dataUri)) return false
  const head = headerBytes(dataUri)
  const size = head && imageSize(head)
  return !!size && size.width > 0 && size.height > 0 && size.width * size.height <= MAX_PIXELS
}

export async function rasteriseToPng(dataUri: string): Promise<string | null> {
  if (!mayDecode(dataUri)) return null
  const img = new Image()
  img.decoding = 'async'
  img.src = dataUri
  try { await img.decode() } catch { return null }
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (!w || !h || w * h > MAX_PIXELS) return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')
  if (!g) return null
  g.drawImage(img, 0, 0)
  const png = canvas.toDataURL('image/png')
  return png.startsWith('data:image/png') ? png : null
}
