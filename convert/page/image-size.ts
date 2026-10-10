// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// An image's width and height, read from its header bytes, BEFORE anything
// decodes it. rasterise.ts refuses a picture whose header declares more than
// its pixel cap, so a hostile file can't make the browser's decoder allocate
// a huge bitmap. A header this cannot read is refused too: nothing unknown
// reaches the decoder.
//
// DOM-free and dependency-free; scripts/test-convert/rasterise.ts drives it.

export interface Size { width: number; height: number; format: string }

const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1]
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
const i32le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n))

/** The header bytes of a base64 data: URI (enough for every format here). */
export function headerBytes(dataUri: string, max = 64 * 1024): Uint8Array | null {
  const m = /^data:[^;,]+;base64,/i.exec(dataUri)
  if (!m) return null
  const b64 = dataUri.slice(m[0].length, m[0].length + Math.ceil((max * 4) / 3 / 4) * 4)
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch { return null }
}

/** Width and height from a header, or null when the format or header is not
 *  one this reads (and so must not be decoded). */
export function imageSize(b: Uint8Array): Size | null {
  // PNG: signature, then IHDR's width and height (big-endian)
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR')
    return { width: u32be(b, 16), height: u32be(b, 20), format: 'png' }
  // WebP: RIFF....WEBP, then a VP8 / VP8L / VP8X chunk
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4)
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, format: 'webp' }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const b1 = b[22], b2 = b[23], b3 = b[24]
      return { width: 1 + (b[21] | ((b1 & 0x3f) << 8)), height: 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)), format: 'webp' }
    }
    if (chunk === 'VP8X') return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27), format: 'webp' }
    return null
  }
  // BMP: 'BM', then BITMAPINFOHEADER width/height (height may be negative)
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d)
    return { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)), format: 'bmp' }
  // TIFF: byte order, 42, then the first IFD's ImageWidth (256) / ImageLength (257)
  if (b.length >= 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 42))) {
    const le = b[0] === 0x49
    const r16 = (o: number) => (le ? u16le(b, o) : u16be(b, o))
    const r32 = (o: number) => (le ? u32le(b, o) : u32be(b, o))
    const ifd = r32(4)
    if (ifd + 2 > b.length) return null
    let w = 0, h = 0
    const n = r16(ifd)
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12
      if (e + 12 > b.length) return null
      const tag = r16(e), type = r16(e + 2)
      const val = type === 3 ? r16(e + 8) : type === 4 ? r32(e + 8) : 0
      if (tag === 256) w = val
      if (tag === 257) h = val
    }
    return w && h ? { width: w, height: h, format: 'tiff' } : null
  }
  // AVIF / HEIF: an 'ispe' (image spatial extents) property holds the size
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
    for (let i = 8; i + 16 <= b.length; i++) {
      if (b[i] === 0x69 && ascii(b, i, 4) === 'ispe') return { width: u32be(b, i + 8), height: u32be(b, i + 12), format: 'avif' }
    }
    return null
  }
  return null
}
