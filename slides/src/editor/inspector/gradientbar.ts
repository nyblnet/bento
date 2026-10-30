// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// A gradient's stops on a bar — shared by the inspector's Fill section and the colour popover.
import type { GradientFill } from '../../model'
import { parseColor, combineColor } from './controls'
import { cssColor, cssLinearGradient } from '../../render'
import { t } from '../../i18n'

/** A gradient's colour at `at` (0..1), linear between stops — for a new stop. */
export function colorAt(stops: GradientFill['stops'], at: number): string {
  const s = [...stops].sort((a, b) => a.at - b.at)
  const j = s.findIndex((x) => x.at >= at)
  if (j <= 0) return s[Math.max(j, 0)]?.color ?? s.at(-1)!.color
  const a = s[j - 1], b = s[j], k = (at - a.at) / ((b.at - a.at) || 1)
  const A = parseColor(a.color), B = parseColor(b.color)
  const ch = (i: number) => Math.round(parseInt(A.hex.slice(i, i + 2), 16) * (1 - k) + parseInt(B.hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')
  return combineColor(`#${ch(1)}${ch(3)}${ch(5)}`, A.a * (1 - k) + B.a * k)
}

/**
 * The stops on a bar, Figma's: the gradient drawn left to right, a handle per
 * stop. Drag a handle to move its stop, click the bar to add one (in the
 * colour already there), Backspace removes the focused one (two always stay).
 * `selected` is the stop being edited; `onSelect` hears a press on a handle.
 */
export function gradientBar(live: GradientFill, edit: (fn: (g: GradientFill) => void, final: boolean) => void, selected = 0, onSelect: (i: number) => void = () => {}): HTMLElement {
  // a copy to draw from while dragging: the model changes only through `edit`
  const grad: GradientFill = { ...live, stops: live.stops.map((st) => ({ ...st })) }
  const bar = document.createElement('div')
  bar.className = 'ed-gradbar'
  bar.setAttribute('role', 'group')
  bar.setAttribute('aria-label', t('Gradient stops'))
  const paint = () => { bar.style.setProperty('--grad', cssLinearGradient({ angle: 90, stops: grad.stops })) }
  paint()
  const at = (clientX: number) => {
    const r = bar.getBoundingClientRect()
    return Math.min(Math.max((clientX - r.left) / (r.width || 1), 0), 1)
  }
  const handles: HTMLButtonElement[] = []
  const place = () => grad.stops.forEach((st, i) => {
    const h = handles[i]
    if (!h) return
    h.style.left = `${st.at * 100}%`
    h.style.setProperty('--c', cssColor(st.color, 'transparent'))
    h.classList.toggle('is-on', i === selected)
    h.setAttribute('aria-pressed', String(i === selected))
  })
  grad.stops.forEach((_st, i) => {
    const h = document.createElement('button')
    h.type = 'button'
    h.className = 'ed-gradbar-stop'
    h.title = t('Stop {n}', { n: i + 1 })
    h.setAttribute('aria-label', h.title)
    h.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault(); e.stopPropagation()
      selected = i
      onSelect(i)
      h.focus({ preventScroll: true })
      let moved = false
      const move = (m: PointerEvent) => {
        const v = Math.round(at(m.clientX) * 100) / 100
        if (!moved && Math.abs(m.clientX - e.clientX) < 2) return
        moved = true
        grad.stops[i].at = v
        edit((g) => { if (g.stops[i]) g.stops[i].at = v }, false)
        paint(); place()
      }
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up)
        if (moved) edit((g) => { if (g.stops[i]) g.stops[i].at = grad.stops[i].at }, true)
        place()
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    })
    h.addEventListener('keydown', (e) => {
      if ((e.key === 'Backspace' || e.key === 'Delete') && grad.stops.length > 2) {
        e.preventDefault(); e.stopPropagation() // not the canvas's Delete
        edit((g) => { if (g.stops.length > 2) g.stops.splice(i, 1) }, true)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault(); e.stopPropagation()
        const v = Math.min(Math.max(grad.stops[i].at + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01), 0), 1)
        grad.stops[i].at = Math.round(v * 100) / 100
        edit((g) => { if (g.stops[i]) g.stops[i].at = grad.stops[i].at }, true)
        paint(); place()
      }
    })
    handles.push(h)
    bar.appendChild(h)
  })
  place()
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target !== bar) return
    const v = Math.round(at(e.clientX) * 100) / 100
    const c = colorAt(grad.stops, v)
    edit((g) => { g.stops.push({ at: v, color: c }); g.stops.sort((a, b) => a.at - b.at) }, true)
  })
  return bar
}
