// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Inspector primitives with no panel state: scrubbing, roving focus, limits, colour parsing.
import { type BentoDoc, uid } from '../../model'
import { t } from '../../i18n'
import { ICONS } from '../../icons'
import { evalNumber } from './numexpr'

// Hover help for panel rows, keyed by the RAW English label (translated at
// render). A missing entry means no tooltip — better silence than an echo.
// i18n NOTE: both the keys (row labels) and the values here reach t() as
// VARIABLES — literal-extraction sweeps must treat this table as in-use
// catalog keys, never prune them.
/**
 * Sentinel <option> value for "clear the morph override". Safe against
 * collision with a real morph key by construction: setMorphId strips anything
 * outside [A-Za-z0-9._-], so no stored morphId can ever contain '#'.
 */
export const UNPAIR = '#unpair'

export const ROW_TIPS: Record<string, string> = {
  'Page size': 'Deck-wide slide size. Elements keep their positions — changing size reframes the canvas, never rescales your art.',
  'Width': 'Custom slide width in pixels',
  'Height': 'Custom slide height in pixels',
  'Slide number': 'Deck-wide. Show the slide counter to the audience while presenting.',
  'Progress bar': 'Deck-wide. Show the thin progress bar along the bottom while presenting.',
  'Corner arrows': 'Deck-wide. Show clickable ‹ › arrows in the corner while presenting. Off by default — clicks and arrow keys already move between slides.',
  'Background': 'This slide’s background colour',
  'Transition': 'How this slide comes in. Morph moves matching elements from the previous slide into place.',
  'Slide name': 'Optional. Shown in the Link to and Variant of lists and on variant thumbnails, so this slide is easy to pick.',
  'On hover': 'While presenting, what happens when the pointer rests on an element that has a Hover group: dim the other groups, or switch which content shows.',
  'Fade others to': 'How visible the other groups stay while one is pointed at: 0 = hidden, 1 = no fading. 0.15 is a soft fade.',
  'Shown at rest': 'The Hover group whose content shows before the pointer is on anything. Empty = nothing extra.',
  'Preview on canvas': 'Which Hover group’s content the canvas shows while you edit. Doesn’t change the show.',
  'Layout role': 'What this text is in the layout (title, body…). Apply layout uses it to put content in the matching place.',
  'Entrance': 'How the element appears when the slide comes in. Skipped when it morphs in from the previous slide.',
  'Entrance (s)': 'How long the entrance takes, in seconds',
  'Appears on click': '0 = shown with the slide. 1 = appears on the first click or → press, 2 = on the second, and so on. Elements with the same number appear together.',
  'Count up numbers': 'Numbers in this text count up from zero when the slide enters',
  'Typewriter': 'Code types in a character at a time, behind a cursor, when it appears',
  'Pan & zoom': 'Slow, continuous Ken Burns motion while the slide is on screen — made for full-bleed photos.',
  'Motion': 'Drift: an endless slow pan and zoom. Zoom out / Zoom in: one smooth zoom each time the slide appears.',
  'Zoom': 'How far the picture is zoomed inside its frame',
  'Zoom amount %': 'How far the Ken Burns zoom travels',
  'Pan & zoom (s)': 'How long one pan-and-zoom pass takes, in seconds',
  // 'Loop animation' — NOT 'Loop': the media panel's playback toggle owns that
  // word, and one key cannot mean both (a language must pick one and be wrong
  // in the other place).
  'Loop animation': 'A repeating animation: marching dashes along strokes, or motion along a drawn path',
  'Seconds per lap': 'How long one lap takes — lower is faster',
  'Motion path': 'The motion path — edit it as draggable points on the canvas',
  'Lap speed': 'How the speed changes during one lap — constant, or easing in and out at the ends',
  'Show on hover of': 'Type a Hover group name: this element stays hidden until the pointer is on an element of that group (slide’s On hover: Switch content). Empty = always visible.',
  'Hover group': 'A name shared by elements that react to the pointer together while presenting (see On hover on the slide). Not the same as ⌘G grouping.',
  'Link to': 'Clicking this element during the show jumps to the chosen slide',
  'Web link': 'Clicking this element during the show opens this web page in a new tab (https:// only)',
  'Size (pt)': 'Font size in points',
  'Align': 'Horizontal text alignment',
  'Vertical align': 'Vertical alignment inside the box',
  'Line height': 'Line spacing as a multiple of the font size',
  'Line start': 'Decoration at the line’s start — arrow, dot or bar',
  'Line end': 'Decoration at the line’s end — arrow, dot or bar',
  'Corner radius': 'How rounded the corners are, in pixels',
  'Type': 'Chart type — switching bar⇄pie animates the data across',
  'Legend': 'Show the series legend above the chart',
  'Second axis': 'Adds a right-hand value axis — assign series to it in the list below',
  'Header row': 'Style the first row as a header',
  'Preset': 'Quick table looks — Lined, Zebra, Boxed, Minimal',
  'Header fill': 'Header row background colour',
  'Header text': 'Header row text colour',
  'Text': 'Table text colour',
  'Grid lines': 'Colour of the lines between cells',
  'Fit': 'How the media fills its box — cover crops to fill, contain letterboxes',
  'URL': 'Link a hosted file instead of embedding — keeps the deck small',
  'Poster': 'Preview image shown before the video plays',
  'Page URL': 'The web page the live frame loads while online (http or https)',
  'Live': 'Load the page in a sandboxed frame while online. Offline, or with offline mode on, the captured view shows instead.',
  'Variant of': 'Make this slide a variant of another slide: arrow keys skip it, the audience opens it by clicking a linked element, and matching elements morph between the two.',
  'Skip numbering': 'This slide stays in the show but gets no number of its own; its page-number field shows the previous slide’s.',
  'Number hidden slides': 'On: hidden slides keep their number, so the others don’t renumber when you hide one (as in PowerPoint). Off: the audience sees no gaps in the numbering.',
  'Morph name': 'Elements with the same morph name on neighbouring slides morph into each other. Until you change it, it is the element’s own name.',
  'Morph with': 'Pick an element on another slide; this one takes its morph name and morphs into it.',
}

/** An embed view from a raster: one <svg> around a data:image, sized to the
 *  element so it fills the box the way `fit: cover` would. */
export function rasterView(dataUri: string, w: number, h: number): string {
  const vw = Math.max(1, Math.round(w)), vh = Math.max(1, Math.round(h))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}">`
    + `<image href="${dataUri.replace(/"/g, '')}" width="${vw}" height="${vh}" preserveAspectRatio="xMidYMid slice"/></svg>`
}

/** internAsset for raw svg markup: identical markup reuses its key. Callers
 *  run inside a store.commit for the same reason internAsset's do. */
export function internView(doc: BentoDoc, markup: string): string {
  const assets = (doc.assets ??= {})
  for (const k in assets) if (assets[k] === markup) return `asset:${k}`
  const key = uid('a')
  assets[key] = markup
  return `asset:${key}`
}

/**
 * Fill-style options: the stored model words are 'solid'/'gradient', only the
 * LABEL is localised. 'solid' here is a solid COLOUR, which in many languages
 * is a different word from the 'solid' LINE style further down (Swedish:
 * enfärgad vs heldragen) — so it gets its own catalog key rather than sharing
 * one that must be wrong in one of the two places.
 *
 * A function, not a const: t() in a module-level const freezes the English at
 * import time.
 */
export const fillStyles = (): Array<[string, string]> =>
  [['solid', t('Solid')], ['linear', t('Linear')], ['radial', t('Radial')]]

/**
 * Stored model words → the sentence-case English key that labels them, for
 * select()/segmented() and the few lists built from model words. A model word
 * is never its own label: 'none' would show as "none" (and "nenhum" in pt)
 * where every other option reads "Fade up". Words without an entry are
 * already labels ('Arrow', 'Widescreen 16:9').
 */
export const OPTION_LABEL: Record<string, string> = {
  none: 'None', off: 'Off', on: 'On', custom: 'Custom',
  fade: 'Fade', slide: 'Push', zoom: 'Zoom', morph: 'Morph', // slide transitions
  subtle: 'Subtle', soft: 'Soft', elevated: 'Elevated', glow: 'Glow', // shadow presets
  filled: 'Filled', hollow: 'Hollow',
  contain: 'Contain', cover: 'Cover', fill: 'Stretch',
  left: 'Left', center: 'Center', right: 'Right', top: 'Top', middle: 'Middle', bottom: 'Bottom',
  title: 'Title', subtitle: 'Subtitle', body: 'Body', kicker: 'Kicker', // layout roles
}

export const optLabel = (v: string): string => t(OPTION_LABEL[v] ?? v)

/** A palette slot as the author knows it. */
export function slotLabel(slot: string): string {
  switch (slot) {
    case 'bg1': return t('Background')
    case 'tx1': return t('Text')
    case 'bg2': return t('Background 2')
    case 'tx2': return t('Text 2')
    case 'hlink': return t('Link')
    case 'folHlink': return t('Visited link')
    default: return t('Accent {n}', { n: slot.replace('accent', '') })
  }
}

/** Fired on a numeric field while its label is being scrubbed: a live,
 *  non-final edit. The release fires an ordinary `change`. */
export const SCRUB = 'ed-scrub'

/**
 * Drag a numeric field's label to change its value, the gesture every design
 * tool has: 2px per step, Shift ×10, Alt ×0.1. A press that does not move is
 * an ordinary label click and focuses the field for typing.
 *
 * Past the 3px dead zone the pointer is LOCKED (hidden, unbounded), as in
 * Figma: a drag no longer dies at the edge of the screen. Locked, the pointer
 * reports movement, not position, so the drag runs on its own accumulated x.
 * A refused lock (no user activation, an embedding that forbids it) changes
 * nothing: the drag carries on with the visible pointer.
 *
 * The field holds focus for the length of the drag. That is what makes this
 * work at all: the panel defers its rebuild while a field is focused
 * (isActiveEditFocus), so the label being dragged is not torn out from under
 * the pointer, and edit()'s burst stays open, so the whole drag is ONE undo
 * step. Blurring on release lets the deferred rebuild catch up. The release's
 * `change` says it ended a scrub (`endedScrub`), so a multi-selection can
 * apply the drag as a delta to each element instead of one value to all.
 */
export function scrub(handle: HTMLElement, input: HTMLInputElement) {
  handle.classList.add('ed-scrub')
  handle.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || input.disabled) return
    let cur = parseFloat(input.value) || 0
    let changed = false // a drag that never moved the value is no edit, and no undo step
    const step = parseFloat(input.step) || 1
    const x0 = ev.clientX
    let x = x0 // the drag's own x: the pointer's, or accumulated movement while locked
    let px = x0
    let last = x0 // where the value was last stepped from
    let moved = false
    const locked = () => document.pointerLockElement === handle
    const move = (e: PointerEvent) => {
      x += locked() ? e.movementX : e.clientX - px
      px = e.clientX
      if (!moved && Math.abs(x - x0) < 3) return
      if (!moved) {
        moved = true
        input.focus()
        document.body.classList.add('ed-scrubbing')
        try { void (handle.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}) } catch { /* refused: drag unlocked */ }
      }
      // Stepped from the LAST position, not the press: held at a limit, the
      // drag does not bank the overshoot, so turning back moves the value at
      // once instead of after a dead zone as long as the overshoot was.
      const steps = Math.trunc((x - last) / 2)
      if (!steps) return
      last += steps * 2
      const k = step * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1)
      const digits = Math.max(0, Math.ceil(-Math.log10(k) - 1e-9))
      cur = bound(input, cur + steps * k) // never past the field's own min/max
      const v = cur.toFixed(digits)
      cur = parseFloat(v) // no float drift across a long drag
      if (v === input.value) return
      input.value = v
      changed = true
      input.dispatchEvent(new Event(SCRUB))
    }
    // pointercancel (the OS took the pointer) ends the drag like a release:
    // the cursor class, the lock and the edit burst must not stick
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (locked()) document.exitPointerLock()
      if (!moved) return
      document.body.classList.remove('ed-scrubbing')
      if (changed) input.dispatchEvent(new CustomEvent('change', { detail: 'scrub' }))
      // The click that ends a drag is not a label click: it must not refocus
      // the field (focus would keep ⌘Z in the field's own text undo). Caught
      // on window, because a press on the label released over the field is
      // dispatched to their common ancestor, the <label>, not to the handle.
      const swallow = (c: Event) => c.preventDefault()
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, true), 0)
      input.blur()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  })
}

/** True for the `change` a scrub fires on release. */
export const endedScrub = (e: Event) => (e as CustomEvent).detail === 'scrub'

/**
 * Make an <input> a numeric field that takes arithmetic (numexpr.ts): a text
 * field, since a number field rejects `/` and `*` as typed, given back what
 * the number field gave for free — role spinbutton with its aria values, and
 * ↑/↓ stepping (Shift ×10, Alt ×0.1). `min`/`max`/`step` stay ordinary
 * attributes (they reflect on any input), so `bound()` and scrub read them as
 * before.
 *
 * The entry is evaluated in a CAPTURE listener, which at the target runs
 * before every ordinary `change` listener: those read a plain number in
 * `value` as they always did. Junk restores the last value and the change
 * goes no further. A relative entry (`+12`, `*2`) and a scrub leave their
 * delta in `dataset.rel` for a multi-selection to apply per element.
 */
export function numeric(input: HTMLInputElement, unit?: string): HTMLInputElement {
  input.type = 'text'
  input.inputMode = 'decimal'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.classList.add('ed-num')
  input.setAttribute('role', 'spinbutton')
  if (unit) input.dataset.unit = unit
  let prev = input.value
  const aria = () => {
    if (input.value !== '') input.setAttribute('aria-valuenow', input.value)
    else input.removeAttribute('aria-valuenow')
    for (const k of ['min', 'max'] as const) if (input[k] !== '') input.setAttribute(`aria-value${k}`, input[k])
  }
  aria()
  input.addEventListener('focus', () => { prev = input.value })
  input.addEventListener('change', (e) => {
    delete input.dataset.rel
    if (endedScrub(e)) { input.dataset.rel = String((parseFloat(input.value) || 0) - (parseFloat(prev) || 0)); prev = input.value; aria(); return }
    if (input.value.trim() === '') { prev = ''; aria(); return } // cleared: the field's own meaning (auto, unset)
    const r = evalNumber(input.value, parseFloat(prev) || 0)
    if (!r) { input.value = prev; e.stopImmediatePropagation(); return }
    const v = bound(input, r.v)
    input.value = String(Math.round(v * 1000) / 1000)
    if (r.rel !== undefined) input.dataset.rel = String(v - (parseFloat(prev) || 0))
    prev = input.value
    aria()
  }, true)
  input.addEventListener(SCRUB, aria)
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    e.stopPropagation() // the editor's arrows nudge the selection
    const k = (parseFloat(input.step) || 1) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1)
    const digits = Math.max(0, Math.ceil(-Math.log10(k) - 1e-9))
    const v = bound(input, (parseFloat(input.value) || 0) + (e.key === 'ArrowUp' ? k : -k))
    input.value = v.toFixed(digits).replace(/\.0+$/, '')
    input.dispatchEvent(new Event('change'))
  })
  return input
}

/**
 * One tab stop for a group of radios or tabs (roving tabindex): Tab lands on
 * the chosen one, the arrows (Home/End) move to and choose a neighbour, as the
 * WAI-ARIA radio-group and tabs patterns ask. Mirrored in RTL.
 */
export function roving(group: HTMLElement, role: 'radio' | 'tab') {
  const items = () => [...group.querySelectorAll<HTMLElement>(`:scope > [role=${role}]`)]
  const on = (b: HTMLElement) => b.getAttribute(role === 'radio' ? 'aria-checked' : 'aria-selected') === 'true'
  const stop = (to: HTMLElement) => { for (const b of items()) b.tabIndex = b === to ? 0 : -1 }
  const all = items()
  if (all.length) stop(all.find(on) ?? all[0])
  group.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(`[role=${role}]`)
    if (b && group.contains(b)) stop(b)
  })
  group.addEventListener('keydown', (e) => {
    const list = items()
    const i = list.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    const back = getComputedStyle(group).direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
    const k = e.key
    const j = k === 'Home' ? 0 : k === 'End' ? list.length - 1
      : k === back || k === 'ArrowUp' ? (i - 1 + list.length) % list.length
      : k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowDown' ? (i + 1) % list.length : -1
    if (j < 0) return
    e.preventDefault()
    e.stopPropagation() // the editor's own arrows nudge the selection
    stop(list[j])
    list[j].focus()
    list[j].click()
  })
}

/** A tab strip's selected pill, drawn once and SLID to the chosen tab
 *  (styles.css .ed-tabs-pill). It follows aria-selected, so the strip's own
 *  code stays as it is; until it can measure, the selected tab paints its own. */
export function slidingPill(bar: HTMLElement) {
  const place = () => {
    const on = bar.querySelector<HTMLElement>(':scope > [aria-selected="true"]')
    if (!on?.offsetWidth) return
    bar.style.setProperty('--pill-x', `${on.offsetLeft}px`)
    bar.style.setProperty('--pill-w', `${on.offsetWidth}px`)
    bar.classList.add('ed-tabs-pill')
  }
  new MutationObserver(place).observe(bar, { subtree: true, attributeFilter: ['aria-selected'] })
  new ResizeObserver(place).observe(bar)
}

/** An opacity % field as 0..1; empty or junk reads as opaque, 0 stays 0. */
export function alphaOf(input: HTMLInputElement): number {
  const raw = parseFloat(input.value)
  return Number.isFinite(raw) ? Math.min(Math.max(raw / 100, 0), 1) : 1
}

/** A value held to a numeric field's min and max, where it has them. */
export function bound(input: HTMLInputElement, v: number): number {
  const lo = input.min === '' ? -Infinity : parseFloat(input.min)
  const hi = input.max === '' ? Infinity : parseFloat(input.max)
  return Math.min(hi, Math.max(lo, v))
}

/** The scrub handle for a numeric field with no label of its own: its unit,
 *  or the word that names it, beside it. */
export function unitHandle(text: string, input: HTMLInputElement): HTMLElement {
  const s = document.createElement('span')
  s.className = 'ed-unit'
  s.textContent = text
  scrub(s, input)
  return s
}

/** Segmented options that read better as a glyph (keyed by option value). */
export const SEG_ICONS: Record<string, string> = {
  left: ICONS.alignLeft, center: ICONS.alignCenter, right: ICONS.alignRight,
  top: ICONS.valignTop, middle: ICONS.valignMiddle, bottom: ICONS.valignBottom,
}

export { parseColor, combineColor } from './colorvalue'

/** Aesthetic shadow presets offered in the panel (custom values stay 'custom'). */
export const SHADOW_PRESETS: Record<string, { x?: number; y?: number; blur: number; color: string }> = {
  subtle: { y: 2, blur: 10, color: 'rgba(10,16,28,0.25)' },
  soft: { y: 10, blur: 28, color: 'rgba(10,16,28,0.32)' },
  elevated: { y: 24, blur: 56, color: 'rgba(8,12,22,0.45)' },
  glow: { blur: 40, color: 'rgba(255,238,214,0.55)' },
}
