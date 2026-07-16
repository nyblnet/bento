// Visual motion-path editing. The path of an fx.loop 'motion-path' is edited
// as draggable anchor points on the canvas; segments are auto-smoothed
// (Catmull-Rom → cubic bezier) so authors never manage control handles.
// A preview dot runs the loop live while editing.
//
// Model contract: the stored path is RELATIVE to the element's rest position
// (first point 0,0 — the element translates along it). The editor shows it
// anchored at the element's centre; dragging the first anchor moves the
// element itself.

import { gsap } from 'gsap'
import { MotionPathPlugin } from 'gsap/MotionPathPlugin'
import type { Store } from '../store'

gsap.registerPlugin(MotionPathPlugin)

const SVG_NS = 'http://www.w3.org/2000/svg'

type Pt = { x: number; y: number }

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

const r = (v: number) => Math.round(v * 100) / 100

/**
 * Anchors that PRESERVE the curve's shape: the path is sampled through the
 * browser (so beziers, arcs, relative commands and H/V/Z all work) and the
 * samples are reduced with Ramer–Douglas–Peucker. A hand-written single-C
 * curve like "M 0 0 C 122 0 133 140 255 140" yields interior anchors that
 * reproduce the S-bend — parseAnchors alone would flatten it to a line.
 */
export function samplePathAnchors(d: string): Pt[] {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', d)
  svg.appendChild(path)
  document.body.appendChild(svg)
  try {
    const total = path.getTotalLength()
    if (!Number.isFinite(total) || total < 1) return parseAnchors(d)
    const n = Math.min(256, Math.max(24, Math.ceil(total / 4)))
    const samples: Pt[] = []
    for (let i = 0; i <= n; i++) {
      const p = path.getPointAtLength((total * i) / n)
      samples.push({ x: p.x, y: p.y })
    }
    // Loosen tolerance until the anchor count is comfortable to edit.
    let eps = 0.75
    let pts = rdp(samples, eps)
    while (pts.length > 12) {
      eps *= 1.7
      pts = rdp(samples, eps)
    }
    return pts
  } catch {
    return parseAnchors(d)
  } finally {
    svg.remove()
  }
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

export class PathEditor {
  private overlay: SVGSVGElement | null = null
  private hint: HTMLElement | null = null
  private pts: Pt[] = []
  private elId = ''
  private scale = () => 1
  private dirty = false

  constructor(
    private scaleHost: HTMLElement,
    private store: Store,
    private onExit: () => void,
  ) {}

  get active() {
    return !!this.overlay
  }

  setScaleGetter(fn: () => number) {
    this.scale = fn
  }

  start(elId: string) {
    this.cancel()
    const el = this.store.element(elId)
    if (!el || el.fx?.loop?.type !== 'motion-path') return
    this.elId = elId
    this.dirty = false
    const cx = el.x + el.w / 2
    const cy = el.y + el.h / 2
    const rel = samplePathAnchors(el.fx.loop.path)
    this.pts = rel.length
      ? rel.map((p) => ({ x: p.x + cx, y: p.y + cy }))
      : [{ x: cx, y: cy }, { x: cx + 160, y: cy }]
    if (this.pts.length === 1) this.pts.push({ x: cx + 160, y: cy })
    // A synthesized default line counts as an edit — Done should save it.
    if (rel.length < 2) this.dirty = true

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.classList.add('ed-pathedit')
    const { width, height } = this.store.doc.size
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    svg.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;overflow:visible;z-index:50`
    svg.addEventListener('dblclick', (ev) => this.onDblClick(ev))
    this.scaleHost.appendChild(svg)
    this.overlay = svg

    this.hint = document.createElement('div')
    this.hint.className = 'ed-setbar ed-pathbar'
    this.hint.innerHTML =
      '<span class="ed-setbar-label">Motion path — drag points · double-click path to insert · double-click point to remove · double-click canvas to append</span>'
    const done = document.createElement('button')
    done.className = 'ed-setchip active'
    done.textContent = 'Done'
    done.addEventListener('click', () => this.commit())
    this.hint.appendChild(done)
    this.scaleHost.closest('.ed-canvas-wrap')?.appendChild(this.hint)

    this.draw()
  }

  /** Persist: element rest position ← first anchor; path stored relative. */
  commit() {
    if (!this.overlay) return
    const el = this.store.element(this.elId)
    const pts = this.pts
    const dirty = this.dirty
    this.cancel()
    // Nothing was touched: keep the original path byte-for-byte. The anchor
    // set is a sampled approximation of the curve, so writing it back on a
    // no-op edit would still subtly reshape hand-authored beziers.
    if (!dirty) {
      this.onExit()
      return
    }
    if (!el || el.fx?.loop?.type !== 'motion-path' || pts.length < 2) return
    const p0 = pts[0]
    const relPath = anchorsToPath(pts.map((p) => ({ x: p.x - p0.x, y: p.y - p0.y })))
    this.store.commit(() => {
      const live = this.store.element(el.id)
      if (!live || live.fx?.loop?.type !== 'motion-path') return
      live.fx.loop.path = relPath
      live.x = r(p0.x - live.w / 2)
      live.y = r(p0.y - live.h / 2)
    })
    this.onExit()
  }

  cancel() {
    if (!this.overlay) return
    gsap.killTweensOf(this.overlay.querySelectorAll('*'))
    this.overlay.remove()
    this.overlay = null
    this.hint?.remove()
    this.hint = null
  }

  // --- rendering -------------------------------------------------------------

  private draw() {
    const svg = this.overlay
    if (!svg) return
    gsap.killTweensOf(svg.querySelectorAll('.ed-pe-dot'))
    svg.innerHTML = ''
    const k = 1 / this.scale()
    const d = anchorsToPath(this.pts)

    const mk = (tag: string) => document.createElementNS(SVG_NS, tag)
    // wide invisible hit area for inserting on the curve
    const hit = mk('path')
    hit.setAttribute('d', d)
    hit.setAttribute('fill', 'none')
    hit.setAttribute('stroke', 'transparent')
    hit.setAttribute('stroke-width', String(16 * k))
    hit.classList.add('ed-pe-hit')
    svg.appendChild(hit)

    const line = mk('path')
    line.setAttribute('d', d)
    line.setAttribute('fill', 'none')
    line.setAttribute('stroke', '#5b8def')
    line.setAttribute('stroke-width', String(2 * k))
    line.setAttribute('stroke-dasharray', `${6 * k} ${5 * k}`)
    line.style.pointerEvents = 'none'
    svg.appendChild(line)

    this.pts.forEach((p, i) => {
      const dot = mk('circle')
      dot.setAttribute('cx', String(p.x))
      dot.setAttribute('cy', String(p.y))
      dot.setAttribute('r', String((i === 0 ? 8 : 6.5) * k))
      dot.setAttribute('fill', i === 0 ? '#f7a600' : '#fff')
      dot.setAttribute('stroke', '#31445c')
      dot.setAttribute('stroke-width', String(1.6 * k))
      dot.classList.add('ed-pe-anchor')
      dot.dataset.idx = String(i)
      if (i === 0)

        dot.append(Object.assign(mk('title'), { textContent: 'Start — also the element’s rest position' }))
      dot.addEventListener('mousedown', (ev) => this.dragAnchor(ev, i))
      svg.appendChild(dot)
    })

    // live preview: a dot loops the path at the element's configured speed
    const el = this.store.element(this.elId)
    const dur = (el?.fx?.loop as any)?.duration ?? 3
    const preview = mk('circle')
    preview.setAttribute('r', String(4.5 * k))
    preview.setAttribute('fill', '#f7a600')
    preview.style.pointerEvents = 'none'
    preview.classList.add('ed-pe-dot')
    svg.appendChild(preview)
    gsap.to(preview, { motionPath: { path: d }, duration: Math.max(dur, 0.5), ease: 'none', repeat: -1 })
  }

  // --- interaction ------------------------------------------------------------

  private toSlide(ev: MouseEvent): Pt {
    const rect = this.scaleHost.getBoundingClientRect()
    const s = this.scale()
    return { x: (ev.clientX - rect.left) / s, y: (ev.clientY - rect.top) / s }
  }

  private dragAnchor(down: MouseEvent, idx: number) {
    down.stopPropagation()
    down.preventDefault()
    const startPt = this.toSlide(down)
    const orig = { ...this.pts[idx] }
    let lastTs = 0
    const move = (ev: MouseEvent) => {
      const p = this.toSlide(ev)
      if (p.x !== startPt.x || p.y !== startPt.y) this.dirty = true
      this.pts[idx] = { x: orig.x + p.x - startPt.x, y: orig.y + p.y - startPt.y }
      // first anchor = element rest position: give live feedback on the node
      if (idx === 0) {
        const el = this.store.element(this.elId)
        const node = this.scaleHost.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(this.elId)}"]`)
        if (el && node) {
          node.style.left = `${this.pts[0].x - el.w / 2}px`
          node.style.top = `${this.pts[0].y - el.h / 2}px`
        }
      }
      if (ev.timeStamp - lastTs > 30) {
        lastTs = ev.timeStamp
        this.draw()
      }
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      this.draw()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private onDblClick(ev: MouseEvent) {
    ev.preventDefault()
    ev.stopPropagation()
    const target = ev.target as Element
    const p = this.toSlide(ev)
    if (target.classList.contains('ed-pe-anchor')) {
      // remove (keep at least two)
      const idx = Number((target as SVGElement).dataset.idx)
      if (this.pts.length > 2) {
        this.pts.splice(idx, 1)
        this.dirty = true
      }
      this.draw()
      return
    }
    if (target.classList.contains('ed-pe-hit')) {
      // insert into the nearest segment
      let best = 0
      let bestDist = Infinity
      for (let i = 0; i < this.pts.length - 1; i++) {
        const mx = (this.pts[i].x + this.pts[i + 1].x) / 2
        const my = (this.pts[i].y + this.pts[i + 1].y) / 2
        const dist = Math.hypot(p.x - mx, p.y - my)
        if (dist < bestDist) { bestDist = dist; best = i }
      }
      this.pts.splice(best + 1, 0, p)
      this.dirty = true
      this.draw()
      return
    }
    // empty canvas: append to the end
    this.pts.push(p)
    this.dirty = true
    this.draw()
  }
}
