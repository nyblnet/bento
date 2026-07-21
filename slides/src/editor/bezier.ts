// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// Exact cubic-bezier path model for true pen-tool editing. Unlike the old
// Catmull-Rom approach (which SAMPLED the rendered curve back into approximate
// anchors and re-smoothed on every edit — lossy, drifting, no real handles),
// this parses the path's actual control points and edits them directly, so the
// on-screen handles ARE the curve and a round-trip is byte-stable.
//
// Coordinates here are path-local (the space of ShapeElement.d / pathBox); the
// editor maps to/from slide coords. Segments are always cubic; straight bits
// are cubics whose handles sit on the chord, so everything edits uniformly.

export type Pt = { x: number; y: number }

/** One on-curve anchor with its incoming/outgoing control handles (absolute
 *  path coords). `in` is undefined on the first node of an open path, `out` on
 *  the last. `corner` = handles move independently (no smooth mirroring). */
export interface BezNode {
  p: Pt
  in?: Pt
  out?: Pt
  corner?: boolean
}

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const r = (v: number) => Math.round(v * 100) / 100

/** Parse an SVG path of M / L / C (+ optional trailing Z) into cubic nodes.
 *  L segments become cubics with handles on the chord (thirds) so they edit
 *  like everything else. Our own generators only emit these commands; exotic
 *  commands (Q/S/T/A) are ignored gracefully (their endpoints still land). */
export function parseBezier(d: string): { nodes: BezNode[]; closed: boolean } {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  const nodes: BezNode[] = []
  let closed = false
  let i = 0
  let cmd = ''
  const num = () => Number(tokens[i++])
  while (i < tokens.length) {
    const tk = tokens[i]
    if (/^[A-Za-z]$/.test(tk)) {
      cmd = tk
      i++
      if (/z/i.test(cmd)) closed = true
      continue
    }
    const C = cmd.toUpperCase()
    if (C === 'M') {
      nodes.push({ p: { x: num(), y: num() } })
    } else if (C === 'L') {
      const p = { x: num(), y: num() }
      const prev = nodes[nodes.length - 1]
      if (prev) prev.out = prev.out ?? lerp(prev.p, p, 1 / 3)
      nodes.push({ p, in: lerp(prev ? prev.p : p, p, 2 / 3) })
    } else if (C === 'C') {
      const c1 = { x: num(), y: num() }
      const c2 = { x: num(), y: num() }
      const p = { x: num(), y: num() }
      const prev = nodes[nodes.length - 1]
      if (prev) prev.out = c1
      nodes.push({ p, in: c2 })
    } else {
      // unknown command: consume two numbers as an endpoint so we stay in sync
      const p = { x: num(), y: num() }
      if (!Number.isNaN(p.x) && !Number.isNaN(p.y)) nodes.push({ p })
    }
  }
  return { nodes, closed }
}

/** Serialize nodes back to a path string. Missing handles fall back to the
 *  chord thirds (a straight segment), so partial nodes never crash the render. */
export function serializeBezier(nodes: BezNode[], closed: boolean): string {
  if (!nodes.length) return ''
  if (nodes.length === 1) return `M ${r(nodes[0].p.x)} ${r(nodes[0].p.y)}`
  const seg = (a: BezNode, b: BezNode) => {
    const c1 = a.out ?? lerp(a.p, b.p, 1 / 3)
    const c2 = b.in ?? lerp(a.p, b.p, 2 / 3)
    return ` C ${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(b.p.x)} ${r(b.p.y)}`
  }
  let d = `M ${r(nodes[0].p.x)} ${r(nodes[0].p.y)}`
  for (let i = 0; i < nodes.length - 1; i++) d += seg(nodes[i], nodes[i + 1])
  if (closed && nodes.length > 2) {
    d += seg(nodes[nodes.length - 1], nodes[0])
    d += ' Z'
  }
  return d
}

/** Evaluate the cubic p0→p3 (controls c1,c2) at parameter t. */
export function cubicAt(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const dd = t * t * t
  return {
    x: a * p0.x + b * c1.x + c * c2.x + dd * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + dd * p3.y,
  }
}

/** Nearest parameter t on the cubic to point q (coarse sample + local refine). */
export function nearestT(p0: Pt, c1: Pt, c2: Pt, p3: Pt, q: Pt): number {
  const N = 24
  let bestT = 0
  let bestD = Infinity
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const pt = cubicAt(p0, c1, c2, p3, t)
    const d = (pt.x - q.x) ** 2 + (pt.y - q.y) ** 2
    if (d < bestD) { bestD = d; bestT = t }
  }
  let step = 1 / N
  for (let iter = 0; iter < 12; iter++) {
    step /= 2
    for (const t of [bestT - step, bestT + step]) {
      if (t < 0 || t > 1) continue
      const pt = cubicAt(p0, c1, c2, p3, t)
      const d = (pt.x - q.x) ** 2 + (pt.y - q.y) ** 2
      if (d < bestD) { bestD = d; bestT = t }
    }
  }
  return bestT
}

/** de Casteljau split of the segment a→b at t. Returns updated a/b (their inner
 *  handles shrink to the split) and the new middle node — shape is preserved
 *  exactly. The middle node is smooth. */
export function splitSegment(a: BezNode, b: BezNode, t: number): { a: BezNode; mid: BezNode; b: BezNode } {
  const p0 = a.p
  const c1 = a.out ?? lerp(a.p, b.p, 1 / 3)
  const c2 = b.in ?? lerp(a.p, b.p, 2 / 3)
  const p3 = b.p
  const q0 = lerp(p0, c1, t)
  const q1 = lerp(c1, c2, t)
  const q2 = lerp(c2, p3, t)
  const s0 = lerp(q0, q1, t)
  const s1 = lerp(q1, q2, t)
  const mid = lerp(s0, s1, t)
  return {
    a: { ...a, out: q0 },
    mid: { p: mid, in: s0, out: s1 },
    b: { ...b, in: q2 },
  }
}

/** Mirror handle `h` about anchor `p` (for smooth-node symmetry), preserving the
 *  opposite handle's original length so a smooth node isn't forced symmetric. */
export function mirrorHandle(p: Pt, h: Pt, oppLen: number): Pt {
  const dx = p.x - h.x
  const dy = p.y - h.y
  const len = Math.hypot(dx, dy)
  if (!len) return { ...p }
  const k = oppLen / len
  return { x: p.x + dx * k, y: p.y + dy * k }
}

export const handleLen = (p: Pt, h?: Pt): number => (h ? Math.hypot(h.x - p.x, h.y - p.y) : 0)
