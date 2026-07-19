// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento/Suite authors
// The editing canvas: renders the current slide at fit-to-window scale and
// wires Moveable (drag/resize/rotate/snap) + Selecto (click & rubber-band
// selection) + contenteditable text editing on top of it.

import Moveable from 'moveable'
import Selecto from 'selecto'
import type { Store } from '../store'
import { t } from '../i18n'
import { uid, type SlideElement, type TableElement } from '../model'
import { renderSlide, sanitizeHtml } from '../render'
import { autoformatAtCaret, clearAutoformat, markdownToHtml, undoAutoformat } from './markdown'
import { PathEditor } from './patheditor'
import { CommentsUI } from './comments'
import type { Peer } from '../sync/session'

export class SlideCanvas {
  private stage: HTMLElement
  private scaleHost: HTMLElement
  private scroller: HTMLElement
  private surface: HTMLElement | null = null
  private moveable: Moveable
  private selecto: Selecto
  private scale = 1
  private fitScale = 1
  /** user zoom, multiplier on the fitted scale (1 = fit to window) */
  private zoom = 1
  private zoomLabel: HTMLElement | null = null
  private editing: HTMLElement | null = null
  /** when editing a table cell, which cell (else null → text element edit) */
  private editingCell: { r: number; c: number } | null = null
  private pathEditor!: PathEditor
  private comments!: CommentsUI

  constructor(
    private wrap: HTMLElement,
    private store: Store,
  ) {
    this.scroller = document.createElement('div')
    this.scroller.className = 'ed-scroll'
    this.stage = document.createElement('div')
    this.stage.className = 'ed-stage'
    this.scaleHost = document.createElement('div')
    this.scaleHost.className = 'ed-stage-scale'
    this.stage.appendChild(this.scaleHost)
    this.scroller.appendChild(this.stage)
    wrap.appendChild(this.scroller)
    this.buildZoomBar()
    // pinch / ctrl+wheel zooms like every design tool
    this.scroller.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return
      ev.preventDefault()
      this.setZoom(this.zoom * (ev.deltaY < 0 ? 1.12 : 1 / 1.12))
    }, { passive: false })

    // Control box lives INSIDE the scaled host with rootContainer at body:
    // Moveable then works in slide-local coordinates (e.left/e.top are model
    // px), and `zoom` compensates the handles' visual size (set in relayout).
    this.moveable = new Moveable(this.scaleHost, {
      rootContainer: document.body,
      draggable: true,
      resizable: true,
      rotatable: true,
      origin: false,
      snappable: true,
      snapThreshold: 6,
      snapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
      elementSnapDirections: { top: true, left: true, bottom: true, right: true, center: true, middle: true },
      isDisplaySnapDigit: false,
      throttleRotate: 1,
      rotationPosition: 'top',
      renderDirections: ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'],
    })

    this.selecto = new Selecto({
      container: this.scroller,
      dragContainer: this.scroller,
      selectableTargets: ['.bento-el'],
      selectByClick: true,
      selectFromInside: false,
      toggleContinueSelect: 'shift',
      // Marquee selects only elements it fully contains (clicking still
      // selects whatever is under the cursor via selectByClick).
      hitRate: 100,
    })

    this.wireMoveable()
    this.wireSelecto()

    this.pathEditor = new PathEditor(this.scaleHost, store, () => this.syncTargets())
    this.pathEditor.setScaleGetter(() => this.scale)
    document.addEventListener('bento:edit-path', ((ev: CustomEvent) => {
      this.startPathEdit(ev.detail.id)
    }) as EventListener)

    this.comments = new CommentsUI(store, this.stage, () => this.scale)

    // Alt/Option-click digs through overlapping elements: first click grabs
    // the topmost, each further alt-click steps one element deeper (wrapping).
    // Capture phase so it wins over Selecto AND Moveable's control-box area,
    // which otherwise swallows clicks over the current selection.
    document.addEventListener('mousedown', (ev) => {
      if (!ev.altKey || ev.button !== 0 || this.pathEditor.active) return
      // Alt on a resize/rotate handle means center-scale, not deep-select
      if (ev.target instanceof Element && ev.target.closest('.moveable-control-box')) return
      const r = this.scaleHost.getBoundingClientRect()
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return
      if (ev.target instanceof Element && ev.target.closest('.ed-sidebar, .ed-props, .ed-topbar')) return
      ev.preventDefault()
      ev.stopPropagation()
      this.deepSelect((ev.clientX - r.left) / this.scale, (ev.clientY - r.top) / this.scale)
    }, true)

    this.stage.addEventListener('dblclick', (ev) => {
      const textEl = (ev.target as HTMLElement).closest<HTMLElement>('.bento-el-text')
      if (textEl) { this.startTextEdit(textEl); return }
      const td = (ev.target as HTMLElement).closest<HTMLElement>('.bento-el-table td[data-c]')
      if (td) this.editCellFromTd(td)
    })

    new ResizeObserver(() => this.relayout()).observe(wrap)

    store.on('current', () => this.render())
    store.on('doc', () => this.render())
    store.on('selection', () => this.syncTargets())

    this.render()
  }

  // --- layout & rendering ---------------------------------------------------

  relayout() {
    const { width, height } = this.store.doc.size
    const availW = this.scroller.clientWidth - 64
    const availH = this.scroller.clientHeight - 64
    if (availW <= 0 || availH <= 0) return
    this.fitScale = Math.min(availW / width, availH / height)
    this.scale = this.fitScale * this.zoom
    this.stage.style.width = `${width * this.scale}px`
    this.stage.style.height = `${height * this.scale}px`
    this.scaleHost.style.transform = `scale(${this.scale})`
    this.moveable.zoom = 1 / this.scale
    this.moveable.updateRect()
    if (this.zoomLabel) this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`
    this.comments?.refresh()
    this.drawRemote()
  }

  // --- zoom ------------------------------------------------------------------

  setZoom(zoom: number) {
    this.zoom = Math.min(Math.max(zoom, 0.5), 8)
    this.relayout()
    // keep the view centred on the slide as it grows/shrinks
    this.scroller.scrollLeft = (this.scroller.scrollWidth - this.scroller.clientWidth) / 2
    this.scroller.scrollTop = (this.scroller.scrollHeight - this.scroller.clientHeight) / 2
  }

  zoomIn() { this.setZoom(this.zoom * 1.25) }
  zoomOut() { this.setZoom(this.zoom / 1.25) }
  zoomReset() { this.setZoom(1) }

  private buildZoomBar() {
    const bar = document.createElement('div')
    bar.className = 'ed-zoombar'
    const mk = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement('button')
      b.className = 'ed-zoombtn'
      b.textContent = label
      b.title = title
      b.addEventListener('click', onClick)
      return b
    }
    const label = mk('100%', t('Reset zoom to fit (⌘0)'), () => this.zoomReset())
    label.classList.add('ed-zoomlabel')
    this.zoomLabel = label
    bar.append(
      mk('−', t('Zoom out (⌘−)'), () => this.zoomOut()),
      label,
      mk('+', t('Zoom in (⌘+)'), () => this.zoomIn()),
    )
    this.wrap.appendChild(bar)
  }

  /** notified when the comment tool arms/disarms (topbar button state) */
  onCommentModeChange: ((on: boolean) => void) | null = null
  private commentCleanup: (() => void) | null = null

  get isCommentMode() {
    return !!this.commentCleanup
  }

  /**
   * The unified comment tool. Armed: the next canvas click anchors a new
   * thread — on the ELEMENT under the cursor when there is one, else at
   * that POINT of the slide. Capture phase (Selecto/Moveable never see the
   * click); Esc or toggling again disarms.
   */
  /** Where a comment click at these client coords would anchor.
   *  Near-full-slide elements (photos, scrims) don't capture — a comment
   *  "here" on scenery means the spot, not the backdrop object. */
  private commentAnchorAt(clientX: number, clientY: number): { x: number; y: number; el?: SlideElement } | null {
    const r = this.scaleHost.getBoundingClientRect()
    const x = Math.round((clientX - r.left) / this.scale)
    const y = Math.round((clientY - r.top) / this.scale)
    const { width, height } = this.store.doc.size
    if (x < 0 || y < 0 || x > width || y > height) return null
    let hit: SlideElement | undefined
    const slideArea = width * height
    for (const el of this.store.slide.elements) {
      if (x < el.x || x > el.x + el.w || y < el.y || y > el.y + el.h) continue
      if (el.w * el.h >= slideArea * 0.8) continue
      const node = this.scaleHost.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
      if (node && node.style.display !== 'none') hit = el
    }
    return { x, y, el: hit }
  }

  toggleCommentMode() {
    if (this.commentCleanup) {
      this.commentCleanup()
      return
    }
    this.wrap.style.cursor = 'crosshair' // the whole canvas area, grey included
    // live feedback: an amber outline over the element the comment would
    // anchor to, a pin-dot + coordinates where the point would land, or the
    // whole-slide outline plus a cursor-following chip out on the grey
    const hl = document.createElement('div')
    hl.className = 'ed-comment-hl'
    this.stage.appendChild(hl)
    const chip = document.createElement('div')
    chip.className = 'ed-comment-chip'
    chip.textContent = t('💬 whole slide')
    chip.style.display = 'none'
    this.stage.appendChild(chip)
    const cleanup = () => {
      this.commentCleanup = null
      this.wrap.style.cursor = ''
      hl.remove()
      chip.remove()
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('keydown', onKey, true)
      this.onCommentModeChange?.(false)
    }
    const onMove = (ev: MouseEvent) => {
      const inWrap = ev.target instanceof Element && !!ev.target.closest('.ed-canvas-wrap')
      const a = inWrap ? this.commentAnchorAt(ev.clientX, ev.clientY) : null
      if (!inWrap) {
        hl.style.display = 'none'
        chip.style.display = 'none'
        return
      }
      hl.style.display = ''
      if (!a) {
        // on the canvas but off the slide: the WHOLE SLIDE is the anchor.
        // Outline the slide AND pin a chip to the cursor — that's where the
        // user is looking.
        const { width, height } = this.store.doc.size
        hl.className = 'ed-comment-hl slide'
        hl.style.left = '-3px'
        hl.style.top = '-3px'
        hl.style.width = `${width * this.scale + 6}px`
        hl.style.height = `${height * this.scale + 6}px`
        hl.textContent = ''
        const stageR = this.stage.getBoundingClientRect()
        chip.style.display = ''
        chip.style.left = `${ev.clientX - stageR.left + 14}px`
        chip.style.top = `${ev.clientY - stageR.top + 6}px`
        return
      }
      chip.style.display = 'none'
      if (a.el) {
        hl.className = 'ed-comment-hl element'
        hl.style.left = `${a.el.x * this.scale - 3}px`
        hl.style.top = `${a.el.y * this.scale - 3}px`
        hl.style.width = `${a.el.w * this.scale + 6}px`
        hl.style.height = `${a.el.h * this.scale + 6}px`
        hl.textContent = ''
      } else {
        hl.className = 'ed-comment-hl pin'
        hl.style.left = `${a.x * this.scale}px`
        hl.style.top = `${a.y * this.scale}px`
        hl.style.width = ''
        hl.style.height = ''
        hl.textContent = `${a.x}, ${a.y}`
      }
    }
    const onDown = (ev: MouseEvent) => {
      const t = ev.target instanceof Element ? ev.target : null
      if (t?.closest('.ed-topbar')) return // let the 💬 toggle (or other tools) handle it
      if (!t?.closest('.ed-canvas-wrap')) {
        cleanup() // clicked some other UI: disarm without placing
        return
      }
      const a = this.commentAnchorAt(ev.clientX, ev.clientY)
      cleanup()
      ev.preventDefault()
      ev.stopPropagation()
      if (!a) this.comments.openNew() // off-slide canvas click = whole slide
      else this.comments.openNew(a.el?.id, a.el ? undefined : { x: a.x, y: a.y })
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') cleanup()
    }
    this.commentCleanup = cleanup
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('keydown', onKey, true)
    this.onCommentModeChange?.(true)
  }

  /** Grow a selection to whole groups: any member pulls in its groupId kin.
   *  (Alt-click deep select bypasses this — that's how you reach a member.) */
  private expandGroups(ids: string[]): string[] {
    const els = this.store.slide.elements
    const groups = new Set(
      ids.map((id) => els.find((e) => e.id === id)?.groupId).filter((g): g is string => !!g),
    )
    if (!groups.size) return ids
    const out = new Set(ids)
    for (const el of els) if (el.groupId && groups.has(el.groupId)) out.add(el.id)
    return [...out]
  }

  /** Alt-click: select the element under (px, py), digging one step deeper
   *  below the current selection on each repeat. Coordinates in slide px. */
  private deepSelect(px: number, py: number) {
    const stack: string[] = []
    for (const el of this.store.slide.elements) {
      if (px < el.x || px > el.x + el.w || py < el.y || py > el.y + el.h) continue
      const node = this.scaleHost.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
      if (!node || node.style.display === 'none') continue // hidden hover set
      stack.push(el.id)
    }
    if (!stack.length) return
    const topFirst = stack.reverse() // model order is z-order; topmost last
    let pick = topFirst[0]
    if (this.store.selection.length === 1) {
      const i = topFirst.indexOf(this.store.selection[0])
      if (i >= 0) pick = topFirst[(i + 1) % topFirst.length]
    }
    this.store.select([pick])
  }

  // --- motion-path editing ----------------------------------------------------

  get isPathEditing() {
    return this.pathEditor.active
  }

  startPathEdit(elId: string) {
    this.commitTextEdit()
    this.pathEditor.start(elId)
    this.syncTargets()
  }

  /** finish path editing; commit=false discards the changes */
  stopPathEdit(commit = true) {
    if (commit) this.pathEditor.commit()
    else {
      this.pathEditor.cancel()
      this.syncTargets()
    }
  }

  render() {
    this.commitTextEdit()
    if (this.pathEditor?.active) this.pathEditor.cancel() // doc changed under us
    const slide = this.store.slide
    const next = renderSlide(slide, this.store.doc)
    // hover-reveal slides: preview one set at a time; hidden sets are
    // display:none so they don't block selection
    const sets = [...new Set(slide.elements.map((e) => e.showOnHover).filter(Boolean))] as string[]
    if (sets.length) {
      const active = this.store.hoverPreview ?? slide.hover?.default ?? sets[0]
      for (const node of next.querySelectorAll<HTMLElement>('[data-show-on-hover]')) {
        if (node.dataset.showOnHover !== active) node.style.display = 'none'
      }
    }
    this.renderSetBar(sets)
    if (this.surface) this.surface.replaceWith(next)
    else this.scaleHost.appendChild(next)
    this.surface = next
    this.relayout()
    this.syncTargets()
    this.drawRemote()
  }

  // --- collaborator presence (colored outlines + name tags) -----------------

  private remotePeers: Peer[] = []
  private remoteLayer: HTMLElement | null = null

  setRemotePeers(peers: Peer[]) {
    this.remotePeers = peers
    this.drawRemote()
  }

  private drawRemote() {
    const slide = this.store.slide
    if (!slide) return
    if (!this.remoteLayer) {
      this.remoteLayer = document.createElement('div')
      this.remoteLayer.className = 'ed-remote-layer'
      this.scaleHost.appendChild(this.remoteLayer)
    }
    // layer stays last in the scaled host so outlines paint above the slide
    if (this.remoteLayer.nextSibling) this.scaleHost.appendChild(this.remoteLayer)
    this.remoteLayer.innerHTML = ''
    for (const peer of this.remotePeers) {
      if (peer.slide !== slide.id) continue
      const ids = new Set(peer.sel)
      if (peer.editing) ids.add(peer.editing)
      // the layer lives inside the scaled host — counter-scale strokes and
      // name tags so they stay readable at any zoom (same idea as
      // moveable.zoom = 1/scale)
      const inv = 1 / (this.scale || 1)
      let tagged = false
      for (const id of ids) {
        const el = slide.elements.find((e) => e.id === id)
        if (!el) continue
        const box = document.createElement('div')
        box.className = 'ed-remote-box'
        box.style.left = `${el.x}px`
        box.style.top = `${el.y}px`
        box.style.width = `${el.w}px`
        box.style.height = `${el.h}px`
        box.style.borderColor = peer.color
        box.style.borderWidth = `${2 * inv}px`
        if (el.rotation) box.style.transform = `rotate(${el.rotation}deg)`
        if (peer.editing === id) box.classList.add('ed-remote-editing')
        if (!tagged) {
          const tag = document.createElement('div')
          tag.className = 'ed-remote-tag'
          tag.style.background = peer.color
          tag.textContent = peer.editing === id ? `✏️ ${peer.name}` : peer.name
          tag.style.transform = `scale(${inv})`
          tag.style.transformOrigin = 'bottom left'
          tag.style.bottom = '100%'
          tag.style.top = 'auto'
          box.appendChild(tag)
          tagged = true
        }
        this.remoteLayer.appendChild(box)
      }
    }
  }

  /**
   * Canvas set-switcher: when a slide has hover-reveal sets, a chip bar sits
   * above the stage so each set is one click away while editing. Selection
   * survives the switch when the selected element is in the shown set.
   */
  private renderSetBar(sets: string[]) {
    this.wrap.querySelector('.ed-setbar')?.remove()
    if (!sets.length) return
    const slide = this.store.slide
    const active = this.store.hoverPreview ?? slide.hover?.default ?? sets[0]
    const bar = document.createElement('div')
    bar.className = 'ed-setbar'
    const label = document.createElement('span')
    label.className = 'ed-setbar-label'
    label.textContent = t('Hover set:')
    bar.appendChild(label)
    for (const set of sets) {
      const chip = document.createElement('button')
      chip.className = 'ed-setchip'
      chip.textContent = set + (slide.hover?.default === set ? ' ●' : '')
      chip.title = slide.hover?.default === set
        ? `"${set}" — shown when nothing is hovered (default set)`
        : `Preview and edit the "${set}" hover set`
      if (set === active) chip.classList.add('active')
      chip.addEventListener('click', () => {
        this.store.hoverPreview = set
        this.render()
      })
      bar.appendChild(chip)
    }
    this.wrap.appendChild(bar)
  }

  private selectedNodes(): HTMLElement[] {
    if (!this.surface) return []
    return this.store.selection
      .map((id) => this.surface!.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(id)}"]`))
      .filter((n): n is HTMLElement => !!n)
  }

  private syncTargets() {
    const targets = this.editing || this.pathEditor?.active ? [] : this.selectedNodes()
    // snap against slide bounds/center and every non-selected element
    const others = this.surface
      ? [this.surface, ...Array.from(this.surface.querySelectorAll<HTMLElement>('.bento-el'))].filter(
          (n) => !targets.includes(n),
        )
      : []
    this.moveable.elementGuidelines = others
    // Only reset targets when they actually changed — setting the same array
    // re-attaches gesture listeners a frame later and can swallow a drag that
    // starts immediately after.
    const current = (this.moveable.target ?? []) as HTMLElement[]
    const same = current.length === targets.length && targets.every((t, i) => current[i] === t)
    if (!same) this.moveable.target = targets
    this.moveable.updateRect()
    // Keep Selecto's continue-select memory in lockstep with the store —
    // otherwise shift-click resurrects targets from a previously shown slide.
    this.selecto.setSelectedTargets(targets)
    this.updateTableHandles()
  }

  // --- column resize handles (single selected table) --------------------------

  /** Show draggable dividers on the boundaries of a lone selected table. */
  private updateTableHandles() {
    this.surface?.querySelectorAll('.bento-col-handle').forEach((h) => h.remove())
    if (this.editing) return
    const ids = this.store.selection
    if (ids.length !== 1) return
    const el = this.store.element(ids[0])
    if (!el || el.type !== 'table' || el.columns.length < 2) return
    const node = this.surface?.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
    if (!node) return
    const total = el.columns.reduce((s, c) => s + (c.w || 0), 0) || 1
    let acc = 0
    for (let i = 0; i < el.columns.length - 1; i++) {
      acc += el.columns[i].w || 0
      const handle = document.createElement('div')
      handle.className = 'bento-col-handle'
      handle.style.cssText =
        `position:absolute;top:0;height:${el.h}px;width:11px;` +
        `left:${(acc / total) * el.w - 5.5}px;cursor:col-resize;z-index:5;`
      handle.addEventListener('pointerdown', (ev) => this.startColResize(ev, el.id, i))
      node.appendChild(handle)
    }
  }

  /** Drag a column divider: adjust the two adjacent weights, commit on release. */
  private startColResize(ev: PointerEvent, id: string, i: number) {
    ev.preventDefault()
    ev.stopPropagation()
    const el = this.store.element(id)
    if (!el || el.type !== 'table') return
    const node = this.surface?.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(id)}"]`)
    if (!node) return
    const startX = ev.clientX
    const w0 = el.columns[i].w || 0
    const w1 = el.columns[i + 1].w || 0
    const pair = w0 + w1
    const min = pair * 0.12
    const cols = node.querySelectorAll<HTMLElement>('col')
    const handles = [...node.querySelectorAll<HTMLElement>('.bento-col-handle')]
    const total = el.columns.reduce((s, c) => s + (c.w || 0), 0) || 1
    let live0 = w0
    let live1 = w1
    const onMove = (e: PointerEvent) => {
      const dFrac = ((e.clientX - startX) / this.scale / el.w) * total
      live0 = Math.min(Math.max(w0 + dFrac, min), pair - min)
      live1 = pair - live0
      // live DOM update only — no store write until release
      if (cols[i]) cols[i].style.width = `${(live0 / total) * 100}%`
      if (cols[i + 1]) cols[i + 1].style.width = `${(live1 / total) * 100}%`
      let a = 0
      for (let k = 0; k < el.columns.length - 1; k++) {
        a += k === i ? live0 : k === i + 1 ? live1 : el.columns[k].w || 0
        if (handles[k]) handles[k].style.left = `${(a / total) * el.w - 5.5}px`
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      this.store.commit(() => {
        const tb = this.store.element(id) as TableElement
        if (tb?.columns[i] && tb.columns[i + 1]) {
          tb.columns[i].w = live0
          tb.columns[i + 1].w = live1
        }
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // --- moveable -------------------------------------------------------------

  /** ⌘/Ctrl-drag duplicate: originals move, copies stay behind (committed at drag end) */
  private pendingCopy: SlideElement[] | null = null

  private wireMoveable() {
    const mv = this.moveable
    // start positions per target — Shift axis-locks against these
    const dragStarts = new Map<HTMLElement, { left: number; top: number }>()

    const noteDragStart = (target: HTMLElement, inputEvent: MouseEvent | undefined) => {
      dragStarts.set(target, {
        left: parseFloat(target.style.left) || 0,
        top: parseFloat(target.style.top) || 0,
      })
      if (inputEvent && (inputEvent.metaKey || inputEvent.ctrlKey) && !this.pendingCopy) {
        // duplicate-drag: snapshot the selection now; the stationary copies
        // are committed in one undo step together with the moved frames
        this.pendingCopy = this.store.selectedElements.map(
          (el) => JSON.parse(JSON.stringify(el)) as SlideElement,
        )
      }
    }
    const axisLock = (target: HTMLElement, left: number, top: number, ev: { inputEvent?: MouseEvent; dist?: number[] }) => {
      const start = dragStarts.get(target)
      if (!start || !ev.inputEvent?.shiftKey || !ev.dist) return { left, top }
      return Math.abs(ev.dist[0]) >= Math.abs(ev.dist[1])
        ? { left, top: start.top }
        : { left: start.left, top }
    }

    mv.on('dragStart', (e) => noteDragStart(e.target as HTMLElement, e.inputEvent as MouseEvent))
    mv.on('dragGroupStart', (e) =>
      e.events.forEach((ev) => noteDragStart(ev.target as HTMLElement, e.inputEvent as MouseEvent)),
    )
    mv.on('drag', (e) => {
      const p = axisLock(e.target as HTMLElement, e.left, e.top, e)
      e.target.style.left = `${p.left}px`
      e.target.style.top = `${p.top}px`
    })
    mv.on('dragGroup', (e) => e.events.forEach((ev) => {
      const p = axisLock(ev.target as HTMLElement, ev.left, ev.top, ev)
      ev.target.style.left = `${p.left}px`
      ev.target.style.top = `${p.top}px`
    }))
    // Shift while resizing keeps the aspect ratio; Alt/Option scales from
    // the center (both live per move, combinable)
    const resizeCenters = new Map<HTMLElement, { cx: number; cy: number }>()
    const noteResizeStart = (target: HTMLElement) => {
      resizeCenters.set(target, {
        cx: (parseFloat(target.style.left) || 0) + (parseFloat(target.style.width) || 0) / 2,
        cy: (parseFloat(target.style.top) || 0) + (parseFloat(target.style.height) || 0) / 2,
      })
    }
    const applyResize = (
      target: HTMLElement,
      w: number,
      h: number,
      left: number,
      top: number,
      inputEvent: MouseEvent | undefined,
    ) => {
      target.style.width = `${w}px`
      target.style.height = `${h}px`
      const c = resizeCenters.get(target)
      if (inputEvent?.altKey && c) {
        target.style.left = `${c.cx - w / 2}px`
        target.style.top = `${c.cy - h / 2}px`
      } else {
        target.style.left = `${left}px`
        target.style.top = `${top}px`
      }
    }
    const syncKeepRatio = (inputEvent: MouseEvent | undefined) => {
      const want = !!inputEvent?.shiftKey
      if (mv.keepRatio !== want) mv.keepRatio = want
    }
    mv.on('resizeStart', (e) => {
      syncKeepRatio(e.inputEvent as MouseEvent)
      noteResizeStart(e.target as HTMLElement)
    })
    mv.on('resize', (e) => {
      syncKeepRatio(e.inputEvent as MouseEvent)
      applyResize(e.target as HTMLElement, e.width, e.height, e.drag.left, e.drag.top, e.inputEvent as MouseEvent)
    })
    mv.on('resizeGroupStart', (e) => e.events.forEach((ev) => noteResizeStart(ev.target as HTMLElement)))
    mv.on('resizeGroup', (e) => e.events.forEach((ev) => {
      applyResize(ev.target as HTMLElement, ev.width, ev.height, ev.drag.left, ev.drag.top, e.inputEvent as MouseEvent)
    }))
    // Shift while rotating snaps to 15° steps
    mv.on('rotateStart', (e) => { mv.throttleRotate = (e.inputEvent as MouseEvent | undefined)?.shiftKey ? 15 : 1 })
    mv.on('rotate', (e) => {
      mv.throttleRotate = (e.inputEvent as MouseEvent | undefined)?.shiftKey ? 15 : 1
      e.target.style.transform = `rotate(${e.rotation}deg)`
    })
    mv.on('rotateGroup', (e) => e.events.forEach((ev) => {
      ev.target.style.transform = ev.transform
    }))

    const commitFrames = () => {
      const copies = this.pendingCopy
      this.pendingCopy = null
      if (copies?.length) {
        // one undo step: stationary duplicates (fresh ids) + moved originals
        const nodes = this.selectedNodes()
        const frames = nodes.map((node) => ({
          id: node.dataset.elId!,
          x: parseFloat(node.style.left) || 0,
          y: parseFloat(node.style.top) || 0,
        }))
        this.store.commit(() => {
          const dupes = copies.map((el) => ({ ...el, id: uid(el.type[0]) }))
          this.store.slide.elements.push(...dupes)
          for (const f of frames) {
            const el = this.store.element(f.id)
            if (!el) continue
            el.x = Math.round(f.x * 10) / 10
            el.y = Math.round(f.y * 10) / 10
          }
        })
        return
      }
      this.commitDomFrames(this.selectedNodes())
    }
    mv.on('dragEnd', ({ isDrag }) => {
      if (isDrag) commitFrames()
      else this.pendingCopy = null
    })
    mv.on('dragGroupEnd', ({ isDrag }) => {
      if (isDrag) commitFrames()
      else this.pendingCopy = null
    })
    mv.on('resizeEnd', ({ isDrag }) => {
      mv.keepRatio = false
      if (isDrag) commitFrames()
    })
    mv.on('resizeGroupEnd', ({ isDrag }) => isDrag && commitFrames())
    mv.on('rotateEnd', ({ isDrag }) => {
      mv.throttleRotate = 1
      if (isDrag) commitFrames()
    })
    mv.on('rotateGroupEnd', ({ isDrag }) => isDrag && commitFrames())
  }

  /** Read live DOM styles back into the model in one undo step. */
  private commitDomFrames(nodes: HTMLElement[]) {
    if (!nodes.length) return
    const frames = nodes.map((node) => {
      const rotation = /rotate\((-?[\d.]+)deg\)/.exec(node.style.transform)
      return {
        id: node.dataset.elId!,
        x: parseFloat(node.style.left) || 0,
        y: parseFloat(node.style.top) || 0,
        w: parseFloat(node.style.width) || 1,
        h: parseFloat(node.style.height) || 1,
        rotation: rotation ? Math.round(parseFloat(rotation[1]) * 10) / 10 : 0,
      }
    })
    this.store.commit(() => {
      for (const f of frames) {
        const el = this.store.element(f.id)
        if (!el) continue
        el.x = Math.round(f.x * 10) / 10
        el.y = Math.round(f.y * 10) / 10
        el.w = Math.round(f.w * 10) / 10
        el.h = Math.round(f.h * 10) / 10
        el.rotation = f.rotation
      }
    })
  }

  // --- selecto ----------------------------------------------------------------

  private wireSelecto() {
    this.selecto.on('dragStart', (e) => {
      const target = e.inputEvent.target as HTMLElement
      // floating controls over the canvas are not marquee territory
      if (target.closest('.ed-present-fabs, .ed-zoombar, .ed-panel-toggle, .ed-resizer')) {
        e.stop()
        return
      }
      if (this.pathEditor?.active) {
        e.stop() // the path overlay owns the pointer while editing
        return
      }
      if (this.editing) {
        // editing a table cell: clicking a DIFFERENT cell switches to it
        if (this.editingCell) {
          const td = (target as HTMLElement)?.closest?.<HTMLElement>('td[data-c]')
          if (td && this.editing.contains(td)) {
            const already = Number(td.dataset.r) === this.editingCell.r && Number(td.dataset.c) === this.editingCell.c
            if (!already) { this.editCellFromTd(td); e.stop(); return }
            return // same cell: let contentEditable place the caret
          }
        }
        // clicking outside the text being edited commits it; inside, do nothing
        if (!this.editing.contains(target)) this.commitTextEdit()
        e.stop()
        return
      }
      const selected = this.selectedNodes()
      if (
        this.moveable.isMoveableElement(target) ||
        selected.some((n) => n === target || n.contains(target))
      ) {
        e.stop() // let Moveable take the drag
      }
    })

    this.selecto.on('selectEnd', (e) => {
      const ids = (e.selected as HTMLElement[])
        .map((n) => n.dataset.elId)
        .filter((id): id is string => !!id)
      this.store.select(this.expandGroups(ids))
      if (e.isDragStartEnd) {
        e.inputEvent.preventDefault()
        this.moveable.waitToChangeTarget().then(() => {
          this.moveable.dragStart(e.inputEvent)
        })
      }
    })
  }

  // --- text editing -----------------------------------------------------------

  startTextEdit(node: HTMLElement) {
    if (this.store.readOnly) return // live viewer — no inline editing
    if (this.editing === node) return
    this.commitTextEdit()
    const inner = node.querySelector<HTMLElement>('.bento-text-inner')
    if (!inner) return
    // fields ({{page}} etc.) render resolved; while editing, show the RAW token
    // so the author edits the field, not the computed value
    const model = this.store.element(node.dataset.elId ?? '')
    if (model?.type === 'text' && typeof model.html === 'string' && model.html.includes('{{')) {
      inner.innerHTML = model.html
    }
    this.editing = node
    node.classList.add('bento-editing')
    inner.contentEditable = 'true'
    inner.focus()
    document.getSelection()?.selectAllChildren(inner)
    this.syncTargets()
    this.onTextEditChange?.(node.dataset.elId)

    inner.addEventListener('keydown', (ev) => {
      ev.stopPropagation() // keep global shortcuts (Delete, arrows…) away
      if (ev.key === 'Escape') {
        ev.preventDefault()
        this.commitTextEdit()
        return
      }
      // inline markup: ⌘/Ctrl+B/I/U toggle bold/italic/underline on the
      // selection (sanitize keeps b/i/u/strong/em, so it round-trips)
      if (ev.metaKey || ev.ctrlKey) {
        // ⌘Z right after a markdown conversion restores the literal markers;
        // otherwise the browser's native contentEditable undo runs
        if (ev.key.toLowerCase() === 'z' && !ev.shiftKey) {
          if (undoAutoformat()) ev.preventDefault()
          return
        }
        const cmd = { b: 'bold', i: 'italic', u: 'underline' }[ev.key.toLowerCase()]
        if (cmd) {
          ev.preventDefault()
          document.execCommand(cmd)
        }
      }
    })
    // markdown affordances: **bold** / *italic* / `code` / ~~strike~~ / "- "
    // collapse as you type (⌘Z reverts, backslash escapes); pasted plain
    // text converts the same patterns
    inner.addEventListener('input', () => {
      if (!autoformatAtCaret()) clearAutoformat()
    })
    inner.addEventListener('paste', (ev) => {
      const text = ev.clipboardData?.getData('text/plain')
      if (!text) return
      ev.preventDefault()
      document.execCommand('insertHTML', false, sanitizeHtml(markdownToHtml(text)))
    })
    inner.addEventListener('blur', () => this.commitTextEdit(), { once: true })
  }

  /** collaborator presence: notified when text editing starts/stops */
  onTextEditChange: ((elId: string | undefined) => void) | null = null

  commitTextEdit() {
    const node = this.editing
    if (!node) return
    if (this.editingCell) { this.commitCellEdit(node); return }
    this.editing = null
    this.onTextEditChange?.(undefined)
    const inner = node.querySelector<HTMLElement>('.bento-text-inner')
    const id = node.dataset.elId
    node.classList.remove('bento-editing')
    if (!inner || !id) return
    inner.contentEditable = 'false'
    // drop the zero-width caret spacers autoformat leaves behind
    const html = sanitizeHtml(inner.innerHTML.replace(/\u200B/g, '').replace(/\\([*_~`-])/g, '$1'))
    const grownH = Math.max(parseFloat(node.style.height) || 0, inner.scrollHeight)
    const el = this.store.element(id)
    if (el && el.type === 'text' && (el.html !== html || grownH > el.h)) {
      this.store.commit(() => {
        el.html = html
        if (grownH > el.h) el.h = Math.ceil(grownH)
      })
    } else {
      this.syncTargets()
    }
  }

  // --- table cell editing -----------------------------------------------------

  /** Enter cell editing from a clicked/dbl-clicked <td> (re-queries fresh). */
  private editCellFromTd(td: HTMLElement) {
    const tableNode = td.closest<HTMLElement>('.bento-el-table')
    const id = tableNode?.dataset.elId
    if (!id) return
    this.editCellAt(id, Number(td.dataset.r), Number(td.dataset.c))
  }

  /** Commit any current edit, then edit cell (r,c) of table `id`. */
  private editCellAt(id: string, r: number, c: number) {
    if (this.store.readOnly) return // live viewer — no inline editing
    this.commitTextEdit()
    const td = this.surface?.querySelector<HTMLElement>(
      `[data-el-id="${CSS.escape(id)}"] td[data-r="${r}"][data-c="${c}"]`)
    if (!td) return
    const node = td.closest<HTMLElement>('.bento-el-table')
    const inner = td.querySelector<HTMLElement>('.bento-cell-inner')
    if (!node || !inner) return
    this.editing = node
    this.editingCell = { r, c }
    node.classList.add('bento-editing')
    inner.contentEditable = 'true'
    inner.focus()
    document.getSelection()?.selectAllChildren(inner)
    this.syncTargets()
    this.onTextEditChange?.(id)

    inner.addEventListener('keydown', (ev) => {
      ev.stopPropagation()
      if (ev.key === 'Escape') { ev.preventDefault(); this.commitTextEdit(); return }
      if (ev.key === 'Tab') { ev.preventDefault(); this.moveCell(ev.shiftKey ? -1 : 1, 'cell'); return }
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); this.moveCell(1, 'row'); return }
      if (ev.metaKey || ev.ctrlKey) {
        if (ev.key.toLowerCase() === 'z' && !ev.shiftKey) { if (undoAutoformat()) ev.preventDefault(); return }
        const cmd = { b: 'bold', i: 'italic', u: 'underline' }[ev.key.toLowerCase()]
        if (cmd) { ev.preventDefault(); document.execCommand(cmd) }
      }
    })
    inner.addEventListener('input', () => { if (!autoformatAtCaret()) clearAutoformat() })
    inner.addEventListener('paste', (ev) => {
      const text = ev.clipboardData?.getData('text/plain')
      if (!text) return
      ev.preventDefault()
      document.execCommand('insertHTML', false, sanitizeHtml(markdownToHtml(text)))
    })
    inner.addEventListener('blur', () => this.commitTextEdit(), { once: true })
  }

  private commitCellEdit(node: HTMLElement) {
    const cell = this.editingCell!
    const id = node.dataset.elId
    this.editing = null
    this.editingCell = null
    this.onTextEditChange?.(undefined)
    node.classList.remove('bento-editing')
    const inner = node.querySelector<HTMLElement>(
      `td[data-r="${cell.r}"][data-c="${cell.c}"] .bento-cell-inner`)
    if (!inner || !id) return
    inner.contentEditable = 'false'
    const html = sanitizeHtml(inner.innerHTML.replace(/\u200B/g, '').replace(/\\([*_~`-])/g, '$1'))
    const el = this.store.element(id)
    if (el && el.type === 'table' && el.rows[cell.r]?.cells[cell.c] && el.rows[cell.r].cells[cell.c].html !== html) {
      this.store.commit(() => {
        const tb = this.store.element(id) as TableElement
        if (tb.rows[cell.r]?.cells[cell.c]) tb.rows[cell.r].cells[cell.c].html = html
      })
    } else {
      this.syncTargets()
    }
  }

  /** Tab/Enter navigation between cells; Tab off the last cell appends a row. */
  private moveCell(dir: 1 | -1, mode: 'cell' | 'row') {
    const cur = this.editingCell
    const id = this.editing?.dataset.elId
    if (!cur || !id) return
    const el = this.store.element(id)
    if (!el || el.type !== 'table') return
    const nCols = el.columns.length
    const nRows = el.rows.length
    let r = cur.r
    let c = cur.c
    if (mode === 'row') {
      if (r + dir < 0 || r + dir >= nRows) { this.commitTextEdit(); return }
      r += dir
    } else {
      const idx = r * nCols + c + dir
      if (idx < 0) { this.commitTextEdit(); return }
      if (idx >= nRows * nCols) {
        this.commitTextEdit()
        this.store.commit(() => {
          const tb = this.store.element(id) as TableElement
          tb.rows.push({ cells: tb.columns.map(() => ({ html: '' })) })
        })
        this.editCellAt(id, nRows, 0)
        return
      }
      r = Math.floor(idx / nCols)
      c = idx % nCols
    }
    this.editCellAt(id, r, c)
  }

  get isEditingText() {
    return !!this.editing
  }

  /** Insert an element, select it, and (for text) drop straight into editing. */
  insert(el: SlideElement, startEditing = false) {
    // inserting while previewing a non-default hover set joins that set —
    // "I'm editing the italy panel" means new content belongs to it
    const slide = this.store.slide
    const preview = this.store.hoverPreview
    if (preview && slide.hover?.type === 'reveal' && preview !== slide.hover.default) {
      el.showOnHover = preview
    }
    this.store.commit(() => this.store.slide.elements.push(el))
    this.store.select([el.id])
    if (startEditing && el.type === 'text') {
      const node = this.surface?.querySelector<HTMLElement>(`[data-el-id="${CSS.escape(el.id)}"]`)
      if (node) this.startTextEdit(node)
    }
  }
}
