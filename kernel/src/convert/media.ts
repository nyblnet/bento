// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Pictures and package relationships — the .rels graph, the asset store, and
// p:pic → OutImage (675 pictures across the six census decks).
//
// THE SVG RULE is the one decision in this file that protects the whole deck.
// The census corpus is overwhelmingly vector — 386 .svg media parts against 18
// raster parts in the template alone, referenced through asvg:svgBlip in the
// blip's extLst — and the tempting destination, an inline bento `svg` element,
// silently corrupts every icon: render.ts deliberately never strips `id`, svg
// `url(#…)` resolves DOCUMENT-globally, and icon libraries all name their
// clipPath/gradient `a` — so 386 icons each defining `#a` all paint with the
// first one's clip. The safe destination is an `image` element holding a
// `data:image/svg+xml` asset (its own document, ids scoped) — the same route
// render.ts already takes on the svgAsImage thumbnail path. The raster blip
// beside an svgBlip is only PowerPoint's compatibility preview; we use it only
// when the vector part is actually missing, and say so.
//
// The store dedups by CONTENT, not by part name, because the template reuses
// the same image across dozens of slides and layouts — and because the emitted
// document is one self-contained HTML file (6.9MB of media → ~9.2MB of base64
// if embedded once; catastrophic if embedded per reference). Keys are a pure
// function of the bytes so a re-import emits identical assets and a diff means
// a real change.

import { NS, attr, intAttr, kid, kids, descendants, type XElem } from './xml.ts'
import { EMU_PER_PX, type InheritCtx, type OutImage } from './types.ts'
import type { ZipParts } from './zip.ts'

// --- relationships -----------------------------------------------------------

export interface Rel {
  /** resolved part name ('ppt/media/image1.png'), or the verbatim URI when
   *  mode is 'External' — an external target is never a package part and must
   *  never be fetched */
  target: string
  type: string
  mode?: string
}

/**
 * Parse one .rels part into id → relationship.
 *
 * `baseDir` is the directory of the SOURCE part the .rels belongs to (e.g.
 * 'ppt/slides/' for slide1.xml.rels), because targets are relative to the
 * part, not to the _rels folder that physically holds the file:
 * 'ppt/slides/' + '../media/x.png' → 'ppt/media/x.png'.
 */
export function parseRels(relsXml: XElem, baseDir: string): Map<string, Rel> {
  const out = new Map<string, Rel>()
  for (const r of kids(relsXml, NS.rel, 'Relationship')) {
    const id = attr(r, 'Id')
    const target = attr(r, 'Target')
    if (!id || target === undefined) continue
    const type = attr(r, 'Type') ?? ''
    const mode = attr(r, 'TargetMode')
    // An External target is a URI into the outside world (a linked picture, a
    // hyperlink). It stays verbatim — resolving it against baseDir would
    // mangle it, and fetching it is the caller's line never to cross.
    if (mode === 'External') out.set(id, { target, type, mode })
    else out.set(id, { target: resolveTarget(baseDir, target), type })
  }
  return out
}

/** Join + normalize an OPC target against a base directory. Targets are URIs:
 *  '%20' in the XML is a literal space in the ZIP part name. */
function resolveTarget(baseDir: string, target: string): string {
  let t = target
  try { t = decodeURIComponent(target) } catch { /* malformed escape: use as written */ }
  const segs = t.startsWith('/')
    ? t.split('/') // pack-absolute: '/ppt/media/x.png' ignores the base
    : [...baseDir.split('/'), ...t.split('/')]
  const out: string[] = []
  for (const s of segs) {
    if (s === '' || s === '.') continue
    if (s === '..') out.pop() // clamped at the package root
    else out.push(s)
  }
  return out.join('/')
}

// --- content types -----------------------------------------------------------

export interface ContentTypes {
  /** extension (lowercased, no dot) → mime, from ct:Default */
  defaults: Map<string, string>
  /** part name (no leading slash) → mime, from ct:Override */
  overrides: Map<string, string>
}

export function parseContentTypes(root: XElem): ContentTypes {
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  for (const c of kids(root, NS.ct)) {
    const t = attr(c, 'ContentType')
    if (!t) continue
    if (c.local === 'Default') {
      const ext = attr(c, 'Extension')
      if (ext) defaults.set(ext.toLowerCase(), t)
    } else if (c.local === 'Override') {
      const p = attr(c, 'PartName')
      if (p) overrides.set(p.replace(/^\//, ''), t)
    }
  }
  return { defaults, overrides }
}

/** Extension fallbacks for a package with no (or an incomplete)
 *  [Content_Types].xml — the package's own declarations win when present. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
  webp: 'image/webp', ico: 'image/x-icon',
  emf: 'image/x-emf', wmf: 'image/x-wmf', wdp: 'image/vnd.ms-photo',
}

export function mimeFor(partName: string, types?: ContentTypes): string {
  const clean = partName.replace(/^\//, '')
  const override = types?.overrides.get(clean)
  if (override) return override
  const dot = clean.lastIndexOf('.')
  const ext = dot < 0 ? '' : clean.slice(dot + 1).toLowerCase()
  return types?.defaults.get(ext) ?? MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

// --- base64 ------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** No Buffer (browser), no btoa assumption (bare JS runtimes): btoa where the
 *  platform has it, the manual encoder elsewhere. One function, both worlds. */
export function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    // btoa wants a binary string; apply() in bounded chunks — one call over a
    // multi-MB image blows the argument-count limit.
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[])
    }
    return btoa(bin)
  }
  return b64Manual(bytes)
}

function b64Manual(bytes: Uint8Array): string {
  let out = ''
  const n = bytes.length
  let i = 0
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63]
  }
  if (i + 1 === n) {
    const v = bytes[i] << 16
    out += B64[v >> 18] + B64[(v >> 12) & 63] + '=='
  } else if (i + 2 === n) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + '='
  }
  return out
}

// --- the asset store ---------------------------------------------------------

/** Two independent FNV-1a passes over the bytes, base36-joined. The key must
 *  be a pure function of the CONTENT (stable across re-imports, dedups across
 *  parts); 64 bits keeps accidental collisions out of reach for a few hundred
 *  assets, and `register` byte-compares on a hash hit anyway, so a collision
 *  costs a suffix, never a wrong image. */
function fnvKey(b: Uint8Array): string {
  let h1 = 0x811c9dc5 | 0
  let h2 = 0x7ee36211 | 0 // a second, unrelated basis
  for (let i = 0; i < b.length; i++) {
    h1 = Math.imul(h1 ^ b[i], 0x01000193)
    h2 = Math.imul(h2 ^ b[i], 0x01000193)
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Content-addressed media for the emitted document.
 *
 * `register` takes a resolved part name, returns the stable asset key (or
 * undefined for a missing part — the CALLER decides what that means and
 * reports it, because "svg part missing" and "raster missing" are different
 * findings). Elements reference `asset:<key>`; `assets()` is the
 * `doc.assets` record of data: URIs.
 */
export class AssetStore {
  /** hash → every distinct content seen under it (in practice one) */
  private byHash = new Map<string, Array<{ bytes: Uint8Array; key: string }>>()
  private uris = new Map<string, string>()
  // plain declarations, not parameter properties — node's strip-only TS
  // refuses non-erasable syntax, and every rig runs under it
  private parts: ZipParts
  private types?: ContentTypes

  constructor(parts: ZipParts, types?: ContentTypes) {
    this.parts = parts
    this.types = types
  }

  register(partName: string): string | undefined {
    const bytes = this.parts.get(partName.replace(/^\//, ''))
    if (!bytes) return undefined
    return this.registerBytes(bytes, mimeFor(partName, this.types))
  }

  /** Dedup is by bytes alone: the first registration's mime sticks, which is
   *  right — identical bytes under two names are the same file. */
  registerBytes(bytes: Uint8Array, mime: string): string {
    const h = fnvKey(bytes)
    let bucket = this.byHash.get(h)
    if (!bucket) { bucket = []; this.byHash.set(h, bucket) }
    for (const e of bucket) if (bytesEq(e.bytes, bytes)) return e.key
    const key = bucket.length === 0 ? `m${h}` : `m${h}x${bucket.length}`
    bucket.push({ bytes, key })
    this.uris.set(key, `data:${mime};base64,${toBase64(bytes)}`)
    return key
  }

  /** The doc.assets record: key → data: URI. */
  assets(): Record<string, string> {
    return Object.fromEntries(this.uris)
  }
}

// --- p:pic → OutImage --------------------------------------------------------

/**
 * Convert one p:pic. Returns undefined when there is nothing displayable —
 * every undefined is reported, never silent.
 *
 * The frame is read from the pic's OWN a:xfrm (pictures nearly always carry
 * one); a pic without it — a picture placeholder — comes back at 0,0,0,0 and
 * the caller's inheritance walk must supply the frame, exactly as for shapes.
 * Group transforms (p:grpSp chOff/chExt) are likewise the geometry pass's job.
 */
export function imageFrom(
  pic: XElem,
  ctx: InheritCtx,
  rels: Map<string, Rel>,
  assets: AssetStore,
  where = 'slide',
): OutImage | undefined {
  const report = ctx.report
  const blipFill = kid(pic, NS.p, 'blipFill')
  const blip = blipFill && kid(blipFill, NS.a, 'blip')
  if (!blipFill || !blip) {
    report.add('dropped', 'image-no-blip', where, 'a picture carries no image reference at all')
    return undefined
  }

  // The SVG rule (see header): a blip whose extLst carries asvg:svgBlip is a
  // vector icon; the r:embed raster beside it is only a compatibility preview.
  let key: string | undefined
  const svgBlip = descendants(blip, NS.asvg, 'svgBlip')[0]
  if (svgBlip) {
    const svgId = attr(svgBlip, 'embed')
    const svgRel = svgId ? rels.get(svgId) : undefined
    if (svgRel && !svgRel.mode) key = assets.register(svgRel.target)
    if (key === undefined) {
      report.add('approximated', 'svg-raster-fallback', where,
        'a vector icon\'s SVG part is missing — its raster preview is used instead')
    }
  }

  if (key === undefined) {
    const relId = attr(blip, 'embed') ?? attr(blip, 'link')
    const rel = relId ? rels.get(relId) : undefined
    if (!rel) {
      report.add('dropped', 'image-missing-rel', where,
        'a picture references a relationship the .rels part does not define')
      return undefined
    }
    if (rel.mode === 'External') {
      // A linked (not embedded) picture. The bytes live on someone's
      // filesystem or a URL; fetching is out of the question for a converter,
      // so the picture is lost and the report says where it pointed.
      report.add('dropped', 'image-external-dropped', where,
        `a linked (not embedded) picture points outside the file: ${rel.target}`)
      return undefined
    }
    if (rel.target.toLowerCase().endsWith('.wdp')) {
      // JPEG XR — no browser decodes it. PowerPoint pairs these with an
      // mc:Fallback pic carrying a real raster; the caller resolves that pair
      // (resolveAlternate) and calls us with the fallback pic instead.
      report.add('dropped', 'wdp-fallback', where,
        'a JPEG XR (.wdp) image no browser can decode — use the mc:Fallback picture if the file carries one')
      return undefined
    }
    key = assets.register(rel.target)
    if (key === undefined) {
      report.add('dropped', 'image-missing-part', where,
        `a picture's media part is missing from the package: ${rel.target}`)
      return undefined
    }
  }

  // Framing. 335 census crops (~half of all pictures) have no model field to
  // land in; 'cover' at least keeps the box filled and centred rather than
  // squashing the whole original into it — but an off-centre headshot crop
  // WILL reframe, which is why this is 'approximated', not carried.
  const srcRect = kid(blipFill, NS.a, 'srcRect')
  const cropped = srcRect !== undefined &&
    (intAttr(srcRect, 'l') !== 0 || intAttr(srcRect, 't') !== 0 ||
     intAttr(srcRect, 'r') !== 0 || intAttr(srcRect, 'b') !== 0)
  let fit: OutImage['fit'] = 'fill' // a:stretch (the norm, and the default)
  if (cropped) {
    fit = 'cover'
    report.add('approximated', 'image-crop-dropped', where,
      'a source-rectangle crop has no model field — the image fills its box as a centred cover instead')
  } else if (kid(blipFill, NS.a, 'tile')) {
    report.add('approximated', 'image-tile-dropped', where,
      'a tiled picture fill renders as a single stretched copy')
  }

  const spPr = kid(pic, NS.p, 'spPr')
  const xfrm = spPr && kid(spPr, NS.a, 'xfrm')
  let x = 0, y = 0, w = 0, h = 0, rotation = 0
  if (xfrm) {
    const off = kid(xfrm, NS.a, 'off')
    const ext = kid(xfrm, NS.a, 'ext')
    if (off) { x = px(intAttr(off, 'x')); y = px(intAttr(off, 'y')) }
    if (ext) { w = px(intAttr(ext, 'cx')); h = px(intAttr(ext, 'cy')) }
    rotation = intAttr(xfrm, 'rot') / 60000 // 60,000ths of a degree
  }

  const nv = kid(pic, NS.p, 'nvPicPr')
  const cNvPr = nv && kid(nv, NS.p, 'cNvPr')
  return {
    id: `pic${cNvPr ? intAttr(cNvPr, 'id') : 0}`,
    type: 'image',
    x, y, w, h, rotation,
    opacity: 1,
    src: `asset:${key}`,
    fit,
  }
}

/** EMU → px, rounded to 1/100 px so emitted JSON stays diffable. */
const px = (emu: number): number => Math.round((emu / EMU_PER_PX) * 100) / 100

export const _internals = { b64Manual, resolveTarget, fnvKey, bytesEq }
