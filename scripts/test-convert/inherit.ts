#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/convert inheritance-resolver rig.
//
//   node scripts/test-convert/inherit.ts     (Node ≥ 23.6 strips types natively)
//
// Hand-built master/layout/slide trees with hand-computed expected values, so
// nothing here is "the resolver agrees with itself". The scenarios are the
// census traps, each with its wrong-implementation counterpart demonstrated
// inline as the NEGATIVE control:
//
//   • a slide title written `<p:ph/>` (no type — the census records ZERO
//     type="title" slide placeholders) must pair with the layout's title by
//     idx-0 default; the rig computes what a type-first matcher would pick
//     and asserts it is the WRONG shape, so the check fails on that design.
//   • buNone at a nearer source must SILENCE the master's buChar; the rig
//     computes what a property-merging resolver would emit (a live bullet)
//     and asserts ours does not.
//   • sz is centipoints; lIns="0" is an explicit zero, not an absence.
//   • a frame absent everywhere is zero + a report entry, never invented.

import { parseXml, kid, kids, descendants, attr, NS } from '../../kernel/src/convert/xml.ts'
import type { XElem } from '../../kernel/src/convert/xml.ts'
import { Report } from '../../kernel/src/convert/report.ts'
import type { ThemeCtx, InheritCtx } from '../../kernel/src/convert/types.ts'
import {
  placeholderChain, labeledChain, effectivePhType, resolveFrame, textDefaults, bodyInsets,
} from '../../kernel/src/convert/inherit.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const XMLNS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

// --------------------------------------------------------------- the fixtures

const master = parseXml(`<p:sldMaster ${XMLNS}>
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="master-title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr lIns="0"/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="master-body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="4351338"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr tIns="91440"/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
  <p:txStyles>
    <p:titleStyle>
      <a:lvl1pPr algn="ctr"><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr>
    </p:titleStyle>
    <p:bodyStyle>
      <a:lvl1pPr algn="l"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="1000"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="2800"/></a:lvl1pPr>
      <a:lvl2pPr><a:buFont typeface="Arial"/><a:buChar char="–"/><a:defRPr sz="2400"/></a:lvl2pPr>
    </p:bodyStyle>
    <p:otherStyle>
      <a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr>
    </p:otherStyle>
  </p:txStyles>
</p:sldMaster>`)

const layout = parseXml(`<p:sldLayout ${XMLNS}>
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="layout-title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="9144000" cy="1143000"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></a:lstStyle><a:p/></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="layout-body1"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr rIns="0"/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="4" name="layout-decoy5"/><p:cNvSpPr/><p:nvPr><p:ph idx="5"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="111" y="222"/><a:ext cx="333" cy="444"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sldLayout>`)

const slide = parseXml(`<p:sld ${XMLNS}>
  <p:cSld><p:spTree>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="10" name="slide-title"/><p:cNvSpPr/><p:nvPr><p:ph/></p:nvPr></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="11" name="slide-body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr lIns="182880"/><a:lstStyle><a:lvl1pPr><a:buNone/></a:lvl1pPr></a:lstStyle><a:p/></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="12" name="slide-plain-body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="13" name="slide-idx5"/><p:cNvSpPr/><p:nvPr><p:ph idx="5"/></p:nvPr></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="14" name="slide-fallback"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="3"/></p:nvPr></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="15" name="slide-ctr"/><p:cNvSpPr/><p:nvPr><p:ph type="ctrTitle" idx="9"/></p:nvPr></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="16" name="slide-own"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm rot="5400000" flipH="1"><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="17" name="slide-orphan"/><p:cNvSpPr/><p:nvPr><p:ph type="pic" idx="7"/></p:nvPr></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="18" name="slide-noph"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`)

const theme: ThemeCtx = {
  scheme: {}, majorFont: 'TestMajor', minorFont: 'TestMinor',
  fillStyles: [], lineStyles: [], bgFillStyles: [],
}
const report = new Report()
const ctx: InheritCtx = { slide, layout, master, theme, report }

function nameOf(shape: XElem): string {
  for (const c of kids(shape)) {
    const cnv = kid(c, NS.p, 'cNvPr')
    if (cnv) return attr(cnv, 'name') ?? '?'
  }
  return '?'
}
function sp(root: XElem, name: string): XElem {
  for (const s of descendants(root, NS.p, 'sp')) if (nameOf(s) === name) return s
  throw new Error(`no sp named ${name}`)
}
function phTypeOf(shape: XElem): string | undefined {
  for (const c of kids(shape)) {
    const nv = kid(c, NS.p, 'nvPr')
    const ph = nv ? kid(nv, NS.p, 'ph') : undefined
    if (ph) return attr(ph, 'type')
  }
  return undefined
}

// ------------------------------------------------- chain matching (idx first)
{
  // The census-critical case: a slide title is `<p:ph/>` — no type, no idx.
  // Absent idx defaults to 0 on BOTH sides, which is the only thing that pairs
  // it with the layout's `<p:ph type="title"/>`.
  const chain = placeholderChain(sp(slide, 'slide-title'), ctx)
  ok(chain.length === 3, 'bare <p:ph/> chain reaches shape + layout + master')
  ok(nameOf(chain[1]) === 'layout-title', 'and the layout match is the TITLE (idx-0 default), not a body')
  ok(nameOf(chain[2]) === 'master-title', 'and the master match is the master title')

  // NEGATIVE control: what a type-first matcher would have picked. `<p:ph/>`
  // normalizes to 'body', so type matching lands on layout-body1 — the wrong
  // shape. Seen to fail: swapping the module to type-first matching makes the
  // chain check above pick layout-body1.
  const typeFirst = descendants(layout, NS.p, 'sp').find((s) => {
    const t = phTypeOf(s)
    return t === undefined || t === 'body'
  })
  ok(typeFirst !== undefined && nameOf(typeFirst) === 'layout-body1',
    'negative control: a type-first matcher WOULD grab layout-body1 for the bare title ph')

  // idx beats type: slide idx=5 must take the idx-5 decoy even though a typed
  // body (idx=1) appears earlier in document order.
  const c5 = placeholderChain(sp(slide, 'slide-idx5'), ctx)
  ok(nameOf(c5[1]) === 'layout-decoy5', 'idx-match beats type-match (idx=5 takes the decoy, not the first body)')

  // type fallback fires only when no candidate shares the idx
  const cf = placeholderChain(sp(slide, 'slide-fallback'), ctx)
  ok(nameOf(cf[1]) === 'layout-body1', 'idx=3 matches nothing, so type="body" falls back to the body placeholder')
  ok(nameOf(cf[2]) === 'master-body', 'and the master hop matches by the layout ph')

  // ctrTitle ≡ title (idx=9 forces the type path)
  const cc = placeholderChain(sp(slide, 'slide-ctr'), ctx)
  ok(nameOf(cc[1]) === 'layout-title', 'ctrTitle matches a title placeholder')

  const cn = placeholderChain(sp(slide, 'slide-noph'), ctx)
  ok(cn.length === 1, 'a non-placeholder shape has a one-link chain')

  ok(effectivePhType(sp(slide, 'slide-title'), ctx) === 'title',
    'effectivePhType lifts "title" from the layout side (the slide ph never says it)')
  ok(effectivePhType(sp(slide, 'slide-body'), ctx) === 'body', 'and a typeless body resolves to "body"')
  ok(effectivePhType(sp(slide, 'slide-noph'), ctx) === '', 'and a non-placeholder to ""')
}

// ------------------------------------------------------------------- frames
{
  const f1 = resolveFrame(sp(slide, 'slide-title'), ctx)
  ok(f1.x === 914400 && f1.y === 457200 && f1.w === 9144000 && f1.h === 1143000,
    'a slide with no xfrm takes its frame from the layout placeholder')
  ok(f1.from === 'layout', 'and says so (provenance layout)')

  const f2 = resolveFrame(sp(slide, 'slide-plain-body'), ctx)
  ok(f2.x === 838200 && f2.y === 1825625 && f2.w === 10515600 && f2.h === 4351338,
    'slide AND layout silent: the frame comes from the master placeholder')
  ok(f2.from === 'master', 'and says so (provenance master)')

  const f3 = resolveFrame(sp(slide, 'slide-own'), ctx)
  ok(f3.x === 100 && f3.y === 200 && f3.w === 300 && f3.h === 400 && f3.from === 'own',
    'an own xfrm wins over the whole chain')
  ok(f3.rotation === 90, 'rot="5400000" is 60,000ths of a degree → 90°')
  ok(f3.flipH && !f3.flipV, 'flipH="1" reads as a flip, flipV absent does not')

  // absent everywhere: zero, reported, never invented
  const r2 = new Report()
  const f4 = resolveFrame(sp(slide, 'slide-orphan'), { ...ctx, report: r2 })
  ok(f4.x === 0 && f4.y === 0 && f4.w === 0 && f4.h === 0 && f4.from === 'default',
    'a frame absent everywhere is all-zero (never invented)')
  const built = r2.build()
  ok(built.entries.some((e) => e.code === 'frame-missing' && e.verdict === 'dropped' && e.where.includes('slide-orphan')),
    'and lands in the report as frame-missing/dropped naming the shape')

  ok(report.build().provenance['frame:layout'] >= 1 && report.build().provenance['frame:master'] >= 1,
    'frame provenance is tallied per level')
}

// ------------------------------------------------------------- text defaults
{
  // title: sz from the LAYOUT lstStyle (3200 centipoints), everything else
  // from the master's titleStyle — per-property nearest-wins, not per-source.
  const t = textDefaults(sp(slide, 'slide-title'), ctx, 0, 'title')
  ok(t.fontSize === 32, 'layout lstStyle sz="3200" resolves to 32pt (centipoints ÷ 100) and beats the master’s 44')
  ok(t.fontSize !== 3200, 'negative control: a resolver skipping the ÷100 would say 3200')
  ok(t.bold === true, 'bold still comes from the master titleStyle (layout is silent on it)')
  ok(t.font === 'TestMajor', '+mj-lt resolves through ThemeCtx.majorFont')
  ok(t.align === 'center', 'algn="ctr" → center')
  ok(t.color !== undefined && t.color.local === 'schemeClr' && attr(t.color, 'val') === 'tx1',
    'the colour comes back as the raw element for theme.resolveColor')

  // body level 2 (0-based 1): master bodyStyle lvl2pPr
  const b2 = textDefaults(sp(slide, 'slide-plain-body'), ctx, 1, 'body')
  ok(b2.fontSize === 24, 'level 1 (lvl2pPr) fontSize comes from master bodyStyle: 24pt')
  ok(b2.bullet.kind === 'char' && b2.bullet.char === '–', 'and its own level’s bullet (–), not lvl1’s')

  // body level 1: the full bodyStyle lvl1 row
  const b1 = textDefaults(sp(slide, 'slide-plain-body'), ctx, 0, 'body')
  ok(b1.fontSize === 28 && b1.align === 'left', 'bodyStyle lvl1: 28pt, left')
  ok(b1.lineHeight === 0.9, 'lnSpc spcPct val="90000" → 0.9')
  ok(b1.hasSpcBef && !b1.hasSpcAft, 'spcBef presence is surfaced for the caller to report')
  ok(b1.bullet.kind === 'char' && b1.bullet.char === '•' && b1.bullet.font === 'Arial',
    'an untouched body inherits the master’s • bullet with its buFont')
  ok(b1.font === 'TestMinor', 'no latin anywhere → the minor (body) theme face')

  // THE PRECEDENCE TRAP: slide-body carries <a:buNone/> in its own lstStyle.
  const bn = textDefaults(sp(slide, 'slide-body'), ctx, 0, 'body')
  ok(bn.bullet.kind === 'none', 'buNone at the shape SILENCES the master’s inherited buChar')
  // NEGATIVE control: a property-merging resolver unions the sources, and the
  // master's buChar survives the union — demonstrate the wrong answer is live
  // in this data, then that ours differs from it. Seen to fail: making the
  // module scan past a buNone-only source to the next buChar flips bn to 'char'.
  const merged = (() => {
    const styles = kid(master, NS.p, 'txStyles')!
    const lvl1 = kid(kid(styles, NS.p, 'bodyStyle')!, NS.a, 'lvl1pPr')!
    return kid(lvl1, NS.a, 'buChar') ? 'char' : 'none'
  })()
  ok(merged === 'char', 'negative control: a merging resolver would emit the master’s bullet here')
  ok(bn.bullet.kind !== merged, 'and ours does not')
  ok(bn.fontSize === 28, 'while sz still flows past the buNone source (per-property, per-bullet-unit)')

  // non-placeholder → otherStyle
  const o = textDefaults(sp(slide, 'slide-noph'), ctx, 0, '')
  ok(o.fontSize === 18, 'a non-placeholder resolves through otherStyle (18pt)')
  ok(o.bullet.kind === 'none' && o.lineHeight === 1, 'and gets the quiet defaults: no bullet, single spacing')
}

// --------------------------------------------------------------- body insets
{
  // Explicit zero is a value, not an absence — a falsy check re-defaults to
  // 91440 and mis-widens the title by ~19px.
  const ti = bodyInsets(sp(slide, 'slide-title'), ctx)
  ok(ti.l === 0, 'master title lIns="0" survives as an explicit zero')
  ok(ti.t === 45720 && ti.r === 91440 && ti.b === 45720, 'unspecified insets take the OOXML defaults')

  // per-attribute walk: each side may come from a different level
  const bi = bodyInsets(sp(slide, 'slide-body'), ctx)
  ok(bi.l === 182880, 'own bodyPr lIns wins')
  ok(bi.r === 0, 'rIns="0" comes from the layout placeholder')
  ok(bi.t === 91440, 'tIns comes from the master placeholder')
  ok(bi.b === 45720, 'and bIns, said nowhere, is the 45720 default')

  const ni = bodyInsets(sp(slide, 'slide-noph'), ctx)
  ok(ni.l === 91440 && ni.t === 45720 && ni.r === 91440 && ni.b === 45720,
    'no bodyPr attrs anywhere → all four defaults')
}

// chain shape sanity for downstream: labeledChain labels line up with the els
{
  const lc = labeledChain(sp(slide, 'slide-title'), ctx)
  ok(lc.map((l) => l.from).join(',') === 'own,layout,master', 'labeledChain provenance labels are own,layout,master')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
