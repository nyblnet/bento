// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/** Layers panel — the DOM half. The decisions (rows, labels, the move as the
 *  Order buttons make it, the highlight) live in layerrows.ts; read its
 *  header for what this is and where it sits. */

import type { Slide, SlideElement } from '../model'
import { ICONS } from '../icons'
import { t } from '../i18n'
import { layerRows, moveInPaintOrder, highlighted, type LayerRow } from './layerrows'
export { excerpt, labelFor, layerRows, moveInPaintOrder, highlighted, type LayerRow } from './layerrows'

/** The store surface the list needs — narrow so the rig never needs one. */
export interface LayersHost {
  slide: () => Pick<Slide, 'elements'>
  selection: () => readonly string[]
  select: (ids: string[]) => void
  /** commit a new paint order as one undo step */
  setOrder: (elements: SlideElement[]) => void
}

const GLYPH: Partial<Record<SlideElement['type'], string>> = {
  text: ICONS.text, shape: ICONS.shapes, image: ICONS.image, chart: ICONS.chart, table: ICONS.table,
  code: ICONS.code, media: ICONS.media, svg: ICONS.freeform, embed: ICONS.window,
}

export class LayersUI {
  private list: HTMLElement
  private dragId: string | null = null

  constructor(private host: LayersHost) {
    this.list = document.createElement('div')
    this.list.className = 'ed-layers'
    this.list.tabIndex = 0
    this.list.setAttribute('role', 'listbox')
    this.list.addEventListener('keydown', (ev) => this.onKey(ev))
  }

  /** Append the section (header + list) to a panel host. */
  mount(into: HTMLElement) {
    const h = document.createElement('h3')
    h.className = 'ed-section'
    h.textContent = t('Layers')
    into.appendChild(h)
    into.appendChild(this.list)
    this.refresh()
  }

  refresh() {
    this.list.innerHTML = ''
    const rows = layerRows(this.host.slide(), t)
    const lit = highlighted(rows, this.host.selection())
    if (!rows.length) {
      const empty = document.createElement('p')
      empty.className = 'ed-hint'
      empty.textContent = t('Nothing on this slide yet.')
      this.list.appendChild(empty)
      return
    }
    for (const r of rows) {
      const row = document.createElement('div')
      row.className = 'ed-layer' + (lit.has(r.id) ? ' sel' : '') + (r.grouped ? ' grouped' : '')
      row.dataset.id = r.id
      row.draggable = true
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', lit.has(r.id) ? 'true' : 'false')
      const glyph = document.createElement('span')
      glyph.className = 'ed-layer-glyph'
      glyph.innerHTML = GLYPH[r.type] ?? ''
      if (!GLYPH[r.type]) glyph.textContent = r.type.charAt(0).toUpperCase()
      const label = document.createElement('span')
      label.className = 'ed-layer-label'
      label.textContent = r.label
      row.append(glyph, label)
      row.title = r.label
      row.addEventListener('click', (ev) => this.onClick(ev, r))
      row.addEventListener('dragstart', (ev) => {
        this.dragId = r.id
        ev.dataTransfer?.setData('text/plain', r.id)
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
        row.classList.add('dragging')
      })
      row.addEventListener('dragend', () => { this.dragId = null; this.clearDropMarks() })
      row.addEventListener('dragover', (ev) => {
        if (!this.dragId || this.dragId === r.id) return
        ev.preventDefault()
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
        this.clearDropMarks()
        row.classList.add(this.dropAbove(ev, row) ? 'drop-above' : 'drop-below')
      })
      row.addEventListener('drop', (ev) => {
        ev.preventDefault()
        const id = this.dragId ?? ev.dataTransfer?.getData('text/plain')
        this.clearDropMarks()
        if (!id || id === r.id) return
        this.dropOn(id, r, this.dropAbove(ev, row))
      })
      this.list.appendChild(row)
    }
  }

  private dropAbove(ev: DragEvent, row: HTMLElement): boolean {
    const b = row.getBoundingClientRect()
    return ev.clientY < b.top + b.height / 2
  }

  private clearDropMarks() {
    for (const n of this.list.querySelectorAll('.drop-above, .drop-below, .dragging')) n.classList.remove('drop-above', 'drop-below', 'dragging')
  }

  /** Drop `id` above or below row `r` (rows are top-first, paint index runs
   *  the other way): above the top row = front; below the bottom row = back. */
  private dropOn(id: string, r: LayerRow, above: boolean) {
    const elements = this.host.slide().elements as SlideElement[]
    const moving = elements.find((e) => e.id === id)
    if (!moving) return
    const from = elements.indexOf(moving)
    // target paint index: above row r means "just after r in paint order"
    let to = above ? r.index + 1 : r.index
    if (from < to) to -= 1
    this.move(id, to)
  }

  private move(id: string, to: number) {
    const elements = this.host.slide().elements as SlideElement[]
    const next = moveInPaintOrder(elements, id, to)
    if (next === elements) return
    // the commit rebuilds the panel (the list is re-mounted); keep the keys
    // working by handing focus back to the re-attached node
    const had = document.activeElement === this.list
    this.host.setOrder(next)
    this.refresh()
    if (had) this.list.focus({ preventScroll: true })
  }

  private onClick(ev: MouseEvent, r: LayerRow) {
    const elements = this.host.slide().elements
    // the canvas selects a whole group on click and reaches a member with Alt
    const unit = r.groupId && !ev.altKey ? elements.filter((e) => e.groupId === r.groupId).map((e) => e.id) : [r.id]
    const cur = [...this.host.selection()]
    if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
      const has = unit.every((id) => cur.includes(id))
      this.host.select(has ? cur.filter((id) => !unit.includes(id)) : [...cur.filter((id) => !unit.includes(id)), ...unit])
    } else this.host.select(unit)
    this.list.focus({ preventScroll: true })
  }

  private onKey(ev: KeyboardEvent) {
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return
    const rows = layerRows(this.host.slide())
    if (!rows.length) return
    const sel = this.host.selection()
    const dir = ev.key === 'ArrowUp' ? -1 : 1
    ev.preventDefault()
    ev.stopPropagation()
    if (ev.metaKey || ev.ctrlKey) {
      // ⌘↑ = up the stack = toward the front = paint index + 1
      const id = sel[0]
      if (!id) return
      const el = rows.find((r) => r.id === id)
      if (el) this.move(id, el.index - dir)
      return
    }
    const at = rows.findIndex((r) => r.id === sel[0])
    const next = rows[Math.max(0, Math.min(rows.length - 1, (at < 0 ? (dir > 0 ? -1 : rows.length) : at) + dir))]
    if (next) {
      const unit = next.groupId ? this.host.slide().elements.filter((e) => e.groupId === next.groupId).map((e) => e.id) : [next.id]
      this.host.select(unit)
    }
  }
}
