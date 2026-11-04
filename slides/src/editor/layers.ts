// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/** Layers panel — the DOM half. The decisions (rows, labels, the move as the
 *  Order buttons make it, the highlight) live in layerrows.ts; read its
 *  header for what this is and where it sits. */

import type { Slide, SlideElement } from '../model'
import { ICONS } from '../icons'
import { t } from '../i18n'
import { canAccept, frameChildren, isFrame } from '../layout'
import { layerRows, moveInPaintOrder, highlighted, wholeGroups, rowSignature, signatureDiff, type LayerRow } from './layerrows'
export { excerpt, labelFor, labelIn, layerRows, moveInPaintOrder, highlighted, rowSignature, signatureDiff, type LayerRow } from './layerrows'

/** The store surface the list needs — narrow so the rig never needs one. */
export interface LayersHost {
  slide: () => Pick<Slide, 'elements'>
  selection: () => readonly string[]
  select: (ids: string[]) => void
  /** commit a new paint order as one undo step */
  setOrder: (elements: SlideElement[]) => void
  /** name an element, as one undo step; '' gives it back its default name */
  rename: (id: string, name: string) => void
  /** name a group, on all its members, as one undo step */
  renameGroup: (groupId: string, name: string) => void
  /** a read-only document offers no renaming */
  readOnly?: () => boolean
  /** put elements inside a frame at a slot, or beside an element (taking
   *  them out of their frames), as one undo step */
  reparent?: (ids: string[], to: { frame: string; slot: number } | { beside: string; above: boolean }) => void
  /** flip `locked` or `hidden` on elements, as one undo step: all on unless
   *  every one already is (a group row acts on its members like this) */
  toggle?: (ids: string[], key: 'locked' | 'hidden') => void
  /** ids on this slide that morph from an element on the slide before */
  paired?: () => ReadonlySet<string>
}

/** the element kinds' glyphs, shared with the inspector's context line */
export const GLYPH: Partial<Record<SlideElement['type'], string>> = {
  text: ICONS.text, shape: ICONS.shapes, image: ICONS.image, chart: ICONS.chart, table: ICONS.table,
  code: ICONS.code, media: ICONS.media, svg: ICONS.freeform, embed: ICONS.window,
}

export class LayersUI {
  private list: HTMLElement
  private header: HTMLElement
  private dragId: string | null = null
  /** everything a drag carries: the dragged row, or the whole selection when
   *  the row is part of it (a group row carries its members) */
  private dragIds: string[] = []
  /** what the rows on screen were built from — see layerrows.ts rowSignature */
  private sig: ReturnType<typeof rowSignature> | null = null
  /** groups folded to their one row (by groupId, for the session) */
  private folded = new Set<string>()

  constructor(private host: LayersHost) {
    this.list = document.createElement('div')
    this.list.className = 'ed-layers'
    this.list.tabIndex = 0
    this.list.setAttribute('role', 'listbox')
    this.list.addEventListener('keydown', (ev) => this.onKey(ev))
    // ONE header node for the life of the panel, like the list: the accordion
    // retrofit keys its open state and its click handler off this element.
    this.header = document.createElement('h3')
    this.header.className = 'ed-section'
    this.header.textContent = t('Layers')
  }

  /** Append the section (header + list) to its host — once: the side
   *  column's Layers view (editor.ts). Rows are only rebuilt when they
   *  changed (refresh). */
  mount(into: HTMLElement) {
    this.header.textContent = t('Layers')
    into.appendChild(this.header)
    into.appendChild(this.list)
    this.refresh()
  }

  /** Bring the rows up to date, touching as little as the change needs:
   *  nothing for a move/resize, label text for a content edit, the rows for
   *  an order or membership change; the highlight always, in place. */
  refresh() {
    const next = rowSignature(this.host.slide(), t, this.host.paired?.())
    const diff = signatureDiff(this.sig, next)
    this.sig = next
    if (diff === 'same') { this.highlight(); return }
    if (diff === 'labels') {
      for (const r of layerRows(this.host.slide(), t, this.host.paired?.())) {
        const node = this.rowNode(r.id)
        const label = node?.querySelector<HTMLElement>('.ed-layer-label')
        if (node && label && label.textContent !== r.label) { label.textContent = r.label; node.title = r.label }
      }
      this.highlight()
      return
    }
    this.rebuildRows()
  }

  /** Rename in place, as Penpot and Figma do: the row's label becomes a
   *  field; Enter or leaving it keeps the name, Escape keeps the old one, an
   *  empty name gives the default back. Double-click a row, or Rename on its
   *  right-click menu. */
  rename(id: string, typed?: string) {
    if (this.host.readOnly?.()) return
    const el = this.host.slide().elements.find((e) => e.id === id)
    // a member of a folded group has no row to edit until the group opens
    if (el?.groupId && this.folded.delete(el.groupId)) this.rebuildRows()
    this.editLabel({ id }, this.rowNode(id), el?.name, (name) => this.host.rename(id, name), typed)
  }

  /** Rename a group — its row's label, named on every member. */
  renameGroup(gid: string, typed?: string) {
    if (this.host.readOnly?.()) return
    const row = this.list.querySelector<HTMLElement>(`.ed-layer-group[data-group="${CSS.escape(gid)}"]`)
    this.editLabel({ gid }, row, this.host.slide().elements.find((e) => e.groupId === gid)?.groupName, (name) => this.host.renameGroup(gid, name), typed)
  }

  /** The rename in progress, if any: what it edits and what has been typed —
   *  so a rebuild of the rows (an undo, a collaborator's edit) can put the
   *  field back on the new row instead of throwing the typing away. */
  private renaming: { target: { id?: string; gid?: string }; input: HTMLInputElement; drop: () => void } | null = null

  private editLabel(target: { id?: string; gid?: string }, row: HTMLElement | null, current: string | undefined, save: (name: string) => void, typed?: string) {
    const label = row?.querySelector<HTMLElement>('.ed-layer-label')
    if (!row || !label) return
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'ed-layer-rename'
    input.value = typed ?? current ?? label.textContent ?? ''
    input.setAttribute('aria-label', t('Rename'))
    row.draggable = false
    label.replaceWith(input)
    input.focus()
    if (typed === undefined) input.select()
    let done = false
    const finish = (keep: boolean, refocus: boolean) => {
      if (done) return
      done = true
      this.renaming = null
      const name = input.value.trim()
      input.replaceWith(label)
      row.draggable = true
      if (keep && name !== (current ?? label.textContent)) save(name)
      // back to the list only when the field was left with a key: a click
      // elsewhere put the focus where the author wants it — taking it back
      // sent the next Backspace to the list, which deletes the element
      if (refocus) this.list.focus({ preventScroll: true })
    }
    this.renaming = { target, input, drop: () => { done = true; this.renaming = null } }
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation() // the list's arrows and Delete are not this field's
      if (ev.key === 'Enter') finish(true, true)
      if (ev.key === 'Escape') finish(false, true)
    })
    input.addEventListener('blur', () => finish(true, false))
    input.addEventListener('click', (ev) => ev.stopPropagation())
  }

  private rowNode(id: string): HTMLElement | null {
    for (const n of this.list.children) if ((n as HTMLElement).dataset.id === id) return n as HTMLElement
    return null
  }

  /** Selection changed: classes only, no DOM churn. */
  private highlight() {
    const rows = layerRows(this.host.slide(), t, this.host.paired?.())
    const lit = highlighted(rows, this.host.selection())
    const sel = new Set(this.host.selection())
    const whole = wholeGroups(rows, this.host.selection())
    for (const n of this.list.children) {
      const row = n as HTMLElement
      const gid = row.dataset.group
      const on = gid
        ? rows.filter((r) => r.groupId === gid).every((r) => sel.has(r.id))
        : !!row.dataset.id && lit.has(row.dataset.id)
      if (!gid && !row.dataset.id) continue
      // a member of a group selected whole: a faint tint says "inside the
      // selection", the group row carries the highlight
      const member = rows.find((r) => r.id === row.dataset.id)
      row.classList.toggle('in-sel', !gid && !!member?.groupId && whole.has(member.groupId))
      row.classList.toggle('sel', on)
      row.setAttribute('aria-selected', on ? 'true' : 'false')
    }
  }

  private rebuildRows() {
    const scroll = this.list.scrollTop
    const had = document.activeElement === this.list
    // a rename open on a row about to be replaced moves to the new row, typing kept
    const pending = this.renaming
    pending?.drop()
    this.list.innerHTML = ''
    const rows = layerRows(this.host.slide(), t, this.host.paired?.())
    const lit = highlighted(rows, this.host.selection())
    const whole = wholeGroups(rows, this.host.selection())
    if (!rows.length) {
      const empty = document.createElement('p')
      empty.className = 'ed-hint'
      empty.textContent = t('Nothing on this slide yet.')
      this.list.appendChild(empty)
      return
    }
    let run: string | undefined
    for (const r of rows) {
      if (r.groupId !== run) {
        run = r.groupId
        if (run) this.list.appendChild(this.groupRow(run, rows))
      }
      if (r.groupId && this.folded.has(r.groupId)) continue
      const row = document.createElement('div')
      row.className = 'ed-layer' + (lit.has(r.id) ? ' sel' : '') + (r.groupId && whole.has(r.groupId) ? ' in-sel' : '') + (r.grouped ? ' grouped' : '') + (r.hidden ? ' is-hidden' : '')
      row.dataset.id = r.id
      row.draggable = true
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', lit.has(r.id) ? 'true' : 'false')
      const glyph = document.createElement('span')
      glyph.className = 'ed-layer-glyph'
      glyph.innerHTML = r.frame ? ICONS[({ row: 'frameRow', col: 'frameCol', grid: 'frameGrid' } as const)[r.frame]] : GLYPH[r.type] ?? ''
      if (!r.frame && !GLYPH[r.type]) glyph.textContent = r.type.charAt(0).toUpperCase()
      if (r.depth) row.style.paddingInlineStart = `${8 + r.depth * 16}px` // inside a frame
      const label = document.createElement('span')
      label.className = 'ed-layer-label'
      label.textContent = r.label
      row.append(glyph, label)
      if (r.comp) {
        const mark = document.createElement('span')
        mark.className = 'ed-layer-comp'
        mark.textContent = r.comp === 'main' ? '◆' : '◇'
        mark.title = r.comp === 'main' ? t('Main component — its copies follow it') : t('Component copy — follows its main')
        row.appendChild(mark)
      }
      if (r.paired) {
        const badge = document.createElement('span')
        badge.className = 'ed-layer-morph'
        badge.textContent = '↔'
        badge.title = t('Morphs from the slide before')
        row.appendChild(badge)
      }
      if (this.host.toggle && !this.host.readOnly?.()) row.append(this.flagButton([r.id], !!r.locked, 'locked'), this.flagButton([r.id], !!r.hidden, 'hidden'))
      row.title = r.label
      row.addEventListener('click', (ev) => this.onClick(ev, r))
      label.addEventListener('dblclick', (ev) => { ev.stopPropagation(); this.rename(r.id) })
      row.addEventListener('dragstart', (ev) => {
        this.dragId = r.id
        const sel = this.host.selection()
        this.dragIds = sel.includes(r.id) ? [...sel] : [r.id]
        ev.dataTransfer?.setData('text/plain', r.id)
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
        row.classList.add('dragging')
      })
      row.addEventListener('dragend', () => { this.dragId = null; this.dragIds = []; this.clearDropMarks() })
      row.addEventListener('dragover', (ev) => {
        if (!this.dragId || this.dragIds.includes(r.id)) return
        const where = this.dropWhere(ev, row, r)
        if (!where) { this.clearDropMarks(); return }
        ev.preventDefault()
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
        this.clearDropMarks()
        row.classList.add(where === 'into' ? 'drop-into' : where === 'above' ? 'drop-above' : 'drop-below')
      })
      row.addEventListener('drop', (ev) => {
        ev.preventDefault()
        const id = this.dragId ?? ev.dataTransfer?.getData('text/plain')
        const where = this.dropWhere(ev, row, r)
        this.clearDropMarks()
        if (!id || this.dragIds.includes(r.id) || !where) return
        this.dropAt(id, r, where)
      })
      this.list.appendChild(row)
    }
    this.list.scrollTop = scroll
    if (pending) {
      const { target, input } = pending
      if (target.id && this.rowNode(target.id)) this.rename(target.id, input.value)
      else if (target.gid) this.renameGroup(target.gid, input.value)
      return
    }
    if (had) this.list.focus({ preventScroll: true })
  }

  /**
   * The row that stands for a group, the way Penpot and Figma show one: a
   * disclosure arrow, the group glyph, 'Group of N'; its members are nested
   * under it. Clicking it selects the whole group (the canvas's click);
   * dragging it moves the group as one, and it takes drops for its run.
   */
  private groupRow(gid: string, rows: LayerRow[]): HTMLElement {
    const members = rows.filter((r) => r.groupId === gid)
    const row = document.createElement('div')
    row.className = 'ed-layer ed-layer-group'
    row.dataset.group = gid
    row.draggable = true
    row.setAttribute('role', 'option')
    const open = !this.folded.has(gid)
    const fold = document.createElement('button')
    fold.type = 'button'
    fold.className = 'ed-layer-fold'
    fold.setAttribute('aria-expanded', String(open))
    fold.setAttribute('aria-label', open ? t('Collapse') : t('Expand'))
    fold.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (open) this.folded.add(gid); else this.folded.delete(gid)
      this.rebuildRows()
    })
    const glyph = document.createElement('span')
    glyph.className = 'ed-layer-glyph'
    glyph.innerHTML = ICONS.group
    const label = document.createElement('span')
    label.className = 'ed-layer-label'
    label.textContent = this.host.slide().elements.find((e) => e.groupId === gid)?.groupName || t('Group of {n}', { n: members.length })
    label.addEventListener('dblclick', (ev) => { ev.stopPropagation(); this.renameGroup(gid) })
    row.append(fold, glyph, label)
    const els = this.host.slide().elements.filter((e) => e.groupId === gid)
    const all = els.map((e) => e.id)
    // a group locks and hides like any layer: its flag is on when every member's is
    const flags = { locked: els.every((e) => e.locked), hidden: els.every((e) => e.hidden) }
    if (flags.hidden) row.classList.add('is-hidden')
    if (this.host.toggle && !this.host.readOnly?.()) row.append(this.flagButton(all, flags.locked, 'locked'), this.flagButton(all, flags.hidden, 'hidden'))
    row.addEventListener('click', (ev) => {
      const cur = [...this.host.selection()]
      if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
        const has = all.every((id) => cur.includes(id))
        this.host.select(has ? cur.filter((id) => !all.includes(id)) : [...cur.filter((id) => !all.includes(id)), ...all])
      } else this.host.select(all)
      this.list.focus({ preventScroll: true })
    })
    // dragging the group drags its topmost member, and moveInPaintOrder takes
    // the whole group along; a drop on it lands above or below the whole run
    row.addEventListener('dragstart', (ev) => {
      this.dragId = members[0].id
      this.dragIds = members.map((m) => m.id)
      ev.dataTransfer?.setData('text/plain', members[0].id)
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
      row.classList.add('dragging')
    })
    row.addEventListener('dragend', () => { this.dragId = null; this.dragIds = []; this.clearDropMarks() })
    row.addEventListener('dragover', (ev) => {
      if (!this.dragId || all.includes(this.dragId)) return
      ev.preventDefault()
      this.clearDropMarks()
      row.classList.add(this.dropAbove(ev, row) ? 'drop-above' : 'drop-below')
    })
    row.addEventListener('drop', (ev) => {
      ev.preventDefault()
      const id = this.dragId ?? ev.dataTransfer?.getData('text/plain')
      this.clearDropMarks()
      if (!id || all.includes(id)) return
      const above = this.dropAbove(ev, row)
      this.dropOn(id, above ? members[0] : members[members.length - 1], above)
    })
    return row
  }

  /** A row's padlock or eye: shown on hover, and always while it is on. */
  private flagButton(ids: string[], on: boolean, key: 'locked' | 'hidden'): HTMLElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `ed-layer-act ed-layer-${key}` + (on ? ' on' : '')
    if (key === 'locked' && on) b.classList.add('ed-layer-lock') // the row's padlock IS its lock mark (#838)
    b.innerHTML = key === 'locked' ? ICONS.lock : ICONS.eye
    const label = key === 'locked' ? (on ? t('Unlock') : t('Lock')) : (on ? t('Show') : t('Hide'))
    b.title = label
    b.setAttribute('aria-label', label)
    b.setAttribute('aria-pressed', String(on))
    b.draggable = false
    b.addEventListener('click', (ev) => { ev.stopPropagation(); this.host.toggle!(ids, key) })
    return b
  }

  private dropAbove(ev: DragEvent, row: HTMLElement): boolean {
    const b = row.getBoundingClientRect()
    return ev.clientY < b.top + b.height / 2
  }

  private clearDropMarks() {
    for (const n of this.list.querySelectorAll('.drop-above, .drop-below, .drop-into, .dragging')) n.classList.remove('drop-above', 'drop-below', 'drop-into', 'dragging')
  }

  /**
   * Where a drag over row `r` would land: INSIDE a frame row when over its
   * middle (Figma's rule — the top and bottom quarters still mean above and
   * below), else above or below the row. Null when the drop is refused: a
   * frame never goes inside itself or anything it holds, and a locked frame
   * takes nothing.
   */
  private dropWhere(ev: DragEvent, row: HTMLElement, r: LayerRow): 'into' | 'above' | 'below' | null {
    const slide = this.host.slide() as Slide
    const b = row.getBoundingClientRect()
    const y = (ev.clientY - b.top) / (b.height || 1)
    if (r.frame && this.host.reparent && y > 0.25 && y < 0.75) return canAccept(slide, this.moving(), r.id) ? 'into' : null
    // beside a frame's child is inside that frame — it must accept them too
    const parent = slide.elements.find((e) => e.id === r.id)?.parentId
    if (parent && this.host.reparent && !canAccept(slide, this.moving(), parent)) return null
    return y < 0.5 ? 'above' : 'below'
  }

  /** The dragged elements, each counted once: a selected element whose frame
   *  is selected too travels with its frame. */
  private moving(): string[] {
    const slide = this.host.slide() as Slide
    const set = new Set(this.dragIds)
    const byId = new Map(slide.elements.map((e) => [e.id, e]))
    const under = (e: SlideElement | undefined): boolean => !!e?.parentId && (set.has(e.parentId) || under(byId.get(e.parentId)))
    return this.dragIds.filter((id) => !under(byId.get(id)))
  }

  /** Land the drag on row `r`. Same parent, one element: a plain reorder, as
   *  before. Otherwise the elements change frame: inside `r` (a frame), at
   *  `r`'s slot when `r` is a frame's child, or out to the top level beside it. */
  private dropAt(id: string, r: LayerRow, where: 'into' | 'above' | 'below') {
    const slide = this.host.slide() as Slide
    const ids = this.moving()
    const target = slide.elements.find((e) => e.id === r.id)
    const parent = target?.parentId
    if (where === 'into') { this.host.reparent!(ids, { frame: r.id, slot: Infinity }); return this.refresh() }
    const sameParent = ids.every((x) => slide.elements.find((e) => e.id === x)?.parentId === parent)
    if (ids.length === 1 && sameParent || !this.host.reparent) return this.dropOn(id, r, where === 'above')
    if (parent) {
      // rows are top-first and a frame's children paint in flow order, so the
      // row above `r` comes after it in the flow
      const f = slide.elements.find((e) => e.id === parent)
      const stay = isFrame(f) ? frameChildren(slide, f).filter((e) => !ids.includes(e.id)) : []
      const i = stay.findIndex((e) => e.id === r.id)
      this.host.reparent(ids, { frame: parent, slot: i + (where === 'above' ? 1 : 0) })
    } else this.host.reparent(ids, { beside: r.id, above: where === 'above' })
    this.refresh()
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
    // A member's row selects that member — the list is where you reach inside
    // a group, as in Penpot and Figma; the group's own row selects the group.
    const unit = [r.id]
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
