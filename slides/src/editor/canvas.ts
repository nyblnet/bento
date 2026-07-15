// The editing canvas: renders the current slide at fit-to-window scale and
// wires Moveable (drag/resize/rotate/snap) + Selecto (click & rubber-band
// selection) + contenteditable text editing on top of it.

import Moveable from 'moveable'
import Selecto from 'selecto'
import type { Store } from '../store'
import type { SlideElement } from '../model'
import { renderSlide, sanitizeHtml } from '../render'

export class SlideCanvas {
  private stage: HTMLElement
  private scaleHost: HTMLElement
  private surface: HTMLElement | null = null
  private moveable: Moveable
  private selecto: Selecto
  private scale = 1
  private editing: HTMLElement | null = null

  constructor(
    private wrap: HTMLElement,
    private store: Store,
  ) {
    this.stage = document.createElement('div')
    this.stage.className = 'ed-stage'
    this.scaleHost = document.createElement('div')
    this.scaleHost.className = 'ed-stage-scale'
    this.stage.appendChild(this.scaleHost)
    wrap.appendChild(this.stage)

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
      hitRate: 0,
    })

    this.wireMoveable()
    this.wireSelecto()

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
    const availW = this.wrap.clientWidth - 64
    const availH = this.wrap.clientHeight - 64
    if (availW <= 0 || availH <= 0) return
    this.scale = Math.min(availW / width, availH / height)
    this.stage.style.width = `${width * this.scale}px`
    this.stage.style.height = `${height * this.scale}px`
    this.scaleHost.style.transform = `scale(${this.scale})`
    this.moveable.zoom = 1 / this.scale
    this.moveable.updateRect()
  }

  render() {
    this.commitTextEdit()
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
    const targets = this.editing ? [] : this.selectedNodes()
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
      this.store.select(ids)
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
      }
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
    const html = sanitizeHtml(inner.innerHTML)
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
