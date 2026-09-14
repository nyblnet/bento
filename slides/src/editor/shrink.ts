// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Photos shrink at insert. A phone photo is 4000 px wide and several MB; a
 * slide is 1280 px wide and a 4K projector shows it at 2560. Every insert
 * path (file picker, paste, panel replace) runs the picture through here, so
 * the deck grows by hundreds of KB, not megabytes — the biggest lever left on
 * file size after #447/#476 (a save drops what nothing refers to) and #468
 * (built-in fonts). The FORMAT is untouched: `src` is still a data URI or an
 * `asset:` key, and an old shell opens the deck identically.
 *
 * The rules, in the order they run (the DOM-free ones are exported so
 * scripts/test-slides-shrink.ts can hold them):
 *
 *   1. SVG and GIF are never touched — vectors have no pixels to shed and a
 *      GIF may animate. Never upscale.
 *   2. The long edge is capped at MAX_EDGE (2560), not at the element's box:
 *      users resize later and would find a box-fitted image blurry.
 *   3. Photos become lossy (JPEG 0.85, or WebP where the browser really
 *      encodes it and it is smaller); GRAPHICS stay lossless PNG. A graphic is
 *      anything with transparency, or with few distinct colours — a
 *      screenshot with text, a logo, a chart — because JPEG makes those
 *      fuzzy and that is the thing people notice.
 *   4. The original bytes are kept unless the result is at least MIN_GAIN
 *      (20%) smaller. Re-encoding a small, already-tight JPEG only loses.
 *
 * Preference: localStorage 'bento-shrink-photos' = 'off' bypasses all of it
 * (About dialog). An authoring convenience for this browser, never in the
 * document.
 */

import { lsGet, lsSet } from '../../../kernel/src/storage.ts'

export const MAX_EDGE = 2560
/** The re-encoded result must be at least this much smaller, or the original stays. */
export const MIN_GAIN = 0.2
/** Below this many distinct 5-bit colours in the sample, an image reads as a graphic (a logo, a chart). */
export const GRAPHIC_COLOURS = 64
/** Above this share of sample points identical to the point before them, an
 *  image reads as a graphic (a screenshot's flat background). A photo's sensor
 *  noise makes two pixels 40 px apart almost never identical. */
export const GRAPHIC_FLAT = 0.3
/** Toast only when the saving is worth telling. */
export const TOAST_MIN_SAVING = 200 * 1024
const PHOTO_QUALITY = 0.85
const PREF_KEY = 'bento-shrink-photos'

export type ShrinkKind = 'photo' | 'graphic' | 'kept'
export interface ShrinkResult {
  dataUrl: string
  width: number
  height: number
  /** bytes of the original file */
  before: number
  /** bytes stored */
  after: number
  kind: ShrinkKind
  reason: 'shrunk' | 'untouchable' | 'no gain' | 'off' | 'undecodable'
}

export const shrinkEnabled = (): boolean => lsGet(PREF_KEY) !== 'off'
export const setShrinkEnabled = (on: boolean): void => { lsSet(PREF_KEY, on ? 'on' : 'off') }

/** Formats and shapes that are left exactly as they came. */
export const untouchable = (mime: string): boolean => /^image\/(svg\+xml|gif)$/i.test(mime)

/** The size the long edge is capped to — never larger than the source. */
export function fitEdge(w: number, h: number, max = MAX_EDGE): { width: number; height: number } {
  const long = Math.max(w, h)
  if (long <= max) return { width: w, height: h }
  const s = max / long
  return { width: Math.round(w * s), height: Math.round(h * s) }
}

/**
 * Photo or graphic, from a sample of pixels taken on a grid across the image
 * (RGBA, in row order; the grid spacing is the caller's, ~40 px). Three
 * signs make a graphic, any one of them: transparency anywhere (JPEG has no
 * alpha); a run of identical consecutive sample points — a screenshot's flat
 * background, a chart's fills — above GRAPHIC_FLAT of the sample, which a
 * photo's noise never produces; or very few distinct colours, a logo.
 * Everything else is a photo, including a smooth sky: a gradient's
 * neighbours 40 px apart differ, so it is not "flat".
 */
export function classify(rgba: Uint8ClampedArray | Uint8Array): 'photo' | 'graphic' {
  const seen = new Set<number>()
  let same = 0
  let n = 0
  let prev = -1
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 255) return 'graphic'
    const exact = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]
    if (n > 0 && exact === prev) same++
    prev = exact
    n++
    seen.add(((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3))
  }
  if (n === 0) return 'graphic'
  if (same / Math.max(1, n - 1) > GRAPHIC_FLAT) return 'graphic'
  return seen.size < GRAPHIC_COLOURS ? 'graphic' : 'photo'
}

/** Every `step`-th pixel of a full-resolution frame, as one RGBA run in row order. */
export function sampleGrid(rgba: Uint8ClampedArray, width: number, height: number, step: number): Uint8ClampedArray {
  const cols = Math.max(1, Math.floor(width / step))
  const rows = Math.max(1, Math.floor(height / step))
  const out = new Uint8ClampedArray(cols * rows * 4)
  let o = 0
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = ((r * step) * width + c * step) * 4
    out[o++] = rgba[i]; out[o++] = rgba[i + 1]; out[o++] = rgba[i + 2]; out[o++] = rgba[i + 3]
  }
  return out
}

/** Keep the original unless the candidate is at least MIN_GAIN smaller. */
export const worthIt = (before: number, after: number): boolean => after <= before * (1 - MIN_GAIN)

const bytesOfDataUrl = (u: string): number => {
  const i = u.indexOf(',')
  return i < 0 ? 0 : Math.floor(((u.length - i - 1) * 3) / 4)
}

const readDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })

const toBlob = (c: HTMLCanvasElement, type: string, q?: number): Promise<Blob | null> =>
  new Promise((resolve) => c.toBlob(resolve, type, q))

/** Encode; a browser that cannot produce `type` answers with a PNG, which is not what was asked. */
async function encode(c: HTMLCanvasElement, type: string, q?: number): Promise<Blob | null> {
  const b = await toBlob(c, type, q)
  return b && b.type === type ? b : null
}

const kept = (dataUrl: string, before: number, width: number, height: number, reason: ShrinkResult['reason']): ShrinkResult =>
  ({ dataUrl, width, height, before, after: before, kind: 'kept', reason })

/**
 * The whole thing: decode, cap, classify, encode, compare. Always resolves —
 * anything that cannot be decoded is stored as it came, the way it always was.
 */
export async function shrinkImageFile(file: Blob): Promise<ShrinkResult> {
  const before = file.size
  const original = await readDataUrl(file)
  if (!shrinkEnabled()) return kept(original, before, 0, 0, 'off')
  if (untouchable(file.type)) return kept(original, before, 0, 0, 'untouchable')

  let bmp: ImageBitmap
  try { bmp = await createImageBitmap(file) } catch { return kept(original, before, 0, 0, 'undecodable') }
  const { width, height } = fitEdge(bmp.width, bmp.height)
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) { bmp.close(); return kept(original, before, bmp.width, bmp.height, 'undecodable') }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bmp, 0, 0, width, height)
  bmp.close()

  // sample the drawn frame on a ~40 px grid (about 64×48 points at the cap):
  // real pixels, not a downscale — a downscale averages a photo's noise away
  // and made a gradient look flat
  const step = Math.max(1, Math.round(Math.max(width, height) / 64))
  const kind = classify(sampleGrid(ctx.getImageData(0, 0, width, height).data, width, height, step))

  const candidates: Blob[] = []
  if (kind === 'photo') {
    const jpeg = await encode(canvas, 'image/jpeg', PHOTO_QUALITY)
    const webp = await encode(canvas, 'image/webp', PHOTO_QUALITY)
    for (const b of [jpeg, webp]) if (b) candidates.push(b)
  } else {
    // PNG only: a browser's WebP encoder cannot be asked for lossless in a
    // way every engine honours, and "sharp" is the promise for graphics
    const png = await encode(canvas, 'image/png')
    if (png) candidates.push(png)
  }
  candidates.sort((a, b) => a.size - b.size)
  const best = candidates[0]
  if (!best || !worthIt(before, best.size)) return kept(original, before, width, height, 'no gain')
  const dataUrl = await readDataUrl(best)
  return { dataUrl, width, height, before, after: bytesOfDataUrl(dataUrl), kind, reason: 'shrunk' }
}

/** What the toast says, or null when the saving is not worth a line. The
 *  strings are the caller's (t() is render-time, not module-level). */
export function shrinkNote(r: ShrinkResult): { photo: boolean; vars: { px: number; before: string; after: string } } | null {
  if (r.kind === 'kept' || r.before - r.after < TOAST_MIN_SAVING) return null
  return { photo: r.kind === 'photo', vars: { px: Math.max(r.width, r.height), before: fmtBytes(r.before), after: fmtBytes(r.after) } }
}

export const fmtBytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
