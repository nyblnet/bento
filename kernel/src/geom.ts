// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// SHARED 2-D GEOMETRY — the pure math behind shapes, lines, connectors and
// curve editing, lifted out of slides so a second app (spaces diagrams) can
// share ONE engine rather than grow a parallel copy. This is step 1 of that
// move: the DOM-free core only. The editor CLASSES (LineEditor, PathEditor,
// BezierEditor), the DOM path sampler (samplePathAnchors) and the connector
// re-route stay app-side for now; slides re-exports every symbol below from its
// old paths (editor/bezier.ts, editor/lineedit.ts, editor/patheditor.ts) so its
// imports — and its behaviour — are unchanged.
//
// Nothing here touches the DOM or any app module: the few functions that took a
// slides `ShapeElement` take a STRUCTURAL box instead ({x,y,w,h,rotation?}),
// which a ShapeElement satisfies, so the kernel depends on no app type.
//
// ————————————————————————— exact cubic beziers —————————————————————————
// (verbatim from slides/src/editor/bezier.ts) Coordinates are path-local (the
// space of ShapeElement.d / pathBox); callers map to/from slide coords. Segments
// are always cubic; straight bits are cubics whose handles sit on the chord.

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

// ————————————————————— anchors & polyline reduction —————————————————————
// (pure helpers from slides/src/editor/patheditor.ts)

/** Anchor points out of a path string: the M point plus each segment end. */
export function parseAnchors(d: string): Pt[] {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  const pts: Pt[] = []
  let i = 0
  let cmd = ''
  const arity: Record<string, number> = { M: 2, L: 2, T: 2, Q: 4, S: 4, C: 6 }
  while (i < tokens.length) {
    const t = tokens[i]
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t.toUpperCase()
      i++
      continue
    }
    const n = arity[cmd] ?? 2
    const nums = tokens.slice(i, i + n).map(Number)
    if (nums.length === n && nums.every((v) => !Number.isNaN(v))) {
      pts.push({ x: nums[n - 2], y: nums[n - 1] })
    }
    i += n
  }
  return pts
}

/** Smooth path through anchors (Catmull-Rom converted to cubic beziers). */
export function anchorsToPath(pts: Pt[]): string {
  if (!pts.length) return ''
  if (pts.length === 1) return `M ${r(pts[0].x)} ${r(pts[0].y)}`
  const P = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))]
  let d = `M ${r(pts[0].x)} ${r(pts[0].y)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const c1x = P(i).x + (P(i + 1).x - P(i - 1).x) / 6
    const c1y = P(i).y + (P(i + 1).y - P(i - 1).y) / 6
    const c2x = P(i + 1).x - (P(i + 2).x - P(i).x) / 6
    const c2y = P(i + 1).y - (P(i + 2).y - P(i).y) / 6
    d += ` C ${r(c1x)} ${r(c1y)} ${r(c2x)} ${r(c2y)} ${r(P(i + 1).x)} ${r(P(i + 1).y)}`
  }
  return d
}

/** Reduce a raw pointer trail to editable anchors (freeform drawing). */
export function simplifyPoints(pts: Pt[], eps = 3): Pt[] {
  return rdp(pts, eps)
}

function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length <= 2) return pts.slice()
  const a = pts[0]
  const b = pts[pts.length - 1]
  let maxD = -1
  let idx = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b)
    if (d > maxD) {
      maxD = d
      idx = i
    }
  }
  if (maxD <= eps) return [a, b]
  const left = rdp(pts.slice(0, idx + 1), eps)
  const right = rdp(pts.slice(idx), eps)
  return left.slice(0, -1).concat(right)
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (!len) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs(dx * (a.y - p.y) - (a.x - p.x) * dy) / len
}

// ————————————————————— lines, boxes & connector anchors —————————————————————
// (pure geometry from slides/src/editor/lineedit.ts). The element arguments are
// STRUCTURAL ({x,y,w,h,rotation?}); a slides ShapeElement satisfies them.

export type Box = { x: number; y: number; w: number; h: number }
type LineBox = Box & { rotation?: number }

/** Closed shapes (polygons) end with Z; straight ones have no curve commands. */
export const pathIsClosed = (d?: string) => /z\s*$/i.test(d ?? '')
export const pathIsStraight = (d?: string) => !/[csqta]/i.test(d ?? '')

/** True for shapes the direct line/curve editor takes over (vs Moveable's box). */
export function isLineLike(el: { type: string; shape?: string }): boolean {
  return el.type === 'shape' && (el.shape === 'line' || el.shape === 'path')
}

/** The two endpoints of a line shape, in slide coords. */
export function lineEndpoints(el: LineBox): [Pt, Pt] {
  const cx = el.x + el.w / 2
  const cy = el.y + el.h / 2
  const rad = ((el.rotation || 0) * Math.PI) / 180
  const hw = el.w / 2
  const dx = Math.cos(rad) * hw
  const dy = Math.sin(rad) * hw
  return [{ x: cx - dx, y: cy - dy }, { x: cx + dx, y: cy + dy }]
}

/** Write a line shape from two endpoints (keeps its stroke-box thickness). */
export function setLineEndpoints(el: LineBox, a: Pt, b: Pt): void {
  const cx = (a.x + b.x) / 2
  const cy = (a.y + b.y) / 2
  const w = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1)
  const h = el.h || 4
  el.w = w
  el.x = cx - w / 2
  el.y = cy - h / 2
  el.rotation = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
}

export function boxCenter(b: Box): Pt {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

/** Where the ray from box b's centre toward `target` crosses b's border. */
export function borderPoint(b: Box, target: Pt): Pt {
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const dx = target.x - cx
  const dy = target.y - cy
  if (!dx && !dy) return { x: cx, y: cy }
  const sx = dx ? b.w / 2 / Math.abs(dx) : Infinity
  const sy = dy ? b.h / 2 / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  return { x: cx + dx * s, y: cy + dy * s }
}

/** Midpoint of one side of a box (connector anchor points). */
export function sideMidpoint(b: Box, side: 'top' | 'right' | 'bottom' | 'left'): Pt {
  if (side === 'top') return { x: b.x + b.w / 2, y: b.y }
  if (side === 'bottom') return { x: b.x + b.w / 2, y: b.y + b.h }
  if (side === 'left') return { x: b.x, y: b.y + b.h / 2 }
  return { x: b.x + b.w, y: b.y + b.h / 2 }
}
