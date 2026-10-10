#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// pptx-write shape-mapper rig: bento shape → p:sp / p:cxnSp.
//
//   node scripts/test-convert/pptx-shapes.ts     (Node ≥ 23.6 strips types natively)
//
// Every emitted node is re-read through the convert engine's own PARSER
// (convert/src/xml.ts) and checked against HAND-COMPUTED EMU/angle/
// percentage values — the arithmetic is done twice, once in the module and
// once on paper here, so a unit slip (px vs pt, degree vs 60000ths) fails a
// number, not a vibe. NEGATIVE controls exercise the honesty paths: an
// unsupported arc command must produce a report entry and a parseable path,
// never garbage coordinates; a 'bar' tip must confess it has no OOXML twin.

import { parseXml, kids, kid, attr, NS, type XElem } from '../../convert/src/xml.ts'
import { serialize, x } from '../../convert/src/xmlout.ts'
import { PML_XMLNS } from '../../convert/src/pptx-write/parts.ts'
import { Report } from '../../convert/src/report.ts'
import { arcToCubics,
  emu, xfrmNode, parseColor, solidFill, cssAngleToOoxml, shapeNode, type ShapeIn,
} from '../../convert/src/pptx-write/shapes.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// A defaulted bento shape; tests override what they exercise.
function shape(over: Partial<ShapeIn>): ShapeIn {
  return {
    id: 'el1', x: 100, y: 50, w: 200, h: 100, rotation: 0, opacity: 1,
    shape: 'rect', fill: '#336699', stroke: 'transparent', strokeWidth: 0, radius: 0,
    ...over,
  }
}

// Emit one shape and re-read it through the parser. Standalone sp/cxnSp nodes
// carry no xmlns of their own (the slide root declares the trio), so the rig
// wraps them the way slidePart would.
function emit(el: ShapeIn, report = new Report()): XElem {
  const node = shapeNode(el, 2, report, 'slide 1')
  const doc = parseXml(serialize(x('root', PML_XMLNS, [node])))
  const sp = doc.children.find((c) => typeof c !== 'string') as XElem
  return sp
}

const spPr = (sp: XElem) => kid(sp, NS.p, 'spPr')!
const codes = (r: Report) => r.build().entries.map((e) => e.code)

// --- shared helpers ----------------------------------------------------------
console.log('frame/xfrm helper')

ok(emu(100) === 952500, 'emu: 100px = 952500 EMU (100 * 9525)')
ok(emu(1.5) === 14288, 'emu rounds to an integer (1.5px = 14287.5 → 14288)')

{
  const n = parseXml(serialize(x('r', { 'xmlns:a': NS.a }, [xfrmNode({ x: 100, y: 50, w: 200, h: 100, rotation: 45 })])))
  const xf = kid(n, NS.a, 'xfrm')!
  const off = kid(xf, NS.a, 'off')!
  const ext = kid(xf, NS.a, 'ext')!
  ok(attr(off, 'x') === '952500' && attr(off, 'y') === '476250', 'xfrm off: (100,50)px = (952500,476250) EMU')
  ok(attr(ext, 'cx') === '1905000' && attr(ext, 'cy') === '952500', 'xfrm ext: 200×100px = 1905000×952500 EMU')
  ok(attr(xf, 'rot') === '2700000', 'xfrm rot: 45° = 2700000 (60000ths of a degree)')
}
{
  const n = parseXml(serialize(x('r', { 'xmlns:a': NS.a }, [xfrmNode({ x: 0, y: 0, w: 10, h: 10 })])))
  ok(attr(kid(n, NS.a, 'xfrm')!, 'rot') === undefined, 'rot omitted at 0 (matches native PowerPoint output)')
}

// --- colours -----------------------------------------------------------------
console.log('colours')

ok(JSON.stringify(parseColor('#336699')) === '{"hex":"336699","alpha":1}', '#rrggbb parses opaque')
ok(JSON.stringify(parseColor('#36c')) === '{"hex":"3366CC","alpha":1}', '#rgb shorthand doubles')
{
  const c = parseColor('rgba(255, 0, 0, 0.5)')!
  ok(c.hex === 'FF0000' && c.alpha === 0.5, 'rgba() splits into hex + alpha')
}
ok(parseColor('transparent')!.alpha === 0, 'transparent = alpha 0')
ok(parseColor('chartreuse') === null, 'NEGATIVE: css keyword is refused (null), not silently guessed')

{
  const n = parseXml(serialize(x('r', { 'xmlns:a': NS.a }, [solidFill('rgba(255,0,0,0.5)')])))
  const clr = kid(kid(n, NS.a, 'solidFill')!, NS.a, 'srgbClr')!
  ok(attr(clr, 'val') === 'FF0000', 'solidFill: rgba colour lands in srgbClr@val')
  ok(attr(kid(clr, NS.a, 'alpha')!, 'val') === '50000', 'solidFill: alpha 0.5 = 50000 (1000ths of a percent)')
}
{
  const n = parseXml(serialize(x('r', { 'xmlns:a': NS.a }, [solidFill('#ff0000', 0.5)])))
  const clr = kid(kid(n, NS.a, 'solidFill')!, NS.a, 'srgbClr')!
  ok(attr(kid(clr, NS.a, 'alpha')!, 'val') === '50000', 'element opacity multiplies into fill alpha (#88 combineTransparency)')
}

// --- rect / roundRect --------------------------------------------------------
console.log('rect and roundRect')

{
  const r = new Report()
  const sp = emit(shape({}), r)
  ok(sp.local === 'sp' && sp.ns === NS.p, 'rect emits p:sp')
  const geom = kid(spPr(sp), NS.a, 'prstGeom')!
  ok(attr(geom, 'prst') === 'rect', 'radius 0 → prst=rect')
  ok(kid(geom, NS.a, 'avLst') !== undefined, 'prstGeom carries its (empty) avLst')
  const nv = kid(sp, NS.p, 'nvSpPr')!
  ok(attr(kid(nv, NS.p, 'cNvPr')!, 'name') === 'bento:el1', 'cNvPr name carries bento:<morph key> (#88 objectName)')
  ok(attr(kid(nv, NS.p, 'cNvPr')!, 'id') === '2', 'cNvPr id is the caller-assigned shape id')
  const fill = kid(kid(spPr(sp), NS.a, 'solidFill')!, NS.a, 'srgbClr')!
  ok(attr(fill, 'val') === '336699', 'fill colour carried')
  const ln = kid(spPr(sp), NS.a, 'ln')!
  ok(kid(ln, NS.a, 'noFill') !== undefined, 'strokeWidth 0 → explicit a:ln/a:noFill (never theme-default outline)')
  ok(kid(sp, NS.p, 'txBody') !== undefined, 'p:sp carries an empty txBody (typeable in PowerPoint)')
  ok(r.build().entries.length === 0, 'plain rect reports nothing')
}
{
  // radius 12 on a 200×100 box: 12/min(200,100) = 0.12 → 12000
  const sp = emit(shape({ radius: 12 }))
  const geom = kid(spPr(sp), NS.a, 'prstGeom')!
  ok(attr(geom, 'prst') === 'roundRect', 'radius > 0 → roundRect')
  const gd = kid(kid(geom, NS.a, 'avLst')!, NS.a, 'gd')!
  ok(attr(gd, 'fmla') === 'val 12000', 'roundRect adj: 12px / min(200,100) = 0.12 → 12000 (fraction in 100000ths)')
}
{
  // radius 80 on 100×60: 80/60 = 1.33 → clamped to 0.5 (#88's clamp)
  const sp = emit(shape({ w: 100, h: 60, radius: 80 }))
  const gd = kid(kid(kid(spPr(sp), NS.a, 'prstGeom')!, NS.a, 'avLst')!, NS.a, 'gd')!
  ok(attr(gd, 'fmla') === 'val 50000', 'roundRect adj clamps at 0.5 (PowerPoint\'s own maximum)')
}

// --- other presets -----------------------------------------------------------
console.log('ellipse / triangle / arrow')

for (const [kind, prst] of [['ellipse', 'ellipse'], ['triangle', 'triangle'], ['arrow', 'rightArrow']] as const) {
  const sp = emit(shape({ shape: kind }))
  ok(attr(kid(spPr(sp), NS.a, 'prstGeom')!, 'prst') === prst, `${kind} → prst=${prst}`)
}

// --- lines -------------------------------------------------------------------
console.log('lines')

{
  const el = shape({ shape: 'line', fill: '#ff0000', stroke: '#00ff00', strokeWidth: 4, y: 50, h: 20 })
  const sp = emit(el)
  ok(sp.local === 'cxnSp' && sp.ns === NS.p, 'line emits p:cxnSp')
  ok(attr(kid(spPr(sp), NS.a, 'prstGeom')!, 'prst') === 'line', 'line geometry is prst=line (the census\'s 141)')
  const ln = kid(spPr(sp), NS.a, 'ln')!
  const clr = kid(kid(ln, NS.a, 'solidFill')!, NS.a, 'srgbClr')!
  ok(attr(clr, 'val') === 'FF0000', 'GOTCHA: line colour comes from FILL (#ff0000), never stroke (#00ff00)')
  ok(attr(ln, 'w') === String(emu(4)), 'line width: strokeWidth px → EMU on a:ln@w')
  const xf = kid(spPr(sp), NS.a, 'xfrm')!
  ok(attr(kid(xf, NS.a, 'off')!, 'y') === String(emu(60)), 'line box collapses to the centerline: y 50 + h/2 = 60px')
  ok(attr(kid(xf, NS.a, 'ext')!, 'cy') === '0', 'line box collapses to zero height (bento draws at h/2, OOXML corner-to-corner)')
  ok(kid(sp, NS.p, 'nvCxnSpPr') !== undefined, 'cxnSp carries nvCxnSpPr, not nvSpPr')
}
{
  const ln0 = kid(spPr(emit(shape({ shape: 'line', strokeWidth: 0 }))), NS.a, 'ln')!
  ok(attr(ln0, 'w') === String(emu(2)), 'a 0-width bento line stays visible: renderer\'s max(sw,2)px floor kept')
}

// --- dash + tips -------------------------------------------------------------
console.log('stroke style and tips')

{
  const ln = kid(spPr(emit(shape({ shape: 'line', strokeStyle: 'dotted', strokeWidth: 2 }))), NS.a, 'ln')!
  ok(attr(kid(ln, NS.a, 'prstDash')!, 'val') === 'sysDot', 'dotted → prstDash sysDot')
  ok(attr(ln, 'cap') === 'rnd', 'dotted gets round caps (or sysDot renders square specks)')
}
{
  const ln = kid(spPr(emit(shape({ strokeStyle: 'dashed', stroke: '#000000', strokeWidth: 2 }))), NS.a, 'ln')!
  ok(attr(kid(ln, NS.a, 'prstDash')!, 'val') === 'dash', 'dashed → prstDash dash')
}
{
  const ln = kid(spPr(emit(shape({ strokeDash: 6, stroke: '#000000', strokeWidth: 2 }))), NS.a, 'ln')!
  ok(attr(kid(ln, NS.a, 'prstDash')!, 'val') === 'dash', 'legacy strokeDash px-count still maps to dash')
}
{
  const r = new Report()
  const ln = kid(spPr(emit(shape({ shape: 'line', strokeWidth: 2, lineStart: 'arrow', lineEnd: 'dot' }), r)), NS.a, 'ln')!
  ok(attr(kid(ln, NS.a, 'headEnd')!, 'type') === 'triangle', 'lineStart arrow → headEnd triangle')
  ok(attr(kid(ln, NS.a, 'tailEnd')!, 'type') === 'oval', 'lineEnd dot → tailEnd oval')
  ok(r.build().entries.length === 0, 'faithful tips report nothing')
}
{
  const r = new Report()
  const ln = kid(spPr(emit(shape({ shape: 'line', strokeWidth: 2, lineEnd: 'bar' }), r)), NS.a, 'ln')!
  ok(attr(kid(ln, NS.a, 'tailEnd')!, 'type') === 'diamond', 'bar tip exports as diamond (#88\'s least-dishonest pick)')
  ok(codes(r).includes('line-tip-approximated'), 'NEGATIVE: bar has no OOXML twin — the report says so')
}

// --- gradients ---------------------------------------------------------------
console.log('gradients')

// The angle inversion, hand-computed against both conventions. CSS 90° is
// left→right; OOXML left→right is 0. CSS 180° is top→bottom; OOXML top→bottom
// is 90° = 5400000 (the same value parts.ts's theme uses for its vertical
// gradient). The importer converts ooxml→css by the +90 shift; this is its
// exact inverse, so 90 must round-trip to 0.
ok(cssAngleToOoxml(90) === 0, 'css 90° (left→right) → ooxml 0')
ok(cssAngleToOoxml(180) === 5400000, 'css 180° (top→bottom) → ooxml 5400000')
ok(cssAngleToOoxml(0) === 16200000, 'css 0° (bottom→top) → ooxml 16200000')
ok(cssAngleToOoxml(45) === 18900000, 'css 45° → ooxml 315° = 18900000 (wraps, stays positive)')

{
  const r = new Report()
  const sp = emit(shape({
    fillGradient: { angle: 90, stops: [{ at: 0, color: '#ff0000' }, { at: 0.25, color: 'rgba(0,0,255,0.5)' }, { at: 1, color: '#00ff00' }] },
  }), r)
  const grad = kid(spPr(sp), NS.a, 'gradFill')!
  const gs = kids(kid(grad, NS.a, 'gsLst')!, NS.a, 'gs')
  ok(gs.length === 3, 'every stop becomes an a:gs')
  ok(attr(gs[1], 'pos') === '25000', 'stop at 0.25 → pos 25000 (1000ths of a percent)')
  const mid = kid(gs[1], NS.a, 'srgbClr')!
  ok(attr(mid, 'val') === '0000FF' && attr(kid(mid, NS.a, 'alpha')!, 'val') === '50000', 'rgba stop keeps its own alpha')
  const lin = kid(grad, NS.a, 'lin')!
  ok(attr(lin, 'ang') === '0', 'gradient angle inverted from CSS convention')
  ok(attr(lin, 'scaled') === '0', 'scaled=0: a CSS angle is a TRUE angle, never aspect-skewed')
  ok(kid(spPr(sp), NS.a, 'solidFill') === undefined, 'gradient wins over the solid fallback fill')
  ok(r.build().entries.length === 0, 'clean gradient reports nothing')
}

{
  // CT_GradientStopList requires gs minOccurs=2: a ONE-stop gradient must not
  // emit a schema-invalid gsLst. SVG paints one stop as solid, so the honest
  // (and valid) export is that stop's solidFill.
  const sp = emit(shape({ fill: '#00ff00', fillGradient: { angle: 90, stops: [{ at: 0, color: '#ff0000' }] } }))
  ok(kid(spPr(sp), NS.a, 'gradFill') === undefined, 'NEGATIVE: one-stop gradient emits NO a:gradFill (gsLst needs 2+ gs)')
  const oneClr = kid(kid(spPr(sp), NS.a, 'solidFill')!, NS.a, 'srgbClr')!
  ok(attr(oneClr, 'val') === 'FF0000', 'one-stop gradient exports as that stop’s solid colour (what SVG painted)')
}

// --- alpha and noFill --------------------------------------------------------
console.log('opacity and transparency')

{
  const sp = emit(shape({ fill: 'rgba(255,0,0,0.5)', opacity: 0.5 }))
  const clr = kid(kid(spPr(sp), NS.a, 'solidFill')!, NS.a, 'srgbClr')!
  ok(attr(kid(clr, NS.a, 'alpha')!, 'val') === '25000', 'fill alpha × element opacity: 0.5 × 0.5 → 25000')
}
{
  const sp = emit(shape({ fill: 'transparent' }))
  ok(kid(spPr(sp), NS.a, 'noFill') !== undefined, 'transparent fill → explicit a:noFill')
}
{
  const r = new Report()
  const sp = emit(shape({ fill: 'papayawhip' }), r)
  const clr = kid(kid(spPr(sp), NS.a, 'solidFill')!, NS.a, 'srgbClr')!
  ok(attr(clr, 'val') === '000000', 'unparseable colour falls back to black…')
  ok(codes(r).includes('color-unparsed'), 'NEGATIVE: …and the fallback is reported, not silent (#88 was silent here)')
}

// --- shadows -----------------------------------------------------------------
console.log('shadows')

{
  const r = new Report()
  const sp = emit(shape({ shadow: { x: 3, y: 4, blur: 8, color: 'rgba(0,0,0,0.4)' } }), r)
  const shdw = kid(kid(spPr(sp), NS.a, 'effectLst')!, NS.a, 'outerShdw')!
  ok(attr(shdw, 'dist') === '47625', 'offset (3,4)px → dist = hypot·9525 = 47625 EMU')
  // atan2(4,3) = 53.13010235…° clockwise (y-down is already clockwise) × 60000
  ok(attr(shdw, 'dir') === '3187806', 'dir = atan2(4,3) = 53.1301° → 3187806 (60000ths)')
  ok(attr(shdw, 'blurRad') === '76200', 'blur 8px → blurRad 76200 EMU')
  ok(attr(shdw, 'rotWithShape') === '0', 'rotWithShape=0: CSS drop-shadow is screen-space, never rotates with the shape')
  const clr = kid(shdw, NS.a, 'srgbClr')!
  ok(attr(kid(clr, NS.a, 'alpha')!, 'val') === '40000', 'shadow colour alpha carried')
  ok(r.build().entries.length === 0, 'single shadow reports nothing')
}
{
  // 300px blur = 225pt, beyond PowerPoint's editable 100pt — clamped (#88)
  const sp = emit(shape({ shadow: { blur: 300, color: '#000000' } }))
  const shdw = kid(kid(spPr(sp), NS.a, 'effectLst')!, NS.a, 'outerShdw')!
  ok(attr(shdw, 'blurRad') === '1270000', 'blur clamps at 100pt so the shadow stays editable in PowerPoint')
}
{
  const r = new Report()
  const sp = emit(shape({ shadow: [{ blur: 8, color: '#000000' }, { blur: 20, color: '#ffffff' }] }), r)
  const shdws = kids(kid(spPr(sp), NS.a, 'effectLst')!, NS.a, 'outerShdw')
  ok(shdws.length === 1, 'stacked shadows export the first only…')
  ok(codes(r).includes('multiple-shadows-simplified'), 'NEGATIVE: …and say so (#88\'s code, kept)')
}

// --- custGeom ----------------------------------------------------------------
console.log('custGeom (path shapes)')

{
  const r = new Report()
  const el = shape({ shape: 'path', d: 'M0 0 L10 0 L10 5 Z', pathBox: [0, 0, 10, 5], w: 200, h: 100 })
  const sp = emit(el, r)
  const geom = kid(spPr(sp), NS.a, 'custGeom')!
  const path = kid(kid(geom, NS.a, 'pathLst')!, NS.a, 'path')!
  ok(attr(path, 'w') === '95250' && attr(path, 'h') === '47625', 'path space is pathBox scaled to EMU: 10×5px → 95250×47625')
  const segNames = path.children.filter((c) => typeof c !== 'string').map((c) => (c as XElem).local)
  ok(segNames.join(',') === 'moveTo,lnTo,lnTo,close', 'M/L/L/Z → moveTo, lnTo, lnTo, close')
  const ln2 = kids(path, NS.a, 'lnTo')[1]
  const p2 = kid(ln2, NS.a, 'pt')!
  ok(attr(p2, 'x') === '95250' && attr(p2, 'y') === '47625', 'point (10,5)px lands at (95250,47625) — integers, EMU-scaled')
  ok(r.build().entries.length === 0, 'supported subset reports nothing')
}
{
  // cubic + relative commands + pathBox with a non-zero origin
  const el = shape({ shape: 'path', d: 'M2 1 c 4 0 4 3 8 3', pathBox: [2, 1, 8, 3] })
  const path = kid(kid(kid(spPr(emit(el)), NS.a, 'custGeom')!, NS.a, 'pathLst')!, NS.a, 'path')!
  const cub = kid(path, NS.a, 'cubicBezTo')!
  const pts = kids(cub, NS.a, 'pt')
  ok(pts.length === 3, 'C emits cubicBezTo with three points')
  // relative c from (2,1): ctrl1 (6,1) → box-local (4,0) → (38100, 0)
  ok(attr(pts[0], 'x') === '38100' && attr(pts[0], 'y') === '0', 'relative coords resolve against the current point, offset by pathBox origin')
  ok(attr(pts[2], 'x') === String(emu(8)) && attr(pts[2], 'y') === String(emu(3)), 'cubic endpoint lands where the model authored it')
}
{
  const r = new Report()
  const el = shape({ shape: 'path', d: 'M0 0 A5 5 0 0 1 10 0 L10 5', pathBox: [0, 0, 10, 5] })
  const sp = emit(el, r)
  const path = kid(kid(kid(spPr(sp), NS.a, 'custGeom')!, NS.a, 'pathLst')!, NS.a, 'path')!
  // A5 5 0 0 1 10 0 from (0,0) is a half circle about (5,0): two quarter
  // cubics, through (5,-5) (positive sweep, y down), ending exactly on (10,0)
  ok(!codes(r).includes('path-approximated'), 'an arc is drawn exactly, so nothing is reported')
  const cubs = kids(path, NS.a, 'cubicBezTo')
  ok(cubs.length === 2, `a half-circle arc becomes two quarter-turn cubics (${cubs.length})`)
  const end = (c: XElem) => kids(c, NS.a, 'pt')[2]
  ok(attr(end(cubs[0]), 'x') === String(emu(5)) && attr(end(cubs[0]), 'y') === String(-emu(5)), `it passes through the top of the circle (${attr(end(cubs[0]), 'x')}, ${attr(end(cubs[0]), 'y')})`)
  ok(attr(end(cubs[1]), 'x') === String(emu(10)) && attr(end(cubs[1]), 'y') === '0', 'and lands exactly on the arc endpoint')
  const nums = path.children.filter((c) => typeof c !== 'string')
    .flatMap((c) => kids(c as XElem, NS.a, 'pt'))
    .flatMap((p) => [attr(p, 'x'), attr(p, 'y')])
  ok(nums.every((n) => n !== undefined && /^-?\d+$/.test(n)), 'NEGATIVE: every emitted coordinate is a plain integer (no NaN leaked)')
}
{
  // a minifier writes arc flags run together: "0 01" is flags 0, 1 — read as
  // one number they shifted every coordinate after them (and crashed export)
  const a = new Report(), b = new Report()
  const spread = emit(shape({ shape: 'path', d: 'M0 0 A5 5 0 0 1 10 0', pathBox: [0, 0, 10, 5] }), a)
  const packed = emit(shape({ shape: 'path', d: 'M0 0a5 5 0 0110 0', pathBox: [0, 0, 10, 5] }), b)
  const geo = (sp: XElem) => JSON.stringify(kid(kid(spPr(sp), NS.a, 'custGeom')!, NS.a, 'pathLst'))
  ok(geo(spread) === geo(packed) && !codes(b).includes('path-approximated'), 'run-together arc flags ("0110 0") read as 0, 1, then 10 0')
  // and where the flags run into a decimal: "00.5.5" is flags 0, 0, then .5 .5
  const c = new Report(), d = new Report()
  const spread2 = emit(shape({ shape: 'path', d: 'M0 0 a.5 .5 0 0 0 .5 .5', pathBox: [0, 0, 1, 1] }), c)
  const packed2 = emit(shape({ shape: 'path', d: 'M0 0a.5.5 0 00.5.5', pathBox: [0, 0, 1, 1] }), d)
  ok(geo(spread2) === geo(packed2) && !codes(d).includes('path-approximated'), 'flags run into a decimal ("00.5.5") read as 0, 0, then .5 .5')
}
{
  // the side of the centre matters on any arc that is not a half circle:
  // A10 10 0 0 1 10 10 from (0,0) is a quarter turn about (0,10), not (10,0)
  const curves = arcToCubics(0, 0, 10, 10, 0, 0, 1, 10, 10)!
  const [c] = curves
  const mid = [0.125 * 0 + 0.375 * c[0] + 0.375 * c[2] + 0.125 * c[4], 0.125 * 0 + 0.375 * c[1] + 0.375 * c[3] + 0.125 * c[5]]
  const dist = (x: number, y: number) => Math.hypot(mid[0] - x, mid[1] - y)
  ok(curves.length === 1 && Math.abs(dist(0, 10) - 10) < 0.05 && Math.abs(dist(10, 0) - 10) > 1,
    `a quarter arc curves about the right centre (midpoint ${mid.map((v) => v.toFixed(2))}, ${dist(0, 10).toFixed(3)} from (0,10))`)
  // the same endpoints with sweep 0 turn the other way, about (10,0)
  const [d] = arcToCubics(0, 0, 10, 10, 0, 0, 0, 10, 10)!
  const m2 = [0.375 * d[0] + 0.375 * d[2] + 0.125 * d[4], 0.375 * d[1] + 0.375 * d[3] + 0.125 * d[5]]
  ok(Math.abs(Math.hypot(m2[0] - 10, m2[1]) - 10) < 0.05 && Math.abs(Math.hypot(m2[0], m2[1] - 10) - 10) > 1,
    `with sweep 0 it curves about the other centre (midpoint ${m2.map((v) => v.toFixed(2))})`)
}
{
  // a path that runs out of arguments must not cost the whole export
  const r = new Report()
  const sp = emit(shape({ shape: 'path', d: 'M0 0 L10 0 C1 2 3', pathBox: [0, 0, 10, 5] }), r)
  const path = kid(kid(kid(spPr(sp), NS.a, 'custGeom')!, NS.a, 'pathLst')!, NS.a, 'path')!
  const nums = path.children.filter((c) => typeof c !== 'string').flatMap((c) => kids(c as XElem, NS.a, 'pt')).flatMap((p) => [attr(p, 'x'), attr(p, 'y')])
  ok(codes(r).includes('path-approximated') && kids(path, NS.a, 'lnTo').length === 1 && nums.every((n) => /^-?\d+$/.test(n ?? '')),
    'a truncated path keeps its good segments, is reported, and writes no NaN')
}
{
  const r = new Report()
  emit(shape({ shape: 'path', d: 'M0 0 W nonsense', pathBox: [0, 0, 10, 5] }), r)
  ok(codes(r).includes('path-approximated'), 'NEGATIVE: an unknown command letter reports rather than guessing arg counts')
}

// --- effects with no OOXML expression ---------------------------------------
console.log('dropped effects')

{
  const r = new Report()
  emit(shape({ blur: 4, blend: 'screen', backdropFilter: 10 }), r)
  const c = codes(r)
  ok(c.includes('shape-blur-dropped') && c.includes('blend-mode-dropped') && c.includes('backdrop-filter-dropped'),
    'blur / blend / backdropFilter each report as dropped')
}
{
  const r = new Report()
  emit(shape({ shape: 'line', strokeWidth: 2, from: { el: 'other', side: 'auto' } }), r)
  ok(codes(r).includes('connector-detached'), 'an anchored connector reports that it stops following its elements')
}

// -----------------------------------------------------------------------------
console.log(`\n${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
