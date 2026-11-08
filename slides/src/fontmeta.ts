// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Reads the @font-face descriptors a font file states about itself, so an
// embedded face is declared with the weights it really has (#850).
//
// Without this every embedded file was declared `font-weight: normal`. A
// variable font covering 100..900 then matched only 400: Bold drew the 400
// instance thickened by the browser (faux bold), never the font's own bold.
// A static Bold file was declared 400 too, and got faux bold ON TOP of bold.
//
// What each container gives up:
//   - TTF/OTF: tables are plain. fvar's wght axis is the range; with no wght
//     axis, OS/2 usWeightClass is the single weight.
//   - WOFF: the same tables, each zlib-compressed — inflated with the
//     browser's DecompressionStream.
//   - WOFF2: all tables are ONE brotli stream, and no browser offers brotli in
//     DecompressionStream (measured: Chrome 149 and 156 refuse it). Only the
//     table directory is readable, and it says whether fvar is there. For a
//     variable WOFF2 the range is measured by rendering (probeWeightRange);
//     a static WOFF2's weight cannot be read and stays unstated.

export interface FaceDescriptors { weight?: string; style?: string }

/** What the file says. `variable` = a WOFF2 that has fvar but whose axes cannot be read. */
export interface FontFileFacts extends FaceDescriptors { variable?: boolean }

const tag = (v: DataView, at: number) =>
  String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3))

/** Read descriptors from a font file's bytes. Never throws: a file it cannot read gives {}. */
export async function readFontFacts(bytes: Uint8Array): Promise<FontFileFacts> {
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const sig = tag(v, 0)
    if (sig === 'wOF2') return woff2Directory(v).has('fvar') ? { variable: true } : {}
    const tables = sig === 'wOFF' ? await woffTables(bytes, v) : sfntTables(bytes, v, 0)
    if (!tables) return {}
    return descriptors(tables.get('fvar'), tables.get('OS/2'))
  } catch {
    return {}
  }
}

type Tables = Map<string, DataView>

function sfntTables(bytes: Uint8Array, v: DataView, base: number): Tables | undefined {
  const sig = v.getUint32(base)
  if (sig !== 0x00010000 && sig !== 0x74727565 /* true */ && sig !== 0x4f54544f /* OTTO */) return undefined
  const out: Tables = new Map()
  const n = v.getUint16(base + 4)
  for (let i = 0; i < n; i++) {
    const at = base + 12 + i * 16
    const offset = v.getUint32(at + 8), length = v.getUint32(at + 12)
    out.set(tag(v, at), new DataView(bytes.buffer, bytes.byteOffset + offset, length))
  }
  return out
}

async function woffTables(bytes: Uint8Array, v: DataView): Promise<Tables> {
  const out: Tables = new Map()
  const n = v.getUint16(12)
  for (let i = 0; i < n; i++) {
    const at = 44 + i * 20
    const name = tag(v, at)
    if (name !== 'fvar' && name !== 'OS/2') continue
    const offset = v.getUint32(at + 4), compLength = v.getUint32(at + 8), origLength = v.getUint32(at + 12)
    let data = bytes.subarray(offset, offset + compLength)
    if (compLength < origLength) data = await inflate(data)
    out.set(name, new DataView(data.buffer, data.byteOffset, data.byteLength))
  }
  return out
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// WOFF2 "known table" indices (WOFF2 spec, table 5.1); 63 = tag follows.
const WOFF2_FVAR = 47

function woff2Directory(v: DataView): Set<string> {
  const out = new Set<string>()
  const n = v.getUint16(12)
  let at = 48
  const base128 = () => {
    let value = 0
    for (let i = 0; i < 5; i++) {
      const b = v.getUint8(at++)
      value = value * 128 + (b & 0x7f)
      if (!(b & 0x80)) return value
    }
    throw new Error('bad UIntBase128')
  }
  for (let i = 0; i < n; i++) {
    const flags = v.getUint8(at++)
    const known = flags & 0x3f
    let name = ''
    if (known === 0x3f) { name = tag(v, at); at += 4 } else if (known === WOFF2_FVAR) name = 'fvar'
    base128() // origLength
    const version = flags >> 6
    // glyf/loca carry a transformLength unless version 3; every other table only when version != 0
    const glyfOrLoca = known === 10 || known === 11 || name === 'glyf' || name === 'loca'
    if (glyfOrLoca ? version !== 3 : version !== 0) base128()
    if (name) out.add(name)
  }
  return out
}

const weightValue = (w: number) => Math.min(1000, Math.max(1, Math.round(w)))

function descriptors(fvar: DataView | undefined, os2: DataView | undefined): FaceDescriptors {
  const out: FaceDescriptors = {}
  const range = fvar && wghtAxis(fvar)
  if (range) {
    const [lo, hi] = range.map(weightValue)
    out.weight = lo === hi ? String(lo) : `${lo} ${hi}`
  } else if (os2 && os2.byteLength >= 6) {
    const w = os2.getUint16(4)
    if (w >= 1 && w <= 1000) out.weight = String(w)
  }
  if (os2 && os2.byteLength >= 64 && os2.getUint16(62) & 0x01) out.style = 'italic'
  return out
}

function wghtAxis(fvar: DataView): [number, number] | undefined {
  const axesAt = fvar.getUint16(4), count = fvar.getUint16(8), size = fvar.getUint16(10)
  for (let i = 0; i < count; i++) {
    const at = axesAt + i * size
    if (tag(fvar, at) !== 'wght') continue
    const min = fvar.getInt32(at + 4) / 65536, max = fvar.getInt32(at + 12) / 65536
    return min <= max ? [min, max] : undefined
  }
  return undefined
}

/**
 * Measure a variable face's weight range by rendering, for the WOFF2 whose
 * fvar cannot be read. The face is loaded with a 1..1000 descriptor, so every
 * requested weight sets wght directly and the FONT clamps it to its own axis:
 * outside the axis the rendering is pixel-identical to the clamped end. So the
 * range's low end is the highest probe that still renders exactly as weight 1,
 * the high end the lowest that renders exactly as 1000. Probes sit on the
 * hundreds, where axis ends almost always are; an end between two probes
 * reads as the outer one — a range wider than the font, never narrower, which
 * costs nothing (the font clamps) where narrower would bring faux bold back.
 * Returns undefined when weight changes nothing, or rendering is unavailable.
 */
export async function probeWeightRange(src: string): Promise<string | undefined> {
  try {
    const family = `bento-weight-probe-${Math.random().toString(36).slice(2)}`
    const face = new FontFace(family, `url(${JSON.stringify(src)})`, { weight: '1 1000' })
    await face.load()
    document.fonts.add(face)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 800; canvas.height = 160
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return undefined
      const render = (w: number) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.font = `${w} 96px "${family}"`
        ctx.fillText('HOIamnoe', 8, 120)
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data
      }
      const same = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.every((x, i) => x === b[i])
      const weights = [1, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
      const shots = weights.map(render)
      const lowest = shots[0], highest = shots[shots.length - 1]
      if (same(lowest, highest)) return undefined
      let lo = 0
      while (lo + 1 < shots.length && same(shots[lo + 1], lowest)) lo++
      let hi = shots.length - 1
      while (hi - 1 >= 0 && same(shots[hi - 1], highest)) hi--
      return weights[lo] === weights[hi] ? String(weights[lo]) : `${weights[lo]} ${weights[hi]}`
    } finally {
      document.fonts.delete(face)
    }
  } catch {
    return undefined
  }
}

/** Everything embedFont needs: the file's own descriptors, measured where they cannot be read. */
export async function fontFaceDescriptors(bytes: Uint8Array, src: string): Promise<FaceDescriptors> {
  const { variable, ...facts } = await readFontFacts(bytes)
  if (variable && !facts.weight) {
    const weight = await probeWeightRange(src)
    if (weight) facts.weight = weight
  }
  return facts
}
