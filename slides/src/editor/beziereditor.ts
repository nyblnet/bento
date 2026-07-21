// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// True pen-tool editing for curve (path) shapes. Each on-curve anchor shows its
// in/out control handles; dragging a handle bends the curve exactly (the path
// IS the handles — no sampling, no re-smoothing, no drift). Smooth anchors
// mirror the opposite handle; Alt breaks symmetry into a corner. Double-click a
// segment to insert an anchor (the split preserves the shape via de Casteljau);
// double-click an anchor to remove it; drag the body to move the whole shape.
//
// Replaces the old Catmull-Rom anchor editing for curves (which sampled the
// rendered path and re-smoothed on every drag). Lines and straight polygons
// keep using LineEditor; this takes over only for curved paths.

import type { Store } from '../store'
import type { ShapeElement } from '../model'
import { type BezNode, type Pt, handleLen, mirrorHandle, nearestT, parseBezier, serializeBezier, splitSegment } from './bezier'

const SVG_NS = 'http://www.w3.org/2000/svg'
const rnd = (v: number) => Math.round(v * 100) / 100

/** A curve is a path shape that carries actual bezier commands. */
export function isCurve(el: { type: string; shape?: string; d?: string }): boolean {
  return el.type === 'shape' && el.shape === 'path' && /[csq]/i.test(el.d ?? '')
}

export class BezierEditor {
  private overlay: SVGSVGElement | null = null
  private elId = ''
  private nodes: BezNode[] = [] // slide coords
  private closed = false
  private scale = () => 1

  constructor(
    private scaleHost: HTMLElement,
    private store: Store,
  ) {}

  get active() {
    return !!this.overlay
  }
  get elementId() {
    return this.elId
  }
  setScaleGetter(fn: () => number) {
    this.scale = fn
  }

  attach(elId: string) {
    const el = this.store.element(elId) as ShapeElement | undefined
    if (!el || !isCurve(el)) return this.detach()
    this.elId = elId
    const { nodes, closed } = parseBezier(el.d ?? '')
    this.closed = closed
    const map = this.toSlideFn(el)
    this.nodes = nodes.map((n) => this.mark({ p: map(n.p), in: n.in && map(n.in), out: n.out && map(n.out) }))
    if (!this.overlay) {
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.classList.add('ed-bezedit')
      const { width, height } = this.store.doc.size
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
      svg.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;overflow:visible;z-index:49;pointer-events:none`
      svg.addEventListener('dblclick', (ev) => this.onDblClick(ev))
      this.scaleHost.appendChild(svg)
      this.overlay = svg
    }
    this.draw()
  }

  detach() {
    this.overlay?.remove()
    this.overlay = null
    this.elId = ''
  }

  // --- coordinate mapping (path-local ⇄ slide) --------------------------------

  private toSlideFn(el: ShapeElement): (p: Pt) => Pt {
    const [px, py, pw, ph] = el.pathBox ?? [0, 0, el.w || 1, el.h || 1]
    const sx = el.w / (pw || 1)
    const sy = el.h / (ph || 1)
    return (p) => ({ x: el.x + (p.x - px) * sx, y: el.y + (p.y - py) * sy })
  }

  /** Mark a node corner if its two handles aren't (roughly) collinear. */
  private mark(n: BezNode): BezNode {
    if (n.in && n.out) {
      const a = Math.atan2(n.p.y - n.in.y, n.p.x - n.in.x)
      const b = Math.atan2(n.out.y - n.p.y, n.out.x - n.p.x)
      let d = Math.abs(a - b)
      if (d > Math.PI) d = 2 * Math.PI - d
      n.corner = d > 0.14 // ~8°
    }
    return n
  }

  // --- rendering --------------------------------------------------------------

  private draw() {
    const svg = this.overlay
    if (!svg) return
    svg.innerHTML = ''
    const k = 1 / this.scale()
    const mk = (tag: string) => document.createElementNS(SVG_NS, tag)
    const d = serializeBezier(this.nodes, this.closed)

    // fat invisible hit line — drag the whole shape / double-click to insert
    const hit = mk('path')
    hit.setAttribute('d', d)
    hit.setAttribute('fill', 'none')
    hit.setAttribute('stroke', 'transparent')
    hit.setAttribute('stroke-width', String(16 * k))
    hit.classList.add('ed-bz-body')
    hit.style.cssText = 'cursor:move;pointer-events:stroke'
    hit.addEventListener('mousedown', (ev) => this.dragBody(ev))
    svg.appendChild(hit)

    // visible guide
    const guide = mk('path')
    guide.setAttribute('d', d)
    guide.setAttribute('fill', 'none')
    guide.setAttribute('stroke', '#5b8def')
    guide.setAttribute('stroke-width', String(1.5 * k))
    guide.style.pointerEvents = 'none'
    svg.appendChild(guide)

    // handles (drawn under anchors)
    this.nodes.forEach((n, i) => {
      for (const which of ['in', 'out'] as const) {
        const h = n[which]
        if (!h) continue
        const stem = mk('line')
        stem.setAttribute('x1', String(n.p.x))
        stem.setAttribute('y1', String(n.p.y))
        stem.setAttribute('x2', String(h.x))
        stem.setAttribute('y2', String(h.y))
        stem.setAttribute('stroke', '#8aa9e6')
        stem.setAttribute('stroke-width', String(1 * k))
        stem.style.pointerEvents = 'none'
        svg.appendChild(stem)
        const hd = mk('circle')
        hd.setAttribute('cx', String(h.x))
        hd.setAttribute('cy', String(h.y))
        hd.setAttribute('r', String(4.5 * k))
        hd.setAttribute('fill', '#5b8def')
        hd.setAttribute('stroke', '#fff')
        hd.setAttribute('stroke-width', String(1.5 * k))
        hd.style.cssText = 'cursor:crosshair;pointer-events:all'
        hd.addEventListener('mousedown', (ev) => this.dragHandle(ev, i, which))
        svg.appendChild(hd)
      }
    })

    // anchors (on top)
    this.nodes.forEach((n, i) => {
      const dot = mk(n.corner ? 'rect' : 'circle')
      const rad = 6 * k
      if (n.corner) {
        dot.setAttribute('x', String(n.p.x - rad))
        dot.setAttribute('y', String(n.p.y - rad))
        dot.setAttribute('width', String(rad * 2))
        dot.setAttribute('height', String(rad * 2))
      } else {
        dot.setAttribute('cx', String(n.p.x))
        dot.setAttribute('cy', String(n.p.y))
        dot.setAttribute('r', String(rad))
      }
      dot.setAttribute('fill', '#fff')
      dot.setAttribute('stroke', '#2f6df6')
      dot.setAttribute('stroke-width', String(2 * k))
      dot.classList.add('ed-bz-anchor')
      dot.dataset.idx = String(i)
      dot.style.cssText = 'cursor:grab;pointer-events:all'
      dot.addEventListener('mousedown', (ev) => this.dragAnchor(ev, i))
      svg.appendChild(dot)
    })
  }

  // --- interaction ------------------------------------------------------------

  private toSlide(ev: MouseEvent): Pt {
    const rect = this.scaleHost.getBoundingClientRect()
    const s = this.scale()
    return { x: (ev.clientX - rect.left) / s, y: (ev.clientY - rect.top) / s }
  }
  private elNode(): HTMLElement | null {
    return this.scaleHost.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(this.elId)}"]`)
  }

  private dragAnchor(down: MouseEvent, idx: number) {
    down.stopPropagation()
    down.preventDefault()
    // Alt-click (no drag) toggles corner/smooth
    const start = this.toSlide(down)
    const n = this.nodes[idx]
    const orig = { p: { ...n.p }, in: n.in && { ...n.in }, out: n.out && { ...n.out } }
    const node = this.elNode()
    if (node) node.style.opacity = '0.4'
    let moved = false
    const move = (ev: MouseEvent) => {
      const p = this.toSlide(ev)
      const dx = p.x - start.x
      const dy = p.y - start.y
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moved = true
      n.p = { x: orig.p.x + dx, y: orig.p.y + dy }
      if (orig.in) n.in = { x: orig.in.x + dx, y: orig.in.y + dy }
      if (orig.out) n.out = { x: orig.out.x + dx, y: orig.out.y + dy }
      this.draw()
    }
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (node) node.style.opacity = ''
      if (!moved && ev.altKey) {
        n.corner = !n.corner
        this.draw()
      }
      this.commit(moved || (!moved && ev.altKey))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private dragHandle(down: MouseEvent, idx: number, which: 'in' | 'out') {
    down.stopPropagation()
    down.preventDefault()
    const n = this.nodes[idx]
    const other = which === 'in' ? 'out' : 'in'
    const oppLen = handleLen(n.p, n[other])
    const node = this.elNode()
    if (node) node.style.opacity = '0.4'
    const move = (ev: MouseEvent) => {
      const p = this.toSlide(ev)
      n[which] = p
      if (ev.altKey) n.corner = true // Alt breaks smooth symmetry into a corner
      // smooth node: mirror the opposite handle's direction, keep its length
      if (!n.corner && n[other]) n[other] = mirrorHandle(n.p, p, oppLen)
      this.draw()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (node) node.style.opacity = ''
      this.commit(true)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private dragBody(down: MouseEvent) {
    down.stopPropagation()
    down.preventDefault()
    const start = this.toSlide(down)
    const orig = this.nodes.map((n) => ({ p: { ...n.p }, in: n.in && { ...n.in }, out: n.out && { ...n.out }, corner: n.corner }))
    const node = this.elNode()
    if (node) node.style.opacity = '0.4'
    let moved = false
    const move = (ev: MouseEvent) => {
      const p = this.toSlide(ev)
      const dx = p.x - start.x
      const dy = p.y - start.y
      moved = true
      this.nodes = orig.map((o) => ({
        p: { x: o.p.x + dx, y: o.p.y + dy },
        in: o.in && { x: o.in.x + dx, y: o.in.y + dy },
        out: o.out && { x: o.out.x + dx, y: o.out.y + dy },
        corner: o.corner,
      }))
      this.draw()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (node) node.style.opacity = ''
      if (moved) this.commit(true)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private onDblClick(ev: MouseEvent) {
    ev.preventDefault()
    ev.stopPropagation()
    const target = ev.target as Element
    if (target.classList.contains('ed-bz-anchor')) {
      const idx = Number((target as SVGElement).dataset.idx)
      if (this.nodes.length > 2) {
        this.nodes.splice(idx, 1)
        this.commit(true)
      }
      return
    }
    // insert: find the segment nearest the click, split it at the nearest t
    const q = this.toSlide(ev)
    const segs = this.closed ? this.nodes.length : this.nodes.length - 1
    let best = 0
    let bestT = 0.5
    let bestD = Infinity
    for (let i = 0; i < segs; i++) {
      const a = this.nodes[i]
      const b = this.nodes[(i + 1) % this.nodes.length]
      const c1 = a.out ?? a.p
      const c2 = b.in ?? b.p
      const t = nearestT(a.p, c1, c2, b.p, q)
      const pt = cubicPoint(a.p, c1, c2, b.p, t)
      const dd = (pt.x - q.x) ** 2 + (pt.y - q.y) ** 2
      if (dd < bestD) { bestD = dd; best = i; bestT = t }
    }
    const a = this.nodes[best]
    const b = this.nodes[(best + 1) % this.nodes.length]
    const split = splitSegment(a, b, bestT)
    this.nodes[best] = split.a
    this.nodes[(best + 1) % this.nodes.length] = split.b
    this.nodes.splice(best + 1, 0, split.mid)
    this.commit(true)
  }

  /** Write nodes back to the model: bbox of anchor POINTS → element box +
   *  pathBox, handles stored relative (may fall outside the box, which is fine).
   *  Dragging an endpoint detaches that end of a connector. */
  private commit(dirty: boolean) {
    if (!dirty) return
    const id = this.elId
    const nodes = this.nodes.map((n) => ({ p: { ...n.p }, in: n.in && { ...n.in }, out: n.out && { ...n.out } }))
    const closed = this.closed
    this.store.commit(() => {
      const el = this.store.element(id) as ShapeElement | undefined
      if (!el || nodes.length < 2) return
      // Element box = the TRUE geometric bounds of the curve (getBBox includes
      // the control-point bulge), not just the anchor points — so selection and
      // pathBox fit the visible shape. pathBox size == box size ⇒ 1:1 render.
      const bb = curveBBox(serializeBezier(nodes, closed))
      const minX = bb.x
      const minY = bb.y
      const w = Math.max(bb.width, 1)
      const h = Math.max(bb.height, 1)
      const loc = (p: Pt) => ({ x: rnd(p.x - minX), y: rnd(p.y - minY) })
      const local = nodes.map((n) => ({ p: loc(n.p), in: n.in && loc(n.in), out: n.out && loc(n.out) }))
      el.x = rnd(minX)
      el.y = rnd(minY)
      el.w = rnd(w)
      el.h = rnd(h)
      el.pathBox = [0, 0, rnd(w), rnd(h)]
      el.d = serializeBezier(local, closed)
    })
    // re-read (bbox may have shifted) so handles track the new element frame
    this.attach(id)
  }
}

/** Geometric bbox of a path (includes curve bulge, via SVG getBBox). */
function curveBBox(d: string): { x: number; y: number; width: number; height: number } {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', d)
  svg.appendChild(path)
  document.body.appendChild(svg)
  try {
    return path.getBBox()
  } finally {
    svg.remove()
  }
}

function cubicPoint(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
  }
}
