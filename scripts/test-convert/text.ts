#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/convert text-mapper rig.
//
//   node scripts/test-convert/text.ts        (Node ≥ 23.6 strips types natively)
//
// Hand-built p:sp fragments with hand-computed expected values, wired to the
// REAL inherit/theme resolvers (that is the deps injection working as
// designed). Each flattening trap carries a NEGATIVE control — the wrong
// implementation's answer computed inline, asserted to differ from ours:
//
//   • sz=1800 must land at 24px, not 18 (pt-as-px) and not 1800 (raw
//     centipoints) — both wrong readings are pinned as inequalities.
//   • two IDENTICALLY styled runs must NOT report run-formatting-flattened
//     (an implementation that reports whenever runs > 1 fails here — seen to
//     fail exactly that way with the variance test replaced by a run count).
//   • a paragraph buNone under an inherited buChar must stay silent, while
//     the defaults provably carry a live bullet (the merged answer).
//   • a literal '<' in a:t must come out as &lt; — the raw-emit answer would
//     open a tag (seen to fail with esc() bypassed: html gained '<script').

import { parseXml, kid, kids, attr, NS } from '../../kernel/src/convert/xml.ts'
import type { XElem } from '../../kernel/src/convert/xml.ts'
import { Report } from '../../kernel/src/convert/report.ts'
import type { ThemeCtx, InheritCtx } from '../../kernel/src/convert/types.ts'
import {
  effectivePhType, textDefaults, resolveFrame, labeledChain,
} from '../../kernel/src/convert/inherit.ts'
import { resolveColor } from '../../kernel/src/convert/theme.ts'
import { textFrom, type TextDeps } from '../../kernel/src/convert/text.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const NBSP = ' '
const XMLNS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

const theme: ThemeCtx = {
  scheme: { tx1: '#101010', accent1: '#4488FF' },
  majorFont: 'TestHead', minorFont: 'TestBody',
  fillStyles: [], lineStyles: [], bgFillStyles: [],
}

// off 9525,19050 ext 952500×476250 EMU = x1 y2 w100 h50 px — hand computed.
const XFRM = '<p:spPr><a:xfrm><a:off x="9525" y="19050"/><a:ext cx="952500" cy="476250"/></a:xfrm></p:spPr>'

/** A standalone (non-placeholder) shape around one txBody. */
function makeSp(txBody: string, name = 't'): XElem {
  return parseXml(`<p:sp ${XMLNS}>
    <p:nvSpPr><p:cNvPr id="7" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    ${XFRM}
    ${txBody}
  </p:sp>`)
}

const dummySlide = parseXml(`<p:sld ${XMLNS}><p:cSld><p:spTree/></p:cSld></p:sld>`)

const refits: string[] = []
const deps: TextDeps = {
  effectivePhType, textDefaults, resolveFrame, labeledChain, resolveColor,
  needsRefit: (id) => refits.push(id),
}

function run(sp: XElem): { out: ReturnType<typeof textFrom>; report: ReturnType<Report['build']> } {
  const report = new Report()
  const ctx: InheritCtx = { slide: dummySlide, theme, report }
  const out = textFrom(sp, ctx, deps)
  return { out, report: report.build() }
}
const has = (r: ReturnType<Report['build']>, code: string): boolean =>
  r.entries.some((e) => e.code === code)

// -------------------------------------------------------- single clean run
{
  const sp = makeSp(`<p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr><a:lstStyle/>
    <a:p><a:r><a:rPr lang="en" sz="1800"><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>Hello</a:t></a:r></a:p>
  </p:txBody>`)
  const { out, report } = run(sp)
  ok(out !== undefined, 'a clean single run emits a text element')
  if (out) {
    ok(out.html === 'Hello', 'html is the bare run text')
    ok(out.fontSize === 24, 'sz="1800" → 18pt → 24px (centipoints ÷ 100, × 4/3)')
    ok(out.fontSize !== 18, 'negative control: a pt-as-px implementation would say 18')
    ok(out.fontSize !== 1800, 'negative control: raw centipoints would say 1800')
    ok(out.color === '#112233', 'run srgbClr resolves through theme.resolveColor')
    ok(out.fontFamily === "Calibri, Carlito, sans-serif", 'Calibri maps to a metric-substitute stack')
    ok(out.x === 1 && out.y === 2 && out.w === 100 && out.h === 50, 'frame is EMU ÷ 9525 in px')
    ok(out.align === 'left' && out.valign === 'top' && out.lineHeight === 1, 'quiet defaults: left, top, single-spaced')
    ok(out.fontWeight === 400, 'no bold anywhere → weight 400')
    ok(out.id === 'txt7', 'id is txt + cNvPr@id')
  }
  ok(has(report, 'font-substituted'), 'and the substitution is reported (approximated)')
  ok(!has(report, 'run-formatting-flattened'), 'a single run never reports flattening')
}

// --------------------------------------------------------- mixed bold/italic
{
  const sp = makeSp(`<p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p>
      <a:r><a:rPr sz="1800"/><a:t>the longest plain stretch </a:t></a:r>
      <a:r><a:rPr sz="1800" b="1"/><a:t>bold</a:t></a:r>
      <a:r><a:rPr sz="1800" i="1" u="sng" strike="sngStrike"/><a:t>ital</a:t></a:r>
    </a:p>
  </p:txBody>`)
  const { out, report } = run(sp)
  ok(out !== undefined && out.html.includes('<b>bold</b>'), 'b="1" survives as <b>')
  ok(out !== undefined && out.html.includes('<i><u><s>ital</s></u></i>'), 'i/u/strike survive as <i><u><s>')
  ok(out !== undefined && out.fontWeight === 400, 'the dominant (plain) run sets the element weight')
  ok(!has(report, 'run-formatting-flattened'),
    'bold/italic carried as tags are NOT flattening (size/colour/family all agree)')
}

// ----------------------------------- dominant-run selection + flatten report
{
  const sp = makeSp(`<p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p>
      <a:r><a:rPr sz="1800"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:rPr><a:t>the long descriptive label</a:t></a:r>
      <a:r><a:rPr sz="4400"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>42%</a:t></a:r>
    </a:p>
  </p:txBody>`)
  const { out, report } = run(sp)
  ok(out !== undefined && out.fontSize === 24 && out.color === '#112233',
    'the element styles after the dominant run by character count')
  ok(has(report, 'run-formatting-flattened'), 'and the disagreement is reported once')

  // NEGATIVE control: identical styling across two runs must stay silent. An
  // implementation keyed on run COUNT (rather than style variance) fails this
  // — seen to fail exactly so with the variance test swapped for pieces>1.
  const same = makeSp(`<p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p>
      <a:r><a:rPr sz="1800"/><a:t>two runs, </a:t></a:r>
      <a:r><a:rPr sz="1800"/><a:t>one style</a:t></a:r>
    </a:p>
  </p:txBody>`)
  const r2 = run(same)
  ok(r2.out !== undefined && !has(r2.report, 'run-formatting-flattened'),
    'negative control: identically-styled runs do NOT report flattening')
}

// ------------------------------------------------------------------ bullets
{
  const sp = makeSp(`<p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p><a:pPr><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr><a:r><a:rPr sz="1800"/><a:t>first point</a:t></a:r></a:p>
    <a:p><a:pPr><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr><a:r><a:rPr sz="1800"/><a:t>second point</a:t></a:r></a:p>
  </p:txBody>`)
  const { out, report } = run(sp)
  ok(out !== undefined && out.html === `•${NBSP}first point<br>•${NBSP}second point`,
    'buChar prepends glyph + NBSP per paragraph, paragraphs join with <br>')
  ok(has(report, 'bullet-flattened'), 'and the flattening is reported')

  // buAutoNum freezes to literals, honouring startAt
  const auto = makeSp(`<p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p><a:pPr><a:buAutoNum type="arabicPeriod" startAt="3"/></a:pPr><a:r><a:t>alpha</a:t></a:r></a:p>
    <a:p><a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:t>beta</a:t></a:r></a:p>
  </p:txBody>`)
  const ra = run(auto)
  ok(ra.out !== undefined && ra.out.html === `3.${NBSP}alpha<br>4.${NBSP}beta`,
    'buAutoNum numbers sequentially at convert time (startAt honoured)')
  ok(has(ra.report, 'auto-number-frozen'), 'and reports the freeze')

  // buNone SILENCES an inherited buChar. The shape's own lstStyle carries a
  // live bullet — the merged (wrong) answer — and the paragraph turns it off.
  const none = makeSp(`<p:txBody><a:bodyPr/>
    <a:lstStyle><a:lvl1pPr><a:buFont typeface="Arial"/><a:buChar char="♦"/></a:lvl1pPr></a:lstStyle>
    <a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>no bullet here</a:t></a:r></a:p>
  </p:txBody>`)
  const rn = run(none)
  // negative control: prove the inherited default IS a live bullet, so a
  // property-merging implementation would prepend ♦ here.
  const mergedDefaults = (() => {
    const report = new Report()
    const ctx: InheritCtx = { slide: dummySlide, theme, report }
    return textDefaults(none, ctx, 0, '')
  })()
  ok(mergedDefaults.bullet.kind === 'char', 'negative control: the inherited default carries a live ♦ bullet')
  ok(rn.out !== undefined && rn.out.html === 'no bullet here', 'buNone silences it — no glyph')
  ok(!has(rn.report, 'bullet-flattened'), 'and nothing bullet-shaped is reported')
}

// ---------------------------------------------------------- algn and anchor
{
  const sp = makeSp(`<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/>
    <a:p><a:pPr algn="ctr"/><a:r><a:t>centered</a:t></a:r></a:p>
  </p:txBody>`)
  const { out } = run(sp)
  ok(out !== undefined && out.align === 'center' && out.valign === 'middle',
    'algn="ctr" → center, anchor="ctr" → middle')

  const b = makeSp(`<p:txBody><a:bodyPr anchor="b"/><a:lstStyle/>
    <a:p><a:pPr algn="r"/><a:r><a:t>right-bottom</a:t></a:r></a:p>
  </p:txBody>`)
  const rb = run(b)
  ok(rb.out !== undefined && rb.out.align === 'right' && rb.out.valign === 'bottom',
    'algn="r" → right, anchor="b" → bottom')

  const just = makeSp(`<p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p><a:pPr algn="just"/><a:r><a:t>justified text goes left</a:t></a:r></a:p>
  </p:txBody>`)
  const rj = run(just)
  ok(rj.out !== undefined && rj.out.align === 'left', 'algn="just" approximates to left')
  ok(has(rj.report, 'align-approximated'), 'and is reported')

  // mixed paragraph alignment: dominant wins, disagreement reported
  const mixed = makeSp(`<p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p><a:pPr algn="ctr"/><a:r><a:t>short</a:t></a:r></a:p>
    <a:p><a:r><a:t>the much longer left-aligned body paragraph</a:t></a:r></a:p>
  </p:txBody>`)
  const rm = run(mixed)
  ok(rm.out !== undefined && rm.out.align === 'left', 'mixed alignment: the dominant paragraph wins')
  ok(has(rm.report, 'align-flattened'), 'and the disagreement is reported')
}

// -------------------------------------------- line spacing + paragraph space
{
  const sp = makeSp(`<p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p><a:pPr><a:lnSpc><a:spcPct val="150000"/></a:lnSpc><a:spcBef><a:spcPts val="600"/></a:spcBef></a:pPr><a:r><a:t>spaced</a:t></a:r></a:p>
  </p:txBody>`)
  const { out, report } = run(sp)
  ok(out !== undefined && out.lineHeight === 1.5, 'lnSpc spcPct val="150000" → 1.5')
  ok(has(report, 'paragraph-spacing-dropped'), 'spcBef presence is reported as dropped spacing')
}

// ------------------------------------------------------------------- fields
{
  const sp = makeSp(`<p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p><a:fld id="{X}" type="slidenum"><a:rPr sz="1200"/><a:t>4</a:t></a:fld><a:r><a:rPr sz="1200"/><a:t> of 12</a:t></a:r></a:p>
  </p:txBody>`)
  const { out, report } = run(sp)
  ok(out !== undefined && out.html === '{{page}} of 12', 'a:fld slidenum → {{page}} (never the cached "4")')
  ok(report.entries.length === 0, 'an exact semantic match reports NOTHING — carried, not approximated')

  const dt = makeSp(`<p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p><a:fld id="{Y}" type="datetime1"><a:t>1/1/26</a:t></a:fld></a:p>
  </p:txBody>`)
  const rd = run(dt)
  ok(rd.out !== undefined && rd.out.html === '{{date}}', 'a:fld datetime → {{date}}')
}

// -------------------------------------------------------- autofit / refit
{
  refits.length = 0
  const norm = makeSp(`<p:txBody><a:bodyPr><a:normAutofit fontScale="62500"/></a:bodyPr><a:lstStyle/>
    <a:p><a:r><a:rPr sz="3200"/><a:t>shrunk to fit</a:t></a:r></a:p>
  </p:txBody>`)
  const rn = run(norm)
  // 32pt × 4/3 = 42.6667px, × 0.625 = 26.6667 → 26.67
  ok(rn.out !== undefined && rn.out.fontSize === 26.67, 'normAutofit fontScale="62500" scales 32pt → 26.67px')
  ok(refits.length === 0, 'normAutofit does NOT ask for a refit (the scale is applied here)')

  const spa = makeSp(`<p:txBody><a:bodyPr><a:spAutoFit/></a:bodyPr><a:lstStyle/>
    <a:p><a:r><a:t>grows</a:t></a:r></a:p>
  </p:txBody>`)
  run(spa)
  ok(refits.length === 1 && refits[0] === 'txt7', 'spAutoFit emits a needsRefit hint with the element id')

  const absent = makeSp(`<p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p><a:r><a:t>unfitted</a:t></a:r></a:p>
  </p:txBody>`)
  run(absent)
  ok(refits.length === 2, 'absent autofit also hints (substituted fonts re-wrap)')

  refits.length = 0
  const no = makeSp(`<p:txBody><a:bodyPr><a:noAutofit/></a:bodyPr><a:lstStyle/>
    <a:p><a:r><a:t>fixed</a:t></a:r></a:p>
  </p:txBody>`)
  run(no)
  ok(refits.length === 0, 'noAutofit is an explicit fixed box — no hint')
}

// ------------------------------------------------------------- escaping
{
  const sp = makeSp(`<p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p><a:r><a:t>a &lt;script&gt; &amp; b</a:t></a:r></a:p>
  </p:txBody>`)
  const { out } = run(sp)
  ok(out !== undefined && out.html === 'a &lt;script&gt; &amp; b',
    'literal <, > and & in run text are entity-escaped in the emitted html')
  ok(out !== undefined && !out.html.includes('<script'),
    'negative control: a raw emitter would open a real tag here (seen to fail with esc() bypassed)')
}

// ------------------------------------- defaults: bold weight + fallback ink
{
  const sp = makeSp(`<p:txBody><a:bodyPr/>
    <a:lstStyle><a:lvl1pPr><a:defRPr sz="4400" b="1"/></a:lvl1pPr></a:lstStyle>
    <a:p><a:r><a:t>a heading</a:t></a:r></a:p>
  </p:txBody>`)
  const { out } = run(sp)
  ok(out !== undefined && out.fontWeight === 700, 'defRPr b="1" from the lstStyle → element weight 700')
  ok(out !== undefined && !out.html.includes('<b>'), 'and NOT doubled as a <b> tag')
  ok(out !== undefined && out.color === '#101010', 'no colour anywhere → the theme’s tx1 ink')
  ok(out !== undefined && out.fontFamily.startsWith('TestBody'), 'no latin anywhere → the minor theme face')
}

// ------------------------------------------------------------ empty bodies
{
  const empty = makeSp(`<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr/><a:endParaRPr lang="en"/></a:p></p:txBody>`)
  const { out, report } = run(empty)
  ok(out === undefined, 'a txBody with no visible text emits nothing')
  ok(report.entries.length === 0, 'and leaves no reports about the element it never was')

  const noBody = parseXml(`<p:sp ${XMLNS}><p:nvSpPr><p:cNvPr id="9" name="pic-ish"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>${XFRM}</p:sp>`)
  ok(run(noBody).out === undefined, 'a shape without p:txBody emits nothing')
}

// -------------------------------------------------- a:br and blank paragraphs
{
  const sp = makeSp(`<p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p><a:r><a:t>line one</a:t></a:r><a:br/><a:r><a:t>line two</a:t></a:r></a:p>
    <a:p/>
    <a:p><a:r><a:t>after the gap</a:t></a:r></a:p>
    <a:p><a:endParaRPr/></a:p>
  </p:txBody>`)
  const { out } = run(sp)
  ok(out !== undefined && out.html === 'line one<br>line two<br><br>after the gap',
    'a:br is <br>, an interior empty paragraph is a blank line, trailing empties are trimmed')
}

// sanity: the deps object really is wired to the shipping resolvers
{
  const chain = labeledChain(makeSp('<p:txBody><a:bodyPr/><a:p/></p:txBody>'), {
    slide: dummySlide, theme, report: new Report(),
  })
  ok(chain.length === 1 && chain[0].from === 'own', 'deps wire the real inherit resolver (not a stub)')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
