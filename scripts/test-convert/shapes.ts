#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/convert shapes rig — geometry, fills, groups, connectors.
//
//   node scripts/test-convert/shapes.ts     (Node ≥ 23.6 strips types natively)
//
// Every expected value is HAND-COMPUTED in the comments; nothing is derived by
// running the module against itself. The traps each carry a NEGATIVE control —
// a value a plausible wrong implementation WOULD produce, asserted absent:
//
//   • gradient angles: the naive read (ang/60000 → CSS degrees) gives 90 for
//     OOXML 5400000; render.ts's convention (0 = bottom→top, from
//     gradientLineCoords: dy = -cos) makes the correct answer 180. Both pinned.
//   • an EMPTY <a:effectLst/> must CANCEL the layout's shadow; an ABSENT one
//     must inherit it. An implementation conflating empty with absent fails
//     one of the pair whichever way it conflates.
//   • nested groups: the single-scale answer (outer map applied to the leaf
//     directly, skipping the inner group's own scaling) is computed and
//     asserted to differ from the composed one.

import { parseXml } from '../../kernel/src/convert/xml.ts'
import type { XElem } from '../../kernel/src/convert/xml.ts'
import { parseTheme } from '../../kernel/src/convert/theme.ts'
import { Report } from '../../kernel/src/convert/report.ts'
import type { InheritCtx, ThemeCtx } from '../../kernel/src/convert/types.ts'
import { shapeFrom, groupChildren } from '../../kernel/src/convert/shapes.ts'
import type { ShapeDeps } from '../../kernel/src/convert/shapes.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const XMLNS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

// ------------------------------------------------------------------ the theme
// accent1 = #4472C4; fillStyleLst[0] solid phClr, [1] a phClr gradient with
// the theme's own vertical (5400000) direction; lnStyleLst widths 6350 /
// 12700 / 19050 EMU.
const theme: ThemeCtx = parseTheme(parseXml(`<a:theme ${XMLNS} name="rig">
  <a:themeElements>
    <a:clrScheme name="rig">
      <a:dk1><a:srgbClr val="000000"/></a:dk1>
      <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="1E2A3A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
      <a:accent2><a:srgbClr val="FBAE40"/></a:accent2>
      <a:accent3><a:srgbClr val="808080"/></a:accent3>
      <a:accent4><a:srgbClr val="FF0000"/></a:accent4>
      <a:accent5><a:srgbClr val="70AD47"/></a:accent5>
      <a:accent6><a:srgbClr val="C00000"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="rig">
      <a:majorFont><a:latin typeface="Georgia"/></a:majorFont>
      <a:minorFont><a:latin typeface="Verdana"/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="rig">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:gradFill>
          <a:gsLst>
            <a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:gs>
            <a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs>
          </a:gsLst>
          <a:lin ang="5400000" scaled="1"/>
        </a:gradFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
      </a:lnStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`), undefined)

const dummySlide = parseXml(`<p:sld ${XMLNS}><p:cSld><p:spTree/></p:cSld></p:sld>`)

function ctxOf(layout?: XElem): InheritCtx {
  const c: InheritCtx = { slide: dummySlide, theme, report: new Report() }
  if (layout) c.layout = layout
  return c
}
const deps = (extra?: Partial<ShapeDeps>): ShapeDeps => ({ slideIndex: 1, ...extra })
const sp = (inner: string) => parseXml(`<p:sp ${XMLNS}>${inner}</p:sp>`)

/** minimal nv block + spPr assembled around a geometry/fill/effect payload */
const spOf = (id: string, spPr: string, after = '') => sp(
  `<p:nvSpPr><p:cNvPr id="${id}" name="sp${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr>${spPr}</p:spPr>${after}`)

const XFRM_100 = '<a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm>'
const RED = '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>'

// -------------------------------------------------------- EMU/rot arithmetic
{
  // off 914400,457200 EMU = 96,48 px; ext 2743200×914400 = 288×96 px;
  // rot 2700000/60000 = 45°
  const r = shapeFrom(spOf('10',
    '<a:xfrm rot="2700000"><a:off x="914400" y="457200"/><a:ext cx="2743200" cy="914400"/></a:xfrm>' +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${RED}`), ctxOf(), deps())
  ok(!!r, 'a filled rect emits')
  const s = r!.shape
  ok(s.id === 's1-10', `id follows the s<slide>-<spId> scheme (got ${s.id})`)
  ok(s.x === 96 && s.y === 48, `EMU offsets land on 96,48 px (got ${s.x},${s.y})`)
  ok(s.w === 288 && s.h === 96, `EMU extents land on 288×96 px (got ${s.w}×${s.h})`)
  ok(s.rotation === 45, `rot 2700000 = 45° (got ${s.rotation})`)
  ok(s.shape === 'rect' && s.fill === '#FF0000', 'rect preset + own srgb fill carried')
  ok(s.strokeWidth === 0 && s.stroke === 'transparent', 'no a:ln and no style = no stroke')
}

// ------------------------------------------------- roundRect radius (a:avLst)
{
  // 1905000×952500 EMU = 200×100 px; absent adj → the preset default 16667;
  // radius = min(w,h) × 16667/100000 = 100 × 0.16667 = 16.67
  const dflt = shapeFrom(spOf('11',
    '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm>' +
    `<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>${RED}`), ctxOf(), deps())
  ok(dflt!.shape.shape === 'rect' && dflt!.shape.radius === 16.67,
    `roundRect with empty avLst takes the 16667 default → radius 16.67 (got ${dflt!.shape.radius})`)
  // explicit adj 50000 → 100 × 0.5 = 50
  const expl = shapeFrom(spOf('12',
    '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm>' +
    `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 50000"/></a:avLst></a:prstGeom>${RED}`),
    ctxOf(), deps())
  ok(expl!.shape.radius === 50, `explicit adj 50000 → radius 50 (got ${expl!.shape.radius})`)
}

// --------------------------------------------------- the 12-preset kind table
{
  const expected: Array<[string, string]> = [
    ['rect', 'rect'], ['roundRect', 'rect'], ['ellipse', 'ellipse'], ['triangle', 'triangle'],
    ['line', 'line'], ['straightConnector1', 'line'],
    ['chevron', 'path'], ['upArrowCallout', 'path'], ['round2SameRect', 'path'],
    ['bentConnector2', 'path'], ['bentConnector3', 'path'], ['bentConnector4', 'path'],
  ]
  for (const [prst, kind] of expected) {
    const c = ctxOf()
    const r = shapeFrom(spOf('13',
      `${XFRM_100}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${RED}` +
      '<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>'), c, deps())
    ok(r!.shape.shape === kind, `${prst} → '${kind}' (got '${r!.shape.shape}')`)
    ok(!c.report.build().entries.some((e) => e.code === 'shape-approximated'),
      `${prst} converts without a shape-approximated report`)
  }
}

// ------------------------------------------------------------- unknown preset
{
  const c = ctxOf()
  const r = shapeFrom(spOf('14', `${XFRM_100}<a:prstGeom prst="hexagon"><a:avLst/></a:prstGeom>${RED}`), c, deps())
  ok(r!.shape.shape === 'rect', 'off-census preset falls back to rect')
  const e = c.report.build().entries.find((x) => x.code === 'shape-approximated')
  ok(!!e && e.verdict === 'approximated' && e.detail.includes('hexagon'),
    'shape-approximated names the preset in its detail')
}

// -------------------------------------------------- gradient angle conversion
{
  // OOXML a:lin@ang is clockwise from 3 o'clock, y-down: 5400000/60000 = 90°
  // points DOWN, so the gradient runs top→bottom. render.ts gradientLineCoords
  // (dy = -cos(angle)) makes top→bottom = 180deg in bento's CSS convention.
  const c = ctxOf()
  const r = shapeFrom(spOf('15', `${XFRM_100}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    '<a:gradFill><a:gsLst>' +
    '<a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>' +
    '<a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs>' +
    '</a:gsLst><a:lin ang="5400000" scaled="1"/></a:gradFill>'), c, deps())
  const g = r!.shape.fillGradient!
  ok(g.angle === 180, `OOXML 5400000 → CSS-convention 180deg (got ${g.angle})`)
  ok(g.angle !== 90, 'NEGATIVE: the naive ang/60000 read (90) is not what we emit')
  ok(g.stops.length === 2 && g.stops[0].at === 0 && g.stops[0].color === '#FF0000'
    && g.stops[1].at === 1 && g.stops[1].color === '#0000FF', 'stops carry pos/100000 and resolved colours')
  ok(r!.shape.fill === '#0000FF', 'solid fallback fill = the last stop')

  // radial → linear approximation, reported
  const c2 = ctxOf()
  const r2 = shapeFrom(spOf('16', `${XFRM_100}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    '<a:gradFill><a:gsLst>' +
    '<a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>' +
    '<a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs>' +
    '</a:gsLst><a:path path="circle"/></a:gradFill>'), c2, deps())
  ok(r2!.shape.fillGradient!.angle === 180
    && c2.report.build().entries.some((e) => e.code === 'radial-gradient-linearized' && e.verdict === 'approximated'),
    'radial gradient linearizes and reports it')
}

// ------------------------------------------- fillRef / lnRef style fallback
{
  // no spPr fill, no spPr ln: everything comes from p:style through the theme
  // matrix with phClr = accent1 #4472C4. fillRef idx 1 → fillStyleLst[0]
  // (solid phClr); lnRef idx 2 → lnStyleLst[1] (w 12700 EMU = 1.33px).
  const c = ctxOf()
  const r = shapeFrom(spOf('17', `${XFRM_100}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
    '<p:style>' +
    '<a:lnRef idx="2"><a:schemeClr val="accent1"/></a:lnRef>' +
    '<a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>' +
    '<a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef>' +
    '<a:fontRef idx="minor"/></p:style>'), c, deps())
  const s = r!.shape
  ok(s.fill === '#4472C4', `fillRef idx 1 resolves phClr accent1 (got ${s.fill})`)
  ok(s.stroke === '#4472C4' && s.strokeWidth === 1.33,
    `lnRef idx 2 gives a 1.33px accent stroke (got ${s.stroke} @ ${s.strokeWidth})`)
  ok((c.report.build().provenance['fill:theme'] ?? 0) >= 1, 'style-matrix fill traces provenance fill:theme')

  // fillRef idx 2 = the theme's phClr GRADIENT: shapes.ts owns the parse and
  // must substitute phClr per stop; the theme's own lin 5400000 → 180deg
  const c2 = ctxOf()
  const r2 = shapeFrom(spOf('18', `${XFRM_100}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
    '<p:style><a:lnRef idx="0"/><a:fillRef idx="2"><a:schemeClr val="accent1"/></a:fillRef></p:style>'), c2, deps())
  const g = r2!.shape.fillGradient!
  ok(g.stops.length === 2 && g.stops[1].color === '#4472C4' && g.angle === 180,
    'style gradient parses with phClr substituted per stop')
}

// ----------------------------------- empty a:effectLst cancels; absent defers
{
  // layout placeholder carries the shadow: blurRad 47625 EMU = 5px,
  // dist 95250 = 10px, dir 2700000 = 45° → x = y = 10·cos45 = 7.07,
  // black at alpha 40000 → rgba(0,0,0,0.4)
  const layout = parseXml(`<p:sldLayout ${XMLNS}><p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="lay"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:effectLst><a:outerShdw blurRad="47625" dist="95250" dir="2700000">
        <a:srgbClr val="000000"><a:alpha val="40000"/></a:srgbClr>
      </a:outerShdw></a:effectLst></p:spPr>
    </p:sp>
  </p:spTree></p:cSld></p:sldLayout>`)
  const phSp = (id: string, ownEffect: string) => sp(
    `<p:nvSpPr><p:cNvPr id="${id}" name="sp${id}"/><p:cNvSpPr/><p:nvPr><p:ph/></p:nvPr></p:nvSpPr>` +
    `<p:spPr>${XFRM_100}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${RED}${ownEffect}</p:spPr>`)

  const cancelled = shapeFrom(phSp('20', '<a:effectLst/>'), ctxOf(layout), deps())
  ok(cancelled!.shape.shadow === undefined,
    'an EMPTY own a:effectLst CANCELS the layout shadow (empty ≠ absent)')

  const inherited = shapeFrom(phSp('21', ''), ctxOf(layout), deps())
  const sh = inherited!.shape.shadow
  ok(!!sh && !Array.isArray(sh) && sh.x === 7.07 && sh.y === 7.07 && sh.blur === 5
    && sh.color === 'rgba(0,0,0,0.4)',
    `NEGATIVE pair: an ABSENT effectLst inherits the layout shadow (got ${JSON.stringify(sh)})`)
}

// --------------------------------------------- nested group frame composition
{
  // outer: off 952500,952500 (100,100px), ext 1905000×952500 (200×100),
  //   chOff 0,0, chExt 952500×952500 → sx=2, sy=1
  // inner (in outer's child units): off 238125,238125, ext 476250×476250
  //   → abs 1428750,1190625, 952500×476250; its chExt 238125×238125
  //   → inner sx = 952500/238125 = 4, sy = 476250/238125 = 2
  // leaf local off 95250,95250 ext 95250×95250
  //   → abs x = 1428750 + 95250·4 = 1809750 EMU (190px)
  //     abs y = 1190625 + 95250·2 = 1381125 EMU (145px)
  //     abs w = 381000 (40px), h = 190500 (20px)
  const grp = parseXml(`<p:grpSp ${XMLNS}>
    <p:nvGrpSpPr><p:cNvPr id="20" name="outer"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm>
      <a:off x="952500" y="952500"/><a:ext cx="1905000" cy="952500"/>
      <a:chOff x="0" y="0"/><a:chExt cx="952500" cy="952500"/>
    </a:xfrm></p:grpSpPr>
    <p:grpSp>
      <p:nvGrpSpPr><p:cNvPr id="21" name="inner"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm>
        <a:off x="238125" y="238125"/><a:ext cx="476250" cy="476250"/>
        <a:chOff x="0" y="0"/><a:chExt cx="238125" cy="238125"/>
      </a:xfrm></p:grpSpPr>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="22" name="leaf"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="95250" y="95250"/><a:ext cx="95250" cy="95250"/></a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${RED}</p:spPr>
      </p:sp>
    </p:grpSp>
  </p:grpSp>`)
  const c = ctxOf()
  const children = groupChildren(grp, c, deps())
  ok(children.length === 1, 'nested groups flatten to leaves')
  const leaf = children[0]
  ok(leaf.frame.x === 1809750 && leaf.frame.y === 1381125,
    `composed child offset is 1809750,1381125 EMU (got ${leaf.frame.x},${leaf.frame.y})`)
  ok(leaf.frame.w === 381000 && leaf.frame.h === 190500,
    `composed child extent is 381000×190500 EMU (got ${leaf.frame.w}×${leaf.frame.h})`)
  // NEGATIVE: skipping the inner group's own scaling (applying only the outer
  // map to the leaf) would land x at 952500 + 95250·2 = 1143000
  ok(leaf.frame.x !== 1143000, 'NEGATIVE: not the single-scale (outer-map-only) x')
  ok(leaf.groupId === 's1-g20', `every leaf shares the OUTERMOST group id (got ${leaf.groupId})`)
  ok(c.report.build().entries.some((e) => e.code === 'nested-group-flattened'),
    'nested group is reported as flattened')

  // the frame feeds back through deps and lands in px on the element
  const r = shapeFrom(leaf.el, c, deps({ frame: leaf.frame, groupId: leaf.groupId }))
  const s = r!.shape
  ok(s.x === 190 && s.y === 145 && s.w === 40 && s.h === 20,
    `deps.frame override wires through to px (got ${s.x},${s.y},${s.w},${s.h})`)
  ok(s.groupId === 's1-g20', 'deps.groupId lands on the element')
}

// ------------------------------------------------- connectors + line-as-fill
{
  const cxn = (endId: string) => parseXml(`<p:cxnSp ${XMLNS}>
    <p:nvCxnSpPr><p:cNvPr id="7" name="conn"/>
      <p:cNvCxnSpPr><a:stCxn id="4" idx="3"/><a:endCxn id="${endId}" idx="1"/></p:cNvCxnSpPr>
    <p:nvPr/></p:nvCxnSpPr>
    <p:spPr>
      <a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="0"/></a:xfrm>
      <a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>
      <a:ln w="19050"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:tailEnd type="triangle"/></a:ln>
    </p:spPr>
  </p:cxnSp>`)
  const c = ctxOf()
  const r = shapeFrom(cxn('9'), c, deps({ spIds: new Set(['4', '9']) }))
  const s = r!.shape
  ok(s.shape === 'line', 'straightConnector1 is a bento line')
  // BENTO LINE GOTCHA: the renderer strokes el.fill (morphs tween the stroke
  // attr) — both carry the resolved a:ln colour
  ok(s.fill === '#FF0000' && s.stroke === '#FF0000', 'line colour lands on BOTH fill and stroke')
  ok(s.strokeWidth === 2, `19050 EMU line width = 2px (got ${s.strokeWidth})`)
  ok(s.w === 100 && s.rotation === 0 && s.x === 0 && s.y === -(s.h / 2),
    `horizontal 100px line: box centred on the segment (got x${s.x} y${s.y} w${s.w} rot${s.rotation})`)
  ok(s.lineEnd === 'arrow' && s.lineStart === undefined, 'tailEnd triangle → lineEnd arrow')
  ok(!!s.from && s.from.el === 's1-4' && s.from.side === 'auto', `stCxn → from s1-4 (got ${JSON.stringify(s.from)})`)
  ok(!!s.to && s.to.el === 's1-9', `endCxn → to s1-9 (got ${JSON.stringify(s.to)})`)

  // dangling target: the end goes free, and the report says so
  const c2 = ctxOf()
  const r2 = shapeFrom(cxn('99'), c2, deps({ spIds: new Set(['4', '9']) }))
  ok(r2!.shape.to === undefined && !!r2!.shape.from, 'a ref to a missing shape drops only that end')
  ok(c2.report.build().entries.some((e) => e.code === 'connector-ref-dangling' && e.verdict === 'dropped'),
    'dangling connector ref is reported')
}

// -------------------------------------------------------- line flip geometry
{
  // flipV on a 100×100 box: the segment runs bottom-left→top-right, so
  // len = √2·100 = 141.42, angle = atan2(-100,100) = -45°, and the element
  // box centres on the segment: x = 50 - 141.42/2 = -20.71
  const c = ctxOf()
  const r = shapeFrom(spOf('30',
    '<a:xfrm flipV="1"><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm>' +
    '<a:prstGeom prst="line"><a:avLst/></a:prstGeom>' +
    '<a:ln w="9525"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>'), c, deps())
  const s = r!.shape
  ok(s.rotation === -45, `flipV line rotates -45° (got ${s.rotation})`)
  ok(s.w === 141.42, `diagonal length 141.42 (got ${s.w})`)
  ok(s.x === -20.71, `box recentres on the segment (got x ${s.x})`)
  ok(!c.report.build().entries.some((e) => e.code === 'flip-dropped'),
    'a line CONSUMES its flip — no flip-dropped report')
}

// ---------------------------------------------------------- path synthesis d
{
  // chevron 200×100, adj default 50000: ss=100 → x1=50
  const c = ctxOf()
  const r = shapeFrom(spOf('31',
    '<a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="952500"/></a:xfrm>' +
    `<a:prstGeom prst="chevron"><a:avLst/></a:prstGeom>${RED}`), c, deps())
  ok(r!.shape.d === 'M0 0 L150 0 L200 50 L150 100 L0 100 L50 50 Z',
    `chevron d matches the hand-derived outline (got ${r!.shape.d})`)
  ok(JSON.stringify(r!.shape.pathBox) === '[0,0,200,100]', 'pathBox is the real px box')

  // upArrowCallout 100×100 defaults: a1=a2=a3=25000, a4=64977 →
  // dx1=25 dx2=12.5 y1=25 y2=100-64.977=35.02
  const r2 = shapeFrom(spOf('32',
    `${XFRM_100}<a:prstGeom prst="upArrowCallout"><a:avLst/></a:prstGeom>${RED}`), ctxOf(), deps())
  ok(r2!.shape.d ===
    'M0 35.02 L37.5 35.02 L37.5 25 L25 25 L50 0 L75 25 L62.5 25 L62.5 35.02 L100 35.02 L100 100 L0 100 Z',
    `upArrowCallout d matches the spec guides (got ${r2!.shape.d})`)

  // round2SameRect 100×100 defaults adj1=16667 adj2=0: only the TOP corners
  // round (r=16.67); zero-radius corners emit no degenerate arcs
  const r3 = shapeFrom(spOf('33',
    `${XFRM_100}<a:prstGeom prst="round2SameRect"><a:avLst/></a:prstGeom>${RED}`), ctxOf(), deps())
  ok(r3!.shape.d ===
    'M16.67 0 L83.33 0 A16.67 16.67 0 0 1 100 16.67 L100 100 L0 100 L0 16.67 A16.67 16.67 0 0 1 16.67 0 Z',
    `round2SameRect d rounds only the top pair (got ${r3!.shape.d})`)

  // bentConnector3 100×50, adj default 50000 → the bend at x=50; open,
  // stroke-only (never filled)
  const r4 = shapeFrom(spOf('34',
    '<a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm>' +
    '<a:prstGeom prst="bentConnector3"><a:avLst/></a:prstGeom>' +
    '<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>'), ctxOf(), deps())
  ok(r4!.shape.d === 'M0 0 L50 0 L50 50 L100 50', `bentConnector3 elbow at x1 (got ${r4!.shape.d})`)
  ok(r4!.shape.fill === 'transparent', 'bent connectors never take a fill')

  // flip baked into synthesized coordinates: bentConnector2 flipV mirrors y
  const r5 = shapeFrom(spOf('35',
    '<a:xfrm flipV="1"><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm>' +
    '<a:prstGeom prst="bentConnector2"><a:avLst/></a:prstGeom>' +
    '<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>'), ctxOf(), deps())
  ok(r5!.shape.d === 'M0 50 L100 50 L100 0', `flipV bakes into the path (got ${r5!.shape.d})`)
}

// --------------------------------------------------------------- flip policy
{
  // flipV triangle: bento's triangle points up, so the flip is absorbed by
  // becoming a path — NOT reported (the negative for a lazy always-report)
  const c = ctxOf()
  const r = shapeFrom(spOf('36',
    '<a:xfrm flipV="1"><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm>' +
    `<a:prstGeom prst="triangle"><a:avLst/></a:prstGeom>${RED}`), c, deps())
  ok(r!.shape.shape === 'path' && r!.shape.d === 'M50 100 L100 0 L0 0 Z',
    `flipV triangle becomes a points-down path (got ${r!.shape.shape} ${r!.shape.d})`)
  ok(!c.report.build().entries.some((e) => e.code === 'flip-dropped'),
    'an absorbable flip is not reported')

  // a flip nothing absorbs (rightArrow flipH would need to point left) IS
  ok(r!.shape.pathBox !== undefined, 'flipped triangle keeps its pathBox')
  const c2 = ctxOf()
  const r2 = shapeFrom(spOf('37',
    '<a:xfrm flipH="1"><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm>' +
    `<a:prstGeom prst="rightArrow"><a:avLst/></a:prstGeom>${RED}`), c2, deps())
  ok(r2!.shape.shape === 'arrow'
    && c2.report.build().entries.some((e) => e.code === 'flip-dropped' && e.verdict === 'approximated'),
    'an unabsorbable flip reports flip-dropped')
}

// ------------------------------------------ dash mapping / picture fill drop
{
  const dash = (val: string) => shapeFrom(spOf('40',
    `${XFRM_100}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${RED}` +
    `<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="${val}"/></a:ln>`),
    ctxOf(), deps())!.shape
  ok(dash('sysDash').strokeStyle === 'dashed' && dash('dashDot').strokeStyle === 'dashed',
    'dash family → dashed')
  ok(dash('sysDot').strokeStyle === 'dotted', 'dot family → dotted')
  ok(dash('solid').strokeStyle === undefined, 'solid emits no strokeStyle')

  const c = ctxOf()
  const r = shapeFrom(spOf('41', `${XFRM_100}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    '<a:blipFill><a:blip/></a:blipFill>'), c, deps())
  ok(!!r && r.shape.fill === 'transparent'
    && c.report.build().entries.some((e) => e.code === 'picture-fill-dropped'),
    'blipFill on a shape → transparent + report (shape still emitted for the report to point at)')
}

// ----------------------------------------- text boxes and the box-text split
{
  const TX = '<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>Hello</a:t></a:r></a:p></p:txBody>'
  // invisible geometry (noFill, no ln): a bare text box — no shape element
  const bare = shapeFrom(spOf('50',
    `${XFRM_100}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>`, TX), ctxOf(), deps())
  ok(bare === undefined, 'a noFill/no-stroke text box emits NO shape (text module carries it alone)')

  // visible box with text: shape emits carrying the reserved groupId the
  // integrator must weld the text element to (shape first, text above)
  const boxed = shapeFrom(spOf('51',
    `${XFRM_100}<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>${RED}`, TX), ctxOf(), deps())
  ok(!!boxed && boxed.textGroupId === 's1-51-g' && boxed.shape.groupId === 's1-51-g',
    `box-with-text reserves the shared groupId (got ${boxed?.textGroupId})`)
}

// --------------------------------------------------------------------- total
console.log(`\n${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
