// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A picture PowerPoint cannot take (WebP, AVIF, BMP, TIFF) → a PNG data: URI,
// with the browser's own decoder and a canvas. The writer has no DOM, so the
// page passes this in (ExportOpts.rasterise). Same pixels, PNG-encoded.
//
// Guards: the image is decoded from a data: URI only (the CSP's img-src allows
// data:, and nothing is fetched); anything over 40 megapixels is refused
// rather than drawn, so a hostile file cannot make the tab allocate a huge
// canvas. A refusal returns null, and the writer reports the picture dropped.

const MAX_PIXELS = 40_000_000

export async function rasteriseToPng(dataUri: string): Promise<string | null> {
  if (!/^data:image\//i.test(dataUri)) return null
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
