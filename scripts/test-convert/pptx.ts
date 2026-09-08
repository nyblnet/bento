#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/convert end-to-end rig — whole .pptx packages through convertPptx.
//
//   node scripts/test-convert/pptx.ts       (Node ≥ 23.6 strips types natively)
//
// The packages are built in code (_fixtures.ts) and every expected value is
// hand-computed from the fixture constants — EMU arithmetic in the comments,
// colour values pinned from published/spec sources — never by running the
// converter against itself. Report CODES are asserted as EXACT sets per
// fixture: a new code appearing (or one silently ceasing to fire) fails here
// rather than in somebody's deck.
//
// Negative controls, one per trap, each seen to fail against a deliberately
// broken input or implementation while this rig was written:
//
//   • clrMap: the fixture SWAPS the map (bg1→dk2); the default-map answer
//     (#FFFFFF) is asserted absent.
//   • shade: linear-light 50% of #808080 is #5D5D5D; the sRGB-space answer
//     (#404040) is asserted absent.
//   • nested group: the single-scale answer (outer map applied to the leaf
//     directly → 120px) is asserted absent.
//   • transition: 'fade' — the model constructors' default — is asserted
//     absent on every slide.
//   • mc: the Fallback rect appears EXACTLY once; the Choice rect (which an
//     mc-blind walk would also import) is asserted absent.
//   • svg pair: exactly ONE asset, and it is the SVG bytes, not the raster.
//   • connector: the dangling end (id 99) is asserted absent while the valid
//     end on the SAME connector survives.

import { Buffer } from 'node:buffer'
import { convertPptx } from '../../kernel/src/convert/pptx.ts'
import type { ConvertResult } from '../../kernel/src/convert/types.ts'
import type { OutShape, OutText, OutImage } from '../../kernel/src/convert/types.ts'
import {
  fxMinimal, fxThemed, fxPlaceholder, fxGroup, fxBullets, fxSvg, fxConnectors, fxStructure,
  SVG_BYTES,
} from './_fixtures.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** Exact report-code set: extras and absences both fail, with a readable diff. */
function reportIs(r: ConvertResult, expected: string[], label: string) {
  const got = [...new Set(r.report.entries.map((e) => e.code))].sort()
  const want = [...new Set(expected)].sort()
  ok(got.length === want.length && got.every((c, i) => c === want[i]),
    `${label}: report codes are exactly [${want.join(', ')}] (got [${got.join(', ')}])`)
}

const byId = (r: ConvertResult, slide: number, id: string) =>
  r.doc.slides[slide].elements.find((e) => e.id === id)

// ------------------------------------------------------------------- minimal
{
  const r = await convertPptx(await fxMinimal())
  const d = r.doc
  ok(d.format === 'bento/slides' && d.version === '1.0.0', 'minimal: format/version stamped')
  // 12192000×6858000 EMU / 9525 = 1280×720 EXACTLY
  ok(d.size.width === 1280 && d.size.height === 720, 'minimal: 12192000×6858000 EMU converts to exactly 1280×720')
  ok(d.title === 'Rig Deck', 'minimal: title comes from docProps/core.xml dc:title')
  ok(d.slides.length === 1 && d.slides[0].id === 's1', 'minimal: one slide, deterministic id')
  ok(d.slides[0].transition === 'none', 'minimal: transition is explicit none')
  ok(d.slides[0].background === '#FFFFFF', 'minimal: no p:bg anywhere defaults to white')
  ok(d.fonts === null, 'minimal: fonts is null (byte embedding is a host concern)')

  const els = d.slides[0].elements
  ok(els.length === 1 && els[0].type === 'text', 'minimal: a noFill/noLn box emits its text half only')
  const t = els[0] as OutText
  ok(t.id === 's1-2', 'minimal: element id is s<slide>-<cNvPr id>')
  // off 914400,914400 ext 2743200,457200 → 96, 96, 288, 48 px
  ok(t.x === 96 && t.y === 96 && t.w === 288 && t.h === 48, 'minimal: frame 96,96,288,48 from the sp’s own xfrm')
  ok(t.fontSize === 24, 'minimal: sz="1800" = 18pt = 24px (centipoints → pt → px, both hops)')
  ok(t.color === '#28303A', 'minimal: run solidFill carried exactly')
  ok(t.fontFamily === 'Georgia, sans-serif', 'minimal: non-substituted face gets a plain stack')
  ok(t.html === 'Hello, Bento', 'minimal: text content carried verbatim')
  ok(d.theme.fontFamily === 'Calibri, Carlito, sans-serif',
    'minimal: broken-chain theme falls back to Calibri with its metric substitute')
  reportIs(r, [], 'minimal')
}

// -------------------------------------------------------------------- themed
{
  const r = await convertPptx(await fxThemed())
  const d = r.doc

  const bgRect = byId(r, 0, 's1-2') as OutShape
  // clrMap SWAPS bg1→dk2 (#28303A). The default map would give bg1→lt1 #FFFFFF.
  ok(bgRect.fill === '#28303A', 'themed: schemeClr bg1 resolves through the SWAPPED clrMap to #28303A')
  ok(bgRect.fill !== '#FFFFFF', 'themed: NEGATIVE — the default-clrMap answer (#FFFFFF) is absent')
  ok(d.slides[0].background === '#28303A', 'themed: slide background resolves through the same map')
  ok(d.theme.background === '#28303A' && d.theme.color === '#FFFFFF' && d.theme.accent === '#4472C4',
    'themed: doc.theme bakes bg1/tx1/accent1 through the map')

  const shadeRect = byId(r, 0, 's1-3') as OutShape
  // linear-light shade: ((128/255)^2.2 · 0.5)^(1/2.2) · 255 ≈ 93 → #5D5D5D
  ok(shadeRect.fill === '#5D5D5D', 'themed: shade 50% of #808080 is #5D5D5D (linear-light)')
  ok(shadeRect.fill !== '#404040', 'themed: NEGATIVE — the sRGB-space multiply (#404040) is absent')

  // the box-with-text split: shape, then text, welded by groupId
  const els = d.slides[0].elements
  ok(els.map((e) => e.id).join(',') === 's1-2,s1-3,s1-4,s1-4-t',
    'themed: document order is z-order, text half right after its shape')
  const box = byId(r, 0, 's1-4') as OutShape
  const label = byId(r, 0, 's1-4-t') as OutText
  ok(box.fill === '#4472C4', 'themed: accent1 fill on the label box')
  ok(box.groupId === 's1-4-g' && label.groupId === 's1-4-g',
    'themed: shape and text share the minted split groupId')
  ok(label.color === '#FFFFFF', 'themed: default ink is theme tx1 through the swapped map (lt1 = white)')
  ok(label.fontSize === 18.67, 'themed: sz="1400" = 14pt = 18.67px')
  ok((r.report.provenance['fill:theme'] ?? 0) >= 2,
    'themed: scheme-resolved fills are traced fill:theme')
  ok((r.report.provenance['fill:own'] ?? 0) >= 1,
    'themed: the literal srgbClr fill is traced fill:own')
  reportIs(r, [], 'themed')
}

// --------------------------------------------------------------- placeholder
{
  const r = await convertPptx(await fxPlaceholder())
  const d = r.doc
  const els = d.slides[0].elements
  ok(els.length === 1 && els[0].type === 'text', 'placeholder: the bare title box emits text only')
  const t = els[0] as OutText
  ok(t.id === 's1-5', 'placeholder: id from the slide sp, not the layout donor')
  // layout title ph: off 914400,457200 ext 1828800,914400 → 96, 48, 192, 96
  ok(t.x === 96 && t.y === 48 && t.w === 192 && t.h === 96,
    'placeholder: frame comes from the LAYOUT placeholder (slide sp has no xfrm)')
  // master titleStyle sz="4400" = 44pt = 58.666… → 58.67px
  ok(t.fontSize === 58.67, 'placeholder: size comes from the master’s titleStyle through the type hop')
  ok(t.color === '#000000', 'placeholder: default ink is theme tx1 (standard map → dk1)')
  ok(d.title === 'Quarterly Review', 'placeholder: no core.xml — the deck is titled by its first title text')
  // two resolveFrame walks reach the layout: the shape pass (which finds the
  // box invisible) and the text pass — both must land on 'layout'
  ok((r.report.provenance['frame:layout'] ?? 0) >= 1 && r.report.provenance['frame:own'] === undefined,
    'placeholder: the frame is traced to the layout level, never to own')
  ok((r.report.provenance['font-size:master'] ?? 0) >= 1, 'placeholder: the size is traced to the master level')
  reportIs(r, ['text-needs-refit', 'font-substituted'], 'placeholder')
}

// -------------------------------------------------------------------- group
{
  const r = await convertPptx(await fxGroup())
  const d = r.doc
  ok(d.size.width === 960 && d.size.height === 720, 'group: 9144000×6858000 EMU converts to exactly 960×720')
  const els = d.slides[0].elements
  ok(els.length === 1, 'group: the nested group flattens to its one leaf')
  const leaf = els[0] as OutShape
  ok(leaf.id === 's1-12', 'group: leaf keeps its own cNvPr-derived id')
  // hand-composed (see _fixtures.ts): abs EMU 2057400, 571500, 228600, 114300
  ok(leaf.x === 216 && leaf.y === 60 && leaf.w === 24 && leaf.h === 12,
    'group: leaf frame composes BOTH group maps (216, 60, 24, 12 px)')
  ok(leaf.x !== 120, 'group: NEGATIVE — the single-scale answer (120px) is absent')
  ok(leaf.groupId === 's1-g10', 'group: every leaf shares the OUTERMOST group’s id')
  ok(leaf.fill === '#FF0000', 'group: leaf fill carried')
  reportIs(r, ['nested-group-flattened'], 'group')
}

// ------------------------------------------------------------------- bullets
{
  const r = await convertPptx(await fxBullets())
  const bullets = byId(r, 0, 's1-2') as OutText
  // glyph + LITERAL NBSP prefixes; the buNone paragraph gets none
  ok(bullets.html === '• One<br>Two<br>• Three',
    'bullets: lstStyle buChar baked per line, buNone paragraph silenced')
  const nums = byId(r, 0, 's1-3') as OutText
  ok(nums.html === '3. Alpha<br>4. Beta',
    'bullets: buAutoNum honours startAt=3 and counts on (frozen numbering)')
  ok(!nums.html.startsWith('1.'), 'bullets: NEGATIVE — startAt ignored (1.) is absent')
  reportIs(r, ['bullet-flattened', 'auto-number-frozen'], 'bullets')
}

// ----------------------------------------------------------------------- svg
{
  const r = await convertPptx(await fxSvg())
  const d = r.doc
  const img = byId(r, 0, 's1-7') as OutImage
  ok(img !== undefined && img.type === 'image', 'svg: the pic emits an image element')
  ok(img.x === 96 && img.y === 96 && img.w === 96 && img.h === 96, 'svg: frame from the pic’s own xfrm')
  const keys = Object.keys(d.assets)
  ok(keys.length === 1, `svg: exactly ONE asset registered — raster preview and unused media PRUNED (got ${keys.length})`)
  const expected = `data:image/svg+xml;base64,${Buffer.from(SVG_BYTES).toString('base64')}`
  ok(d.assets[keys[0]] === expected, 'svg: the asset is the SVG bytes (node:buffer base64, not ours)')
  ok(img.src === `asset:${keys[0]}`, 'svg: the element references the registered key')
  ok(!Object.values(d.assets).some((u) => u.startsWith('data:image/png')),
    'svg: NEGATIVE — the raster compatibility preview is absent')
  reportIs(r, [], 'svg')
}

// ---------------------------------------------------------------- connectors
{
  const r = await convertPptx(await fxConnectors())
  const conn = byId(r, 0, 's1-4') as OutShape
  ok(conn.shape === 'line', 'connectors: straightConnector1 becomes a bento line')
  ok(conn.from?.el === 's1-2' && conn.to?.el === 's1-3',
    'connectors: stCxn/endCxn resolve to the deterministic element ids')
  ok(conn.lineEnd === 'arrow', 'connectors: tailEnd triangle becomes lineEnd arrow')
  ok(conn.fill === '#000000' && conn.stroke === '#000000',
    'connectors: line shapes carry the colour in BOTH fill and stroke (morphs tween stroke)')
  // box 1828800,457200 + 914400×0 → x 192, y 48; len 96, elH 2 → 192, 47, 96, 2
  ok(conn.x === 192 && conn.y === 47 && conn.w === 96 && conn.h === 2,
    'connectors: box diagonal recentred to length+height (192, 47, 96, 2)')
  const dangling = byId(r, 0, 's1-5') as OutShape
  ok(dangling.from?.el === 's1-2', 'connectors: the valid end of the half-dangling connector survives')
  ok(dangling.to === undefined, 'connectors: NEGATIVE — the endCxn to id 99 is dropped, not invented')
  reportIs(r, ['connector-ref-dangling'], 'connectors')
}

// ----------------------------------------------------------------- structure
{
  const r = await convertPptx(await fxStructure())
  const d = r.doc
  ok(d.slides.length === 2, 'structure: both slides imported in sldIdLst order')
  ok(d.slides.every((s) => s.transition === 'none'),
    'structure: every slide gets transition none')
  ok(!d.slides.some((s) => (s.transition as string) === 'fade'),
    'structure: NEGATIVE — the model-constructor default (fade) never leaks in')

  const table = byId(r, 0, 's1-6') as OutShape
  ok(table !== undefined && table.shape === 'rect' && table.strokeStyle === 'dashed'
    && table.fill === 'transparent',
    'structure: a table graphicFrame leaves a dashed placeholder box')
  ok(table.x === 96 && table.y === 96 && table.w === 480 && table.h === 192,
    'structure: the placeholder sits in the graphicFrame’s own p:xfrm frame')
  ok(byId(r, 0, 's1-7') !== undefined, 'structure: the chart graphicFrame leaves one too')

  ok(d.slides[0].notes === 'Remember the demo',
    'structure: notes come from the body placeholder only (sldImg and sldNum skipped)')
  ok(d.slides[1].hidden === true, 'structure: show="0" imports as hidden')
  ok(d.slides[0].hidden === undefined, 'structure: an ordinary slide carries no hidden flag')

  // mc: Fallback taken exactly once
  const s2 = d.slides[1].elements
  ok(s2.length === 1 && s2[0].id === 's2-21' && (s2[0] as OutShape).fill === '#0000FF',
    'structure: mc:AlternateContent resolves to its Fallback, imported ONCE')
  ok(!s2.some((e) => e.id === 's2-20'),
    'structure: NEGATIVE — the mc:Choice content (which a blind walk double-imports) is absent')
  reportIs(r, ['table-not-yet', 'chart-not-yet'], 'structure')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
