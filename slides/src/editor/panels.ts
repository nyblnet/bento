// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Right-hand properties panel. Shows slide properties when nothing is
// selected, element properties otherwise. Bursts of 'input' events collapse
// into a single undo checkpoint.

import type { Store } from '../store'
import { adoptComponents } from '../components'
import { uid, type Slide, type SlideElement } from '../model'
import { morphPairs } from './morph'

import { revealInOrder, revealTogether, removeReveal } from './reveal'

import { ICONS } from '../icons'
import { LayersUI, labelIn, GLYPH as LAYER_GLYPH } from './layers'

import { t } from '../i18n'
import { componentHeader } from './inspector/component'
import { lsJson, lsSet } from '../../../kernel/src/storage.ts'
import { buildExport } from './inspector/export'
import { buildSlidePanel } from './inspector/slide'
import { roving, slidingPill } from './inspector/controls'
import { layerBlock, buildLayoutRole } from './inspector/arrange'
import { section, opBtn } from './inspector/fields'
import { revealRow, buildPresentingProps, buildMorphProps, applySteps } from './inspector/animate'
import { buildTextProps, buildTextFill, buildTextStroke } from './inspector/text'
import { buildShapeProps, buildShapeFill, buildShapeStroke, buildSharedPaint } from './inspector/shape'
import { buildImageProps, buildMediaProps, buildCodeProps, buildEmbedProps } from './inspector/media'
import { buildChartProps } from './inspector/chart'
import { buildTableProps } from './inspector/table'
import { buildAutoLayout, wrapInFrame } from './inspector/layout'
import { withDescendants } from '../layout'
import { buildShadow, buildBlur } from './inspector/effects'
import { freshGroups } from './clipboard'

export class PropsPanel {
  private burst = false
  /** Indent (+1) / outdent (−1) bullets — set by the editor to the canvas,
   *  which knows whether a text box is open and where its caret is. */
  onListIndent: ((dir: 1 | -1) => void) | null = null
  /** End the open edit burst by undoing it — a popover cancelled after its
   *  live previews leaves no trace and no undo step. */
  cancelBurst() {
    if (!this.burst) return
    this.burst = false
    this.store.undo()
  }
  /** A command's tooltip with its keys (commands.ts titleFor) — set by the
   *  editor, which owns the command list, so a hint cannot drift from the key. */
  titleOf: (id: string, label: string) => string = (_id, label) => label
  /** Delete the selection — set by the editor, whose delete asks before a
   *  component's main goes and promotes a copy; alone, the panel just deletes. */
  remove: (els: SlideElement[]) => void = (els) => this.deleteEls(els)
  /** Morph preview on the canvas: 0..1 of the way in, null restores — set
   *  by the editor to the canvas, which owns the rendered nodes. */
  onMorphPreview: ((t: number | null) => void) | null = null
  /** Present from the slide before and step into this one (editor.ts). */
  onPlayTransition: (() => void) | null = null

  constructor(
    readonly host: HTMLElement,
    readonly store: Store,
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

  stale = false

  /**
   * True only while the user is mid-edit in a control a rebuild would
   * disrupt: typing in text/number fields, or the native color popup.
   * Discrete controls (selects, checkboxes, buttons) commit atomically, so
   * the panel rebuilds the moment they change — structural rows (shadow
   * color, fx options) appear immediately instead of after focus leaves.
   */
  private isActiveEditFocus(): boolean {
    // the colour popover lives on <body>; while it is open a field is mid-edit
    if (document.querySelector('.ed-cpop')) return true
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
  edit(mutate: () => void, final: boolean) {
    if (!this.burst) {
      this.store.checkpoint()
      this.burst = true
    }
    mutate()
    this.store.touch()
    if (final) this.burst = false
  }

  /* The canonical API to edit `slide` attributes. */
  editSlideAttrs(slideId: string, mutate: (slide: Slide) => void, final: boolean) {
    const slide = this.store.slideById(slideId)
    if (slide) {
      this.edit(() => {
        mutate(slide)
      }, final)
    }
  }

  rebuild(force = false) {
    if (!force && this.isActiveEditFocus()) {
      this.stale = true // don't rip the field out from under the user; catch up on focusout
      return
    }
    this.stale = false
    this.burst = false
    // A doc edit rebuilds the same inspector in place: keep its scroll so a
    // control near the bottom does not throw the panel back to the top on
    // every change. A selection or slide switch (force) starts the new
    // inspector at the top, which is where a different subject belongs.
    const scrollTop = force ? 0 : this.host.scrollTop
    // an action inside the panel rebuilds it: remember where focus was
    const spot = force ? null : this.focusSpot()
    this.host.innerHTML = ''
    const els = this.store.selectedElements
    if (els.length === 0) buildSlidePanel(this)
    else if (els.length === 1) this.buildElementPanel(els[0])
    else this.buildMultiPanel(els)
    buildExport(this, els)
    this.applyAccordion()
    this.mountTabs()
    this.mountContext(els)
    this.stackCrampedRows()
    // focus first, without scrolling: the restored scroll is the last word
    if (spot) this.restoreFocus(spot)
    this.host.scrollTop = scrollTop
  }

  /**
   * Where focus sits in the panel, said so it survives a rebuild: the
   * control's name (its aria-label, title or text) and which of the controls
   * so named it is, plus the section it is in. Every action inside the panel
   * — a + that adds a shadow, a toolbar button, a radio, the colour popover
   * handing focus back to its swatch — rebuilds it, and without this focus
   * fell to <body>, stranding a keyboard user at the top of the page.
   */
  private focusSpot(): { name: string; nth: number; section: string } | null {
    const a = document.activeElement as HTMLElement | null
    if (!a || a === this.host || !this.host.contains(a)) return null
    const name = PropsPanel.nameOf(a)
    const same = [...this.host.querySelectorAll<HTMLElement>(PropsPanel.FOCUSABLE)].filter((x) => PropsPanel.nameOf(x) === name)
    const head = a.classList.contains('ed-section') ? a : a.closest('.ed-section') ?? a.closest('.ed-section-body')?.previousElementSibling
    return { name, nth: Math.max(0, same.indexOf(a)), section: (head as HTMLElement | null)?.dataset.key ?? '' }
  }

  /** The same control again; or, when the action replaced it (a + became a
   *  −, a row was added), the first control of the same section. */
  private restoreFocus(spot: { name: string; nth: number; section: string }) {
    const same = [...this.host.querySelectorAll<HTMLElement>(PropsPanel.FOCUSABLE)].filter((x) => PropsPanel.nameOf(x) === spot.name && x.offsetParent !== null)
    let to: HTMLElement | undefined = same[Math.min(spot.nth, same.length - 1)]
    if (!to && spot.section) {
      const head = [...this.host.querySelectorAll<HTMLElement>('.ed-section')].find((h) => h.dataset.key === spot.section)
      const body = head?.nextElementSibling
      to = (body?.classList.contains('ed-section-body') ? body.querySelector<HTMLElement>(PropsPanel.FOCUSABLE) : null) ?? head ?? undefined
    }
    to?.focus({ preventScroll: true })
  }

  private static FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex="0"], .ed-section'
  private static nameOf(x: HTMLElement): string {
    return `${x.tagName}|${x.getAttribute('aria-label') ?? x.title ?? ''}|${x.getAttribute('aria-label') || x.title ? '' : (x.textContent ?? '').trim().slice(0, 40)}`
  }

  /** Collapsed by default until the user opens them (persisted per title).
   *  English keys, matched against the TRANSLATED header like SHOW_SECTIONS. */
  private static CLOSED_BY_DEFAULT = ['Layout', 'Placeholder role', 'Advanced (JSON)', 'Export']

  /** Which tab a section lives on, by its English title — matched against
   *  the TRANSLATED header, like CLOSED_BY_DEFAULT. Format is the rest: how
   *  things look. Animate is how they move; Interact is what they do when the
   *  audience points at them. */
  private static TAB_SECTIONS: Record<'animate' | 'interact', string[]> = {
    animate: ['Animation', 'Morph', 'Transition'],
    interact: ['Interactivity'],
  }

  private tab: PanelTab = (() => {
    const saved = lsJson<string>('bento-panel-tab', 'format')
    return saved === 'animate' || saved === 'interact' ? saved : saved === 'show' ? 'animate' : 'format'
  })()

  /** Format | Animate | Interact, heading the panel the way design tools head
   *  theirs (Penpot: Design | Prototype | Inspect; Keynote: Format | Animate).
   *  A tab hides the others' sections with CSS (data-tab), so switching never
   *  rebuilds the panel or loses a field's state. A tab with nothing for this
   *  selection says so, rather than showing a blank. */
  private mountTabs() {
    const bar = document.createElement('div')
    bar.className = 'ed-tabs'
    bar.setAttribute('role', 'tablist')
    const tabs = [['format', t('Format')], ['animate', t('Animate')], ['interact', t('Interact')]] as const
    for (const [id, label] of tabs) {
      const b = document.createElement('button')
      b.type = 'button'
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', String(this.tab === id))
      b.textContent = label
      b.addEventListener('click', () => {
        this.tab = id
        lsSet('bento-panel-tab', JSON.stringify(id))
        this.host.dataset.tab = id
        for (const x of bar.children) x.setAttribute('aria-selected', String(x === b))
        this.stackCrampedRows() // rows on a hidden tab had no width to measure
      })
      bar.appendChild(b)
      if (!this.host.querySelector(`:scope > .ed-section[data-tab="${id}"], :scope > .ed-layer-block[data-tab="${id}"]`)) {
        const empty = document.createElement('p')
        empty.className = 'ed-hint ed-tab-empty'
        empty.dataset.tab = id
        empty.textContent = t('Nothing to set here for this selection.')
        this.host.appendChild(empty)
      }
    }
    // the pill sits in a full-width band of the panel's own surface: sticky,
    // it covers what scrolls under it edge to edge instead of floating over it
    roving(bar, 'tab')
    slidingPill(bar)
    const band = document.createElement('div')
    band.className = 'ed-tabs-band'
    band.appendChild(bar)
    this.host.prepend(band)
    this.host.dataset.tab = this.tab
  }

  /** The layer list: one instance, the SAME header and list nodes re-appended
   *  on every rebuild (a drag emits a doc event per frame; the rows are only
   *  rebuilt when what they say changed — layers.ts refresh). */
  /** The layer list. It lives in the side column now (editor.ts mounts it
   *  there); the panel still owns it because the panel owns the store verbs. */
  readonly layers = new LayersUI({
    slide: () => this.store.slide,
    selection: () => this.store.selection,
    select: (ids) => this.store.select(ids),
    setOrder: (elements) => this.store.commit(() => { this.store.slide.elements = elements }),
    rename: (id, name) => this.store.commit(() => {
      const el = this.store.element(id)
      if (!el) return
      if (name) el.name = name
      else delete el.name
    }),
    readOnly: () => this.store.readOnly,
    renameGroup: (gid, name) => this.store.commit(() => {
      for (const el of this.store.slide.elements) {
        if (el.groupId !== gid) continue
        if (name) el.groupName = name
        else delete el.groupName
      }
    }),
    toggle: (id, key) => this.store.commit(() => {
      const el = this.store.element(id)
      if (!el) return
      if (el[key]) delete el[key]
      else el[key] = true
    }),
    paired: () => morphPairs(this.store.doc, this.store.slide),
  })

  /**
   * Retrofit the flat panel into an accordion: every .ed-section header
   * gathers its following siblings into a collapsible body. Open state is
   * remembered per section title — everything stays discoverable (headers
   * always visible) while rarely-used sections stop costing space.
   */
  private applyAccordion() {
    let openState: Record<string, boolean> = {}
    openState = lsJson<Record<string, boolean>>('bento-panel-open', {})
    const headers = [...this.host.querySelectorAll<HTMLElement>('.ed-section')]
    const closed = new Set(PropsPanel.CLOSED_BY_DEFAULT.map((k) => t(k)))
    const tabOf = new Map<string, PanelTab>()
    for (const [tab, keys] of Object.entries(PropsPanel.TAB_SECTIONS)) for (const k of keys) tabOf.set(t(k), tab as PanelTab)
    for (const h of headers) {
      const key = h.dataset.key ?? h.textContent ?? ''
      const body = document.createElement('div')
      body.className = 'ed-section-body'
      let n: ChildNode | null = h.nextSibling
      while (n && !(n instanceof HTMLElement && n.classList.contains('ed-section'))) {
        const next: ChildNode | null = n.nextSibling
        body.appendChild(n)
        n = next
      }
      h.after(body)
      // Help paragraphs fold behind a "?" on the section's header line, as
      // design tools keep explanation out of the controls: hover or focus shows
      // it as a hint, a click unfolds it in place (touch has no hover). State
      // messages — .ed-status, the morph warning — are not help, and stay.
      const help = [...body.querySelectorAll<HTMLElement>(':scope > p.ed-hint:not(.ed-status, .ed-morph-warn, .ed-tab-empty, .ed-keep)')]
      if (help.length) {
        const q = document.createElement('button')
        q.type = 'button'
        q.className = 'ed-help-btn'
        q.textContent = '?'
        q.setAttribute('aria-label', t('Help'))
        q.setAttribute('aria-expanded', 'false')
        q.title = help.map((p) => p.textContent?.trim()).join('\n\n')
        q.addEventListener('click', () => q.setAttribute('aria-expanded', String(body.classList.toggle('ed-help-open'))))
        body.prepend(q)
      }
      h.dataset.tab = body.dataset.tab = tabOf.get(key) ?? 'format'
      // Nothing to fold: a section that is only its header (Shadow and Blur
      // before their + is pressed, a section whose controls this selection
      // lacks) reads as open — the same chevron as every open section, so the
      // column looks alike — but is no button: it would open onto nothing.
      // Folded-away help alone does not count as content.
      const empty = ![...body.children].some((c) => !c.matches('.ed-help-btn, p.ed-hint:not(.ed-status, .ed-morph-warn, .ed-tab-empty, .ed-keep)'))
      h.classList.toggle('ed-sec-flat', empty)
      if (empty) {
        h.classList.add('ed-sec-toggle')
        h.classList.remove('closed')
        body.style.display = ''
        h.removeAttribute('role'); h.removeAttribute('aria-expanded'); h.removeAttribute('tabindex')
        continue
      }
      const isOpen = openState[key] ?? !closed.has(key)
      h.classList.add('ed-sec-toggle')
      h.classList.toggle('closed', !isOpen)
      // the header IS the fold's button: reachable by Tab, Enter/Space folds
      h.tabIndex = 0
      h.setAttribute('role', 'button')
      h.setAttribute('aria-expanded', String(isOpen))
      if (!isOpen) body.style.display = 'none'
      // A header can outlive a rebuild (the Layers h3 is one node for the
      // panel's life), so the click handler is attached once and reads its
      // body from the DOM each time rather than closing over one that a later
      // rebuild threw away.
      if (h.dataset.acc) continue
      h.dataset.acc = '1'
      h.addEventListener('keydown', (e) => {
        if (e.target !== h || (e.key !== 'Enter' && e.key !== ' ') || h.classList.contains('ed-sec-flat')) return
        e.preventDefault()
        h.click()
      })
      h.addEventListener('click', () => {
        if (h.classList.contains('ed-sec-flat')) return // nothing to fold (emptied by a later rebuild)
        const nowClosed = h.classList.toggle('closed')
        h.setAttribute('aria-expanded', String(!nowClosed))
        const live = h.nextElementSibling as HTMLElement | null
        if (live?.classList.contains('ed-section-body')) foldSection(live, nowClosed)
        if (!nowClosed) this.stackCrampedRows()
        const state = lsJson<Record<string, boolean>>('bento-panel-open', {})
        state[key] = !nowClosed
        lsSet('bento-panel-open', JSON.stringify(state))
      })
    }
  }

  private buildMultiPanel(els: SlideElement[]) {
    componentHeader(this, els)
    layerBlock(this, els)
    buildSharedPaint(this, els)
    section(this, t('Animation'))
    revealRow(this, els)
  }

  private buildElementPanel(el: SlideElement) {
    // Penpot's order: how it sits (align, order, blend, opacity, measures) with
    // no header, then what it IS (its type's own controls), then the optional
    // layers of paint — fill, stroke, shadow, blur — each added from its header.
    componentHeader(this, [el])
    layerBlock(this, [el])
    section(this, t({ text: 'Text', shape: 'Shape', image: 'Image', svg: 'Diagram', chart: 'Chart', table: 'Table', code: 'Code', media: el.type === 'media' && el.kind === 'audio' ? 'Audio' : 'Video', embed: 'Embed' }[el.type]))
    const kindHead = this.host.lastElementChild!
    if (el.type === 'text') buildTextProps(this, el)
    if (el.type === 'shape') buildShapeProps(this, el)
    if (el.type === 'image') buildImageProps(this, el)
    if (el.type === 'chart') buildChartProps(this, el)
    if (el.type === 'table') buildTableProps(this, el)
    if (el.type === 'media') buildMediaProps(this, el)
    if (el.type === 'code') buildCodeProps(this, el)
    if (el.type === 'embed') buildEmbedProps(this, el)
    // a kind with nothing of its own (an ellipse, a diagram) shows no empty
    // header, and one whose builder opens its own section (Chart, Source
    // code) does not get the kind's name twice
    const next = kindHead.nextElementSibling
    if (!next || next.classList.contains('ed-section')) kindHead.remove()
    if (el.type === 'text') { buildTextFill(this, el); buildTextStroke(this, el) }
    if (el.type === 'shape') { buildShapeFill(this, el); buildShapeStroke(this, el) }
    buildShadow(this, el)
    buildBlur(this, el)
    buildAutoLayout(this, el)
    buildLayoutRole(this, el)
    buildPresentingProps(this, el)
    buildMorphProps(this, el)
  }

  toast(message: string) {
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

  // --- element ops --------------------------------------------------------------

  /**
   * A dropdown whose chosen option does not fit beside its caption gets the
   * row to itself — caption above, field full width — rather than cutting
   * the value off, in whichever language made it long. The value is measured
   * with text metrics against the select's laid-out width, so a dropdown that
   * is not rendered (closed section, other tab) is skipped: opening a section,
   * switching tab and resizing the panel each measure again.
   */
  private stackCrampedRows() {
    const host = this.host
    const ctx = (PropsPanel.measure ??= document.createElement('canvas').getContext('2d')!)
    // measured in the caption | control grid: a value wider than the control
    // column takes the row to itself, caption above
    for (const sel of host.querySelectorAll<HTMLSelectElement>('.ed-row > select')) {
      const row = sel.parentElement!
      row.classList.remove('ed-row-stack')
      if (!sel.offsetParent) continue
      ctx.font = getComputedStyle(sel).font
      const valueW = ctx.measureText(sel.options[sel.selectedIndex]?.text ?? '').width + 30 // padding + arrow
      row.classList.toggle('ed-row-stack', valueW > sel.clientWidth)
    }
    // a caption that would take more than two lines beside its control (de,
    // pt: 'Transformar a partir do slide anterior') goes above it instead
    // (cleared, measured, then applied in batches: one reflow, not one per row)
    const caps = [...host.querySelectorAll<HTMLElement>('.ed-row:not(:has(> select)) > span:first-child')]
    for (const cap of caps) cap.parentElement!.classList.remove('ed-row-stack')
    const line = caps[0] ? parseFloat(getComputedStyle(caps[0]).lineHeight) || 14 : 14
    const tall = caps.filter((cap) => cap.offsetParent && cap.offsetHeight > line * 2 + 1)
    for (const cap of tall) cap.parentElement!.classList.add('ed-row-stack')
    if (!this.watchingWidth) {
      this.watchingWidth = true
      let last = host.clientWidth
      new ResizeObserver(() => { if (host.clientWidth !== last) { last = host.clientWidth; this.stackCrampedRows() } }).observe(host)
    }
  }
  static measure: CanvasRenderingContext2D | undefined
  static rowIds = 0
  private watchingWidth = false

  /**
   * What the panel is about, under the tabs, on every tab: the selection's
   * glyph and name, its two everyday actions, and one quiet line on how to
   * change it. The panel follows the selection — select something and its
   * options appear, click empty space and the slide's come back — and this
   * says so, so a different set of options never arrives as a surprise.
   */
  private mountContext(els: SlideElement[]) {
    const bar = document.createElement('div')
    bar.className = 'ed-context'
    const glyph = document.createElement('span')
    glyph.className = 'ed-context-glyph'
    const name = document.createElement('span')
    name.className = 'ed-context-name'
    const how = document.createElement('p')
    how.className = 'ed-context-how'
    const one = els.length === 1 ? els[0] : null
    if (!els.length) {
      const slide = this.store.slide
      glyph.innerHTML = ICONS.slideshow
      name.textContent = slide.name || t('Slide {n}', { n: this.store.currentIndex + 1 })
      how.textContent = t('Select something on the slide to see its options.')
    } else {
      glyph.innerHTML = one ? (LAYER_GLYPH[one.type] ?? ICONS.shapes) : ICONS.shapes
      name.textContent = one ? labelIn(this.store.slide, one, t) : t('{n} elements', { n: els.length })
      how.textContent = one ? t('Click an empty part of the slide for the slide’s options.') : t('Shift-click to add an element or take one out.')
    }
    name.title = name.textContent ?? ''
    bar.append(glyph, name)
    if (els.length) {
      bar.append(
        opBtn(ICONS.copy, this.titleOf('duplicate', t('Duplicate')), () => this.duplicate(els)),
        opBtn(ICONS.trash, this.titleOf('delete', t('Delete')), () => this.remove(els)),
      )
    }
    this.host.querySelector(':scope > .ed-tabs-band')!.after(bar, how)
  }

  /** ⇧A — wrap the selection in an auto-layout frame (inspector/layout.ts). */
  addAutoLayout(els: SlideElement[]) { wrapInFrame(this, els) }

  group(els: SlideElement[]) {
    if (els.length < 2) return
    const gid = `grp-${uid()}`
    // A group is one block in the stack, as in every design tool: the members
    // gather where the topmost of them was, keeping their own order, so the
    // layer list can show the group as one row with its members under it.
    // One undo step with the tagging.
    this.edit(() => {
      const ids = new Set(els.map((e) => e.id))
      const all = this.store.slide.elements
      const members = all.filter((e) => ids.has(e.id))
      let top = -1
      all.forEach((e, i) => { if (ids.has(e.id)) top = i })
      const rest = all.filter((e) => !ids.has(e.id))
      const at = all.slice(0, top + 1).filter((e) => !ids.has(e.id)).length
      this.store.slide.elements = [...rest.slice(0, at), ...members, ...rest.slice(at)]
      for (const el of members) { el.groupId = gid; delete el.groupName }
    }, true)
  }

  // --- reveal verbs (editor/reveal.ts decides, this applies) ---------------

  /** Number the selection in reading order: top-to-bottom, then left-to-right. */
  revealInOrder(els: SlideElement[]) { applySteps(this, revealInOrder(this.store.slide.elements, els)) }

  /** The whole selection on one step, after everything else on the slide. */
  revealTogether(els: SlideElement[]) { applySteps(this, revealTogether(this.store.slide.elements, els)) }

  /** Shown with the slide again. */
  removeReveal(els: SlideElement[]) { applySteps(this, removeReveal(els)) }

  ungroup(els: SlideElement[]) {
    const gids = new Set(els.map((e) => e.groupId).filter(Boolean))
    this.edit(() => {
      for (const el of this.store.slide.elements) {
        if (el.groupId && gids.has(el.groupId)) { delete el.groupId; delete el.groupName }
      }
    }, true)
  }

  private duplicate(picked: SlideElement[]) {
    // a frame brings its contents; the batch keeps its groups and frames among
    // its copies (clipboard.freshGroups)
    const els = withDescendants(this.store.slide, picked)
    const clones = freshGroups(els.map((el) => ({
      ...JSON.parse(JSON.stringify(el)),
      id: `${el.id.replace(/-copy\d*$/, '')}-copy${Math.floor(Math.random() * 1000)}`,
      x: el.x + 24,
      y: el.y + 24,
    })), els)
    adoptComponents(clones, this.store.doc)
    this.store.commit(() => this.store.slide.elements.push(...clones))
    const top = new Set(picked.map((e) => els.indexOf(e)))
    this.store.select(clones.filter((_, i) => top.has(i)).map((c) => c.id))
  }

  private deleteEls(els: SlideElement[]) {
    const ids = new Set(withDescendants(this.store.slide, els).map((e) => e.id))
    this.store.commit(() => {
      this.store.slide.elements = this.store.slide.elements.filter((e) => !ids.has(e.id))
    })
    this.store.select([])
  }

  /** Also driven by the canvas context menu (editor.ts). */
  reorder(els: SlideElement[], where: 'front' | 'back') {
    const ids = new Set(els.map((e) => e.id))
    this.store.commit(() => {
      const slide = this.store.slide
      const picked = slide.elements.filter((e) => ids.has(e.id))
      const rest = slide.elements.filter((e) => !ids.has(e.id))
      slide.elements = where === 'front' ? [...rest, ...picked] : [...picked, ...rest]
    })
  }

  // --- tiny DOM helpers -----------------------------------------------------------

  mutate(id: string, fn: (el: SlideElement) => void, final: boolean) {
    const el = this.store.element(id)
    if (el) this.edit(() => fn(el), final)
  }
}

type PanelTab = 'format' | 'animate' | 'interact'

/**
 * Open or close a section body with a short height tween (styles.css
 * --ed-fold). Opening shows it at once and grows it, so anything that reads
 * the open section reads it immediately; closing shrinks, then hides.
 * Reduced motion: no tween.
 */
function foldSection(body: HTMLElement, close: boolean) {
  body.getAnimations().forEach((a) => a.cancel())
  if (!close) body.style.display = ''
  const ms = parseFloat(getComputedStyle(body).getPropertyValue('--ed-fold-ms')) || 0
  if (!ms || matchMedia('(prefers-reduced-motion: reduce)').matches) { body.style.display = close ? 'none' : ''; return }
  const h = `${body.scrollHeight}px`
  const a = body.animate(
    [{ height: close ? h : '0px', opacity: close ? 1 : 0, overflow: 'hidden' }, { height: close ? '0px' : h, opacity: close ? 0 : 1, overflow: 'hidden' }],
    { duration: ms, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
  if (close) a.onfinish = () => { body.style.display = 'none' }
}
