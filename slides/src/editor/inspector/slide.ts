// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The slide's own panel (background, transition, page) and the deck theme.
import type { PropsPanel } from '../panels'
import { section, row, toggle, mini, select, labeledSelect, number, segmented, field } from './fields'
import { t } from '../../i18n'
import { color } from './color'
import { type Slide, uid, type TransitionKind } from '../../model'
import { ROW_TIPS } from './controls'
import { slideLabel, syncStateFromParent } from './animate'
import { ICONS } from '../../icons'
import { CODE_SCOPES, DEFAULT_CODE_COLORS } from '../../code'

  // --- builders ---------------------------------------------------------------

export const PAGE_PRESETS: Record<string, { w: number; h: number }> = {
  'Widescreen 16:9': { w: 1280, h: 720 },
  'Classic 4:3': { w: 960, h: 720 },
  'Square 1:1': { w: 1080, h: 1080 },
  'Portrait 9:16': { w: 1080, h: 1920 },
  'A4 landscape': { w: 1123, h: 794 },
  'A4 portrait': { w: 794, h: 1123 },
}

export function buildSlidePanel(p: PropsPanel) {
  const slide = p.store.slide
  // Track the `slide.id` so when updating you can find the slide to update using its `id`. 
  // This way if the doc is actively replaced and the references are stale the update still succeeds.
  const slideId = slide.id
  section(p, t('Slide'))
  row(p, 'Background', color(p, slide.background, (v, fin) =>
    p.editSlideAttrs(slideId, (slide: Slide) => { slide.background = v }, fin),
    { id: null, path: 'background', slide }))
  // Hidden slides stay in the deck and stay editable; they drop out of the
  // walk, the PDF and the file thumbnail. Offered only on ordinary slides —
  // a state is already unreachable linearly, so hiding one means nothing.
  if (!slide.stateOf) {
    row(p, 'Hide slide', toggle(!!slide.hidden, (v) =>
      p.editSlideAttrs(slideId, (slide: Slide) => {
        if (v) slide.hidden = true
        else delete slide.hidden
      }, true)))
    // The third answer to "does it take a number": stays in the walk, counts
    // for nothing, and {{page}} on it continues the slide before. Builds
    // (one element revealed per morph step) and interstitials.
    row(p, 'Skip numbering', toggle(!!slide.unnumbered, (v) =>
      p.editSlideAttrs(slideId, (slide: Slide) => {
        if (v) slide.unnumbered = true
        else delete slide.unnumbered
      }, true)))
    if (slide.unnumbered) {
      const hint = document.createElement('p')
      hint.className = 'ed-hint'
      hint.textContent = t('Stays in the show without a number of its own — its page-number field shows the previous slide’s. Use it for build-up steps or a divider that shouldn’t count.')
      p.host.appendChild(hint)
    }
  }

  section(p, t('Layout'))
  const applyLy = document.createElement('button')
  applyLy.className = 'ed-btn ed-btn-block'
  applyLy.textContent = t('⧉ Apply layout…')
  applyLy.title = t('Re-arrange this slide onto a layout — content moves by matching id, then role; extra elements are kept')
  applyLy.addEventListener('click', () =>
    document.dispatchEvent(new CustomEvent('bento:apply-layout', { detail: { anchor: applyLy } })))
  p.host.appendChild(applyLy)

  const saveLy = document.createElement('button')
  saveLy.className = 'ed-btn ed-btn-block'
  saveLy.textContent = t('＋ Save slide as layout…')
  saveLy.title = t('Adds this slide to the layouts offered by New slide in this deck')
  saveLy.addEventListener('click', () => {
    const name = window.prompt(t('Layout name'), slide.name ?? t('My layout'))
    if (!name) return
    p.edit(() => {
      const doc = p.store.doc
      const copy: Slide = JSON.parse(JSON.stringify(slide))
      doc.layouts = [...(doc.layouts ?? []), { ...copy, id: uid('layout'), name, stateOf: undefined, notes: '' }]
    }, true)
  })
  p.host.appendChild(saveLy)

  buildThemeProps(p)

  // What applies to the whole DECK, in one section: its page size and how
  // it presents (slide numbers, progress, arrows). None of these is a
  // property of THIS slide, and mixing them in beside Background read as
  // per-slide. Keynote keeps the same set in its Document inspector.
  section(p, t('Deck'))
  // deck-wide page size: presets + custom. Elements keep their absolute
  // positions — a size change reframes the canvas, it never rescales art.
  const { width: dw, height: dh } = p.store.doc.size
  const presetKey =
    Object.entries(PAGE_PRESETS).find(([, s]) => s.w === dw && s.h === dh)?.[0] ?? 'Custom…'
  // The sizes as tiles, each DRAWN at its proportions, its ratio under it —
  // a page size is a shape before it is a name, and every option is one
  // click. Custom opens W and H below.
  const tiles = document.createElement('div')
  tiles.className = 'ed-page-tiles'
  tiles.setAttribute('role', 'radiogroup')
  tiles.setAttribute('aria-label', t('Page size'))
  tiles.title = t(ROW_TIPS['Page size'])
  let size: HTMLElement
  const tile = (key: string, w: number, h: number, caption: string) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-page-tile'
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', String(key === presetKey))
    b.title = t(key)
    b.setAttribute('aria-label', t(key))
    const shape = document.createElement('span')
    shape.className = 'ed-page-shape'
    // the longer side 22px, the shorter in proportion
    const k = 22 / Math.max(w, h)
    shape.style.width = `${Math.round(w * k)}px`
    shape.style.height = `${Math.round(h * k)}px`
    const cap = document.createElement('span')
    cap.textContent = caption
    b.append(shape, cap)
    b.addEventListener('click', () => {
      const s = PAGE_PRESETS[key]
      if (s) p.edit(() => { p.store.doc.size = { width: s.w, height: s.h } }, true)
      else { size.hidden = false; for (const x of tiles.children) x.setAttribute('aria-checked', String(x === b)) }
    })
    tiles.appendChild(b)
  }
  for (const [key, s] of Object.entries(PAGE_PRESETS)) {
    // 'Widescreen 16:9' → '16:9'; 'A4 landscape' → 'A4'
    tile(key, s.w, s.h, /\d+:\d+/.exec(key)?.[0] ?? key.split(' ')[0])
  }
  tile('Custom…', presetKey === 'Custom…' ? dw : 4, presetKey === 'Custom…' ? dh : 3, t('Custom…').replace(/…$/, ''))
  tiles.lastElementChild!.classList.add('ed-page-custom') // a word, not a ratio: it takes two cells
  p.host.appendChild(tiles)
  size = document.createElement('div')
  size.className = 'ed-grid2'
  size.append(
    mini(t('W'), dw, (v, fin) =>
      p.edit(() => { p.store.doc.size.width = Math.round(v) }, fin), undefined, { min: 320, max: 4000 }),
    mini(t('H'), dh, (v, fin) =>
      p.edit(() => { p.store.doc.size.height = Math.round(v) }, fin), undefined, { min: 320, max: 4000 }),
  )
  size.firstElementChild!.setAttribute('title', t('Custom slide width in pixels'))
  size.lastElementChild!.setAttribute('title', t('Custom slide height in pixels'))
  size.hidden = presetKey !== 'Custom…'
  p.host.appendChild(size)
  // These live in doc.present because they are AUDIENCE-facing: what the
  // author designs is what a recipient's audience sees. Contrast reduce-motion
  // and locale, which are viewer preferences and deliberately never enter the
  // document.
  //
  // Each writes `undefined` at its default rather than the default value, so a
  // deck that never touches these carries no `present` block at all.
  const pres = p.store.doc.present ?? {}
  const setPresent = (k: 'slideNumber' | 'progress' | 'controls' | 'numberHidden', v: boolean, dflt: boolean) =>
    p.edit(() => {
      const d = p.store.doc
      const cur = { ...(d.present ?? {}) }
      if (v === dflt) delete cur[k]
      else cur[k] = v
      if (Object.keys(cur).length) d.present = cur
      else delete d.present
    }, true)
  row(p, 'Slide number', toggle(pres.slideNumber ?? true,
    (v) => setPresent('slideNumber', v, true)))
  row(p, 'Progress bar', toggle(pres.progress ?? true,
    (v) => setPresent('progress', v, true)))
  row(p, 'Corner arrows', toggle(pres.controls ?? false,
    (v) => setPresent('controls', v, false)))
  // Off by default: skipped means uncounted, the same rule interactive states
  // already follow, which is what keeps the audience's numbering contiguous.
  // On matches PowerPoint and Keynote, where a hidden slide keeps its number
  // so the visible ones do not renumber as you toggle slides during rehearsal.
  row(p, 'Number hidden slides', toggle(pres.numberHidden ?? false,
    (v) => setPresent('numberHidden', v, false)))


  // interactivity: naming, state-of, hover focus
  // the section names it: the picker needs no second label
  section(p, t('Transition'))
  const trans = segmented(['none', 'fade', 'slide', 'zoom', 'morph'], slide.transition,
    (v) => p.editSlideAttrs(slideId, (slide: Slide) => { slide.transition = v as TransitionKind }, true), undefined,
    { none: ICONS.transNone, fade: ICONS.transFade, slide: ICONS.transPush, zoom: ICONS.transZoom, morph: ICONS.transMorph })
  trans.setAttribute('aria-label', t('Transition'))
  field(p, trans)
  if (slide.transition === 'morph') {
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.innerHTML = t('<b>Morph</b> animates elements that appear on both this slide and the previous one (copy a slide, then move things around).')
    p.host.appendChild(hint)
  }

  section(p, t('Interactivity'))
  const name = document.createElement('input')
  name.type = 'text'
  name.placeholder = t('unnamed')
  name.value = slide.name ?? ''
  name.addEventListener('change', () =>
     p.editSlideAttrs(slideId, (slide: Slide) => { slide.name = name.value || undefined }, true))
  row(p, 'Slide name', name)

  const stateSel = document.createElement('select')
  const optNone = document.createElement('option')
  optNone.value = ''
  optNone.textContent = t('None — a normal slide')
  stateSel.appendChild(optNone)
  p.store.doc.slides.forEach((s, i) => {
    if (s.stateOf || s.id === slide.id) return
    const o = document.createElement('option')
    o.value = s.id
    o.textContent = slideLabel(p, s, i)
    if (slide.stateOf === s.id) o.selected = true
    stateSel.appendChild(o)
  })
  stateSel.addEventListener('change', () =>
    p.editSlideAttrs(slideId, (slide: Slide) => {
      slide.stateOf = stateSel.value || undefined
      p.store.emit('slides')
    }, true))
  stateSel.title = t('Make this slide a variant of another slide: arrow keys skip it, the audience opens it by clicking a linked element, and matching elements morph between the two.')
  row(p, 'Variant of', stateSel)

  if (slide.stateOf) {
    const sync = document.createElement('button')
    sync.className = 'ed-btn ed-btn-block'
    sync.innerHTML = `${ICONS.sync}<span>${t('Update from main slide')}</span>`
    sync.title = t('Copies in elements added to the main slide since, and follows its layer order. Your changes in this variant are kept.')
    sync.addEventListener('click', () => syncStateFromParent(p))
    p.host.appendChild(sync)
  }

  row(p, 'On hover', labeledSelect(
    [['none', t('None')], ['focus-group', t('Dim other groups')], ['reveal', t('Switch content')]],
    slide.hover?.type ?? 'none',
    (v) => p.editSlideAttrs(slideId, (slide: Slide) => {
      slide.hover = v === 'none'
        ? undefined
        : { ...(slide.hover ?? {}), type: v as 'focus-group' | 'reveal' }
    }, true)))
  if (slide.hover?.type === 'focus-group') {
    row(p, 'Fade others to', number(slide.hover.dim ?? 0.15, 0.01, (v, fin) =>
      p.editSlideAttrs(slideId, (slide: Slide) => { if (slide.hover) slide.hover.dim = Math.min(Math.max(v, 0), 1) }, fin), { min: 0, max: 1 }))
  }
  if (slide.hover?.type === 'reveal') {
    const sets = [...new Set(slide.elements.map((e) => e.showOnHover).filter(Boolean))] as string[]
    const defIn = document.createElement('input')
    defIn.type = 'text'
    defIn.placeholder = sets[0] ?? t('group name')
    defIn.value = slide.hover.default ?? ''
    defIn.addEventListener('change', () =>
      p.editSlideAttrs(slideId, (slide: Slide) => { if (slide.hover) slide.hover.default = defIn.value || undefined }, true))
    row(p, 'Shown at rest', defIn)
    if (sets.length) {
      row(p, 'Preview on canvas', select(sets, p.store.hoverPreview ?? slide.hover.default ?? sets[0], (v) => {
        p.store.hoverPreview = v
        p.store.emit('current') // re-render canvas without touching the doc
      }))
      const revealHint = document.createElement('p')
      revealHint.className = 'ed-hint'
      revealHint.innerHTML = t('While presenting, pointing at an element shows the content whose <b>Show on hover of</b> matches its <b>Hover group</b>. Pick a group in <b>Preview on canvas</b> to edit its content.')
      p.host.appendChild(revealHint)
    }
  }

}

/**
 * Deck-wide brand colours. Editing one re-derives every colour in the deck
 * that points at it (editor.syncThemeRefs), which is what makes a Bento deck
 * re-brandable rather than a pile of literals.
 */
export function buildThemeProps(p: PropsPanel) {
  // One home for the deck's colours: the Tokens view, where the theme colours
  // lead as built-in tokens beside the deck's own, with their uses and modes.
  // This section only points there — listing them again here made "theme" and
  // "tokens" look like two systems.
  section(p, t('Theme'))
  const link = document.createElement('button')
  link.type = 'button'
  link.className = 'ed-btn ed-btn-block ed-theme-tokens'
  link.textContent = t('Colors live in Tokens →')
  link.title = t('The deck’s theme colors and your color tokens, with where each is used')
  link.addEventListener('click', () => document.querySelector<HTMLElement>('.ed-side-tabs [data-view="tokens"]')?.click())
  p.host.appendChild(link)
  // Code colours only mean something to a deck with code in it
  if (p.store.doc.slides.some((s) => s.elements.some((e) => e.type === 'code'))) buildCodeColors(p)
}

/** The colours of code snippets, one per kind of token — their own section,
 *  folded by default; not the deck's brand, so not in Tokens either. */
function buildCodeColors(p: PropsPanel) {
  section(p, t('Code colors'))
  const slot = (label: string, get: () => string, set: (v: string) => void) =>
    row(p, label, color(p, get(), (v, fin) => p.edit(() => set(v), fin)))
  // Code colours: theme.codePalette (#450), one row per token scope. Plain
  // literals, deliberately — the palette-swatch reference (themeRefs) is a
  // per-element/per-slide path resolved through resolveRef, and codePalette
  // is a doc-level map that code.ts reads as literals; wiring a second
  // reference shape for eight keys would be a mechanism, not a row. A deck
  // with no codePalette shows the built-in scheme as its starting values and
  // the field is written only when a colour is changed, so a deck without
  // one keeps rendering exactly as before.
  for (const scope of CODE_SCOPES) {
    slot(t(scope.label), () => p.store.doc.theme.codePalette?.[scope.key] ?? DEFAULT_CODE_COLORS[scope.key], (v) => {
      const t2 = p.store.doc.theme
      ;(t2.codePalette ??= {})[scope.key] = v
    })
  }
  if (p.store.doc.theme.codePalette) {
    const reset = document.createElement('button')
    reset.className = 'ed-btn ed-btn-block'
    reset.textContent = t('Use the built-in code colours')
    reset.title = t('Removes the deck’s code palette; snippets render with the standard scheme again')
    reset.addEventListener('click', () => p.edit(() => { delete p.store.doc.theme.codePalette }, true))
    p.host.appendChild(reset)
  }
}
