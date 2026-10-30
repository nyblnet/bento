// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// Vector booleans — union, subtract, intersect, exclude — computed into an
// ordinary path. DOM-free, no dependencies.
//
// WHY A COMPUTED PATH. A boolean is stored as a plain `shape:'path'` whose `d`
// IS the result, so every shell that predates booleans, every thumbnail, the
// PDF and the morph draw it with no new code. The operands ride along in
// `bool.shapes` (see model.ts) only so the editor can change the operation or
// give the shapes back.
//
// HOW. Shapes are flattened to polygons (curves to short chords), then every
// edge is split where it crosses an edge of the other operand. Each piece lies
// wholly inside or wholly outside the other operand, which its midpoint
// decides; the operation keeps a set of pieces and they are chained back into
// closed contours. Finally each contour is wound by its nesting depth (outer
// clockwise, hole anticlockwise, and so on), so the default nonzero fill an
// old shell uses draws the same holes evenodd would.
import type { ShapeElement } from './model'

export type BoolOp = 'union' | 'subtract' | 'intersect' | 'exclude'
export type Pt = { x: number; y: number }
type Poly = Pt[][]

/** Shapes a boolean accepts: closed outlines. A line or an open path has no inside. */
export function canBool(el: { type: string; shape?: string; d?: string }): boolean {
  if (el.type !== 'shape') return false
  if (el.shape === 'rect' || el.shape === 'ellipse' || el.shape === 'triangle') return true
  return el.shape === 'path' && /z\s*$/i.test(el.d ?? '')
}

const TOL = 0.25 // px: the most a chord may stray from the curve it replaces

// ————————————————————————— shapes → polygons —————————————————————————

const full0 = (a0: number, a1: number) => Math.abs(a1 - a0) >= Math.PI * 2 - 1e-9

function ellipsePts(cx: number, cy: number, rx: number, ry: number, a0 = 0, a1 = Math.PI * 2): Pt[] {
  const r = Math.max(rx, ry, 1e-9)
  const step = 2 * Math.acos(Math.max(-1, 1 - TOL / r)) || 0.1
  const n = Math.min(512, Math.max(full0(a0, a1) ? 8 : 2, Math.ceil(Math.abs(a1 - a0) / step)))
  // a whole ellipse: push the vertices out just enough that the polygon's area
  // equals the ellipse's — an inscribed polygon would lose ~1% on a small one
  const full = full0(a0, a1)
  const k = full ? Math.sqrt((2 * Math.PI) / (n * Math.sin((2 * Math.PI) / n))) : 1
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    out.push({ x: cx + k * rx * Math.cos(a), y: cy + k * ry * Math.sin(a) })
  }
  return out
}

function rectPts(w: number, h: number, radius: number): Pt[] {
  const r = Math.min(radius || 0, w / 2, h / 2)
  if (r <= 0) return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]
  const q = Math.PI / 2
  // clockwise on screen (y down), starting at the top-right corner's arc
  return [
    ...ellipsePts(w - r, r, r, r, -q, 0), { x: w, y: r },
    ...ellipsePts(w - r, h - r, r, r, 0, q), { x: w - r, y: h },
    ...ellipsePts(r, h - r, r, r, q, 2 * q), { x: 0, y: h - r },
    ...ellipsePts(r, r, r, r, 2 * q, 3 * q), { x: r, y: 0 },
  ]
}

const cubic = (p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt => {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
  }
}
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
// ponytail: chord count from the control polygon's length (≤ 4px chords) — a
// tight-curvature hairpin can stray past TOL; adaptive subdivision if it shows.
const chords = (len: number) => Math.min(64, Math.max(2, Math.ceil(len / 4)))

/** Flatten SVG path data to closed contours, every command (arcs included) to short chords. */
export function flattenPath(d: string): Poly {
  const tk = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []
  const out: Poly = []
  let cur: Pt[] = []
  let p: Pt = { x: 0, y: 0 }
  let start = p
  let lastC: Pt | null = null // the previous cubic's/quad's second control, for S/T
  let lastQ: Pt | null = null
  let cmd = ''
  let i = 0
  const n = () => Number(tk[i++])
  // an arc flag is one digit and may be packed against the next ("a5 5 0 01 10 10")
  const flag = (): number => {
    const t = tk[i]
    if (t.length > 1 && /^[01]/.test(t)) { tk[i] = t.slice(1); return Number(t[0]) }
    i++
    return Number(t)
  }
  const close = () => { if (cur.length > 2) out.push(cur); cur = [] }
  while (i < tk.length) {
    if (/^[A-Za-z]$/.test(tk[i])) {
      cmd = tk[i++]
      if (/z/i.test(cmd)) { close(); p = start; lastC = lastQ = null }
      continue
    }
    const rel = cmd === cmd.toLowerCase()
    const at = (x: number, y: number): Pt => (rel ? { x: p.x + x, y: p.y + y } : { x, y })
    const C = cmd.toUpperCase()
    if (C === 'M') {
      close()
      p = start = at(n(), n())
      cur = [p]
      cmd = rel ? 'l' : 'L' // further pairs are line-tos
      lastC = lastQ = null
      continue
    }
    let q: Pt
    if (C === 'L') q = at(n(), n())
    else if (C === 'H') { const x = n(); q = { x: rel ? p.x + x : x, y: p.y } }
    else if (C === 'V') { const y = n(); q = { x: p.x, y: rel ? p.y + y : y } }
    else if (C === 'C' || C === 'S') {
      const c1 = C === 'C' ? at(n(), n()) : lastC ? { x: 2 * p.x - lastC.x, y: 2 * p.y - lastC.y } : p
      const c2 = at(n(), n())
      q = at(n(), n())
      const k = chords(dist(p, c1) + dist(c1, c2) + dist(c2, q))
      for (let j = 1; j < k; j++) cur.push(cubic(p, c1, c2, q, j / k))
      cur.push(q); p = q; lastC = c2; lastQ = null
      continue
    } else if (C === 'Q' || C === 'T') {
      const c: Pt = C === 'Q' ? at(n(), n()) : lastQ ? { x: 2 * p.x - lastQ.x, y: 2 * p.y - lastQ.y } : p
      q = at(n(), n())
      // a quadratic is the cubic with controls ⅔ of the way to its one control
      const c1 = { x: p.x + (2 / 3) * (c.x - p.x), y: p.y + (2 / 3) * (c.y - p.y) }
      const c2 = { x: q.x + (2 / 3) * (c.x - q.x), y: q.y + (2 / 3) * (c.y - q.y) }
      const k = chords(dist(p, c) + dist(c, q))
      for (let j = 1; j < k; j++) cur.push(cubic(p, c1, c2, q, j / k))
      cur.push(q); p = q; lastQ = c; lastC = null
      continue
    } else if (C === 'A') {
      const rx = n(), ry = n(), rot = n(), large = flag(), sweep = flag()
      q = at(n(), n())
      cur.push(...arcPts(p, q, rx, ry, rot, !!large, !!sweep))
      p = q; lastC = lastQ = null
      continue
    } else { i++; continue }
    cur.push(q); p = q; lastC = lastQ = null
  }
  close()
  return out
}

/**
 * An elliptical arc from p to q as chord points (q included), by the SVG
 * spec's endpoint-to-centre conversion (SVG 1.1 F.6.5–F.6.6): radii too small
 * for the endpoints are scaled up, a zero radius is a straight line.
 */
function arcPts(p: Pt, q: Pt, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean): Pt[] {
  rx = Math.abs(rx); ry = Math.abs(ry)
  if (!rx || !ry || (p.x === q.x && p.y === q.y)) return [q]
  const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi)
  const dx = (p.x - q.x) / 2, dy = (p.y - q.y) / 2
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam) }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)))
  const cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx
  const cx = cos * cx1 - sin * cy1 + (p.x + q.x) / 2, cy = sin * cx1 + cos * cy1 + (p.y + q.y) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const t0 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  else if (sweep && dt < 0) dt += 2 * Math.PI
  const steps = chords(Math.abs(dt) * Math.max(rx, ry))
  const out: Pt[] = []
  for (let j = 1; j < steps; j++) {
    const t = t0 + (dt * j) / steps
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t)
    out.push({ x: cos * ex - sin * ey + cx, y: sin * ex + cos * ey + cy })
  }
  out.push(q)
  return out
}

/** A shape's outline in SLIDE coordinates: its box, its own path space mapped
 *  into that box, and its rotation about the box centre, as render.ts draws it. */
export function shapeToPoly(el: ShapeElement): Poly {
  const { x, y, w, h } = el
  let local: Poly
  if (el.shape === 'rect') local = [rectPts(w, h, el.radius)]
  else if (el.shape === 'ellipse') local = [ellipsePts(w / 2, h / 2, w / 2, h / 2)]
  else if (el.shape === 'triangle') local = [[{ x: w / 2, y: 0 }, { x: w, y: h }, { x: 0, y: h }]]
  else if (el.shape === 'path') {
    const [bx, by, bw, bh] = el.pathBox ?? [0, 0, w || 1, h || 1]
    const sx = w / (bw || 1), sy = h / (bh || 1)
    local = flattenPath(el.d ?? '').map((c) => c.map((q) => ({ x: (q.x - bx) * sx, y: (q.y - by) * sy })))
  } else local = []
  const a = ((el.rotation || 0) * Math.PI) / 180
  const cos = Math.cos(a), sin = Math.sin(a)
  const cx = w / 2, cy = h / 2
  return orient(local.map((c) => c.map((q) => ({
    x: x + cx + (q.x - cx) * cos - (q.y - cy) * sin,
    y: y + cy + (q.x - cx) * sin + (q.y - cy) * cos,
  }))))
}

// ————————————————————————— polygon geometry —————————————————————————

/** Twice the signed area: positive = clockwise on screen (y grows down). */
const signedArea = (c: Pt[]) => {
  let s = 0
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) s += (c[j].x - c[i].x) * (c[j].y + c[i].y)
  return -s
}

/** Evenodd containment — holes come free. */
export function inside(q: Pt, poly: Poly): boolean {
  let inn = false
  for (const c of poly) {
    for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
      const a = c[i], b = c[j]
      if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inn = !inn
    }
  }
  return inn
}

/** Wind every contour by how deeply it is nested: depth 0 clockwise, 1
 *  anticlockwise, … so nonzero and evenodd fill agree. Depth is read at the
 *  midpoint of the contour's first edge, which no other contour passes through. */
function orient(poly: Poly): Poly {
  return poly.filter((c) => c.length > 2 && Math.abs(signedArea(c)) > 1e-9).map((c, k, all) => {
    const m = { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 }
    const depth = all.filter((o, j) => j !== k && inside(m, [o])).length
    const cw = signedArea(c) > 0
    return cw === (depth % 2 === 0) ? c : [...c].reverse()
  })
}

type Edge = { a: Pt; b: Pt; cuts: Array<{ t: number; p: Pt }> }

const edgesOf = (poly: Poly): Edge[] =>
  poly.flatMap((c) => c.map((a, i) => ({ a, b: c[(i + 1) % c.length], cuts: [] as Edge['cuts'] })))

/** Split both operands' edges where they cross, sharing each crossing point. */
function splitAll(ea: Edge[], eb: Edge[]) {
  // ponytail: O(n·m) pair test — fine for a few hundred chords a side; a sweep line if decks grow huge outlines
  for (const e of ea) {
    const minx = Math.min(e.a.x, e.b.x), maxx = Math.max(e.a.x, e.b.x)
    const miny = Math.min(e.a.y, e.b.y), maxy = Math.max(e.a.y, e.b.y)
    for (const f of eb) {
      if (Math.max(f.a.x, f.b.x) < minx || Math.min(f.a.x, f.b.x) > maxx) continue
      if (Math.max(f.a.y, f.b.y) < miny || Math.min(f.a.y, f.b.y) > maxy) continue
      const rx = e.b.x - e.a.x, ry = e.b.y - e.a.y
      const sx = f.b.x - f.a.x, sy = f.b.y - f.a.y
      const den = rx * sy - ry * sx
      if (Math.abs(den) < 1e-12) continue // parallel — the perturbation keeps them from overlapping
      const qx = f.a.x - e.a.x, qy = f.a.y - e.a.y
      const t = (qx * sy - qy * sx) / den
      const u = (qx * ry - qy * rx) / den
      if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue
      const p = { x: e.a.x + t * rx, y: e.a.y + t * ry }
      e.cuts.push({ t, p })
      f.cuts.push({ t: u, p })
    }
  }
}

function pieces(e: Edge): Array<[Pt, Pt]> {
  const pts = [e.a, ...e.cuts.sort((x, y) => x.t - y.t).map((c) => c.p), e.b]
  const out: Array<[Pt, Pt]> = []
  for (let i = 0; i < pts.length - 1; i++) out.push([pts[i], pts[i + 1]])
  return out
}

/** Chain directed segments into closed contours (end of one = start of the next). */
function chain(segs: Array<[Pt, Pt]>): Poly {
  const key = (p: Pt) => `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)}`
  const from = new Map<string, Array<[Pt, Pt]>>()
  for (const s of segs) {
    const k = key(s[0])
    if (!from.has(k)) from.set(k, [])
    from.get(k)!.push(s)
  }
  const out: Poly = []
  const used = new Set<[Pt, Pt]>()
  for (const s0 of segs) {
    if (used.has(s0)) continue
    const c: Pt[] = []
    let s: [Pt, Pt] | undefined = s0
    while (s && !used.has(s)) {
      used.add(s)
      c.push(s[0])
      s = from.get(key(s[1]))?.find((x) => !used.has(x))
    }
    if (c.length > 2) out.push(c)
  }
  return out
}

/**
 * Nudge B by a sub-pixel amount so no vertex of one lies exactly on an edge of
 * the other and no edges overlap — the degenerate cases the split-and-classify
 * method cannot decide. ponytail: shapes that share an edge (two abutting
 * rects) come out a 1e-4px sliver apart or overlapping; invisible on a slide.
 */
const nudge = (poly: Poly): Poly => poly.map((c) => c.map((p) => ({ x: p.x + 1.3e-4, y: p.y + 0.7e-4 })))

function two(A: Poly, B0: Poly, op: Exclude<BoolOp, 'exclude'>): Poly {
  const B = nudge(B0)
  const ea = edgesOf(A), eb = edgesOf(B)
  splitAll(ea, eb)
  const mid = (s: [Pt, Pt]): Pt => ({ x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2 })
  const keep: Array<[Pt, Pt]> = []
  for (const e of ea) for (const s of pieces(e)) {
    const inB = inside(mid(s), B)
    if (op === 'intersect' ? inB : !inB) keep.push(s)
  }
  for (const e of eb) for (const s of pieces(e)) {
    const inA = inside(mid(s), A)
    if (op === 'union' && !inA) keep.push(s)
    if (op === 'intersect' && inA) keep.push(s)
    if (op === 'subtract' && inA) keep.push([s[1], s[0]]) // B's edge, walked the other way, bounds the hole
  }
  return orient(chain(keep))
}

/**
 * Combine outlines bottom to top, as Figma does: union and intersect fold over
 * all of them, subtract takes every upper shape away from the bottom one, and
 * exclude keeps what an odd number of them cover.
 */
export function boolPolys(polys: Poly[], op: BoolOp): Poly {
  if (!polys.length) return []
  let acc = polys[0]
  for (const p of polys.slice(1)) {
    if (op === 'exclude') acc = orient([...two(acc, p, 'subtract'), ...two(p, acc, 'subtract')])
    else acc = two(acc, p, op)
  }
  return acc
}

const r2 = (v: number) => Math.round(v * 100) / 100

/** The result as a path in its own box: `d` in [0,0,w,h] and where the box sits. */
export function polyToPath(poly: Poly): { x: number; y: number; w: number; h: number; d: string } | null {
  const all = poly.flat()
  if (!all.length) return null
  const x = Math.min(...all.map((p) => p.x)), y = Math.min(...all.map((p) => p.y))
  const w = Math.max(...all.map((p) => p.x)) - x, h = Math.max(...all.map((p) => p.y)) - y
  const d = poly.map((c) => `M ${c.map((p) => `${r2(p.x - x)} ${r2(p.y - y)}`).join(' L ')} Z`).join(' ')
  return { x, y, w: Math.max(w, 1), h: Math.max(h, 1), d }
}

/** Area by evenodd — what the shape actually covers (test aid). */
export function polyArea(poly: Poly): number {
  // nested contours are wound opposite (orient), so the signed sum IS the covered area
  return poly.reduce((s, c) => s + signedArea(c) / 2, 0)
}

/** Operands → the computed outline, in slide coordinates. */
export function computeBool(shapes: ShapeElement[], op: BoolOp) {
  return polyToPath(boolPolys(shapes.map(shapeToPoly), op))
}
