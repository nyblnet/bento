// Editor shell: topbar, slide sidebar, canvas, properties panel, keyboard
// shortcuts, save & present wiring.

import type { Store } from '../store'
import {
  defaultImage, defaultShape, defaultText, emptySlide, uid,
  type ShapeKind, type SlideElement,
} from '../model'
import { renderSlide, renderThumbnail } from '../render'
import { SlideCanvas } from './canvas'
import { PropsPanel } from './panels'
import { startPresentation } from '../present'
import { saveFile } from '../save'
import { ICONS } from '../icons'

const SHAPE_MENU: Array<{ kind: ShapeKind; label: string; icon: string }> = [
  { kind: 'rect', label: 'Rectangle', icon: ICONS.rect },
  { kind: 'ellipse', label: 'Ellipse', icon: ICONS.ellipse },
  { kind: 'triangle', label: 'Triangle', icon: ICONS.triangle },
  { kind: 'arrow', label: 'Arrow', icon: ICONS.arrow },
  { kind: 'line', label: 'Line', icon: ICONS.line },
]

export class Editor {
  private canvas!: SlideCanvas
  private sidebar!: HTMLElement
  private props!: HTMLElement
  private dirtyDot!: HTMLElement
  private thumbTimer = 0
  private clipboard: SlideElement[] = []
  private presenting = false
  /** side panel widths (px) — user-resizable, persisted per browser */
  private panelW = { left: 188, right: 236 }

  constructor(
    private root: HTMLElement,
    private store: Store,
  ) {
    this.build()
    this.wireKeyboard()
    store.on('slides', () => this.rebuildSidebar())
    store.on('current', () => this.highlightSidebar())
    store.on('doc', () => this.scheduleThumbs())
    store.on('dirty', () => {
      this.dirtyDot.classList.toggle('on', store.dirty)
    })
    window.addEventListener('beforeunload', (ev) => {
      if (store.dirty) ev.preventDefault()
    })
    this.rebuildSidebar()
  }

  // --- DOM ----------------------------------------------------------------

  private build() {
    this.root.innerHTML = ''
    this.root.className = 'ed-root'

    // topbar
    const bar = div('ed-topbar')
    const logo = div('ed-logo')
    logo.innerHTML =
      `<svg class="ed-logo-mark" viewBox="0 0 32 32" width="20" height="20" aria-hidden="true">` +
      `<rect width="32" height="32" rx="7" fill="#1E2A3A"/>` +
      `<rect x="5" y="5" width="6" height="22" rx="2.5" fill="#5B8DEF"/>` +
      `<rect x="14" y="5" width="13" height="10" rx="2.5" fill="#F7A600"/>` +
      `<rect x="14" y="17" width="13" height="10" rx="2.5" fill="#E9EDF3"/>` +
      `</svg> <b>Bento</b>&nbsp;Slides`
    const title = document.createElement('input')
    title.className = 'ed-title'
    title.value = this.store.doc.title
    title.spellcheck = false
    title.addEventListener('change', () => {
      this.store.commit(() => { this.store.doc.title = title.value || 'Untitled' })
      document.title = `${this.store.doc.title} — Bento Slides`
    })
    this.dirtyDot = div('ed-dirty')
    this.dirtyDot.title = 'Unsaved changes'

    const insert = div('ed-group')
    insert.append(
      btn(ICONS.text, 'Text', () => this.canvas.insert(defaultText({ y: 120 + Math.random() * 200 }), true)),
      this.shapeDropdown(),
      btn(ICONS.image, 'Image', () => this.pickImage()),
    )

    const actions = div('ed-group ed-group-right')
    const undoB = btn(ICONS.undo, '', () => this.store.undo(), 'Undo (⌘Z)')
    const redoB = btn(ICONS.redo, '', () => this.store.redo(), 'Redo (⇧⌘Z)')
    const presentB = btn(ICONS.play, 'Present', () => this.present(), 'Present from current slide')
    presentB.classList.add('ed-btn-primary')
    const saveB = btn(ICONS.save, 'Save', () => this.save(false), 'Save (⌘S)')
    const saveAsB = btn(ICONS.download, '', () => this.save(true), 'Save a copy…')
    const pdfB = btn(ICONS.pdf, '', () => this.exportPdf(), 'Export PDF (print)')
    const leftT = btn(ICONS.panelLeft, '', () => this.togglePanel('left'), 'Toggle slide list ([)')
    const rightT = btn(ICONS.panelRight, '', () => this.togglePanel('right'), 'Toggle properties (])')
    actions.append(undoB, redoB, pdfB, leftT, rightT, presentB, saveB, saveAsB)

    bar.append(logo, title, this.dirtyDot, insert, actions)

    // main area
    const main = div('ed-main')
    this.sidebar = div('ed-sidebar')
    const canvasWrap = div('ed-canvas-wrap')
    this.props = div('ed-props')
    main.append(this.sidebar, this.makeResizer('left'), canvasWrap, this.makeResizer('right'), this.props)

    this.root.append(bar, main)

    this.restorePanelWidths()
    this.canvas = new SlideCanvas(canvasWrap, this.store)
    new PropsPanel(this.props, this.store)
  }

  // --- resizable side panels ------------------------------------------------

  private static PANEL_BOUNDS = { left: [110, 400], right: [190, 520] } as const
  private static PANEL_DEFAULTS = { left: 188, right: 236 } as const

  private restorePanelWidths() {
    try {
      const saved = JSON.parse(localStorage.getItem('bento-ed-panels') ?? '{}')
      for (const side of ['left', 'right'] as const) {
        const [min, max] = Editor.PANEL_BOUNDS[side]
        if (typeof saved[side] === 'number') this.panelW[side] = Math.min(max, Math.max(min, saved[side]))
      }
    } catch { /* corrupt storage — keep defaults */ }
    this.applyPanelWidths()
  }

  private applyPanelWidths() {
    this.sidebar.style.setProperty('--panew', `${this.panelW.left}px`)
    this.props.style.setProperty('--panew', `${this.panelW.right}px`)
  }

  private makeResizer(side: 'left' | 'right'): HTMLElement {
    const handle = div('ed-resizer')
    handle.title = 'Drag to resize · double-click to reset'
    const commit = () => {
      localStorage.setItem('bento-ed-panels', JSON.stringify(this.panelW))
      // thumbnails render at a width derived from the sidebar — refit them
      if (side === 'left') this.rebuildSidebar()
    }
    handle.addEventListener('mousedown', (down) => {
      const panel = side === 'left' ? this.sidebar : this.props
      if (panel.classList.contains('ed-collapsed')) return
      down.preventDefault()
      const startX = down.clientX
      const startW = this.panelW[side]
      const [min, max] = Editor.PANEL_BOUNDS[side]
      panel.classList.add('ed-noanim')
      document.body.classList.add('ed-col-resizing')
      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - startX
        this.panelW[side] = Math.min(max, Math.max(min, startW + (side === 'left' ? dx : -dx)))
        this.applyPanelWidths()
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        panel.classList.remove('ed-noanim')
        document.body.classList.remove('ed-col-resizing')
        commit()
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
    handle.addEventListener('dblclick', () => {
      this.panelW[side] = Editor.PANEL_DEFAULTS[side]
      this.applyPanelWidths()
      commit()
    })
    return handle
  }

  /** Collapse/expand the slide list or the properties panel. */
  togglePanel(side: 'left' | 'right') {
    const el = side === 'left' ? this.sidebar : this.props
    el.classList.toggle('ed-collapsed')
    // the canvas wrap resizes; its ResizeObserver re-fits the stage
  }

  private shapeDropdown(): HTMLElement {
    const wrap = div('ed-dropdown')
    const trigger = btn(ICONS.shapes, 'Shape', () => wrap.classList.toggle('open'))
    const menu = div('ed-menu')
    for (const item of SHAPE_MENU) {
      const b = btn(item.icon, item.label, () => {
        wrap.classList.remove('open')
        const partial = item.kind === 'line' ? { h: 4, w: 400, strokeWidth: 3 } : {}
        this.canvas.insert(defaultShape(item.kind, partial))
      })
      menu.appendChild(b)
    }
    wrap.append(trigger, menu)
    document.addEventListener('pointerdown', (ev) => {
      if (!wrap.contains(ev.target as Node)) wrap.classList.remove('open')
    })
    return wrap
  }

  // --- sidebar -----------------------------------------------------------------

  private makeThumb(slide: import('../model').Slide, i: number, isState: boolean): HTMLElement {
    const item = div('ed-thumb')
    item.dataset.index = String(i)
    item.draggable = !isState
    const num = div('ed-thumb-num')
    if (isState) {
      const parentIdx = this.store.doc.slides.findIndex((s) => s.id === slide.stateOf)
      num.textContent = slide.name ?? `⤷ ${parentIdx + 1}`
      num.title = `Interactive state of slide ${parentIdx + 1} — reached via links while presenting`
    } else {
      num.textContent = String(this.linearNumber(i))
    }
    // thumb width tracks the (resizable) sidebar; states render smaller
    const base = Math.max(96, this.panelW.left - 40)
    const surface = renderThumbnail(slide, this.store.doc, isState ? Math.round(base * 0.84) : base)
    const tools = div('ed-thumb-tools')
    tools.append(
      btn(ICONS.copy, '', (ev) => { ev.stopPropagation(); this.duplicateSlide(i) }, 'Duplicate slide'),
      btn(ICONS.trash, '', (ev) => { ev.stopPropagation(); this.deleteSlide(i) }, 'Delete slide'),
    )
    item.append(num, surface, tools)
    item.addEventListener('click', () => this.store.goTo(i))
    if (!isState) this.wireThumbDrag(item, i)
    return item
  }

  /** 1-based position among non-state slides (what the audience counts). */
  private linearNumber(i: number): number {
    return this.store.doc.slides.slice(0, i + 1).filter((s) => !s.stateOf).length
  }

  private rebuildSidebar() {
    // States sit in doc order right after their parent and render nested —
    // smaller, indented, dimmed — so the structure reads at a glance.
    const scroll = this.sidebar.scrollTop
    this.sidebar.innerHTML = ''
    const slides = this.store.doc.slides
    slides.forEach((slide, i) => {
      const item = this.makeThumb(slide, i, !!slide.stateOf)
      if (slide.stateOf) item.classList.add('ed-thumb-state')
      this.sidebar.appendChild(item)
    })
    const add = btn(ICONS.plus, 'New slide', () => this.addSlide())
    add.classList.add('ed-add-slide')
    this.sidebar.appendChild(add)
    this.sidebar.scrollTop = scroll
    this.highlightSidebar()
  }

  private wireThumbDrag(item: HTMLElement, index: number) {
    item.addEventListener('dragstart', (ev) => {
      ev.dataTransfer!.setData('text/bento-slide', String(index))
      ev.dataTransfer!.effectAllowed = 'move'
    })
    item.addEventListener('dragover', (ev) => {
      ev.preventDefault()
      item.classList.add('drop')
    })
    item.addEventListener('dragleave', () => item.classList.remove('drop'))
    item.addEventListener('drop', (ev) => {
      ev.preventDefault()
      item.classList.remove('drop')
      const from = parseInt(ev.dataTransfer!.getData('text/bento-slide'))
      if (Number.isNaN(from) || from === index) return
      this.store.commit(() => {
        const [moved] = this.store.doc.slides.splice(from, 1)
        this.store.doc.slides.splice(index, 0, moved)
      }, 'slides')
      this.store.currentIndex = index
      this.store.emit('current')
    })
  }

  private highlightSidebar() {
    this.sidebar.querySelectorAll<HTMLElement>('.ed-thumb').forEach((n) => {
      n.classList.toggle('active', Number(n.dataset.index) === this.store.currentIndex)
    })
  }

  private scheduleThumbs() {
    clearTimeout(this.thumbTimer)
    this.thumbTimer = window.setTimeout(() => {
      const thumbs = this.sidebar.querySelectorAll<HTMLElement>('.ed-thumb')
      if (thumbs.length !== this.store.doc.slides.length) return this.rebuildSidebar()
      thumbs.forEach((item) => {
        const slide = this.store.doc.slides[Number(item.dataset.index)]
        if (!slide) return
        item.querySelector('.bento-thumb-surface')?.replaceWith(renderThumbnail(slide, this.store.doc, 148))
      })
    }, 150)
  }

  // --- slide ops ------------------------------------------------------------------

  private addSlide() {
    const bg = this.store.slide.background
    this.store.commit(() => {
      this.store.doc.slides.splice(this.store.currentIndex + 1, 0, emptySlide({ background: bg }))
    }, 'slides')
    this.store.goTo(this.store.currentIndex + 1)
  }

  private duplicateSlide(i: number) {
    // Duplicated slides keep element ids → set transition to morph and you
    // get PowerPoint-Morph behaviour for free.
    const clone = JSON.parse(JSON.stringify(this.store.doc.slides[i]))
    clone.id = uid('slide')
    this.store.commit(() => {
      this.store.doc.slides.splice(i + 1, 0, clone)
    }, 'slides')
    this.store.goTo(i + 1)
  }

  private deleteSlide(i: number) {
    if (this.store.doc.slides.length <= 1) return this.toast('A deck needs at least one slide')
    const target = this.store.doc.slides[i]
    // dependents: states of this slide, and element links pointing at it
    const states = this.store.doc.slides.filter((s) => s.stateOf === target.id)
    const doomedIds = new Set([target.id, ...states.map((s) => s.id)])
    let linkCount = 0
    for (const s of this.store.doc.slides) {
      if (doomedIds.has(s.id)) continue
      for (const el of s.elements) if (el.link && doomedIds.has(el.link)) linkCount++
    }
    if (states.length || linkCount) {
      const parts = [
        states.length ? `${states.length} interactive state${states.length > 1 ? 's' : ''} will be deleted with it` : '',
        linkCount ? `${linkCount} element link${linkCount > 1 ? 's' : ''} will be cleared` : '',
      ].filter(Boolean).join('; ')
      if (!window.confirm(`Delete this slide? ${parts}.`)) return
    }
    this.store.commit(() => {
      this.store.doc.slides = this.store.doc.slides.filter((s) => !doomedIds.has(s.id))
      for (const s of this.store.doc.slides) {
        for (const el of s.elements) {
          if (el.link && doomedIds.has(el.link)) delete el.link
        }
      }
    }, 'slides')
    this.store.goTo(Math.min(i, this.store.doc.slides.length - 1))
    this.store.emit('current')
  }

  /**
   * Export the deck to PDF via the browser's print pipeline: every linear
   * slide becomes one exact 1600×900 page (states are reachable only through
   * interaction, so they stay out of the paper trail).
   */
  exportPdf() {
    this.canvas.commitTextEdit()
    document.getElementById('bento-print')?.remove()
    const box = div('')
    box.id = 'bento-print'
    for (const slide of this.store.doc.slides) {
      if (slide.stateOf) continue
      const page = div('bp-page')
      const surface = renderSlide(slide, this.store.doc, { svgAsImage: true })
      // normalise to the print page size regardless of doc size
      const s = 1600 / this.store.doc.size.width
      surface.style.transformOrigin = '0 0'
      if (s !== 1) surface.style.transform = `scale(${s})`
      page.appendChild(surface)
      box.appendChild(page)
    }
    document.body.appendChild(box)
    const cleanup = () => {
      box.remove()
      window.removeEventListener('afterprint', cleanup)
    }
    window.addEventListener('afterprint', cleanup)
    // give the freshly-inserted images a beat to decode before printing
    setTimeout(() => window.print(), 250)
  }

  // --- insert image ------------------------------------------------------------------

  private pickImage() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const src = String(reader.result)
        const img = new Image()
        img.onload = () => {
          const { width: dw, height: dh } = this.store.doc.size
          const scale = Math.min((dw * 0.5) / img.width, (dh * 0.5) / img.height, 1)
          const w = Math.round(img.width * scale)
          const h = Math.round(img.height * scale)
          this.canvas.insert(defaultImage(src, { w, h, x: (dw - w) / 2, y: (dh - h) / 2 }))
        }
        img.src = src
      }
      reader.readAsDataURL(file)
    })
    input.click()
  }

  // --- present & save ------------------------------------------------------------------

  present(fromStart = false) {
    if (this.presenting) return
    this.canvas.commitTextEdit()
    this.presenting = true
    startPresentation(this.store.doc, fromStart ? 0 : this.store.currentIndex, (last) => {
      this.presenting = false
      this.store.goTo(last)
      this.canvas.render()
    })
  }

  async save(forcePicker: boolean) {
    this.canvas.commitTextEdit()
    try {
      const result = await saveFile(this.store.doc, forcePicker)
      if (result === 'cancelled') return
      this.store.setDirty(false)
      this.toast(result === 'downloaded'
        ? 'This browser can’t rewrite files in place — a fresh copy went to Downloads'
        : 'Saved')
    } catch (err) {
      console.error(err)
      this.toast('Save failed — see console')
    }
  }

  // --- keyboard ------------------------------------------------------------------

  private wireKeyboard() {
    document.addEventListener('keydown', (ev) => {
      if (this.presenting) return
      const mod = ev.metaKey || ev.ctrlKey
      const inField =
        ev.target instanceof Element &&
        ev.target.closest('input, textarea, select, [contenteditable="true"]') != null

      if (mod && ev.key.toLowerCase() === 's') {
        ev.preventDefault()
        this.save(false)
        return
      }
      if (mod && (ev.key === '=' || ev.key === '+')) {
        ev.preventDefault()
        this.canvas.zoomIn()
        return
      }
      if (mod && ev.key === '-') {
        ev.preventDefault()
        this.canvas.zoomOut()
        return
      }
      if (mod && ev.key === '0') {
        ev.preventDefault()
        this.canvas.zoomReset()
        return
      }
      if (ev.key === 'F5') {
        ev.preventDefault()
        this.present(!ev.shiftKey)
        return
      }
      if (inField) return

      if (mod && ev.key.toLowerCase() === 'z') {
        ev.preventDefault()
        ev.shiftKey ? this.store.redo() : this.store.undo()
        return
      }
      if (mod && ev.key.toLowerCase() === 'y') {
        ev.preventDefault()
        this.store.redo()
        return
      }
      if (mod && ev.key.toLowerCase() === 'd') {
        ev.preventDefault()
        this.duplicateSelection()
        return
      }
      if (mod && ev.key.toLowerCase() === 'c') {
        if (this.store.selection.length) {
          this.clipboard = JSON.parse(JSON.stringify(this.store.selectedElements))
        }
        return
      }
      if (mod && ev.key.toLowerCase() === 'v') {
        if (this.clipboard.length) {
          const clones = this.clipboard.map((el) => cloneElement(el))
          this.store.commit(() => this.store.slide.elements.push(...clones))
          this.store.select(clones.map((c) => c.id))
        }
        return
      }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (this.store.selection.length) {
          ev.preventDefault()
          const ids = new Set(this.store.selection)
          this.store.commit(() => {
            this.store.slide.elements = this.store.slide.elements.filter((e) => !ids.has(e.id))
          })
          this.store.select([])
        }
        return
      }
      if (ev.key.startsWith('Arrow') && this.store.selection.length) {
        ev.preventDefault()
        const step = ev.shiftKey ? 10 : 1
        const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0
        const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0
        this.store.commit(() => {
          for (const el of this.store.selectedElements) {
            el.x += dx
            el.y += dy
          }
        })
        return
      }
      if (ev.key === '[') {
        this.togglePanel('left')
        return
      }
      if (ev.key === ']') {
        this.togglePanel('right')
        return
      }
      if (ev.key === 'Escape') {
        if (this.canvas.isPathEditing) this.canvas.stopPathEdit(true)
        else this.store.select([])
        return
      }
      if (ev.key === 'PageDown') {
        ev.preventDefault()
        this.store.goTo(this.store.currentIndex + 1)
        return
      }
      if (ev.key === 'PageUp') {
        ev.preventDefault()
        this.store.goTo(this.store.currentIndex - 1)
      }
    })
  }

  private duplicateSelection() {
    const els = this.store.selectedElements
    if (!els.length) return
    const clones = els.map((el) => cloneElement(el))
    this.store.commit(() => this.store.slide.elements.push(...clones))
    this.store.select(clones.map((c) => c.id))
  }

  // --- toast ------------------------------------------------------------------

  toast(message: string) {
    document.querySelector('.ed-toast')?.remove()
    const t = div('ed-toast')
    t.textContent = message
    document.body.appendChild(t)
    setTimeout(() => t.classList.add('show'))
    setTimeout(() => {
      t.classList.remove('show')
      setTimeout(() => t.remove(), 300)
    }, 2200)
  }
}

/** Deep-clone an element with a fresh id (same-slide duplicates must not share ids). */
function cloneElement(el: SlideElement): SlideElement {
  return { ...JSON.parse(JSON.stringify(el)), id: uid(el.type[0]), x: el.x + 24, y: el.y + 24 }
}

// tiny DOM helpers
function div(cls: string): HTMLElement {
  const d = document.createElement('div')
  d.className = cls
  return d
}

function btn(
  icon: string,
  label: string,
  onClick: (ev: MouseEvent) => void,
  title?: string,
): HTMLElement {
  const b = document.createElement('button')
  b.className = 'ed-btn'
  b.innerHTML = label ? `${icon}<span>${label}</span>` : icon
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}
