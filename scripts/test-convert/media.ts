#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/convert media rig — rels resolution, the asset store, p:pic → OutImage.
//
//   node scripts/test-convert/media.ts        (Node ≥ 23.6 strips types natively)
//
// Expected values are computed BY HAND (the '../' resolution, the base64
// vectors, the mime table) or by an implementation that is not ours
// (node:buffer for base64), never by round-tripping our own code. Each trap
// from the spike carries a NEGATIVE control — an input a naive converter gets
// wrong — verified to fail against deliberately broken variants of this module
// while it was written:
//
//   • blip-as-bitmap: an svgBlip picture whose emitted asset must be the SVG
//     bytes and must NOT contain the raster bytes.
//   • base-blind rels: 'media/x.png' from 'ppt/slides/' must land in
//     ppt/slides/media/, not ppt/media/.
//   • dedup by name instead of content: same bytes under two part names = one
//     key; different bytes of the SAME length = two keys.
//   • fetch-the-External-target: an External image rel must come back
//     undefined with the right code, not as a missing-part fetch attempt.

import { Buffer } from 'node:buffer'
import { parseXml } from '../../kernel/src/convert/xml.ts'
import { Report } from '../../kernel/src/convert/report.ts'
import type { InheritCtx } from '../../kernel/src/convert/types.ts'
import {
  parseRels, parseContentTypes, mimeFor, toBase64, AssetStore, imageFrom, _internals,
} from '../../kernel/src/convert/media.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const enc = new TextEncoder()

// ------------------------------------------------------------------ .rels
{
  const rels = parseRels(parseXml(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://x/image" Target="../media/image1.png"/>' +
    '<Relationship Id="rId2" Type="http://x/image" Target="media/local.png"/>' +
    '<Relationship Id="rId3" Type="http://x/image" Target="/ppt/media/abs.png"/>' +
    '<Relationship Id="rId4" Type="http://x/hyperlink" Target="https://example.com/a" TargetMode="External"/>' +
    '<Relationship Id="rId5" Type="http://x/image" Target="../media/image%202.png"/>' +
    '<Relationship Id="rId6" Type="http://x/image" Target="../../docProps/../ppt/media/up.png"/>' +
    '</Relationships>'), 'ppt/slides/')

  ok(rels.get('rId1')!.target === 'ppt/media/image1.png', "'../media/x' from ppt/slides/ resolves to ppt/media/")
  // NEGATIVE (base-blind resolver): no '..' means the target stays UNDER the base.
  ok(rels.get('rId2')!.target === 'ppt/slides/media/local.png',
    "'media/x' (no ../) stays under ppt/slides/ — a resolver ignoring the base would say ppt/media/")
  ok(rels.get('rId3')!.target === 'ppt/media/abs.png', 'a pack-absolute /ppt/… target ignores the base dir')
  ok(rels.get('rId4')!.mode === 'External' && rels.get('rId4')!.target === 'https://example.com/a',
    'an External target keeps its URI verbatim, flagged by mode')
  ok(rels.get('rId5')!.target === 'ppt/media/image 2.png', "'%20' in the target is a literal space in the part name")
  ok(rels.get('rId6')!.target === 'ppt/media/up.png', "a '../../…/../' chain normalizes step by step")
  ok(_internals.resolveTarget('ppt/slides/', '../../../../x.png') === 'x.png', "'..' clamps at the package root")
}

// ---------------------------------------------------------- content types
const ctXml = parseXml(
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="png" ContentType="image/x-census-png"/>' +
  '<Default Extension="svg" ContentType="image/svg+xml"/>' +
  '<Override PartName="/ppt/media/special.bin" ContentType="image/gif"/>' +
  '</Types>')
{
  const types = parseContentTypes(ctXml)
  // The package's declaration is the source of truth even when it contradicts
  // the well-known extension mapping.
  ok(mimeFor('ppt/media/a.png', types) === 'image/x-census-png',
    'a [Content_Types].xml Default overrides the built-in extension table')
  ok(mimeFor('ppt/media/special.bin', types) === 'image/gif', 'an Override wins by part name')
  ok(mimeFor('ppt/media/a.png') === 'image/png', 'without content types the built-in table answers')
  ok(mimeFor('ppt/media/a.PNG') === 'image/png', 'extension matching is case-insensitive')
  ok(mimeFor('ppt/media/mystery.zzz') === 'application/octet-stream', 'an unknown extension degrades to octet-stream')
}

// ------------------------------------------------------------------ base64
{
  // Known vectors, computed by hand from RFC 4648: every padding length.
  ok(toBase64(enc.encode('Man')) === 'TWFu', "base64 of 'Man' is TWFu")
  ok(toBase64(enc.encode('Ma')) === 'TWE=', 'two bytes pad with one =')
  ok(toBase64(enc.encode('M')) === 'TQ==', 'one byte pads with two ==')
  ok(toBase64(new Uint8Array(0)) === '', 'zero bytes encode to the empty string')

  // All 256 byte values plus awkward lengths, against node:buffer — an
  // implementation that is not ours.
  for (const len of [1, 2, 3, 255, 256, 257, 0x8000 - 1, 0x8000, 0x8000 + 1]) {
    const b = new Uint8Array(len)
    for (let i = 0; i < len; i++) b[i] = (i * 7 + 13) & 0xff
    const want = Buffer.from(b).toString('base64')
    if (toBase64(b) !== want || _internals.b64Manual(b) !== want) {
      ok(false, `base64 of ${len} bytes matches node:buffer (both paths)`)
    } else ok(true, `base64 of ${len} bytes matches node:buffer (both paths)`)
  }
}

// -------------------------------------------------------------- asset store
{
  const logo = enc.encode('PNGBYTES-logo')
  const logoCopy = enc.encode('PNGBYTES-logo') // same content, its own buffer
  const other = enc.encode('PNGBYTES-lXgo')     // SAME length, different bytes
  const parts = new Map<string, Uint8Array>([
    ['ppt/media/image1.png', logo],
    ['ppt/media/image2.png', logoCopy],
    ['ppt/media/image3.png', other],
  ])
  const store = new AssetStore(parts, parseContentTypes(ctXml))
  const k1 = store.register('ppt/media/image1.png')!
  const k2 = store.register('ppt/media/image2.png')!
  const k3 = store.register('ppt/media/image3.png')!
  ok(k1 === k2, 'identical bytes under two part names dedup to ONE key')
  // NEGATIVE (dedup-by-name-or-length): same length, different content.
  ok(k1 !== k3, 'same-length different bytes get different keys')
  ok(k1.startsWith('m'), "keys carry the 'm' prefix")
  ok(store.register('ppt/media/image1.png') === k1, 'a re-registration is stable')
  ok(store.register('ppt/media/nope.png') === undefined, 'a missing part returns undefined, never throws')

  const assets = store.assets()
  ok(Object.keys(assets).length === 2, 'the assets record holds exactly the two distinct contents')
  ok(assets[k1] === `data:image/x-census-png;base64,${Buffer.from(logo).toString('base64')}`,
    'the data URI carries the content-types mime and the exact bytes')

  // key determinism across store instances (a re-import must re-emit the same keys)
  const again = new AssetStore(parts).register('ppt/media/image1.png')
  ok(again === k1, 'the key is a pure function of the bytes — stable across stores')

  // fnv collision safety net: force two contents into one bucket by hand
  ok(_internals.fnvKey(logo) !== _internals.fnvKey(other), 'the 64-bit hash separates these contents')
  ok(_internals.bytesEq(logo, logoCopy) && !_internals.bytesEq(logo, other), 'bytesEq compares content, not identity')
}

// ------------------------------------------------------------ p:pic → image
// One picture XML builder so each case varies exactly one thing.
const NSDECL =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main"'

function pic(opts: { embed?: string; svg?: string; srcRect?: string; tile?: boolean; link?: string }): ReturnType<typeof parseXml> {
  const blipInner = opts.svg
    ? `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip r:embed="${opts.svg}"/></a:ext></a:extLst>`
    : ''
  const blipAttr = opts.embed ? ` r:embed="${opts.embed}"` : opts.link ? ` r:link="${opts.link}"` : ''
  return parseXml(
    `<p:pic ${NSDECL}>` +
    '<p:nvPicPr><p:cNvPr id="7" name="Picture 7"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
    `<p:blipFill><a:blip${blipAttr}>${blipInner}</a:blip>` +
    (opts.srcRect ?? '') +
    (opts.tile ? '<a:tile/>' : '<a:stretch><a:fillRect/></a:stretch>') +
    '</p:blipFill>' +
    '<p:spPr><a:xfrm rot="2700000"><a:off x="914400" y="457200"/><a:ext cx="1828800" cy="914400"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    '</p:pic>')
}

const rasterBytes = enc.encode('RASTER-PREVIEW-BYTES')
const svgBytes = enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><clipPath id="a"/></svg>')
const picParts = new Map<string, Uint8Array>([
  ['ppt/media/image1.png', rasterBytes],
  ['ppt/media/icon1.svg', svgBytes],
])
const picRels = parseRels(parseXml(
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://x/image" Target="../media/image1.png"/>' +
  '<Relationship Id="rId2" Type="http://x/image" Target="../media/icon1.svg"/>' +
  '<Relationship Id="rId3" Type="http://x/image" Target="../media/gone.svg"/>' +
  '<Relationship Id="rId4" Type="http://x/image" Target="file:///C:/pics/x.png" TargetMode="External"/>' +
  '<Relationship Id="rId5" Type="http://x/image" Target="../media/hdphoto1.wdp"/>' +
  '</Relationships>'), 'ppt/slides/')

function ctxAnd(): { ctx: InheritCtx; report: Report } {
  const report = new Report()
  // imageFrom touches only .report; the chain members are the other modules' business
  const ctx = { slide: parseXml('<sld/>'), theme: undefined, report } as unknown as InheritCtx
  return { ctx, report }
}
const codes = (r: Report) => r.build().entries.map((e) => `${e.verdict}:${e.code}`).join(' ')

// the plain raster picture — the boring common case must stay clean
{
  const { ctx, report } = ctxAnd()
  const store = new AssetStore(picParts)
  const el = imageFrom(pic({ embed: 'rId1' }), ctx, picRels, store, 'slide 1')!
  ok(el !== undefined && el.type === 'image', 'a plain raster pic converts')
  ok(el.src === `asset:${store.register('ppt/media/image1.png')!}`, 'its src references the registered asset')
  ok(el.fit === 'fill', 'a:stretch maps to fill')
  // hand-computed: 914400/9525 = 96, 457200/9525 = 48, 1828800/9525 = 192, rot 2700000/60000 = 45
  ok(el.x === 96 && el.y === 48 && el.w === 192 && el.h === 96, 'EMU frame lands at 96,48 192×96')
  ok(el.rotation === 45 && el.id === 'pic7' && el.opacity === 1, 'rotation 45°, id from cNvPr')
  ok(report.build().entries.length === 0, 'and nothing is reported — this case is fully carried')
}

// THE SVG RULE: vector part preferred, raster preview ignored
{
  const { ctx, report } = ctxAnd()
  const store = new AssetStore(picParts)
  const el = imageFrom(pic({ embed: 'rId1', svg: 'rId2' }), ctx, picRels, store, 'slide 1')!
  const uri = store.assets()[el.src.slice('asset:'.length)]!
  ok(uri.startsWith('data:image/svg+xml;base64,'), 'an svgBlip pic emits the SVG bytes as a data:image/svg+xml asset')
  // NEGATIVE (blip-as-bitmap): a naive converter reads r:embed and emits the raster.
  ok(uri !== `data:image/png;base64,${Buffer.from(rasterBytes).toString('base64')}` &&
     Buffer.from(uri.split(',')[1]!, 'base64').toString() === Buffer.from(svgBytes).toString(),
    'and the asset is NOT the raster preview')
  ok(report.build().entries.length === 0, 'the preferred-svg path reports nothing')
}

// raster fallback when the svg part is missing
{
  const { ctx, report } = ctxAnd()
  const store = new AssetStore(picParts)
  const el = imageFrom(pic({ embed: 'rId1', svg: 'rId3' }), ctx, picRels, store, 'slide 1')!
  const uri = store.assets()[el.src.slice('asset:'.length)]!
  ok(uri.startsWith('data:image/png;base64,'), 'a missing SVG part falls back to the raster preview')
  ok(codes(report) === 'approximated:svg-raster-fallback', 'and says so')
}

// crop → cover, reported
{
  const { ctx, report } = ctxAnd()
  const el = imageFrom(pic({ embed: 'rId1', srcRect: '<a:srcRect l="10000" r="25000"/>' }),
    ctx, picRels, new AssetStore(picParts), 'slide 2')!
  ok(el.fit === 'cover', 'a srcRect crop maps to cover')
  ok(codes(report) === 'approximated:image-crop-dropped', 'and is reported as approximated')
}

// an all-zero srcRect is not a crop
{
  const { ctx, report } = ctxAnd()
  const el = imageFrom(pic({ embed: 'rId1', srcRect: '<a:srcRect l="0" t="0"/>' }),
    ctx, picRels, new AssetStore(picParts), 'slide 2')!
  ok(el.fit === 'fill' && report.build().entries.length === 0,
    'an all-zero srcRect stays fill and unreported')
}

// tile → fill, reported
{
  const { ctx, report } = ctxAnd()
  const el = imageFrom(pic({ embed: 'rId1', tile: true }), ctx, picRels, new AssetStore(picParts), 'slide 3')!
  ok(el.fit === 'fill', 'a:tile maps to fill')
  ok(codes(report) === 'approximated:image-tile-dropped', 'and is reported')
}

// NEGATIVE (fetch-the-External): a linked picture is dropped by name, never fetched
{
  const { ctx, report } = ctxAnd()
  const el = imageFrom(pic({ link: 'rId4' }), ctx, picRels, new AssetStore(picParts), 'slide 4')
  ok(el === undefined, 'an External (linked) picture converts to nothing')
  ok(codes(report) === 'dropped:image-external-dropped',
    'with the external code — not missing-part, which would mean we tried to fetch it from the package')
}

// .wdp → dropped with the fallback hint
{
  const { ctx, report } = ctxAnd()
  const el = imageFrom(pic({ embed: 'rId5' }), ctx, picRels, new AssetStore(picParts), 'slide 5')
  ok(el === undefined && codes(report) === 'dropped:wdp-fallback',
    'a JPEG XR picture is dropped with the wdp-fallback code (caller takes mc:Fallback)')
}

// dangling rel and missing part are distinct findings
{
  const { ctx, report } = ctxAnd()
  ok(imageFrom(pic({ embed: 'rId99' }), ctx, picRels, new AssetStore(picParts), 'slide 6') === undefined &&
    codes(report) === 'dropped:image-missing-rel', 'a dangling r:embed is image-missing-rel')
}
{
  const { ctx, report } = ctxAnd()
  const rels = parseRels(parseXml(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://x/image" Target="../media/vanished.png"/></Relationships>'), 'ppt/slides/')
  ok(imageFrom(pic({ embed: 'rId1' }), ctx, rels, new AssetStore(picParts), 'slide 6') === undefined &&
    codes(report) === 'dropped:image-missing-part', 'a rel to a part the package lacks is image-missing-part')
}

// a blip with no reference at all
{
  const { ctx, report } = ctxAnd()
  ok(imageFrom(pic({}), ctx, picRels, new AssetStore(picParts), 'slide 7') === undefined &&
    codes(report) === 'dropped:image-missing-rel', 'a blip with neither embed nor link is reported, not thrown on')
}

// dedup across pictures: the template's reused logo costs one asset
{
  const { ctx } = ctxAnd()
  const store = new AssetStore(picParts)
  const a = imageFrom(pic({ embed: 'rId1' }), ctx, picRels, store, 'slide 1')!
  const b = imageFrom(pic({ embed: 'rId1' }), ctx, picRels, store, 'slide 2')!
  ok(a.src === b.src && Object.keys(store.assets()).length === 1,
    'two pictures of the same bytes share one asset entry')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
