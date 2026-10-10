// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Bento shape → p:sp / p:cxnSp — and the frame/colour helpers every element
// writer shares (`emu`, `xfrmNode`, `parseColor`, `solidFill`).
//
// The mapping decisions here are adopted from PR #88's exporter
// (slides/src/export/pptx/shapes.ts + color.ts), which proved them against
// real PowerPoint through PptxGenJS; this module re-expresses them as direct
// OOXML so the writer stays first-party (no vendored dependency — see
// docs/DECISIONS.md 2026-08-02). Where #88's library hid a raw-OOXML trap
// (EMU integrality, schema child order, the a:lin `scaled` flag), the trap is
// documented at the line that avoids it.
//
// UNITS. Bento is CSS px at 96dpi throughout; OOXML wants EMU (px * 9525,
// always an integer — a decimal point in an off/ext/w attribute is a repair
// dialog), angles in 60000ths of a degree, and percentages in 1000ths of a
// percent (100% = 100000).
//
// THE LINE GOTCHA, kept from #88: a bento line's colour lives in FILL, not
// stroke — the renderer paints lines as a stroked SVG line whose stroke attr
// is what morphs tween, so `fill` is the authored colour and `stroke` is
// meaningless on lines. Reading `stroke` here exports every line invisible.

import { x, type XChild, type XNode } from '../xmlout.ts'
import type { Report } from '../report.ts'
import { EMU_PER_PX } from '../types.ts'

// --- the input shape (structural, never imported from slides/) ---------------
// The exporter's input is the REAL bento/slides document — a superset of the
// convert engine's OutShape. These fields mirror slides/src/model.ts
// ShapeElement; unknown extra fields simply never get read.

export interface ShadowIn { x?: number; y?: number; blur: number; color: string }
export interface GradientIn { angle: number; stops: Array<{ at: number; color: string }> }

export interface ShapeIn {
  id: string
  morphId?: string
  x: number; y: number; w: number; h: number
  rotation: number
  opacity: number
  shadow?: ShadowIn | ShadowIn[]
  blur?: number
  blend?: string
  backdropFilter?: number
  shape: 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'line' | 'path'
  fill: string
  fillGradient?: GradientIn
  stroke: string
  strokeWidth: number
  radius: number
  strokeDash?: number
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  lineStart?: 'none' | 'arrow' | 'dot' | 'bar'
  lineEnd?: 'none' | 'arrow' | 'dot' | 'bar'
  d?: string
  pathBox?: [number, number, number, number]
  from?: unknown
  to?: unknown
}

// --- shared frame helper -----------------------------------------------------

/** px → EMU, rounded. EMU are integers BY DEFINITION — `String(1.5)` in a
 *  cx attribute is silently unreadable, so every px→EMU conversion in the
 *  writer must round exactly once, here. */
export const emu = (px: number): number => Math.round(px * EMU_PER_PX)

export interface Frame { x: number; y: number; w: number; h: number; rotation?: number }

/**
 * The a:xfrm every element writer places its element with. Bento px map to
 * EMU 1:1 through EMU_PER_PX (the integrator sizes the slide the same way,
 * so no per-deck scale factor exists — unlike #88's inch-based geometry).
 * Rotation is degrees clockwise in both models; OOXML just counts it in
 * 60000ths. rot is omitted at 0 because PowerPoint omits it — matching the
 * native shape keeps diffs against real files readable.
 */
export function xfrmNode(f: Frame): XNode {
  const deg = (((f.rotation ?? 0) % 360) + 360) % 360
  return x('a:xfrm', deg ? { rot: Math.round(deg * 60000) } : undefined, [
    x('a:off', { x: emu(f.x), y: emu(f.y) }),
    x('a:ext', { cx: emu(f.w), cy: emu(f.h) }),
  ])
}

// --- colours -----------------------------------------------------------------
// Ported from #88's color.ts: bento authors solid colours as #hex (3/4/6/8
// digits) or rgb()/rgba() (comma or space separated, alpha 0..1 or %), plus
// 'transparent'/'none'. OOXML wants six uppercase hex digits with alpha as a
// separate a:alpha child in 1000ths of a percent.

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

/** hex 'RRGGBB' (uppercase) + alpha 0..1. */
export interface ParsedColor { hex: string; alpha: number }

/**
 * Parse a bento colour. `transparent`/`none`/empty → alpha 0 (a real value:
 * "no paint"). Anything unparseable (css keywords, hsl()) → null so the
 * caller can pick a fallback AND report — #88 fell back silently, but silent
 * black is exactly the kind of change the fidelity report exists to admit.
 */
export function parseColor(value: string | undefined): ParsedColor | null {
  const raw = (value ?? '').trim()
  if (!raw || raw === 'none' || raw === 'transparent') return { hex: '000000', alpha: 0 }
  const rgb = raw.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)%?)?\s*\)$/i)
  if (rgb) {
    const alphaRaw = rgb[4]
    // A bare number > 1 is a percentage ('50' in 'rgba(0,0,0,50%)' — the
    // regex eats the % sign); #88's heuristic, kept verbatim.
    const alpha = alphaRaw === undefined ? 1 : Number(alphaRaw) > 1 ? Number(alphaRaw) / 100 : Number(alphaRaw)
    return {
      hex: [rgb[1], rgb[2], rgb[3]]
        .map((n) => clamp(Math.round(Number(n)), 0, 255).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase(),
      alpha: clamp(alpha, 0, 1),
    }
  }
  let hex = raw.replace(/^#/, '')
  if (/^[0-9a-f]{3,4}$/i.test(hex)) hex = [...hex].map((c) => c + c).join('')
  if (/^[0-9a-f]{6,8}$/i.test(hex)) {
    return {
      hex: hex.slice(0, 6).toUpperCase(),
      alpha: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1,
    }
  }
  return null
}

/** a:srgbClr, with an a:alpha child only when translucent — PowerPoint never
 *  writes a redundant alpha="100000" and neither do we. */
function srgbNode(c: ParsedColor, opacity = 1): XNode {
  const a = clamp(c.alpha * clamp(opacity, 0, 1), 0, 1)
  return x('a:srgbClr', { val: c.hex }, a < 1 ? [x('a:alpha', { val: Math.round(a * 100000) })] : undefined)
}

/**
 * a:solidFill (or a:noFill for transparent) from a css colour — the shared
 * door for text/table writers that need a colour without a Report handle.
 * Unparseable falls back to opaque black; shapes' own path goes through
 * `fillOf` below, which reports the fallback.
 */
export function solidFill(css: string | undefined, opacity = 1): XNode {
  const c = parseColor(css) ?? { hex: '000000', alpha: 1 }
  if (c.alpha * opacity <= 0) return x('a:noFill')
  return x('a:solidFill', undefined, [srgbNode(c, opacity)])
}

/** parseColor with the fidelity report on the failure path. */
function colorOf(css: string | undefined, report: Report, where: string): ParsedColor {
  const c = parseColor(css)
  if (c) return c
  report.add('approximated', 'color-unparsed', where, `colour '${css}' not parseable; exported as black`)
  return { hex: '000000', alpha: 1 }
}

// --- gradient ----------------------------------------------------------------

/**
 * CSS gradient angle → OOXML a:lin@ang. CSS measures the gradient VECTOR
 * clockwise from "to top" (0 = bottom→top, 90 = left→right — render.ts
 * cssLinearGradient); OOXML measures it clockwise from 3 o'clock in a y-down
 * space (0 = left→right, 5400000 = top→bottom). Same rotation direction on
 * screen, origins 90° apart — so the whole conversion is a -90° phase shift.
 * This is the exact inverse of the importer's ooxml→css step; the rig
 * round-trips 90° through both conventions by hand.
 */
export function cssAngleToOoxml(cssDeg: number): number {
  return Math.round(((((cssDeg - 90) % 360) + 360) % 360) * 60000)
}

/**
 * a:gradFill from a bento GradientFill. Stop positions are 0..1 → 1000ths of
 * a percent. `scaled="0"` is load-bearing: a CSS angle is a TRUE angle in the
 * element's space, while scaled="1" tells PowerPoint the angle was authored
 * in a unit square and must be skewed by the shape's aspect ratio — with it
 * set, every gradient on a non-square shape leans wrong.
 */
function gradFillNode(g: GradientIn, opacity: number, report: Report, where: string): XNode {
  const stops = g.stops.map((s) =>
    x('a:gs', { pos: Math.round(clamp(s.at, 0, 1) * 100000) }, [srgbNode(colorOf(s.color, report, where), opacity)]),
  )
  return x('a:gradFill', { rotWithShape: 1 }, [
    x('a:gsLst', undefined, stops),
    x('a:lin', { ang: cssAngleToOoxml(g.angle), scaled: 0 }),
  ])
}

/** A gradient is only emittable as a:gradFill with TWO OR MORE stops —
 *  CT_GradientStopList's gs has minOccurs="2", so a one-stop gsLst is a
 *  schema-invalid part (repair dialog). SVG paints a one-stop gradient as
 *  that solid colour, so the honest export of a degenerate gradient is the
 *  stop's solid fill — same pixels, valid part. */
const gradientStops = (el: ShapeIn): number => el.fillGradient?.stops.length ?? 0

/** The shape's interior paint: gradient wins over solid (model contract —
 *  `fill` is kept as the solid fallback), transparent → explicit a:noFill. */
function fillOf(el: ShapeIn, report: Report, where: string): XNode {
  if (gradientStops(el) >= 2) return gradFillNode(el.fillGradient!, el.opacity, report, where)
  // one stop = solid of that stop (see gradientStops); zero = el.fill
  const css = gradientStops(el) === 1 ? el.fillGradient!.stops[0].color : el.fill
  const c = colorOf(css, report, where)
  if (c.alpha * el.opacity <= 0) return x('a:noFill')
  return x('a:solidFill', undefined, [srgbNode(c, el.opacity)])
}

// --- stroke ------------------------------------------------------------------

/** Bento tip → OOXML arrowhead. arrow/dot have faithful twins; 'bar' (a flat
 *  perpendicular tick) has NO OOXML twin — the arrowhead vocabulary is
 *  triangle/stealth/diamond/oval/arrow only. #88 chose diamond as the least
 *  dishonest blocky tip; we keep that choice but say so in the report. */
function tipType(kind: string | undefined, report: Report, where: string): string | null {
  if (!kind || kind === 'none') return null
  if (kind === 'arrow') return 'triangle'
  if (kind === 'dot') return 'oval'
  report.add('approximated', 'line-tip-approximated', where, `line tip 'bar' has no PowerPoint arrowhead; exported as diamond`)
  return 'diamond'
}

/**
 * a:ln. Child order is schema-fixed: fill, prstDash, headEnd, tailEnd.
 * A shape with no stroke gets an EXPLICIT a:ln/a:noFill — omitting a:ln
 * entirely leaves the outline to the theme's line style, and "no stroke in
 * bento" must not become "thin Office-blue outline in PowerPoint".
 */
function lnOf(el: ShapeIn, report: Report, where: string): XNode {
  const isLine = el.shape === 'line'
  if (!isLine && el.strokeWidth <= 0) return x('a:ln', undefined, [x('a:noFill')])
  // The renderer draws lines at max(strokeWidth, 2)px — a 0-width bento line
  // is still visible on canvas, so it must stay visible in PowerPoint.
  const wPx = isLine ? Math.max(el.strokeWidth, 2) : el.strokeWidth
  const dotted = el.strokeStyle === 'dotted'
  // strokeStyle wins over the legacy px-count strokeDash (model contract).
  const dashed = el.strokeStyle === 'dashed' || (!el.strokeStyle && (el.strokeDash ?? 0) > 0)
  // THE line gotcha (see header): a line's colour is its FILL. A gradient
  // fill on a line becomes a gradient STROKE — a:ln accepts gradFill.
  const paintCss = isLine
    ? gradientStops(el) === 1 ? el.fillGradient!.stops[0].color : el.fill
    : el.stroke
  const paint = isLine && gradientStops(el) >= 2
    ? gradFillNode(el.fillGradient!, el.opacity, report, where)
    : (() => {
        const c = colorOf(paintCss, report, where)
        return c.alpha * el.opacity <= 0 ? x('a:noFill') : x('a:solidFill', undefined, [srgbNode(c, el.opacity)])
      })()
  const kids: XChild[] = [paint]
  if (dotted) kids.push(x('a:prstDash', { val: 'sysDot' }))
  else if (dashed) kids.push(x('a:prstDash', { val: 'dash' }))
  if (isLine) {
    const head = tipType(el.lineStart, report, where)
    const tail = tipType(el.lineEnd, report, where)
    if (head) kids.push(x('a:headEnd', { type: head, w: 'med', len: 'med' }))
    if (tail) kids.push(x('a:tailEnd', { type: tail, w: 'med', len: 'med' }))
  }
  // Round caps match the renderer (round unless dashed); dotted NEEDS them or
  // sysDot renders as square specks.
  const cap = dotted || (isLine && !dashed) ? 'rnd' : undefined
  return x('a:ln', { w: emu(wPx), ...(cap ? { cap } : {}) }, kids)
}

// --- shadow ------------------------------------------------------------------

// PowerPoint's shadow UI edits blur up to 100pt and distance up to 200pt;
// values beyond render but become uneditable sliders. #88 clamped to those
// limits (via PptxGenJS's validation) and we keep the clamp so a re-opened
// shadow is always a shadow the user can adjust.
const MAX_BLUR_EMU = 1270000 // 100pt
const MAX_DIST_EMU = 2540000 // 200pt

/**
 * a:effectLst with one a:outerShdw, or null when shadowless. x/y offsets
 * become polar dist+dir (dir clockwise from 3 o'clock — atan2 in a y-down
 * space is already clockwise, no sign flip). rotWithShape="0" because CSS
 * drop-shadow applies after the element's transform: the shadow direction is
 * a screen-space fact that must not rotate with the shape. Stacked shadows
 * (bento allows an array) keep the first — the elevation shadow by
 * convention — and report; #88's simplification, kept.
 */
function effectsOf(el: ShapeIn, report: Report, where: string): XNode | null {
  const s = Array.isArray(el.shadow) ? el.shadow[0] : el.shadow
  if (Array.isArray(el.shadow) && el.shadow.length > 1) {
    report.add('approximated', 'multiple-shadows-simplified', where, 'stacked shadows exported as the first only')
  }
  if (!s) return null
  const dx = s.x ?? 0
  const dy = s.y ?? 0
  const dir = Math.round((((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360) * 60000)
  return x('a:effectLst', undefined, [
    x('a:outerShdw', {
      blurRad: Math.min(emu(s.blur), MAX_BLUR_EMU),
      dist: Math.min(emu(Math.hypot(dx, dy)), MAX_DIST_EMU),
      dir,
      rotWithShape: 0,
    }, [srgbNode(colorOf(s.color, report, where), el.opacity)]),
  ])
}

// --- geometry ----------------------------------------------------------------

/**
 * An SVG elliptical arc as cubic Béziers (SVG 1.1 implementation notes F.6:
 * endpoint to centre parameterisation, then one cubic per quarter turn or
 * less, k = 4/3·tan(Δθ/4)). Exact to well under a pixel at slide scale.
 * Returns [c1x, c1y, c2x, c2y, x, y] per segment; [] for a zero-length arc;
 * null when a radius is 0 (the spec draws a straight line).
 */
export function arcToCubics(x1: number, y1: number, rx: number, ry: number, phiDeg: number,
  largeArc: number, sweep: number, x2: number, y2: number): number[][] | null {
  // a non-finite input (path data misread upstream) draws a line, and the
  // caller's coordinate guard then stops the parse if the endpoint is bad too
  if (![x1, y1, rx, ry, phiDeg, x2, y2].every(Number.isFinite)) return null
  if (x1 === x2 && y1 === y2) return []
  rx = Math.abs(rx); ry = Math.abs(ry)
  if (rx === 0 || ry === 0) return null
  const phi = (phiDeg * Math.PI) / 180
  const cos = Math.cos(phi), sin = Math.sin(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy
  // radii too small for the endpoints are scaled up (F.6.6)
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) { const k = Math.sqrt(lambda); rx *= k; ry *= k }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  let coef = Math.sqrt(Math.max(0, num / den))
  if (largeArc === sweep) coef = -coef
  const cxp = (coef * rx * y1p) / ry
  const cyp = (-coef * ry * x1p) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return a
  }
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  else if (sweep && delta < 0) delta += 2 * Math.PI
  if (!Number.isFinite(delta) || !Number.isFinite(cx) || !Number.isFinite(cy)) return null
  const n = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9))
  const step = delta / n
  const k = (4 / 3) * Math.tan(step / 4)
  const out: number[][] = []
  // a point on the ellipse at parameter t, and its derivative
  const P = (t: number) => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]
  const D = (t: number) => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos]
  for (let j = 0; j < n; j++) {
    const t1 = theta1 + j * step, t2 = t1 + step
    const [ax, ay] = P(t1), [bx, by] = P(t2)
    const [dax, day] = D(t1), [dbx, dby] = D(t2)
    out.push([ax + k * dax, ay + k * day, bx - k * dbx, by - k * dby, bx, by])
  }
  // land exactly on the requested endpoint
  out[out.length - 1][4] = x2; out[out.length - 1][5] = y2
  return out
}

/**
 * a:custGeom from SVG path data (M/L/H/V/C/S/Q/T/A/Z, absolute and
 * relative; S/T resolved exactly via control-point reflection, arcs as exact
 * cubics via arcToCubics). Path
 * coordinates are ST_AdjCoordinate — INTEGERS — so the path space is scaled
 * to EMU (px * 9525): sub-pixel curve detail survives the integer floor.
 * Arcs (A) have no custGeom primitive of the same shape (arcTo is
 * centre-relative); they become cubic Béziers, which is exact enough to be
 * no loss. Any command letter outside the vocabulary is reported and stops
 * the parse (continuing
 * past an unknown command means guessing at its argument count, and a
 * miscounted queue turns every coordinate after it into garbage).
 */
function custGeomNode(el: ShapeIn, report: Report, where: string): XNode {
  const [bx, by, bw, bh] = el.pathBox ?? [0, 0, el.w, el.h]
  const pw = Math.max(emu(bw), 1)
  const ph = Math.max(emu(bh), 1)
  const px = (v: number) => Math.round((v - bx) * EMU_PER_PX)
  const py = (v: number) => Math.round((v - by) * EMU_PER_PX)
  // A coordinate that is not a finite number (a path that runs out of
  // arguments, or one this parser misreads) ends the parse at the last good
  // segment and is reported, never written: xmlout refuses NaN, and one bad
  // path must not cost the whole export.
  class BadCoordinate extends Error {}
  const pt = (X: number, Y: number): XNode => {
    if (!Number.isFinite(X) || !Number.isFinite(Y)) throw new BadCoordinate()
    return x('a:pt', { x: px(X), y: py(Y) })
  }

  const segs: XChild[] = []
  let approx = false
  // tokenizer: command letters and numbers; anything else is caught below
  const src = el.d ?? ''
  const tokens = src.match(/[MmLlHhVvCcQqZzAaSsTt]|-?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?/g) ?? []
  const junk = src.replace(/[MmLlHhVvCcQqZzAaSsTt0-9eE+\-.,\s]/g, '')

  let i = 0
  let cx = 0, cy = 0 // current point (absolute px)
  let sx = 0, sy = 0 // subpath start
  let pcx: number | null = null, pcy = 0 // previous cubic ctrl2 (for S)
  let pqx: number | null = null, pqy = 0 // previous quad ctrl (for T)
  const num = () => Number(tokens[i++])
  // An arc flag is ONE digit, 0 or 1, and SVG lets flags run together with
  // what follows ("a.4.4 0 00-.1-.2" is flags 0 and 0, then x -.1): a minifier
  // writes them that way, and reading "00" as one number shifted every
  // coordinate after it. Take the first digit and leave the rest queued.
  const flag = (): number => {
    const t = tokens[i]
    // "00.267" tokenises as one decimal: flags 0 and 0, then x .267
    if (t !== undefined && t.length > 1 && /^[01]/.test(t)) { tokens[i] = t.slice(1); return Number(t[0]) }
    return num()
  }
  const isNum = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i])

  let stopped = false
  try {
  while (i < tokens.length && !stopped) {
    const cmd = tokens[i++]
    const rel = cmd === cmd.toLowerCase()
    // S/T reflection state survives only through their own families
    const keepsCubic = 'CcSs'.includes(cmd)
    const keepsQuad = 'QqTt'.includes(cmd)
    switch (cmd.toUpperCase()) {
      case 'M': {
        let first = true
        while (isNum()) {
          const X = num() + (rel ? cx : 0)
          const Y = num() + (rel ? cy : 0)
          if (first) {
            segs.push(x('a:moveTo', undefined, [pt(X, Y)]))
            sx = X; sy = Y
          } else {
            // extra coordinate pairs after M are implicit lineto (SVG spec)
            segs.push(x('a:lnTo', undefined, [pt(X, Y)]))
          }
          cx = X; cy = Y
          first = false
        }
        break
      }
      case 'L':
        while (isNum()) {
          cx = num() + (rel ? cx : 0)
          cy = num() + (rel ? cy : 0)
          segs.push(x('a:lnTo', undefined, [pt(cx, cy)]))
        }
        break
      case 'H':
        while (isNum()) {
          cx = num() + (rel ? cx : 0)
          segs.push(x('a:lnTo', undefined, [pt(cx, cy)]))
        }
        break
      case 'V':
        while (isNum()) {
          cy = num() + (rel ? cy : 0)
          segs.push(x('a:lnTo', undefined, [pt(cx, cy)]))
        }
        break
      case 'C':
        while (isNum()) {
          const x1 = num() + (rel ? cx : 0), y1 = num() + (rel ? cy : 0)
          const x2 = num() + (rel ? cx : 0), y2 = num() + (rel ? cy : 0)
          const X = num() + (rel ? cx : 0), Y = num() + (rel ? cy : 0)
          segs.push(x('a:cubicBezTo', undefined, [pt(x1, y1), pt(x2, y2), pt(X, Y)]))
          pcx = x2; pcy = y2
          cx = X; cy = Y
        }
        break
      case 'S':
        while (isNum()) {
          // first control = reflection of the previous cubic's second control
          // about the current point (current point when the previous command
          // was not a cubic) — resolving it here keeps S EXACT, not approximated
          const x1: number = pcx === null ? cx : 2 * cx - pcx
          const y1: number = pcx === null ? cy : 2 * cy - pcy
          const x2 = num() + (rel ? cx : 0), y2 = num() + (rel ? cy : 0)
          const X = num() + (rel ? cx : 0), Y = num() + (rel ? cy : 0)
          segs.push(x('a:cubicBezTo', undefined, [pt(x1, y1), pt(x2, y2), pt(X, Y)]))
          pcx = x2; pcy = y2
          cx = X; cy = Y
        }
        break
      case 'Q':
        while (isNum()) {
          const x1 = num() + (rel ? cx : 0), y1 = num() + (rel ? cy : 0)
          const X = num() + (rel ? cx : 0), Y = num() + (rel ? cy : 0)
          segs.push(x('a:quadBezTo', undefined, [pt(x1, y1), pt(X, Y)]))
          pqx = x1; pqy = y1
          cx = X; cy = Y
        }
        break
      case 'T':
        while (isNum()) {
          const x1: number = pqx === null ? cx : 2 * cx - pqx
          const y1: number = pqx === null ? cy : 2 * cy - pqy
          const X = num() + (rel ? cx : 0), Y = num() + (rel ? cy : 0)
          segs.push(x('a:quadBezTo', undefined, [pt(x1, y1), pt(X, Y)]))
          pqx = x1; pqy = y1
          cx = X; cy = Y
        }
        break
      case 'A':
        while (isNum()) {
          const rx = num(), ry = num(), rot = num(), large = flag(), sw = flag()
          const X = num() + (rel ? cx : 0)
          const Y = num() + (rel ? cy : 0)
          const curves = arcToCubics(cx, cy, rx, ry, rot, large, sw, X, Y)
          if (curves === null) segs.push(x('a:lnTo', undefined, [pt(X, Y)])) // zero radius: a line, per the spec
          else for (const [a1, b1, a2, b2, a3, b3] of curves) segs.push(x('a:cubicBezTo', undefined, [pt(a1, b1), pt(a2, b2), pt(a3, b3)]))
          cx = X; cy = Y
        }
        break
      case 'Z':
        segs.push(x('a:close'))
        cx = sx; cy = sy
        break
      default:
        stopped = true // unreachable given the tokenizer, kept as a belt
    }
    if (!keepsCubic) pcx = null
    if (!keepsQuad) pqx = null
  }
  } catch (e) {
    if (!(e instanceof BadCoordinate)) throw e
    stopped = true
  }
  if (junk) {
    approx = true
    stopped = true
  }
  if (approx || stopped) {
    report.add('approximated', 'path-approximated', where,
      'path data could not be fully read; the shape is drawn up to the point it stopped')
  }
  // A pathLst with zero commands is a repair dialog; an unusable d degrades
  // to the element's box outline (visible, selectable, honestly reported).
  if (segs.length === 0) {
    segs.push(
      x('a:moveTo', undefined, [pt(bx, by)]),
      x('a:lnTo', undefined, [pt(bx + bw, by)]),
      x('a:lnTo', undefined, [pt(bx + bw, by + bh)]),
      x('a:lnTo', undefined, [pt(bx, by + bh)]),
      x('a:close'),
    )
  }
  return x('a:custGeom', undefined, [
    x('a:avLst'),
    x('a:gdLst'),
    x('a:ahLst'),
    x('a:cxnLst'),
    x('a:rect', { l: 0, t: 0, r: pw, b: ph }),
    x('a:pathLst', undefined, [x('a:path', { w: pw, h: ph }, segs)]),
  ])
}

/** Preset geometry for the non-path kinds. roundRect's adj is the corner
 *  radius as a fraction of min(w,h) in 1000ths of a percent, clamped to 0.5
 *  (PowerPoint's own maximum) — #88's formula, kept verbatim. */
function geomOf(el: ShapeIn, report: Report, where: string): XNode {
  if (el.shape === 'path') return custGeomNode(el, report, where)
  if (el.shape === 'rect' && el.radius > 0) {
    const adj = Math.round(Math.min(el.radius / Math.max(Math.min(el.w, el.h), 1), 0.5) * 100000)
    return x('a:prstGeom', { prst: 'roundRect' }, [
      x('a:avLst', undefined, [x('a:gd', { name: 'adj', fmla: `val ${adj}` })]),
    ])
  }
  const prst =
    el.shape === 'ellipse' ? 'ellipse'
    : el.shape === 'triangle' ? 'triangle'
    : el.shape === 'arrow' ? 'rightArrow' // #88's mapping: bento arrows point right at rest
    : el.shape === 'line' ? 'line'
    : 'rect'
  return x('a:prstGeom', { prst }, [x('a:avLst')])
}

// --- the shape node ----------------------------------------------------------

export interface ShapeOpts {
  /** rel id of an already-allocated slide-jump hyperlink rel (bento `link`
   *  targets a slide; the integrator resolves slide id → rel). Emitted as
   *  a:hlinkClick with the sldjump action inside cNvPr. */
  linkRelId?: string
}

/**
 * One bento shape element → a finished spTree child.
 *
 *   - line       → p:cxnSp with prst="line" (what PowerPoint itself writes
 *                  for a drawn line; the census' 141 prst=line agree)
 *   - path       → p:sp with a:custGeom from d/pathBox
 *   - everything → p:sp with a preset geometry
 *
 * `shapeId` is the cNvPr id — the integrator numbers from 2 up (the spTree
 * preamble claims 1). `where` is the report location ('slide 4'). The name
 * attr carries `bento:<morph key>` (#88's objectName) so a future re-import
 * can restore morph pairing.
 */
export function shapeNode(el: ShapeIn, shapeId: number, report: Report, where: string, opts: ShapeOpts = {}): XNode {
  // Effects with no OOXML expression at all: named, not silently shed.
  if (el.blur) report.add('dropped', 'shape-blur-dropped', where, 'element gaussian blur has no shape-level OOXML equivalent')
  if (el.blend) report.add('dropped', 'blend-mode-dropped', where, 'mix-blend-mode has no OOXML equivalent')
  if (el.backdropFilter) report.add('dropped', 'backdrop-filter-dropped', where, 'frosted-glass backdrop blur has no OOXML equivalent')

  const cNvPr = x(
    'p:cNvPr',
    { id: shapeId, name: `bento:${el.morphId || el.id}` },
    opts.linkRelId ? [x('a:hlinkClick', { 'r:id': opts.linkRelId, action: 'ppaction://hlinksldjump' })] : undefined,
  )
  const effects = effectsOf(el, report, where)

  if (el.shape === 'line') {
    // Live connector anchoring is editor-derived geometry; the exported line
    // keeps the correct absolute endpoints but stops following its elements.
    if (el.from || el.to) {
      report.add('approximated', 'connector-detached', where, 'connector exported as a free line (no longer follows its elements)')
    }
    // Bento draws the line horizontally across the element box's vertical
    // CENTER (render.ts: y1 = y2 = h/2); OOXML's line runs corner to corner.
    // Collapsing the box to zero height at the centerline makes the two
    // agree — and since both models rotate about the box center, rotation
    // survives the collapse untouched.
    const spPr = x('p:spPr', undefined, [
      xfrmNode({ x: el.x, y: el.y + el.h / 2, w: el.w, h: 0, rotation: el.rotation }),
      geomOf(el, report, where),
      lnOf(el, report, where),
      ...(effects ? [effects] : []),
    ])
    return x('p:cxnSp', undefined, [
      x('p:nvCxnSpPr', undefined, [cNvPr, x('p:cNvCxnSpPr'), x('p:nvPr')]),
      spPr,
    ])
  }

  const spPr = x('p:spPr', undefined, [
    xfrmNode(el),
    geomOf(el, report, where),
    fillOf(el, report, where),
    lnOf(el, report, where),
    ...(effects ? [effects] : []),
  ])
  return x('p:sp', undefined, [
    x('p:nvSpPr', undefined, [cNvPr, x('p:cNvSpPr'), x('p:nvPr')]),
    spPr,
    // An empty txBody makes the shape typeable in PowerPoint (and mirrors
    // what PowerPoint writes for every shape it creates).
    x('p:txBody', undefined, [x('a:bodyPr'), x('a:lstStyle'), x('a:p')]),
  ])
}
