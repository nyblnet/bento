// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// SHARED SHAPE RENDERING — model → <svg> for rect / ellipse / triangle / arrow /
// line / arbitrary path, with gradients, line-tip markers (the kernel tip
// catalogue) and dash styles. Lifted out of slides (render.ts) so bento/spaces
// diagrams render shapes through ONE engine. Step 2 of the diagram-engine move;
// slides re-exports these from render.ts so its imports — and the pixels — are
// unchanged.
//
// This builds DOM nodes (document.createElementNS), as the kernel UI primitives
// already do, but reads NO layout and imports nothing from an app: the element
// argument is a STRUCTURAL ShapeSpec (the fields the renderer reads), which a
// slides ShapeElement satisfies, so the kernel depends on no app type. Geometry
// math is in kernel/src/geom.ts; the tip catalogue + path-tip math in
// kernel/src/tips.ts.

import { shortenPathEnds, tipInsetPx, tipSpec, type TipKind } from './tips.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** A linear gradient fill (CSS angle convention: 0deg = bottom→top). */
export interface GradientSpec {
  angle: number
  stops: Array<{ at: number; color: string }>
}

/** The shape fields the renderer reads — a slides ShapeElement satisfies this.
 *  `shape` is the closed kind set (not `string`) so the render switch stays
 *  exhaustive, as it was in render.ts. */
export interface ShapeSpec {
  shape: 'rect' | 'ellipse' | 'triangle' | 'arrow' | 'line' | 'path'
  w: number
  h: number
  fill: string
  stroke: string
  strokeWidth: number
  /** corner radius, rect only */
  radius?: number
  /** when set, wins over `fill` */
  fillGradient?: GradientSpec
  /** legacy numeric dash length (px) */
  strokeDash?: number
  /** stroke pattern; wins over strokeDash */
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  /** line/path only: tip decorations */
  lineStart?: TipKind
  lineEnd?: TipKind
  /** arrow only: 2 = a head at both ends */
  heads?: number
  /** path only: SVG path data in the coordinate space given by pathBox */
  d?: string
  /** path only: [x, y, w, h] viewBox the path was authored in */
  pathBox?: [number, number, number, number]
}

// Module-global id counters: svg url(#…) references resolve DOCUMENT-WIDE (the
// same gradient/marker ids appear on the canvas, in sidebar thumbnails and in
// the present overlay), so each minted id must be unique across them. One app
// runs per page, so a shared counter here is still unique.
let gradSeq = 0

/** Gradient line endpoints (objectBoundingBox units) for a CSS-convention
 *  angle: 0deg points up, 90deg points right. Shared with morph tweening. */
export function gradientLineCoords(angle: number) {
  const rad = ((angle ?? 180) * Math.PI) / 180
  const dx = Math.sin(rad) / 2
  const dy = -Math.cos(rad) / 2
  return { x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy }
}

/** CSS linear-gradient() from a GradientFill. CSS angle convention matches the
 *  model (0deg = bottom->top, 90deg = left->right), so pass angle straight. */
export function cssLinearGradient(g: GradientSpec): string {
  const stops = g.stops
    .map((s) => `${s.color} ${Math.round(Math.min(Math.max(s.at, 0), 1) * 100)}%`)
    .join(', ')
  return `linear-gradient(${g.angle}deg, ${stops})`
}

/** Materialize a GradientFill as a <defs> gradient; returns its url() ref. */
function gradientRef(svg: SVGSVGElement, g: GradientSpec): string {
  const id = `bento-grad-${gradSeq++}`
  const defs = document.createElementNS(SVG_NS, 'defs')
  const lin = document.createElementNS(SVG_NS, 'linearGradient')
  lin.setAttribute('id', id)
  const { x1, y1, x2, y2 } = gradientLineCoords(g.angle)
  lin.setAttribute('x1', String(x1))
  lin.setAttribute('y1', String(y1))
  lin.setAttribute('x2', String(x2))
  lin.setAttribute('y2', String(y2))
  for (const s of g.stops) {
    const stop = document.createElementNS(SVG_NS, 'stop')
    stop.setAttribute('offset', String(Math.min(Math.max(s.at, 0), 1)))
    stop.setAttribute('stop-color', s.color)
    lin.appendChild(stop)
  }
  defs.appendChild(lin)
  svg.appendChild(defs)
  return `url(#${id})`
}

/** stroke-dasharray for the element's line style (undefined = solid). */
function dashArray(el: ShapeSpec, w: number): string | undefined {
  if (el.strokeStyle === 'dashed') return `${Math.max(w * 2.4, 7)} ${Math.max(w * 1.8, 5)}`
  if (el.strokeStyle === 'dotted') return `0.1 ${Math.max(w * 2.2, 5)}`
  if (el.strokeStyle === 'solid') return undefined
  if (el.strokeDash) return `${el.strokeDash} ${el.strokeDash}` // legacy numeric dash
  return undefined
}

let markSeq = 0

/** A line-tip marker in <defs>; sized in strokeWidth units, colored like the
 *  line. Geometry comes from tips.ts — one catalogue for every tip. A hollow
 *  tip is an outline in the line colour with an open interior. */
function markerRef(svg: SVGSVGElement, kind: TipKind, color: string, start: boolean): string | null {
  const spec = tipSpec(kind)
  if (!spec) return null
  const id = `bento-mark-${markSeq++}`
  const marker = document.createElementNS(SVG_NS, 'marker')
  marker.setAttribute('id', id)
  marker.setAttribute('viewBox', '0 0 8 8')
  marker.setAttribute('refX', String(spec.refX))
  marker.setAttribute('refY', '4')
  marker.setAttribute('orient', start ? 'auto-start-reverse' : 'auto')
  marker.setAttribute('markerWidth', String(spec.size))
  marker.setAttribute('markerHeight', String(spec.size))
  const g = spec.geom
  let tip: SVGElement
  if (g.tag === 'path') {
    tip = document.createElementNS(SVG_NS, 'path')
    tip.setAttribute('d', g.d)
  } else if (g.tag === 'circle') {
    tip = document.createElementNS(SVG_NS, 'circle')
    tip.setAttribute('cx', String(g.cx))
    tip.setAttribute('cy', String(g.cy))
    tip.setAttribute('r', String(g.r))
  } else {
    tip = document.createElementNS(SVG_NS, 'rect')
    tip.setAttribute('x', String(g.x))
    tip.setAttribute('y', String(g.y))
    tip.setAttribute('width', String(g.w))
    tip.setAttribute('height', String(g.h))
  }
  if (spec.hollow) {
    tip.setAttribute('fill', 'none')
    tip.setAttribute('stroke', color)
    tip.setAttribute('stroke-width', '1.1')
    tip.setAttribute('stroke-linejoin', 'round')
  } else {
    tip.setAttribute('fill', color)
  }
  marker.appendChild(tip)
  let defs = svg.querySelector('defs')
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs')
    svg.appendChild(defs)
  }
  defs.appendChild(marker)
  return `url(#${id})`
}

export function shapeSvg(el: ShapeSpec): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  const { w, h } = el
  const sw = el.strokeWidth
  const inset = sw / 2
  svg.setAttribute('viewBox', `0 0 ${Math.max(w, 1)} ${Math.max(h, 1)}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible'

  let node: SVGElement
  switch (el.shape) {
    case 'path': {
      // arbitrary vector data, stretched from its authored viewBox into the box
      if (el.pathBox) svg.setAttribute('viewBox', el.pathBox.join(' '))
      node = document.createElementNS(SVG_NS, 'path')
      let d = el.d ?? ''
      // Tips on a curve (#302): SVG orients a marker along the path's own end
      // tangent, so the head points the way the curve arrives. The endpoint is
      // pulled back along that tangent by the tip's inset (tips.ts) so the
      // point lands on the model's endpoint and a hollow head has no stroke
      // inside it. Insets are in slide px; the path is in pathBox units, so
      // divide by the box→slide scale (uniform for anything the editor draws —
      // a connector is renormalised on every re-route).
      if ((el.lineStart || el.lineEnd) && sw > 0 && !/z\s*$/i.test(d)) {
        const [, , pw, ph] = el.pathBox ?? [0, 0, w, h]
        const k = ((w / (pw || 1)) + (h / (ph || 1))) / 2 || 1
        d = shortenPathEnds(d, tipInsetPx(el.lineStart, sw) / k, tipInsetPx(el.lineEnd, sw) / k)
        const color = el.stroke && el.stroke !== 'transparent' ? el.stroke : el.fill
        const mStart = el.lineStart ? markerRef(svg, el.lineStart, color, true) : null
        const mEnd = el.lineEnd ? markerRef(svg, el.lineEnd, color, false) : null
        if (mStart) node.setAttribute('marker-start', mStart)
        if (mEnd) node.setAttribute('marker-end', mEnd)
        if (tipSpec(el.lineStart)?.hollow || tipSpec(el.lineEnd)?.hollow) node.setAttribute('stroke-linecap', 'butt')
      }
      node.setAttribute('d', d)
      if (sw > 0) node.setAttribute('vector-effect', 'non-scaling-stroke')
      break
    }
    case 'rect': {
      node = document.createElementNS(SVG_NS, 'rect')
      node.setAttribute('x', String(inset))
      node.setAttribute('y', String(inset))
      node.setAttribute('width', String(Math.max(w - sw, 0)))
      node.setAttribute('height', String(Math.max(h - sw, 0)))
      if (el.radius) node.setAttribute('rx', String(el.radius))
      break
    }
    case 'ellipse': {
      node = document.createElementNS(SVG_NS, 'ellipse')
      node.setAttribute('cx', String(w / 2))
      node.setAttribute('cy', String(h / 2))
      node.setAttribute('rx', String(Math.max(w / 2 - inset, 0)))
      node.setAttribute('ry', String(Math.max(h / 2 - inset, 0)))
      break
    }
    case 'triangle': {
      node = document.createElementNS(SVG_NS, 'polygon')
      node.setAttribute('points', `${w / 2},${inset} ${w - inset},${h - inset} ${inset},${h - inset}`)
      break
    }
    case 'arrow': {
      // right-pointing arrow: shaft + head, proportional to the box
      node = document.createElementNS(SVG_NS, 'polygon')
      const shaftH = h * 0.44
      const y0 = (h - shaftH) / 2
      if (el.heads === 2) {
        // a head at BOTH ends (#304): the same head, mirrored, symmetric about
        // the box centre. Still `shape: 'arrow'` — a shell that predates
        // `heads` draws the single arrow. Morph: the polygon's points are not
        // tweened (no shape geometry is); a one-head ↔ two-head morph tweens
        // the box and fill and the point list snaps at the swap.
        const headW = Math.min(w * 0.3, h)
        node.setAttribute(
          'points',
          `0,${h / 2} ${headW},0 ${headW},${y0} ${w - headW},${y0} ${w - headW},0 ${w},${h / 2} ${w - headW},${h} ${w - headW},${y0 + shaftH} ${headW},${y0 + shaftH} ${headW},${h}`,
        )
        break
      }
      const headW = Math.min(w * 0.38, h)
      node.setAttribute(
        'points',
        `0,${y0} ${w - headW},${y0} ${w - headW},0 ${w},${h / 2} ${w - headW},${h} ${w - headW},${y0 + shaftH} 0,${y0 + shaftH}`,
      )
      break
    }
    case 'line': {
      node = document.createElementNS(SVG_NS, 'line')
      const lw = Math.max(sw, 2)
      // inset the endpoints so the tip's point lands on the box edge (tips.ts:
      // the three original kinds keep their 2.6 — every old deck unchanged)
      node.setAttribute('x1', String(tipInsetPx(el.lineStart, lw)))
      node.setAttribute('y1', String(h / 2))
      node.setAttribute('x2', String(w - tipInsetPx(el.lineEnd, lw)))
      node.setAttribute('y2', String(h / 2))
      node.setAttribute('stroke', el.fill)
      node.setAttribute('stroke-width', String(lw))
      const hollow = tipSpec(el.lineStart)?.hollow || tipSpec(el.lineEnd)?.hollow
      node.setAttribute('stroke-linecap', el.strokeStyle === 'dashed' || hollow ? 'butt' : 'round')
      const lineDash = dashArray(el, lw)
      if (lineDash) node.setAttribute('stroke-dasharray', lineDash)
      const mStart = el.lineStart ? markerRef(svg, el.lineStart, el.fill, true) : null
      const mEnd = el.lineEnd ? markerRef(svg, el.lineEnd, el.fill, false) : null
      if (mStart) node.setAttribute('marker-start', mStart)
      if (mEnd) node.setAttribute('marker-end', mEnd)
      svg.appendChild(node)
      return svg
    }
  }
  node.setAttribute('fill', el.fillGradient?.stops.length ? gradientRef(svg, el.fillGradient) : el.fill)
  if (el.stroke && el.stroke !== 'transparent' && sw > 0) {
    node.setAttribute('stroke', el.stroke)
    node.setAttribute('stroke-width', String(sw))
    const dash = dashArray(el, sw)
    if (dash) node.setAttribute('stroke-dasharray', dash)
    if (el.strokeStyle === 'dotted') node.setAttribute('stroke-linecap', 'round')
  }
  svg.appendChild(node)
  return svg
}
