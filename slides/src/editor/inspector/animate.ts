// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Animate and Interact: entrances, steps, morph pairing, links, states.
import type { PropsPanel } from '../panels'
import { type Slide, type SlideElement, morphKey, isWebUrl, uid, paginates } from '../../model'
import { section, row, number, toggle, segmented } from './fields'
import { ICONS } from '../../icons'
import { t } from '../../i18n'
import { UNPAIR } from './controls'
import { endPreview, previewEnter } from '../fxpreview'
import type { StepPatch } from '../reveal'
import { stepOf } from '../../steps'
import { morphPartners, morphSource, walkSource, wouldPair } from '../morph'
import { labelFor } from '../layerrows'

/**
 * Morph section. The morph key is `morphId ?? id`: by default an element
 * morphs with same-id elements on adjacent slides (the duplicate-a-slide
 * idiom), but setting a `morphId` re-targets the pairing WITHOUT mutating
 * `id` (which stays the stable identity used by selection, connectors,
 * comments and the CRDT).
 *
 * One truth for "will this morph": the status line, the checkbox, the layer
 * badge and the canvas ghost all read morph.ts morphPartners — a partner on
 * the slide the show arrives from, AND this slide's transition is Morph. A
 * pair that would exist under Morph but not under this slide's transition is
 * said so, with the one click that fixes it. Machine ids are never shown.
 */
export function buildMorphProps(p: PropsPanel, el: SlideElement) {
  section(p, t('Morph'))
  const doc = p.store.doc
  const slide = p.store.slide
  const from = morphPartners(doc, slide).get(el.id)
  const would = from ? undefined : wouldPair(doc, slide).get(el.id)
  const src = walkSource(doc, slide)

  const warn = document.createElement('p')
  warn.className = 'ed-hint ed-morph-warn'
  warn.setAttribute('role', 'alert')
  warn.style.display = 'none'
  const say = (err: string | null) => { warn.textContent = err ?? ''; warn.style.display = err ? '' : 'none' }

  // the state, first: what this element does when the slide arrives
  const status = document.createElement('p')
  status.className = 'ed-hint ed-status ed-morph-status'
  if (from && src) status.textContent = t('Pairs with: {what}', { what: pairLabel(p, src, from) })
  else if (would && src) {
    status.textContent = t('Pairs with {what}, but this slide uses {transition} — it will not morph.', {
      what: pairLabel(p, src, would), transition: transitionName(slide.transition) })
    const use = document.createElement('button')
    use.type = 'button'
    use.className = 'ed-btn ed-morph-use'
    use.textContent = t('Use Morph')
    use.addEventListener('click', () => p.store.commit(() => { slide.transition = 'morph' }))
    status.append(' ', use)
  } else if (src) status.textContent = t('Not paired — it enters with its own entrance.')
  else status.textContent = t('Nothing comes before this slide, so nothing morphs into it.')
  p.host.appendChild(status)

  // a text pair moves and resizes, but its words swap at once (present.ts)
  if (from?.type === 'text' && el.type === 'text' && from.html !== el.html) {
    const note = document.createElement('p')
    note.className = 'ed-hint ed-status'
    note.textContent = t('Text changes at once; position and size morph.')
    p.host.appendChild(note)
  }

  if (src) {
    row(p, 'Morph from the slide before', toggle(!!from, (on) => {
      say(on ? linkPrevious(p, el, src) : unlinkPrevious(p, el, src))
    }))
  }

  // the name: an override the author typed, never a machine id
  const input = document.createElement('input')
  input.type = 'text'
  input.spellcheck = false
  input.value = el.morphId && !/-solo\d*$/.test(el.morphId) ? el.morphId : ''
  input.placeholder = t('Automatic')
  input.addEventListener('change', () => {
    const err = renameMorph(p, el, input.value)
    say(err)
    if (err) input.value = el.morphId ?? ''
    else input.value = cleanKey(input.value)
  })
  row(p, 'Morph name', input)

  const pick = document.createElement('button')
  pick.type = 'button'
  pick.className = 'ed-btn ed-morph-pick-btn'
  pick.setAttribute('aria-haspopup', 'listbox')
  // a select-like chip: the choice ellipsed on one line, a chevron at the end
  const chosen = document.createElement('span')
  chosen.className = 'ed-morph-pick-txt'
  chosen.textContent = from && src ? pairLabel(p, src, from) : t('Choose an element…')
  pick.title = chosen.textContent
  pick.append(chosen)
  pick.insertAdjacentHTML('beforeend', ICONS.chevron)
  pick.addEventListener('click', () => openMorphPicker(p, el, pick, say))
  row(p, 'Morph with', pick)

  p.host.appendChild(warn)

  // Scrub through the morph on the canvas — from the slide before (0%) to this
  // one (100%), the whole slide. Nothing is written; leaving puts it back.
  if (morphSource(doc, slide)) {
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '0'
    range.max = '100'
    range.value = '100'
    range.className = 'ed-morph-preview'
    range.setAttribute('aria-label', t('Morph preview'))
    range.addEventListener('input', () => p.onMorphPreview?.(Number(range.value) / 100))
    range.addEventListener('blur', () => { range.value = '100'; p.onMorphPreview?.(null) })
    row(p, 'Preview', range)
  }
  if (src) {
    const play = document.createElement('button')
    play.type = 'button'
    play.className = 'ed-btn ed-morph-play'
    play.textContent = t('▶ Play transition')
    play.title = t('Present from the slide before and step into this one')
    play.addEventListener('click', () => p.onPlayTransition?.())
    p.host.appendChild(play)
  }
}

/** "Slide 2 · Revenue card" — the page, then the element as Layers names it. */
function pairLabel(p: PropsPanel, s: Slide, e: SlideElement): string {
  return `${slideLabel(p, s, p.store.doc.slides.indexOf(s))} · ${labelFor(e, t)}`
}

function transitionName(tr: string): string {
  return t(({ none: 'None', fade: 'Fade', push: 'Push', zoom: 'Zoom', morph: 'Morph' } as Record<string, string>)[tr] ?? tr)
}

/** What a typed morph name is stored as: letters, digits and . _ - only. */
const cleanKey = (raw: string) => raw.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '')

/**
 * The pairing picker: the slide before's elements first (those nothing on
 * this slide already pairs with), each by its Layers name with a colour or
 * text hint, then every other slide behind a fold; type to filter, arrows to
 * move, Enter to choose, Esc to go back. Replaces a native select that grew
 * to every element of the deck under labels like "Slide 1 · Shape".
 */
function openMorphPicker(p: PropsPanel, el: SlideElement, anchor: HTMLElement, say: (err: string | null) => void) {
  document.querySelector('.ed-morph-pick')?.remove()
  const doc = p.store.doc
  const slide = p.store.slide
  const src = walkSource(doc, slide)
  const here = new Set(slide.elements.filter((e) => e.id !== el.id).map(morphKey))
  const box = document.createElement('div')
  box.className = 'ed-morph-pick ed-pop'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-label', t('Morph with'))
  const filter = document.createElement('input')
  filter.type = 'search'
  filter.placeholder = t('Find an element')
  filter.setAttribute('aria-label', t('Find an element'))
  const list = document.createElement('div')
  list.setAttribute('role', 'listbox')
  box.append(filter, list)

  const close = (refocus = true) => {
    box.remove()
    document.removeEventListener('pointerdown', outside, true)
    if (refocus) anchor.focus()
  }
  const outside = (ev: PointerEvent) => { if (!box.contains(ev.target as Node) && ev.target !== anchor) close(false) }
  const choose = (key: string) => {
    close()
    say(setMorphId(p, el, key))
    // the commit rebuilt the panel: focus the picker that replaced this one
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.ed-props .ed-morph-pick-btn')?.focus())
  }
  const option = (label: string, key: string, hint?: SlideElement) => {
    const o = document.createElement('div')
    o.setAttribute('role', 'option')
    o.tabIndex = -1
    o.className = 'ed-morph-opt'
    o.dataset.key = key
    if (hint) o.append(hintOf(hint))
    o.append(label)
    o.addEventListener('click', () => choose(key))
    return o
  }
  if (el.morphId) list.append(option(t('Don’t pair — use its own name'), UNPAIR))
  const pairable = (e: SlideElement) => !here.has(morphKey(e)) && morphKey(e) !== morphKey(el)
  if (src) {
    const h = document.createElement('div')
    h.className = 'ed-morph-pick-h'
    h.textContent = slideLabel(p, src, doc.slides.indexOf(src))
    list.append(h)
    const mine = src.elements.filter(pairable)
    for (const e of mine) list.append(option(labelFor(e, t, src), morphKey(e), e))
    if (!mine.length) { const n = document.createElement('div'); n.className = 'ed-hint'; n.textContent = t('Everything there is already paired.'); list.append(n) }
  }
  const more = document.createElement('details')
  more.className = 'ed-morph-pick-more'
  const sum = document.createElement('summary')
  sum.textContent = t('Other slides')
  more.append(sum)
  const seen = new Set<string>()
  doc.slides.forEach((s, i) => {
    if (s === slide || s === src) return
    for (const e of s.elements) {
      const key = morphKey(e)
      if (!pairable(e) || seen.has(key) || key === el.id) continue
      seen.add(key)
      more.append(option(`${slideLabel(p, s, i)} · ${labelFor(e, t, s)}`, key, e))
    }
  })
  if (seen.size) list.append(more)

  const options = () => [...list.querySelectorAll<HTMLElement>('[role=option]')].filter((o) => !o.hidden && (o.closest('details')?.open ?? true))
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase()
    if (q) more.open = true
    for (const o of list.querySelectorAll<HTMLElement>('[role=option]')) o.hidden = !!q && !o.textContent!.toLowerCase().includes(q)
  })
  box.addEventListener('keydown', (ev) => {
    const all = options()
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close() }
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault(); ev.stopPropagation()
      const n = ev.key === 'ArrowDown' ? Math.min(i + 1, all.length - 1) : i - 1
      if (n < 0) filter.focus(); else all[n]?.focus()
    } else if ((ev.key === 'Enter' || ev.key === ' ') && i >= 0) { ev.preventDefault(); ev.stopPropagation(); all[i].click() }
    else if (ev.key === 'Enter' && document.activeElement === filter) { ev.preventDefault(); ev.stopPropagation(); all[0]?.click() }
    else ev.stopPropagation() // typing in the filter is not a tool key
  })

  document.body.appendChild(box)
  const r = anchor.getBoundingClientRect()
  box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - box.offsetWidth - 8))}px`
  box.style.top = `${Math.max(8, Math.min(r.bottom + 4, window.innerHeight - box.offsetHeight - 8))}px`
  setTimeout(() => document.addEventListener('pointerdown', outside, true))
  filter.focus()
}

/** A fill swatch for a shape, the first words for text, nothing otherwise. */
function hintOf(e: SlideElement): HTMLElement {
  const h = document.createElement('span')
  h.className = 'ed-morph-hint'
  h.setAttribute('aria-hidden', 'true')
  const fill = e.type === 'shape' ? e.fill : e.type === 'text' ? e.color : ''
  if (fill) h.style.background = fill
  return h
}

/**
 * Pair `el` with its best match on `prev`: the same name, else the same type
 * nearest in place and size. Keys already used on this slide are skipped.
 * Ticking "Morph from the slide before" means morph: a slide that did not
 * morph is switched to Morph in the same step.
 */
export function linkPrevious(p: PropsPanel, el: SlideElement, prev: Slide): string | null {
  const here = new Set(p.store.slide.elements.filter((e) => e.id !== el.id).map(morphKey))
  const free = prev.elements.filter((e) => !here.has(morphKey(e)))
  const cost = (e: SlideElement) => (e.type === el.type ? 0 : 1e6)
    + Math.hypot(e.x + e.w / 2 - el.x - el.w / 2, e.y + e.h / 2 - el.y - el.h / 2) + Math.abs(e.w - el.w) + Math.abs(e.h - el.h)
  const already = prev.elements.find((e) => morphKey(e) === morphKey(el))
  const best = already ?? (el.name && free.find((e) => e.name === el.name && e.type === el.type))
    ?? [...free].sort((a, b) => cost(a) - cost(b))[0]
  return best ? setMorphId(p, el, morphKey(best), true) : t('Nothing on the slide before to pair with.')
}

/** Stop `el` morphing from `prev`: clear an override, or — when its own id is what pairs it — give it a name of its own. */
export function unlinkPrevious(p: PropsPanel, el: SlideElement, prev: Slide): string | null {
  const ownPairs = prev.elements.some((e) => morphKey(e) === el.id)
  if (el.morphId && !ownPairs) return setMorphId(p, el, el.id)
  let name = `${el.id}-solo`
  for (let i = 2; [...prev.elements, ...p.store.slide.elements].some((e) => morphKey(e) === name); i++) name = `${el.id}-solo${i}`
  return setMorphId(p, el, name)
}

/** The element on `s` (other than `skip`) already using `key`, by its Layers name. */
function holder(s: Slide, key: string, skip: Set<string>): SlideElement | undefined {
  return s.elements.find((e) => !skip.has(e.id) && morphKey(e) === key)
}

/** Set or clear an element's morph-key override (writing its own id clears
 *  it). `andMorph` also switches the slide to the Morph transition, in the
 *  same undo step. Returns an inline error, or null on success. */
export function setMorphId(p: PropsPanel, el: SlideElement, raw: string, andMorph = false): string | null {
  const clean = raw === UNPAIR ? el.id : cleanKey(raw)
  if (!clean) return t('Morph name can’t be empty.')
  const clash = holder(p.store.slide, clean, new Set([el.id]))
  if (clash) return t('“{name}” on this slide already uses that morph name.', { name: labelFor(clash, t) })
  const slide = p.store.slide
  p.store.commit(() => {
    const e = slide.elements.find((x) => x.id === el.id)
    if (!e) return
    if (clean === e.id) delete e.morphId
    else e.morphId = clean
    if (andMorph) slide.transition = 'morph'
  })
  return null
}

/**
 * Rename a morph name the way an author means it: the element and whatever
 * it pairs with on the neighbouring slides (the slide it arrives from, and the
 * slides that arrive from it) take the new name together, in one undo step —
 * renaming one side alone silently ended the pair. A name another element on
 * any of those slides already uses is refused, naming that element.
 */
export function renameMorph(p: PropsPanel, el: SlideElement, raw: string): string | null {
  const doc = p.store.doc
  const slide = p.store.slide
  const next = raw.trim() ? cleanKey(raw) : el.id
  if (!next) return t('Morph name can’t be empty.')
  const old = morphKey(el)
  if (next === old) return null
  const prev = walkSource(doc, slide)
  const neighbours = [prev, ...doc.slides.filter((s) => s !== slide && walkSource(doc, s) === slide)].filter((s): s is Slide => !!s)
  const moving = [{ s: slide, e: el }]
  for (const s of neighbours) for (const e of s.elements) if (morphKey(e) === old) moving.push({ s, e })
  const ids = new Set(moving.map((m) => m.e.id))
  for (const s of [slide, ...neighbours]) {
    const c = holder(s, next, ids)
    if (c) return s === slide
      ? t('“{name}” on this slide already uses that morph name.', { name: labelFor(c, t) })
      : t('“{name}” on {slide} already uses that morph name — it would pair with that instead.', { name: labelFor(c, t), slide: slideLabel(p, s, doc.slides.indexOf(s)) })
  }
  p.store.commit(() => {
    for (const { s, e } of moving) {
      const live = s.elements.find((x) => x.id === e.id)
      if (!live) continue
      if (next === live.id) delete live.morphId
      else live.morphId = next
    }
  })
  return null
}

/** fx + link — how the element behaves while presenting. */
export function buildPresentingProps(p: PropsPanel, el: SlideElement) {
  section(p, t('Animation'))
  const setFx = (patch: Partial<NonNullable<SlideElement['fx']>>) =>
    p.mutate(el.id, (e) => {
      const fx = { ...(e.fx ?? {}), ...patch }
      if (!fx.enter && !fx.countUp && !fx.ambient && !fx.loop && !fx.step && !fx.typeWriter) delete e.fx
      else e.fx = fx
    }, true)

  // An effect (None · Fade · Fly) and, for an effect that moves, the way it
  // travels. The arrows point the way the element MOVES: slide-left starts on
  // the right and travels left (present.ts enterSpec), so its tooltip says
  // where it comes from. Pointing at a choice plays it on the canvas
  // (fxpreview.ts) before it is chosen.
  type Enter = NonNullable<NonNullable<typeof el.fx>['enter']>
  const enter = el.fx?.enter
  const effect = !enter ? 'none' : enter.startsWith('slide-') ? 'fly' : 'fade'
  const DIRS: Record<'fade' | 'fly', Array<[string, Enter, string]>> = {
    fade: [['none', 'fade', 'Fade'], ['up', 'fade-up', 'Fade up'], ['down', 'fade-down', 'Fade down']],
    fly: [['left', 'slide-left', 'Fly in from right'], ['right', 'slide-right', 'Fly in from left'],
      ['up', 'slide-up', 'Fly in from below'], ['down', 'slide-down', 'Fly in from above']],
  }
  const choose = (v: Enter | 'none') => {
    endPreview()
    setFx(v === 'none' ? { enter: undefined, enterDur: undefined } : { enter: v })
  }
  // keep the direction across a change of effect where both have it
  const dirOf = (v: Enter | undefined) => v?.endsWith('-up') ? 'up' : v?.endsWith('-down') ? 'down' : v?.endsWith('-left') ? 'left' : v?.endsWith('-right') ? 'right' : 'none'
  const firstFor = (fx: 'fade' | 'fly'): Enter =>
    (DIRS[fx].find(([d]) => d === dirOf(enter)) ?? DIRS[fx][fx === 'fly' ? 2 : 0])[1]
  const fxPick = segmented(['none', 'fade', 'fly'], effect, (v) => choose(v === 'none' ? 'none' : firstFor(v as 'fade' | 'fly')),
    { none: t('None'), fade: t('Fade'), fly: t('Fly in') }, { none: ICONS.fxNone, fade: ICONS.fxFade, fly: ICONS.fxFly })
  const preview = (b: Element, v: Enter) => {
    b.addEventListener('pointerenter', () => previewEnter(el, v))
    b.addEventListener('focus', () => previewEnter(el, v))
    b.addEventListener('pointerleave', endPreview)
    b.addEventListener('blur', endPreview)
  }
  const fxButtons = fxPick.querySelectorAll('button')
  preview(fxButtons[1], firstFor('fade'))
  preview(fxButtons[2], firstFor('fly'))
  row(p, 'Entrance', fxPick)
  if (effect !== 'none') {
    const dirs = DIRS[effect]
    const ICON: Record<string, string> = { none: ICONS.dirNone, up: ICONS.dirUp, down: ICONS.dirDown, left: ICONS.dirLeft, right: ICONS.dirRight }
    const pad = segmented(dirs.map(([d]) => d), dirOf(enter), (d) => choose(dirs.find(([x]) => x === d)![1]),
      Object.fromEntries(dirs.map(([d, , label]) => [d, t(label)])), Object.fromEntries(dirs.map(([d]) => [d, ICON[d]])))
    pad.querySelectorAll('button').forEach((b, k) => preview(b, dirs[k][1]))
    row(p, 'Direction', pad)
  }
  if (el.fx?.enter) {
    // per-kind default (slide-* 0.75s, fade-* 0.55s); lower = snappier
    row(p, 'Entrance (s)', number(
      el.fx.enterDur ?? (el.fx.enter.startsWith('slide-') ? 0.75 : 0.55), 0.05,
      (v, fin) => { if (fin) setFx({ enterDur: Math.max(v, 0.05) }) }, { min: 0.05 }))
  }
  // "Animate on click": hidden until the n-th → on this slide (0 = with the
  // slide). The element's Enter plays when its step comes, or a plain fade.
  // The verbs come first (one click, no number to think about); the number
  // row underneath is the precise control, and the canvas badge cycles it.
  revealRow(p, [el])
  row(p, 'Appears on click', number(el.fx?.step ?? 0, 1,
    (v, fin) => { if (fin) setFx({ step: v >= 1 ? Math.floor(v) : undefined }) }))
  if (el.fx?.step) {
    const hint = document.createElement('p')
    hint.className = 'ed-hint'
    hint.textContent = t('Hidden until that press of → while presenting; ← hides it again. Give several elements the same step to reveal them together.')
    p.host.appendChild(hint)
  }
  // counting up only means something where there is a number to count
  if (el.fx?.countUp || hasNumber(el)) row(p, 'Count up numbers', toggle(!!el.fx?.countUp,
    (on) => setFx({ countUp: on ? true : undefined })))
  if (el.type === 'code') row(p, 'Typewriter', toggle(!!el.fx?.typeWriter,
    (on) => setFx({ typeWriter: on ? true : undefined })))
  row(p, 'Pan & zoom', toggle(el.fx?.ambient === 'kenburns',
    (on) => setFx(on ? { ambient: 'kenburns' } : { ambient: undefined, ken: undefined })))
  if (el.fx?.ambient === 'kenburns') {
    const ken = el.fx.ken ?? {}
    const dir = ken.dir ?? 'drift'
    const setKen = (patch: Partial<NonNullable<NonNullable<SlideElement['fx']>['ken']>>) =>
      setFx({ ken: { ...ken, ...patch } })
    row(p, 'Motion', segmented(['drift', 'zoom-out', 'zoom-in'],
      dir === 'out' ? 'zoom-out' : dir === 'in' ? 'zoom-in' : 'drift',
      (v) => {
        const d = v === 'zoom-out' ? 'out' : v === 'zoom-in' ? 'in' : 'drift'
        // give each style its natural pace when switching
        setFx({ ken: d === 'drift' ? undefined : { dir: d, scale: 1.06, duration: 2.5 } })
      }, { drift: t('Drift'), 'zoom-out': t('Zoom out'), 'zoom-in': t('Zoom in') },
      { drift: ICONS.kenDrift, 'zoom-out': ICONS.kenOut, 'zoom-in': ICONS.kenIn }))
    row(p, 'Zoom amount %', number(
      Math.round(((ken.scale ?? (dir === 'drift' ? 1.1 : 1.06)) - 1) * 100), 1,
      (v, fin) => { if (fin) setKen({ scale: 1 + Math.min(Math.max(v, 0), 100) / 100 }) }, { min: 0, max: 100 }))
    row(p, 'Pan & zoom (s)', number(
      ken.duration ?? (dir === 'drift' ? 26 : 2.5), 0.1,
      (v, fin) => { if (fin) setKen({ duration: Math.max(v, 0.1) }) }, { min: 0.1 }))
  }

  // continuous loop animation
  const loop = el.fx?.loop
  row(p, 'Loop animation', segmented(['none', 'dash-march', 'motion-path'],
    loop?.type ?? 'none',
    (v) => setFx({
      loop: v === 'none' ? undefined
        : v === 'dash-march' ? { type: 'dash-march', distance: 18, duration: (loop as any)?.duration ?? 1.4 }
        : { type: 'motion-path', path: (loop as any)?.path ?? 'M 0 0 L 100 0', duration: (loop as any)?.duration ?? 3 },
    }), { none: t('None'), 'dash-march': t('Marching dashes'), 'motion-path': t('Follow a path') },
    { none: ICONS.fxNone, 'dash-march': ICONS.lineDashed, 'motion-path': ICONS.curve }))
  if (loop) {
    row(p, 'Seconds per lap', number(loop.duration ?? 2, 0.1, (v, fin) =>
      p.mutate(el.id, (e) => { if (e.fx?.loop) e.fx.loop.duration = Math.max(v, 0.1) }, fin), { min: 0.1 }))
    if (loop.type === 'motion-path') {
      const path = document.createElement('input')
      path.type = 'text'
      path.value = loop.path
      path.title = t('SVG path the element travels along, relative to its position')
      path.addEventListener('change', () =>
        p.mutate(el.id, (e) => { if (e.fx?.loop?.type === 'motion-path') e.fx.loop.path = path.value }, true))
      row(p, 'Motion path', path)

      // lap easing — the tempo of a whole lap (per-anchor speed is edited on canvas)
      row(p, 'Lap speed', segmented(['none', 'sine.inOut', 'power2.in', 'power2.out'],
        (loop as { ease?: string }).ease ?? 'none',
        (v) => p.mutate(el.id, (e) => {
          const lp = e.fx?.loop
          if (lp?.type !== 'motion-path') return
          if (v === 'none') delete lp.ease; else lp.ease = v
        }, true),
        { none: t('Constant'), 'sine.inOut': t('Ease in-out'), 'power2.in': t('Ease in'), 'power2.out': t('Ease out') },
        { none: ICONS.easeLinear, 'sine.inOut': ICONS.easeInOut, 'power2.in': ICONS.easeIn, 'power2.out': ICONS.easeOut }))

      const editPath = document.createElement('button')
      editPath.className = 'ed-btn ed-btn-block'
      editPath.textContent = t('✎ Edit path on canvas')
      editPath.title = t('Drag points to reshape · double-click to add/remove · scroll a point to change its speed')
      editPath.addEventListener('click', () =>
        document.dispatchEvent(new CustomEvent('bento:edit-path', { detail: { id: el.id } })))
      p.host.appendChild(editPath)
      const speedHint = document.createElement('p')
      speedHint.className = 'ed-hint'
      speedHint.textContent = t('Tip: on the canvas, scroll a point to make the element dwell there or rush past it.')
      p.host.appendChild(speedHint)
    }
  }

  // What the element DOES in the show, as opposed to how it moves: its own
  // section, on the Interact tab.
  section(p, t('Interactivity'))

  // hover-reveal set membership
  const soh = document.createElement('input')
  soh.type = 'text'
  soh.placeholder = t('always visible')
  soh.value = el.showOnHover ?? ''
  soh.addEventListener('change', () => {
    p.mutate(el.id, (e) => {
      if (soh.value) e.showOnHover = soh.value
      else delete e.showOnHover
    }, true)
    // follow the element into its new set so it stays visible/editable
    p.store.hoverPreview = soh.value || null
    p.store.emit('current')
  })
  row(p, 'Show on hover of', soh)

  // group tag (hover focus & interaction targeting)
  const group = document.createElement('input')
  group.type = 'text'
  group.placeholder = t('None')
  group.value = el.group ?? ''
  group.addEventListener('change', () =>
    p.mutate(el.id, (e) => {
      if (group.value) e.group = group.value
      else delete e.group
    }, true))
  row(p, 'Hover group', group)

  // link → slide picker
  const sel = document.createElement('select')
  const none = document.createElement('option')
  none.value = ''
  none.textContent = t('None')
  sel.appendChild(none)
  p.store.doc.slides.forEach((s, i) => {
    const o = document.createElement('option')
    o.value = s.id
    o.textContent = slideLabel(p, s, i)
    if (el.link === s.id) o.selected = true
    sel.appendChild(o)
  })
  if (isWebUrl(el.link)) {
    const web = document.createElement('option')
    web.value = el.link
    web.textContent = t('web page (below)')
    web.selected = true
    sel.appendChild(web)
  }
  sel.addEventListener('change', () =>
    p.mutate(el.id, (e) => {
      if (sel.value) e.link = sel.value
      else delete e.link
    }, true))
  row(p, 'Link to', sel)
  // Or a web page: opens in a new tab while presenting (discussion #373).
  const url = document.createElement('input')
  url.type = 'url'
  url.placeholder = 'https://…'
  url.value = isWebUrl(el.link) ? el.link : ''
  url.addEventListener('change', () => {
    const v = url.value.trim()
    if (v && !isWebUrl(v)) {
      p.toast(t('That doesn’t look like a web address — it should start with https://'))
      url.value = isWebUrl(el.link) ? el.link : ''
      return
    }
    p.mutate(el.id, (e) => {
      if (v) e.link = v
      else if (isWebUrl(e.link)) delete e.link
    }, true)
  })
  row(p, 'Web link', url)

  // one-click interactivity: duplicate this slide as a hidden state
  // (element ids preserved ⇒ it morphs) and link this element to it
  const makeState = document.createElement('button')
  makeState.className = 'ed-btn ed-btn-block'
  makeState.textContent = t('＋ Link to a new variant of this slide')
  makeState.title = t('Copies this slide as a variant and links this element to it: while presenting, clicking the element opens the copy. Edit the copy to show what changes.')
  makeState.addEventListener('click', () => createLinkedState(p, el))
  p.host.appendChild(makeState)
}

/**
 * Re-sync an interactive state with its parent: parent elements missing
 * here (added since the state was created) come in, ordering follows the
 * parent, and this state's own versions of shared elements — its whole
 * point — stay untouched. Elements unique to this state stay on top.
 */
export function syncStateFromParent(p: PropsPanel) {
  const state = p.store.slide
  const parent = p.store.doc.slides.find((s) => s.id === state.stateOf)
  if (!parent) return
  const own = new Map(state.elements.map((e) => [e.id, e]))
  // sync only makes sense for states that share lineage with the parent —
  // otherwise "merging" would just stack two full copies of everything
  const shared = parent.elements.filter((pe) => own.has(pe.id)).length
  if (state.elements.length && !shared) {
    p.toast(t('This variant shares no elements with its main slide — nothing to update.'))
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
  p.store.commit(() => {
    p.store.slide.elements = [...merged, ...extras]
  })
  p.store.select([])
  // numbers rather than hand-made plurals, which no catalog can follow
  p.toast(t('Updated from the main slide — new: {added} · only in this variant: {kept}', { added, kept: extras.length }))
}

/** Duplicate the current slide as a hidden state and link `el` to it. */
export function createLinkedState(p: PropsPanel, el: SlideElement) {
  const src = p.store.slide
  const clone = JSON.parse(JSON.stringify(src)) as typeof src
  clone.id = uid('slide')
  clone.stateOf = src.stateOf ?? src.id // states of a state share one parent
  clone.name = `${src.name ?? t('variant')} ${p.store.doc.slides.filter((s) => s.stateOf === clone.stateOf).length + 2}`
  clone.transition = 'morph'
  delete (clone as any).hover // inherit nothing implicit; user can re-enable
  if (src.hover) clone.hover = { ...src.hover }
  // insert right after the parent and its existing states, keeping the
  // family together in the slide list
  const parentIdx = p.store.doc.slides.findIndex((s) => s.id === clone.stateOf)
  let insertAt = parentIdx + 1
  while (p.store.doc.slides[insertAt]?.stateOf === clone.stateOf) insertAt++
  p.store.commit(() => {
    p.store.doc.slides.splice(insertAt, 0, clone)
    const live = p.store.element(el.id)
    if (live) live.link = clone.id
  }, 'slides')
  p.store.goTo(insertAt)
}

/**
 * Human label for a slide in pickers — the number the SIDEBAR shows, so an
 * author who reads "4" there finds "Slide 4" here. That is the page number
 * (`paginates`), not the position: an unnumbered or hidden slide shows the
 * number it continues, marked, so two entries can share a number without
 * being confused for each other.
 */
export function slideLabel(p: PropsPanel, s: { id: string; name?: string; stateOf?: string; hidden?: boolean; unnumbered?: boolean }, i: number): string {
  const doc = p.store.doc
  const pageAt = (idx: number) => doc.slides.slice(0, idx + 1).filter((x) => paginates(x, doc)).length
  if (s.stateOf) {
    const p = doc.slides.findIndex((x) => x.id === s.stateOf)
    return `${t('Variant of slide {n}', { n: pageAt(p) })}${s.name ? ` — ${s.name}` : ''}`
  }
  const mark = s.hidden ? ` (${t('hidden')})` : s.unnumbered ? ` (${t('unnumbered')})` : ''
  return `${t('Slide {n}', { n: pageAt(i) })}${mark}${s.name ? ` — ${s.name}` : ''}`
}

export function applySteps(p: PropsPanel, patches: StepPatch[]) {
  if (!patches.length) return
  p.edit(() => {
    for (const { id, step } of patches) {
      const el = p.store.element(id)
      if (!el) continue
      const fx = { ...(el.fx ?? {}), step: step > 0 ? step : undefined }
      if (!fx.enter && !fx.countUp && !fx.ambient && !fx.loop && !fx.step && !fx.typeWriter) delete el.fx
      else el.fx = fx
    }
  }, true)
}

/** The three reveal verbs as a captioned button row (multi panel + Presenting). */
export function revealRow(p: PropsPanel, els: SlideElement[]) {
  const stepped = els.some((e) => stepOf(e) > 0)
  const row = document.createElement('div')
  row.className = 'ed-reveal-row'
  const cap = document.createElement('span')
  cap.className = 'ed-arrange-cap'
  cap.textContent = t('Reveal')
  row.appendChild(cap)
  const btn = (label: string, title: string, run: () => void, enabled = true) => {
    const b = document.createElement('button')
    b.className = 'ed-btn'
    b.textContent = label
    b.title = title
    b.disabled = !enabled
    b.addEventListener('click', run)
    row.appendChild(b)
  }
  btn(t('In order'), t('Hide until → is pressed, one after another in reading order — top to bottom, then left to right'), () => p.revealInOrder(els))
  btn(t('Together'), t('Hide until → is pressed, all at once'), () => p.revealTogether(els))
  btn(t('Remove'), t('Show with the slide again'), () => p.removeReveal(els), stepped)
  p.host.appendChild(row)
  const hint = document.createElement('p')
  hint.className = 'ed-hint'
  hint.textContent = t('Numbered badges on the canvas show the order; click one for the next step.')
  p.host.appendChild(hint)
}

/** A number in the element's text, the thing Count up animates. */
function hasNumber(el: SlideElement): boolean {
  const text = el.type === 'text' ? el.html : el.type === 'code' ? (el as { code?: string }).code : undefined
  return !!text && /\d/.test(text.replace(/<[^>]*>/g, ''))
}
