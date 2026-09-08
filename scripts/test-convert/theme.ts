#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/convert theme rig — the colour/font resolver.
//
//   node scripts/test-convert/theme.ts     (Node ≥ 23.6 strips types natively)
//
// Every expected value below is HAND-COMPUTED (worked in the comments), never
// derived by running the module against itself — a resolver checked against
// its own output would agree perfectly, including about its bugs. The two
// traps the spike names get NEGATIVE controls: the naive sRGB-space shade and
// tint values are asserted to be what we do NOT produce (the rig can tell the
// colour spaces apart), and a deliberately swapped clrMap is asserted to
// produce a DIFFERENT bg1 than the standard one (the backwards-clrMap failure,
// made visible instead of silent).

import { parseXml } from '../../kernel/src/convert/xml.ts'
import { parseTheme, resolveColor, resolveFillRef, resolveLnRef } from '../../kernel/src/convert/theme.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

/** A colour container as it appears in spPr — the usual resolveColor input. */
const fill = (inner: string) => parseXml(`<a:solidFill ${A}>${inner}</a:solidFill>`)

// ------------------------------------------------------------------ the theme
const themeXml = parseXml(`<a:theme ${A} name="rig">
  <a:themeElements>
    <a:clrScheme name="rig">
      <a:dk1><a:sysClr val="windowText" lastClr="0A0A0A"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="EEEEEE"/></a:lt1>
      <a:dk2><a:srgbClr val="1E2A3A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="4488CC"/></a:accent1>
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
        <a:solidFill><a:schemeClr val="phClr"><a:lumMod val="75000"/></a:schemeClr></a:solidFill>
        <a:gradFill><a:gsLst>
          <a:gs pos="0"><a:schemeClr val="phClr"/></a:gs>
          <a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="50000"/></a:schemeClr></a:gs>
        </a:gsLst><a:lin ang="5400000"/></a:gradFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"><a:shade val="50000"/></a:schemeClr></a:solidFill></a:ln>
      </a:lnStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:srgbClr val="123456"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`)

const stdMap = parseXml(`<p:clrMap ${P} bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>`)
const swappedMap = parseXml(`<p:clrMap ${P} bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>`)

// --------------------------------------------------- parseTheme + clrMap swap
const theme = parseTheme(themeXml, stdMap)
{
  ok(theme.scheme.dk1 === '#0A0A0A', 'sysClr scheme slot reads its lastClr (dk1 = #0A0A0A)')
  ok(theme.scheme.accent1 === '#4488CC', 'srgbClr scheme slot reads its val (accent1 = #4488CC)')
  ok(theme.scheme.bg1 === '#EEEEEE', 'standard clrMap routes bg1 → lt1')
  ok(theme.scheme.tx1 === '#0A0A0A', 'standard clrMap routes tx1 → dk1')
  ok(theme.scheme.lt1 === '#EEEEEE', 'raw slot names stay resolvable beside the logical ones')
  ok(theme.majorFont === 'Georgia' && theme.minorFont === 'Verdana', 'fontScheme major/minor latin typefaces')
  ok(theme.fillStyles.length === 3 && theme.lineStyles.length === 2 && theme.bgFillStyles.length === 1,
    'fmtScheme style lists collected in order (3 fills, 2 lines, 1 bg fill)')

  // NEGATIVE CONTROL — the backwards-clrMap failure made visible: a swapped
  // map must give a DIFFERENT bg1, or the resolver is ignoring the map and
  // dark-on-dark section slides would render without a peep.
  const swapped = parseTheme(themeXml, swappedMap)
  ok(swapped.scheme.bg1 === '#0A0A0A', 'swapped clrMap routes bg1 → dk1')
  ok(swapped.scheme.bg1 !== theme.scheme.bg1, 'NEGATIVE: swapped map differs from standard — the map is actually read')

  const unmapped = parseTheme(themeXml, undefined)
  ok(unmapped.scheme.bg1 === '#EEEEEE' && unmapped.scheme.tx1 === '#0A0A0A',
    'absent clrMap falls back to the standard bg1→lt1 / tx1→dk1 map')
}

// ----------------------------------------------------------- base colour kinds
{
  const c = resolveColor(fill('<a:srgbClr val="FBAE40"/>'), theme)
  ok(c?.css === '#FBAE40' && c.alpha === 1 && c.from === 'own', 'srgbClr passes through untouched, from:own')

  const s = resolveColor(fill('<a:schemeClr val="accent1"/>'), theme)
  ok(s?.css === '#4488CC' && s.from === 'theme', 'schemeClr resolves through the scheme, from:theme')

  const sys = resolveColor(fill('<a:sysClr val="windowText" lastClr="2B2B2B"/>'), theme)
  ok(sys?.css === '#2B2B2B', 'sysClr uses its lastClr attribute')

  const prst = resolveColor(fill('<a:prstClr val="black"/>'), theme)
  ok(prst?.css === '#000000', 'prstClr black (618 census uses) resolves')
  ok(resolveColor(fill('<a:prstClr val="dkBlue"/>'), theme)?.css === '#00008B',
    'prstClr abbreviated spelling normalizes (dkBlue → darkBlue #00008B)')

  ok(resolveColor(fill('<a:schemeClr val="nope"/>'), theme) === undefined, 'unknown scheme name is undefined, never a guess')
  ok(resolveColor(undefined, theme) === undefined, 'undefined container is undefined')
  ok(resolveColor(parseXml(`<a:solidFill ${A}/>`), theme) === undefined, 'container with no colour child is undefined')
}

// --------------------------------------------------------------------- alpha
{
  const c = resolveColor(fill('<a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr>'), theme)
  ok(c?.css === 'rgba(255,0,0,0.5)' && c.alpha === 0.5, 'a:alpha 50% emits rgba(255,0,0,0.5)')
}

// ------------------------------------------------------------------ HSL space
{
  // lumMod 75% of #4488CC, by hand: rgb (68,136,204)/255 → max .8 min .26667,
  // L = .53333, d = .53333, S = d/(2-max-min) = .53333/.93333 = .571429,
  // H: max is blue → ((r-g)/d + 4)·60 = (-.5+4)·60 = 210°.
  // L·.75 = .4 → q = .4·1.571429 = .628571, p = .171429.
  // R(t=.91667→p) = .171429·255 = 43.71 → 44 (2C); G = L = .4·255 = 102 (66);
  // B = q = .628571·255 = 160.29 → 160 (A0).
  const c = resolveColor(fill('<a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr>'), theme)
  ok(c?.css === '#2C66A0', 'lumMod 75% of #4488CC = #2C66A0 (hand-computed HSL)')
}

// ------------------------------------------------------- linear-light space
{
  // shade 50% of #808080, by hand in LINEAR light: (128/255)^2.2 = .21952,
  // ·.5 = .10976, ^(1/2.2) = .36640, ·255 = 93.4 → 93 → #5D5D5D.
  // The naive sRGB multiply gives 128·.5 = 64 → #404040 — a DIFFERENT channel
  // value, which is how this rig tells the two spaces apart.
  const sh = resolveColor(fill('<a:srgbClr val="808080"><a:shade val="50000"/></a:srgbClr>'), theme)
  ok(sh?.css === '#5D5D5D', 'shade 50% of #808080 = #5D5D5D (linear-light, hand-computed)')
  ok(sh?.css !== '#404040', 'NEGATIVE: shade is NOT the naive sRGB multiply (#404040)')

  // tint 50% toward white: .21952·.5 + .5 = .60976, ^(1/2.2) = .79869,
  // ·255 = 203.7 → 204 → #CCCCCC. Naive: 128 + .5·127 = 191.5 → 192 → #C0C0C0.
  const ti = resolveColor(fill('<a:srgbClr val="808080"><a:tint val="50000"/></a:srgbClr>'), theme)
  ok(ti?.css === '#CCCCCC', 'tint 50% of #808080 = #CCCCCC (linear-light, hand-computed)')
  ok(ti?.css !== '#C0C0C0', 'NEGATIVE: tint is NOT the naive sRGB interpolation (#C0C0C0)')
}

// ------------------------------------------------------------ document order
{
  // On accent1 (H 210°, S .571429, L .533333):
  //   lumMod 50 then lumOff 25:  L = .533333·.5 + .25 = .516667
  //     q = L+S−L·S = .792857, p = .240476 → R 61 (3D), G = L·255 = 131.75 →
  //     132 (84), B = q·255 = 202.2 → 202 (CA)  → #3D84CA
  //   lumOff 25 then lumMod 50:  L = (.533333+.25)·.5 = .391667
  //     q = L·(1+S) = .615476, p = .167857 → R 42.8 → 43 (2B), G = 99.875 →
  //     100 (64), B = 156.9 → 157 (9D)          → #2B649D
  const ab = resolveColor(fill('<a:schemeClr val="accent1"><a:lumMod val="50000"/><a:lumOff val="25000"/></a:schemeClr>'), theme)
  const ba = resolveColor(fill('<a:schemeClr val="accent1"><a:lumOff val="25000"/><a:lumMod val="50000"/></a:schemeClr>'), theme)
  ok(ab?.css === '#3D84CA', 'lumMod then lumOff = #3D84CA (hand-computed)')
  ok(ba?.css === '#2B649D', 'lumOff then lumMod = #2B649D (hand-computed)')
  ok(ab?.css !== ba?.css, 'NEGATIVE: transform order matters — reversing it changes the colour')
}

// ------------------------------------------------------------------- phClr
{
  const c = resolveColor(fill('<a:schemeClr val="phClr"/>'), theme, '#FBAE40')
  ok(c?.css === '#FBAE40', 'schemeClr val="phClr" substitutes the placeholder colour')
  ok(resolveColor(fill('<a:schemeClr val="phClr"/>'), theme) === undefined,
    'phClr with no substitution available is undefined, not black')
}

// ------------------------------------------------------------ the style matrix
{
  ok(resolveFillRef(0, '#FBAE40', theme)?.kind === 'none', 'fillRef idx 0 is an intentional none')

  const f1 = resolveFillRef(1, '#FBAE40', theme)
  ok(f1?.kind === 'solid' && f1.color.css === '#FBAE40', 'fillRef idx 1 = fillStyleLst[0], phClr substituted')

  const f2 = resolveFillRef(2, '#4488CC', theme)
  ok(f2?.kind === 'solid' && f2.color.css === '#2C66A0', 'fillRef idx 2 applies the entry\'s own transforms to phClr')

  const f3 = resolveFillRef(3, '#4488CC', theme)
  ok(f3?.kind === 'other' && f3.el.local === 'gradFill' && f3.phClr === '#4488CC',
    'fillRef onto a gradFill hands the raw entry + phClr through for shapes.ts')

  const bg = resolveFillRef(1001, '#4488CC', theme)
  ok(bg?.kind === 'solid' && bg.color.css === '#123456', 'fillRef idx 1001 = bgFillStyleLst[0]')

  ok(resolveFillRef(99, '#4488CC', theme) === undefined, 'NEGATIVE: out-of-range fillRef is undefined, not silently none')

  ok(resolveLnRef(0, '#FBAE40', theme)?.kind === 'none', 'lnRef idx 0 is none')
  const l1 = resolveLnRef(1, '#FBAE40', theme)
  ok(l1?.kind === 'ln' && l1.ln.attrs.get('w') === '9525' && l1.color?.css === '#FBAE40',
    'lnRef idx 1 carries the raw a:ln (width readable) with its solid colour resolved')
  const l2 = resolveLnRef(2, '#808080', theme)
  ok(l2?.kind === 'ln' && l2.color?.css === '#5D5D5D', 'lnRef idx 2 shades phClr in linear light (#5D5D5D again)')
  ok(resolveLnRef(9, '#808080', theme) === undefined, 'out-of-range lnRef is undefined')
}

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`)
process.exit(failures ? 1 : 0)
