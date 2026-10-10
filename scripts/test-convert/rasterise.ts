// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The page's rasteriser refuses a picture before anything decodes it when
// its header declares more than MAX_PIXELS, or cannot be read: so a hostile
// file can't make the browser's decoder allocate a giant bitmap. This pins
// the header reader for each format, the cap, and the ORDER (the check runs
// before `new Image()`). The decode itself runs in the page's browser test.
//
//   node scripts/test-convert/rasterise.ts

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { imageSize } from '../../convert/page/image-size.ts'
import { mayDecode, MAX_PIXELS } from '../../convert/page/rasterise.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bytes = (n: number) => new Uint8Array(n)
const put = (b: Uint8Array, o: number, s: string) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i) }
const be32 = (b: Uint8Array, o: number, v: number) => { b[o] = v >>> 24; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255 }
const le32 = (b: Uint8Array, o: number, v: number) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = v >>> 24 }
const le24 = (b: Uint8Array, o: number, v: number) => { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255 }
const uri = (mime: string, b: Uint8Array) => `data:${mime};base64,${Buffer.from(b).toString('base64')}`

function png(w: number, h: number) { const b = bytes(33); b[0] = 0x89; put(b, 1, 'PNG\r\n\x1a\n'); be32(b, 8, 13); put(b, 12, 'IHDR'); be32(b, 16, w); be32(b, 20, h); return b }
function webpX(w: number, h: number) { const b = bytes(30); put(b, 0, 'RIFF'); put(b, 8, 'WEBP'); put(b, 12, 'VP8X'); le24(b, 24, w - 1); le24(b, 27, h - 1); return b }
function webp8(w: number, h: number) { const b = bytes(30); put(b, 0, 'RIFF'); put(b, 8, 'WEBP'); put(b, 12, 'VP8 '); b[23] = 0x9d; b[24] = 1; b[25] = 0x2a; b[26] = w & 255; b[27] = (w >> 8) & 0x3f; b[28] = h & 255; b[29] = (h >> 8) & 0x3f; return b }
function bmp(w: number, h: number) { const b = bytes(54); put(b, 0, 'BM'); le32(b, 18, w); le32(b, 22, -h); return b }
function tiff(w: number, h: number, le: boolean) {
  const b = bytes(40); put(b, 0, le ? 'II' : 'MM')
  const w16 = (o: number, v: number) => { if (le) { b[o] = v & 255; b[o + 1] = v >> 8 } else { b[o] = v >> 8; b[o + 1] = v & 255 } }
  const w32 = (o: number, v: number) => (le ? le32(b, o, v) : be32(b, o, v))
  w16(2, 42); w32(4, 8); w16(8, 2)
  w16(10, 256); w16(12, 4); w32(14, 1); w32(18, w)
  w16(22, 257); w16(24, 4); w32(26, 1); w32(30, h)
  return b
}
function avif(w: number, h: number) { const b = bytes(48); put(b, 4, 'ftyp'); put(b, 8, 'avif'); put(b, 24, 'ispe'); be32(b, 32, w); be32(b, 36, h); return b }

console.log('reading sizes from headers')
for (const [name, b, w, h] of [
  ['PNG', png(640, 480), 640, 480],
  ['WebP VP8X', webpX(9000, 6000), 9000, 6000],
  ['WebP VP8', webp8(1200, 800), 1200, 800],
  ['BMP (top-down, negative height)', bmp(300, 200), 300, 200],
  ['TIFF little-endian', tiff(5000, 4000, true), 5000, 4000],
  ['TIFF big-endian', tiff(5000, 4000, false), 5000, 4000],
  ['AVIF (ispe)', avif(3840, 2160), 3840, 2160],
] as Array<[string, Uint8Array, number, number]>) {
  const s = imageSize(b)
  ok(!!s && s.width === w && s.height === h, `${name}: ${w} × ${h} (${s ? `${s.width} × ${s.height}` : 'unread'})`)
}
// a real 1×1 lossless WebP, as browsers write it
const REAL_WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='
const real = imageSize(new Uint8Array(Buffer.from(REAL_WEBP.split(',')[1], 'base64')))
ok(!!real && real.width === 1 && real.height === 1, `a real VP8L WebP reads as 1 × 1 (${real ? `${real.width} × ${real.height}` : 'unread'})`)

console.log('the cap, before decoding')
ok(MAX_PIXELS === 40_000_000, 'the cap is 40 megapixels')
ok(mayDecode(REAL_WEBP) && mayDecode(uri('image/webp', webpX(6000, 6000))), 'pictures within the cap may decode (1×1, 6000×6000 = 36 MP)')
ok(!mayDecode(uri('image/webp', webpX(16383, 16383))), 'a WebP header declaring 268 MP is refused before decoding')
ok(!mayDecode(uri('image/png', png(10000, 4001))), 'just over the cap is refused (40.01 MP)')
ok(!mayDecode(uri('image/tiff', tiff(100000, 100000, true))), 'a TIFF declaring 10 gigapixels is refused')
ok(!mayDecode(uri('image/webp', bytes(64))) && !mayDecode('data:image/webp;base64,!!!') && !mayDecode('https://example.com/x.webp'),
  'an unreadable header, broken base64, or anything but a data: URI is refused')
ok(!mayDecode(uri('image/png', png(0, 100))), 'a zero dimension is refused')

console.log('the order')
{
  const src = fs.readFileSync(path.join(root, 'convert/page/rasterise.ts'), 'utf8')
  const body = src.slice(src.indexOf('export async function rasteriseToPng'))
  const check = body.indexOf('if (!mayDecode(dataUri)) return null'), decode = body.indexOf('new Image()')
  ok(check > 0 && decode > check, 'rasteriseToPng refuses on the header check before it creates an Image to decode')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
