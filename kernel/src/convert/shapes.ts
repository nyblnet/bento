// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Geometry, fills and groups: p:sp / p:cxnSp / p:grpSp → OutShape.
//
// The census makes this module's budget clear: the entire preset vocabulary of
// six real decks is 12 names, a:custGeom is ZERO, and rect/roundRect/ellipse/
// line cover 95.9% of 4,927 shapes. So there is no geometry engine here — a
// map for the exact presets, three-and-a-half path generators for the rest
// (chevron 89, upArrowCallout 35, round2SameRect 32, bentConnector2/3/4 27),
// and 'rect' + a report for anything outside the census.
//
// Where the actual work lives, per the spike:
//
//   - 1,727 shapes carry NO local fill: it comes from p:style's a:fillRef into
//     the theme's fillStyleLst with phClr substituted — read only spPr and
//     they render unfilled with no error to notice. Same for a:lnRef strokes.
//   - An EMPTY <a:effectLst/> is an OVERRIDE that cancels an inherited effect;
//     only a chain level with no effectLst at all defers downward. Presence
//     and emptiness are therefore distinguished when walking the chain.
//   - Bento line shapes take their colour from `fill`, not `stroke` (the
//     stroke attr is what morphs tween) — shape 'line' gets BOTH set.
//   - flipH/flipV (68+22 slide-level uses in the re-census) have no bento
//     field. Where the flip is free it is CONSUMED exactly: line endpoints
//     swap, synthesized path coordinates mirror, a flipV triangle becomes a
//     path, a gradient angle mirrors. Only a flip nothing can absorb is
//     reported ('flip-dropped').
//
// ID SCHEME (integrator contract): a shape's element id is
// `s<slideIndex>-<cNvPr id>` — deterministic, so connector a:stCxn/a:endCxn
// refs resolve WITHOUT a lookup table (deps.spIds only validates existence;
// a dangling ref drops that end with a report). A source group's members share
// groupId `s<slideIndex>-g<cNvPr id>`; a filled box with text in it (the
// spike's ~1,000-per-corpus split case) reserves `s<slideIndex>-<spId>-g` —
// see ShapeResult.textGroupId. The morph/identity pass may rewrite ids later;
// within one slide's conversion they are stable.

import { NS, kid, kids, attr, intAttr, textOf, descendants, type XElem } from './xml.ts'
import {
  EMU_PER_PX,
  type InheritCtx, type OutShape, type OutGradient, type OutShadow,
} from './types.ts'
import { resolveColor, resolveFillRef, resolveLnRef, type ColorResult } from './theme.ts'
import { resolveFrame, labeledChain } from './inherit.ts'
import type { Provenance } from './report.ts'

// --- small arithmetic --------------------------------------------------------

/** EMU → px, 1/100px precision (the engine-wide convention media.ts set). */
const px = (emu: number): number => Math.round((emu / EMU_PER_PX) * 100) / 100
const r2 = (v: number): number => Math.round(v * 100) / 100
const pin = (lo: number, v: number, hi: number): number => Math.min(Math.max(v, lo), hi)
const DEG = Math.PI / 180

/** Report `where` — slide plus the shape's authored name. */
function whereOf(sp: XElem, slideIndex: number): string {
  for (const c of kids(sp)) {
    const cnv = kid(c, NS.p, 'cNvPr')
    if (cnv) {
      const name = attr(cnv, 'name')
      return `slide ${slideIndex} / sp ${name ? `"${name}"` : attr(cnv, 'id') ?? '?'}`
    }
  }
  return `slide ${slideIndex} / sp`
}

function cNvPrId(sp: XElem): string {
  for (const c of kids(sp)) {
    const cnv = kid(c, NS.p, 'cNvPr')
    if (cnv) return attr(cnv, 'id') ?? '0'
  }
  return '0'
}

// --- public types ------------------------------------------------------------

/** A frame in EMU + degrees — resolveFrame's shape, minus provenance. */
export interface GroupFrame {
  x: number; y: number; w: number; h: number
  rotation: number
  flipH: boolean
  flipV: boolean
}

export interface ShapeDeps {
  /** 1-based slide position — the id scheme needs it */
  slideIndex: number
  /** cNvPr ids present on the slide; connector refs outside it are dangling */
  spIds?: Set<string>
  /** absolute frame override (EMU) — groupChildren computed it; when set the
   *  placeholder chain walk is skipped */
  frame?: GroupFrame
  /** group membership — groupChildren minted it */
  groupId?: string
}

export interface ShapeResult {
  shape: OutShape
  /**
   * Set when the sp ALSO carries text (the box-with-text split): the
   * integrator must emit the text element with THIS groupId, placed
   * immediately AFTER the shape in the element array — later paints above,
   * so the text sits on the box. The shape's own groupId is already set.
   */
  textGroupId?: string
}

// --- adjust values -----------------------------------------------------------

/** a:avLst gd name→val. An EMPTY <a:avLst/> (the overwhelmingly common form)
 *  reads the same as an absent one: every preset default applies. */
function adjOf(geom: XElem | undefined): Map<string, number> {
  const out = new Map<string, number>()
  const av = geom && kid(geom, NS.a, 'avLst')
  if (!av) return out
  for (const gd of kids(av, NS.a, 'gd')) {
    const name = attr(gd, 'name')
    const fmla = attr(gd, 'fmla') ?? ''
    const m = /^val (-?\d+)$/.exec(fmla)
    if (name && m) out.set(name, parseInt(m[1], 10))
  }
  return out
}

// --- path synthesis ----------------------------------------------------------

// Paths are synthesized at the element's REAL px size (pathBox = [0,0,w,h])
// rather than a fixed 100×100: preset guides scale by min(w,h), so a fixed
// box would bake the wrong aspect into every non-square shape. pathBox
// stretches on later resize, exactly like any bento path.

type Seg =
  | { c: 'M' | 'L'; x: number; y: number }
  | { c: 'A'; r: number; x: number; y: number }
  | { c: 'Z' }

/** Serialize, baking flips into the coordinates. Mirroring across ONE axis
 *  reverses arc orientation, so the sweep flag toggles with flipH xor flipV. */
function serializeSegs(segs: Seg[], w: number, h: number, flipH: boolean, flipV: boolean): string {
  const fx = (x: number) => r2(flipH ? w - x : x)
  const fy = (y: number) => r2(flipV ? h - y : y)
  const sweep = flipH !== flipV ? 0 : 1
  return segs
    .map((s) => s.c === 'Z' ? 'Z'
      : s.c === 'A' ? `A${r2(s.r)} ${r2(s.r)} 0 0 ${sweep} ${fx(s.x)} ${fy(s.y)}`
        : `${s.c}${fx(s.x)} ${fy(s.y)}`)
    .join(' ')
}

/** The preset generators. Guides transcribed from ECMA-376's
 *  presetShapeDefinitions (ss = min(w,h), pin = the spec's pin). */
function presetSegs(prst: string, w: number, h: number, adj: Map<string, number>): Seg[] | undefined {
  const ss = Math.min(w, h)
  const a = (name: string, dflt: number) => adj.get(name) ?? dflt
  switch (prst) {
    case 'chevron': {
      const x1 = ss * pin(0, a('adj', 50000), (100000 * w) / ss) / 100000
      return [
        { c: 'M', x: 0, y: 0 }, { c: 'L', x: w - x1, y: 0 }, { c: 'L', x: w, y: h / 2 },
        { c: 'L', x: w - x1, y: h }, { c: 'L', x: 0, y: h }, { c: 'L', x: x1, y: h / 2 },
        { c: 'Z' },
      ]
    }
    case 'upArrowCallout': {
      const a2 = pin(0, a('adj2', 25000), (50000 * w) / ss)
      const a1 = pin(0, a('adj1', 25000), a2 * 2)
      const a3 = pin(0, a('adj3', 25000), (100000 * h) / ss)
      const a4 = pin(0, a('adj4', 64977), 100000 - (a3 * ss) / h)
      const dx1 = (ss * a2) / 100000, dx2 = (ss * a1) / 200000
      const y1 = (ss * a3) / 100000, y2 = h - (h * a4) / 100000
      const hc = w / 2
      return [
        { c: 'M', x: 0, y: y2 }, { c: 'L', x: hc - dx2, y: y2 }, { c: 'L', x: hc - dx2, y: y1 },
        { c: 'L', x: hc - dx1, y: y1 }, { c: 'L', x: hc, y: 0 }, { c: 'L', x: hc + dx1, y: y1 },
        { c: 'L', x: hc + dx2, y: y1 }, { c: 'L', x: hc + dx2, y: y2 }, { c: 'L', x: w, y: y2 },
        { c: 'L', x: w, y: h }, { c: 'L', x: 0, y: h }, { c: 'Z' },
      ]
    }
    case 'round2SameRect': {
      // top pair rounded by adj1, bottom pair by adj2 (default square)
      const r1 = r2((ss * pin(0, a('adj1', 16667), 50000)) / 100000)
      const rb = r2((ss * pin(0, a('adj2', 0), 50000)) / 100000)
      const segs: Seg[] = [{ c: 'M', x: r1, y: 0 }, { c: 'L', x: w - r1, y: 0 }]
      if (r1 > 0) segs.push({ c: 'A', r: r1, x: w, y: r1 })
      segs.push({ c: 'L', x: w, y: h - rb })
      if (rb > 0) segs.push({ c: 'A', r: rb, x: w - rb, y: h })
      segs.push({ c: 'L', x: rb, y: h })
      if (rb > 0) segs.push({ c: 'A', r: rb, x: 0, y: h - rb })
      segs.push({ c: 'L', x: 0, y: r1 })
      if (r1 > 0) segs.push({ c: 'A', r: r1, x: r1, y: 0 })
      segs.push({ c: 'Z' })
      return segs
    }
    case 'bentConnector2':
      return [{ c: 'M', x: 0, y: 0 }, { c: 'L', x: w, y: 0 }, { c: 'L', x: w, y: h }]
    case 'bentConnector3': {
      const x1 = (w * a('adj1', 50000)) / 100000
      return [
        { c: 'M', x: 0, y: 0 }, { c: 'L', x: x1, y: 0 },
        { c: 'L', x: x1, y: h }, { c: 'L', x: w, y: h },
      ]
    }
    case 'bentConnector4': {
      const x1 = (w * a('adj1', 50000)) / 100000
      const y1 = (h * a('adj2', 50000)) / 100000
      return [
        { c: 'M', x: 0, y: 0 }, { c: 'L', x: x1, y: 0 }, { c: 'L', x: x1, y: y1 },
        { c: 'L', x: w, y: y1 }, { c: 'L', x: w, y: h },
      ]
    }
    default:
      return undefined
  }
}

/** Bent connectors are open stroked polylines — never filled, no tip markers
 *  (render.ts only puts markers on shape 'line'). */
const OPEN_PATHS = new Set(['bentConnector2', 'bentConnector3', 'bentConnector4'])

// --- fills -------------------------------------------------------------------

const FILL_LOCALS = new Set(['solidFill', 'gradFill', 'blipFill', 'pattFill', 'grpFill', 'noFill'])

/** First fill element up the placeholder chain — a nearer noFill is a real
 *  declaration, so ANY fill child stops the walk. */
function chainFill(sp: XElem, ctx: InheritCtx): { el: XElem; from: Provenance } | undefined {
  for (const link of labeledChain(sp, ctx)) {
    const spPr = kid(link.el, NS.p, 'spPr')
    const f = spPr && kids(spPr, NS.a).find((k) => FILL_LOCALS.has(k.local))
    if (f) return { el: f, from: link.from }
  }
  return undefined
}

/** First p:style up the chain (a layout placeholder can carry one too). */
function chainStyle(sp: XElem, ctx: InheritCtx): XElem | undefined {
  for (const link of labeledChain(sp, ctx)) {
    const st = kid(link.el, NS.p, 'style')
    if (st) return st
  }
  return undefined
}

/**
 * The phClr a style ref substitutes, as the '#RRGGBB' resolveFillRef requires.
 * Style ref colours with alpha do not occur in the census (theme.ts's note);
 * if one shows up the alpha is stripped and reported rather than failing the
 * whole fill.
 */
function phClrOf(ref: XElem, ctx: InheritCtx, where: string): string {
  const c = resolveColor(ref, ctx.theme)
  if (!c) {
    ctx.report.add('dropped', 'style-color-unresolved', where,
      'p:style reference colour did not resolve — phClr substituted as black')
    return '#000000'
  }
  if (c.css.startsWith('#')) return c.css
  const m = /^rgba\((\d+),(\d+),(\d+),/.exec(c.css)
  if (m) {
    ctx.report.add('approximated', 'phclr-alpha-dropped', where,
      'style reference colour carries alpha — dropped for phClr substitution')
    const h2 = (v: string) => parseInt(v, 10).toString(16).padStart(2, '0').toUpperCase()
    return `#${h2(m[1])}${h2(m[2])}${h2(m[3])}`
  }
  return '#000000'
}

/**
 * a:gradFill → bento GradientFill. ANGLES: OOXML a:lin@ang is 60,000ths of a
 * degree clockwise from 3 o'clock in a y-down space — ang 0 runs left→right,
 * 5400000 (90°) runs top→bottom. Bento/CSS convention (render.ts
 * gradientLineCoords): 0deg = bottom→top, 90deg = left→right, 180deg =
 * top→bottom. Both rotate the same way, offset a quarter turn:
 * css = ooxmlDeg + 90. (The tempting straight read — 5400000 → 90deg CSS —
 * paints every vertical gradient sideways; the rig pins 5400000 → 180.)
 */
function gradientFrom(g: XElem, ctx: InheritCtx, phClr: string | undefined, where: string): OutGradient | undefined {
  const gsLst = kid(g, NS.a, 'gsLst')
  const stops: Array<{ at: number; color: string }> = []
  if (gsLst) {
    for (const gs of kids(gsLst, NS.a, 'gs')) {
      const color = resolveColor(gs, ctx.theme, phClr)
      if (!color) {
        ctx.report.add('dropped', 'gradient-stop-unresolved', where,
          'a gradient stop colour did not resolve and was skipped')
        continue
      }
      stops.push({ at: pin(0, intAttr(gs, 'pos') / 100000, 1), color: color.css })
    }
  }
  stops.sort((s1, s2) => s1.at - s2.at)
  if (stops.length < 2) return undefined

  let angle: number
  const lin = kid(g, NS.a, 'lin')
  if (lin) angle = ((intAttr(lin, 'ang') / 60000 + 90) % 360 + 360) % 360
  else if (kid(g, NS.a, 'path')) {
    ctx.report.add('approximated', 'radial-gradient-linearized', where,
      'radial/path gradient approximated as a vertical linear gradient')
    angle = 180
  } else angle = 90 // no a:lin: OOXML's implicit ang 0, left→right
  return { angle, stops }
}

interface FillOut {
  fill: string
  gradient?: OutGradient
  /** resolution FAILED (reported) — distinct from an intentional noFill; a
   *  failed shape still emits so the report entry has something to point at */
  failed: boolean
}

function resolveShapeFill(sp: XElem, ctx: InheritCtx, style: XElem | undefined, where: string): FillOut {
  const own = chainFill(sp, ctx)
  if (own) {
    switch (own.el.local) {
      case 'noFill':
        ctx.report.trace('fill', own.from)
        return { fill: 'transparent', failed: false }
      case 'solidFill': {
        const c = resolveColor(own.el, ctx.theme)
        if (!c) break
        ctx.report.trace('fill', own.from === 'own' ? c.from : own.from)
        return { fill: c.css, failed: false }
      }
      case 'gradFill': {
        const g = gradientFrom(own.el, ctx, undefined, where)
        if (!g) break
        ctx.report.trace('fill', own.from)
        // solid fallback: the last stop (bento keeps `fill` beneath a gradient)
        return { fill: g.stops[g.stops.length - 1].color, gradient: g, failed: false }
      }
      case 'blipFill':
        ctx.report.add('dropped', 'picture-fill-dropped', where,
          'picture fill on a shape has no bento counterpart — filled transparent')
        return { fill: 'transparent', failed: true }
      default: // pattFill / grpFill: 0/6 in the census
        ctx.report.add('dropped', 'fill-unsupported', where,
          `a:${own.el.local} has no bento counterpart — filled transparent`)
        return { fill: 'transparent', failed: true }
    }
    ctx.report.add('dropped', 'fill-unresolved', where,
      'fill colour did not resolve — filled transparent')
    return { fill: 'transparent', failed: true }
  }

  // no fill element anywhere up the chain: the style matrix (1,727 census
  // shapes live or die on this walk)
  const ref = style && kid(style, NS.a, 'fillRef')
  if (ref) {
    const idx = intAttr(ref, 'idx')
    const got = resolveFillRef(idx, phClrOf(ref, ctx, where), ctx.theme)
    if (!got) {
      ctx.report.add('dropped', 'fill-unresolved', where,
        `a:fillRef idx="${idx}" points outside the theme's fill styles — filled transparent`)
      return { fill: 'transparent', failed: true }
    }
    if (got.kind === 'none') return { fill: 'transparent', failed: false }
    if (got.kind === 'solid') {
      ctx.report.trace('fill', 'theme')
      return { fill: got.color.css, failed: false }
    }
    // 'other': the raw fillStyleLst entry — gradFill here, blipFill never
    // (theme bg image styles are not shape styles in practice)
    if (got.el.local === 'gradFill') {
      const g = gradientFrom(got.el, ctx, got.phClr, where)
      if (g) {
        ctx.report.trace('fill', 'theme')
        return { fill: g.stops[g.stops.length - 1].color, gradient: g, failed: false }
      }
    }
    ctx.report.add('dropped', 'fill-unresolved', where,
      `theme fill style ${idx} (a:${got.el.local}) did not resolve — filled transparent`)
    return { fill: 'transparent', failed: true }
  }

  ctx.report.trace('fill', 'default')
  return { fill: 'transparent', failed: false }
}

// --- strokes -----------------------------------------------------------------

interface LnOut {
  color?: ColorResult
  widthPx: number
  style: 'solid' | 'dashed' | 'dotted'
  start: 'none' | 'arrow' | 'dot' | 'bar'
  end: 'none' | 'arrow' | 'dot' | 'bar'
  failed: boolean
}

const NO_LINE: LnOut = { widthPx: 0, style: 'solid', start: 'none', end: 'none', failed: false }

const dashOf = (v: string | undefined): LnOut['style'] =>
  v === undefined || v === 'solid' ? 'solid' : v === 'dot' || v === 'sysDot' ? 'dotted' : 'dashed'

const tipOf = (v: string | undefined): LnOut['start'] =>
  v === 'triangle' || v === 'arrow' || v === 'stealth' ? 'arrow'
    : v === 'oval' || v === 'diamond' ? 'dot' : 'none'

function chainLn(sp: XElem, ctx: InheritCtx): { el: XElem; from: Provenance } | undefined {
  for (const link of labeledChain(sp, ctx)) {
    const spPr = kid(link.el, NS.p, 'spPr')
    const ln = spPr && kid(spPr, NS.a, 'ln')
    if (ln) return { el: ln, from: link.from }
  }
  return undefined
}

/**
 * The stroke: a local a:ln overrides per-attribute over the lnRef style base
 * (width/dash/tips read local-first), colour precedence local solidFill →
 * lnRef's pre-resolved colour → black (DrawingML's documented line default —
 * an a:ln with no fill child still draws).
 */
function resolveStroke(sp: XElem, ctx: InheritCtx, style: XElem | undefined, where: string): LnOut {
  const own = chainLn(sp, ctx)
  const ref = style && kid(style, NS.a, 'lnRef')
  let styleLn: XElem | undefined
  let styleColor: ColorResult | undefined
  if (ref) {
    const idx = intAttr(ref, 'idx')
    const got = resolveLnRef(idx, phClrOf(ref, ctx, where), ctx.theme)
    if (got === undefined && idx > 0) {
      ctx.report.add('dropped', 'stroke-unresolved', where,
        `a:lnRef idx="${idx}" points outside the theme's line styles — no stroke`)
    } else if (got && got.kind === 'ln') {
      styleLn = got.ln
      styleColor = got.color
      if (!styleColor && kid(got.ln, NS.a, 'gradFill')) {
        const g = gradientFrom(kid(got.ln, NS.a, 'gradFill')!, ctx, got.phClr, where)
        if (g) {
          styleColor = { css: g.stops[0].color, alpha: 1, from: 'theme' }
          ctx.report.add('approximated', 'gradient-stroke-approximated', where,
            'gradient stroke flattened to its first stop colour')
        }
      }
    }
  }
  if (!own && !styleLn) return NO_LINE

  const base = own?.el
  const pick = (name: string): string | undefined =>
    (base && attr(base, name)) ?? (styleLn && attr(styleLn, name))
  const pickKid = (local: string): XElem | undefined =>
    (base && kid(base, NS.a, local)) ?? (styleLn && kid(styleLn, NS.a, local))

  // explicit noFill on the nearest ln = no outline, full stop
  if (base && kid(base, NS.a, 'noFill')) return NO_LINE

  const wAttr = pick('w')
  const widthPx = px(wAttr !== undefined ? parseInt(wAttr, 10) : 9525) // OOXML default: 0.75pt

  let color: ColorResult | undefined
  let failed = false
  const ownFill = base && kid(base, NS.a, 'solidFill')
  if (ownFill) {
    color = resolveColor(ownFill, ctx.theme)
    if (!color) {
      ctx.report.add('dropped', 'stroke-unresolved', where,
        'stroke colour did not resolve — no stroke painted')
      failed = true
    } else ctx.report.trace('stroke', own ? (own.from === 'own' ? color.from : own.from) : 'theme')
  } else if (base && kid(base, NS.a, 'gradFill')) {
    const g = gradientFrom(kid(base, NS.a, 'gradFill')!, ctx, undefined, where)
    if (g) {
      color = { css: g.stops[0].color, alpha: 1, from: 'own' }
      ctx.report.add('approximated', 'gradient-stroke-approximated', where,
        'gradient stroke flattened to its first stop colour')
    } else failed = true
  } else if (styleColor) {
    color = styleColor
    ctx.report.trace('stroke', 'theme')
  } else {
    color = { css: '#000000', alpha: 1, from: 'own' }
    ctx.report.trace('stroke', 'default')
  }

  const dash = pickKid('prstDash')
  const head = pickKid('headEnd')
  const tail = pickKid('tailEnd')
  const out: LnOut = {
    widthPx,
    style: dashOf(dash ? attr(dash, 'val') : undefined),
    start: tipOf(head ? attr(head, 'type') : undefined),
    end: tipOf(tail ? attr(tail, 'type') : undefined),
    failed,
  }
  if (color) out.color = color
  return out
}

// --- effects -----------------------------------------------------------------

/**
 * The chain walk distinguishes PRESENT-BUT-EMPTY from ABSENT (the spike trap):
 * the nearest level carrying an a:effectLst element wins whole — an empty one
 * is an override cancelling an inherited shadow, only a level with no
 * effectLst at all defers to the next.
 */
function resolveShadow(sp: XElem, ctx: InheritCtx, where: string): OutShadow | undefined {
  for (const link of labeledChain(sp, ctx)) {
    const spPr = kid(link.el, NS.p, 'spPr')
    const lst = spPr && kid(spPr, NS.a, 'effectLst')
    if (!lst) continue
    const shdw = kid(lst, NS.a, 'outerShdw')
    for (const other of kids(lst, NS.a)) {
      if (other.local !== 'outerShdw') {
        ctx.report.add('dropped', 'effect-dropped', where,
          `a:${other.local} has no bento counterpart`)
      }
    }
    if (!shdw) return undefined // declared list without outerShdw = no shadow
    const color = resolveColor(shdw, ctx.theme)
    if (!color) {
      ctx.report.add('dropped', 'shadow-color-unresolved', where,
        'outer shadow colour did not resolve — shadow dropped')
      return undefined
    }
    const dist = px(intAttr(shdw, 'dist'))
    const dir = (intAttr(shdw, 'dir') / 60000) * DEG // clockwise from 3 o'clock, y-down — matches CSS offsets
    return {
      x: r2(Math.cos(dir) * dist),
      y: r2(Math.sin(dir) * dist),
      blur: px(intAttr(shdw, 'blurRad')),
      color: color.css,
    }
  }
  return undefined
}

// --- shapeFrom ---------------------------------------------------------------

/** First prstGeom (or custGeom) up the chain — ~513 census shapes carry no
 *  geometry of their own and read the layout placeholder's. */
function chainGeom(sp: XElem, ctx: InheritCtx): XElem | undefined {
  for (const link of labeledChain(sp, ctx)) {
    const spPr = kid(link.el, NS.p, 'spPr')
    const g = spPr && (kid(spPr, NS.a, 'prstGeom') ?? kid(spPr, NS.a, 'custGeom'))
    if (g) return g
  }
  return undefined
}

function hasTextContent(sp: XElem): boolean {
  const tb = kid(sp, NS.p, 'txBody')
  if (!tb) return false
  return textOf(tb).trim() !== '' || descendants(tb, NS.a, 'fld').length > 0
}

/** Mirror a CSS-convention gradient angle: flips a symmetric shape cannot
 *  express still move its gradient, and that part is free to keep exact. */
function mirrorAngle(angle: number, flipH: boolean, flipV: boolean): number {
  let out = angle
  if (flipH) out = (360 - out) % 360
  if (flipV) out = ((180 - out) % 360 + 360) % 360
  return out
}

/**
 * Convert one p:sp or p:cxnSp. Returns undefined for INVISIBLE geometry — the
 * bare text box (noFill, no stroke, no shadow), whose txBody the text module
 * carries alone. A shape whose fill/stroke FAILED to resolve still emits (the
 * report entry needs an element to point at); an intentional noFill does not.
 */
export function shapeFrom(sp: XElem, ctx: InheritCtx, deps: ShapeDeps): ShapeResult | undefined {
  const where = whereOf(sp, deps.slideIndex)
  const spId = cNvPrId(sp)
  const fr = deps.frame ?? resolveFrame(sp, ctx)
  const x = px(fr.x), y = px(fr.y), w = px(fr.w), h = px(fr.h)
  let rotation = r2(fr.rotation)
  let { flipH, flipV } = fr

  const geom = chainGeom(sp, ctx)
  let prst = geom && geom.local === 'prstGeom' ? attr(geom, 'prst') ?? 'rect' : 'rect'
  if (geom && geom.local === 'custGeom') {
    // 0/6 in the census — approximated loudly, never parsed
    ctx.report.add('approximated', 'shape-approximated', where,
      'a:custGeom approximated as a rectangle')
  }
  const adj = adjOf(geom)

  const style = chainStyle(sp, ctx)
  const stroke = resolveStroke(sp, ctx, style, where)

  const shape: OutShape = {
    id: `s${deps.slideIndex}-${spId}`,
    type: 'shape',
    x, y, w, h, rotation,
    opacity: 1,
    shape: 'rect',
    fill: 'transparent',
    stroke: 'transparent',
    strokeWidth: 0,
    radius: 0,
  }

  // ---- line-family presets: bento draws lines horizontally through the box
  // centre and orients by rotation, so the OOXML box diagonal (start at the
  // box's top-left, flips choosing which diagonal) becomes length + angle.
  // Colour-from-fill gotcha: line shapes paint el.fill as the stroke.
  if (prst === 'line' || prst === 'straightConnector1') {
    const color = stroke.color?.css ?? '#000000'
    if (!stroke.color && !stroke.failed) ctx.report.trace('stroke', 'default')
    let p1: [number, number] = [x, y]
    let p2: [number, number] = [x + w, y + h]
    if (flipH) { p1 = [x + w, p1[1]]; p2 = [x, p2[1]] }
    if (flipV) { p1 = [p1[0], y + h]; p2 = [p2[0], y] }
    const len = Math.hypot(w, h)
    const diag = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) / DEG
    const elH = Math.max(stroke.widthPx, 2)
    shape.shape = 'line'
    shape.x = r2(x + w / 2 - len / 2)
    shape.y = r2(y + h / 2 - elH / 2)
    shape.w = r2(len)
    shape.h = r2(elH)
    shape.rotation = r2(rotation + diag)
    shape.fill = color
    shape.stroke = color
    shape.strokeWidth = stroke.widthPx || 1
    if (stroke.style !== 'solid') shape.strokeStyle = stroke.style
    if (stroke.start !== 'none') shape.lineStart = stroke.start
    if (stroke.end !== 'none') shape.lineEnd = stroke.end
    const lnShadow = resolveShadow(sp, ctx, where)
    if (lnShadow) shape.shadow = lnShadow
    attachConnectorEnds(sp, shape, ctx, deps, where)
    if (deps.groupId) shape.groupId = deps.groupId
    return { shape }
  }

  // ---- fills / effects (everything with an interior)
  const fill = resolveShapeFill(sp, ctx, style, where)
  const shadow = resolveShadow(sp, ctx, where)

  const openPath = OPEN_PATHS.has(prst)
  let flipConsumed = false

  // a flipped triangle cannot stay 'triangle' (bento's points up); its
  // synthesized polygon absorbs the flip exactly
  const kindHint =
    prst === 'rect' || prst === 'roundRect' ? 'rect'
      : prst === 'ellipse' ? 'ellipse'
        : prst === 'triangle' ? (flipV ? 'path' : 'triangle')
          : prst === 'rightArrow' ? 'arrow'
            : undefined

  if (kindHint) {
    shape.shape = kindHint
    if (prst === 'roundRect') {
      const a = pin(0, adj.get('adj') ?? 16667, 50000)
      shape.radius = r2((Math.min(w, h) * a) / 100000)
    }
    if (prst === 'triangle' && flipV) {
      shape.d = serializeSegs(
        [{ c: 'M', x: w / 2, y: 0 }, { c: 'L', x: w, y: h }, { c: 'L', x: 0, y: h }, { c: 'Z' }],
        w, h, flipH, flipV)
      shape.pathBox = [0, 0, w, h]
      flipConsumed = true
    }
    // rect/roundRect/ellipse are mirror-symmetric (and a triangle across its
    // vertical axis): a flip only moves a gradient, and mirroring its angle
    // carries that exactly
    if (kindHint === 'rect' || kindHint === 'ellipse' || kindHint === 'triangle') flipConsumed = true
  } else {
    const segs = presetSegs(prst, w, h, adj)
    if (segs) {
      shape.shape = 'path'
      shape.d = serializeSegs(segs, w, h, flipH, flipV)
      shape.pathBox = [0, 0, w, h]
      flipConsumed = true
      if (openPath && (stroke.start !== 'none' || stroke.end !== 'none')) {
        ctx.report.add('approximated', 'connector-tip-dropped', where,
          'bent-connector arrowheads are not rendered on bento path shapes')
      }
    } else {
      shape.shape = 'rect'
      ctx.report.add('approximated', 'shape-approximated', where,
        `preset "${prst}" approximated as a rectangle`)
    }
  }

  if (fill.gradient && !openPath) {
    shape.fillGradient = { ...fill.gradient, angle: mirrorAngle(fill.gradient.angle, flipH, flipV) }
  }
  if (!openPath) shape.fill = fill.fill
  if (stroke.color && stroke.widthPx > 0) {
    shape.stroke = stroke.color.css
    shape.strokeWidth = stroke.widthPx
    if (stroke.style !== 'solid') shape.strokeStyle = stroke.style
  }
  if (shadow) shape.shadow = shadow

  if ((flipH || flipV) && !flipConsumed) {
    ctx.report.add('approximated', 'flip-dropped', where,
      'flipH/flipV have no bento field and this geometry cannot absorb them — rendered unflipped')
  }

  if (openPath) attachConnectorEnds(sp, shape, ctx, deps, where)

  const fillVisible = shape.fill !== 'transparent' || !!shape.fillGradient
  const strokeVisible = shape.strokeWidth > 0 && shape.stroke !== 'transparent'
  const visible = fillVisible || strokeVisible || !!shadow || openPath || fill.failed || stroke.failed
  if (!visible) return undefined

  const out: ShapeResult = { shape }
  if (deps.groupId) shape.groupId = deps.groupId
  if (hasTextContent(sp)) {
    // the box-with-text split: shape now, text (the text module's element)
    // right after it, welded by groupId so they move as the one object the
    // author had
    const gid = deps.groupId ?? `s${deps.slideIndex}-${spId}-g`
    shape.groupId = gid
    out.textGroupId = gid
  }
  return out
}

/** a:stCxn/a:endCxn → from/to on the converter's deterministic ids. A ref to
 *  a shape that is not on the slide is dropped (its end stays free). */
function attachConnectorEnds(sp: XElem, shape: OutShape, ctx: InheritCtx, deps: ShapeDeps, where: string): void {
  const nv = kids(sp).find((c) => kid(c, NS.p, 'cNvCxnSpPr'))
  const cNv = nv && kid(nv, NS.p, 'cNvCxnSpPr')
  if (!cNv) return
  const end = (local: string): { el: string; side: string } | undefined => {
    const e = kid(cNv, NS.a, local)
    if (!e) return undefined
    const id = attr(e, 'id')
    if (!id) return undefined
    if (deps.spIds && !deps.spIds.has(id)) {
      ctx.report.add('dropped', 'connector-ref-dangling', where,
        'connector references a shape id not present on the slide — end left free')
      return undefined
    }
    return { el: `s${deps.slideIndex}-${id}`, side: 'auto' }
  }
  const from = end('stCxn')
  const to = end('endCxn')
  if (from) shape.from = from
  if (to) shape.to = to
}

// --- groups ------------------------------------------------------------------

export interface GroupChild {
  /** p:sp | p:pic | p:graphicFrame | p:cxnSp — nested p:grpSp recursed away */
  el: XElem
  /** absolute slide-space frame (EMU) — feed it back as deps.frame */
  frame: GroupFrame
  /** shared per source group — feed it back as deps.groupId */
  groupId: string
}

/** The child→parent coordinate map one grpSpPr xfrm defines. */
interface GroupMap {
  sx: number; sy: number
  ox: number; oy: number
  chx: number; chy: number
  rot: number
  flipH: boolean; flipV: boolean
  cx: number; cy: number
}

function applyMap(m: GroupMap, f: GroupFrame): GroupFrame {
  // child space → group space: axis-aligned scale + translate
  let fx = m.ox + (f.x - m.chx) * m.sx
  let fy = m.oy + (f.y - m.chy) * m.sy
  const fw = f.w * m.sx
  const fh = f.h * m.sy
  let rot = f.rotation
  let flipH = f.flipH
  let flipV = f.flipV
  // group flips mirror the child's centre across the group centre, toggle the
  // child's own flags and negate its rotation
  let ccx = fx + fw / 2
  let ccy = fy + fh / 2
  if (m.flipH) { ccx = 2 * m.cx - ccx; flipH = !flipH; rot = -rot }
  if (m.flipV) { ccy = 2 * m.cy - ccy; flipV = !flipV; rot = -rot }
  // group rotation turns the child's centre about the group centre and adds
  // to the child's own angle (clockwise, y-down — same sense as CSS rotate)
  if (m.rot !== 0) {
    const a = m.rot * DEG
    const dx = ccx - m.cx
    const dy = ccy - m.cy
    ccx = m.cx + dx * Math.cos(a) - dy * Math.sin(a)
    ccy = m.cy + dx * Math.sin(a) + dy * Math.cos(a)
    rot += m.rot
  }
  fx = ccx - fw / 2
  fy = ccy - fh / 2
  return { x: fx, y: fy, w: fw, h: fh, rotation: rot, flipH, flipV }
}

function grpXfrm(grpSp: XElem): XElem | undefined {
  const pr = kid(grpSp, NS.p, 'grpSpPr')
  return pr && kid(pr, NS.a, 'xfrm')
}

const MEMBER_LOCALS = new Set(['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp'])

/**
 * Flatten one p:grpSp (recursively — 94 census groups, and groups nest) into
 * leaf children with composed ABSOLUTE frames. The caller converts each leaf
 * with its own module, passing frame+groupId back through deps. Every leaf —
 * including members of nested groups — shares the OUTERMOST group's id: bento
 * groupId is single-level, and the outermost group is the selection unit the
 * author actually had. A rotated child inside a non-uniformly scaled group
 * shears in PowerPoint; this frame model cannot say that, so such a child
 * keeps its summed rotation and axis-scaled box (no census sighting).
 */
export function groupChildren(grpSp: XElem, ctx: InheritCtx, deps: ShapeDeps): GroupChild[] {
  const out: GroupChild[] = []
  const groupId = deps.groupId ?? `s${deps.slideIndex}-g${cNvPrId(grpSp)}`

  const walk = (grp: XElem, parent: GroupMap | undefined, nested: boolean): void => {
    const xf = grpXfrm(grp)
    const off = xf && kid(xf, NS.a, 'off')
    const ext = xf && kid(xf, NS.a, 'ext')
    const chOff = xf && kid(xf, NS.a, 'chOff')
    const chExt = xf && kid(xf, NS.a, 'chExt')
    let gFrame: GroupFrame = {
      x: off ? intAttr(off, 'x') : 0,
      y: off ? intAttr(off, 'y') : 0,
      w: ext ? intAttr(ext, 'cx') : 0,
      h: ext ? intAttr(ext, 'cy') : 0,
      rotation: xf ? intAttr(xf, 'rot') / 60000 : 0,
      flipH: xf ? attr(xf, 'flipH') === '1' || attr(xf, 'flipH') === 'true' : false,
      flipV: xf ? attr(xf, 'flipV') === '1' || attr(xf, 'flipV') === 'true' : false,
    }
    if (parent) gFrame = applyMap(parent, gFrame)
    if (nested) {
      ctx.report.add('approximated', 'nested-group-flattened', whereOf(grp, deps.slideIndex),
        'nested group flattened into its outermost group (bento groups are one level)')
    }
    const chW = chExt ? intAttr(chExt, 'cx') : 0
    const chH = chExt ? intAttr(chExt, 'cy') : 0
    const map: GroupMap = {
      sx: chW > 0 ? gFrame.w / chW : 1,
      sy: chH > 0 ? gFrame.h / chH : 1,
      ox: gFrame.x, oy: gFrame.y,
      chx: chOff ? intAttr(chOff, 'x') : 0,
      chy: chOff ? intAttr(chOff, 'y') : 0,
      rot: gFrame.rotation,
      flipH: gFrame.flipH, flipV: gFrame.flipV,
      cx: gFrame.x + gFrame.w / 2, cy: gFrame.y + gFrame.h / 2,
    }
    for (const child of kids(grp, NS.p)) {
      if (!MEMBER_LOCALS.has(child.local)) continue
      if (child.local === 'grpSp') {
        walk(child, map, true)
        continue
      }
      const f = resolveFrame(child, ctx)
      out.push({
        el: child,
        frame: applyMap(map, {
          x: f.x, y: f.y, w: f.w, h: f.h,
          rotation: f.rotation, flipH: f.flipH, flipV: f.flipV,
        }),
        groupId,
      })
    }
  }
  walk(grpSp, undefined, false)
  return out
}
