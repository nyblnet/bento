// Bento's animation engine — the in-house replacement for GSAP, sized to
// exactly what the presenter and editor use:
//   anim.to / anim.fromTo(target, vars) with channels:
//     opacity, y (translate px), scale, color, strokeDashoffset,
//     attr: { fill, stop-color, offset, x1..y2, … }  (colors interpolate),
//     motionPath: { path }  (translate along an SVG path, relative),
//     plain numeric props on non-element targets (countUp state objects)
//   vars: duration (s), delay (s), ease ('none'|'linear'|'power1..3.in/out/
//         inOut'|'sine.inOut'), repeat (-1 = forever), yoyo, transformOrigin,
//         onUpdate, onComplete
//   anim.killTweensOf(target | targets), anim.getTweensOf(target) → .progress()
//   anim.setTimeScale(n) and manual clock (anim.manual/tick) for tests.
//
// Transform channels (y/scale/motionPath) compose through a per-element
// registry and PRESERVE the model's rotate() applied by applyElementFrame.

type EaseFn = (t: number) => number

const pow = (n: number) => ({
  in: (t: number) => t ** n,
  out: (t: number) => 1 - (1 - t) ** n,
  inOut: (t: number) => (t < 0.5 ? (2 * t) ** n / 2 : 1 - (2 - 2 * t) ** n / 2),
})

const EASES: Record<string, EaseFn> = {
  none: (t) => t,
  linear: (t) => t,
  'power1.in': pow(2).in, 'power1.out': pow(2).out, 'power1.inOut': pow(2).inOut,
  'power2.in': pow(3).in, 'power2.out': pow(3).out, 'power2.inOut': pow(3).inOut,
  'power3.in': pow(4).in, 'power3.out': pow(4).out, 'power3.inOut': pow(4).inOut,
  'sine.in': (t) => 1 - Math.cos((t * Math.PI) / 2),
  'sine.out': (t) => Math.sin((t * Math.PI) / 2),
  'sine.inOut': (t) => -(Math.cos(Math.PI * t) - 1) / 2,
}

// --- color + number interpolation --------------------------------------------

const parseColor = (v: string): [number, number, number, number] | null => {
  const m = v?.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const p = m[1].split(/[\s,/]+/).map(Number)
    return [p[0] || 0, p[1] || 0, p[2] || 0, Number.isFinite(p[3]) ? p[3] : 1]
  }
  let hex = (v ?? '').trim()
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) hex = '#' + [...hex.slice(1)].map((c) => c + c).join('')
  if (/^#[0-9a-fA-F]{6,8}$/.test(hex)) {
    return [
      parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
      hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1,
    ]
  }
  if (v === 'transparent' || v === 'none') return [0, 0, 0, 0]
  return null
}

const mixColor = (a: [number, number, number, number], b: [number, number, number, number], t: number) =>
  `rgba(${Math.round(a[0] + (b[0] - a[0]) * t)}, ${Math.round(a[1] + (b[1] - a[1]) * t)}, ${Math.round(
    a[2] + (b[2] - a[2]) * t,
  )}, ${Math.round((a[3] + (b[3] - a[3]) * t) * 1000) / 1000})`

/** value-pair → interpolator string|number */
function lerper(from: unknown, to: unknown): (t: number) => string | number {
  if (typeof from === 'number' && typeof to === 'number') return (t) => from + (to - from) * t
  const fc = parseColor(String(from))
  const tc = parseColor(String(to))
  if (fc && tc) return (t) => mixColor(fc, tc, t)
  const fn = parseFloat(String(from))
  const tn = parseFloat(String(to))
  if (Number.isFinite(fn) && Number.isFinite(tn)) return (t) => fn + (tn - fn) * t
  return (t) => (t < 1 ? String(from) : String(to))
}

// --- element transform composition --------------------------------------------

interface XForm { x: number; y: number; scaleX: number; scaleY: number; baseRotate: string }
const xforms = new WeakMap<Element, XForm>()

function xformOf(el: HTMLElement | SVGElement): XForm {
  let x = xforms.get(el)
  if (!x) {
    // preserve whatever rotate() the model frame applied (origin: center)
    const m = (el.style.transform ?? '').match(/rotate\([^)]*\)/)
    x = { x: 0, y: 0, scaleX: 1, scaleY: 1, baseRotate: m ? m[0] : '' }
    xforms.set(el, x)
  }
  return x
}

function writeXform(el: HTMLElement | SVGElement) {
  const x = xformOf(el)
  const parts: string[] = []
  if (x.x || x.y) parts.push(`translate(${x.x}px, ${x.y}px)`)
  if (x.baseRotate) parts.push(x.baseRotate)
  if (x.scaleX !== 1 || x.scaleY !== 1) parts.push(`scale(${x.scaleX}, ${x.scaleY})`)
  el.style.transform = parts.join(' ')
}

/** applyElementFrame resets style.transform — forget our composition state. */
export function resetXform(el: Element) {
  xforms.delete(el)
}

// --- motion path sampling ------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg'

/** on-curve anchor points of a path (the last coord pair of each M/L/C/Q). */
function onCurvePoints(d: string): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = []
  const re = /([MLCQ])([^MLCQZmlcqz]*)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(d))) {
    const nums = (m[2].match(/-?\d*\.?\d+(?:e-?\d+)?/g) ?? []).map(Number)
    if (nums.length >= 2) out.push({ x: nums[nums.length - 2], y: nums[nums.length - 1] })
  }
  return out
}

/**
 * Warp time→arc-length so the element dwells at low-speed anchors and rushes
 * at high-speed ones. `us` are the anchors' arc-length fractions (0..1),
 * `speeds` their multipliers. Returns identity if the profile is uniform.
 */
function makeWarp(us: number[], speeds: number[]): (t: number) => number {
  if (us.length < 2 || us.length !== speeds.length) return (t) => t
  if (speeds.every((s) => Math.abs(s - speeds[0]) < 1e-3)) return (t) => t
  const clampSp = (s: number) => Math.max(0.05, s)
  const v = (u: number) => {
    if (u <= us[0]) return clampSp(speeds[0])
    if (u >= us[us.length - 1]) return clampSp(speeds[speeds.length - 1])
    for (let i = 1; i < us.length; i++) {
      if (u <= us[i]) {
        const f = (u - us[i - 1]) / (us[i] - us[i - 1] || 1)
        return clampSp(speeds[i - 1] + (speeds[i] - speeds[i - 1]) * f)
      }
    }
    return clampSp(speeds[speeds.length - 1])
  }
  // cumulative traversal time T(u) = ∫ du/v ; normalise to [0,1], then invert
  const M = 240
  const T = new Float64Array(M + 1)
  for (let j = 1; j <= M; j++) T[j] = T[j - 1] + (1 / M) / v((j - 0.5) / M)
  const total = T[M] || 1
  for (let j = 0; j <= M; j++) T[j] /= total
  return (t) => {
    t = Math.min(Math.max(t, 0), 1)
    let lo = 0, hi = M
    while (lo < hi) { const mid = (lo + hi) >> 1; if (T[mid] < t) lo = mid + 1; else hi = mid }
    if (lo === 0) return 0
    const t0 = T[lo - 1], t1 = T[lo]
    const f = (t - t0) / (t1 - t0 || 1)
    return ((lo - 1) + f) / M
  }
}

function samplePath(d: string, speeds?: number[]): ((t: number) => { x: number; y: number }) | null {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', d)
  svg.appendChild(path)
  document.body.appendChild(svg)
  let total = 0
  try { total = path.getTotalLength() } catch { /* bad path */ }
  if (!Number.isFinite(total) || total <= 0) { svg.remove(); return null }
  // pre-sample; keeps the probe svg out of the DOM during the animation
  const N = Math.min(512, Math.max(64, Math.ceil(total / 3)))
  const pts: Array<{ x: number; y: number }> = []
  for (let i = 0; i <= N; i++) {
    const p = path.getPointAtLength((total * i) / N)
    pts.push({ x: p.x, y: p.y })
  }
  // variable speed: locate each anchor's arc-length fraction (nearest sample),
  // then build a time-warp from the per-anchor speed multipliers
  let warp: (t: number) => number = (t) => t
  if (speeds && speeds.length >= 2) {
    const anchors = onCurvePoints(d)
    if (anchors.length === speeds.length) {
      const us = anchors.map((a) => {
        let best = 0, bestD = Infinity
        for (let i = 0; i <= N; i++) {
          const dx = pts[i].x - a.x, dy = pts[i].y - a.y
          const dd = dx * dx + dy * dy
          if (dd < bestD) { bestD = dd; best = i }
        }
        return best / N
      })
      warp = makeWarp(us, speeds)
    }
  }
  svg.remove()
  const geom = (u: number) => {
    const f = Math.min(Math.max(u, 0), 1) * N
    const i = Math.min(Math.floor(f), N - 1)
    const k = f - i
    return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * k, y: pts[i].y + (pts[i + 1].y - pts[i].y) * k }
  }
  return (t) => geom(warp(t))
}

// --- the tween -----------------------------------------------------------------

export interface TweenVars {
  duration?: number
  delay?: number
  ease?: string
  repeat?: number
  yoyo?: boolean
  overwrite?: string // accepted for call-site compat; overwrite is always per-channel
  transformOrigin?: string
  onUpdate?: () => void
  onComplete?: () => void
  [channel: string]: unknown
}

const CONTROL = new Set(['duration', 'delay', 'ease', 'repeat', 'yoyo', 'overwrite', 'transformOrigin', 'onUpdate', 'onComplete'])

type Apply = (t: number) => void

export class Tween {
  private applies: Apply[] = []
  private channels = new Set<string>()
  private elapsed = 0 // seconds, excludes delay
  private delay: number
  private duration: number
  private repeat: number
  private yoyo: boolean
  private ease: EaseFn
  private vars: TweenVars
  private from: Record<string, unknown> | null
  private started = false
  private dead = false
  target: unknown

  constructor(target: unknown, from: Record<string, unknown> | null, to: TweenVars) {
    this.target = target
    this.vars = to
    this.from = from
    this.duration = Math.max(to.duration ?? 0.5, 0.0001)
    this.delay = to.delay ?? 0
    this.repeat = to.repeat ?? 0
    this.yoyo = !!to.yoyo
    this.ease = EASES[to.ease ?? 'power1.out'] ?? EASES.linear
    register(this)
    // fromTo renders its from-state immediately (gsap immediateRender parity)
    if (from) this.start()
    tickerOn()
  }

  /** Build interpolators. With explicit from-values this runs at creation;
   *  otherwise lazily when the delay elapses (reading current values). */
  private start() {
    if (this.started || this.dead) return
    this.started = true
    const t = this.target
    const from = this.from ?? {}
    const isEl = t instanceof HTMLElement || t instanceof SVGElement
    for (const [key, toVal] of Object.entries(this.vars)) {
      if (CONTROL.has(key) || toVal === undefined) continue
      this.channels.add(key)
      if (!isEl) {
        // plain object tween (countUp state)
        const obj = t as Record<string, number>
        const f = (from[key] as number) ?? obj[key] ?? 0
        const lerp = lerper(f, toVal as number)
        this.applies.push((p) => { obj[key] = lerp(p) as number })
        continue
      }
      const el = t as HTMLElement
      if (key === 'opacity') {
        const f = from.opacity ?? parseFloat(getComputedStyle(el).opacity) ?? 1
        const lerp = lerper(Number(f), Number(toVal))
        this.applies.push((p) => { el.style.opacity = String(lerp(p)) })
      } else if (key === 'y') {
        const x = xformOf(el)
        const f = Number(from.y ?? x.y)
        const lerp = lerper(f, Number(toVal))
        this.applies.push((p) => { x.y = lerp(p) as number; writeXform(el) })
      } else if (key === 'scale') {
        const x = xformOf(el)
        const f = Number(from.scale ?? x.scaleX)
        const lerp = lerper(f, Number(toVal))
        if (this.vars.transformOrigin) el.style.transformOrigin = String(this.vars.transformOrigin)
        this.applies.push((p) => { const s = lerp(p) as number; x.scaleX = s; x.scaleY = s; writeXform(el) })
      } else if (key === 'color') {
        const f = String(from.color ?? getComputedStyle(el).color)
        const lerp = lerper(f, String(toVal))
        this.applies.push((p) => { el.style.color = String(lerp(p)) })
      } else if (key === 'strokeDashoffset') {
        const f = from.strokeDashoffset ?? getComputedStyle(el).strokeDashoffset
        const lerp = lerper(parseFloat(String(f)) || 0, Number(toVal))
        this.applies.push((p) => { el.style.strokeDashoffset = String(lerp(p)) })
      } else if (key === 'attr') {
        const toAttrs = toVal as Record<string, string | number>
        const fromAttrs = (from.attr ?? {}) as Record<string, string | number>
        for (const [name, tv] of Object.entries(toAttrs)) {
          const fv = fromAttrs[name] ?? el.getAttribute(name) ?? 0
          const lerp = lerper(fv, tv)
          this.applies.push((p) => el.setAttribute(name, String(lerp(p))))
        }
      } else if (key === 'motionPath') {
        const mp = toVal as { path: string; speeds?: number[] }
        const d = mp.path
        const sample = samplePath(d, mp.speeds)
        if (sample) {
          const x = xformOf(el)
          this.applies.push((p) => {
            const pt = sample(p)
            x.x = pt.x
            x.y = pt.y
            writeXform(el)
          })
        }
      }
    }
    // per-channel overwrite: a newer tween on the same target owns its channels
    for (const other of tweensOf(this.target)) {
      if (other === this || other.dead) continue
      if ([...this.channels].some((c) => other.channels.has(c))) other.kill()
    }
    this.applies.forEach((a) => a(0))
  }

  /** 0..1 across the whole lifetime (repeats count as complete). */
  progress(): number {
    if (this.dead) return 1
    if (this.repeat === -1) return 0
    const total = this.duration * (1 + this.repeat)
    return Math.min(this.elapsed / total, 1)
  }

  /** advance by dt seconds; returns false when finished */
  tick(dt: number): boolean {
    if (this.dead) return false
    if (this.delay > 0) {
      this.delay -= dt
      if (this.delay > 0) return true
      dt = -this.delay
      this.delay = 0
    }
    if (!this.started) this.start()
    this.elapsed += dt
    const cycles = this.elapsed / this.duration
    const isForever = this.repeat === -1
    const done = !isForever && cycles >= 1 + this.repeat
    let t: number
    if (done) {
      t = this.yoyo && (1 + this.repeat) % 2 === 0 ? 0 : 1
    } else {
      const c = Math.floor(cycles)
      const frac = cycles - c
      t = this.yoyo && c % 2 === 1 ? 1 - frac : frac
    }
    const eased = this.ease(t)
    for (const a of this.applies) a(eased)
    this.vars.onUpdate?.()
    if (done) {
      this.dead = true
      unregister(this)
      this.vars.onComplete?.()
      return false
    }
    return true
  }

  kill() {
    if (this.dead) return
    this.dead = true
    unregister(this)
  }
}

// --- registry + ticker -----------------------------------------------------------

const live = new Set<Tween>()
const byTarget = new Map<unknown, Set<Tween>>()

function register(tw: Tween) {
  live.add(tw)
  let set = byTarget.get(tw.target)
  if (!set) byTarget.set(tw.target, (set = new Set()))
  set.add(tw)
}

function unregister(tw: Tween) {
  live.delete(tw)
  const set = byTarget.get(tw.target)
  set?.delete(tw)
  if (set && !set.size) byTarget.delete(tw.target)
}

function tweensOf(target: unknown): Tween[] {
  return [...(byTarget.get(target) ?? [])]
}

let running = false
let last = 0
let timeScale = 1
let manual = false

function tickerOn() {
  if (running || manual) return
  running = true
  last = performance.now()
  requestAnimationFrame(loop)
}

function loop(now: number) {
  if (manual) { running = false; return }
  // clamp long gaps (throttled tabs) so loops don't leap wildly
  const dt = Math.min((now - last) / 1000, 0.25) * timeScale
  last = now
  for (const tw of [...live]) tw.tick(dt)
  if (live.size) requestAnimationFrame(loop)
  else running = false
}

// --- public api --------------------------------------------------------------------

export const anim = {
  to(target: unknown, vars: TweenVars): Tween {
    return new Tween(target, null, vars)
  },
  fromTo(target: unknown, from: Record<string, unknown>, vars: TweenVars): Tween {
    return new Tween(target, from, vars)
  },
  killTweensOf(target: unknown) {
    const targets: unknown[] =
      target instanceof NodeList || Array.isArray(target) ? [...(target as Iterable<unknown>)] : [target]
    for (const t of targets) for (const tw of tweensOf(t)) tw.kill()
  },
  getTweensOf(target: unknown): Tween[] {
    return tweensOf(target)
  },
  killAll() {
    for (const tw of [...live]) tw.kill()
  },
  /** global playback rate (diagnostics/tests) */
  setTimeScale(n: number) {
    timeScale = n
  },
  /** manual clock for tests: stop the rAF loop and drive time by hand */
  setManual(on: boolean) {
    manual = on
    if (!on) tickerOn()
  },
  tick(seconds: number) {
    for (const tw of [...live]) tw.tick(seconds * timeScale)
  },
  get activeCount() {
    return live.size
  },
}
