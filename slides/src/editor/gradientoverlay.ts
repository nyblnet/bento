// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A selected shape or text box with a gradient fill shows its gradient on the
// canvas, Figma's way: a linear one as a line through the centre whose two
// knobs set the angle; a radial one as its centre knob (drag to move it) and
// a radius knob on a dashed ellipse. One undo step per drag. The layer sits in
// the scaled stage host and turns with the element, so its numbers are the
// element's own px; only the knobs take the pointer. The knobs sit inside
// the box, off the edge midpoints, so they never land on a resize handle.

import type { Store } from '../store'
import type { GradientFill, SlideElement } from '../model'
import { gradientLineCoords, radialGeom } from '../render'
import { t } from '../i18n'

/** The gradient a selected element is filled with, and where it lives. */
function gradientOf(el: SlideElement | undefined): { g: GradientFill; key: 'fillGradient' | 'colorGradient' } | null {
  if (el?.type === 'shape' && el.shape !== 'line' && el.fillGradient?.stops?.length) return { g: el.fillGradient, key: 'fillGradient' }
  if (el?.type === 'text' && el.colorGradient?.stops?.length) return { g: el.colorGradient, key: 'colorGradient' }
  return null
}

export function drawGradientOverlay(host: HTMLElement, store: Store, scale: () => number, busy: boolean) {
  host.querySelector(':scope > .ed-grad-layer')?.remove()
  const sel = store.selectedElements
  const el = sel.length === 1 ? sel[0] : undefined
  const found = gradientOf(el)
  if (busy || !el || el.locked || !found) return
  const { g, key } = found
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
  const knob = (fx: number, fy: number, name: string, drag: (p: { fx: number; fy: number }) => void) => {
    const b = document.createElement('div')
    b.className = 'ed-grad-knob'
    b.title = t(name)
    const size = 12 * k
    Object.assign(b.style, { left: `${fx * w - size / 2}px`, top: `${fy * h - size / 2}px`, width: `${size}px`, height: `${size}px`, borderWidth: `${2 * k}px` })
    b.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return
      ev.preventDefault(); ev.stopPropagation()
      let moved = false
      const move = (e: PointerEvent) => {
        const live = store.element(el.id) as unknown as Record<string, GradientFill | undefined> | undefined
        if (!live?.[key]) return
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
  const live = () => (store.element(el.id) as unknown as Record<string, GradientFill>)[key]
  const round = (v: number) => Math.round(v * 1000) / 1000

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
  }
  host.appendChild(layer)
}
