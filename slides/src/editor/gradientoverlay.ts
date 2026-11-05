// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// The gradient being edited shows on the canvas, Figma's way: a linear one as
// a line through the centre whose two knobs set the angle; a radial one as its
// centre knob (drag to move it) and a radius knob on a dashed ellipse. Each
// stop is a dot on that line (or radius) — drag it to move the stop. One undo
// step per drag. The layer sits in the scaled stage host and turns with the
// element, so its numbers are the element's own px; only the knobs take the
// pointer. The knobs sit inside the box, off the edge midpoints, so they never
// land on a resize handle.
//
// It shows while a gradient is BEING EDITED — its chip, its stop rows or the
// colour popover on it hold focus (they carry `data-grad-edit`, see
// gradTarget) — not whenever a gradient-filled element is selected: a fill
// stack or a stroke can each have a gradient, and the handle is for the one in
// hand. Focus moving anywhere else, or another selection, puts it away.

import type { Store } from '../store'
import type { GradientFill } from '../model'
import { gradientLineCoords, radialGeom } from '../render'
import { t } from '../i18n'

/** The gradient being edited: an element and the dotted path of its gradient
 *  (`fillGradient`, `fills.1.gradient`, `strokes.0.gradient`, `colorGradient`). */
let editing: { id: string; path: string } | null = null
let last: Parameters<typeof drawGradientOverlay> | null = null

/** The `data-grad-edit` value that marks a control as editing this gradient. */
export const gradTarget = (id: string, path: string) => `${id}|${path}`

/** Show the handle for this gradient (or put it away), and redraw. */
export function editGradient(target: string | null) {
  const [id, path] = target?.split('|') ?? []
  const next = id && path ? { id, path } : null
  if (JSON.stringify(next) === JSON.stringify(editing)) return
  editing = next
  if (last) drawGradientOverlay(...last)
}

// Focus decides: a control marked data-grad-edit takes the handle to its
// gradient; focus anywhere else puts it away. (A knob's press keeps focus where
// it is, and a panel rebuild that drops the focused control moves focus
// nowhere — neither fires a focusin, so neither hides the handle mid-edit.)
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    const marked = (e.target as Element | null)?.closest?.('[data-grad-edit]')
    editGradient(marked?.getAttribute('data-grad-edit') ?? null)
  })
}

const readAt = (obj: unknown, path: string): unknown => path.split('.').reduce<any>((cur, k) => (cur == null ? undefined : cur[k]), obj)

export function drawGradientOverlay(host: HTMLElement, store: Store, scale: () => number, busy: boolean) {
  last = [host, store, scale, busy]
  host.querySelector(':scope > .ed-grad-layer')?.remove()
  const sel = store.selectedElements
  const el = sel.length === 1 ? sel[0] : undefined
  if (editing && editing.id !== el?.id) editing = null // another selection: the edit is over
  const path = editing?.path
  const g = path ? readAt(el, path) as GradientFill | undefined : undefined
  if (busy || !el || el.locked || !path || !g?.stops?.length) return
  const { w, h } = el
  const layer = document.createElement('div')
  layer.className = 'ed-grad-layer'
  layer.style.cssText = `position:absolute;left:${el.x}px;top:${el.y}px;width:${w}px;height:${h}px;pointer-events:none;transform:rotate(${el.rotation || 0}deg)`
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'ed-grad-lines')
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible'
  layer.appendChild(svg)
  const k = 1 / (scale() || 1) // screen px → slide px, for knob sizes
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    for (const [a, v] of Object.entries({ x1, y1, x2, y2 })) l.setAttribute(a, String(v))
    l.setAttribute('stroke-width', String(1.5 * k))
    svg.appendChild(l)
  }

  // pointer → a point in the element's own box, as fractions (rotation undone)
  const local = (e: PointerEvent) => {
    const r = host.getBoundingClientRect()
    const sx = (e.clientX - r.left) / (scale() || 1), sy = (e.clientY - r.top) / (scale() || 1)
    const cx = el.x + w / 2, cy = el.y + h / 2
    const a = -((el.rotation || 0) * Math.PI) / 180
    const dx = sx - cx, dy = sy - cy
    return { fx: (dx * Math.cos(a) - dy * Math.sin(a)) / (w || 1) + 0.5, fy: (dx * Math.sin(a) + dy * Math.cos(a)) / (h || 1) + 0.5 }
  }
  const knob = (fx: number, fy: number, name: string, drag: (p: { fx: number; fy: number }) => void, stop?: string) => {
    const b = document.createElement('div')
    b.className = stop ? 'ed-grad-knob ed-grad-stop' : 'ed-grad-knob'
    b.title = t(name)
    if (stop) b.style.background = stop
    const size = (stop ? 10 : 12) * k
    Object.assign(b.style, { left: `${fx * w - size / 2}px`, top: `${fy * h - size / 2}px`, width: `${size}px`, height: `${size}px`, borderWidth: `${2 * k}px` })
    b.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return
      ev.preventDefault(); ev.stopPropagation()
      let moved = false
      const move = (e: PointerEvent) => {
        if (!live()) return
        if (!moved) { store.checkpoint(); moved = true } // one undo step for the whole drag
        drag(local(e))
        store.touch()
      }
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    })
    layer.appendChild(b)
  }
  function live() { return readAt(store.element(el!.id), path!) as GradientFill }
  const round = (v: number) => Math.round(v * 1000) / 1000
  // The stops as dots on a rail beside the ramp (from `ramp(g)[0]` at 0 to
  // `[1]` at 1, box fractions): offset 14 screen px to one side, so the 0 and
  // 1 dots never sit on a resize handle or the angle knobs. A drag projects
  // the pointer onto the ramp in px (the box need not be square).
  type Pt = { fx: number; fy: number }
  const stopKnobs = (ramp: (g: GradientFill) => [Pt, Pt]) => {
    const [p0, p1] = ramp(g)
    const dx = (p1.fx - p0.fx) * w, dy = (p1.fy - p0.fy) * h
    const len = Math.hypot(dx, dy) || 1
    const ox = (-dy / len) * 14 * k, oy = (dx / len) * 14 * k
    line(p0.fx * w + ox, p0.fy * h + oy, p1.fx * w + ox, p1.fy * h + oy)
    g.stops.forEach((st, i) => {
      const u = st.at
      knob(p0.fx + (p1.fx - p0.fx) * u + ox / (w || 1), p0.fy + (p1.fy - p0.fy) * u + oy / (h || 1), 'Gradient stop', ({ fx, fy }) => {
        const lg = live()
        const [a0, a1] = ramp(lg)
        const vx = (a1.fx - a0.fx) * w, vy = (a1.fy - a0.fy) * h
        const t = (((fx - a0.fx) * w) * vx + ((fy - a0.fy) * h) * vy) / ((vx * vx + vy * vy) || 1)
        if (lg.stops[i]) lg.stops[i].at = round(Math.min(Math.max(t, 0), 1))
      }, st.color)
    })
  }

  if (g.kind === 'radial') {
    const { cx, cy, r } = radialGeom(g)
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse')
    for (const [a, v] of Object.entries({ cx: cx * w, cy: cy * h, rx: r * w, ry: r * h })) ring.setAttribute(a, String(v))
    ring.setAttribute('stroke-width', String(1.5 * k))
    ring.setAttribute('stroke-dasharray', `${4 * k} ${3 * k}`)
    svg.appendChild(ring)
    const D = Math.SQRT1_2 // the radius knob sits up-right of the centre, never on an edge handle
    line(cx * w, cy * h, (cx + r * D) * w, (cy - r * D) * h)
    knob(cx, cy, 'Gradient centre', ({ fx, fy }) => { const lg = live(); lg.cx = round(fx); lg.cy = round(fy) })
    knob(cx + r * D, cy - r * D, 'Gradient radius', ({ fx, fy }) => {
      const lg = live(), c = radialGeom(lg)
      lg.r = round(Math.max(Math.hypot(fx - c.cx, fy - c.cy), 0.02))
    })
    // the stops ride the radius out to the down-left, clear of the radius knob
    stopKnobs((lg) => {
      const c = radialGeom(lg)
      return [{ fx: c.cx, fy: c.cy }, { fx: c.cx - c.r * D, fy: c.cy + c.r * D }]
    })
  } else {
    // the knobs at 20% and 80% of the gradient line: dragging either aims it
    const { x1, y1, x2, y2 } = gradientLineCoords(g.angle)
    const at = (u: number) => ({ fx: x1 + (x2 - x1) * u, fy: y1 + (y2 - y1) * u })
    const a = at(0.2), b = at(0.8)
    line(x1 * w, y1 * h, x2 * w, y2 * h)
    const aim = (end: 1 | -1) => ({ fx, fy }: { fx: number; fy: number }) => {
      // CSS angle: 0deg points up, 90deg right — from the centre to the knob
      const deg = (Math.atan2((fx - 0.5) * end, -(fy - 0.5) * end) * 180) / Math.PI
      live().angle = Math.round((deg + 360) % 360)
    }
    knob(a.fx, a.fy, 'Gradient start', aim(-1))
    knob(b.fx, b.fy, 'Gradient end', aim(1))
    // the stops beside the line, start to end
    stopKnobs((lg) => {
      const c = gradientLineCoords(lg.angle)
      return [{ fx: c.x1, fy: c.y1 }, { fx: c.x2, fy: c.y2 }]
    })
  }
  host.appendChild(layer)
}
