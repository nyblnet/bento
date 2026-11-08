// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Speaker chrome only: proportions and visibility never enter the document.
import { t } from './i18n'

// Keep the presenter's choices across shows in this editor, including when the
// editor-owned popup is repainted with its idle placeholder between shows.
const layout = { current: true, next: true, notes: true, rail: true, columns: 0.6, rows: null as number | null }

export function setupSpeakerLayout(w: Window): () => void {
  const d = w.document
  const main = d.querySelector<HTMLElement>('.sv-main')!
  const current = d.querySelector<HTMLElement>('.sv-current')!
  const side = d.querySelector<HTMLElement>('.sv-side')!
  const next = d.querySelector<HTMLElement>('.sv-next-wrap')!
  const notes = d.querySelector<HTMLElement>('.sv-notes-wrap')!
  const rail = d.querySelector<HTMLElement>('.sv-rail')!
  const view = d.querySelector<HTMLDetailsElement>('.sv-view')!

  const separator = (parent: HTMLElement, before: HTMLElement, vertical: boolean, label: string, controls: string) => {
    const el = d.createElement('div')
    el.className = `sv-splitter sv-splitter-${vertical ? 'columns' : 'rows'}`
    el.tabIndex = 0
    el.setAttribute('role', 'separator')
    el.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal')
    el.setAttribute('aria-label', label)
    el.setAttribute('aria-controls', controls)
    el.title = label
    parent.insertBefore(el, before)
    return el
  }
  const columns = separator(main, side, true, t('Resize slide previews'), 'sv-current sv-side')
  const rows = separator(side, notes, false,
    t('Resize next slide and notes'), 'sv-next sv-notes')

  const apply = () => {
    const hasSide = layout.next || layout.notes
    current.hidden = !layout.current
    side.hidden = !hasSide
    next.hidden = !layout.next
    notes.hidden = !layout.notes
    columns.hidden = !layout.current || !hasSide
    rows.hidden = !layout.next || !layout.notes
    rail.hidden = !layout.rail
    main.classList.toggle('sv-single-pane', !layout.current || !hasSide)
    side.classList.toggle('sv-single-pane', !layout.next || !layout.notes)
    main.style.gridTemplateColumns = layout.current && hasSide
      ? `minmax(0, ${layout.columns}fr) 22px minmax(0, ${1 - layout.columns}fr)` : ''
    side.style.gridTemplateRows = layout.next && layout.notes && layout.rows !== null
      ? `minmax(0, ${layout.rows}fr) 16px minmax(0, ${1 - layout.rows}fr)` : ''
    view.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      input.checked = layout[input.value as 'current' | 'next' | 'notes' | 'rail']
    })
  }

  const bind = (handle: HTMLElement, vertical: boolean) => {
    const container = vertical ? main : side
    const pane = vertical ? current : next
    const available = () => {
      const box = container.getBoundingClientRect()
      const style = w.getComputedStyle(container)
      return vertical
        ? box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - handle.offsetWidth
        : box.height - handle.offsetHeight
    }
    // On a small window the minimum shrinks with the available space, so the
    // split cannot push notes or previews out of the viewport.
    const bounds = () => {
      const size = Math.max(1, available())
      return vertical
        ? [Math.min(160 / size, 0.4), 1 - Math.min(160 / size, 0.4)]
        : [Math.min(54 / size, 0.3), 1 - Math.min(96 / size, 0.4)]
    }
    const value = () => (vertical ? pane.offsetWidth : pane.offsetHeight) / Math.max(1, available())
    const updateAria = () => {
      const [min, max] = bounds()
      handle.setAttribute('aria-valuemin', String(Math.round(min * 100)))
      handle.setAttribute('aria-valuemax', String(Math.round(max * 100)))
      handle.setAttribute('aria-valuenow', String(Math.round(value() * 100)))
    }
    const set = (ratio: number) => {
      const [min, max] = bounds()
      const clamped = Math.min(max, Math.max(min, ratio))
      if (vertical) layout.columns = clamped
      else layout.rows = clamped
      apply()
      updateAria()
    }
    let drag: { id: number; start: number; ratio: number; size: number } | null = null
    handle.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || drag) return
      ev.preventDefault()
      handle.focus()
      drag = { id: ev.pointerId, start: vertical ? ev.clientX : ev.clientY, ratio: value(), size: available() }
      handle.setPointerCapture(ev.pointerId)
      d.body.classList.add('sv-resizing')
    })
    handle.addEventListener('pointermove', (ev) => {
      if (!drag || drag.id !== ev.pointerId || drag.size <= 0) return
      const delta = (vertical ? ev.clientX : ev.clientY) - drag.start
      set(drag.ratio + delta / drag.size)
    })
    const end = (ev: PointerEvent) => {
      if (drag?.id !== ev.pointerId) return
      drag = null
      d.body.classList.remove('sv-resizing')
      if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId)
    }
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
    handle.addEventListener('lostpointercapture', end)
    handle.addEventListener('keydown', (ev) => {
      // These keys belong to the focused splitter, never to slide navigation.
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(ev.key)) ev.stopPropagation()
      const delta = ev.key === (vertical ? 'ArrowRight' : 'ArrowDown') ? 0.025
        : ev.key === (vertical ? 'ArrowLeft' : 'ArrowUp') ? -0.025 : 0
      if (delta || ev.key === 'Home' || ev.key === 'End') {
        ev.preventDefault()
        set(ev.key === 'Home' ? 0 : ev.key === 'End' ? 1 : value() + delta)
      }
    })
    return () => {
      if (handle.hidden) return
      const ratio = value()
      const [min, max] = bounds()
      // Reapply the bounds when the popup shrinks too, not only while the
      // presenter drags. A split chosen on a large screen must stay usable.
      if (ratio < min - 0.005 || ratio > max + 0.005) set(ratio)
      else updateAria()
    }
  }
  const updateColumns = bind(columns, true)
  const updateRows = bind(rows, false)
  view.addEventListener('change', () => {
    view.querySelectorAll<HTMLInputElement>('input').forEach((input) => {
      layout[input.value as 'current' | 'next' | 'notes' | 'rail'] = input.checked
    })
    apply()
  })
  view.addEventListener('keydown', (ev) => {
    // Keys stay in View only while it is open, or when they would toggle it.
    // Focus stays on the summary after closing, and the presenter's clicker
    // keys must reach the show from there.
    if (view.open || ev.key === ' ' || ev.key === 'Enter') ev.stopPropagation()
    if (ev.key === 'Escape') {
      view.open = false
      view.querySelector('summary')?.focus()
      ev.preventDefault()
    }
  })
  const outside = (ev: MouseEvent) => { if (!view.contains(ev.target as Node)) view.open = false }
  d.addEventListener('click', outside)
  const observer = new ResizeObserver(() => { updateColumns(); updateRows() })
  observer.observe(main)
  observer.observe(next)
  apply()
  const cleanup = () => {
    observer.disconnect()
    d.removeEventListener('click', outside)
    d.body.classList.remove('sv-resizing')
    w.removeEventListener('pagehide', cleanup)
  }
  w.addEventListener('pagehide', cleanup)
  return cleanup
}
