// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Images and media parts — everything that becomes a p:pic and a file under
// ppt/media/.
//
// A bento image's src is either a data: URI (self-contained decks embed
// everything), an "asset:<key>" into doc.assets (which itself holds a data:
// URI or raw markup), or an external URL. The first two carry BYTES and become
// embedded media parts; the URL case cannot (this engine does no IO — it runs
// in a browser tab and in node, and an export must not be a network
// operation), so it becomes a LINKED picture: a:blip r:link with an external
// image relationship, which PowerPoint resolves at open. Census note: p:pic is
// the 4th most common shape in real decks (675 across 6/6 files), so this path
// is not an edge case — it is a quarter of what a converted deck looks like.
//
// Identical images repeat across slides constantly (logos, footer marks — the
// same duplicate-a-slide idiom that gave bento its morph key), so the store
// DEDUPLICATES by bytes: forty slides with one logo produce one
// ppt/media/imageN.png, exactly as PowerPoint itself writes it. Rel entries
// are per-slide and cheap; the bytes are the cost worth sharing.
//
// Mapping decisions adopted from PR #88's exporter (slides/src/export/pptx/
// images.ts, media.ts, svg.ts), kept through the rewrite:
//   - the shape name carries `bento:<morphId||id>` (its objectName trick) so a
//     round-trip back through the importer can recover element identity;
//   - missing/unresolvable sources are a REPORT entry, never a throw — one
//     broken asset must not kill a forty-slide export ('missing-image',
//     'missing-svg' are its codes);
//   - svg css injects into the markup before embedding, and media data: URIs
//     fall back to the poster still.
// Where this rewrite is HONEST where #88 was silent: cover/contain fits and
// svg-without-raster both get report entries now (see below).

import { EMU_PER_PX, type OutElementBase, type OutImage } from '../types.ts'
import type { Report } from '../report.ts'
import { x, type XNode } from '../xmlout.ts'
import { REL, type RelEntry } from './parts.ts'

// --- input shapes ------------------------------------------------------------
// Structural, like ../types.ts: the writer never imports from an app. OutImage
// already exists (the importer emits it); svg and media elements are export-
// only inputs, declared here with exactly the fields this module reads —
// slides/src/model.ts is the semantic ground truth for every one of them.

export interface SvgIn extends OutElementBase {
  /** key into assets holding raw SVG markup (preferred in the model: dedupes) */
  asset?: string
  /** raw inline markup, used when `asset` is unset */
  markup?: string
  /** css the renderer injects inside the svg — must travel with the bytes */
  css?: string
}

export interface MediaIn extends OutElementBase {
  kind: 'video' | 'audio'
  src: string
  /** video only: a still shown before playback (data:/asset:/URL) */
  poster?: string
  radius?: number
}

/** OutImage plus the optional morph key (present on real docs, not in the
 *  importer's subset — the name we emit prefers it, matching #88). */
export type ImageIn = OutImage & { morphId?: string }

// --- data: URI decoding ------------------------------------------------------

const B64: Record<string, number> = {}
for (let i = 0; i < 64; i++) {
  B64['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[i]] = i
}
// URL-safe alphabet too: not what data: URIs are supposed to carry, but
// content pasted through chat tools produces it and refusing costs a picture.
B64['-'] = 62
B64['_'] = 63

/**
 * Decode a base64 string to bytes. Hand-rolled because the two platform
 * decoders are both wrong for the writer: Buffer is node-only, and atob
 * round-trips through a binary STRING (one JS char per byte — an allocation
 * disaster at 8 MB video scale, and another loop to repack anyway).
 * Whitespace is skipped (long data URIs get wrapped by editors); padding is
 * optional. Returns null on any other character — a corrupt src must become a
 * report entry upstream, not a corrupt image part.
 */
export function decodeBase64(s: string): Uint8Array | null {
  // Worst-case size; trimmed at the end once the real length is known.
  const out = new Uint8Array((s.length >> 2) * 3 + 3)
  let acc = 0
  let bits = 0
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '=' || c === ' ' || c === '\n' || c === '\r' || c === '\t') continue
    const v = B64[c]
    if (v === undefined) return null
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, n)
}

export interface DecodedDataUri {
  mime: string
  bytes: Uint8Array
}

/**
 * Parse a data: URI to mime + bytes. Handles both encodings the grammar
 * allows: `;base64,<b64>` and the percent-encoded text form (which is how
 * hand-written svg data URIs usually arrive — #88's own svgDataUri emitted
 * base64, but pasted content does not). Returns null for anything malformed:
 * the caller reports and moves on.
 */
export function decodeDataUri(uri: string): DecodedDataUri | null {
  if (!uri.startsWith('data:')) return null
  const comma = uri.indexOf(',')
  if (comma < 0) return null
  const meta = uri.slice(5, comma)
  const params = meta.split(';')
  const mime = (params[0] || 'text/plain').trim().toLowerCase()
  if (params.some((p) => p.trim().toLowerCase() === 'base64')) {
    const bytes = decodeBase64(uri.slice(comma + 1))
    return bytes ? { mime, bytes } : null
  }
  try {
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(uri.slice(comma + 1))) }
  } catch {
    return null // malformed %-escape
  }
}

// --- the media store ---------------------------------------------------------

/**
 * Extension per mime — and also the SUPPORT GATE. Everything here is covered
 * by a Default row in [Content_Types].xml (parts.ts contentTypes); a part
 * with any other extension would need a Default the integrator does not emit,
 * and an unmatched part is a repair dialog. So an unlisted mime (webp, bmp,
 * tiff…) is refused at add() and reported as dropped by the callers — a
 * missing picture with a named reason beats a deck PowerPoint refuses whole.
 */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg', // wrong but seen in the wild; the bytes are jpeg
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
}

// FNV-1a, 32-bit — cheap and dependency-free. Only a bucket key: colliding
// entries compare full bytes below, so a collision costs a memcmp, never a
// wrong picture.
function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export interface MediaFile {
  /** full part name inside the package, e.g. 'ppt/media/image3.png' */
  name: string
  bytes: Uint8Array
}

/**
 * The package's media parts, numbered imageN in add order (PowerPoint's own
 * naming — media1/media2 is reserved for real embedded audio/video, which
 * M-export-0 does not produce). One store per EXPORT, shared by every slide,
 * because dedup across slides is the whole point.
 */
export class MediaStore {
  private parts: MediaFile[] = []
  private byHash = new Map<string, MediaFile[]>()

  /** Register bytes under a mime; returns the part name (existing on dedup),
   *  or null for a mime outside the supported set (see EXT_BY_MIME). */
  add(bytes: Uint8Array, mime: string): string | null {
    const ext = EXT_BY_MIME[mime]
    if (!ext) return null
    const key = `${ext}:${bytes.length}:${fnv1a(bytes)}`
    const bucket = this.byHash.get(key)
    if (bucket) {
      for (const f of bucket) if (bytesEqual(f.bytes, bytes)) return f.name
    }
    const file: MediaFile = { name: `ppt/media/image${this.parts.length + 1}.${ext}`, bytes }
    this.parts.push(file)
    if (bucket) bucket.push(file)
    else this.byHash.set(key, [file])
    return file.name
  }

  files(): readonly MediaFile[] {
    return this.parts
  }
}

// --- per-slide context -------------------------------------------------------

/** What one slide's worth of pic-building needs. The integrator owns rel id
 *  allocation (ids are unique per RELS PART, and layout/notes/hyperlink rels
 *  come from the same sequence), so it passes the allocator in. */
export interface MediaCtx {
  /** doc.assets — "asset:<key>" resolves here */
  assets: Record<string, string>
  store: MediaStore
  /** the slide's rel list; this module pushes image rels into it */
  rels: RelEntry[]
  nextRelId(): string
  report: Report
}

/** "asset:<key>" → the asset's value; anything else passes through. The same
 *  resolution as slides' render.resolveAsset, restated because the writer
 *  cannot import from an app. */
function resolveSrc(assets: Record<string, string>, ref: string): string {
  return ref.startsWith('asset:') ? (assets[ref.slice(6)] ?? '') : ref
}

/** Slide parts live at ppt/slides/, media at ppt/media/ — one hop up. */
const relTarget = (partName: string): string => `../${partName.slice('ppt/'.length)}`

// --- p:pic assembly ----------------------------------------------------------

/** a:xfrm from the element frame. EMU are integers by definition; rot is in
 *  60000ths of a degree and omitted at zero (matching what PowerPoint writes,
 *  which keeps output diffable against native files). */
function xfrm(el: OutElementBase): XNode {
  return x('a:xfrm', el.rotation ? { rot: Math.round(el.rotation * 60000) } : undefined, [
    x('a:off', { x: Math.round(el.x * EMU_PER_PX), y: Math.round(el.y * EMU_PER_PX) }),
    x('a:ext', { cx: Math.round(el.w * EMU_PER_PX), cy: Math.round(el.h * EMU_PER_PX) }),
  ])
}

/** rect, or roundRect when the element carries a corner radius. The adj
 *  handle is the radius as a fraction of the SHORTER side in 1000ths of a
 *  percent, capped at 50% — the same conversion, css px → geometry guide,
 *  in both directions of the round trip. */
function picGeom(el: { w: number; h: number }, radius: number | undefined): XNode {
  if (!radius || radius <= 0) return x('a:prstGeom', { prst: 'rect' }, [x('a:avLst')])
  const short = Math.min(el.w, el.h)
  const adj = short > 0 ? Math.min(50000, Math.round((radius / short) * 100000)) : 0
  return x('a:prstGeom', { prst: 'roundRect' }, [
    x('a:avLst', undefined, [x('a:gd', { name: 'adj', fmla: `val ${adj}` })]),
  ])
}

interface PicOpts {
  shapeId: number
  name: string
  /** children of a:blip, e.g. alphaModFix or the svgBlip extLst */
  blipKids?: XNode[]
  /** external (linked) picture: blip uses r:link instead of r:embed */
  link?: boolean
}

function pic(el: OutElementBase, relId: string, radius: number | undefined, opts: PicOpts): XNode {
  const blipKids: XNode[] = []
  if (el.opacity < 1) {
    // Whole-picture transparency lives ON the blip in OOXML (alphaModFix in
    // 1000ths of a percent), not on the shape — #88 reached the same place
    // through PptxGenJS's `transparency` option.
    blipKids.push(x('a:alphaModFix', { amt: Math.round(el.opacity * 100000) }))
  }
  if (opts.blipKids) blipKids.push(...opts.blipKids)
  return x('p:pic', undefined, [
    x('p:nvPicPr', undefined, [
      x('p:cNvPr', { id: opts.shapeId, name: opts.name }),
      x('p:cNvPicPr', undefined, [x('a:picLocks', { noChangeAspect: 1 })]),
      x('p:nvPr'),
    ]),
    x('p:blipFill', undefined, [
      x('a:blip', { [opts.link ? 'r:link' : 'r:embed']: relId }, blipKids),
      // Always stretch-to-frame: see the fit note in imagePic.
      x('a:stretch', undefined, [x('a:fillRect')]),
    ]),
    x('p:spPr', undefined, [xfrm(el), picGeom(el, radius)]),
  ])
}

const bentoName = (el: { id: string; morphId?: string }): string => `bento:${el.morphId || el.id}`

/**
 * One image element → a p:pic (registering its media part and rel), or null
 * with a report entry when nothing usable can be emitted.
 *
 * FIT. OOXML's blipFill stretch fills the frame exactly — that IS bento's
 * 'fill'. 'cover' and 'contain' need the intrinsic pixel size of the image to
 * compute a srcRect crop or an inset frame, and this engine cannot decode
 * image dimensions (no DOM, no codecs — a deliberate boundary). So both emit
 * stretch and report 'image-fit-approximated': the picture is present at the
 * right place and size, possibly at the wrong aspect. #88 shipped the same
 * stretch mapping SILENTLY; the report entry is the difference between an
 * approximation and a lie.
 */
export function imagePic(el: ImageIn, shapeId: number, where: string, ctx: MediaCtx): XNode | null {
  const src = resolveSrc(ctx.assets, el.src)
  if (!src) {
    ctx.report.add('dropped', 'missing-image', where, 'image source is empty or its asset reference is dangling')
    return null
  }

  if (el.fit !== 'fill') {
    ctx.report.add('approximated', 'image-fit-approximated', where,
      `fit '${el.fit}' needs the image's intrinsic size to crop/inset; exported as stretch (right frame, aspect may differ)`)
  }

  if (src.startsWith('data:')) {
    const decoded = decodeDataUri(src)
    const partName = decoded && ctx.store.add(decoded.bytes, decoded.mime)
    if (!partName) {
      ctx.report.add('dropped', 'missing-image', where,
        decoded
          ? `image format '${decoded.mime}' has no PowerPoint-safe extension; dropped`
          : 'image data: URI is malformed; dropped')
      return null
    }
    const relId = ctx.nextRelId()
    ctx.rels.push({ id: relId, type: REL.image, target: relTarget(partName) })
    return pic(el, relId, el.radius, { shapeId, name: bentoName(el) })
  }

  // External URL: a LINKED picture (r:link + TargetMode=External). PowerPoint
  // fetches it at open — the only bytes-free option an IO-less engine has,
  // and an honest one: the deck referenced the network before export too.
  const relId = ctx.nextRelId()
  ctx.rels.push({ id: relId, type: REL.image, target: src, external: true })
  ctx.report.add('approximated', 'image-linked-not-embedded', where,
    'external image URL kept as a linked picture; PowerPoint loads it at open (blank when offline)')
  return pic(el, relId, el.radius, { shapeId, name: bentoName(el), link: true })
}

// The registered extension-list URI for svgBlip — a fixed GUID from MS-ODRAWXML,
// not something we mint. PowerPoint keys the feature off this exact string.
const SVG_EXT_URI = '{96DAC541-7B7A-43D3-8B79-37D633B846F1}'
const NS_ASVG = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main'

/**
 * One svg element → a p:pic whose blip carries asvg:svgBlip.
 *
 * The svgBlip extension expects r:embed to point at a RASTER fallback with the
 * vector riding in extLst; the engine cannot rasterize (same no-codec boundary
 * as image fits), so r:embed points at the svg part itself and the report says
 * so: modern PowerPoint (2019+/365) reads the svgBlip and renders the vector,
 * PowerPoint 2016 falls back to r:embed, cannot decode svg, and shows a blank
 * frame. 'svg-no-raster-fallback' carries that detail — the user learns which
 * audience sees what, instead of discovering it in a meeting.
 *
 * The css-injection point (splice a <style> into the root tag) is #88's
 * svg.ts approach verbatim; without it, hover/animation styling that slides
 * keeps in el.css would silently vanish from the exported artwork.
 */
export function svgPic(el: SvgIn, shapeId: number, where: string, ctx: MediaCtx): XNode | null {
  let markup = (el.asset ? ctx.assets[el.asset] : el.markup) ?? ''
  if (!markup.trim()) {
    ctx.report.add('dropped', 'missing-svg', where, 'svg element has no markup (empty or dangling asset reference)')
    return null
  }
  if (el.css) markup = markup.replace(/<svg([^>]*)>/i, `<svg$1><style>${el.css}</style>`)
  // Standalone svg FILES need the namespace declared; inline markup in a deck
  // often omits it (the HTML parser never cared). #88 fixed this through the
  // DOM (setAttribute + XMLSerializer); textually here.
  if (!/<svg[^>]*\sxmlns=/i.test(markup)) {
    markup = markup.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  }

  const partName = ctx.store.add(new TextEncoder().encode(markup), 'image/svg+xml')
  if (!partName) return null // unreachable: svg is always in EXT_BY_MIME
  const relId = ctx.nextRelId()
  ctx.rels.push({ id: relId, type: REL.image, target: relTarget(partName) })
  ctx.report.add('approximated', 'svg-no-raster-fallback', where,
    'svg embedded without a raster fallback: PowerPoint 2019+/365 renders it, PowerPoint 2016 shows a blank frame')

  const svgBlip = x('a:extLst', undefined, [
    x('a:ext', { uri: SVG_EXT_URI }, [
      // asvg is not in the slide root's xmlns trio; PowerPoint itself declares
      // it inline on the svgBlip element, so we match that shape exactly.
      x('asvg:svgBlip', { 'xmlns:asvg': NS_ASVG, 'r:embed': relId }),
    ]),
  ])
  return pic(el, relId, undefined, { shapeId, name: bentoName(el), blipKids: [svgBlip] })
}

/**
 * One media (video/audio) element. M-export-0 does not emit playable media —
 * a real p:pic+videoFile part pair needs the poster embedded as the pic AND
 * the clip bytes, and clips are routinely URLs or 8 MB embeds — so every
 * media element is reported 'media-dropped', and when a video carries a
 * decodable poster, that still is exported in its place (the slide keeps its
 * visual weight; #88's data-URI branch did the same poster fallback). Returns
 * the poster p:pic or null.
 */
export function mediaPoster(el: MediaIn, shapeId: number, where: string, ctx: MediaCtx): XNode | null {
  ctx.report.add('dropped', 'media-dropped', where,
    `${el.kind} not exported (M-export-0 has no playable-media pipeline)` +
      (el.poster ? '; its poster image stands in on the slide' : ''))
  const poster = el.poster ? resolveSrc(ctx.assets, el.poster) : ''
  if (!poster) return null
  if (poster.startsWith('data:')) {
    const decoded = decodeDataUri(poster)
    const partName = decoded && ctx.store.add(decoded.bytes, decoded.mime)
    if (!partName) return null // the media-dropped entry above already covers it
    const relId = ctx.nextRelId()
    ctx.rels.push({ id: relId, type: REL.image, target: relTarget(partName) })
    return pic(el, relId, el.radius, { shapeId, name: bentoName(el) })
  }
  const relId = ctx.nextRelId()
  ctx.rels.push({ id: relId, type: REL.image, target: poster, external: true })
  return pic(el, relId, el.radius, { shapeId, name: bentoName(el), link: true })
}
