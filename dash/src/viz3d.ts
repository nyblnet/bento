// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// 3D data visualisation — scatter, surface, bars, globe — on the WebGL2 layer.
//
// WHAT WAS ASKED FOR IS THE LOOK, NOT THE LIBRARY. three.js is 600 KB+ against
// a 43 KB shell, and this project already deleted ECharts at 630 KB and refused
// DuckDB-WASM at 9.4 MB. But the expensive part of three.js is GENERALITY — a
// scene graph, a material system, loaders for a dozen formats, a raycaster, a
// shadow pipeline — and none of it is visible to a reader looking at a scatter
// plot. FOUR fixed chart types need one camera (gl.ts has it), four geometry
// builders, and two shaders. That is what is here.
//
// buildScene IS PURE, and that is the whole testing strategy. Every bug in 3D
// geometry renders SOMETHING, plausibly, and no one looking at the screen can
// tell that a surface is inside out or that a normal is 1.4 long. Geometry is
// arithmetic, arithmetic runs in node, so all of it lives above the GL line and
// the rig checks the numbers. Below `mountViz3d` nothing is testable, so that
// half is kept as boring as it can be.
//
// EVERYTHING IS NORMALISED INTO A UNIT CUBE, PER AXIS INDEPENDENTLY. Two
// reasons, both load-bearing. (1) Attributes are f32: a timestamp in ms or
// revenue in pence has more significant digits than 24 bits of mantissa, and
// the plot visibly quantises into rows. (2) Revenue in millions against margin
// in [0,1] shares one cube only if each axis carries its OWN scale — otherwise
// the margin axis collapses to a line, which is not a plot of the data, it is a
// plot of the units. The real numbers live on in `Scene.axes` and the legend.
//
// LIGHTING EXISTS ONCE. `shade()` below is the model, and the GLSL in this file
// is a literal transliteration of it. The 2D fallback shades on the CPU with
// the same function, so a machine without WebGL2 gets the same picture rather
// than a different one — two lighting models is a bug that only ever shows up
// on someone else's laptop. Flat unlit geometry is what makes hand-rolled 3D
// look amateur; a directional key light plus a hemisphere fill is most of what
// separates it from three.js, and it costs four lines in a vertex shader.
//
// THERE IS NO TRANSPARENCY, DELIBERATELY. Correct alpha needs the geometry
// sorted back-to-front from the CURRENT camera, which is a sort per orbit frame
// (100k points, every mouse move) and is STILL wrong for interpenetrating
// triangles and for anything with a cyclic overlap — the surface passing
// through its own bar chart is exactly that case. The depth buffer is exact,
// order-independent and free. So every mesh is opaque, and scatter points are
// discs cut out with `discard` rather than blended: a marginally harder edge in
// exchange for depth that is right at any point count.
//
// NULLS ARE DROPPED, NEVER ZEROED, and the count is reported. chart.ts's rule
// (`nulls are gaps, not zeroes`) matters more in 3D, because a missing value
// coerced to 0 is not an obvious gap in a surface — it is a crater, and craters
// look like findings.
//
// THE FALLBACK IS A PICTURE. `supportsWebGL2()` is false on old iPads, in
// locked-down enterprise browsers, over remote desktop, and in the shell's own
// scriptless preview. A workbook that opens to an empty rectangle there is
// worse than one that never offered 3D at all, so the same Scene is projected
// with the same camera and the same lighting into an SVG.

import {
  GLView, Orbit, supportsWebGL2, project,
  normalize as vnorm, dot as vdot,
  type Mat4, type Vec3,
} from './gl.ts'
import type { TableSheet } from './model.ts'
import { readCell } from './store.ts'
import { isErr } from './formula.ts'

// --- colour -----------------------------------------------------------------

/** Channels in 0..1, because that is what a shader wants and what mixing needs. */
export type RGB = [number, number, number]

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** An unparseable colour is GREY, not black — black reads as "lit from behind". */
export function hexToRgb(hex: string): RGB {
  const s = String(hex).trim().replace(/^#/, '')
  const full = s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s.slice(0, 6)
  const n = parseInt(full, 16)
  if (full.length < 6 || !Number.isFinite(n)) return [0.5, 0.5, 0.5]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export const rgbToHex = (c: RGB): string =>
  '#' + [c[0], c[1], c[2]]
    .map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0'))
    .join('')

/**
 * Mix in LINEAR light, not in sRGB.
 *
 * sRGB is a transfer curve, so the naive midpoint of black and white is 0.5,
 * which displays as about 21% of the light — every hand-rolled ramp has that
 * mud in the middle, and on a surface it reads as a band of shadow that is not
 * in the data. condfmt.mixColors reached the same conclusion for cell
 * backgrounds; this one works in floats because a vertex colour is a float.
 */
export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  const u = clamp01(t)
  const m = (x: number, y: number) => Math.sqrt(x * x * (1 - u) + y * y * u)
  return [m(a[0], b[0]), m(a[1], b[1]), m(a[2], b[2])]
}

/**
 * Sequential ramps, all monotonic in lightness. That is not decoration: a ramp
 * that is not monotonic in lightness (the rainbow) invents ridges where the
 * data is smooth, and is unreadable to the ~8% of readers with a red/green
 * deficiency. `balance` is the exception and is diverging on purpose — for a
 * signed measure, where the MIDDLE is the meaningful value.
 */
export const RAMPS: Record<string, string[]> = {
  viridis: ['#3B1E54', '#3C558C', '#2E8B8B', '#63B36A', '#CFD84A'],
  thermal: ['#12123A', '#5B2A86', '#C24B6E', '#F08A3C', '#F7E15F'],
  ice: ['#0B1B33', '#1B4A73', '#3E86A8', '#84C1CD', '#DCEFF2'],
  balance: ['#2166AC', '#7FB3D3', '#F2F2F0', '#EF9A7B', '#B2182B'],
}

/**
 * dash's chart palette, repeated rather than imported: chart.ts keeps it as a
 * default PARAMETER, so there is nothing to import — and a 3D view that
 * disagreed with the 2D chart beside it about what colour "North" is would be
 * its own bug report.
 */
export const CATEGORY_COLORS = ['#F7A600', '#5B8DEF', '#2FB47C', '#E1616C', '#8B6FD3', '#3FA9B8']

/**
 * Sample a ramp at `t` in [0, 1]. The ends are EXACT: `rampColor(0)` is the
 * first stop and `rampColor(1)` is the last, with no interpolation error, so
 * the legend's swatches and the extreme vertices are the same colours.
 */
export function rampColor(t: number, stops: RGB[]): RGB {
  if (!stops.length) return [0.5, 0.5, 0.5]
  if (stops.length === 1) return stops[0]
  const u = clamp01(Number.isFinite(t) ? t : 0)
  const x = u * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x))
  return mixRgb(stops[i], stops[i + 1], x - i)
}

// --- lighting ---------------------------------------------------------------

/**
 * The key light, in WORLD space: over the viewer's left shoulder and above.
 * Fixed to the world, not to the camera, so orbiting a surface changes which
 * slopes catch the light — a headlight rigidly attached to the eye flattens
 * everything and is the single clearest tell of hand-rolled 3D.
 */
export const LIGHT: Vec3 = vnorm([-0.45, 0.82, 0.55])

/** How much light reaches a surface facing away. Never 0: an unlit face that
 *  goes pure black reads as a hole in the mesh. */
export const AMBIENT = 0.38

/**
 * The lighting model, and the ONLY copy of it. The GLSL below is a line-for-line
 * transliteration, and the SVG fallback calls this directly.
 *
 * Lambert for the key, plus a hemisphere fill (`sky`) so the underside of a
 * surface is dim rather than uniform — with flat ambient, everything facing away
 * from the light is exactly one colour and the shape disappears into a silhouette.
 *
 * `light` is a parameter because the point-sprite path shades in VIEW space,
 * where the light is the world light run through the view rotation. Same model,
 * same numbers, different basis.
 */
export function shadeWith(n: Vec3, light: Vec3, ambient = AMBIENT): number {
  const d = Math.max(0, vdot(n, light))
  const sky = 0.55 + 0.45 * n[1]
  return Math.min(1, ambient * sky + (1 - ambient) * d)
}

/** `shadeWith` against the world key light — what a mesh normal wants. */
export const shade = (n: Vec3, ambient = AMBIENT): number => shadeWith(n, LIGHT, ambient)

/**
 * A DIRECTION through the view matrix — upper 3x3 only.
 *
 * `transformPoint` is wrong here: it adds the translation column, so the light
 * direction would depend on where the camera IS rather than which way it faces,
 * and the scene would appear to change its lighting when you pan. Needed
 * because the point-sprite shader reconstructs its normal in VIEW space.
 */
export function dirToView(view: Mat4, d: Vec3): Vec3 {
  return vnorm([
    view[0] * d[0] + view[4] * d[1] + view[8] * d[2],
    view[1] * d[0] + view[5] * d[1] + view[9] * d[2],
    view[2] * d[0] + view[6] * d[1] + view[10] * d[2],
  ])
}

// --- the scene --------------------------------------------------------------

export type Viz3dKind = 'scatter' | 'surface' | 'bars' | 'globe'
export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max'

/**
 * What to draw, from which columns.
 *
 * The binding speaks the CHART's language and the scene speaks GL's. For a
 * surface and for bars that means `z = f(x, y)`: `x` and `y` are the two axes
 * and `z` is the height — which lands on the scene's Y, because Y is up in GL
 * and in gl.ts's Orbit. For a scatter there is no remapping; x/y/z are three
 * spatial axes and map straight through.
 */
export interface Viz3dBinding {
  kind: Viz3dKind
  /** scatter: the three spatial axes. surface/bars: x and y are the grid axes,
   *  z is the measured value. */
  x?: string
  y?: string
  z?: string
  /** numeric → ramp; text → categorical palette. */
  color?: string
  /** numeric; scatter and globe only. Maps to point AREA, not radius. */
  size?: string
  lat?: string
  lon?: string
  /** how the value column collapses within one grid cell. Default 'sum'. */
  agg?: Agg
  /** target bin count for a numeric grid axis. Default 16. */
  bins?: number
  /** a RAMPS key, or explicit hex stops. */
  ramp?: string | string[]
}

/**
 * One draw call's worth of geometry. Typed arrays because that is what goes
 * into a GPU buffer with no conversion, and because a 100k-point scatter as
 * plain arrays of objects is 40 MB of garbage per rebuild.
 */
export interface Mesh {
  mode: 'triangles' | 'lines' | 'points'
  /** xyz per vertex */
  positions: Float32Array
  /** rgb per vertex, 0..1 */
  colors: Float32Array
  /** UNIT normals, xyz per vertex. Absent on `lines` (unlit) and on `points`
   *  (the sprite shader derives a sphere normal per FRAGMENT — one vertex per
   *  row instead of the ~80 a real sphere would cost). */
  normals?: Float32Array
  indices?: Uint32Array
  /** per-point radius multiplier; `points` only. */
  sizes?: Float32Array
  lit: boolean
  /** closed geometry, so the SVG fallback may cull back faces. False on an open
   *  surface, which must stay visible from below. */
  cull?: boolean
}

export interface AxisMeta {
  title: string
  kind: 'value' | 'category'
  min?: number
  max?: number
  labels?: string[]
}

export interface Legend {
  title: string
  kind: 'ramp' | 'categories'
  ramp?: string[]
  min?: number
  max?: number
  items?: Array<{ label: string; color: string }>
}

export interface Scene {
  kind: Viz3dKind
  meshes: Mesh[]
  bounds: { min: Vec3; max: Vec3 }
  center: Vec3
  radius: number
  axes: AxisMeta[]
  legend?: Legend
  /** rows the binding looked at */
  rows: number
  /** rows a bound column had no number for. Dropped, and SAID so — a viewer
   *  that quietly plots 4,000 of 5,000 rows is a wrong answer that looks right. */
  dropped: number
  /** set when there is nothing to draw, and it says WHY. `mountViz3d` and the
   *  SVG fallback both render this sentence instead of an empty rectangle. */
  empty?: string
}

/** `radius` is 1, never 0: a zero-radius scene puts the camera AT the target,
 *  lookAt's forward vector is zero-length, and the matrix is NaN. */
const emptyScene = (kind: Viz3dKind, why: string, rows = 0): Scene => ({
  kind,
  meshes: [],
  bounds: { min: [0, 0, 0], max: [0, 0, 0] },
  center: [0, 0, 0],
  radius: 1,
  axes: [],
  rows,
  dropped: 0,
  empty: why,
})

// --- reading the sheet ------------------------------------------------------

/** Never coerces: a blank, a formula error and "n/a" are all `null`, and null
 *  rows are dropped rather than plotted at the origin. */
const num = (v: unknown): number | null => {
  if (v == null || v === '' || isErr(v)) return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s£$€¥%]/g, ''))
  return Number.isFinite(n) ? n : null
}

const fmtNum = (v: number): string => {
  if (!Number.isFinite(v)) return ''
  const a = Math.abs(v)
  if (a >= 1e6 || (a > 0 && a < 1e-3)) return v.toExponential(2)
  return String(Math.round(v * 1000) / 1000)
}

/**
 * Map finite values onto [-1, 1].
 *
 * A ZERO EXTENT MAPS TO 0, not to NaN. One constant column — and a filtered
 * slice very often has one — would otherwise divide by zero, every position in
 * the scene becomes NaN, GL draws absolutely nothing, and there is no error
 * anywhere to explain it.
 */
function scaler(vals: Array<number | null>): { lo: number; hi: number; to: (v: number) => number } {
  let lo = Infinity
  let hi = -Infinity
  for (const v of vals) {
    if (v === null) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 0 }
  const span = hi - lo
  return { lo, hi, to: (v) => (span > 0 ? ((v - lo) / span) * 2 - 1 : 0) }
}

/** 0..1 within the observed range; a zero range is 0.5 (the middle of the ramp,
 *  which is honest about "every value here is the same"). */
const norm01 = (v: number, lo: number, hi: number): number =>
  hi > lo ? clamp01((v - lo) / (hi - lo)) : 0.5

// --- point sizes ------------------------------------------------------------

const SIZE_MIN = 0.62
const SIZE_MAX = 2.55

/**
 * Value → point RADIUS, with AREA proportional to the value.
 *
 * Mapping the value straight to the radius is the classic bubble-chart
 * exaggeration: the reader compares the discs by area, so a 4x number drawn at
 * 4x radius looks 16x. Interpolating in area and taking the root is one `sqrt`
 * and the difference between a chart and a misrepresentation.
 */
const sizeFor = (t: number): number =>
  Math.sqrt(SIZE_MIN * SIZE_MIN + clamp01(t) * (SIZE_MAX * SIZE_MAX - SIZE_MIN * SIZE_MIN))

// --- grid axes --------------------------------------------------------------

const DEFAULT_BINS = 16
/** A surface with 200 categories on a side is 80,000 quads nobody can read. */
const AXIS_MAX_SURFACE = 128
/** Bars cost 24 vertices each, so their cap is tighter — 64x64 is 98k vertices. */
const AXIS_MAX_BARS = 64

interface Axis {
  labels: string[]
  /** row → bucket index; -1 means this row has no place on this axis. */
  slot: number[]
  numeric: boolean
  min?: number
  max?: number
}

/**
 * Turn a column into an ordered set of buckets.
 *
 * ORDER IS THE DECISION HERE. A numeric axis is ASCENDING, because a surface
 * interpolates between adjacent samples and interpolating between out-of-order
 * bins draws a shape that is not in the data. A text axis is FIRST-SEEN, the
 * same rule chart.ts uses, and for the same reason: sorting month names
 * alphabetically gives Apr, Aug, Dec, and a surface over that is noise.
 *
 * Numeric columns with more distinct values than `bins` are binned to equal
 * width; with fewer, each distinct value is its own slot. The mesh is ORDINAL
 * (samples are evenly spaced regardless of value) — the labels carry the real
 * numbers, and for the binned case the two agree exactly.
 */
function categorise(vals: unknown[], bins: number, cap: number): Axis {
  const n = vals.length
  const nums: Array<number | null> = new Array(n)
  let numericCount = 0
  let presentCount = 0
  for (let i = 0; i < n; i++) {
    const v = vals[i]
    const blank = v == null || v === ''
    if (!blank) presentCount++
    const x = blank ? null : num(v)
    nums[i] = x
    if (x !== null) numericCount++
  }

  const slot = new Array<number>(n).fill(-1)

  if (presentCount > 0 && numericCount === presentCount) {
    const uniq = [...new Set(nums.filter((v): v is number => v !== null))].sort((a, b) => a - b)
    if (uniq.length <= Math.max(2, bins)) {
      const at = new Map(uniq.map((v, i) => [v, i]))
      for (let i = 0; i < n; i++) if (nums[i] !== null) slot[i] = at.get(nums[i]!)!
      return {
        labels: uniq.map(fmtNum), slot, numeric: true,
        min: uniq[0], max: uniq[uniq.length - 1],
      }
    }
    const lo = uniq[0]
    const hi = uniq[uniq.length - 1]
    const k = Math.min(bins, cap)
    const w = (hi - lo) / k
    for (let i = 0; i < n; i++) {
      const v = nums[i]
      if (v === null) continue
      // the top edge belongs to the LAST bin, not to a k+1'th one
      slot[i] = w > 0 ? Math.min(k - 1, Math.floor((v - lo) / w)) : 0
    }
    const labels = Array.from({ length: k }, (_, i) => fmtNum(lo + w * (i + 0.5)))
    return { labels, slot, numeric: true, min: lo, max: hi }
  }

  const labels: string[] = []
  const at = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const v = vals[i]
    if (v == null || v === '') continue
    const s = String(v)
    let k = at.get(s)
    if (k === undefined) {
      // past the cap the row is dropped rather than folded into an "other"
      // bucket: an "other" column on a 3D chart is a bar whose height is an
      // artefact of the cap, and readers total it.
      if (labels.length >= cap) continue
      k = labels.length
      at.set(s, k)
      labels.push(s)
    }
    slot[i] = k
  }
  return { labels, slot, numeric: false }
}

/** Collapse rows into (nx x ny) cells. `present` is what stops a missing cell
 *  becoming a crater at zero. */
function aggregateGrid(
  nx: number, ny: number,
  sx: number[], sy: number[],
  zs: Array<number | null> | null,
  agg: Agg,
): { v: Float64Array; present: Uint8Array; used: number } {
  const cells = nx * ny
  const v = new Float64Array(cells)
  const count = new Float64Array(cells)
  const present = new Uint8Array(cells)
  let used = 0
  for (let i = 0; i < sx.length; i++) {
    const a = sx[i]
    const b = sy[i]
    if (a < 0 || b < 0) continue
    const z = zs ? zs[i] : 1
    if (agg !== 'count' && z === null) continue
    const c = b * nx + a
    used++
    const first = present[c] === 0
    present[c] = 1
    count[c]++
    if (agg === 'count') { v[c] = count[c]; continue }
    const x = z as number
    if (first) { v[c] = x; continue }
    if (agg === 'sum' || agg === 'avg') v[c] += x
    else if (agg === 'min') v[c] = Math.min(v[c], x)
    else v[c] = Math.max(v[c], x)
  }
  if (agg === 'avg') for (let c = 0; c < cells; c++) if (present[c]) v[c] /= count[c]
  return { v, present, used }
}

// --- geometry primitives ----------------------------------------------------

/**
 * Per-vertex normals by AREA-WEIGHTED accumulation of face normals.
 *
 * Area weighting is not a nicety: an un-weighted average lets a sliver triangle
 * — which a binned grid produces at its edges — pull the normal as hard as the
 * big quad beside it, and the surface gains a bright seam that is not in the
 * data. The un-normalised cross product IS twice the area, so the weighting is
 * free: accumulate it before normalising.
 *
 * A vertex with no usable contribution (an isolated point, a degenerate fan)
 * gets +Y rather than zero. A zero normal shades to pure black, which reads as
 * a hole in the mesh rather than as the missing information it is.
 */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const out = new Float32Array(positions.length)
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const ia = indices[t] * 3, ib = indices[t + 1] * 3, ic = indices[t + 2] * 3
    const ax = positions[ib] - positions[ia]
    const ay = positions[ib + 1] - positions[ia + 1]
    const az = positions[ib + 2] - positions[ia + 2]
    const bx = positions[ic] - positions[ia]
    const by = positions[ic + 1] - positions[ia + 1]
    const bz = positions[ic + 2] - positions[ia + 2]
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
    for (const i of [ia, ib, ic]) {
      out[i] += nx; out[i + 1] += ny; out[i + 2] += nz
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2])
    if (l > 1e-12) { out[i] /= l; out[i + 1] /= l; out[i + 2] /= l }
    else { out[i] = 0; out[i + 1] = 1; out[i + 2] = 0 }
  }
  return out
}

/** lat/long in DEGREES → a point on a sphere. lon 0 faces +Z and lat +90 is +Y,
 *  matching gl.ts's Orbit (azimuth 0 looks down +Z), so "the camera starts over
 *  the prime meridian" is true rather than approximately true. */
export function latLonToXyz(lat: number, lon: number, r = 1): Vec3 {
  const p = (lat * Math.PI) / 180
  const l = (lon * Math.PI) / 180
  const c = Math.cos(p)
  return [r * c * Math.sin(l), r * Math.sin(p), r * c * Math.cos(l)]
}

/**
 * A UV sphere. Normals are the normalised POSITIONS — exact by construction,
 * where computeNormals would only approximate them, and the poles (where a
 * triangle fan's normals are least reliable) are the part of a globe people
 * look at first.
 *
 * The seam column is duplicated so the grid is rectangular; the degenerate
 * triangles at each pole are skipped rather than emitted zero-area, because a
 * zero-area triangle contributes nothing but still costs a vertex fetch.
 */
function sphereMesh(r: number, segU: number, segV: number): {
  positions: Float32Array; normals: Float32Array; indices: Uint32Array
} {
  const cols = segU + 1
  const rows = segV + 1
  const positions = new Float32Array(cols * rows * 3)
  const normals = new Float32Array(cols * rows * 3)
  for (let j = 0; j < rows; j++) {
    const lat = 90 - (180 * j) / segV
    for (let i = 0; i < cols; i++) {
      const lon = -180 + (360 * i) / segU
      const p = latLonToXyz(lat, lon, r)
      const k = (j * cols + i) * 3
      positions[k] = p[0]; positions[k + 1] = p[1]; positions[k + 2] = p[2]
      normals[k] = p[0] / r; normals[k + 1] = p[1] / r; normals[k + 2] = p[2] / r
    }
  }
  const idx: number[] = []
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1
      if (j !== 0) idx.push(a, c, b)
      if (j !== segV - 1) idx.push(b, c, d)
    }
  }
  return { positions, normals, indices: new Uint32Array(idx) }
}

/** The six faces of an axis-aligned box, wound counter-clockwise from OUTSIDE
 *  and carrying their own normals. Flat shading is CORRECT for a box, so these
 *  are NOT run through computeNormals — smoothed box corners look like melted
 *  wax, which is a different failure from an unlit one but just as visible. */
const BOX_FACES: Array<{ n: Vec3; c: Array<[number, number, number]> }> = [
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
]

const FRAME_RGB: RGB = [0.42, 0.47, 0.56]
const FRAME_GRID = 4

/**
 * The bounding box and floor grid.
 *
 * Not decoration: a perspective projection of unlabelled points has no scale
 * cue at all, and readers systematically misjudge depth without a reference
 * plane. Fifty vertices buys the whole depth read.
 */
function frameMesh(min: Vec3, max: Vec3): Mesh {
  const pos: number[] = []
  const col: number[] = []
  const seg = (a: Vec3, b: Vec3, k: number) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2])
    for (let i = 0; i < 2; i++) col.push(FRAME_RGB[0] * k, FRAME_RGB[1] * k, FRAME_RGB[2] * k)
  }
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const corners: Vec3[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ]
  const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]
  for (const [a, b] of edges) seg(corners[a], corners[b], 1)
  for (let i = 1; i < FRAME_GRID; i++) {
    const t = i / FRAME_GRID
    seg([x0 + (x1 - x0) * t, y0, z0], [x0 + (x1 - x0) * t, y0, z1], 0.5)
    seg([x0, y0, z0 + (z1 - z0) * t], [x1, y0, z0 + (z1 - z0) * t], 0.5)
  }
  return {
    mode: 'lines',
    positions: new Float32Array(pos),
    colors: new Float32Array(col),
    lit: false,
  }
}

function boundsOf(meshes: Mesh[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const m of meshes) {
    const p = m.positions
    for (let i = 0; i + 2 < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p[i + k]
        if (!Number.isFinite(v)) continue
        if (v < min[k]) min[k] = v
        if (v > max[k]) max[k] = v
      }
    }
  }
  for (let k = 0; k < 3; k++) {
    if (!Number.isFinite(min[k])) { min[k] = 0; max[k] = 0 }
  }
  return { min, max }
}

function finish(kind: Viz3dKind, data: Mesh[], extra: Mesh[], rest: {
  axes: AxisMeta[]; legend?: Legend; rows: number; dropped: number
}): Scene {
  const bounds = boundsOf(data)
  const center: Vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ]
  const radius = Math.max(
    0.5,
    0.5 * Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]),
  )
  return { kind, meshes: [...data, ...extra], bounds, center, radius, ...rest }
}

// --- buildScene -------------------------------------------------------------

const rampOf = (b: Viz3dBinding): { hex: string[]; rgb: RGB[] } => {
  const hex = (Array.isArray(b.ramp) ? b.ramp : RAMPS[b.ramp ?? 'viridis']) ?? RAMPS.viridis
  return { hex, rgb: hex.map(hexToRgb) }
}

/**
 * Columns → geometry. PURE: no canvas, no document, no GL — which is what lets
 * the rig check the vertex counts, the winding and the normals in node.
 *
 * `computed` is chart.ts's contract, unchanged: the grid hands in what it just
 * recalculated so a formula column plots the numbers the reader is looking at
 * rather than the raw column underneath them.
 */
export function buildScene(
  sheet: TableSheet,
  binding: Viz3dBinding,
  computed?: Map<string, unknown[]>,
): Scene {
  const rows = sheet.rids.reduce((a, [, c]) => a + c, 0)
  if (rows === 0) return emptyScene(binding.kind, 'this sheet has no rows yet')

  const nameOf = (id?: string): string =>
    id ? (sheet.columns.find((c) => c.id === id)?.name ?? id) : ''
  const col = (id?: string): unknown[] | null => {
    if (!id) return null
    const c = computed?.get(id)
    if (c) return c
    const d = sheet.data[id]
    if (!d) return null
    return Array.from({ length: rows }, (_, i) => readCell(d, i))
  }

  switch (binding.kind) {
    case 'globe': return buildGlobe(binding, rows, col, nameOf)
    case 'surface': return buildGrid(binding, rows, col, nameOf, true)
    case 'bars': return buildGrid(binding, rows, col, nameOf, false)
    default: return buildScatter(binding, rows, col, nameOf)
  }
}

type ColFn = (id?: string) => unknown[] | null
type NameFn = (id?: string) => string

function buildScatter(b: Viz3dBinding, rows: number, col: ColFn, nameOf: NameFn): Scene {
  const cx = col(b.x), cy = col(b.y), cz = col(b.z)
  if (!cx || !cy || !cz) {
    return emptyScene('scatter', 'a 3D scatter needs three numeric columns — pick X, Y and Z', rows)
  }
  const xs = cx.map(num), ys = cy.map(num), zs = cz.map(num)

  const cc = col(b.color)
  const cNums = cc ? cc.map(num) : null
  // A colour column is NUMERIC only if every value present in it is a number;
  // one stray "n/a" must not silently turn a category axis into a ramp of NaN.
  const colourNumeric = !!cNums && cc!.some((v, i) => v != null && v !== '' && cNums[i] !== null)
    && cc!.every((v, i) => v == null || v === '' || cNums![i] !== null)
  const sc = col(b.size)
  const sNums = sc ? sc.map(num) : null

  const keep: number[] = []
  for (let i = 0; i < rows; i++) if (xs[i] !== null && ys[i] !== null && zs[i] !== null) keep.push(i)
  if (!keep.length) {
    return emptyScene('scatter', 'no row has a number in all three of X, Y and Z', rows)
  }

  const sx = scaler(xs), sy = scaler(ys), sz = scaler(zs)
  const ramp = rampOf(b)

  // Categorical colour: first-seen order, so the 3D view and the 2D chart agree
  // about which category is which colour.
  const catAt = new Map<string, number>()
  const catLabels: string[] = []
  if (cc && !colourNumeric) {
    for (const i of keep) {
      const v = cc[i]
      if (v == null || v === '') continue
      const s = String(v)
      if (!catAt.has(s)) { catAt.set(s, catAt.size); catLabels.push(s) }
    }
  }
  const cScale = colourNumeric ? scaler(cNums!) : null
  const sScale = sNums ? scaler(sNums) : null

  const positions = new Float32Array(keep.length * 3)
  const colors = new Float32Array(keep.length * 3)
  const sizes = new Float32Array(keep.length)
  keep.forEach((row, k) => {
    positions[k * 3] = sx.to(xs[row]!)
    positions[k * 3 + 1] = sy.to(ys[row]!)
    positions[k * 3 + 2] = sz.to(zs[row]!)
    let rgb: RGB
    if (cScale) rgb = rampColor(norm01(cNums![row] ?? cScale.lo, cScale.lo, cScale.hi), ramp.rgb)
    else if (cc) {
      const s = cc[row] == null ? '' : String(cc[row])
      const j = catAt.get(s)
      rgb = hexToRgb(j === undefined ? '#8A93A5' : CATEGORY_COLORS[j % CATEGORY_COLORS.length])
    } else {
      // No colour column: ramp over Z anyway. A monochrome cloud in perspective
      // has no depth cue at all beyond point size, and the ramp is free.
      rgb = rampColor(norm01(zs[row]!, sz.lo, sz.hi), ramp.rgb)
    }
    colors[k * 3] = rgb[0]; colors[k * 3 + 1] = rgb[1]; colors[k * 3 + 2] = rgb[2]
    const sv = sScale && sNums![row] !== null ? norm01(sNums![row]!, sScale.lo, sScale.hi) : 0.42
    sizes[k] = sizeFor(sv)
  })

  const data: Mesh[] = [{ mode: 'points', positions, colors, sizes, lit: true }]
  const legend: Legend = cScale
    ? { title: nameOf(b.color), kind: 'ramp', ramp: ramp.hex, min: cScale.lo, max: cScale.hi }
    : cc
      ? {
        title: nameOf(b.color), kind: 'categories',
        items: catLabels.slice(0, 8).map((l, i) => ({ label: l, color: CATEGORY_COLORS[i % CATEGORY_COLORS.length] })),
      }
      : { title: nameOf(b.z), kind: 'ramp', ramp: ramp.hex, min: sz.lo, max: sz.hi }

  const bounds = boundsOf(data)
  return finish('scatter', data, [frameMesh(bounds.min, bounds.max)], {
    axes: [
      { title: nameOf(b.x), kind: 'value', min: sx.lo, max: sx.hi },
      { title: nameOf(b.y), kind: 'value', min: sy.lo, max: sy.hi },
      { title: nameOf(b.z), kind: 'value', min: sz.lo, max: sz.hi },
    ],
    legend,
    rows,
    dropped: rows - keep.length,
  })
}

function buildGrid(b: Viz3dBinding, rows: number, col: ColFn, nameOf: NameFn, surface: boolean): Scene {
  const kind: Viz3dKind = surface ? 'surface' : 'bars'
  const cx = col(b.x), cy = col(b.y)
  /**
   * A SURFACE DEFAULTS TO AVERAGE AND BARS TO SUM, and that is not a taste.
   *
   * A surface is a FIELD — `z = f(x, y)` sampled at points — so a cell holding
   * two samples must report what the field is worth there, not their total.
   * Summing makes the height depend on SAMPLING DENSITY: bin 40 evenly-spaced x
   * values into 24 bins and some bins take two samples and some one, so a
   * perfectly smooth field renders as a comb of spikes with a period set by the
   * binning. Caught by looking at a `sin(r)/r` surface, which should be smooth
   * and was not.
   *
   * A bar is a TOTAL — revenue by region and quarter — and summing is what
   * anyone reading it means. The two defaults are opposite because the two
   * charts are answering opposite questions.
   */
  const agg = b.agg ?? (surface ? 'avg' : 'sum')
  const cz = col(b.z)
  if (!cx || !cy || (!cz && agg !== 'count')) {
    return emptyScene(kind, `${surface ? 'a surface' : '3D bars'} needs two axis columns and a value column`, rows)
  }
  const cap = surface ? AXIS_MAX_SURFACE : AXIS_MAX_BARS
  const bins = Math.max(2, Math.min(cap, b.bins ?? DEFAULT_BINS))
  const ax = categorise(cx, bins, cap)
  const ay = categorise(cy, bins, cap)
  const nx = ax.labels.length
  const ny = ay.labels.length
  if (nx < 1 || ny < 1) return emptyScene(kind, 'the axis columns are empty', rows)
  if (surface && (nx < 2 || ny < 2)) {
    // One row or one column of samples is a line, not a surface, and the quad
    // loop would emit nothing at all — say so rather than draw an empty box.
    return emptyScene(kind, 'a surface needs at least two distinct values on each axis', rows)
  }

  const zs = cz ? cz.map(num) : null
  const g = aggregateGrid(nx, ny, ax.slot, ay.slot, zs, agg)
  if (!g.used) return emptyScene(kind, 'no row falls on both axes with a value', rows)

  const present: Array<number | null> = []
  for (let c = 0; c < nx * ny; c++) present.push(g.present[c] ? g.v[c] : null)
  const vs = scaler(present)
  const ramp = rampOf(b)
  const at = (i: number, n: number) => (n > 1 ? (i / (n - 1)) * 2 - 1 : 0)

  const data: Mesh[] = []
  if (surface) {
    const positions = new Float32Array(nx * ny * 3)
    const colors = new Float32Array(nx * ny * 3)
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i
        const k = c * 3
        const v = g.present[c] ? g.v[c] : vs.lo
        positions[k] = at(i, nx)
        positions[k + 1] = vs.to(v)
        positions[k + 2] = at(j, ny)
        const rgb = rampColor(norm01(v, vs.lo, vs.hi), ramp.rgb)
        colors[k] = rgb[0]; colors[k + 1] = rgb[1]; colors[k + 2] = rgb[2]
      }
    }
    // A quad is emitted only when all FOUR corners were measured. Interpolating
    // across a gap invents a value, and on a surface an invented value is
    // indistinguishable from a measured one.
    const idx: number[] = []
    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const a = j * nx + i, bb = a + 1, c = a + nx, d = c + 1
        if (!(g.present[a] && g.present[bb] && g.present[c] && g.present[d])) continue
        // wound so the face normal is +Y (see the note on BOX_FACES)
        idx.push(a, c, bb, bb, c, d)
      }
    }
    const indices = new Uint32Array(idx)
    data.push({
      mode: 'triangles', positions, colors, indices,
      normals: computeNormals(positions, indices), lit: true, cull: false,
    })
  } else {
    // Bars start at ZERO. A bar's LENGTH is the value, so a truncated axis is a
    // lie rather than a zoom — the one chart where that is unambiguous.
    const span = Math.max(Math.abs(vs.lo), Math.abs(vs.hi))
    const yk = span > 0 ? 1 / span : 0
    const cells: number[] = []
    for (let c = 0; c < nx * ny; c++) if (g.present[c]) cells.push(c)
    const positions = new Float32Array(cells.length * 24 * 3)
    const normals = new Float32Array(cells.length * 24 * 3)
    const colors = new Float32Array(cells.length * 24 * 3)
    const indices = new Uint32Array(cells.length * 36)
    const wx = (nx > 1 ? 2 / (nx - 1) : 1) * 0.36
    const wz = (ny > 1 ? 2 / (ny - 1) : 1) * 0.36
    cells.forEach((c, bi) => {
      const i = c % nx, j = (c / nx) | 0
      const v = g.v[c] * yk
      const x0 = at(i, nx) - wx, x1 = at(i, nx) + wx
      const z0 = at(j, ny) - wz, z1 = at(j, ny) + wz
      const y0 = Math.min(0, v), y1 = Math.max(0, v)
      const rgb = rampColor(norm01(g.v[c], vs.lo, vs.hi), ramp.rgb)
      let vi = bi * 24
      let ii = bi * 36
      for (const face of BOX_FACES) {
        const base = vi
        for (const [fx, fy, fz] of face.c) {
          const k = vi * 3
          positions[k] = fx ? x1 : x0
          positions[k + 1] = fy ? y1 : y0
          positions[k + 2] = fz ? z1 : z0
          normals[k] = face.n[0]; normals[k + 1] = face.n[1]; normals[k + 2] = face.n[2]
          colors[k] = rgb[0]; colors[k + 1] = rgb[1]; colors[k + 2] = rgb[2]
          vi++
        }
        indices[ii++] = base; indices[ii++] = base + 1; indices[ii++] = base + 2
        indices[ii++] = base; indices[ii++] = base + 2; indices[ii++] = base + 3
      }
    })
    data.push({ mode: 'triangles', positions, colors, normals, indices, lit: true, cull: true })
  }

  const bounds = boundsOf(data)
  return finish(kind, data, [frameMesh(
    [Math.min(-1, bounds.min[0]), bounds.min[1], Math.min(-1, bounds.min[2])],
    [Math.max(1, bounds.max[0]), bounds.max[1], Math.max(1, bounds.max[2])],
  )], {
    axes: [
      { title: nameOf(b.x), kind: ax.numeric ? 'value' : 'category', min: ax.min, max: ax.max, labels: ax.labels },
      { title: nameOf(b.y), kind: ay.numeric ? 'value' : 'category', min: ay.min, max: ay.max, labels: ay.labels },
      { title: agg === 'count' ? 'count' : `${agg} of ${nameOf(b.z)}`, kind: 'value', min: vs.lo, max: vs.hi },
    ],
    legend: { title: agg === 'count' ? 'count' : nameOf(b.z), kind: 'ramp', ramp: ramp.hex, min: vs.lo, max: vs.hi },
    rows,
    // rows that fell off an axis (blank, unparseable, or past the category cap)
    dropped: rows - g.used,
  })
}

const GLOBE_R = 1
/** Points sit just off the surface. Exactly ON it z-fights: the depth buffer
 *  cannot separate two surfaces at the same depth and the dots flicker as the
 *  camera moves, which reads as a rendering fault rather than as data. */
const GLOBE_LIFT = 1.012

function buildGlobe(b: Viz3dBinding, rows: number, col: ColFn, nameOf: NameFn): Scene {
  const clat = col(b.lat), clon = col(b.lon)
  if (!clat || !clon) return emptyScene('globe', 'a globe needs a latitude and a longitude column', rows)
  const lats = clat.map(num)
  const lons = clon.map(num)

  const keep: number[] = []
  for (let i = 0; i < rows; i++) {
    const la = lats[i], lo = lons[i]
    // Out-of-range values are REFUSED, not wrapped. A column that is not really
    // a latitude (a row number, a temperature) otherwise paints a confident
    // band of dots across the equator and nothing says the binding is wrong.
    if (la === null || lo === null) continue
    if (la < -90 || la > 90 || lo < -180 || lo > 180) continue
    keep.push(i)
  }

  const ramp = rampOf(b)
  const cc = col(b.color)
  const cNums = cc ? cc.map(num) : null
  const colourNumeric = !!cNums && cc!.some((v, i) => v != null && v !== '' && cNums[i] !== null)
    && cc!.every((v, i) => v == null || v === '' || cNums![i] !== null)
  const cScale = colourNumeric ? scaler(cNums!) : null
  const sc = col(b.size)
  const sNums = sc ? sc.map(num) : null
  const sScale = sNums ? scaler(sNums) : null
  const catAt = new Map<string, number>()
  const catLabels: string[] = []
  if (cc && !colourNumeric) {
    for (const i of keep) {
      const s = cc[i] == null ? '' : String(cc[i])
      if (s && !catAt.has(s)) { catAt.set(s, catAt.size); catLabels.push(s) }
    }
  }

  const sphere = sphereMesh(GLOBE_R, 48, 24)
  const ocean: RGB = [0.13, 0.22, 0.34]
  const sphereColors = new Float32Array(sphere.positions.length)
  for (let i = 0; i < sphereColors.length; i += 3) {
    sphereColors[i] = ocean[0]; sphereColors[i + 1] = ocean[1]; sphereColors[i + 2] = ocean[2]
  }
  const meshes: Mesh[] = [{
    mode: 'triangles',
    positions: sphere.positions,
    normals: sphere.normals,
    colors: sphereColors,
    indices: sphere.indices,
    lit: true,
    cull: true,
  }, graticule()]

  if (keep.length) {
    const positions = new Float32Array(keep.length * 3)
    const colors = new Float32Array(keep.length * 3)
    const sizes = new Float32Array(keep.length)
    keep.forEach((row, k) => {
      const p = latLonToXyz(lats[row]!, lons[row]!, GLOBE_R * GLOBE_LIFT)
      positions[k * 3] = p[0]; positions[k * 3 + 1] = p[1]; positions[k * 3 + 2] = p[2]
      let rgb: RGB
      if (cScale) rgb = rampColor(norm01(cNums![row] ?? cScale.lo, cScale.lo, cScale.hi), ramp.rgb)
      else if (cc) {
        const j = catAt.get(cc[row] == null ? '' : String(cc[row]))
        rgb = hexToRgb(j === undefined ? '#F7A600' : CATEGORY_COLORS[j % CATEGORY_COLORS.length])
      } else rgb = hexToRgb('#F7A600')
      colors[k * 3] = rgb[0]; colors[k * 3 + 1] = rgb[1]; colors[k * 3 + 2] = rgb[2]
      const sv = sScale && sNums![row] !== null ? norm01(sNums![row]!, sScale.lo, sScale.hi) : 0.35
      sizes[k] = sizeFor(sv)
    })
    meshes.push({ mode: 'points', positions, colors, sizes, lit: true })
  }

  const legend: Legend | undefined = cScale
    ? { title: nameOf(b.color), kind: 'ramp', ramp: ramp.hex, min: cScale.lo, max: cScale.hi }
    : catLabels.length
      ? {
        title: nameOf(b.color), kind: 'categories',
        items: catLabels.slice(0, 8).map((l, i) => ({ label: l, color: CATEGORY_COLORS[i % CATEGORY_COLORS.length] })),
      }
      : undefined

  return finish('globe', meshes, [], {
    axes: [
      { title: nameOf(b.lat), kind: 'value', min: -90, max: 90 },
      { title: nameOf(b.lon), kind: 'value', min: -180, max: 180 },
    ],
    legend,
    rows,
    dropped: rows - keep.length,
  })
}

/** Meridians and parallels every 30°. The graticule is what makes a sphere read
 *  as a rotating globe rather than as a flat lit disc — a smooth shaded sphere
 *  has no features, so nothing on screen moves when the camera does. */
function graticule(): Mesh {
  const pos: number[] = []
  const col: number[] = []
  const c: RGB = [0.38, 0.52, 0.62]
  const r = GLOBE_R * 1.003
  const push = (a: Vec3, b: Vec3) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2])
    for (let i = 0; i < 2; i++) col.push(c[0], c[1], c[2])
  }
  for (let lon = -180; lon < 180; lon += 30) {
    for (let lat = -90; lat < 90; lat += 10) {
      push(latLonToXyz(lat, lon, r), latLonToXyz(lat + 10, lon, r))
    }
  }
  for (const lat of [-60, -30, 0, 30, 60]) {
    for (let lon = -180; lon < 180; lon += 10) {
      push(latLonToXyz(lat, lon, r), latLonToXyz(lat, lon + 10, r))
    }
  }
  return { mode: 'lines', positions: new Float32Array(pos), colors: new Float32Array(col), lit: false }
}

/**
 * A binding that needs no configuration, so the first 3D view takes one click.
 * Mirrors chart.ts's defaultBinding in spirit: prefer the view the columns are
 * actually shaped for, and return null rather than force one that is wrong.
 */
export function defaultViz3d(sheet: TableSheet): Viz3dBinding | null {
  const numeric = sheet.columns.filter((c) => c.type === 'number' || c.type === 'money' || c.type === 'percent')
  const cat = sheet.columns.filter((c) => c.type === 'text' || c.type === 'enum' || c.type === 'date')
  const find = (re: RegExp) => numeric.find((c) => re.test(c.name) || re.test(c.id))
  // `\b` matters: without it "platform" is a latitude column.
  const lat = find(/^lat(itude)?$/i) ?? find(/\blat/i)
  const lon = find(/^(lon|lng|long(itude)?)$/i) ?? find(/\b(lon|lng)/i)
  if (lat && lon && lat.id !== lon.id) {
    return { kind: 'globe', lat: lat.id, lon: lon.id, color: numeric.find((c) => c.id !== lat.id && c.id !== lon.id)?.id }
  }
  if (numeric.length >= 3) {
    return {
      kind: 'scatter',
      x: numeric[0].id, y: numeric[1].id, z: numeric[2].id,
      color: numeric[3]?.id ?? cat[0]?.id,
      size: numeric[4]?.id,
    }
  }
  if (cat.length >= 2 && numeric.length >= 1) {
    return { kind: 'bars', x: cat[0].id, y: cat[1].id, z: numeric[0].id, agg: 'sum' }
  }
  return null
}

// --- the 2D fallback --------------------------------------------------------

/** Past this the SVG is slower to lay out than the data is worth, so triangle
 *  meshes degrade to their VERTICES as dots. A half-resolution mesh would be
 *  worse: striding triangles punches holes in the surface, and a surface with
 *  holes reads as missing data. */
const SVG_MAX_TRIS = 9000
const SVG_MAX_POINTS = 4000

const esc = (s: string): string =>
  String(s).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))

export interface FallbackOpts {
  /** reuse a live camera, so dragging the fallback works exactly like dragging GL */
  camera?: Orbit
  azimuth?: number
  elevation?: number
  background?: string
  ink?: string
}

/** Frame a scene: far enough back that the bounding sphere fits the vertical fov. */
export function frameCamera(scene: Scene, opts: { azimuth?: number; elevation?: number } = {}): Orbit {
  const o = new Orbit()
  o.target = [...scene.center] as Vec3
  o.fovY = Math.PI / 4
  o.distance = Math.max(0.6, scene.radius / Math.sin(o.fovY / 2)) * 0.85
  o.minDistance = scene.radius * 0.15
  o.maxDistance = scene.radius * 40
  o.azimuth = opts.azimuth ?? 0.72
  o.elevation = opts.elevation ?? 0.46
  o.near = Math.max(0.01, scene.radius / 200)
  o.far = scene.radius * 80
  return o
}

/**
 * The same scene, the same camera and the same lighting, projected into SVG.
 *
 * PAINTER'S ALGORITHM: every primitive is emitted in one list sorted far-to-near
 * by centroid depth. That is exact for convex closed geometry (the globe, a
 * bar) and correct in practice for a heightfield; it is WRONG for two triangles
 * that interpenetrate, which the depth buffer would resolve per-pixel. Accepted,
 * because the alternative on this path is a software rasteriser.
 *
 * Returns a STRING so it is testable in node — the whole reason the fallback is
 * checkable at all.
 */
export function fallbackSvg(scene: Scene, w = 640, h = 420, opts: FallbackOpts = {}): string {
  const bg = opts.background ?? '#0E1420'
  const ink = opts.ink ?? '#C7D0DE'
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%" ` +
    `role="img" aria-label="${esc(scene.empty ?? `3D ${scene.kind}`)}" style="display:block">` +
    `<rect width="${w}" height="${h}" fill="${esc(bg)}"/>`
  const tail = '</svg>'

  if (scene.empty || !scene.meshes.length) {
    // NOT a blank box: the sentence is the point. A reader on a machine without
    // WebGL2 must learn that the view exists and why it is not showing data.
    return head +
      `<text x="${w / 2}" y="${h / 2}" fill="${esc(ink)}" font-family="system-ui,sans-serif" ` +
      `font-size="14" text-anchor="middle" opacity="0.85">${esc(scene.empty ?? 'nothing to draw')}</text>` +
      tail
  }

  const cam = opts.camera ?? frameCamera(scene, opts)
  const vp = cam.matrix(w / Math.max(1, h))

  let tris = 0
  for (const m of scene.meshes) {
    if (m.mode === 'triangles') tris += (m.indices ? m.indices.length : m.positions.length / 3) / 3
  }
  const dots = tris > SVG_MAX_TRIS

  const prims: Array<{ z: number; s: string }> = []
  const px = (i: number, p: Float32Array) => project(vp, [p[i], p[i + 1], p[i + 2]], w, h)
  const hex = (r: number, g: number, b: number, k: number): string =>
    rgbToHex([r * k, g * k, b * k])

  for (const m of scene.meshes) {
    const p = m.positions
    const c = m.colors
    if (m.mode === 'triangles' && !dots) {
      const idx = m.indices ?? new Uint32Array(Array.from({ length: p.length / 3 }, (_, i) => i))
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, d = idx[t + 2] * 3
        const pa = px(a, p), pb = px(b, p), pd = px(d, p)
        if (!(Number.isFinite(pa.x) && Number.isFinite(pb.x) && Number.isFinite(pd.x))) continue
        if (pa.z > 1 || pb.z > 1 || pd.z > 1) continue      // behind the eye, or past the far plane
        if (m.cull) {
          // screen-space signed area; y is flipped, so a front face is negative
          const area = (pb.x - pa.x) * (pd.y - pa.y) - (pd.x - pa.x) * (pb.y - pa.y)
          if (area > 0) continue
        }
        // FACE normal, not the interpolated vertex normals: SVG cannot shade a
        // gradient across a polygon, so flat-per-triangle is the honest choice
        // and a fine enough mesh looks smooth anyway.
        const nx0 = p[b] - p[a], ny0 = p[b + 1] - p[a + 1], nz0 = p[b + 2] - p[a + 2]
        const nx1 = p[d] - p[a], ny1 = p[d + 1] - p[a + 1], nz1 = p[d + 2] - p[a + 2]
        let n: Vec3 = vnorm([
          ny0 * nz1 - nz0 * ny1,
          nz0 * nx1 - nx0 * nz1,
          nx0 * ny1 - ny0 * nx1,
        ])
        // A back-facing normal on an OPEN surface is the underside; light it as
        // if it faced us rather than painting it black.
        if (!m.cull && m.normals) {
          const dotv = n[0] * m.normals[a] + n[1] * m.normals[a + 1] + n[2] * m.normals[a + 2]
          if (dotv < 0) n = [-n[0], -n[1], -n[2]]
        }
        const k = m.lit ? shade(n) : 1
        const fill = hex((c[a] + c[b] + c[d]) / 3, (c[a + 1] + c[b + 1] + c[d + 1]) / 3, (c[a + 2] + c[b + 2] + c[d + 2]) / 3, k)
        prims.push({
          z: (pa.z + pb.z + pd.z) / 3,
          s: `<polygon points="${pa.x.toFixed(1)},${pa.y.toFixed(1)} ${pb.x.toFixed(1)},${pb.y.toFixed(1)} ${pd.x.toFixed(1)},${pd.y.toFixed(1)}" fill="${fill}"/>`,
        })
      }
      continue
    }
    if (m.mode === 'lines') {
      for (let i = 0; i + 5 < p.length; i += 6) {
        const pa = px(i, p), pb = px(i + 3, p)
        if (!Number.isFinite(pa.x) || !Number.isFinite(pb.x) || pa.z > 1 || pb.z > 1) continue
        prims.push({
          z: (pa.z + pb.z) / 2,
          s: `<line x1="${pa.x.toFixed(1)}" y1="${pa.y.toFixed(1)}" x2="${pb.x.toFixed(1)}" y2="${pb.y.toFixed(1)}" stroke="${hex(c[i], c[i + 1], c[i + 2], 1)}" stroke-width="1" opacity="0.75"/>`,
        })
      }
      continue
    }
    // points, and triangle meshes degraded to their vertices
    const count = p.length / 3
    const stride = Math.max(1, Math.ceil(count / SVG_MAX_POINTS))
    // world radius → pixels, the same formula the point shader uses
    const scale = ((0.5 * h) / Math.tan(cam.fovY / 2)) * (scene.radius * 0.022)
    // A sprite always faces the camera, so its CENTRE normal is +Z in view
    // space; SVG cannot vary shading across a circle, so one value per point is
    // all there is. Hoisted: eye() and view() allocate, and this is per-mesh.
    const k = m.lit ? shadeWith([0, 0, 1], dirToView(cam.view(), LIGHT)) : 1
    const eye = cam.eye()
    for (let v = 0; v < count; v += stride) {
      const i = v * 3
      const q = px(i, p)
      if (!Number.isFinite(q.x) || q.z > 1) continue
      const dist = Math.max(1e-3, Math.hypot(p[i] - eye[0], p[i + 1] - eye[1], p[i + 2] - eye[2]))
      const rad = clamp(((m.sizes ? m.sizes[v] : 0.5) * scale) / dist, 0.7, 30)
      prims.push({
        z: q.z,
        s: `<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="${rad.toFixed(2)}" fill="${hex(c[i], c[i + 1], c[i + 2], k)}"/>`,
      })
    }
  }

  // far first. `project` returns NDC depth, where +1 is the far plane.
  prims.sort((a, b) => b.z - a.z)

  return head + prims.map((x) => x.s).join('') + overlaySvg(scene, w, h, ink) + tail
}

/** Axis titles, the colour legend and the dropped-row count. Chrome, but the
 *  dropped count is not optional: it is the only place the fallback can say
 *  that some rows are not in the picture. */
function overlaySvg(scene: Scene, w: number, h: number, ink: string): string {
  const font = 'font-family="system-ui,-apple-system,sans-serif"'
  let out = ''
  const titles = scene.axes.map((a) => a.title).filter(Boolean).join('  ·  ')
  if (titles) {
    out += `<text x="12" y="${h - 12}" fill="${esc(ink)}" ${font} font-size="11" opacity="0.75">${esc(titles)}</text>`
  }
  if (scene.dropped > 0) {
    out += `<text x="${w - 12}" y="${h - 12}" fill="${esc(ink)}" ${font} font-size="11" ` +
      `text-anchor="end" opacity="0.6">${scene.dropped} of ${scene.rows} rows had no value</text>`
  }
  const lg = scene.legend
  if (lg && lg.kind === 'ramp' && lg.ramp?.length) {
    const id = 'v3lg'
    const stops = lg.ramp.map((c, i) =>
      `<stop offset="${((i / (lg.ramp!.length - 1)) * 100).toFixed(0)}%" stop-color="${esc(c)}"/>`).join('')
    out += `<defs><linearGradient id="${id}" x1="0" y1="1" x2="0" y2="0">${stops}</linearGradient></defs>` +
      `<rect x="${w - 26}" y="24" width="10" height="96" fill="url(#${id})" rx="2"/>` +
      `<text x="${w - 32}" y="30" fill="${esc(ink)}" ${font} font-size="10" text-anchor="end" opacity="0.8">${esc(fmtNum(lg.max ?? 0))}</text>` +
      `<text x="${w - 32}" y="122" fill="${esc(ink)}" ${font} font-size="10" text-anchor="end" opacity="0.8">${esc(fmtNum(lg.min ?? 0))}</text>` +
      (lg.title ? `<text x="12" y="20" fill="${esc(ink)}" ${font} font-size="11" opacity="0.8">${esc(lg.title)}</text>` : '')
  } else if (lg && lg.items?.length) {
    lg.items.slice(0, 6).forEach((it, i) => {
      const y = 24 + i * 16
      out += `<rect x="${w - 26}" y="${y}" width="10" height="10" fill="${esc(it.color)}" rx="2"/>` +
        `<text x="${w - 32}" y="${y + 9}" fill="${esc(ink)}" ${font} font-size="10" text-anchor="end" opacity="0.8">${esc(it.label)}</text>`
    })
  }
  return out
}

// --- GL (browser only) ------------------------------------------------------

// GLSL ES 3.00. `#version` MUST be the very first characters of the source, so
// these template literals open on it with no leading newline.
const MESH_VS = `#version 300 es
precision highp float;
in vec3 a_pos;
in vec3 a_normal;
in vec3 a_color;
uniform mat4 u_vp;
uniform vec3 u_light;
uniform float u_ambient;
uniform float u_lit;
out vec3 v_color;
void main() {
  // transliterated from shade() — the two must not disagree
  float d = max(0.0, dot(a_normal, u_light));
  float sky = 0.55 + 0.45 * a_normal.y;
  float s = min(1.0, u_ambient * sky + (1.0 - u_ambient) * d);
  v_color = mix(a_color, a_color * s, u_lit);
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`

const MESH_FS = `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 fragColor;
void main() { fragColor = vec4(v_color, 1.0); }`

// One vertex per row. A real sphere per point would be ~80 vertices each, so a
// 100k-row scatter is 8M vertices instead of 100k — the impostor is what makes
// the scatter the size of its data rather than eighty times it.
const POINT_VS = `#version 300 es
precision highp float;
in vec3 a_pos;
in vec3 a_color;
in float a_size;
uniform mat4 u_vp;
uniform float u_pscale;
out vec3 v_color;
void main() {
  v_color = a_color;
  gl_Position = u_vp * vec4(a_pos, 1.0);
  // gl_Position.w is the view-space distance for a perspective matrix, so this
  // is the true projected diameter of a sphere of world radius a_size. Clamped
  // because drivers cap gl_PointSize and SILENTLY DROP points that exceed it.
  gl_PointSize = clamp(a_size * u_pscale / max(0.0001, gl_Position.w), 1.5, 96.0);
}`

const POINT_FS = `#version 300 es
precision highp float;
in vec3 v_color;
uniform vec3 u_lightv;
uniform float u_ambient;
out vec4 fragColor;
void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(pc, pc);
  // A hard cut, not a blended edge: blending would need the points sorted
  // back-to-front every frame and would still be wrong where they overlap.
  if (r2 > 1.0) discard;
  // gl_PointCoord counts DOWN, so y is negated to make +Y up.
  vec3 n = vec3(pc.x, -pc.y, sqrt(max(0.0, 1.0 - r2)));
  float d = max(0.0, dot(n, u_lightv));
  float sky = 0.55 + 0.45 * n.y;
  float s = min(1.0, u_ambient * sky + (1.0 - u_ambient) * d);
  fragColor = vec4(v_color * s, 1.0);
}`

export interface Viz3dOpts {
  background?: string
  /** spin gently. Off by default: a dashboard of auto-rotating tiles is a
   *  laptop fan, and motion the reader did not ask for. */
  autoRotate?: boolean
  azimuth?: number
  elevation?: number
  /** point radius as a fraction of the scene radius */
  pointScale?: number
}

/**
 * Pointer control shared by BOTH paths, so the fallback drags exactly like GL
 * does. One pointer rotates (shift or the right button pans); two pinch and
 * pan, because `touch-action: none` is required for the first and disables the
 * browser's own pinch along with it.
 */
function orbitControls(el: HTMLElement, orb: Orbit, changed: () => void): () => void {
  const pts = new Map<number, { x: number; y: number }>()
  let spread = 0

  const centreOf = (): { x: number; y: number; d: number } => {
    const l = [...pts.values()]
    const x = l.reduce((a, p) => a + p.x, 0) / l.length
    const y = l.reduce((a, p) => a + p.y, 0) / l.length
    const d = l.length > 1 ? Math.hypot(l[0].x - l[1].x, l[0].y - l[1].y) : 0
    return { x, y, d }
  }

  const down = (e: PointerEvent) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    spread = centreOf().d
    el.setPointerCapture?.(e.pointerId)
  }
  const move = (e: PointerEvent) => {
    const was = pts.get(e.pointerId)
    if (!was) return
    const dx = e.clientX - was.x
    const dy = e.clientY - was.y
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pts.size >= 2) {
      const now = centreOf()
      if (spread > 0 && now.d > 0) orb.zoom(spread / now.d)
      spread = now.d
      orb.pan(dx / 2, dy / 2)
    } else if (e.shiftKey || e.buttons === 2 || e.buttons === 4) {
      orb.pan(dx, dy)
    } else {
      orb.rotate(dx, dy)
    }
    changed()
  }
  const up = (e: PointerEvent) => {
    pts.delete(e.pointerId)
    spread = pts.size > 1 ? centreOf().d : 0
    el.releasePointerCapture?.(e.pointerId)
  }
  // preventDefault so the page behind a tile does not scroll away under the
  // gesture. A 3D view that does not zoom on the wheel is the bigger surprise.
  const wheel = (e: WheelEvent) => {
    e.preventDefault()
    orb.zoom(Math.exp(clamp(e.deltaY, -120, 120) * 0.0016))
    changed()
  }
  const menu = (e: Event) => e.preventDefault()

  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  el.addEventListener('wheel', wheel, { passive: false })
  el.addEventListener('contextmenu', menu)
  return () => {
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    el.removeEventListener('wheel', wheel)
    el.removeEventListener('contextmenu', menu)
  }
}

function mountFallback(host: HTMLElement, scene: Scene, opts: Viz3dOpts): () => void {
  const box = document.createElement('div')
  box.className = 'dash-viz3d dash-viz3d-2d'
  box.style.cssText = 'width:100%;height:100%;touch-action:none;user-select:none'
  host.appendChild(box)

  const cam = frameCamera(scene, opts)
  let raf = 0
  const paint = () => {
    raf = 0
    cam.height = box.clientHeight || 420
    box.innerHTML = fallbackSvg(scene, box.clientWidth || 640, box.clientHeight || 420, {
      camera: cam, background: opts.background,
    })
  }
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(paint)
  }
  paint()

  const detach = scene.empty ? () => {} : orbitControls(box, cam, schedule)
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
  ro?.observe(box)
  return () => {
    if (raf) cancelAnimationFrame(raf)
    detach()
    ro?.disconnect()
    box.remove()
  }
}

/**
 * Mount a scene into a host element. Returns a teardown.
 *
 * THE LOOP IDLES. A frame is scheduled only when something changed — a drag, a
 * wheel, a resize, a context restore — and `draw` clears the flag rather than
 * re-arming it. A permanent requestAnimationFrame loop is the default shape of
 * every 3D example on the web and it is wrong here: a dashboard holds several
 * tiles, none of them are moving, and between them they would keep the GPU and
 * the compositor awake for as long as the file is open. `autoRotate` is the one
 * case that re-arms, and it is opt-in.
 */
export function mountViz3d(host: HTMLElement, scene: Scene, opts: Viz3dOpts = {}): () => void {
  host.textContent = ''
  if (scene.empty || !supportsWebGL2()) return mountFallback(host, scene, opts)

  const canvas = document.createElement('canvas')
  // `touch-action:none` so a one-finger drag orbits instead of scrolling the
  // page; `user-select:none` because an orbit drag that runs off the canvas
  // otherwise selects the surrounding page text and leaves it highlighted.
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;user-select:none'
  host.appendChild(canvas)
  const view = new GLView(canvas)
  // supportsWebGL2() can be TRUE while this particular context fails: browsers
  // cap live contexts at about 16, and a dashboard that swaps tiles reaches it.
  // Falling back to the SVG is much better than a blank canvas.
  if (!view.ok) {
    view.dispose()
    canvas.remove()
    return mountFallback(host, scene, opts)
  }

  const meshProg = view.compile(MESH_VS, MESH_FS)
  const pointProg = view.compile(POINT_VS, POINT_FS)
  const bufs = scene.meshes.map((m) => ({
    m,
    pos: view.buffer(m.positions),
    col: view.buffer(m.colors),
    nrm: m.normals ? view.buffer(m.normals) : null,
    siz: m.sizes ? view.buffer(m.sizes) : null,
    idx: m.indices ? view.buffer(m.indices, { index: true }) : null,
  }))

  const cam = frameCamera(scene, opts)
  const bg = hexToRgb(opts.background ?? '#0E1420')
  const pointRadius = scene.radius * (opts.pointScale ?? 0.022)
  let raf = 0

  const draw = () => {
    raf = 0
    view.resize()
    cam.height = canvas.clientHeight || 420
    const vp = cam.matrix(view.aspect)
    const lightView = dirToView(cam.view(), LIGHT)
    const pscale = (2 * pointRadius * canvas.height * 0.5) / Math.tan(cam.fovY / 2)
    view.clear(bg[0], bg[1], bg[2], 1)
    for (const b of bufs) {
      if (b.m.mode === 'points') {
        view.draw({
          program: pointProg,
          attribs: {
            a_pos: { buffer: b.pos, size: 3 },
            a_color: { buffer: b.col, size: 3 },
            ...(b.siz ? { a_size: { buffer: b.siz, size: 1 } } : {}),
          },
          uniforms: { u_vp: vp, u_pscale: pscale, u_lightv: lightView, u_ambient: AMBIENT },
          count: b.m.positions.length / 3,
          mode: 'points',
        })
        continue
      }
      view.draw({
        program: meshProg,
        attribs: {
          a_pos: { buffer: b.pos, size: 3 },
          a_color: { buffer: b.col, size: 3 },
          ...(b.nrm ? { a_normal: { buffer: b.nrm, size: 3 } } : {}),
        },
        uniforms: { u_vp: vp, u_light: LIGHT, u_ambient: AMBIENT, u_lit: b.m.lit ? 1 : 0 },
        count: b.idx ? b.m.indices!.length : b.m.positions.length / 3,
        mode: b.m.mode,
        ...(b.idx ? { index: b.idx } : {}),
      })
    }
    if (opts.autoRotate) { cam.rotate(-0.4, 0); schedule() }
  }
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(draw)
  }

  view.onRestore = schedule
  view.onLost = () => { if (raf) { cancelAnimationFrame(raf); raf = 0 } }
  const detach = orbitControls(canvas, cam, schedule)
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
  ro?.observe(canvas)
  schedule()

  return () => {
    if (raf) cancelAnimationFrame(raf)
    detach()
    ro?.disconnect()
    view.dispose()
    canvas.remove()
  }
}

export const _internals = {
  categorise, aggregateGrid, scaler, norm01, sizeFor, sphereMesh, frameMesh, boundsOf,
  num, fmtNum, SIZE_MIN, SIZE_MAX, AXIS_MAX_SURFACE, AXIS_MAX_BARS, DEFAULT_BINS,
  SVG_MAX_TRIS, SVG_MAX_POINTS, BOX_FACES, esc,
}
