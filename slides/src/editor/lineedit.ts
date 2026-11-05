// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Direct on-canvas editing for line / curved-line / connector SHAPES — the
// intuitive alternative to resizing a box and rotating it. A selected line
// shows two draggable endpoint handles; a curve (path) shows its anchor points
// (double-click to add on the curve, double-click a point to remove); dragging
// the body moves the whole thing. Connectors (endpoints anchored to elements)
// are edited the same way but re-route automatically — see editor.syncConnectors.
//
// Model-driven: handles are positioned from the element's geometry (not its DOM
// node), so a re-render underneath us doesn't matter. Geometry conversions:
//   • line  ⇄ two endpoints (box centre ± half-width along rotation)
//   • path  ⇄ anchor points  (pathBox normalised to [0,0,w,h], d = smoothed)

import type { Store } from '../store'
import type { ShapeElement } from '../model'
import { anchorsToPath, parseAnchors, samplePathAnchors } from './patheditor'
// The pure line/box/anchor geometry moved to the kernel (kernel/src/geom.ts) so
// bento/spaces diagrams share it. Re-exported here so `./lineedit` stays the
// import site for editor.ts / canvas.ts and behaviour is unchanged. What remains
// in this file needs the DOM (LineEditor) or slides' model/tips (pathAnchors,
// setPathAnchors, the path-endpoint connector re-route).
import {
  isLineLike, lineEndpoints, pathIsClosed, pathIsStraight, setLineEndpoints, type Pt,
} from '../../../kernel/src/geom.ts'
// pure connector routing lives in ../connectors (DOM-free, used at boot)
export { pathEndpoints, setPathEndpoints, routeConnectors, routeAllConnectors } from '../connectors'
export { boxCenter, borderPoint, sideMidpoint, boxAnchors, connectorEndpoint, nearestAnchor, boxContains, type ConnectorSide } from '../../../kernel/src/geom.ts'
export { isLineLike, lineEndpoints, pathIsClosed, pathIsStraight, setLineEndpoints }

const rnd = (v: number) => Math.round(v * 100) / 100
const SVG_NS = 'http://www.w3.org/2000/svg'

/** Anchor points of a path shape, in slide coords. Straight paths (polylines/
 *  polygons) parse exactly; curves are sampled+reduced. */
export function pathAnchors(el: ShapeElement): Pt[] {
  const [px, py, pw, ph] = el.pathBox ?? [0, 0, el.w || 1, el.h || 1]
  const sx = el.w / (pw || 1)
  const sy = el.h / (ph || 1)
  const src = pathIsStraight(el.d) ? parseAnchors(el.d ?? '') : samplePathAnchors(el.d ?? '')
  return src.map((p) => ({ x: el.x + (p.x - px) * sx, y: el.y + (p.y - py) * sy }))
}

/** Write a path shape from anchor points (slide coords); normalises pathBox.
 *  `straight` keeps segments as lines (polygons); `closed` appends Z. */
export function setPathAnchors(el: ShapeElement, pts: Pt[], opts: { closed?: boolean; straight?: boolean } = {}): void {
  if (pts.length < 2) return
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const w = Math.max(Math.max(...xs) - minX, 1)
  const h = Math.max(Math.max(...ys) - minY, 1)
  el.x = minX
  el.y = minY
  el.w = w
  el.h = h
  el.pathBox = [0, 0, w, h]
  const rel = pts.map((p) => ({ x: rnd(p.x - minX), y: rnd(p.y - minY) }))
  el.d = (opts.straight
    ? 'M ' + rel.map((p) => `${p.x} ${p.y}`).join(' L ')
    : anchorsToPath(rel)) + (opts.closed ? ' Z' : '')
}

/** A compound path — more than one subpath (a boolean's outline and its hole,
 *  an imported SVG with several contours). The line and curve editors hold
 *  one contour, so neither attaches: it is selected and moved as a box. */
export const isCompoundPath = (d?: string) => (d?.match(/m/gi)?.length ?? 0) > 1

/** A body drag of a line or path editor: move the element by (dx, dy), as an
 *  arrow nudge does. Never re-derive `d` — a boolean or imported path holds
 *  several subpaths (an outline and its holes) that the editors' anchor list
 *  would join into one. */
export function moveShapeBy(store: Store, id: string, dx: number, dy: number): void {
  store.commit(() => {
    const el = store.element(id)
    if (!el) return
    el.x = rnd(el.x + dx)
    el.y = rnd(el.y + dy)
  })
}

export class LineEditor {
  private overlay: SVGSVGElement | null = null
  private elId = ''
  private kind: 'line' | 'path' = 'line'
  private closed = false
  private straight = false
  private pts: Pt[] = []
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

  /** Show handles for a line/path shape (idempotent — re-reads geometry). */
  attach(elId: string) {
    const el = this.store.element(elId) as ShapeElement | undefined
    if (!el || !isLineLike(el) || isCompoundPath(el.d)) return this.detach()
    this.elId = elId
    this.kind = el.shape === 'path' ? 'path' : 'line'
    this.closed = this.kind === 'path' && pathIsClosed(el.d)
    this.straight = this.kind === 'path' && pathIsStraight(el.d)
    this.pts = this.kind === 'line' ? lineEndpoints(el) : pathAnchors(el)
    if (!this.overlay) {
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.classList.add('ed-lineedit')
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

  // --- rendering -------------------------------------------------------------

  private draw() {
    const svg = this.overlay
    if (!svg) return
    svg.innerHTML = ''
    const k = 1 / this.scale()
    const mk = (tag: string) => document.createElementNS(SVG_NS, tag)
    const d = this.kind === 'line'
      ? `M ${this.pts[0].x} ${this.pts[0].y} L ${this.pts[1].x} ${this.pts[1].y}`
      : (this.straight
          ? 'M ' + this.pts.map((p) => `${p.x} ${p.y}`).join(' L ')
          : anchorsToPath(this.pts)) + (this.closed ? ' Z' : '')

    // fat invisible hit-line to drag the whole shape (and, for curves, to insert)
    const hit = mk('path')
    hit.setAttribute('d', d)
    hit.setAttribute('fill', 'none')
    hit.setAttribute('stroke', 'transparent')
    hit.setAttribute('stroke-width', String(16 * k))
    hit.classList.add('ed-le-body')
    hit.style.cursor = 'move'
    // a closed shape is pressed anywhere inside it, as its own fill is; a line or open curve on its stroke
    hit.style.pointerEvents = this.closed ? 'all' : 'stroke'
    hit.addEventListener('mousedown', (ev) => this.dragBody(ev))
    svg.appendChild(hit)

    // thin guide line so the geometry is visible while editing
    const guide = mk('path')
    guide.setAttribute('d', d)
    guide.setAttribute('fill', 'none')
    guide.setAttribute('stroke', '#5b8def')
    guide.setAttribute('stroke-width', String(1.5 * k))
    guide.style.pointerEvents = 'none'
    svg.appendChild(guide)

    this.pts.forEach((p, i) => {
      const dot = mk('circle')
      dot.setAttribute('cx', String(p.x))
      dot.setAttribute('cy', String(p.y))
      dot.setAttribute('r', String(6.5 * k))
      dot.setAttribute('fill', '#fff')
      dot.setAttribute('stroke', '#2f6df6')
      dot.setAttribute('stroke-width', String(2 * k))
      dot.classList.add('ed-le-anchor')
      dot.dataset.idx = String(i)
      dot.style.cursor = 'grab'
      dot.style.pointerEvents = 'all'
      dot.addEventListener('mousedown', (ev) => this.dragAnchor(ev, i))
      svg.appendChild(dot)
    })
  }

  // --- interaction -----------------------------------------------------------

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
    const start = this.toSlide(down)
    const orig = { ...this.pts[idx] }
    const node = this.elNode()
    if (node) node.style.opacity = '0.4'
    let moved = false
    const move = (ev: MouseEvent) => {
      const p = this.toSlide(ev)
      moved = true
      this.pts[idx] = { x: orig.x + (p.x - start.x), y: orig.y + (p.y - start.y) }
      this.draw()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (node) node.style.opacity = ''
      if (moved) this.commit(idx)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /** Move the whole shape with this press — its body, or (canvas.ts) the press that just selected it. */
  dragBody(down: MouseEvent) {
    down.stopPropagation()
    down.preventDefault()
    const start = this.toSlide(down)
    const orig = this.pts.map((p) => ({ ...p }))
    const node = this.elNode()
    if (node) node.style.opacity = '0.4'
    let moved = false
    let dx = 0, dy = 0
    const move = (ev: MouseEvent) => {
      const p = this.toSlide(ev)
      dx = p.x - start.x
      dy = p.y - start.y
      moved = true
      this.pts = orig.map((o) => ({ x: o.x + dx, y: o.y + dy }))
      this.draw()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (node) node.style.opacity = ''
      if (moved) { moveShapeBy(this.store, this.elId, dx, dy); this.attach(this.elId) }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  private onDblClick(ev: MouseEvent) {
    if (this.kind !== 'path') return
    ev.preventDefault()
    ev.stopPropagation()
    const target = ev.target as Element
    const p = this.toSlide(ev)
    if (target.classList.contains('ed-le-anchor')) {
      const idx = Number((target as SVGElement).dataset.idx)
      if (this.pts.length > 2) {
        this.pts.splice(idx, 1)
        this.commit(null)
      }
      return
    }
    // a closed shape's body takes a press anywhere inside it; only a double-click on its edge adds a point
    const edge = (a: Pt, b: Pt) => { const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy || 1, u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)); return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy) }
    const ring = this.closed ? [...this.pts, this.pts[0]] : this.pts
    if (Math.min(...ring.slice(1).map((b, i) => edge(ring[i], b))) > 8 / this.scale()) return
    // insert into the nearest segment midpoint
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < this.pts.length - 1; i++) {
      const mx = (this.pts[i].x + this.pts[i + 1].x) / 2
      const my = (this.pts[i].y + this.pts[i + 1].y) / 2
      const dd = Math.hypot(p.x - mx, p.y - my)
      if (dd < bestDist) { bestDist = dd; best = i }
    }
    this.pts.splice(best + 1, 0, p)
    this.commit(null)
  }

  /** Push the edited geometry into the model (one undo step); a connector whose
   *  dragged END lands on nothing loses that anchor (it becomes free). */
  private commit(draggedIdx: number | null) {
    const id = this.elId
    const pts = this.pts.map((p) => ({ ...p }))
    const kind = this.kind
    this.store.commit(() => {
      const el = this.store.element(id) as ShapeElement | undefined
      if (!el) return
      if (kind === 'line') setLineEndpoints(el, pts[0], pts[1])
      else setPathAnchors(el, pts, { closed: this.closed, straight: this.straight })
      // moving an endpoint by hand detaches that end of a connector
      if (draggedIdx === 0) delete el.from
      if (draggedIdx !== null && draggedIdx === pts.length - 1) delete el.to
    })
  }
}
