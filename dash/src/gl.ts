// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A minimal WebGL2 layer: the maths, and a thin wrapper over the context.
//
// WHY HAND-ROLLED. three.js is 600 KB+ minified; this shell is 43 KB
// compressed in total. A project that deleted ECharts for being 47% of the
// file and refused DuckDB-WASM at 9.4 MB cannot then ship a renderer twelve
// times the size of the app to draw points and boxes. What a data viewer
// actually needs is one camera, one projection, buffers of floats, and a
// draw call — measured here at 8.8 KB minified, 3.7 KB deflated standalone
// (less in-shell, where it shares a compression dictionary with the rest of
// the bundle). That is 0.6% of three.js. Everything else in a scene graph
// (materials, loaders, lights, raycasters, a whole node hierarchy) is weight
// with no reader-visible return.
//
// THE MATHS IS PURE AND THE GL IS NOT. Every function above `GLView` runs in
// node with no DOM, which is why the rig can test the camera at all — the
// bugs that matter (a transposed multiply, a flipped screen y, a gimbal flip
// at the pole) are arithmetic, and arithmetic is testable. Below `GLView`
// nothing is testable in node, so that part is kept as small and as boring as
// it can be.
//
// COLUMN-MAJOR, LIKE GL. `m[col * 4 + row]`, so a Mat4 goes straight into
// `uniformMatrix4fv(loc, false, m)` with no transpose. Row-major storage plus
// `transpose = true` is a legal alternative that WebGL1 did not support and
// that every shader author then has to remember; one convention, matching the
// platform's, is cheaper than being clever.
//
// FLOAT64 FOR THE MATHS, FLOAT32 AT THE BOUNDARY. Data ranges in a dashboard
// are not tidy (timestamps in ms, revenue in pence): f32 has 24 bits of
// mantissa and a camera composed of five f32 matrices visibly jitters at those
// magnitudes. The conversion happens once per uniform per frame in `setUniform`
// — note that `uniformMatrix4fv` REJECTS a Float64Array outright, so the copy
// is not optional anyway.

// --- vectors ----------------------------------------------------------------

export type Vec3 = [number, number, number]

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])

/** Vec3 scale. Named `vscale` because `scale` is the Mat4 builder; see `V3`. */
export const vscale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]

/**
 * A zero-length vector normalises to ZERO, not to NaN. Anything else and one
 * degenerate camera vector turns every projected point into NaN, the scene
 * silently disappears, and nothing in the console says why — a viewer that
 * draws nothing is a better failure than a viewer that draws garbage.
 */
export function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2])
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]
}

/** The Vec3 ops under their plain names, for `V3.scale` / `V3.length`. */
export const V3 = { add, sub, scale: vscale, dot, cross, normalize, length }

// --- matrices ---------------------------------------------------------------

export type Mat4 = Float64Array

export function identity(): Mat4 {
  const m = new Float64Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

/**
 * The matrix product A·B — so `multiply(a, b)` applies **b first**, exactly as
 * the maths reads when a point is a column vector on the right: `(A·B)·v`.
 * Getting this backwards is the classic transposed-multiply bug, and it is
 * invisible against the identity matrix (I is symmetric); the rig pins it with
 * a translate/rotate pair, which do not commute.
 */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16)
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3]
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3
    }
  }
  return o
}

/**
 * Right-handed perspective, clip depth in [-1, +1] — the GL convention, not
 * D3D's [0, 1]. `fovY` is in RADIANS (degrees here would be a silent 57x error
 * that still renders something).
 */
export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2)
  const nf = 1 / (near - far)
  const m = new Float64Array(16)
  m[0] = f / aspect
  m[5] = f
  m[10] = (far + near) * nf
  m[11] = -1
  m[14] = 2 * far * near * nf
  return m
}

/**
 * The view matrix for a camera at `eye` looking at `target`.
 *
 * The `up` vector is nudged when it is parallel to the view direction. Orbit
 * clamps its elevation so it can never ask for that, but lookAt is public and
 * "look straight down" is the first thing anyone tries; without the nudge the
 * cross product is zero, the basis is NaN, and the failure surfaces three
 * frames later as an empty canvas.
 */
export function lookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Mat4 {
  const z = normalize(sub(eye, target))          // camera backward
  let x = cross(up, z)
  if (Math.hypot(x[0], x[1], x[2]) < 1e-8) {
    // up ∥ view: pick any other axis to build the basis from
    x = cross(Math.abs(z[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0], z)
  }
  x = normalize(x)
  const y = cross(z, x)
  const m = new Float64Array(16)
  m[0] = x[0]; m[1] = y[0]; m[2] = z[0]
  m[4] = x[1]; m[5] = y[1]; m[6] = z[1]
  m[8] = x[2]; m[9] = y[2]; m[10] = z[2]
  m[12] = -dot(x, eye); m[13] = -dot(y, eye); m[14] = -dot(z, eye)
  m[15] = 1
  return m
}

/** Builders, not mutators: compose with `multiply`, which keeps the order visible. */
export function translate(v: Vec3): Mat4 {
  const m = identity()
  m[12] = v[0]; m[13] = v[1]; m[14] = v[2]
  return m
}

export function scale(v: Vec3 | number): Mat4 {
  const s: Vec3 = typeof v === 'number' ? [v, v, v] : v
  const m = new Float64Array(16)
  m[0] = s[0]; m[5] = s[1]; m[10] = s[2]; m[15] = 1
  return m
}

export function rotateX(rad: number): Mat4 {
  const c = Math.cos(rad), s = Math.sin(rad), m = identity()
  m[5] = c; m[6] = s; m[9] = -s; m[10] = c
  return m
}

export function rotateY(rad: number): Mat4 {
  const c = Math.cos(rad), s = Math.sin(rad), m = identity()
  m[0] = c; m[2] = -s; m[8] = s; m[10] = c
  return m
}

export function rotateZ(rad: number): Mat4 {
  const c = Math.cos(rad), s = Math.sin(rad), m = identity()
  m[0] = c; m[1] = s; m[4] = -s; m[5] = c
  return m
}

/**
 * Transform a POINT (w = 1) and divide through by w, so this unprojects as
 * well as it projects — feed it `invert(viewProjection)` and an NDC point and
 * you get the world ray's position back. A direction vector must NOT go
 * through here: it has w = 0 and wants the upper 3x3 only.
 */
export function transformPoint(m: Mat4, v: Vec3): Vec3 {
  const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12]
  const y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13]
  const z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]
  const w = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15]
  // w === 0 is a point on the eye plane; return it undivided rather than
  // manufacturing infinities the caller will plot at the edge of the screen.
  return w === 0 || w === 1 ? [x, y, z] : [x / w, y / w, z / w]
}

/**
 * The 4x4 inverse (cofactor expansion), or NULL when the matrix is singular.
 *
 * Null rather than identity: a zero-scaled or otherwise collapsed matrix has
 * no inverse, and handing back the identity would let a hit-test quietly
 * report world coordinates that are really screen coordinates.
 */
export function invert(a: Mat4): Mat4 | null {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3]
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7]
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11]
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15]

  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det || !Number.isFinite(det)) return null
  det = 1 / det

  const o = new Float64Array(16)
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det
  return o
}

/**
 * World → screen pixels, for labels and hit-testing.
 *
 * `y` is flipped: NDC counts up from the bottom, CSS counts down from the top,
 * and a viewer that forgets renders every label mirrored about the horizon —
 * which looks plausible on a symmetric scatter plot and is why the rig asserts
 * the number, not just the sign.
 *
 * CHECK `z` BEFORE DRAWING. A point BEHIND the camera has a negative clip w,
 * so x/y come back mirrored into the visible screen — a label for something
 * behind you, in the wrong place. Such a point always lands at `z > 1`, so the
 * one test `-1 <= z && z <= 1` rejects both the behind-camera case and points
 * beyond the far plane.
 */
export function project(vp: Mat4, p: Vec3, w: number, h: number): { x: number; y: number; z: number } {
  const cx = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]
  const cy = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]
  const cz = vp[2] * p[0] + vp[6] * p[1] + vp[10] * p[2] + vp[14]
  const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15]
  if (cw === 0) return { x: NaN, y: NaN, z: Infinity }   // exactly on the eye plane
  const iw = 1 / cw
  return {
    x: (cx * iw * 0.5 + 0.5) * w,
    y: (0.5 - cy * iw * 0.5) * h,
    z: cz * iw,
  }
}

// --- camera -----------------------------------------------------------------

const UP: Vec3 = [0, 1, 0]

/**
 * Elevation stops JUST short of the pole. At exactly ±90° the view direction
 * is parallel to `up`, `cross(up, forward)` is the zero vector, and the camera
 * basis is NaN — in practice the scene flips upside down for one frame and
 * then vanishes. Every hand-rolled orbit control has shipped this bug once.
 *
 * 1e-4 rad is 0.006° — no one can see the camera stop short, and it leaves the
 * cross product a magnitude of 1e-4, which is enormous in float64.
 */
const MAX_EL = Math.PI / 2 - 1e-4

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
/** Keep an angle in [-π, π] so a long session cannot accumulate a huge azimuth. */
const wrapPi = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI))

/**
 * The orbit camera: spherical position around a target, which is what every 3D
 * data view wants (there is nothing to walk through, only something to look at
 * from all sides). Angles in radians, drag deltas in CSS pixels.
 *
 * Drags follow the POINTER, not the camera: dragging right turns the model to
 * the right, which means the camera azimuth goes the other way.
 */
export class Orbit {
  azimuth = 0
  elevation = 0.4
  distance = 5
  target: Vec3 = [0, 0, 0]
  fovY = Math.PI / 4
  near = 0.1
  far = 1000
  /** Distance never reaches 0: lookAt of a zero-length forward is NaN. */
  minDistance = 0.05
  maxDistance = 5000
  rotateSpeed = 0.008
  /** Viewport height in CSS px. Set it on resize — pan only tracks the pointer
   *  1:1 if this matches the canvas the drag happened on. */
  height = 600

  rotate(dx: number, dy: number): void {
    this.azimuth = wrapPi(this.azimuth - dx * this.rotateSpeed)
    this.elevation = clamp(this.elevation + dy * this.rotateSpeed, -MAX_EL, MAX_EL)
  }

  /** `f < 1` moves in. A non-positive factor is ignored — it would put the
   *  camera at the target, or pull it through to the other side. */
  zoom(f: number): void {
    if (!(f > 0)) return
    this.distance = clamp(this.distance * f, this.minDistance, this.maxDistance)
  }

  /**
   * Slide the target in the screen plane. The pixel→world scale is the world
   * height visible at the target's depth divided by the viewport height, so
   * the model stays stuck to the pointer at every zoom level; a fixed constant
   * here is the "panning is too fast when zoomed in" complaint.
   */
  pan(dx: number, dy: number): void {
    const k = (2 * this.distance * Math.tan(this.fovY / 2)) / Math.max(1, this.height)
    const fwd = normalize(sub(this.target, this.eye()))
    const right = normalize(cross(fwd, UP))
    const up = cross(right, fwd)
    this.target = add(this.target, add(vscale(right, -dx * k), vscale(up, dy * k)))
  }

  eye(): Vec3 {
    const ce = Math.cos(this.elevation), se = Math.sin(this.elevation)
    const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth)
    const [tx, ty, tz] = this.target
    const d = this.distance
    return [tx + d * ce * sa, ty + d * se, tz + d * ce * ca]
  }

  view(): Mat4 {
    return lookAt(this.eye(), this.target, UP)
  }

  /** view-projection, ready for a shader's `u_vp`. */
  matrix(aspect: number): Mat4 {
    return multiply(perspective(this.fovY, aspect || 1, this.near, this.far), this.view())
  }
}

// --- GL (browser only) ------------------------------------------------------

let webgl2Probe: boolean | undefined

/**
 * Whether WebGL2 exists at all. Decides the 2D fallback (`Tile.fallback`), so
 * it must answer FALSE rather than throw where there is no DOM — node runs the
 * rigs, and the shell's static preview renders with scripts off.
 */
export function supportsWebGL2(): boolean {
  if (webgl2Probe !== undefined) return webgl2Probe
  webgl2Probe = false
  try {
    if (typeof document === 'undefined') return webgl2Probe
    webgl2Probe = !!document.createElement('canvas').getContext('webgl2')
  } catch {
    webgl2Probe = false
  }
  return webgl2Probe
}

export type UniformValue = number | boolean | number[] | Float32Array | Float64Array

/** A compiled program. Keeps its SOURCE so a lost context can rebuild it. */
export class GLProgram {
  vs: string
  fs: string
  p: WebGLProgram | null = null
  u = new Map<string, WebGLUniformLocation | null>()
  a = new Map<string, number>()
  constructor(vs: string, fs: string) { this.vs = vs; this.fs = fs }
}

/**
 * A GPU buffer. Holds a REFERENCE to the caller's typed array (not a copy) —
 * that is what makes a context restore possible, since GPU memory cannot be
 * read back cheaply, and it costs nothing when the caller keeps the array
 * anyway (which a data app does: it is a column).
 */
export class GLBuffer {
  data: ArrayBufferView
  index: boolean
  dynamic: boolean
  b: WebGLBuffer | null = null
  constructor(data: ArrayBufferView, index: boolean, dynamic: boolean) {
    this.data = data; this.index = index; this.dynamic = dynamic
  }
}

export interface Attrib {
  buffer: GLBuffer
  /** components per vertex, 1..4 */
  size: number
  /** bytes; 0 = tightly packed */
  stride?: number
  offset?: number
  /** 1 = one value per INSTANCE rather than per vertex */
  divisor?: number
}

export interface DrawOpts {
  program: GLProgram
  attribs: Record<string, Attrib>
  uniforms?: Record<string, UniformValue>
  /** vertices, or indices when `index` is given */
  count: number
  instances?: number
  mode?: 'triangles' | 'triangle-strip' | 'lines' | 'line-strip' | 'points'
  index?: GLBuffer
  /** default true */
  depth?: boolean
  /** default false; premultiplied-alpha-free src-alpha blending */
  blend?: boolean
}

/**
 * The whole GL surface: compile, buffer, draw, resize, dispose.
 *
 * CONTEXT LOSS IS A NORMAL EVENT, not an error — a laptop waking from sleep,
 * a GPU driver reset, a background tab reclaimed on mobile. The browser hands
 * back a context whose every program and buffer handle is dead. Because this
 * class remembers the shader source and the buffer data, restore is a rebuild
 * and a redraw; the alternative, and what most small wrappers do, is a canvas
 * that is simply blank forever with nothing in the console.
 */
export class GLView {
  canvas: HTMLCanvasElement
  gl: WebGL2RenderingContext | null = null
  /** Called after the context comes back and everything is rebuilt: redraw here. */
  onRestore: (() => void) | null = null
  /** Called when the context is lost: stop the animation loop here. */
  onLost: (() => void) | null = null

  private programs: GLProgram[] = []
  private buffers: GLBuffer[] = []
  private disposed = false
  private f32 = new Float32Array(16)
  // Bound once and kept, because removeEventListener needs the SAME function
  // object — a fresh `this.handle.bind(this)` at removal time silently removes
  // nothing and leaves the view alive after dispose().
  private lost = (e: Event) => {
    // Without preventDefault the browser never fires `webglcontextrestored`.
    // This one line is the difference between recovering and not.
    e.preventDefault()
    this.gl = null
    for (const p of this.programs) { p.p = null; p.u.clear(); p.a.clear() }
    for (const b of this.buffers) b.b = null
    this.onLost?.()
  }
  private restored = () => {
    if (this.disposed) return
    this.gl = this.canvas.getContext('webgl2', CTX_ATTRS)
    if (!this.gl) return
    for (const p of this.programs) this.link(p)
    for (const b of this.buffers) this.upload(b)
    this.resize()
    this.onRestore?.()
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.gl = canvas.getContext('webgl2', CTX_ATTRS)
    canvas.addEventListener('webglcontextlost', this.lost)
    canvas.addEventListener('webglcontextrestored', this.restored)
  }

  get ok(): boolean { return !!this.gl && !this.gl.isContextLost() }
  get aspect(): number { return this.canvas.width / Math.max(1, this.canvas.height) }

  compile(vs: string, fs: string): GLProgram {
    const p = new GLProgram(vs, fs)
    this.programs.push(p)
    this.link(p)
    return p
  }

  buffer(data: ArrayBufferView, opts?: { index?: boolean; dynamic?: boolean }): GLBuffer {
    const b = new GLBuffer(data, !!opts?.index, !!opts?.dynamic)
    this.buffers.push(b)
    this.upload(b)
    return b
  }

  /** Replace a buffer's contents (and the copy kept for context restore). */
  update(buf: GLBuffer, data: ArrayBufferView): void {
    buf.data = data
    this.upload(buf)
  }

  clear(r = 0, g = 0, b = 0, a = 0): void {
    const gl = this.gl
    if (!gl) return
    gl.clearColor(r, g, b, a)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  }

  draw(o: DrawOpts): void {
    const gl = this.gl
    const prog = o.program.p
    if (!gl || !prog) return          // lost context: skip the frame, restore redraws
    gl.useProgram(prog)

    if (o.depth === false) gl.disable(gl.DEPTH_TEST)
    else { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL) }
    if (o.blend) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA) }
    else gl.disable(gl.BLEND)

    const bound: number[] = []
    for (const name in o.attribs) {
      const at = o.attribs[name]
      let loc = o.program.a.get(name)
      if (loc === undefined) { loc = gl.getAttribLocation(prog, name); o.program.a.set(name, loc) }
      if (loc < 0 || !at.buffer.b) continue
      gl.bindBuffer(gl.ARRAY_BUFFER, at.buffer.b)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, at.size, gl.FLOAT, false, at.stride ?? 0, at.offset ?? 0)
      if (at.divisor) gl.vertexAttribDivisor(loc, at.divisor)
      bound.push(loc)
    }

    if (o.uniforms) for (const name in o.uniforms) this.setUniform(o.program, name, o.uniforms[name])

    const mode = MODES(gl)[o.mode ?? 'triangles']
    if (o.index && o.index.b) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, o.index.b)
      const t = o.index.data instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT
      if (o.instances) gl.drawElementsInstanced(mode, o.count, t, 0, o.instances)
      else gl.drawElements(mode, o.count, t, 0)
    } else if (o.instances) {
      gl.drawArraysInstanced(mode, 0, o.count, o.instances)
    } else {
      gl.drawArrays(mode, 0, o.count)
    }

    // Reset what we touched. A divisor left on an attribute LOCATION outlives
    // the program that set it (there is one default VAO), so the next draw
    // reusing location 2 renders one vertex per instance and looks like a
    // corrupt buffer rather than a leaked state bit.
    for (const loc of bound) { gl.vertexAttribDivisor(loc, 0); gl.disableVertexAttribArray(loc) }
  }

  /**
   * Match the drawing buffer to the CSS box. DPR is capped at 2: a 3x phone
   * screen triples the fragment count for a difference invisible on a scatter
   * plot, and on a large canvas it is the difference between 60fps and not.
   * Returns whether anything changed, so a caller can skip a redraw.
   */
  resize(): boolean {
    const c = this.canvas
    const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2)
    const w = Math.max(1, Math.round((c.clientWidth || c.width) * dpr))
    const h = Math.max(1, Math.round((c.clientHeight || c.height) * dpr))
    if (c.width === w && c.height === h) return false
    c.width = w; c.height = h
    this.gl?.viewport(0, 0, w, h)
    return true
  }

  dispose(): void {
    this.disposed = true
    this.canvas.removeEventListener('webglcontextlost', this.lost)
    this.canvas.removeEventListener('webglcontextrestored', this.restored)
    const gl = this.gl
    if (gl) {
      for (const p of this.programs) if (p.p) gl.deleteProgram(p.p)
      for (const b of this.buffers) if (b.b) gl.deleteBuffer(b.b)
      // Free the GPU allocation now rather than at the next GC: a dashboard
      // swaps tiles, and a handful of orphaned contexts hits the browser's
      // hard limit (~16), at which point the OLDEST live context is killed —
      // i.e. a tile the reader is still looking at goes blank. The listeners
      // came off above, so this deliberate loss cannot re-enter the handler.
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    this.programs = []
    this.buffers = []
    this.gl = null
    this.onRestore = null
    this.onLost = null
  }

  // --- internals ---

  private link(p: GLProgram): void {
    const gl = this.gl
    if (!gl) return
    const vs = this.shader(gl.VERTEX_SHADER, p.vs)
    const fs = this.shader(gl.FRAGMENT_SHADER, p.fs)
    const prog = gl.createProgram()
    if (!prog || !vs || !fs) return
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    // A failed link yields a program that draws NOTHING and reports no error
    // anywhere; throwing is the only way the mistake reaches whoever made it.
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog)
      gl.deleteProgram(prog)
      throw new Error(`shader link failed: ${log}`)
    }
    p.p = prog
    p.u.clear()
    p.a.clear()
  }

  private shader(type: number, src: string): WebGLShader | null {
    const gl = this.gl!
    const s = gl.createShader(type)
    if (!s) return null
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s)
      gl.deleteShader(s)
      throw new Error(`shader compile failed: ${log}`)
    }
    return s
  }

  private upload(b: GLBuffer): void {
    const gl = this.gl
    if (!gl) return
    if (!b.b) b.b = gl.createBuffer()
    if (!b.b) return
    const target = b.index ? gl.ELEMENT_ARRAY_BUFFER : gl.ARRAY_BUFFER
    gl.bindBuffer(target, b.b)
    gl.bufferData(target, b.data, b.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW)
  }

  private setUniform(p: GLProgram, name: string, v: UniformValue): void {
    const gl = this.gl!
    let loc = p.u.get(name)
    if (loc === undefined) { loc = gl.getUniformLocation(p.p!, name); p.u.set(name, loc) }
    // null = the compiler optimised it away because nothing reads it. Normal,
    // not an error: shaders get edited and uniforms outlive their use.
    if (loc === null) return
    if (typeof v === 'number') { gl.uniform1f(loc, v); return }
    if (typeof v === 'boolean') { gl.uniform1i(loc, v ? 1 : 0); return }
    switch (v.length) {
      case 1: gl.uniform1f(loc, v[0]); return
      case 2: gl.uniform2f(loc, v[0], v[1]); return
      case 3: gl.uniform3f(loc, v[0], v[1], v[2]); return
      case 4: gl.uniform4f(loc, v[0], v[1], v[2], v[3]); return
      case 16: {
        // Our matrices are Float64Array, which uniformMatrix4fv rejects.
        const s = this.f32
        for (let i = 0; i < 16; i++) s[i] = v[i]
        gl.uniformMatrix4fv(loc, false, s)
        return
      }
    }
  }
}

// `preserveDrawingBuffer` stays OFF: it costs a full copy every frame, and the
// only thing it buys is toDataURL() at an arbitrary later moment. Snapshot by
// drawing and reading pixels in the SAME turn instead.
const CTX_ATTRS: WebGLContextAttributes = {
  alpha: true,
  antialias: true,
  depth: true,
  preserveDrawingBuffer: false,
}

// GL enum values only exist on a live context, so this is a function, not a
// module-level table — a table would need the WebGL2RenderingContext global,
// which does not exist in node and would break importing this file at all.
const MODES = (gl: WebGL2RenderingContext) => ({
  triangles: gl.TRIANGLES,
  'triangle-strip': gl.TRIANGLE_STRIP,
  lines: gl.LINES,
  'line-strip': gl.LINE_STRIP,
  points: gl.POINTS,
})
