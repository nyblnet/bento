// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// WCAG contrast of an element against what lies behind it, measured where it
// is weakest. A grid of points over the element: at each, the backdrop is
// composited bottom-up from the slide background and every visible shape
// below that covers the point — with its opacity, its fill's alpha and its
// gradient evaluated AT that point — and the element's own colour is
// composited over it the same way. The worst point is the answer, and where it
// is. Pure model maths: no DOM, so the rig checks it directly.
import type { GradientFill, ShapeElement, Slide, SlideElement } from '../../model'
import { parseColor } from './colorvalue'

type RGBA = [number, number, number, number] // 0..255, alpha 0..1

const rgba = (css: string | undefined): RGBA => {
  const { hex, a } = parseColor(css ?? 'transparent')
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(a) as RGBA
}
const over = (top: RGBA, under: RGBA, alpha = 1): RGBA => {
  const a = top[3] * alpha
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1) as RGBA
}
const lerp = (a: RGBA, b: RGBA, t: number): RGBA => a.map((v, i) => v + (b[i] - v) * t) as RGBA

/** A gradient's colour at slide point (px, py), for an element box, CSS geometry. */
function gradientAt(g: GradientFill, el: SlideElement, px: number, py: number): RGBA {
  let t: number
  if (g.kind === 'radial') {
    const r = g.r ?? 0.5
    t = Math.hypot((px - el.x - (g.cx ?? 0.5) * el.w) / (r * el.w || 1), (py - el.y - (g.cy ?? 0.5) * el.h) / (r * el.h || 1))
  } else {
    // CSS linear-gradient: 0deg runs bottom→top; the line is long enough that the corners sit on 0 and 1
    const a = (g.angle * Math.PI) / 180, sx = Math.sin(a), sy = -Math.cos(a)
    const len = Math.abs(el.w * sx) + Math.abs(el.h * sy) || 1
    t = ((px - el.x - el.w / 2) * sx + (py - el.y - el.h / 2) * sy) / len + 0.5
  }
  const stops = [...g.stops].sort((m, n) => m.at - n.at)
  if (!stops.length) return [0, 0, 0, 0]
  if (t <= stops[0].at) return rgba(stops[0].color)
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].at) return lerp(rgba(stops[i - 1].color), rgba(stops[i].color), (t - stops[i - 1].at) / ((stops[i].at - stops[i - 1].at) || 1))
  }
  return rgba(stops[stops.length - 1].color)
}

/** (px, py) in the element's own unrotated frame. */
function local(el: SlideElement, px: number, py: number): [number, number] {
  const a = (-(el.rotation || 0) * Math.PI) / 180
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2
  const dx = px - cx, dy = py - cy
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)]
}

function covers(e: ShapeElement, px: number, py: number): boolean {
  const [x, y] = local(e, px, py)
  if (e.shape === 'ellipse') return ((x - e.x - e.w / 2) / (e.w / 2)) ** 2 + ((y - e.y - e.h / 2) / (e.h / 2)) ** 2 <= 1
  // ponytail: other shapes by their box — a triangle's or path's empty corners count as covered
  return x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h
}

/** A shape's fill at a point: every visible fill layer, bottom first, or the single fill. */
function shapePaint(e: ShapeElement, px: number, py: number, under: RGBA): RGBA {
  const [x, y] = local(e, px, py)
  const layers = e.fills?.length ? e.fills.filter((f) => !f.hidden) : [{ color: e.fill, gradient: e.fillGradient }]
  let c = under
  for (const f of layers) c = over(f.gradient?.stops.length ? gradientAt(f.gradient, e, x, y) : rgba(f.color), c)
  return c
}

/** The element's own colour at a point (text colour, or a shape's fill — its stroke when unfilled). */
function ownPaint(el: SlideElement, px: number, py: number): RGBA | null {
  const [x, y] = local(el, px, py)
  if (el.type === 'text') return el.colorGradient?.stops.length ? gradientAt(el.colorGradient, el, x, y) : rgba(el.color)
  if (el.type !== 'shape') return null
  if (!el.fillHidden && (el.fills?.some((f) => !f.hidden) || (el.fill && el.fill !== 'none' && rgba(el.fill)[3] > 0) || el.fillGradient)) return shapePaint(el, px, py, [0, 0, 0, 0])
  // no fill and no stroke (a bare frame): nothing painted, nothing to judge
  if (!(el.strokeWidth > 0) || el.strokeHidden || rgba(el.stroke)[3] === 0) return null
  return rgba(el.stroke)
}

const lum = (c: RGBA) => 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])
const ch = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const ratio = (a: RGBA, b: RGBA) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }

export interface ContrastReading {
  /** the worst ratio over the samples */
  ratio: number
  /** where: column and row of the 3×3 region, 0..2 each (left/centre/right, top/middle/bottom) */
  at: [number, number]
  /** every sample's ratio, for the rig */
  samples: number[]
}

/** A box in the element's own (unrotated) frame, slide px. */
export interface Area { x: number; y: number; w: number; h: number }

/**
 * The element's contrast against its backdrop, worst over an N×N grid of
 * points (cell centres, in the element's rotated frame) across each of
 * `areas` — for text, the boxes its glyphs actually fill (one per rendered
 * line, measured by the caller), since a text box larger than its words has
 * corners with nothing in them to read. Absent `areas` = the whole box.
 * null when the element has no colour of its own to judge (pictures, charts,
 * a shape with neither fill nor stroke).
 */
export function measureContrast(el: SlideElement, slide: Slide, n = 5, areas?: Area[]): ContrastReading | null {
  const below = slide.elements.slice(0, Math.max(0, slide.elements.findIndex((e) => e.id === el.id)))
  const alpha = el.opacity ?? 1
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2
  const a = ((el.rotation || 0) * Math.PI) / 180
  let worst: ContrastReading | null = null
  const samples: number[] = []
  for (const box of areas?.length ? areas : [{ x: el.x, y: el.y, w: el.w, h: el.h }]) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        // the cell centre in the element's frame, turned onto the slide
        const qx = box.x + ((i + 0.5) / n) * box.w, qy = box.y + ((j + 0.5) / n) * box.h
        const lx = qx - cx, ly = qy - cy
        const px = cx + lx * Math.cos(a) - ly * Math.sin(a), py = cy + lx * Math.sin(a) + ly * Math.cos(a)
        // ponytail: pictures, charts and text below are not sampled — the slide background shows through them here
        let bg: RGBA = over(rgba(slide.background), [255, 255, 255, 1])
        for (const e of below) {
          if (e.hidden || e.type !== 'shape' || e.shape === 'line' || !covers(e, px, py)) continue
          bg = over(shapePaint(e, px, py, bg), bg, e.opacity ?? 1)
        }
        const own = ownPaint(el, px, py)
        if (!own) return null
        const fg = over(own, bg, alpha)
        const r = ratio(fg, bg)
        samples.push(r)
        // which third of the ELEMENT the point falls in, whatever area it came from
        const col = Math.min(2, Math.max(0, Math.floor(((qx - el.x) / (el.w || 1)) * 3)))
        const row = Math.min(2, Math.max(0, Math.floor(((qy - el.y) / (el.h || 1)) * 3)))
        if (!worst || r < worst.ratio) worst = { ratio: r, at: [col, row], samples }
      }
    }
  }
  return worst
}
