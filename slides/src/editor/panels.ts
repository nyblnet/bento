// Right-hand properties panel. Shows slide properties when nothing is
// selected, element properties otherwise. Bursts of 'input' events collapse
// into a single undo checkpoint.

import type { Store } from '../store'
import { uid, type ShapeElement, type SlideElement, type TextElement, type TransitionKind } from '../model'
import { ICONS } from '../icons'

export class PropsPanel {
  private burst = false

  constructor(
    private host: HTMLElement,
    private store: Store,
  ) {
    store.on('selection', () => this.rebuild())
    store.on('current', () => this.rebuild())
    store.on('doc', () => this.rebuild())
    this.rebuild()
  }

  /** checkpoint once per burst of continuous input, commit on change. */
  private edit(mutate: () => void, final: boolean) {
    if (!this.burst) {
      this.store.checkpoint()
      this.burst = true
    }
    mutate()
    this.store.touch()
    if (final) this.burst = false
  }

  private rebuild() {
    if (this.host.matches(':focus-within')) return // don't rip inputs out from under the user
    this.burst = false
    this.host.innerHTML = ''
    const els = this.store.selectedElements
    if (els.length === 0) this.buildSlidePanel()
    else if (els.length === 1) this.buildElementPanel(els[0])
    else this.buildMultiPanel(els)
  }

  // --- builders ---------------------------------------------------------------

  private buildSlidePanel() {
    const slide = this.store.slide
    this.section('Slide')
    this.row('Background', this.color(slide.background, (v, fin) =>
      this.edit(() => { this.store.slide.background = v }, fin)))
    this.row('Transition', this.select(
      ['none', 'fade', 'slide', 'zoom', 'morph'],
      slide.transition,
      (v) => this.edit(() => { this.store.slide.transition = v as TransitionKind }, true),
    ))
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.innerHTML = '<b>Morph</b> animates elements that appear on both this slide and the previous one (copy a slide, then move things around).'
    this.host.appendChild(hint)

    // interactivity: naming, state-of, hover focus
    this.section('Interactivity')
    const name = document.createElement('input')
    name.type = 'text'
    name.placeholder = 'unnamed'
    name.value = slide.name ?? ''
    name.addEventListener('change', () =>
      this.edit(() => { this.store.slide.name = name.value || undefined }, true))
    this.row('Name', name)

    const stateSel = document.createElement('select')
    const optNone = document.createElement('option')
    optNone.value = ''
    optNone.textContent = 'no — normal slide'
    stateSel.appendChild(optNone)
    this.store.doc.slides.forEach((s, i) => {
      if (s.stateOf || s.id === slide.id) return
      const o = document.createElement('option')
      o.value = s.id
      o.textContent = this.slideLabel(s, i)
      if (slide.stateOf === s.id) o.selected = true
      stateSel.appendChild(o)
    })
    stateSel.addEventListener('change', () =>
      this.edit(() => {
        this.store.slide.stateOf = stateSel.value || undefined
        this.store.emit('slides')
      }, true))
    this.row('State of', stateSel)
    const stateHint = document.createElement('p')
    stateHint.className = 'ed-hint'
    stateHint.innerHTML =
      'A <b>state</b> is hidden from arrow-key flow — viewers reach it by clicking a linked element. Shared element ids morph between states.'
    this.host.appendChild(stateHint)

    this.row('Hover', this.select(
      ['none', 'focus-group'],
      slide.hover?.type ?? 'none',
      (v) => this.edit(() => {
        this.store.slide.hover = v === 'focus-group' ? { type: 'focus-group', dim: slide.hover?.dim ?? 0.15 } : undefined
      }, true)))
    if (slide.hover) {
      this.row('Hover dim', this.number(slide.hover.dim ?? 0.15, 0.01, (v, fin) =>
        this.edit(() => { if (this.store.slide.hover) this.store.slide.hover.dim = Math.min(Math.max(v, 0), 1) }, fin)))
    }

    this.section('Speaker notes')
    const notes = document.createElement('textarea')
    notes.className = 'ed-notes'
    notes.placeholder = 'Notes for presenter view (press S while presenting)…'
    notes.value = slide.notes
    notes.addEventListener('input', () => this.edit(() => { this.store.slide.notes = notes.value }, false))
    notes.addEventListener('change', () => this.edit(() => { this.store.slide.notes = notes.value }, true))
    this.host.appendChild(notes)
  }

  private buildMultiPanel(els: SlideElement[]) {
    this.section(`${els.length} elements`)
    this.opsRow(els)
  }

  private buildElementPanel(el: SlideElement) {
    this.section({ text: 'Text', shape: 'Shape', image: 'Image', svg: 'Diagram' }[el.type])
    this.opsRow([el])

    // geometry
    const geo = document.createElement('div')
    geo.className = 'ed-grid2'
    geo.append(
      this.mini('X', el.x, (v) => this.setNum(el.id, 'x', v)),
      this.mini('Y', el.y, (v) => this.setNum(el.id, 'y', v)),
      this.mini('W', el.w, (v) => this.setNum(el.id, 'w', Math.max(v, 1))),
      this.mini('H', el.h, (v) => this.setNum(el.id, 'h', Math.max(v, 1))),
      this.mini('Angle', el.rotation, (v) => this.setNum(el.id, 'rotation', v)),
      this.mini('Opacity', Math.round(el.opacity * 100), (v) =>
        this.setNum(el.id, 'opacity', Math.min(Math.max(v / 100, 0), 1))),
    )
    this.host.appendChild(geo)

    if (el.type === 'text') this.buildTextProps(el)
    if (el.type === 'shape') this.buildShapeProps(el)
    if (el.type === 'image') this.buildImageProps(el)

    this.buildPresentingProps(el)

    const morph = document.createElement('p')
    morph.className = 'ed-hint'
    morph.innerHTML = `Morph id: <code>${el.id}</code>`
    this.host.appendChild(morph)
  }

  /** fx + link — how the element behaves while presenting. */
  private buildPresentingProps(el: SlideElement) {
    this.section('Presenting')
    const setFx = (patch: Partial<NonNullable<SlideElement['fx']>>) =>
      this.mutate(el.id, (e) => {
        const fx = { ...(e.fx ?? {}), ...patch }
        if (!fx.enter && !fx.countUp && !fx.ambient) delete e.fx
        else e.fx = fx
      }, true)

    this.row('Enter', this.select(
      ['none', 'fade', 'fade-up'], el.fx?.enter ?? 'none',
      (v) => setFx({ enter: v === 'none' ? undefined : (v as 'fade' | 'fade-up') })))
    this.row('Count up', this.select(
      ['off', 'on'], el.fx?.countUp ? 'on' : 'off',
      (v) => setFx({ countUp: v === 'on' ? true : undefined })))
    this.row('Ambient', this.select(
      ['none', 'kenburns'], el.fx?.ambient ?? 'none',
      (v) => setFx({ ambient: v === 'none' ? undefined : 'kenburns' })))

    // group tag (hover focus & interaction targeting)
    const group = document.createElement('input')
    group.type = 'text'
    group.placeholder = 'none'
    group.value = el.group ?? ''
    group.addEventListener('change', () =>
      this.mutate(el.id, (e) => {
        if (group.value) e.group = group.value
        else delete e.group
      }, true))
    this.row('Group', group)

    // link → slide picker
    const sel = document.createElement('select')
    const none = document.createElement('option')
    none.value = ''
    none.textContent = 'none'
    sel.appendChild(none)
    this.store.doc.slides.forEach((s, i) => {
      const o = document.createElement('option')
      o.value = s.id
      o.textContent = this.slideLabel(s, i)
      if (el.link === s.id) o.selected = true
      sel.appendChild(o)
    })
    sel.addEventListener('change', () =>
      this.mutate(el.id, (e) => {
        if (sel.value) e.link = sel.value
        else delete e.link
      }, true))
    this.row('Link to', sel)

    // one-click interactivity: duplicate this slide as a hidden state
    // (element ids preserved ⇒ it morphs) and link this element to it
    const makeState = document.createElement('button')
    makeState.className = 'ed-btn ed-btn-block'
    makeState.textContent = '＋ New state linked from this element'
    makeState.title = 'Duplicates this slide as a hidden interactive state and links the selected element to it'
    makeState.addEventListener('click', () => this.createLinkedState(el))
    this.host.appendChild(makeState)
  }

  /** Duplicate the current slide as a hidden state and link `el` to it. */
  private createLinkedState(el: SlideElement) {
    const src = this.store.slide
    const clone = JSON.parse(JSON.stringify(src)) as typeof src
    clone.id = uid('slide')
    clone.stateOf = src.stateOf ?? src.id // states of a state share one parent
    clone.name = `${src.name ?? 'state'} ${this.store.doc.slides.filter((s) => s.stateOf === clone.stateOf).length + 2}`
    clone.transition = 'morph'
    delete (clone as any).hover // inherit nothing implicit; user can re-enable
    if (src.hover) clone.hover = { ...src.hover }
    const targetIdx = this.store.doc.slides.length
    this.store.commit(() => {
      this.store.doc.slides.push(clone)
      const live = this.store.element(el.id)
      if (live) live.link = clone.id
    }, 'slides')
    this.store.goTo(targetIdx)
  }

  /** Human label for a slide in pickers. */
  private slideLabel(s: { id: string; name?: string; stateOf?: string }, i: number): string {
    const linear = this.store.doc.slides.slice(0, i + 1).filter((x) => !x.stateOf).length
    if (s.stateOf) {
      const p = this.store.doc.slides.findIndex((x) => x.id === s.stateOf)
      const pn = this.store.doc.slides.slice(0, p + 1).filter((x) => !x.stateOf).length
      return `state of ${pn}${s.name ? ` — ${s.name}` : ''}`
    }
    return `slide ${linear}${s.name ? ` — ${s.name}` : ''}`
  }

  private buildTextProps(el: TextElement) {
    this.section('Typography')
    this.row('Size', this.number(el.fontSize, 1, (v, fin) =>
      this.mutate(el.id, (e) => { (e as TextElement).fontSize = Math.max(v, 4) }, fin)))
    this.row('Weight', this.select(['300', '400', '600', '700', '800'], String(el.fontWeight), (v) =>
      this.mutate(el.id, (e) => { (e as TextElement).fontWeight = parseInt(v) }, true)))
    this.row('Color', this.color(el.color, (v, fin) =>
      this.mutate(el.id, (e) => { (e as TextElement).color = v }, fin)))
    this.row('Align', this.select(['left', 'center', 'right'], el.align, (v) =>
      this.mutate(el.id, (e) => { (e as TextElement).align = v as TextElement['align'] }, true)))
    this.row('V-align', this.select(['top', 'middle', 'bottom'], el.valign, (v) =>
      this.mutate(el.id, (e) => { (e as TextElement).valign = v as TextElement['valign'] }, true)))
    this.row('Line height', this.number(el.lineHeight, 0.05, (v, fin) =>
      this.mutate(el.id, (e) => { (e as TextElement).lineHeight = Math.max(v, 0.5) }, fin)))
  }

  private buildShapeProps(el: ShapeElement) {
    this.section('Fill & stroke')
    this.row('Fill', this.color(el.fill, (v, fin) =>
      this.mutate(el.id, (e) => { (e as ShapeElement).fill = v }, fin)))
    this.row('Stroke', this.color(el.stroke === 'transparent' ? '#1E2A3A' : el.stroke, (v, fin) =>
      this.mutate(el.id, (e) => { (e as ShapeElement).stroke = v }, fin)))
    this.row('Stroke width', this.number(el.strokeWidth, 0.5, (v, fin) =>
      this.mutate(el.id, (e) => { (e as ShapeElement).strokeWidth = Math.max(v, 0) }, fin)))
    if (el.shape === 'rect') {
      this.row('Corner radius', this.number(el.radius, 1, (v, fin) =>
        this.mutate(el.id, (e) => { (e as ShapeElement).radius = Math.max(v, 0) }, fin)))
    }
  }

  private buildImageProps(el: SlideElement) {
    this.section('Image')
    this.row('Fit', this.select(['contain', 'cover', 'fill'], (el as any).fit, (v) =>
      this.mutate(el.id, (e) => { (e as any).fit = v }, true)))
    this.row('Corner radius', this.number((el as any).radius, 1, (v, fin) =>
      this.mutate(el.id, (e) => { (e as any).radius = Math.max(v, 0) }, fin)))
  }

  // --- element ops --------------------------------------------------------------

  private opsRow(els: SlideElement[]) {
    const row = document.createElement('div')
    row.className = 'ed-ops'
    row.append(
      this.opBtn(ICONS.copy, 'Duplicate', () => this.duplicate(els)),
      this.opBtn(ICONS.front, 'Bring to front', () => this.reorder(els, 'front')),
      this.opBtn(ICONS.back, 'Send to back', () => this.reorder(els, 'back')),
      this.opBtn(ICONS.trash, 'Delete', () => this.deleteEls(els)),
    )
    this.host.appendChild(row)
  }

  duplicate(els: SlideElement[]) {
    const clones = els.map((el) => ({
      ...JSON.parse(JSON.stringify(el)),
      id: `${el.id.replace(/-copy\d*$/, '')}-copy${Math.floor(Math.random() * 1000)}`,
      x: el.x + 24,
      y: el.y + 24,
    }))
    this.store.commit(() => this.store.slide.elements.push(...clones))
    this.store.select(clones.map((c) => c.id))
  }

  deleteEls(els: SlideElement[]) {
    const ids = new Set(els.map((e) => e.id))
    this.store.commit(() => {
      this.store.slide.elements = this.store.slide.elements.filter((e) => !ids.has(e.id))
    })
    this.store.select([])
  }

  private reorder(els: SlideElement[], where: 'front' | 'back') {
    const ids = new Set(els.map((e) => e.id))
    this.store.commit(() => {
      const slide = this.store.slide
      const picked = slide.elements.filter((e) => ids.has(e.id))
      const rest = slide.elements.filter((e) => !ids.has(e.id))
      slide.elements = where === 'front' ? [...rest, ...picked] : [...picked, ...rest]
    })
  }

  // --- tiny DOM helpers -----------------------------------------------------------

  private mutate(id: string, fn: (el: SlideElement) => void, final: boolean) {
    const el = this.store.element(id)
    if (el) this.edit(() => fn(el), final)
  }

  private setNum(id: string, key: 'x' | 'y' | 'w' | 'h' | 'rotation' | 'opacity', v: number) {
    if (Number.isNaN(v)) return
    this.mutate(id, (el) => { (el as any)[key] = v }, true)
  }

  private section(title: string) {
    const h = document.createElement('h3')
    h.className = 'ed-section'
    h.textContent = title
    this.host.appendChild(h)
  }

  private row(label: string, input: HTMLElement) {
    const row = document.createElement('label')
    row.className = 'ed-row'
    const span = document.createElement('span')
    span.textContent = label
    row.append(span, input)
    this.host.appendChild(row)
  }

  private mini(label: string, value: number, onChange: (v: number) => void): HTMLElement {
    const wrap = document.createElement('label')
    wrap.className = 'ed-mini'
    const span = document.createElement('span')
    span.textContent = label
    const input = document.createElement('input')
    input.type = 'number'
    input.value = String(Math.round(value * 10) / 10)
    input.addEventListener('change', () => onChange(parseFloat(input.value)))
    wrap.append(span, input)
    return wrap
  }

  private number(value: number, step: number, onEdit: (v: number, final: boolean) => void): HTMLElement {
    const input = document.createElement('input')
    input.type = 'number'
    input.step = String(step)
    input.value = String(value)
    input.addEventListener('change', () => {
      const v = parseFloat(input.value)
      if (!Number.isNaN(v)) onEdit(v, true)
    })
    return input
  }

  private color(value: string, onEdit: (v: string, final: boolean) => void): HTMLElement {
    const input = document.createElement('input')
    input.type = 'color'
    input.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#1E2A3A'
    input.addEventListener('input', () => onEdit(input.value, false))
    input.addEventListener('change', () => onEdit(input.value, true))
    return input
  }

  private select(options: string[], value: string, onChange: (v: string) => void): HTMLElement {
    const sel = document.createElement('select')
    for (const opt of options) {
      const o = document.createElement('option')
      o.value = opt
      o.textContent = opt
      if (opt === value) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => onChange(sel.value))
    return sel
  }

  private opBtn(icon: string, title: string, onClick: () => void): HTMLElement {
    const btn = document.createElement('button')
    btn.className = 'ed-btn ed-btn-icon'
    btn.title = title
    btn.innerHTML = icon
    btn.addEventListener('click', onClick)
    return btn
  }
}
