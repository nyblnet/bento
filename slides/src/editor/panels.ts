// Right-hand properties panel. Shows slide properties when nothing is
// selected, element properties otherwise. Bursts of 'input' events collapse
// into a single undo checkpoint.

import type { Store } from '../store'
import { uid, type ChartElement, type LineEnding, type ShapeElement, type Slide, type SlideElement, type TextElement, type TransitionKind } from '../model'
import { CHART_PRESETS } from '../charts'
import { FONT_CHOICES, firstFamily, injectFonts } from '../fonts'
import { ICONS } from '../icons'

export class PropsPanel {
  private burst = false

  constructor(
    private host: HTMLElement,
    private store: Store,
  ) {
    // Selection/slide switches always rebuild — the user acted outside the
    // panel, so whatever input was focused is obsolete. Doc mutations respect
    // a focused input (skip + mark stale) and catch up when focus leaves.
    store.on('selection', () => this.rebuild(true))
    store.on('current', () => this.rebuild(true))
    store.on('doc', () => this.rebuild())
    this.host.addEventListener('focusout', () => {
      setTimeout(() => {
        if (this.stale && !this.host.matches(':focus-within')) this.rebuild()
      }, 0)
    })
    this.rebuild()
  }

  private stale = false

  /**
   * True only while the user is mid-edit in a control a rebuild would
   * disrupt: typing in text/number fields, or the native color popup.
   * Discrete controls (selects, checkboxes, buttons) commit atomically, so
   * the panel rebuilds the moment they change — structural rows (shadow
   * color, fx options) appear immediately instead of after focus leaves.
   */
  private isActiveEditFocus(): boolean {
    const a = document.activeElement as HTMLElement | null
    if (!a || !this.host.contains(a)) return false
    if (a.tagName === 'TEXTAREA' || a.isContentEditable) return true
    if (a.tagName === 'INPUT') {
      const t = (a as HTMLInputElement).type
      return t !== 'checkbox' && t !== 'radio' && t !== 'button'
    }
    return false
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

  private rebuild(force = false) {
    if (!force && this.isActiveEditFocus()) {
      this.stale = true // don't rip the field out from under the user; catch up on focusout
      return
    }
    this.stale = false
    this.burst = false
    this.host.innerHTML = ''
    const els = this.store.selectedElements
    if (els.length === 0) this.buildSlidePanel()
    else if (els.length === 1) this.buildElementPanel(els[0])
    else this.buildMultiPanel(els)
    this.applyAccordion()
  }

  /** Collapsed by default until the user opens them (persisted per title). */
  private static CLOSED_BY_DEFAULT = new Set(['Presenting', 'Interactivity', 'Layout'])

  /**
   * Retrofit the flat panel into an accordion: every .ed-section header
   * gathers its following siblings into a collapsible body. Open state is
   * remembered per section title — everything stays discoverable (headers
   * always visible) while rarely-used sections stop costing space.
   */
  private applyAccordion() {
    let openState: Record<string, boolean> = {}
    try { openState = JSON.parse(localStorage.getItem('bento-panel-open') ?? '{}') } catch { /* defaults */ }
    const headers = [...this.host.querySelectorAll<HTMLElement>('.ed-section')]
    for (const h of headers) {
      const key = h.textContent ?? ''
      const body = document.createElement('div')
      body.className = 'ed-section-body'
      let n: ChildNode | null = h.nextSibling
      while (n && !(n instanceof HTMLElement && n.classList.contains('ed-section'))) {
        const next: ChildNode | null = n.nextSibling
        body.appendChild(n)
        n = next
      }
      h.after(body)
      const isOpen = openState[key] ?? !PropsPanel.CLOSED_BY_DEFAULT.has(key)
      h.classList.add('ed-sec-toggle')
      if (!isOpen) {
        h.classList.add('closed')
        body.style.display = 'none'
      }
      h.addEventListener('click', () => {
        const nowClosed = h.classList.toggle('closed')
        body.style.display = nowClosed ? 'none' : ''
        openState[key] = !nowClosed
        localStorage.setItem('bento-panel-open', JSON.stringify(openState))
      })
    }
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
    if (slide.transition === 'morph') {
      const hint = document.createElement('p')
      hint.className = 'ed-hint'
      hint.innerHTML = '<b>Morph</b> animates elements that appear on both this slide and the previous one (copy a slide, then move things around).'
      this.host.appendChild(hint)
    }

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

    if (slide.stateOf) {
      const sync = document.createElement('button')
      sync.className = 'ed-btn ed-btn-block'
      sync.innerHTML = `${ICONS.sync}<span>Sync from parent slide</span>`
      sync.title = 'Pull elements added to the parent into this state and adopt its ordering — your changes to shared elements are kept'
      sync.addEventListener('click', () => this.syncStateFromParent())
      this.host.appendChild(sync)
    }

    this.row('Hover', this.select(
      ['none', 'focus-group', 'reveal'],
      slide.hover?.type ?? 'none',
      (v) => this.edit(() => {
        this.store.slide.hover = v === 'none'
          ? undefined
          : { ...(this.store.slide.hover ?? {}), type: v as 'focus-group' | 'reveal' }
      }, true)))
    if (slide.hover?.type === 'focus-group') {
      this.row('Hover dim', this.number(slide.hover.dim ?? 0.15, 0.01, (v, fin) =>
        this.edit(() => { if (this.store.slide.hover) this.store.slide.hover.dim = Math.min(Math.max(v, 0), 1) }, fin)))
    }
    if (slide.hover?.type === 'reveal') {
      const sets = [...new Set(slide.elements.map((e) => e.showOnHover).filter(Boolean))] as string[]
      const defIn = document.createElement('input')
      defIn.type = 'text'
      defIn.placeholder = sets[0] ?? 'set name'
      defIn.value = slide.hover.default ?? ''
      defIn.addEventListener('change', () =>
        this.edit(() => { if (this.store.slide.hover) this.store.slide.hover.default = defIn.value || undefined }, true))
      this.row('Default set', defIn)
      if (sets.length) {
        this.row('Preview set', this.select(sets, this.store.hoverPreview ?? slide.hover.default ?? sets[0], (v) => {
          this.store.hoverPreview = v
          this.store.emit('current') // re-render canvas without touching the doc
        }))
        const revealHint = document.createElement('p')
        revealHint.className = 'ed-hint'
        revealHint.innerHTML = 'While presenting, hovering an element whose <b>group</b> matches a set name shows that set. Use Preview to edit each set.'
        this.host.appendChild(revealHint)
      }
    }

    this.section('Layout')
    const applyLy = document.createElement('button')
    applyLy.className = 'ed-btn ed-btn-block'
    applyLy.textContent = '⧉ Apply layout…'
    applyLy.title = 'Re-arrange this slide onto a layout — content moves by matching id, then role; extra elements are kept'
    applyLy.addEventListener('click', () =>
      document.dispatchEvent(new CustomEvent('bento:apply-layout', { detail: { anchor: applyLy } })))
    this.host.appendChild(applyLy)

    const saveLy = document.createElement('button')
    saveLy.className = 'ed-btn ed-btn-block'
    saveLy.textContent = '＋ Save slide as layout…'
    saveLy.title = "Add this slide to the document's layout picker (New slide button)"
    saveLy.addEventListener('click', () => {
      const name = window.prompt('Layout name', this.store.slide.name ?? 'My layout')
      if (!name) return
      this.edit(() => {
        const doc = this.store.doc
        const copy: Slide = JSON.parse(JSON.stringify(this.store.slide))
        doc.layouts = [...(doc.layouts ?? []), { ...copy, id: uid('layout'), name, stateOf: undefined, notes: '' }]
      }, true)
    })
    this.host.appendChild(saveLy)

    this.section('Speaker notes')
    const notes = document.createElement('textarea')
    notes.className = 'ed-notes'
    notes.placeholder = 'Notes for presenter view (press S while presenting)…'
    notes.value = slide.notes
    notes.addEventListener('input', () => this.edit(() => { this.store.slide.notes = notes.value }, false))
    notes.addEventListener('change', () => this.edit(() => { this.store.slide.notes = notes.value }, true))
    this.host.appendChild(notes)
    const notesHint = document.createElement('p')
    notesHint.className = 'ed-hint'
    notesHint.innerHTML = 'Press <b>S</b> while presenting to open the speaker view — these notes beside the current and next slide, with a timer.'
    this.host.appendChild(notesHint)
  }

  private buildMultiPanel(els: SlideElement[]) {
    this.section(`${els.length} elements`)
    this.opsRow(els)
    this.section('Arrange')
    this.arrangeRows(els)
  }

  private buildElementPanel(el: SlideElement) {
    this.section({ text: 'Text', shape: 'Shape', image: 'Image', svg: 'Diagram', chart: 'Chart' }[el.type])
    this.opsRow([el])

    this.section('Arrange')
    this.arrangeRows([el])

    this.section('Position & size')
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

    this.row('Role', this.select(
      ['none', 'title', 'subtitle', 'body', 'kicker'],
      el.role ?? 'none',
      (v) => this.mutate(el.id, (e) => {
        if (v === 'none') delete e.role
        else e.role = v
      }, true)))

    const current = Object.entries(SHADOW_PRESETS).find(([, p]) => JSON.stringify(p) === JSON.stringify(el.shadow))?.[0]
      ?? (el.shadow ? 'custom' : 'none')
    this.row('Shadow', this.select(
      [...(current === 'custom' ? ['custom'] : []), 'none', ...Object.keys(SHADOW_PRESETS)],
      current,
      (v) => this.mutate(el.id, (e) => {
        if (v === 'none') delete e.shadow
        else if (v !== 'custom') e.shadow = { ...SHADOW_PRESETS[v] }
      }, true)))
    if (el.shadow) {
      // recoloring a preset makes it 'custom' on next rebuild — that's fine
      this.row('Shadow color', this.colorAlpha(el.shadow.color, (v, fin) =>
        this.mutate(el.id, (e) => { if (e.shadow) e.shadow = { ...e.shadow, color: v } }, fin)))
    }


    if (el.type === 'text') this.buildTextProps(el)
    if (el.type === 'shape') this.buildShapeProps(el)
    if (el.type === 'image') this.buildImageProps(el)
    if (el.type === 'chart') this.buildChartProps(el)

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
        if (!fx.enter && !fx.countUp && !fx.ambient && !fx.loop) delete e.fx
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
      (v) => setFx(v === 'none' ? { ambient: undefined, ken: undefined } : { ambient: 'kenburns' })))
    if (el.fx?.ambient === 'kenburns') {
      const ken = el.fx.ken ?? {}
      const dir = ken.dir ?? 'drift'
      const setKen = (patch: Partial<NonNullable<NonNullable<SlideElement['fx']>['ken']>>) =>
        setFx({ ken: { ...ken, ...patch } })
      this.row('Zoom', this.select(
        ['drift', 'zoom-out', 'zoom-in'],
        dir === 'out' ? 'zoom-out' : dir === 'in' ? 'zoom-in' : 'drift',
        (v) => {
          const d = v === 'zoom-out' ? 'out' : v === 'zoom-in' ? 'in' : 'drift'
          // give each style its natural pace when switching
          setFx({ ken: d === 'drift' ? undefined : { dir: d, scale: 1.06, duration: 2.5 } })
        }))
      this.row('Zoom %', this.number(
        Math.round(((ken.scale ?? (dir === 'drift' ? 1.1 : 1.06)) - 1) * 100), 1,
        (v, fin) => { if (fin) setKen({ scale: 1 + Math.min(Math.max(v, 0), 100) / 100 }) }))
      this.row('Zoom secs', this.number(
        ken.duration ?? (dir === 'drift' ? 26 : 2.5), 0.1,
        (v, fin) => { if (fin) setKen({ duration: Math.max(v, 0.1) }) }))
    }

    // continuous loop animation
    const loop = el.fx?.loop
    this.row('Loop', this.select(
      ['none', 'dash-march', 'motion-path'],
      loop?.type ?? 'none',
      (v) => setFx({
        loop: v === 'none' ? undefined
          : v === 'dash-march' ? { type: 'dash-march', distance: 18, duration: (loop as any)?.duration ?? 1.4 }
          : { type: 'motion-path', path: (loop as any)?.path ?? 'M 0 0 L 100 0', duration: (loop as any)?.duration ?? 3 },
      })))
    if (loop) {
      this.row('Loop secs', this.number(loop.duration ?? 2, 0.1, (v, fin) =>
        this.mutate(el.id, (e) => { if (e.fx?.loop) e.fx.loop.duration = Math.max(v, 0.1) }, fin)))
      if (loop.type === 'motion-path') {
        const path = document.createElement('input')
        path.type = 'text'
        path.value = loop.path
        path.title = 'SVG path the element travels along, relative to its position'
        path.addEventListener('change', () =>
          this.mutate(el.id, (e) => { if (e.fx?.loop?.type === 'motion-path') e.fx.loop.path = path.value }, true))
        this.row('Path', path)

        const editPath = document.createElement('button')
        editPath.className = 'ed-btn ed-btn-block'
        editPath.textContent = '✎ Edit path on canvas'
        editPath.title = 'Drag anchor points on the slide; double-click adds and removes points'
        editPath.addEventListener('click', () =>
          document.dispatchEvent(new CustomEvent('bento:edit-path', { detail: { id: el.id } })))
        this.host.appendChild(editPath)
      }
    }

    // hover-reveal set membership
    const soh = document.createElement('input')
    soh.type = 'text'
    soh.placeholder = 'always visible'
    soh.value = el.showOnHover ?? ''
    soh.title = "Only visible while an element with this group is hovered (slide hover: 'reveal')"
    soh.addEventListener('change', () => {
      this.mutate(el.id, (e) => {
        if (soh.value) e.showOnHover = soh.value
        else delete e.showOnHover
      }, true)
      // follow the element into its new set so it stays visible/editable
      this.store.hoverPreview = soh.value || null
      this.store.emit('current')
    })
    this.row('Show on hover', soh)

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

  /**
   * Re-sync an interactive state with its parent: parent elements missing
   * here (added since the state was created) come in, ordering follows the
   * parent, and this state's own versions of shared elements — its whole
   * point — stay untouched. Elements unique to this state stay on top.
   */
  private syncStateFromParent() {
    const state = this.store.slide
    const parent = this.store.doc.slides.find((s) => s.id === state.stateOf)
    if (!parent) return
    const own = new Map(state.elements.map((e) => [e.id, e]))
    // sync only makes sense for states that share lineage with the parent —
    // otherwise "merging" would just stack two full copies of everything
    const shared = parent.elements.filter((pe) => own.has(pe.id)).length
    if (state.elements.length && !shared) {
      this.toast('This state shares no element ids with its parent — nothing to sync against')
      return
    }
    let added = 0
    const merged: SlideElement[] = parent.elements.map((pe) => {
      const mine = own.get(pe.id)
      if (mine) {
        own.delete(pe.id)
        return mine
      }
      added++
      return JSON.parse(JSON.stringify(pe))
    })
    const extras = [...own.values()] // this state's additions, kept on top
    this.store.commit(() => {
      this.store.slide.elements = [...merged, ...extras]
    })
    this.store.select([])
    const bits = [added ? `${added} new element${added > 1 ? 's' : ''} pulled in` : 'nothing new in the parent']
    if (extras.length) bits.push(`${extras.length} state-only element${extras.length > 1 ? 's' : ''} kept`)
    this.toast(`Synced — ${bits.join('; ')}`)
  }

  private toast(message: string) {
    document.querySelector('.ed-toast')?.remove()
    const t = document.createElement('div')
    t.className = 'ed-toast'
    t.textContent = message
    document.body.appendChild(t)
    setTimeout(() => t.classList.add('show'))
    setTimeout(() => {
      t.classList.remove('show')
      setTimeout(() => t.remove(), 300)
    }, 2600)
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
    // insert right after the parent and its existing states, keeping the
    // family together in the slide list
    const parentIdx = this.store.doc.slides.findIndex((s) => s.id === clone.stateOf)
    let insertAt = parentIdx + 1
    while (this.store.doc.slides[insertAt]?.stateOf === clone.stateOf) insertAt++
    this.store.commit(() => {
      this.store.doc.slides.splice(insertAt, 0, clone)
      const live = this.store.element(el.id)
      if (live) live.link = clone.id
    }, 'slides')
    this.store.goTo(insertAt)
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
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.innerHTML = 'While editing: <b>⌘B</b>/<b>⌘I</b>/<b>⌘U</b> · markdown auto-converts — **bold*&#8203;* *italic*&#8203; `code` ~~strike~~ and "- " bullets; pasting markdown converts too. Escape with \\ or press ⌘Z right after to keep the literal characters.'
    this.host.appendChild(hint)
    this.row('Font', this.fontSelect(el))
    // Shown in POINTS (the unit office users know); the model stores slide-space
    // px. 1pt = 4/3 px at the slide's 96dpi space, so 32px = 24pt exactly.
    this.row('Size (pt)', this.number(Math.round(el.fontSize * 0.75 * 10) / 10, 1, (v, fin) =>
      this.mutate(el.id, (e) => {
        (e as TextElement).fontSize = Math.round(Math.max(v, 3) * (4 / 3) * 100) / 100
      }, fin)))
    this.row('Weight', this.weightSelect(el))
    this.row('Color', this.color(el.color, (v, fin) =>
      this.mutate(el.id, (e) => { (e as TextElement).color = v }, fin)))
    this.row('Align', this.select(['left', 'center', 'right'], el.align, (v) =>
      this.mutate(el.id, (e) => { (e as TextElement).align = v as TextElement['align'] }, true)))
    this.row('V-align', this.select(['top', 'middle', 'bottom'], el.valign, (v) =>
      this.mutate(el.id, (e) => { (e as TextElement).valign = v as TextElement['valign'] }, true)))
    this.row('Line height', this.number(el.lineHeight, 0.05, (v, fin) =>
      this.mutate(el.id, (e) => { (e as TextElement).lineHeight = Math.max(v, 0.5) }, fin)))

    const embed = document.createElement('button')
    embed.className = 'ed-btn ed-btn-block'
    embed.textContent = '＋ Embed font file…'
    embed.title = 'Bundle a .woff2/.woff/.ttf/.otf into this file and use it here'
    embed.addEventListener('click', () => this.embedFont(el))
    this.host.appendChild(embed)
  }

  /**
   * Font picker: theme default, curated system stacks, fonts embedded in the
   * document, and (if unmatched) the element's current custom stack. Options
   * render in their own face so the menu previews itself.
   */
  private fontSelect(el: TextElement): HTMLElement {
    const sel = document.createElement('select')
    const current = el.fontFamily ?? ''
    const add = (label: string, value: string, selected: boolean) => {
      const o = document.createElement('option')
      o.value = value
      o.textContent = label
      o.style.fontFamily = value || 'inherit'
      o.selected = selected
      sel.appendChild(o)
      return o
    }
    const curFirst = firstFamily(current)
    let matched = false
    add('theme default', '', current === '')
    for (const f of this.store.doc.fonts ?? []) {
      const hit = !matched && (current === f.family || curFirst === firstFamily(f.family))
      if (hit) matched = true
      add(`${f.family} (embedded)`, f.family, hit)
    }
    for (const c of FONT_CHOICES) {
      const hit = !matched && current !== '' && curFirst === firstFamily(c.stack)
      if (hit) matched = true
      add(c.label, c.stack, hit)
    }
    if (current && !matched) add(curFirst || 'custom', current, true)
    sel.addEventListener('change', () =>
      this.mutate(el.id, (e) => { (e as TextElement).fontFamily = sel.value }, true))
    return sel
  }

  /** Bundle a font file into the document and apply it to this element. */
  private embedFont(el: TextElement) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.woff2,.woff,.ttf,.otf'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        const family = file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim() || 'Embedded font'
        const asset = `font_${family.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
        this.store.commit(() => {
          const doc = this.store.doc
          doc.assets = { ...(doc.assets ?? {}), [asset]: String(reader.result) }
          doc.fonts = [...(doc.fonts ?? []).filter((f) => f.family !== family), { family, asset }]
          const live = this.store.element(el.id)
          if (live && live.type === 'text') live.fontFamily = family
        })
        injectFonts(this.store.doc)
        this.toast(`"${family}" embedded into this file`)
      }
      reader.readAsDataURL(file)
    })
    input.click()
  }

  private buildShapeProps(el: ShapeElement) {
    this.section('Fill & stroke')
    const grad = el.fillGradient
    this.row('Fill style', this.select(['solid', 'gradient'], grad ? 'gradient' : 'solid', (v) =>
      this.mutate(el.id, (e) => {
        const s = e as ShapeElement
        if (v === 'gradient') {
          const base = parseColor(s.fill)
          s.fillGradient ??= {
            angle: 180,
            stops: [
              { at: 0, color: combineColor(base.hex, Math.max(base.a, 0.85)) },
              { at: 1, color: combineColor(base.hex, 0) },
            ],
          }
        } else {
          delete s.fillGradient
        }
      }, true)))

    if (!grad) {
      this.row('Fill', this.colorAlpha(el.fill, (v, fin) =>
        this.mutate(el.id, (e) => { (e as ShapeElement).fill = v }, fin)))
    } else {
      this.row('Grad. angle', this.number(grad.angle, 1, (v, fin) =>
        this.mutate(el.id, (e) => {
          const g = (e as ShapeElement).fillGradient
          if (g) g.angle = v
        }, fin)))
      grad.stops.forEach((stop, i) => {
        const wrap = document.createElement('div')
        wrap.className = 'ed-gradstop'
        const at = this.number(Math.round(stop.at * 100), 1, (v, fin) =>
          this.mutate(el.id, (e) => {
            const g = (e as ShapeElement).fillGradient
            if (g?.stops[i]) g.stops[i].at = Math.min(Math.max(v / 100, 0), 1)
          }, fin))
        at.title = 'Position %'
        const color = this.colorAlpha(stop.color, (v, fin) =>
          this.mutate(el.id, (e) => {
            const g = (e as ShapeElement).fillGradient
            if (g?.stops[i]) g.stops[i].color = v
          }, fin))
        wrap.append(at, color)
        if (grad.stops.length > 2) {
          const del = document.createElement('button')
          del.className = 'ed-btn ed-btn-icon'
          del.textContent = '✕'
          del.title = 'Remove stop'
          del.addEventListener('click', () =>
            this.mutate(el.id, (e) => {
              const g = (e as ShapeElement).fillGradient
              if (g && g.stops.length > 2) g.stops.splice(i, 1)
            }, true))
          wrap.appendChild(del)
        }
        this.row(`Stop ${i + 1}`, wrap)
      })
      const add = document.createElement('button')
      add.className = 'ed-btn ed-btn-block'
      add.textContent = '＋ Add stop'
      add.addEventListener('click', () =>
        this.mutate(el.id, (e) => {
          const g = (e as ShapeElement).fillGradient
          if (!g) return
          const mid = g.stops[Math.floor(g.stops.length / 2)]
          g.stops.push({ at: 0.5, color: mid?.color ?? '#808080' })
          g.stops.sort((a, b) => a.at - b.at)
        }, true))
      this.host.appendChild(add)
    }

    this.row('Stroke', this.colorAlpha(el.stroke === 'transparent' ? 'rgba(30, 42, 58, 0)' : el.stroke, (v, fin) =>
      this.mutate(el.id, (e) => { (e as ShapeElement).stroke = v }, fin)))
    this.row('Stroke width', this.number(el.strokeWidth, 0.5, (v, fin) =>
      this.mutate(el.id, (e) => { (e as ShapeElement).strokeWidth = Math.max(v, 0) }, fin)))
    this.row('Line style', this.select(
      ['solid', 'dashed', 'dotted'],
      el.strokeStyle ?? (el.strokeDash ? 'dashed' : 'solid'),
      (v) => this.mutate(el.id, (e) => {
        const s = e as ShapeElement
        s.strokeStyle = v === 'solid' ? undefined : (v as 'dashed' | 'dotted')
        if (v === 'solid') delete s.strokeDash // clear the legacy dash too
      }, true)))
    if (el.shape === 'line') {
      const ENDINGS = ['none', 'arrow', 'dot', 'bar']
      this.row('Start tip', this.select(ENDINGS, el.lineStart ?? 'none', (v) =>
        this.mutate(el.id, (e) => { (e as ShapeElement).lineStart = v === 'none' ? undefined : (v as LineEnding) }, true)))
      this.row('End tip', this.select(ENDINGS, el.lineEnd ?? 'none', (v) =>
        this.mutate(el.id, (e) => { (e as ShapeElement).lineEnd = v === 'none' ? undefined : (v as LineEnding) }, true)))
    }
    if (el.shape === 'rect') {
      this.row('Corner radius', this.number(el.radius, 1, (v, fin) =>
        this.mutate(el.id, (e) => { (e as ShapeElement).radius = Math.max(v, 0) }, fin)))
    }
  }

  private buildChartProps(el: ChartElement) {
    this.section('Data')
    this.row('Preset', this.select(Object.keys(CHART_PRESETS), el.preset ?? 'bar', (v) =>
      this.mutate(el.id, (e) => {
        const c = e as ChartElement
        c.preset = v
        c.option = CHART_PRESETS[v]()
      }, true)))

    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.innerHTML = 'The full <b>ECharts option</b> as JSON (pure data — use template-string formatters like <code>{b}: {c}</code>, never functions). Tooltips and zoom run while presenting.'
    this.host.appendChild(hint)

    const ta = document.createElement('textarea')
    ta.className = 'ed-chart-json'
    ta.rows = 14
    ta.spellcheck = false
    ta.value = JSON.stringify(el.option, null, 2)
    ta.addEventListener('change', () => {
      try {
        const parsed = JSON.parse(ta.value)
        ta.classList.remove('ed-invalid')
        this.mutate(el.id, (e) => { (e as ChartElement).option = parsed }, true)
      } catch {
        ta.classList.add('ed-invalid')
      }
    })
    this.host.appendChild(ta)
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
      this.opBtn(ICONS.trash, 'Delete', () => this.deleteEls(els)),
    )
    this.host.appendChild(row)
  }

  /** Align / distribute / size / order / rotate — the arrange kit, in
   *  captioned, balanced rows. */
  private arrangeRows(els: SlideElement[]) {
    const textBtn = (label: string, title: string, onClick: () => void, enabled = true) => {
      const b = document.createElement('button')
      b.className = 'ed-btn ed-arrange-btn'
      b.textContent = label
      b.title = title
      b.disabled = !enabled
      b.addEventListener('click', onClick)
      return b
    }
    const group = (caption: string, buttons: HTMLElement[]) => {
      const row = document.createElement('div')
      row.className = 'ed-arrange-row'
      const cap = document.createElement('span')
      cap.className = 'ed-arrange-cap'
      cap.textContent = caption
      row.appendChild(cap)
      row.append(...buttons)
      this.host.appendChild(row)
    }

    group('Align', [
      textBtn('⇤', 'Align left', () => this.align(els, 'left')),
      textBtn('⇹', 'Align horizontal centers', () => this.align(els, 'centerX')),
      textBtn('⇥', 'Align right', () => this.align(els, 'right')),
      textBtn('⤒', 'Align top', () => this.align(els, 'top')),
      textBtn('⇳', 'Align vertical middles', () => this.align(els, 'middleY')),
      textBtn('⤓', 'Align bottom', () => this.align(els, 'bottom')),
    ])
    group('Space', [
      textBtn('⋯', 'Equal horizontal gaps (3+)', () => this.distribute(els, 'x'), els.length >= 3),
      textBtn('⋮', 'Equal vertical gaps (3+)', () => this.distribute(els, 'y'), els.length >= 3),
      textBtn('↔', 'Match widths — first selected sets the size (2+)', () => this.matchSize(els, 'w'), els.length >= 2),
      textBtn('↕', 'Match heights — first selected sets the size (2+)', () => this.matchSize(els, 'h'), els.length >= 2),
    ])
    group('Order', [
      textBtn('⇈', 'Bring to front', () => this.reorder(els, 'front')),
      textBtn('↑', 'Bring forward one step', () => this.step(els, +1)),
      textBtn('↓', 'Send backward one step', () => this.step(els, -1)),
      textBtn('⇊', 'Send to back', () => this.reorder(els, 'back')),
    ])

    const grouped = els.some((e) => e.groupId)
    if (els.length > 1 || grouped) {
      const g = document.createElement('button')
      g.className = 'ed-btn ed-btn-block'
      const allSame = els.length > 1 && els.every((e) => e.groupId && e.groupId === els[0].groupId)
      if (allSame || (grouped && els.length === 1)) {
        g.textContent = '⛓ Ungroup'
        g.title = 'Dissolve the group (⇧⌘G)'
        g.addEventListener('click', () => this.ungroup(els))
      } else {
        g.textContent = '⛓ Group'
        g.title = 'Elements select and move as one; Alt-click reaches a member (⌘G)'
        g.addEventListener('click', () => this.group(els))
      }
      this.host.appendChild(g)
    }
  }

  /** Same width/height for the whole selection — first selected is the reference. */
  private matchSize(els: SlideElement[], dim: 'w' | 'h') {
    if (els.length < 2) return
    const ref = els[0][dim]
    this.edit(() => { for (const el of els) el[dim] = ref }, true)
  }

  /** Single element aligns to the slide; a multi-selection aligns to its own bounds. */
  private align(els: SlideElement[], edge: 'left' | 'centerX' | 'right' | 'top' | 'middleY' | 'bottom') {
    const { width, height } = this.store.doc.size
    const box = els.length === 1
      ? { x0: 0, y0: 0, x1: width, y1: height }
      : {
          x0: Math.min(...els.map((e) => e.x)),
          y0: Math.min(...els.map((e) => e.y)),
          x1: Math.max(...els.map((e) => e.x + e.w)),
          y1: Math.max(...els.map((e) => e.y + e.h)),
        }
    this.edit(() => {
      for (const el of els) {
        if (edge === 'left') el.x = box.x0
        if (edge === 'right') el.x = box.x1 - el.w
        if (edge === 'centerX') el.x = (box.x0 + box.x1) / 2 - el.w / 2
        if (edge === 'top') el.y = box.y0
        if (edge === 'bottom') el.y = box.y1 - el.h
        if (edge === 'middleY') el.y = (box.y0 + box.y1) / 2 - el.h / 2
      }
    }, true)
  }

  /** Even gaps between elements, first and last stay put. */
  private distribute(els: SlideElement[], axis: 'x' | 'y') {
    if (els.length < 3) return
    const size = axis === 'x' ? 'w' : 'h'
    const sorted = [...els].sort((a, b) => a[axis] - b[axis])
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const span = last[axis] + last[size] - first[axis]
    const total = sorted.reduce((s, e) => s + e[size], 0)
    const gap = (span - total) / (sorted.length - 1)
    this.edit(() => {
      let cursor = first[axis] + first[size] + gap
      for (const el of sorted.slice(1, -1)) {
        el[axis] = cursor
        cursor += el[size] + gap
      }
    }, true)
  }

  /** Move the selection one step up/down the paint order (adjacent swap). */
  private step(els: SlideElement[], dir: 1 | -1) {
    const ids = new Set(els.map((e) => e.id))
    this.store.commit(() => {
      const arr = this.store.slide.elements
      const idxs = arr.map((e, i) => (ids.has(e.id) ? i : -1)).filter((i) => i >= 0)
      const ordered = dir > 0 ? [...idxs].reverse() : idxs
      for (const i of ordered) {
        const j = i + dir
        if (j < 0 || j >= arr.length || ids.has(arr[j].id)) continue
        ;[arr[i], arr[j]] = [arr[j], arr[i]]
      }
    })
  }

  group(els: SlideElement[]) {
    if (els.length < 2) return
    const gid = `grp-${uid()}`
    this.edit(() => { for (const el of els) el.groupId = gid }, true)
  }

  ungroup(els: SlideElement[]) {
    const gids = new Set(els.map((e) => e.groupId).filter(Boolean))
    this.edit(() => {
      for (const el of this.store.slide.elements) {
        if (el.groupId && gids.has(el.groupId)) delete el.groupId
      }
    }, true)
  }

  duplicate(els: SlideElement[]) {
    // clones of grouped elements get fresh group ids (kept consistent within
    // the batch) so a duplicated group is its own group, not the original's
    const gidMap = new Map<string, string>()
    const clones = els.map((el) => ({
      ...JSON.parse(JSON.stringify(el)),
      id: `${el.id.replace(/-copy\d*$/, '')}-copy${Math.floor(Math.random() * 1000)}`,
      x: el.x + 24,
      y: el.y + 24,
      ...(el.groupId
        ? { groupId: gidMap.get(el.groupId) ?? gidMap.set(el.groupId, `grp-${uid()}`).get(el.groupId)! }
        : {}),
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
    input.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : parseColor(value).hex
    input.addEventListener('input', () => onEdit(input.value, false))
    input.addEventListener('change', () => onEdit(input.value, true))
    return input
  }

  /** Color swatch + opacity %. Native color inputs have no alpha channel, so
   *  the pair round-trips rgba()/#rrggbbaa strings losslessly. */
  private colorAlpha(value: string, onEdit: (v: string, final: boolean) => void): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'ed-coloralpha'
    const parsed = parseColor(value)
    const col = document.createElement('input')
    col.type = 'color'
    col.value = parsed.hex
    const alpha = document.createElement('input')
    alpha.type = 'number'
    alpha.min = '0'
    alpha.max = '100'
    alpha.step = '1'
    alpha.value = String(Math.round(parsed.a * 100))
    alpha.title = 'Opacity %'
    const emit = (final: boolean) => {
      const raw = parseFloat(alpha.value)
      const a = Number.isFinite(raw) ? Math.min(Math.max(raw / 100, 0), 1) : 1
      onEdit(combineColor(col.value, a), final)
    }
    col.addEventListener('input', () => emit(false))
    col.addEventListener('change', () => emit(true))
    alpha.addEventListener('change', () => emit(true))
    wrap.append(col, alpha)
    return wrap
  }

  /** Weight picker with the familiar named weights; stores the numeric value. */
  private weightSelect(el: TextElement): HTMLElement {
    const WEIGHTS: Array<[number, string]> = [
      [100, 'Thin'], [200, 'Extra light'], [300, 'Light'], [400, 'Regular'],
      [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black'],
    ]
    const sel = document.createElement('select')
    const current = el.fontWeight ?? 400
    if (!WEIGHTS.some(([n]) => n === current)) {
      const o = document.createElement('option')
      o.value = String(current)
      o.textContent = `Custom (${current})`
      o.selected = true
      sel.appendChild(o)
    }
    for (const [n, name] of WEIGHTS) {
      const o = document.createElement('option')
      o.value = String(n)
      o.textContent = name
      o.style.fontWeight = String(n)
      if (n === current) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () =>
      this.mutate(el.id, (e) => { (e as TextElement).fontWeight = parseInt(sel.value) }, true))
    return sel
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

/** Any CSS color → {hex, a}. Handles #rgb/#rrggbb/#rrggbbaa/rgb()/rgba()/transparent. */
export function parseColor(v: string): { hex: string; a: number } {
  if (!v || v === 'transparent' || v === 'none') return { hex: '#000000', a: 0 }
  const m = v.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const parts = m[1].split(/[\s,/]+/).map((s) => parseFloat(s))
    const [r, g, b] = parts
    const a = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1
    if ([r, g, b].every((n) => Number.isFinite(n))) {
      const hex = '#' + [r, g, b].map((n) => Math.round(Math.min(Math.max(n, 0), 255)).toString(16).padStart(2, '0')).join('')
      return { hex, a: Math.min(Math.max(a, 0), 1) }
    }
  }
  let hex = v.trim()
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) hex = '#' + [...hex.slice(1)].map((c) => c + c).join('')
  if (/^#[0-9a-fA-F]{8}$/.test(hex)) return { hex: hex.slice(0, 7), a: parseInt(hex.slice(7), 16) / 255 }
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return { hex, a: 1 }
  return { hex: '#1E2A3A', a: 1 }
}

/** {hex, a} → the shortest CSS color that keeps the alpha. */
export function combineColor(hex: string, a: number): string {
  if (a >= 1) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`
}

/** Aesthetic shadow presets offered in the panel (custom values stay 'custom'). */
const SHADOW_PRESETS: Record<string, { x?: number; y?: number; blur: number; color: string }> = {
  subtle: { y: 2, blur: 10, color: 'rgba(10,16,28,0.25)' },
  soft: { y: 10, blur: 28, color: 'rgba(10,16,28,0.32)' },
  elevated: { y: 24, blur: 56, color: 'rgba(8,12,22,0.45)' },
  glow: { blur: 40, color: 'rgba(226,80,45,0.45)' },
}
