// Editor shell: topbar, slide sidebar, canvas, properties panel, keyboard
// shortcuts, save & present wiring.

import type { Store } from '../store'
import {
  FORMAT_VERSION,
  applyLayout, builtinLayouts, defaultChart, defaultImage, defaultShape, defaultText,
  instantiateLayout, layoutElementIds, uid,
  type ShapeKind, type Slide, type SlideElement,
} from '../model'
import { APP_VERSION, applyUpdate, applyUpdateInPlace, canUpdateInPlace, checkForUpdates } from '../update'
import { CHART_PRESETS } from '../charts'
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
  private panel!: PropsPanel
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
    document.addEventListener('bento:apply-layout', ((ev: CustomEvent) => {
      this.openLayoutPicker(ev.detail.anchor as HTMLElement, { kind: 'apply' })
    }) as EventListener)
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
    logo.title = 'About Bento Slides — version, updates, licenses'
    logo.style.cursor = 'pointer'
    logo.addEventListener('click', () => this.openAbout())
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
      btn(ICONS.chart, 'Chart', () => this.canvas.insert(defaultChart(CHART_PRESETS.bar()))),
    )
    const commentB = btn(ICONS.comment, '', () => this.canvas.toggleCommentMode(),
      'Comment (C) — click an element or a spot on the slide')
    insert.appendChild(commentB)

    const actions = div('ed-group ed-group-right')
    const undoB = btn(ICONS.undo, '', () => this.store.undo(), 'Undo (⌘Z)')
    const redoB = btn(ICONS.redo, '', () => this.store.redo(), 'Redo (⇧⌘Z)')
    const presentB = btn(ICONS.play, 'Present', () => this.present(), 'Present from current slide')
    presentB.classList.add('ed-btn-primary')
    const saveB = btn(ICONS.save, 'Save', () => this.save(false), 'Save — rewrite this file in place (⌘S)')
    const saveAsB = btn(ICONS.download, '', () => this.save(true), 'Save a copy — pick a new file, leave this one untouched')
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
    this.canvas.onCommentModeChange = (on) => commentB.classList.toggle('ed-btn-armed', on)
    this.panel = new PropsPanel(this.props, this.store)
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
    if (slide.comments?.some((c) => !c.resolved)) {
      const badge = div('ed-thumb-cmt')
      badge.title = `${slide.comments.filter((c) => !c.resolved).length} open comment(s)`
      item.appendChild(badge)
    }
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
      // hover gap = insert here; never between a parent and its states
      if (!slide.stateOf) this.sidebar.appendChild(this.insertGap(i))
      const item = this.makeThumb(slide, i, !!slide.stateOf)
      if (slide.stateOf) item.classList.add('ed-thumb-state')
      this.sidebar.appendChild(item)
    })
    this.sidebar.appendChild(this.insertGap(slides.length))
    const add = btn(ICONS.plus, 'New slide', () => this.openLayoutPicker(add))
    add.classList.add('ed-add-slide')
    add.title = 'New slide from a layout'
    this.sidebar.appendChild(add)
    this.sidebar.scrollTop = scroll
    this.highlightSidebar()
  }

  // --- layouts ---------------------------------------------------------------

  /** Layout popover. Serves three flows: the New-slide button, the
   *  insert-gaps (both insert at a position), and Apply-to-current-slide. */
  private openLayoutPicker(
    anchor: HTMLElement,
    action: { kind: 'insert'; at: number } | { kind: 'apply' } = { kind: 'insert', at: this.store.currentIndex + 1 },
  ) {
    document.querySelector('.ed-layoutpick')?.remove()
    const pick = div('ed-layoutpick')
    const doc = this.store.doc
    if (action.kind === 'apply') {
      const t = div('ed-layoutpick-title')
      t.textContent = 'Apply layout to this slide'
      pick.appendChild(t)
    }
    const sections: Array<[string, Slide[], boolean]> = [['Built-in', builtinLayouts(), false]]
    if (doc.layouts?.length) sections.push(['This document', doc.layouts, true])
    for (const [label, layouts, custom] of sections) {
      const h = div('ed-layoutpick-h')
      h.textContent = label
      pick.appendChild(h)
      const grid = div('ed-layoutpick-grid')
      for (const ly of layouts) {
        const item = div('ed-layoutpick-item')
        item.appendChild(renderThumbnail(ly, doc, 104))
        const name = div('ed-layoutpick-name')
        name.textContent = ly.name ?? 'Untitled'
        item.appendChild(name)
        item.addEventListener('click', () => {
          pick.remove()
          if (action.kind === 'insert') this.insertSlideFromLayout(ly, action.at)
          else this.applyLayoutToCurrent(ly)
        })
        if (custom) {
          const del = document.createElement('button')
          del.className = 'ed-layoutpick-del'
          del.textContent = '✕'
          del.title = 'Delete this layout'
          del.addEventListener('click', (ev) => {
            ev.stopPropagation()
            this.store.commit(() => {
              doc.layouts = doc.layouts!.filter((l) => l.id !== ly.id)
              if (!doc.layouts.length) delete doc.layouts
            })
            pick.remove()
          })
          item.appendChild(del)
        }
        grid.appendChild(item)
      }
      pick.appendChild(grid)
    }
    const r = anchor.getBoundingClientRect()
    if (anchor.classList.contains('ed-add-slide')) {
      // bottom-of-sidebar button: open upward from it
      pick.style.left = `${Math.max(8, r.left)}px`
      pick.style.bottom = `${window.innerHeight - r.top + 8}px`
    } else {
      // insert-gap or panel button: open beside the anchor, clamped on-screen
      pick.style.left = `${Math.max(8, Math.min(r.right + 10, window.innerWidth - 440))}px`
      pick.style.top = `${Math.max(8, Math.min(r.top - 40, window.innerHeight - 460))}px`
    }
    document.body.appendChild(pick)
    const close = (ev: PointerEvent) => {
      if (!pick.contains(ev.target as Node)) {
        pick.remove()
        document.removeEventListener('pointerdown', close, true)
      }
    }
    setTimeout(() => document.addEventListener('pointerdown', close, true))
  }

  private insertSlideFromLayout(layout: Slide, at: number) {
    const slide = instantiateLayout(layout)
    this.store.commit(() => {
      this.store.doc.slides.splice(at, 0, slide)
    }, 'slides')
    this.store.goTo(at)
  }

  /** Re-arrange the current slide onto a layout: content matched by id, then
   *  by role; the layout brings frame + typography; extras are kept on top. */
  private applyLayoutToCurrent(layout: Slide) {
    const known = layoutElementIds(this.store.doc)
    this.store.commit(() => {
      const s = this.store.slide
      s.elements = applyLayout(s, layout, known)
      s.background = layout.background
    })
    this.store.select([])
  }

  /** Slim hover strip between thumbnails — click inserts a blank slide there. */
  private insertGap(at: number): HTMLElement {
    const gap = div('ed-insertgap')
    gap.title = 'Insert slide here'
    const plus = document.createElement('button')
    plus.className = 'ed-insertgap-btn'
    plus.textContent = '＋'
    plus.tabIndex = -1
    gap.appendChild(plus)
    gap.addEventListener('click', () => this.openLayoutPicker(gap, { kind: 'insert', at }))
    return gap
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
      const base = Math.max(96, this.panelW.left - 40)
      thumbs.forEach((item) => {
        const slide = this.store.doc.slides[Number(item.dataset.index)]
        if (!slide) return
        const w = slide.stateOf ? Math.round(base * 0.84) : base
        item.querySelector('.bento-thumb-surface')?.replaceWith(renderThumbnail(slide, this.store.doc, w))
        // comment badge tracks doc-level changes too (comments emit 'doc')
        const open = slide.comments?.some((c) => !c.resolved)
        const badge = item.querySelector('.ed-thumb-cmt')
        if (open && !badge) {
          const b = div('ed-thumb-cmt')
          b.title = 'Open comment(s)'
          item.appendChild(b)
        } else if (!open && badge) {
          badge.remove()
        }
      })
    }, 150)
  }

  // --- slide ops ------------------------------------------------------------------

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
      const surface = renderSlide(slide, this.store.doc, { svgAsImage: true, hidePlaceholders: true })
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

      if (!mod && ev.key.toLowerCase() === 'c') {
        ev.preventDefault()
        this.canvas.toggleCommentMode()
        return
      }
      if (mod && ev.key.toLowerCase() === 'g') {
        ev.preventDefault()
        const els = this.store.selectedElements
        if (ev.shiftKey) this.panel.ungroup(els)
        else this.panel.group(els)
        return
      }
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

  // --- about & updates ------------------------------------------------------

  /** About dialog: version, user-initiated update check, licenses. */
  private openAbout() {
    document.querySelector('.ed-about-overlay')?.remove()
    const overlay = div('ed-about-overlay')
    const box = div('ed-about')

    const head = div('ed-about-head')
    head.innerHTML =
      `<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">` +
      `<rect width="32" height="32" rx="7" fill="#1E2A3A"/>` +
      `<rect x="5" y="5" width="6" height="22" rx="2.5" fill="#5B8DEF"/>` +
      `<rect x="14" y="5" width="13" height="10" rx="2.5" fill="#F7A600"/>` +
      `<rect x="14" y="17" width="13" height="10" rx="2.5" fill="#E9EDF3"/>` +
      `</svg><div><b>Bento Slides</b><span>v${APP_VERSION} · format v${FORMAT_VERSION}</span></div>`
    box.appendChild(head)

    const status = div('ed-about-status')
    status.textContent = 'This file carries its own app — it works offline, forever, as is.'

    const row = div('ed-about-row')
    const checkB = document.createElement('button')
    checkB.className = 'ed-btn'
    checkB.textContent = 'Check for updates'
    checkB.addEventListener('click', async () => {
      checkB.disabled = true
      status.textContent = 'Checking…'
      const result = await checkForUpdates()
      checkB.disabled = false
      if (result.status === 'current') {
        status.textContent = `You're on the latest version (v${result.version}).`
      } else if (result.status === 'error') {
        status.textContent = `Couldn't check: ${result.message}`
      } else {
        const { release } = result
        status.textContent = ''
        const line = div('ed-about-new')
        line.textContent = `Version ${release.version} is available.`
        status.appendChild(line)
        if (release.notes) {
          const notes = div('ed-about-notes')
          notes.textContent = release.notes
          status.appendChild(notes)
        }
        const fail = (err: any) => { status.textContent = `Update failed: ${err?.message ?? err}` }
        const done = () => {
          status.textContent = ''
          const ok = div('ed-about-new')
          ok.textContent = `Updated to v${release.version} on disk.`
          status.appendChild(ok)
          const note = div('ed-about-notes')
          note.textContent = canUpdateInPlace()
            ? `This window is still running v${APP_VERSION} — reload to finish. A v${APP_VERSION} backup was downloaded.`
            : `This window is still running v${APP_VERSION}. If you overwrote the file that's open here, reload; otherwise open the file you saved.`
          status.appendChild(note)
          const reloadB = document.createElement('button')
          reloadB.className = 'ed-btn ed-btn-primary'
          reloadB.textContent = 'Reload into new version'
          reloadB.addEventListener('click', () => {
            this.store.setDirty(false) // disk already holds this exact document
            location.reload()
          })
          status.appendChild(reloadB)
        }

        const inPlaceB = document.createElement('button')
        inPlaceB.className = 'ed-btn ed-btn-primary'
        inPlaceB.textContent = canUpdateInPlace() ? 'Update this file' : 'Update this file…'
        inPlaceB.title = canUpdateInPlace()
          ? 'Downloads a backup of the current version, then rewrites this file on disk as the new version — document untouched.'
          : 'Verifies and builds the new version with this document inside, then asks where to save it — pick the file you have open to update it.'
        inPlaceB.addEventListener('click', async () => {
          inPlaceB.disabled = true
          inPlaceB.textContent = 'Verifying…'
          try {
            const written = await applyUpdateInPlace(release, this.store.doc)
            if (written) done()
            else { inPlaceB.disabled = false; inPlaceB.textContent = 'Update this file…' }
          } catch (err: any) { fail(err) }
        })
        status.appendChild(inPlaceB)

        const getB = document.createElement('button')
        getB.className = 'ed-btn'
        getB.textContent = 'Download updated copy'
        getB.title = 'Downloads the new version with this document inside. The file you have now is not touched.'
        getB.addEventListener('click', async () => {
          getB.disabled = true
          getB.textContent = 'Verifying…'
          try {
            await applyUpdate(release, this.store.doc)
            getB.textContent = 'Downloaded ✓'
            const note = div('ed-about-notes')
            note.textContent = `This window keeps running v${APP_VERSION} until you open the downloaded file.`
            status.appendChild(note)
          } catch (err: any) { fail(err) }
        })
        status.appendChild(getB)
      }
    })
    row.appendChild(checkB)
    box.append(row, status)

    const fine = div('ed-about-fine')
    fine.innerHTML =
      `Checking contacts the release server once and sends nothing about you or this document.<br>` +
      `Includes reveal.js, Moveable, Selecto (MIT) · Apache ECharts (Apache-2.0) · zrender (BSD-3) · Fraunces typeface (OFL-1.1) — full notices travel in this file’s source.`
    box.appendChild(fine)

    overlay.appendChild(box)
    const close = () => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        close()
      }
    }
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close()
    })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
  }

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
