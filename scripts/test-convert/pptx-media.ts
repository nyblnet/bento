#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// pptx-write media rig: data-URI decoding, the deduplicating media store, and
// p:pic assembly for images / svg / media posters.
//
//   node scripts/test-convert/pptx-media.ts     (Node ≥ 23.6 strips types natively)
//
// Same discipline as pptx-parts.ts: every emitted structure is re-read with
// the convert engine's own PARSER (written for other people's files, with its
// own strict grammar), and the NEGATIVE controls have each been observed
// failing — a decoder that never returns null and a reporter that fires on
// every fit are both indistinguishable from correct output until PowerPoint
// meets them.

import { parseXml, kids, kid, attr, textOf, NS, type XElem } from '../../kernel/src/convert/xml.ts'
import { serialize, x } from '../../kernel/src/convert/xmlout.ts'
import { PML_XMLNS, REL, type RelEntry } from '../../kernel/src/convert/pptx-write/parts.ts'
import {
  decodeBase64, decodeDataUri, MediaStore,
  imagePic, svgPic, mediaPoster,
  type ImageIn, type SvgIn, type MediaIn, type MediaCtx,
} from '../../kernel/src/convert/pptx-write/media.ts'
import { Report } from '../../kernel/src/convert/report.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const bytesEq = (a: Uint8Array | null, b: number[]): boolean =>
  !!a && a.length === b.length && b.every((v, i) => a[i] === v)

// A fresh ctx per scenario: report/rels/store state is what the checks read.
function makeCtx(assets: Record<string, string> = {}): MediaCtx & { relN: () => number } {
  const rels: RelEntry[] = []
  const report = new Report()
  let n = 0
  return {
    assets, store: new MediaStore(), rels, report,
    nextRelId: () => `rId${++n}`,
    relN: () => n,
  }
}

// Serialized pics carry p:/a:/r: prefixes that only resolve under a root
// declaring the trio — exactly the situation inside a real slide part.
function parsePic(node: ReturnType<typeof x>): XElem {
  const root = parseXml(serialize(x('p:sld', PML_XMLNS, [node])))
  const pic = kid(root, NS.p, 'pic')
  if (!pic) throw new Error('no p:pic under wrapper root')
  return pic
}

const findEntry = (report: Report, code: string) => report.build().entries.find((e) => e.code === code)

const baseFrame = { x: 10, y: 20, w: 320, h: 240, rotation: 0, opacity: 1 }

// --- data-URI decoding -------------------------------------------------------
console.log('data: URI decoding')

// Known-vector round-trips (RFC 4648 test vectors, computed independently).
ok(bytesEq(decodeBase64('TWFu'), [77, 97, 110]), 'base64 "TWFu" → "Man" bytes')
ok(bytesEq(decodeBase64('TWE='), [77, 97]), 'base64 one-pad "TWE=" → 2 bytes')
ok(bytesEq(decodeBase64('TQ=='), [77]), 'base64 two-pad "TQ==" → 1 byte')
ok(bytesEq(decodeBase64('TQ'), [77]), 'missing padding tolerated (editors strip it)')
ok(bytesEq(decodeBase64('TW\n Fu\t'), [77, 97, 110]), 'whitespace inside base64 skipped (wrapped data URIs)')
ok(bytesEq(decodeBase64('_w=='), [255]), 'URL-safe alphabet accepted')

{
  const d = decodeDataUri('data:image/png;base64,AAECAwQF')
  ok(!!d && d.mime === 'image/png' && bytesEq(d.bytes, [0, 1, 2, 3, 4, 5]), 'data: URI decodes mime + bytes')
}
{
  const d = decodeDataUri('data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E')
  ok(!!d && d.mime === 'image/svg+xml' && new TextDecoder().decode(d!.bytes) === '<svg></svg>',
    'percent-encoded (non-base64) data: URI decodes')
}
// NEGATIVE controls — each seen FAIL by feeding the good path the bad input.
ok(decodeBase64('TW@u') === null, 'NEGATIVE: base64 with an illegal character returns null')
ok(decodeDataUri('data:image/png;base64,@@@@') === null, 'NEGATIVE: data: URI with corrupt base64 returns null')
ok(decodeDataUri('https://example.com/a.png') === null, 'NEGATIVE: a plain URL is not a data: URI')
ok(decodeDataUri('data:image/png;base64') === null, 'NEGATIVE: data: URI without a comma returns null')

// --- MediaStore dedup --------------------------------------------------------
console.log('MediaStore')

{
  const store = new MediaStore()
  const a = new Uint8Array([1, 2, 3])
  const n1 = store.add(a, 'image/png')
  const n2 = store.add(new Uint8Array([1, 2, 3]), 'image/png')
  const n3 = store.add(new Uint8Array([9, 9, 9]), 'image/jpeg')
  ok(n1 === 'ppt/media/image1.png', 'first part named ppt/media/image1.png')
  ok(n2 === n1, 'identical bytes dedupe to the same part')
  ok(n3 === 'ppt/media/image2.jpeg', 'distinct bytes get the next number, ext from mime')
  ok(store.files().length === 2, 'store holds 2 files after 3 adds')
  // Same length + plausible-collision shape must still separate on content.
  const n4 = store.add(new Uint8Array([3, 2, 1]), 'image/png')
  ok(n4 !== n1 && store.files().length === 3, 'same-length different bytes are NOT deduped')
  ok(store.add(new Uint8Array([1]), 'image/webp') === null, 'NEGATIVE: unsupported mime (webp) is refused')
}

// --- imagePic ----------------------------------------------------------------
console.log('imagePic')

{
  const ctx = makeCtx()
  const el: ImageIn = {
    id: 'img-1', morphId: 'hero', type: 'image', ...baseFrame, rotation: 45, opacity: 0.5,
    src: 'data:image/png;base64,AAECAwQF', fit: 'fill', radius: 12,
  }
  const node = imagePic(el, 7, 'slide 1', ctx)
  ok(!!node, 'embedded image produces a node')
  const pic = parsePic(node!)
  const cNvPr = kid(kid(pic, NS.p, 'nvPicPr')!, NS.p, 'cNvPr')!
  ok(attr(cNvPr, 'id') === '7' && attr(cNvPr, 'name') === 'bento:hero',
    'cNvPr carries the given shape id and bento:<morphId> name (#88 objectName)')
  const blip = kid(kid(pic, NS.p, 'blipFill')!, NS.a, 'blip')!
  ok(attr(blip, 'r:embed') === 'rId1', 'blip r:embed = allocated rel id')
  ok(ctx.rels.length === 1 && ctx.rels[0].type === REL.image && ctx.rels[0].target === '../media/image1.png'
    && !ctx.rels[0].external, 'rel entry: image type, ../media target, internal')
  const amf = kid(blip, NS.a, 'alphaModFix')
  ok(!!amf && attr(amf!, 'amt') === '50000', 'opacity 0.5 → alphaModFix amt=50000 (1000ths of a percent)')
  ok(!!kid(kid(pic, NS.p, 'blipFill')!, NS.a, 'stretch'), 'blipFill carries a:stretch')
  const xf = kid(kid(pic, NS.p, 'spPr')!, NS.a, 'xfrm')!
  ok(attr(xf, 'rot') === String(45 * 60000), 'rotation in 60000ths of a degree')
  const off = kid(xf, NS.a, 'off')!
  const ext = kid(xf, NS.a, 'ext')!
  ok(attr(off, 'x') === String(10 * 9525) && attr(off, 'y') === String(20 * 9525), 'a:off in EMU (px * 9525)')
  ok(attr(ext, 'cx') === String(320 * 9525) && attr(ext, 'cy') === String(240 * 9525), 'a:ext in EMU')
  const geom = kid(kid(pic, NS.p, 'spPr')!, NS.a, 'prstGeom')!
  ok(attr(geom, 'prst') === 'roundRect', 'radius → prstGeom roundRect')
  const gd = kid(kid(geom, NS.a, 'avLst')!, NS.a, 'gd')!
  // 12px of min(320,240)=240 → 5% → 5000 in 1000ths of a percent
  ok(attr(gd, 'fmla') === 'val 5000', 'roundRect adj = radius/shorter-side in 1000ths of a percent')
  ok(findEntry(ctx.report, 'image-fit-approximated') === undefined,
    "NEGATIVE: fit 'fill' (= OOXML stretch exactly) reports NO fit approximation")
}

{
  const ctx = makeCtx()
  const el: ImageIn = {
    id: 'img-2', type: 'image', ...baseFrame,
    src: 'data:image/png;base64,AAECAwQF', fit: 'cover',
  }
  const node = imagePic(el, 2, 'slide 2', ctx)
  const e = findEntry(ctx.report, 'image-fit-approximated')
  ok(!!node && !!e && e!.verdict === 'approximated', "fit 'cover' reports image-fit-approximated (was silent in #88)")
  const geom = kid(kid(parsePic(node!), NS.p, 'spPr')!, NS.a, 'prstGeom')!
  ok(attr(geom, 'prst') === 'rect', 'no radius → prstGeom rect')
  const blip = kid(kid(parsePic(node!), NS.p, 'blipFill')!, NS.a, 'blip')!
  ok(kid(blip, NS.a, 'alphaModFix') === undefined, 'NEGATIVE: full opacity emits no alphaModFix')
}

{
  // Cross-slide dedup: two slides, one logo → one part, one rel EACH.
  const ctx = makeCtx()
  const logo = (id: string): ImageIn =>
    ({ id, type: 'image', ...baseFrame, src: 'data:image/png;base64,AAECAwQF', fit: 'fill' })
  imagePic(logo('a'), 2, 'slide 1', ctx)
  imagePic(logo('b'), 3, 'slide 2', ctx)
  ok(ctx.store.files().length === 1, 'identical image on two slides → ONE media part')
  ok(ctx.rels.length === 2 && ctx.rels[0].target === ctx.rels[1].target, 'both rels point at the shared part')
}

{
  // asset: resolution + the two drop paths.
  const ctx = makeCtx({ pic: 'data:image/gif;base64,AAECAwQF' })
  ok(imagePic({ id: 'a', type: 'image', ...baseFrame, src: 'asset:pic', fit: 'fill' }, 2, 's1', ctx) !== null
    && ctx.store.files()[0].name.endsWith('.gif'), 'asset:<key> resolves through ctx.assets (ext from its mime)')
  ok(imagePic({ id: 'b', type: 'image', ...baseFrame, src: 'asset:gone', fit: 'fill' }, 3, 's1', ctx) === null
    && !!findEntry(ctx.report, 'missing-image'), 'NEGATIVE: dangling asset ref → null + missing-image dropped')
  const before = ctx.store.files().length
  ok(imagePic({ id: 'c', type: 'image', ...baseFrame, src: 'data:image/webp;base64,AAECAwQF', fit: 'fill' }, 4, 's1', ctx) === null
    && ctx.store.files().length === before, 'NEGATIVE: unsupported mime → null, nothing registered')
}

{
  // External URL → linked picture.
  const ctx = makeCtx()
  const node = imagePic({ id: 'u', type: 'image', ...baseFrame, src: 'https://example.com/a.png', fit: 'fill' }, 2, 's1', ctx)
  const blip = kid(kid(parsePic(node!), NS.p, 'blipFill')!, NS.a, 'blip')!
  ok(attr(blip, 'r:link') === 'rId1' && attr(blip, 'r:embed') === undefined, 'URL image uses r:link, not r:embed')
  ok(ctx.rels[0].external === true && ctx.rels[0].target === 'https://example.com/a.png',
    'its rel is TargetMode=External at the raw URL')
  ok(!!findEntry(ctx.report, 'image-linked-not-embedded'), 'linked image is reported approximated')
}

// --- svgPic ------------------------------------------------------------------
console.log('svgPic')

{
  const ctx = makeCtx({ art: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' })
  const el: SvgIn = { id: 'svg-1', ...baseFrame, asset: 'art', css: '.a{fill:red}' }
  const node = svgPic(el, 4, 'slide 3', ctx)
  ok(!!node, 'svg element produces a node')
  const pic = parsePic(node!)
  const blip = kid(kid(pic, NS.p, 'blipFill')!, NS.a, 'blip')!
  ok(attr(blip, 'r:embed') === 'rId1', 'svg blip r:embed points at the svg part (no raster to point at)')
  const extLst = kid(blip, NS.a, 'extLst')!
  const ext = kid(extLst, NS.a, 'ext')!
  ok(attr(ext, 'uri') === '{96DAC541-7B7A-43D3-8B79-37D633B846F1}', 'extLst ext uri is the registered svgBlip GUID')
  const svgBlip = kids(ext).find((k) => k.local === 'svgBlip')
  ok(!!svgBlip && svgBlip!.ns === NS.asvg, 'asvg:svgBlip resolves to the 2016/SVG namespace through the parser')
  ok(!!svgBlip && attr(svgBlip!, 'r:embed') === 'rId1', 'svgBlip r:embed matches the blip rel')
  ok(ctx.rels[0].target === '../media/image1.svg', 'svg part registered as ../media/image1.svg')
  const entry = findEntry(ctx.report, 'svg-no-raster-fallback')
  ok(!!entry && entry!.verdict === 'approximated' && entry!.detail.includes('2016'),
    'svg-no-raster-fallback reported, detail names the PowerPoint 2016 blank-frame case')
  const markup = new TextDecoder().decode(ctx.store.files()[0].bytes)
  ok(markup.includes('<style>.a{fill:red}</style>'), 'el.css injected into the embedded markup (#88 svg.ts)')
  ok(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(markup), 'missing xmlns injected on the root tag')
  // And the bytes we embedded are themselves well-formed XML.
  ok(parseXml(markup).local === 'svg', 'embedded svg bytes re-parse as XML')
}

{
  const ctx = makeCtx({ art: '<svg xmlns="http://www.w3.org/2000/svg"/>' })
  svgPic({ id: 's', ...baseFrame, asset: 'art' }, 2, 's1', ctx)
  const markup = new TextDecoder().decode(ctx.store.files()[0].bytes)
  ok((markup.match(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g) ?? []).length === 1,
    'NEGATIVE: an already-declared xmlns is not doubled')
  const ctx2 = makeCtx()
  ok(svgPic({ id: 'e', ...baseFrame, markup: '   ' }, 2, 's1', ctx2) === null
    && !!findEntry(ctx2.report, 'missing-svg'), 'NEGATIVE: blank markup → null + missing-svg dropped')
}

// --- mediaPoster -------------------------------------------------------------
console.log('mediaPoster')

{
  const ctx = makeCtx()
  const el: MediaIn = {
    id: 'vid-1', ...baseFrame, kind: 'video',
    src: 'data:video/mp4;base64,AAAA', poster: 'data:image/jpeg;base64,AAECAwQF', radius: 8,
  }
  const node = mediaPoster(el, 5, 'slide 4', ctx)
  ok(!!node, 'video with a poster emits the poster p:pic')
  const entry = findEntry(ctx.report, 'media-dropped')
  ok(!!entry && entry!.verdict === 'dropped' && entry!.detail.includes('poster'),
    'media-dropped reported; detail says the poster stands in')
  ok(ctx.rels[0].type === REL.image && ctx.rels[0].target === '../media/image1.jpeg',
    'poster registered as an image part (video bytes never touch the package)')
  const geom = kid(kid(parsePic(node!), NS.p, 'spPr')!, NS.a, 'prstGeom')!
  ok(attr(geom, 'prst') === 'roundRect', 'video radius carries onto the poster pic')
}

{
  const ctx = makeCtx()
  const node = mediaPoster({ id: 'au-1', ...baseFrame, kind: 'audio', src: 'data:audio/mp3;base64,AAAA' }, 2, 's1', ctx)
  ok(node === null && ctx.store.files().length === 0, 'audio (no poster) emits nothing')
  const entry = findEntry(ctx.report, 'media-dropped')
  ok(!!entry && !entry!.detail.includes('poster'), 'NEGATIVE: media-dropped detail omits poster when there is none')
}

{
  // textOf sanity on our own output — the whole pic tree contains no stray text.
  const ctx = makeCtx()
  const node = imagePic({ id: 'q', type: 'image', ...baseFrame, src: 'data:image/png;base64,AAECAwQF', fit: 'fill' }, 2, 's1', ctx)
  ok(textOf(parsePic(node!)).trim() === '', 'p:pic tree is element-only (no accidental text nodes)')
}

console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) process.exit(1)
