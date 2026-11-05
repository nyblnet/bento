// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Alt-hover measurement geometry: what to draw between the selection (the
// reference) and the box under the pointer. Pure and DOM-free so the rules can
// be proven in node (scripts/test-slides-measure-geom.ts); canvas.ts only paints
// the result.
//
// Each axis is decided on its own: separated → one edge-to-edge gap; touching
// or overlapping → never a negative gap, but the offsets between corresponding
// edges, and an accent guide wherever edges or centres coincide. The y axis is
// the x axis transposed, so one function serves both.

export interface Box { x: number; y: number; w: number; h: number }
/** a solid line carrying a distance label */
export interface Measure { x1: number; y1: number; x2: number; y2: number; value: number }
/** 'dash' extends a measure to the edge it refers to; 'align' marks coincidence */
export interface Guide { x1: number; y1: number; x2: number; y2: number; kind: 'dash' | 'align' }

/** Edges closer than this count as coinciding — sub-pixel drift from a drag
 *  should read as "aligned", not as a 0.3 label. */
export const EPS = 0.5

/** The axis-aligned box a rotated element occupies — what the eye measures
 *  against, and what a neighbour's gap is really to. */
export function aabb(b: Box & { rotation?: number }): Box {
  const deg = b.rotation ?? 0
  if (!deg || !(deg % 360)) return { x: b.x, y: b.y, w: b.w, h: b.h }
  const r = (deg * Math.PI) / 180
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r))
  const w = b.w * c + b.h * s, h = b.w * s + b.h * c
  return { x: b.x + b.w / 2 - w / 2, y: b.y + b.h / 2 - h / 2, w, h }
}

export function union(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  const l = Math.min(...boxes.map((b) => b.x)), t = Math.min(...boxes.map((b) => b.y))
  const r = Math.max(...boxes.map((b) => b.x + b.w)), btm = Math.max(...boxes.map((b) => b.y + b.h))
  return { x: l, y: t, w: r - l, h: btm - t }
}

/** Inspector rounding: integers, one decimal only when fractional. */
export const fmt = (v: number) => String(Math.round(v * 10) / 10)

export function measureBoxes(ref: Box, tgt: Box): { measures: Measure[]; guides: Guide[] } {
  const measures: Measure[] = [], guides: Guide[] = []
  axis(ref, tgt, false, measures, guides)
  axis(ref, tgt, true, measures, guides)
  // a zero-size box makes start and end edges the same line — say it once
  const seen = new Set<string>()
  const key = (s: { x1: number; y1: number; x2: number; y2: number }, k: string) =>
    [k, ...[s.x1, s.y1, s.x2, s.y2].map((v) => Math.round(v * 10))].join()
  return {
    measures: measures.filter((m) => !seen.has(key(m, 'm')) && !!seen.add(key(m, 'm'))),
    guides: guides.filter((g) => !seen.has(key(g, g.kind)) && !!seen.add(key(g, g.kind))),
  }
}

// u = the axis being measured, v = the other one. flip swaps them (y axis).
function axis(ref: Box, tgt: Box, flip: boolean, measures: Measure[], guides: Guide[]) {
  const span = (b: Box) => (flip ? [b.y, b.y + b.h, b.x, b.x + b.w] : [b.x, b.x + b.w, b.y, b.y + b.h])
  const [rs, re, rvs, rve] = span(ref)
  const [ts, te, tvs, tve] = span(tgt)
  const pt = (u1: number, v1: number, u2: number, v2: number) =>
    flip ? { x1: v1, y1: u1, x2: v2, y2: u2 } : { x1: u1, y1: v1, x2: u2, y2: v2 }
  const measure = (u1: number, u2: number, v: number) => {
    if (Math.abs(u2 - u1) > EPS) measures.push({ ...pt(u1, v, u2, v), value: Math.abs(u2 - u1) })
  }
  const dash = (u: number, v1: number, v2: number) => {
    if (Math.abs(v2 - v1) > EPS) guides.push({ ...pt(u, v1, u, v2), kind: 'dash' })
  }
  // where the target sits on the OTHER axis: past the reference, before it, or level with it
  const vAfter = tvs - rve > EPS, vBefore = rvs - tve > EPS
  const vSep = vAfter || vBefore

  const after = ts - re > EPS, before = rs - te > EPS
  if (after || before) {
    const refEdge = after ? re : rs, tgtEdge = after ? ts : te
    if (!vSep) {
      // level: the gap runs through the middle of what the two share
      measure(refEdge, tgtEdge, (Math.max(rvs, tvs) + Math.min(rve, tve)) / 2)
    } else {
      // diagonal: out of the reference's facing edge at its centre, then a dash
      // along the target's edge to show which edge the number reaches
      const v = (rvs + rve) / 2
      measure(refEdge, tgtEdge, v)
      dash(tgtEdge, v, vAfter ? tvs : tve)
    }
    return
  }

  // touching or overlapping: coincident edges/centres get a full-length guide
  const vMin = Math.min(rvs, tvs), vMax = Math.max(rve, tve)
  const pairs: [number, number][] = [[rs, ts], [re, te], [(rs + re) / 2, (ts + te) / 2], [rs, te], [re, ts]]
  for (const [a, b] of pairs) if (Math.abs(a - b) <= EPS) guides.push({ ...pt(a, vMin, a, vMax), kind: 'align' })
  if (ts - re >= -EPS || rs - te >= -EPS) return // abutting: the guide says it all

  // overlapping: start-to-start and end-to-end, never a negative gap
  for (const [a, b] of [[rs, ts], [re, te]] as const) {
    if (Math.abs(a - b) <= EPS) continue
    if (!vSep) measure(a, b, (Math.max(rvs, tvs) + Math.min(rve, tve)) / 2)
    else {
      // stacked: measured along the target's facing edge, dashed back to the reference
      const v = vAfter ? tvs : tve
      measure(a, b, v)
      dash(a, vAfter ? rve : rvs, v)
    }
  }
}
