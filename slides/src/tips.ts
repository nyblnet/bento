// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Line tips — the ONE catalogue behind `lineStart`/`lineEnd` (discussion
 * #303): the model's allowed values, the shape gate, the panel's options and
 * the renderer's marker geometry all read this list, so a tip cannot exist in
 * one place and not another.
 *
 * Geometry lives in an 8×8 marker frame, the line arriving from the left and
 * the tip pointing +x. `size` is the marker's width in STROKE units (SVG
 * `markerUnits="strokeWidth"`), `refX` the frame x that sits on the line's
 * end, `tipX` where the point is. A hollow tip needs the line to STOP at the
 * head's back edge — otherwise the stroke shows through the hollow — so the
 * renderer insets the endpoint by `inset` stroke units, which for the new
 * kinds is exactly the distance from the line end to the point. The three
 * original kinds keep their historic numbers (2.6 inset, refX inside the
 * head) so every existing deck renders byte-identically.
 *
 * DEGRADE, stated plainly: in 1.1.0 and older the renderer matches only
 * 'arrow' and 'dot' and draws a BAR for anything else — so a deck carrying
 * one of the seven newer tips shows a bar at that end in those shells, not a
 * plain end. Nothing throws; the deck opens.
 *
 * Also here, because a curved connector needs it (#302): the END TANGENT of
 * a cubic path, so a tip on a curve points along the curve and the endpoint
 * is inset along it, not along the chord.
 */

import { parseBezier, serializeBezier, type BezNode, type Pt } from './editor/bezier'

export type TipKind = 'none' | 'arrow' | 'dot' | 'bar' | 'arrow-open' | 'triangle' | 'triangle-open' | 'diamond' | 'diamond-open' | 'square' | 'circle-open'

export interface TipSpec {
  kind: TipKind
  /** panel label, English key for t() */
  label: string
  /** marker width in stroke units */
  size: number
  refX: number
  tipX: number
  /** 'path' | 'circle' | 'rect' + geometry in the 8×8 frame */
  geom: { tag: 'path'; d: string } | { tag: 'circle'; cx: number; cy: number; r: number } | { tag: 'rect'; x: number; y: number; w: number; h: number }
  /** drawn as an outline in the line's colour, interior left open */
  hollow?: boolean
  /** endpoint inset in stroke units; legacy kinds pin 2.6 */
  inset: number
}

const geometric = (tipX: number, refX: number, size: number) => Math.round(((tipX - refX) * size / 8) * 100) / 100

export const TIPS: ReadonlyArray<TipSpec> = [
  { kind: 'none', label: 'none', size: 0, refX: 0, tipX: 0, geom: { tag: 'path', d: '' }, inset: 0 },
  // the original three — numbers unchanged since 1.0.2
  { kind: 'arrow', label: 'Arrow', size: 5.5, refX: 6.4, tipX: 7.6, geom: { tag: 'path', d: 'M 0 0.4 L 7.6 4 L 0 7.6 Z' }, inset: 2.6 },
  { kind: 'dot', label: 'Dot', size: 5.5, refX: 4, tipX: 6.6, geom: { tag: 'circle', cx: 4, cy: 4, r: 2.6 }, inset: 2.6 },
  { kind: 'bar', label: 'Bar', size: 5.5, refX: 4, tipX: 4.8, geom: { tag: 'rect', x: 3.2, y: 0.4, w: 1.6, h: 7.2 }, inset: 2.6 },
  // #303
  { kind: 'arrow-open', label: 'Open arrow', size: 5.5, refX: 7.2, tipX: 7.6, geom: { tag: 'path', d: 'M 0.4 0.4 L 7.6 4 L 0.4 7.6' }, hollow: true, inset: geometric(7.6, 7.2, 5.5) },
  { kind: 'triangle', label: 'Triangle', size: 7.5, refX: 0.4, tipX: 7.6, geom: { tag: 'path', d: 'M 0.4 0.4 L 7.6 4 L 0.4 7.6 Z' }, inset: geometric(7.6, 0.4, 7.5) },
  { kind: 'triangle-open', label: 'Hollow triangle', size: 7.5, refX: 0.4, tipX: 7.6, geom: { tag: 'path', d: 'M 0.4 0.4 L 7.6 4 L 0.4 7.6 Z' }, hollow: true, inset: geometric(7.6, 0.4, 7.5) },
  { kind: 'diamond', label: 'Diamond', size: 6.5, refX: 0.4, tipX: 7.6, geom: { tag: 'path', d: 'M 0.4 4 L 4 0.8 L 7.6 4 L 4 7.2 Z' }, inset: geometric(7.6, 0.4, 6.5) },
  { kind: 'diamond-open', label: 'Hollow diamond', size: 6.5, refX: 0.4, tipX: 7.6, geom: { tag: 'path', d: 'M 0.4 4 L 4 0.8 L 7.6 4 L 4 7.2 Z' }, hollow: true, inset: geometric(7.6, 0.4, 6.5) },
  { kind: 'square', label: 'Square', size: 5.5, refX: 1.2, tipX: 7.6, geom: { tag: 'rect', x: 1.2, y: 0.8, w: 6.4, h: 6.4 }, inset: geometric(7.6, 1.2, 5.5) },
  { kind: 'circle-open', label: 'Hollow circle', size: 5.5, refX: 0.8, tipX: 7.2, geom: { tag: 'circle', cx: 4, cy: 4, r: 3.2 }, hollow: true, inset: geometric(7.2, 0.8, 5.5) },
]

export const TIP_KINDS: ReadonlyArray<TipKind> = TIPS.map((t) => t.kind)

export const tipSpec = (kind: string | undefined): TipSpec | undefined =>
  kind && kind !== 'none' ? TIPS.find((t) => t.kind === kind) : undefined

/** Endpoint inset for a tip, in px, given the drawn stroke width. */
export const tipInsetPx = (kind: string | undefined, strokePx: number): number => (tipSpec(kind)?.inset ?? 0) * strokePx

/** Unit tangent at a path's start or end: from the end node's own handle,
 *  else the neighbour's handle, else the chord — so a degenerate (zero
 *  length) handle never yields a zero vector. `null` for fewer than 2 nodes. */
export function endTangent(nodes: ReadonlyArray<BezNode>, atEnd: boolean): Pt | null {
  if (nodes.length < 2) return null
  const a = atEnd ? nodes[nodes.length - 2] : nodes[1]
  const b = atEnd ? nodes[nodes.length - 1] : nodes[0]
  // direction pointing OUT of the path at that end
  const candidates: Array<[Pt, Pt]> = atEnd
    ? [[b.in ?? b.p, b.p], [a.out ?? a.p, b.p], [a.p, b.p]]
    : [[b.out ?? b.p, b.p], [a.in ?? a.p, b.p], [a.p, b.p]]
  for (const [from, to] of candidates) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len = Math.hypot(dx, dy)
    if (len > 1e-6) return { x: dx / len, y: dy / len }
  }
  return null
}

/** The path `d` with each tipped end pulled back along its tangent by the
 *  given amounts (path units), so a marker's point lands where the model's
 *  endpoint is and a hollow head has no stroke inside it. Interior nodes are
 *  untouched; the end node's handle moves with it so the curve keeps its
 *  arrival direction. */
export function shortenPathEnds(d: string, startBy: number, endBy: number): string {
  if (!(startBy > 0) && !(endBy > 0)) return d
  const { nodes, closed } = parseBezier(d)
  if (closed || nodes.length < 2) return d
  const pull = (i: number, by: number, atEnd: boolean) => {
    const t = endTangent(nodes, atEnd)
    if (!t || !(by > 0)) return
    const n = nodes[i]
    const dx = -t.x * by
    const dy = -t.y * by
    const h = atEnd ? n.in : n.out
    nodes[i] = { ...n, p: { x: n.p.x + dx, y: n.p.y + dy }, ...(h ? (atEnd ? { in: { x: h.x + dx, y: h.y + dy } } : { out: { x: h.x + dx, y: h.y + dy } }) : {}) }
  }
  pull(0, startBy, false)
  pull(nodes.length - 1, endBy, true)
  return serializeBezier(nodes, false)
}

/**
 * Move a path's first and/or last on-curve point (path units) for connector
 * re-routing (#302). The moved node's handle is recomputed the auto way —
 * one sixth of the way toward its neighbour, the Catmull-Rom end rule the
 * curve editor uses for untouched nodes — so the curve leaves the new anchor
 * smoothly; the neighbour's facing handle is recomputed only if it was auto
 * itself (matched the rule before the move), so a hand-shaped interior point
 * keeps its tangents. Every other node is returned byte-identical.
 */
export function movePathEnds(d: string, start: Pt | null, end: Pt | null): string {
  const { nodes, closed } = parseBezier(d)
  if (closed || nodes.length < 2 || (!start && !end)) return d
  const sixth = (from: Pt, to: Pt): Pt => ({ x: from.x + (to.x - from.x) / 6, y: from.y + (to.y - from.y) / 6 })
  const near = (a: Pt | undefined, b: Pt) => !!a && Math.abs(a.x - b.x) < 0.02 && Math.abs(a.y - b.y) < 0.02
  const catmullIn = (i: number): Pt => {
    // Catmull-Rom incoming handle at node i (P(i) - (P(i+1) - P(i-1)) / 6)
    const P = (k: number) => nodes[Math.max(0, Math.min(nodes.length - 1, k))].p
    return { x: P(i).x - (P(i + 1).x - P(i - 1).x) / 6, y: P(i).y - (P(i + 1).y - P(i - 1).y) / 6 }
  }
  const catmullOut = (i: number): Pt => {
    const P = (k: number) => nodes[Math.max(0, Math.min(nodes.length - 1, k))].p
    return { x: P(i).x + (P(i + 1).x - P(i - 1).x) / 6, y: P(i).y + (P(i + 1).y - P(i - 1).y) / 6 }
  }
  if (start) {
    const nb = nodes[1]
    const nbWasAuto = near(nb.in, catmullIn(1))
    nodes[0] = { p: start, out: sixth(start, nb.p) }
    if (nbWasAuto) nodes[1] = { ...nb, in: catmullIn(1) }
  }
  if (end) {
    const last = nodes.length - 1
    const nb = nodes[last - 1]
    const nbWasAuto = near(nb.out, catmullOut(last - 1))
    nodes[last] = { p: end, in: sixth(end, nb.p) }
    if (nbWasAuto) nodes[last - 1] = { ...nb, out: catmullOut(last - 1) }
  }
  return serializeBezier(nodes, false)
}

/** First and last on-curve points of a path (path units). */
export function pathEnds(d: string): [Pt, Pt] | null {
  const { nodes } = parseBezier(d)
  if (nodes.length < 2) return null
  return [nodes[0].p, nodes[nodes.length - 1].p]
}
