// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// A selected auto-layout frame shows its padding and gaps on the canvas as
// pink bands (Figma's), and dragging a band changes that padding or gap, one
// undo step per drag. Lives in the scaled stage host, so its coordinates are
// slide px; only the bands take the pointer.

import type { Store } from '../store'
import { frameChildren, isFrame } from '../layout'
import { t } from '../i18n'

export function drawFrameOverlay(host: HTMLElement, store: Store, scale: () => number, busy: boolean) {
  host.querySelector(':scope > .ed-frame-layer')?.remove()
  const sel = store.selectedElements
  const f = sel.length === 1 ? sel[0] : undefined
  if (busy || !isFrame(f)) return
  const layer = document.createElement('div')
  layer.className = 'ed-frame-layer'
  layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none'
  const L = f.layout
  const band = (x: number, y: number, w: number, h: number, axis: 'x' | 'y', name: string, get: () => number, put: (v: number) => void, sign = 1) => {
    if (w <= 0 || h <= 0) return
    const b = document.createElement('div')
    b.className = 'ed-frame-band'
    b.dataset.axis = axis
    b.title = t(name)
    Object.assign(b.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` })
    b.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return
      ev.preventDefault(); ev.stopPropagation()
      const start = axis === 'x' ? ev.clientX : ev.clientY
      const v0 = get()
      let moved = false
      const move = (e: PointerEvent) => {
        const v = Math.max(0, Math.round(v0 + sign * ((axis === 'x' ? e.clientX : e.clientY) - start) / (scale() || 1)))
        if (v === get()) return
        if (!moved) { store.checkpoint(); moved = true } // one undo step for the whole drag
        put(v)
        store.touch()
      }
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up) }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    })
    layer.appendChild(b)
  }
  const [pt, pr, pb, pl] = L.pad
  const live = () => store.element(f.id) as typeof f | undefined
  const pad = (i: number) => [() => live()?.layout.pad[i] ?? 0, (v: number) => { const e = live(); if (e) e.layout.pad[i] = v }] as const
  band(f.x, f.y, f.w, pt, 'y', 'Top padding', ...pad(0))
  band(f.x + f.w - pr, f.y, pr, f.h, 'x', 'Right padding', ...pad(1), -1)
  band(f.x, f.y + f.h - pb, f.w, pb, 'y', 'Bottom padding', ...pad(2), -1)
  band(f.x, f.y, pl, f.h, 'x', 'Left padding', ...pad(3))
  if (L.dir !== 'grid' && L.gap > 0) {
    const kids = frameChildren(store.slide, f)
    const gap = [() => live()?.layout.gap ?? 0, (v: number) => { const e = live(); if (e) e.layout.gap = v }] as const
    for (let i = 0; i + 1 < kids.length; i++) {
      const a = kids[i], b = kids[i + 1]
      if (L.dir === 'row') band(a.x + a.w, f.y + pt, b.x - a.x - a.w, f.h - pt - pb, 'x', 'Gap', ...gap)
      else band(f.x + pl, a.y + a.h, f.w - pl - pr, b.y - a.y - a.h, 'y', 'Gap', ...gap)
    }
  }
  host.appendChild(layer)
}
