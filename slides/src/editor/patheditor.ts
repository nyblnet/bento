// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// Visual motion-path editing — HYBRID bezier. The path of an fx.loop
// 'motion-path' is a set of draggable waypoints. By default a waypoint stays
// AUTO: its in/out tangents are auto-computed (Catmull-Rom) so the trajectory
// stays smooth with zero handle wrangling — the same simple feel as before.
// Selecting a waypoint REVEALS its two bezier control handles; the moment you
// drag one, that waypoint becomes MANUAL — its tangents are then stored
// explicitly (exact cubics, no re-sampling, no drift) and no longer
// auto-recomputed, giving precise arcs and sharp corners (Alt = break smooth
// into a corner). Untouched waypoints keep auto-smoothing. A preview dot runs
// the loop live while editing.
//
// Because the trajectory is now stored as explicit cubics (via bezier.ts,
// shared with the shape-curve editor) the lossy sample→re-smooth round-trip of
// the old Catmull-Rom editor is gone: a path survives open→save byte-stable.
//
// Model contract: the stored path is RELATIVE to the element's rest position
// (first point 0,0 — the element translates along it). The editor shows it
// anchored at the element's centre; dragging the first anchor moves the
// element itself. Per-anchor `speeds[]` stays 1:1 with the waypoints through
// every insert/remove/split (serializeBezier emits one on-curve point per
// node, so anim.ts onCurvePoints/samplePath still line the speeds up exactly).

import { anim } from '../anim'
import { t } from '../i18n'
import type { Store } from '../store'
import { type BezNode, type Pt as BPt, handleLen, mirrorHandle, nearestT, parseBezier, serializeBezier, splitSegment } from './bezier'

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

// --- hybrid bezier node model ------------------------------------------------
// A waypoint carries a point plus (when MANUAL) explicit in/out handles. Auto
// waypoints leave the handles undefined and let `autoHandles` derive Catmull-Rom
// tangents at serialize time, so an auto path is byte-identical to the old
// anchorsToPath output (backward compatible with every saved deck).

interface WNode extends BezNode {
  /** handles are explicit (the user dragged one) rather than auto-smoothed */
  manual?: boolean
}

/** Catmull-Rom tangents for waypoint i — EXACTLY what anchorsToPath emits:
 *  out = P + (Pnext − Pprev)/6, in = P − (Pnext − Pprev)/6 (ends clamped). */
function autoHandles(pts: BPt[], i: number): { in?: BPt; out?: BPt } {
  const n = pts.length
  const prev = pts[Math.max(0, i - 1)]
  const next = pts[Math.min(n - 1, i + 1)]
  const dx = (next.x - prev.x) / 6
  const dy = (next.y - prev.y) / 6
  const p = pts[i]
  return {
    in: i > 0 ? { x: p.x - dx, y: p.y - dy } : undefined,
    out: i < n - 1 ? { x: p.x + dx, y: p.y + dy } : undefined,
  }
}

/** Resolve every node's handles: manual nodes keep theirs, auto nodes get
 *  Catmull-Rom tangents. Result feeds serializeBezier / de Casteljau / preview. */
function effectiveNodes(nodes: WNode[]): BezNode[] {
  const pts = nodes.map((n) => n.p)
  return nodes.map((n, i) => {
    if (n.manual) return { p: { ...n.p }, in: n.in && { ...n.in }, out: n.out && { ...n.out } }
    const a = autoHandles(pts, i)
    return { p: { ...n.p }, in: a.in, out: a.out }
  })
}

/** Serialize hybrid nodes to an SVG path (M/C, open). */
function nodesToPath(nodes: WNode[]): string {
  return serializeBezier(effectiveNodes(nodes), false)
}

/** Decide manual vs auto for freshly parsed nodes. A path with no curve
 *  commands (a bare polyline like the "M 0 0 L 100 0" default) is all-auto —
 *  it carries no bezier intent. When it DOES have curves, a node counts as auto
 *  only if its handles still sit on the Catmull-Rom tangents (so legacy
 *  Catmull-Rom motion paths reopen as fully auto and keep the simple feel;
 *  hand-tuned handles reopen as manual and are preserved exactly). */
function classifyNodes(nodes: BezNode[], hadCurves: boolean): WNode[] {
  const pts = nodes.map((n) => n.p)
  return nodes.map((n, i) => {
    if (!hadCurves) return { p: n.p }
    const a = autoHandles(pts, i)
    const near = (p?: BPt, q?: BPt): boolean =>
      (!p && !q) || (!!p && !!q && Math.hypot(p.x - q.x, p.y - q.y) < 0.6)
    const auto = near(n.in, a.in) && near(n.out, a.out)
    return auto ? { p: n.p } : { p: n.p, in: n.in, out: n.out, manual: true }
  })
}

export class PathEditor {
  private overlay: SVGSVGElement | null = null
  private hint: HTMLElement | null = null
  private nodes: WNode[] = [] // slide coords
  private speeds: number[] = [] // per-anchor speed multipliers, mirrors nodes
  private selected: number | null = null
  private elId = ''
  private scale = () => 1
  private dirty = false
  // Manual double-click detection for nodes: the DOM `dblclick` can't be used on
  // anchors because selecting one redraws the overlay between the two clicks
  // (destroying the shared target), so we track the last node mousedown here.
  private lastDown = { idx: -2, t: 0 }
  private suppressDbl = false

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
    this.selected = null
    const cx = el.x + el.w / 2
    const cy = el.y + el.h / 2
    // Parse the ACTUAL control points (exact, no re-sampling) and anchor at the
    // element centre. The stored path is relative (first point ~0,0).
    const raw = el.fx.loop.path
    const hadCurves = /[cq]/i.test(raw)
    const parsed = parseBezier(raw).nodes
    let nodes = classifyNodes(parsed, hadCurves)
    if (nodes.length < 2) {
      // synthesize a default straight line (auto) — counts as an edit
      nodes = [{ p: { x: 0, y: 0 } }, { p: { x: 160, y: 0 } }]
      this.dirty = true
    }
    // path-local → slide coords (add the element centre to points + handles)
    const shift = (p?: BPt): BPt | undefined => (p ? { x: p.x + cx, y: p.y + cy } : undefined)
    this.nodes = nodes.map((n) => ({ p: shift(n.p)!, in: shift(n.in), out: shift(n.out), manual: n.manual }))
    // per-anchor speeds (mirror node count; default uniform)
    const savedSpeeds = (el.fx.loop as { speeds?: number[] }).speeds
    this.speeds = this.nodes.map((_, i) =>
      savedSpeeds && savedSpeeds.length === this.nodes.length ? savedSpeeds[i] : 1)

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.classList.add('ed-pathedit')
    const { width, height } = this.store.doc.size
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    svg.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;overflow:visible;z-index:50`
    svg.addEventListener('dblclick', (ev) => this.onDblClick(ev))
    // click empty space to deselect (hide handles)
    svg.addEventListener('mousedown', (ev) => {
      this.suppressDbl = false // fresh gesture on empty canvas — clear any stale suppress
      if (ev.target === svg && this.selected !== null) { this.selected = null; this.draw() }
    })
    this.scaleHost.appendChild(svg)
    this.overlay = svg

    this.hint = document.createElement('div')
    this.hint.className = 'ed-setbar ed-pathbar'
    this.hint.innerHTML =
      `<span class="ed-setbar-label">${t('Motion path — drag points · click a point for bezier handles · double-click path to insert · double-click point to remove · scroll a point to change its speed')}</span>`
    const done = document.createElement('button')
    done.className = 'ed-setchip active'
    done.textContent = t('Done')
    done.addEventListener('click', () => this.commit())
    this.hint.appendChild(done)
    this.scaleHost.closest('.ed-canvas-wrap')?.appendChild(this.hint)

    this.draw()
  }

  /** Persist: element rest position ← first anchor; path stored relative as
   *  explicit cubics (byte-stable round-trip). */
  commit() {
    if (!this.overlay) return
    const el = this.store.element(this.elId)
    const nodes = this.nodes
    const dirty = this.dirty
    this.cancel()
    // Nothing was touched: keep the original path byte-for-byte (no reshape).
    if (!dirty) {
      this.onExit()
      return
    }
    if (!el || el.fx?.loop?.type !== 'motion-path' || nodes.length < 2) return
    const p0 = nodes[0].p
    // re-relativise to the first anchor, then serialize resolved cubics
    const rel: WNode[] = nodes.map((n) => ({
      p: { x: n.p.x - p0.x, y: n.p.y - p0.y },
      in: n.in && { x: n.in.x - p0.x, y: n.in.y - p0.y },
      out: n.out && { x: n.out.x - p0.x, y: n.out.y - p0.y },
      manual: n.manual,
    }))
    const relPath = nodesToPath(rel)
    this.store.commit(() => {
      const live = this.store.element(el.id)
      if (!live || live.fx?.loop?.type !== 'motion-path') return
      live.fx.loop.path = relPath
      // persist per-anchor speeds only when they actually vary (keep the model clean)
      const sp = this.speeds.slice(0, nodes.length)
      if (sp.length === nodes.length && sp.some((s) => Math.abs(s - 1) > 1e-3)) live.fx.loop.speeds = sp
      else delete live.fx.loop.speeds
      live.x = r(p0.x - live.w / 2)
      live.y = r(p0.y - live.h / 2)
    })
    this.onExit()
  }

  cancel() {
    if (!this.overlay) return
    anim.killTweensOf(this.overlay.querySelectorAll('*'))
    this.overlay.remove()
    this.overlay = null
    this.hint?.remove()
    this.hint = null
    this.selected = null
  }

  // --- rendering -------------------------------------------------------------

  private draw() {
    const svg = this.overlay
    if (!svg) return
    anim.killTweensOf(svg.querySelectorAll('.ed-pe-dot'))
    svg.innerHTML = ''
    const k = 1 / this.scale()
    // keep the speeds array aligned with the nodes (defensive)
    if (this.speeds.length !== this.nodes.length) this.speeds = this.nodes.map((_, i) => this.speeds[i] ?? 1)
    const eff = effectiveNodes(this.nodes)
    const d = serializeBezier(eff, false)

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

    // control handles for the SELECTED waypoint (revealed on demand). Auto
    // waypoints show their computed tangents; grabbing one makes it manual.
    if (this.selected !== null && this.selected < this.nodes.length) {
      const i = this.selected
      const e = eff[i]
      for (const which of ['in', 'out'] as const) {
        const h = e[which]
        if (!h) continue
        const stem = mk('line')
        stem.setAttribute('x1', String(e.p.x))
        stem.setAttribute('y1', String(e.p.y))
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
        hd.classList.add('ed-pe-handle')
        hd.style.cssText = 'cursor:crosshair;pointer-events:all'
        hd.addEventListener('mousedown', (ev) => this.dragHandle(ev, i, which))
        svg.appendChild(hd)
      }
    }

    this.nodes.forEach((n, i) => {
      const p = n.p
      const sel = i === this.selected
      // manual corner waypoints render as squares (like the shape editor)
      const dot = mk(n.manual && n.corner ? 'rect' : 'circle')
      const rad = (i === 0 ? 8 : 6.5) * k
      if (n.manual && n.corner) {
        dot.setAttribute('x', String(p.x - rad))
        dot.setAttribute('y', String(p.y - rad))
        dot.setAttribute('width', String(rad * 2))
        dot.setAttribute('height', String(rad * 2))
      } else {
        dot.setAttribute('cx', String(p.x))
        dot.setAttribute('cy', String(p.y))
        dot.setAttribute('r', String(rad))
      }
      dot.setAttribute('fill', i === 0 ? '#f7a600' : sel ? '#5b8def' : '#fff')
      dot.setAttribute('stroke', sel ? '#2f6df6' : '#31445c')
      dot.setAttribute('stroke-width', String((sel ? 2.4 : 1.6) * k))
      dot.classList.add('ed-pe-anchor')
      dot.dataset.idx = String(i)
      if (i === 0)
        dot.append(Object.assign(mk('title'), { textContent: 'Start — also the element’s rest position' }))
      dot.addEventListener('mousedown', (ev) => this.dragAnchor(ev, i))
      // scroll a point to change how fast the element moves through it
      dot.addEventListener('wheel', (ev) => {
        ev.preventDefault()
        const step = ev.deltaY < 0 ? 0.1 : -0.1
        this.speeds[i] = Math.round(Math.max(0.2, Math.min(4, (this.speeds[i] ?? 1) + step)) * 10) / 10
        this.dirty = true
        this.draw()
      })
      svg.appendChild(dot)

      // speed badge (only when it differs from normal, to avoid clutter)
      if (Math.abs((this.speeds[i] ?? 1) - 1) > 1e-3) {
        const label = mk('text')
        label.setAttribute('x', String(p.x + 11 * k))
        label.setAttribute('y', String(p.y - 9 * k))
        label.setAttribute('font-size', String(12 * k))
        label.setAttribute('font-weight', '700')
        label.setAttribute('fill', '#31445c')
        label.setAttribute('paint-order', 'stroke')
        label.setAttribute('stroke', '#fff')
        label.setAttribute('stroke-width', String(3 * k))
        label.style.pointerEvents = 'none'
        label.textContent = `${(this.speeds[i] ?? 1).toFixed(1)}×`
        svg.appendChild(label)
      }
    })

    // live preview: a dot loops the path at the element's configured speed —
    // including per-anchor variable speed and lap easing, so edits are visible
    const loop = this.store.element(this.elId)?.fx?.loop as
      | { duration?: number; ease?: string }
      | undefined
    const dur = loop?.duration ?? 3
    const preview = mk('circle')
    preview.setAttribute('r', String(4.5 * k))
    preview.setAttribute('fill', '#f7a600')
    preview.style.pointerEvents = 'none'
    preview.classList.add('ed-pe-dot')
    svg.appendChild(preview)
    anim.to(preview, {
      motionPath: { path: d, speeds: this.speeds.slice() },
      duration: Math.max(dur, 0.5),
      ease: loop?.ease ?? 'none',
      repeat: -1,
    })
  }

  // --- interaction ------------------------------------------------------------

  private toSlide(ev: MouseEvent): Pt {
    const rect = this.scaleHost.getBoundingClientRect()
    const s = this.scale()
    return { x: (ev.clientX - rect.left) / s, y: (ev.clientY - rect.top) / s }
  }

  /** Remove waypoint `idx` (keeps at least two), keeping speeds + selection aligned. */
  private removeNode(idx: number) {
    if (this.nodes.length <= 2) return
    this.nodes.splice(idx, 1)
    this.speeds.splice(idx, 1)
    if (this.selected !== null) {
      if (this.selected === idx) this.selected = null
      else if (this.selected > idx) this.selected--
    }
    this.dirty = true
    this.draw()
  }

  private dragAnchor(down: MouseEvent, idx: number) {
    down.stopPropagation()
    down.preventDefault()
    // Second mousedown on the same node within the double-click window = remove.
    // (We detect it here rather than via the DOM `dblclick`, which the
    //  select-redraw below would otherwise defeat — see `lastDown`.)
    if (idx === this.lastDown.idx && down.timeStamp - this.lastDown.t < 400) {
      this.lastDown.idx = -2
      this.suppressDbl = true // swallow the trailing DOM dblclick so it can't also insert
      this.removeNode(idx)
      return
    }
    this.lastDown = { idx, t: down.timeStamp }
    this.suppressDbl = false // fresh gesture — any stale suppress is void
    // selecting a waypoint reveals its handles
    if (this.selected !== idx) { this.selected = idx; this.draw() }
    const startPt = this.toSlide(down)
    const n = this.nodes[idx]
    const orig = { p: { ...n.p }, in: n.in && { ...n.in }, out: n.out && { ...n.out } }
    let moved = false
    let lastTs = 0
    const move = (ev: MouseEvent) => {
      const p = this.toSlide(ev)
      const dx = p.x - startPt.x
      const dy = p.y - startPt.y
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) { moved = true; this.dirty = true }
      n.p = { x: orig.p.x + dx, y: orig.p.y + dy }
      // manual handles travel rigidly with the point (auto ones recompute)
      if (n.manual) {
        if (orig.in) n.in = { x: orig.in.x + dx, y: orig.in.y + dy }
        if (orig.out) n.out = { x: orig.out.x + dx, y: orig.out.y + dy }
      }
      // first anchor = element rest position: give live feedback on the node
      if (idx === 0) {
        const el = this.store.element(this.elId)
        const node = this.scaleHost.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(this.elId)}"]`)
        if (el && node) {
          node.style.left = `${n.p.x - el.w / 2}px`
          node.style.top = `${n.p.y - el.h / 2}px`
        }
      }
      if (ev.timeStamp - lastTs > 30) {
        lastTs = ev.timeStamp
        this.draw()
      }
    }
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      // Alt-click (no drag) toggles a manual waypoint between smooth and corner
      if (!moved && ev.altKey) this.makeCorner(idx)
      this.draw()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /** Drag a control handle: the waypoint becomes MANUAL (its tangents freeze at
   *  their current auto values, then this handle moves). Smooth nodes mirror the
   *  opposite handle; Alt breaks symmetry into a corner. */
  private dragHandle(down: MouseEvent, idx: number, which: 'in' | 'out') {
    down.stopPropagation()
    down.preventDefault()
    const n = this.nodes[idx]
    if (!n.manual) {
      // bake the current auto tangents so nothing jumps, then go manual
      const a = autoHandles(this.nodes.map((m) => m.p), idx)
      n.in = a.in
      n.out = a.out
      n.manual = true
    }
    const other = which === 'in' ? 'out' : 'in'
    const oppLen = handleLen(n.p, n[other])
    const move = (ev: MouseEvent) => {
      const p = this.toSlide(ev)
      n[which] = p
      this.dirty = true
      if (ev.altKey) n.corner = true // Alt breaks smooth symmetry into a corner
      // smooth node: mirror the opposite handle's direction, keep its length
      if (!n.corner && n[other]) n[other] = mirrorHandle(n.p, p, oppLen)
      this.draw()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      this.draw()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  /** Toggle a waypoint's corner flag (making it manual first so the handles are
   *  explicit and can diverge). */
  private makeCorner(idx: number) {
    const n = this.nodes[idx]
    if (!n.manual) {
      const a = autoHandles(this.nodes.map((m) => m.p), idx)
      n.in = a.in
      n.out = a.out
      n.manual = true
    }
    n.corner = !n.corner
    this.dirty = true
  }

  private onDblClick(ev: MouseEvent) {
    ev.preventDefault()
    ev.stopPropagation()
    // A double-click that already removed a node (handled in dragAnchor) must not
    // fall through and insert a point where the node used to be.
    if (this.suppressDbl) { this.suppressDbl = false; return }
    const target = ev.target as Element
    const q = this.toSlide(ev)
    // Node removal is handled manually in dragAnchor (the select-redraw defeats a
    // DOM dblclick on the anchor); a dblclick that still lands on a node is a
    // stale target after that redraw — ignore it rather than mis-insert.
    if (target.classList.contains('ed-pe-anchor')) return
    if (target.classList.contains('ed-pe-hit')) {
      // insert on the nearest segment via de Casteljau split — the split
      // preserves the trajectory shape EXACTLY (sub-pixel), and the three
      // involved nodes become manual so their frozen handles hold that shape.
      const eff = effectiveNodes(this.nodes)
      let best = 0
      let bestT = 0.5
      let bestD = Infinity
      for (let i = 0; i < eff.length - 1; i++) {
        const a = eff[i]
        const b = eff[i + 1]
        const c1 = a.out ?? a.p
        const c2 = b.in ?? b.p
        const t = nearestT(a.p, c1, c2, b.p, q)
        const pt = cubicPoint(a.p, c1, c2, b.p, t)
        const dd = (pt.x - q.x) ** 2 + (pt.y - q.y) ** 2
        if (dd < bestD) { bestD = dd; best = i; bestT = t }
      }
      const split = splitSegment(eff[best], eff[best + 1], bestT)
      this.nodes[best] = { p: eff[best].p, in: eff[best].in, out: split.a.out, manual: true, corner: this.nodes[best].corner }
      this.nodes[best + 1] = { p: eff[best + 1].p, in: split.b.in, out: eff[best + 1].out, manual: true, corner: this.nodes[best + 1].corner }
      this.nodes.splice(best + 1, 0, { p: split.mid.p, in: split.mid.in, out: split.mid.out, manual: true })
      const sA = this.speeds[best] ?? 1
      const sB = this.speeds[best + 1] ?? sA
      this.speeds.splice(best + 1, 0, (sA + sB) / 2)
      if (this.selected !== null && this.selected > best) this.selected++
      this.dirty = true
      this.draw()
      return
    }
    // empty canvas: append an auto waypoint at the end
    this.nodes.push({ p: q })
    this.speeds.push(1)
    this.dirty = true
    this.draw()
  }
}

/** Evaluate the cubic p0→p3 (controls c1,c2) at t — for insert hit-testing. */
function cubicPoint(p0: BPt, c1: BPt, c2: BPt, p3: BPt, t: number): BPt {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
  }
}
