// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Animate and Interact: entrances, steps, morph pairing, links, states.
import type { PropsPanel } from '../panels'
import { type SlideElement, morphKey, type TextElement, isWebUrl, uid, paginates } from '../../model'
import { section, row, labeledSelect, number, select } from './fields'
import { t } from '../../i18n'
import { UNPAIR, roving } from './controls'
import { endPreview, previewEnter } from '../fxpreview'
import type { StepPatch } from '../reveal'
import { stepOf } from '../../steps'
import { morphSource } from '../morph'

/**
 * Morph section. The morph key is `morphId ?? id`: by default an element
 * morphs with same-id elements on adjacent slides (the duplicate-a-slide
 * idiom), but setting a `morphId` re-targets the pairing WITHOUT mutating
 * `id` (which stays the stable identity used by selection, connectors,
 * comments and the CRDT). The text field edits the key directly; the picker
 * adopts another slide element's key. Writing the element's own id clears
 * the override.
 */
export function buildMorphProps(p: PropsPanel, el: SlideElement) {
  section(p, t('Morph'))
  const effective = morphKey(el)

  const warn = document.createElement('p')
  warn.className = 'ed-hint ed-morph-warn'
  warn.style.display = 'none'

  const input = document.createElement('input')
  input.type = 'text'
  input.value = effective
  input.spellcheck = false
  input.addEventListener('change', () => {
    const err = setMorphId(p, el, input.value)
    if (err) { warn.textContent = err; warn.style.display = ''; input.value = effective }
  })
  row(p, 'Morph name', input)

  const targets = morphTargets(p, el)
  // `|| el.morphId`: a paired element with no OTHER slide to pair with still
  // needs the picker — otherwise there is nowhere to unpair from.
  if (targets.length || el.morphId) {
    const sel = document.createElement('select')
    const none = document.createElement('option')
    none.value = ''
    none.textContent = t('(pick an element)')
    sel.appendChild(none)
    // Clearing an override had no affordance: the documented way is to retype
    // the element's own id into the field above, which means knowing what it
    // was (issue #54). Offer it as a choice instead.
    if (el.morphId) {
      const un = document.createElement('option')
      un.value = UNPAIR
      un.textContent = t('Don’t pair — use its own name')
      sel.appendChild(un)
    }
    for (const tgt of targets) {
      const o = document.createElement('option')
      o.value = tgt.key
      o.textContent = tgt.label
      if (tgt.key === effective) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => {
      if (!sel.value) return
      // writing the element's OWN id is what clears the override
      const err = setMorphId(p, el, sel.value === UNPAIR ? el.id : sel.value)
      if (err) { warn.textContent = err; warn.style.display = '' }
    })
    row(p, 'Morph with', sel)
  }

  p.host.appendChild(warn)

  // Scrub through the morph on the canvas — from the slide before (0%) to this
  // one (100%). Nothing is written; letting go puts the slide back.
  if (morphSource(p.store.doc, p.store.slide)) {
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '0'
    range.max = '100'
    range.value = '100'
    range.className = 'ed-morph-preview'
    range.setAttribute('aria-label', t('Morph preview'))
    range.addEventListener('input', () => p.onMorphPreview?.(Number(range.value) / 100))
    const restore = () => { range.value = '100'; p.onMorphPreview?.(null) }
    range.addEventListener('pointerup', restore)
    range.addEventListener('blur', restore)
    row(p, 'Preview', range)
  }

  const hint = document.createElement('p')
  // an override in force is STATE, and stays in view; otherwise it is help
  hint.className = el.morphId ? 'ed-hint ed-status' : 'ed-hint'
  hint.innerHTML = el.morphId
    ? t('Morphs as <code>{id}</code> instead of its own name, <code>{own}</code>. Choose “Don’t pair” below to undo.', { id: effective, own: el.id })
    : t('Elements with the same morph name morph into each other between slides. Rename it, or pick below, to pair it with an element on another slide.')
  p.host.appendChild(hint)
}

/** Set or clear an element's morph-key override. Writing the element's own
 *  id clears it. Returns an inline error message, or null on success. */
export function setMorphId(p: PropsPanel, el: SlideElement, raw: string): string | null {
  const clean = raw.trim().replace(/[^A-Za-z0-9._-]/g, '')
  if (!clean) return t('Morph name can’t be empty.')
  const next = clean === el.id ? undefined : clean
  const effective = next ?? el.id
  const clash = p.store.slide.elements.some(
    (e) => e.id !== el.id && morphKey(e) === effective)
  if (clash) return t('Another element on this slide already uses that morph name.')
  p.mutate(el.id, (e) => {
    if (next === undefined) delete e.morphId
    else e.morphId = next
  }, true)
  return null
}

/** Distinct morph keys present on OTHER slides, each with a readable label,
 *  for the "Pair with" picker. Skips keys that already sit on this slide
 *  (they'd collide) and our own default key. */
export function morphTargets(p: PropsPanel, el: SlideElement): Array<{ key: string; label: string }> {
  const here = new Set(
    p.store.slide.elements.filter((e) => e.id !== el.id).map(morphKey))
  const seen = new Map<string, string>()
  p.store.doc.slides.forEach((s, i) => {
    if (s.id === p.store.slide.id) return
    for (const e of s.elements) {
      const key = morphKey(e)
      if (key === el.id || here.has(key) || seen.has(key)) continue
      seen.set(key, `${t('Slide')} ${i + 1} · ${morphElDesc(e)}`)
    }
  })
  return [...seen].map(([key, label]) => ({ key, label }))
}

/** Short human label for an element in the morph picker. */
export function morphElDesc(e: SlideElement): string {
  if (e.type === 'text') {
    const txt = (e as TextElement).html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    if (txt) return `"${txt.slice(0, 24)}"`
  }
  // Capitalize to hit the existing insert-menu catalog keys (Text/Image/…).
  return t(e.type.charAt(0).toUpperCase() + e.type.slice(1))
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

  // labelled by where the element comes FROM: slide-left starts on the right
  // and travels left (present.ts enterSpec)
  // pills, not a dropdown: every choice visible, and pointing at one plays
  // it on the canvas (fxpreview.ts) before it is chosen
  type Enter = NonNullable<NonNullable<typeof el.fx>['enter']>
  const ENTERS: Array<[Enter | 'none', string]> = [['none', t('None')], ['fade', t('Fade')], ['fade-up', t('Fade up')], ['fade-down', t('Fade down')],
    ['slide-left', t('Fly in from right')], ['slide-right', t('Fly in from left')],
    ['slide-up', t('Fly in from below')], ['slide-down', t('Fly in from above')]]
  const pills = document.createElement('div')
  pills.className = 'ed-fx-pills'
  pills.setAttribute('role', 'radiogroup')
  for (const [v, label] of ENTERS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', String(v === (el.fx?.enter ?? 'none')))
    b.textContent = label
    b.addEventListener('click', () => {
      endPreview()
      setFx(v === 'none' ? { enter: undefined, enterDur: undefined } : { enter: v })
    })
    if (v !== 'none') {
      b.addEventListener('pointerenter', () => previewEnter(el, v))
      b.addEventListener('focus', () => previewEnter(el, v))
    }
    b.addEventListener('pointerleave', endPreview)
    b.addEventListener('blur', endPreview)
    pills.appendChild(b)
  }
  roving(pills, 'radio')
  const enterRow = document.createElement('div')
  enterRow.className = 'ed-row ed-row-pills'
  enterRow.setAttribute('role', 'group')
  const cap = document.createElement('span')
  cap.textContent = t('Entrance')
  cap.id = `ed-enter-${el.id}`
  enterRow.setAttribute('aria-labelledby', cap.id)
  pills.setAttribute('aria-labelledby', cap.id)
  enterRow.append(cap, pills)
  p.host.appendChild(enterRow)
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
  row(p, 'Count up numbers', select(
    ['off', 'on'], el.fx?.countUp ? 'on' : 'off',
    (v) => setFx({ countUp: v === 'on' ? true : undefined })))
  if (el.type === 'code') row(p, 'Typewriter', select(
    ['off', 'on'], el.fx?.typeWriter ? 'on' : 'off',
    (v) => setFx({ typeWriter: v === 'on' ? true : undefined })))
  row(p, 'Pan & zoom', labeledSelect(
    [['none', t('None')], ['kenburns', t('Ken Burns')]], el.fx?.ambient ?? 'none',
    (v) => setFx(v === 'none' ? { ambient: undefined, ken: undefined } : { ambient: 'kenburns' })))
  if (el.fx?.ambient === 'kenburns') {
    const ken = el.fx.ken ?? {}
    const dir = ken.dir ?? 'drift'
    const setKen = (patch: Partial<NonNullable<NonNullable<SlideElement['fx']>['ken']>>) =>
      setFx({ ken: { ...ken, ...patch } })
    row(p, 'Motion', labeledSelect(
      [['drift', t('Drift')], ['zoom-out', t('Zoom out')], ['zoom-in', t('Zoom in')]],
      dir === 'out' ? 'zoom-out' : dir === 'in' ? 'zoom-in' : 'drift',
      (v) => {
        const d = v === 'zoom-out' ? 'out' : v === 'zoom-in' ? 'in' : 'drift'
        // give each style its natural pace when switching
        setFx({ ken: d === 'drift' ? undefined : { dir: d, scale: 1.06, duration: 2.5 } })
      }))
    row(p, 'Zoom amount %', number(
      Math.round(((ken.scale ?? (dir === 'drift' ? 1.1 : 1.06)) - 1) * 100), 1,
      (v, fin) => { if (fin) setKen({ scale: 1 + Math.min(Math.max(v, 0), 100) / 100 }) }, { min: 0, max: 100 }))
    row(p, 'Pan & zoom (s)', number(
      ken.duration ?? (dir === 'drift' ? 26 : 2.5), 0.1,
      (v, fin) => { if (fin) setKen({ duration: Math.max(v, 0.1) }) }, { min: 0.1 }))
  }

  // continuous loop animation
  const loop = el.fx?.loop
  row(p, 'Loop animation', labeledSelect(
    [['none', t('None')], ['dash-march', t('Marching dashes')], ['motion-path', t('Follow a path')]],
    loop?.type ?? 'none',
    (v) => setFx({
      loop: v === 'none' ? undefined
        : v === 'dash-march' ? { type: 'dash-march', distance: 18, duration: (loop as any)?.duration ?? 1.4 }
        : { type: 'motion-path', path: (loop as any)?.path ?? 'M 0 0 L 100 0', duration: (loop as any)?.duration ?? 3 },
    })))
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
      row(p, 'Lap speed', labeledSelect(
        [['none', t('Constant')], ['sine.inOut', t('Ease in-out')], ['power2.in', t('Ease in')], ['power2.out', t('Ease out')]],
        (loop as { ease?: string }).ease ?? 'none',
        (v) => p.mutate(el.id, (e) => {
          const lp = e.fx?.loop
          if (lp?.type !== 'motion-path') return
          if (v === 'none') delete lp.ease; else lp.ease = v
        }, true)))

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
