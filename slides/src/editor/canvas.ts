// The editing canvas: renders the current slide at fit-to-window scale and
// wires Moveable (drag/resize/rotate/snap) + Selecto (click & rubber-band
// selection) + contenteditable text editing on top of it.

import Moveable from 'moveable'
import Selecto from 'selecto'
import type { Store } from '../store'
import type { SlideElement } from '../model'
import { renderSlide, sanitizeHtml } from '../render'
import { autoformatAtCaret, clearAutoformat, markdownToHtml, undoAutoformat } from './markdown'
import { PathEditor } from './patheditor'
import { CommentsUI } from './comments'

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
      container: this.stage,
      dragContainer: this.stage,
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
    document.addEventListener('bento:add-comment', ((ev: CustomEvent) => {
      this.comments.openNew(ev.detail?.elementId)
    }) as EventListener)

    // Alt/Option-click digs through overlapping elements: first click grabs
    // the topmost, each further alt-click steps one element deeper (wrapping).
    // Capture phase so it wins over Selecto AND Moveable's control-box area,
    // which otherwise swallows clicks over the current selection.
    document.addEventListener('mousedown', (ev) => {
      if (!ev.altKey || ev.button !== 0 || this.pathEditor.active) return
      const r = this.scaleHost.getBoundingClientRect()
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return
      if (ev.target instanceof Element && ev.target.closest('.ed-sidebar, .ed-props, .ed-topbar')) return
      ev.preventDefault()
      ev.stopPropagation()
      this.deepSelect((ev.clientX - r.left) / this.scale, (ev.clientY - r.top) / this.scale)
    }, true)

    this.stage.addEventListener('dblclick', (ev) => {
      const el = (ev.target as HTMLElement).closest<HTMLElement>('.bento-el-text')
      if (el) this.startTextEdit(el)
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
    const label = mk('100%', 'Reset zoom to fit (⌘0)', () => this.zoomReset())
    label.classList.add('ed-zoomlabel')
    this.zoomLabel = label
    bar.append(
      mk('−', 'Zoom out (⌘−)', () => this.zoomOut()),
      label,
      mk('+', 'Zoom in (⌘+)', () => this.zoomIn()),
    )
    this.wrap.appendChild(bar)
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
    label.textContent = 'Hover set:'
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
  }

  // --- moveable -------------------------------------------------------------

  private wireMoveable() {
    const mv = this.moveable

    mv.on('drag', (e) => {
      e.target.style.left = `${e.left}px`
      e.target.style.top = `${e.top}px`
    })
    mv.on('dragGroup', (e) => e.events.forEach((ev) => {
      ev.target.style.left = `${ev.left}px`
      ev.target.style.top = `${ev.top}px`
    }))
    mv.on('resize', (e) => {
      e.target.style.width = `${e.width}px`
      e.target.style.height = `${e.height}px`
      e.target.style.left = `${e.drag.left}px`
      e.target.style.top = `${e.drag.top}px`
    })
    mv.on('resizeGroup', (e) => e.events.forEach((ev) => {
      ev.target.style.width = `${ev.width}px`
      ev.target.style.height = `${ev.height}px`
      ev.target.style.left = `${ev.drag.left}px`
      ev.target.style.top = `${ev.drag.top}px`
    }))
    mv.on('rotate', (e) => {
      e.target.style.transform = `rotate(${e.rotation}deg)`
    })
    mv.on('rotateGroup', (e) => e.events.forEach((ev) => {
      ev.target.style.transform = ev.transform
    }))

    const commitFrames = () => this.commitDomFrames(this.selectedNodes())
    mv.on('dragEnd', ({ isDrag }) => isDrag && commitFrames())
    mv.on('dragGroupEnd', ({ isDrag }) => isDrag && commitFrames())
    mv.on('resizeEnd', ({ isDrag }) => isDrag && commitFrames())
    mv.on('resizeGroupEnd', ({ isDrag }) => isDrag && commitFrames())
    mv.on('rotateEnd', ({ isDrag }) => isDrag && commitFrames())
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
      if (this.pathEditor?.active) {
        e.stop() // the path overlay owns the pointer while editing
        return
      }
      if (this.editing) {
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
    if (this.editing === node) return
    this.commitTextEdit()
    const inner = node.querySelector<HTMLElement>('.bento-text-inner')
    if (!inner) return
    this.editing = node
    node.classList.add('bento-editing')
    inner.contentEditable = 'true'
    inner.focus()
    document.getSelection()?.selectAllChildren(inner)
    this.syncTargets()

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

  commitTextEdit() {
    const node = this.editing
    if (!node) return
    this.editing = null
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
