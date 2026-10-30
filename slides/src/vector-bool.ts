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
import { parseBezier, serializeBezier, type BezNode } from '../../kernel/src/geom.ts'

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

const EPS = 1e-7 // px: two points this close are one point; t this close to 0/1 is the end

/**
 * Split both operands' edges at every point they meet, sharing that point so
 * the pieces chain exactly: a proper crossing, a vertex of one lying on an
 * edge of the other (a T), and the ends of a stretch where two edges run along
 * each other (abutting shapes). After this every piece of A either lies along a
 * piece of B end to end, or touches B only at its ends.
 */
function splitAll(ea: Edge[], eb: Edge[]) {
  // ponytail: O(n·m) pair test — fine for a few hundred chords a side; a sweep line if decks grow huge outlines
  const onSeg = (e: Edge, q: Pt) => {
    const rx = e.b.x - e.a.x, ry = e.b.y - e.a.y, L2 = rx * rx + ry * ry
    if (L2 < EPS * EPS) return -1
    const t = ((q.x - e.a.x) * rx + (q.y - e.a.y) * ry) / L2
    if (t <= EPS || t >= 1 - EPS) return -1
    const dx = e.a.x + t * rx - q.x, dy = e.a.y + t * ry - q.y
    return dx * dx + dy * dy < EPS * EPS * 100 ? t : -1
  }
  for (const e of ea) {
    const minx = Math.min(e.a.x, e.b.x) - EPS, maxx = Math.max(e.a.x, e.b.x) + EPS
    const miny = Math.min(e.a.y, e.b.y) - EPS, maxy = Math.max(e.a.y, e.b.y) + EPS
    for (const f of eb) {
      if (Math.max(f.a.x, f.b.x) < minx || Math.min(f.a.x, f.b.x) > maxx) continue
      if (Math.max(f.a.y, f.b.y) < miny || Math.min(f.a.y, f.b.y) > maxy) continue
      // an end of one on the other (a T, or the ends of a shared stretch): cut at that very vertex
      let touched = false
      for (const q of [f.a, f.b]) { const t = onSeg(e, q); if (t >= 0) { e.cuts.push({ t, p: q }); touched = true } }
      for (const q of [e.a, e.b]) { const u = onSeg(f, q); if (u >= 0) { f.cuts.push({ t: u, p: q }); touched = true } }
      if (touched) continue
      const rx = e.b.x - e.a.x, ry = e.b.y - e.a.y
      const sx = f.b.x - f.a.x, sy = f.b.y - f.a.y
      const den = rx * sy - ry * sx
      if (Math.abs(den) < 1e-12) continue // parallel and not touching
      const qx = f.a.x - e.a.x, qy = f.a.y - e.a.y
      const t = (qx * sy - qy * sx) / den
      const u = (qx * ry - qy * rx) / den
      if (t <= EPS || t >= 1 - EPS || u <= EPS || u >= 1 - EPS) continue // meeting at an end: a vertex already
      const p = { x: e.a.x + t * rx, y: e.a.y + t * ry }
      e.cuts.push({ t, p })
      f.cuts.push({ t: u, p })
    }
  }
}

function pieces(e: Edge): Array<[Pt, Pt]> {
  const pts = [e.a]
  for (const c of e.cuts.sort((x, y) => x.t - y.t)) {
    const last = pts[pts.length - 1]
    if (Math.hypot(c.p.x - last.x, c.p.y - last.y) > EPS) pts.push(c.p)
  }
  if (Math.hypot(e.b.x - pts[pts.length - 1].x, e.b.y - pts[pts.length - 1].y) > EPS) pts.push(e.b)
  else pts[pts.length - 1] = e.b
  const out: Array<[Pt, Pt]> = []
  for (let i = 0; i < pts.length - 1; i++) out.push([pts[i], pts[i + 1]])
  return out
}

const key = (p: Pt) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)}`

/** Chain directed segments into closed contours (end of one = start of the next). */
function chain(segs: Array<[Pt, Pt]>): Poly {
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
  return out.map(straighten).filter((c) => c.length > 2)
}

/** Drop points that sit on the straight line between their neighbours — what a shared edge leaves behind. */
function straighten(c: Pt[]): Pt[] {
  let pts = c
  for (let changed = true; changed && pts.length > 3;) {
    changed = false
    const out: Pt[] = []
    for (let i = 0; i < pts.length; i++) {
      const a = out.length ? out[out.length - 1] : pts[(i - 1 + pts.length) % pts.length], b = pts[i], d = pts[(i + 1) % pts.length]
      const cross = (b.x - a.x) * (d.y - b.y) - (b.y - a.y) * (d.x - b.x)
      const len = Math.hypot(d.x - a.x, d.y - a.y) || 1
      if (Math.abs(cross) / len < EPS * 10 && (b.x - a.x) * (d.x - b.x) + (b.y - a.y) * (d.y - b.y) >= 0) { changed = true; continue }
      out.push(b)
    }
    pts = out
  }
  return pts
}

/**
 * Each piece of A is inside B, outside it, or lies ALONG a piece of B — a
 * shared stretch, where abutting shapes meet. Both operands are wound the same
 * way (orient), so a shared piece running the same direction has both
 * interiors on one side, and one running opposite has them on either side.
 * The classic rule: union and intersect keep a same-direction shared piece
 * once, subtract keeps an opposite one; everything else is decided by the
 * midpoint, which for a non-shared piece never lies on the other's boundary.
 */
function two(A: Poly, B: Poly, op: Exclude<BoolOp, 'exclude'>): Poly {
  const ea = edgesOf(A), eb = edgesOf(B)
  splitAll(ea, eb)
  const mid = (s: [Pt, Pt]): Pt => ({ x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2 })
  const bp = eb.flatMap(pieces), ap = ea.flatMap(pieces)
  const pk = (s: [Pt, Pt]) => key(s[0]) + '|' + key(s[1])
  const bSet = new Set(bp.map(pk)), aSet = new Set(ap.map(pk))
  const keep: Array<[Pt, Pt]> = []
  for (const s of ap) {
    const same = bSet.has(pk(s)), opposite = bSet.has(pk([s[1], s[0]]))
    if (same || opposite) { if (op === 'subtract' ? opposite : same) keep.push(s); continue }
    const inB = inside(mid(s), B)
    if (op === 'intersect' ? inB : !inB) keep.push(s)
  }
  for (const s of bp) {
    if (aSet.has(pk(s)) || aSet.has(pk([s[1], s[0]]))) continue // shared: decided on A's side
    const inA = inside(mid(s), A)
    if (op === 'union' && !inA) keep.push(s)
    if (op === 'intersect' && inA) keep.push(s)
    if (op === 'subtract' && inA) keep.push([s[1], s[0]]) // B's edge, walked the other way, bounds the hole
  }
  return orient(chain(keep))
}

/** Winding number of `poly` around `q` (crossings counted with their direction). */
function winding(q: Pt, poly: Poly): number {
  let w = 0
  for (const c of poly) for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length]
    const side = (b.x - a.x) * (q.y - a.y) - (q.x - a.x) * (b.y - a.y)
    if (a.y <= q.y && b.y > q.y && side > 0) w++
    else if (a.y > q.y && b.y <= q.y && side < 0) w--
  }
  return w
}

/**
 * The region a path FILLS, as simple contours. A path is drawn with the
 * nonzero rule (render.ts, the kernel), so a contour that crosses itself (a
 * pentagram) or subpaths that overlap fill more than evenodd containment would
 * say. Split the outline against itself and keep each piece with filled area
 * on exactly one side of it: that is the boundary of what is drawn, and from
 * there evenodd and nonzero agree.
 */
function filledRegion(poly: Poly): Poly {
  const es = edgesOf(poly)
  splitAll(es, es)
  const keep: Array<[Pt, Pt]> = []
  for (const s of es.flatMap(pieces)) {
    const dx = s[1].x - s[0].x, dy = s[1].y - s[0].y, len = Math.hypot(dx, dy)
    if (len < EPS) continue
    const m = { x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2 }
    const nx = (-dy / len) * 1e-4, ny = (dx / len) * 1e-4
    const l = winding({ x: m.x + nx, y: m.y + ny }, poly) !== 0, r = winding({ x: m.x - nx, y: m.y - ny }, poly) !== 0
    if (l === r) continue // filled on both sides (inside) or neither (a cancelled overlap)
    keep.push(r ? s : [s[1], s[0]]) // walk with the filled side on the right, as orient expects of an outer edge
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
  // a rect or an ellipse is one simple contour already; a path may cross itself
  return polyToPath(boolPolys(shapes.map((s) => (s.shape === 'path' ? filledRegion(shapeToPoly(s)) : shapeToPoly(s))), op))
}

// ————————————————————————— operands back where the result stands —————————————————————————

const KAPPA = 0.5522847498

/** A shape's outline as cubic nodes in its own box (0..w, 0..h), or null when
 *  the path is more than one M/L/C contour (then it travels as chords). */
function localNodes(s: ShapeElement): { nodes: BezNode[]; closed: boolean } | null {
  const { w, h } = s
  const P = (x: number, y: number) => ({ x, y })
  if (s.shape === 'ellipse') {
    const rx = w / 2, ry = h / 2, kx = rx * KAPPA, ky = ry * KAPPA
    return { closed: true, nodes: [
      { p: P(rx, 0), in: P(rx - kx, 0), out: P(rx + kx, 0) },
      { p: P(w, ry), in: P(w, ry - ky), out: P(w, ry + ky) },
      { p: P(rx, h), in: P(rx + kx, h), out: P(rx - kx, h) },
      { p: P(0, ry), in: P(0, ry + ky), out: P(0, ry - ky) },
    ] }
  }
  if (s.shape === 'rect') {
    const r = Math.min(s.radius || 0, w / 2, h / 2), k = r * (1 - KAPPA)
    if (!r) return { closed: true, nodes: [{ p: P(0, 0) }, { p: P(w, 0) }, { p: P(w, h) }, { p: P(0, h) }] }
    return { closed: true, nodes: [
      { p: P(r, 0), in: P(k, 0) }, { p: P(w - r, 0), out: P(w - k, 0) },
      { p: P(w, r), in: P(w, k) }, { p: P(w, h - r), out: P(w, h - k) },
      { p: P(w - r, h), in: P(w - k, h) }, { p: P(r, h), out: P(k, h) },
      { p: P(0, h - r), in: P(0, h - k) }, { p: P(0, r), out: P(0, k) },
    ] }
  }
  if (s.shape === 'triangle') return { closed: true, nodes: [{ p: P(w / 2, 0) }, { p: P(w, h) }, { p: P(0, h) }] }
  if (s.shape === 'path' && s.d && !/[^MLCZmlcz\d\s.,eE+-]/.test(s.d) && (s.d.match(/[Mm]/g) ?? []).length === 1 && !/[a-z]/.test(s.d.replace(/e/g, ''))) {
    const [bx, by, bw, bh] = s.pathBox ?? [0, 0, w || 1, h || 1]
    const sx = w / (bw || 1), sy = h / (bh || 1)
    const m = (q?: { x: number; y: number }) => (q ? { x: (q.x - bx) * sx, y: (q.y - by) * sy } : undefined)
    const { nodes, closed } = parseBezier(s.d)
    return { closed, nodes: nodes.map((n) => ({ ...n, p: m(n.p)!, in: m(n.in), out: m(n.out) })) }
  }
  return null
}

/**
 * Where the operands stand now. They were stored as they stood when combined;
 * since then the result may have been moved, resized or turned, so the frame
 * the result had then is mapped onto the one it has now: scale (sx, sy) into
 * the new box, then the result's rotation about its centre. An operand that
 * was itself turned by other than a multiple of 90° comes out of a
 * non-uniform scale SKEWED — no box and rotation can say that, so it comes
 * back as a path carrying the exact skewed outline.
 */
export function operandsAt(el: ShapeElement): ShapeElement[] {
  const bool = el.bool!
  const was = computeBool(bool.shapes, bool.op) ?? { x: el.x, y: el.y, w: el.w, h: el.h }
  const sx = el.w / (was.w || 1), sy = el.h / (was.h || 1)
  const a = ((el.rotation || 0) * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a)
  const ecx = el.x + el.w / 2, ecy = el.y + el.h / 2
  // a slide point of the frame then → where it stands now
  const M = (q: Pt): Pt => {
    const x = el.x + (q.x - was.x) * sx - ecx, y = el.y + (q.y - was.y) * sy - ecy
    return { x: ecx + x * ca - y * sa, y: ecy + x * sa + y * ca }
  }
  const uniform = Math.abs(sx - sy) <= 1e-9 * Math.max(sx, sy, 1)
  return bool.shapes.map((s0) => {
    const s: ShapeElement = JSON.parse(JSON.stringify(s0))
    const r0 = ((s.rotation || 0) % 360 + 360) % 360
    const quarter = Math.abs(r0 / 90 - Math.round(r0 / 90)) < 1e-9
    const c = M({ x: s.x + s.w / 2, y: s.y + s.h / 2 })
    if (uniform || quarter) {
      // the box survives: a quarter turn swaps which scale lands on which side
      const swap = !uniform && Math.round(r0 / 90) % 2 === 1
      s.w *= swap ? sy : sx
      s.h *= swap ? sx : sy
      s.x = c.x - s.w / 2
      s.y = c.y - s.h / 2
      if (el.rotation) s.rotation = (s.rotation || 0) + el.rotation
      return s
    }
    // skewed: carry the outline itself through the map
    const r = (r0 * Math.PI) / 180, cr = Math.cos(r), sr = Math.sin(r)
    const toSlide = (q: Pt): Pt => {
      const x = q.x - s.w / 2, y = q.y - s.h / 2
      return M({ x: s.x + s.w / 2 + x * cr - y * sr, y: s.y + s.h / 2 + x * sr + y * cr })
    }
    const local = localNodes(s)
    let contours: Array<{ nodes: BezNode[]; closed: boolean }>
    if (local) {
      const T = (q?: Pt) => (q ? toSlide(q) : undefined)
      contours = [{ closed: local.closed, nodes: local.nodes.map((n) => ({ ...n, p: T(n.p)!, in: T(n.in), out: T(n.out) })) }]
    } else {
      // ponytail: a multi-contour or arc path travels as its chords (TOL px) — exact curves only for M/L/C
      const unturned = shapeToPoly({ ...s, rotation: 0 })
      const back = (q: Pt) => toSlide({ x: q.x - s.x, y: q.y - s.y })
      contours = unturned.map((cn) => ({ closed: true, nodes: cn.map((q) => ({ p: back(q) })) }))
    }
    const pts = contours.flatMap((cn) => cn.nodes.flatMap((n) => [n.p, n.in, n.out].filter(Boolean) as Pt[]))
    const x0 = Math.min(...pts.map((q) => q.x)), y0 = Math.min(...pts.map((q) => q.y))
    const w = Math.max(Math.max(...pts.map((q) => q.x)) - x0, 1), h = Math.max(Math.max(...pts.map((q) => q.y)) - y0, 1)
    const L = (q?: Pt) => (q ? { x: q.x - x0, y: q.y - y0 } : undefined)
    const d = contours.map((cn) => serializeBezier(cn.nodes.map((n) => ({ ...n, p: L(n.p)!, in: L(n.in), out: L(n.out) })), cn.closed)).join(' ')
    const out = { ...s, shape: 'path' as const, d, pathBox: [0, 0, w, h] as [number, number, number, number], x: x0, y: y0, w, h, rotation: 0, radius: 0 }
    return out
  })
}
