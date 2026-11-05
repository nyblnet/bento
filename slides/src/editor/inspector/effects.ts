// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Shadow and blur.
import { tokenWrap, tokenPicker } from './tokenbind'
import { paintRow } from './paintrow'
import { tokenName } from '../../tokens'
import type { PropsPanel } from '../panels'
import type { SlideElement } from '../../model'
import { SHADOW_PRESETS, optLabel, roving } from './controls'
import { section, mini } from './fields'
import { t } from '../../i18n'
import { ICONS } from '../../icons'
import { colorAlpha } from './color'
import { endPreview, previewShadow } from '../fxpreview'

/** Shadow — added and removed from its header; a preset to start from,
 *  then the concrete values (per layer when stacked). */
export function buildShadow(p: PropsPanel, el: SlideElement) {
  const first = Object.keys(SHADOW_PRESETS)[0]
  // Figma's Effects row: ⠿ (shadow tokens) and + on the header; the shadow a
  // row — its chip opens the editor, 👁 hides it (kept), − removes it
  section(p, t('Shadow'), el.shadow ? undefined
    : { add: true, hint: t('Add shadow'), run: () => { openFx.add(`${el.id}:shadow`); p.mutate(el.id, (e) => { e.shadow = { ...SHADOW_PRESETS[first] }; delete e.shadowHidden }, true) } },
  (anchor) => tokenPicker(p, el, 'shadow', ['shadow'])(anchor))
  if (!el.shadow) return
  const current = Object.entries(SHADOW_PRESETS).find(([, p]) => JSON.stringify(p) === JSON.stringify(el.shadow))?.[0] ?? 'custom'
  const sh0 = Array.isArray(el.shadow) ? el.shadow[0] : el.shadow
  const bound = tokenName(el.themeRefs?.shadow)
  const editor = effectChip(p, `${el.id}:shadow`, bound ?? (current === 'custom' ? t('Drop shadow') : `${t('Drop shadow')} · ${optLabel(current)}`),
    (sw) => { sw.style.boxShadow = `${(sh0.x ?? 0) / 4}px ${(sh0.y ?? 0) / 4}px ${sh0.blur / 4}px ${sh0.color}` },
    { hidden: !!el.shadowHidden, toggle: () => p.mutate(el.id, (e) => { if (e.shadowHidden) delete e.shadowHidden; else e.shadowHidden = true }, true) },
    () => p.mutate(el.id, (e) => { delete e.shadow; delete e.shadowHidden; delete e.themeRefs?.shadow }, true),
    // the chip's arrows step through the presets, as the tiles' do
    (by) => {
      const keys = Object.keys(SHADOW_PRESETS), i = keys.indexOf(current)
      const key = keys[i < 0 ? (by > 0 ? 0 : keys.length - 1) : (i + by + keys.length) % keys.length]
      p.mutate(el.id, (e) => { e.shadow = { ...SHADOW_PRESETS[key] } }, true)
    })
  if (!editor) return
  // The presets as tiles: each one SHOWS its shadow, its name under it —
  // one click, all visible, where a dropdown of words hid what they meant.
  const tiles = document.createElement('div')
  tiles.className = 'ed-shadow-tiles'
  tiles.setAttribute('role', 'radiogroup')
  tiles.setAttribute('aria-label', t('Shadow'))
  for (const [key, sh] of Object.entries(SHADOW_PRESETS)) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-shadow-tile'
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', String(key === current))
    const swatch = document.createElement('span')
    swatch.className = 'ed-shadow-swatch'
    // the preset drawn at a quarter of its size, so all four fit a tile
    swatch.style.boxShadow = `${(sh.x ?? 0) / 4}px ${(sh.y ?? 0) / 4}px ${sh.blur / 4}px ${sh.color}`
    const name = document.createElement('span')
    name.textContent = optLabel(key)
    b.append(swatch, name)
    b.addEventListener('click', () => { endPreview(); if (key !== current) p.mutate(el.id, (e) => { e.shadow = { ...SHADOW_PRESETS[key] } }, true) })
    // pointing at a preset shows it on the element; nothing is written
    b.addEventListener('pointerenter', () => previewShadow(el, p.store.doc, SHADOW_PRESETS[key]))
    b.addEventListener('pointerleave', endPreview)
    tiles.appendChild(b)
  }
  roving(tiles, 'radio')
  // a bound shadow says so on its pill; binding itself is the header's ⠿
  editor.appendChild(bound ? tokenWrap(p, tiles, el, 'shadow', ['shadow']) : tiles)
  // editing any value turns a preset into 'custom' on the next rebuild
  const shadows = Array.isArray(el.shadow) ? el.shadow : [el.shadow]
  const setShadow = (i: number, patch: Record<string, unknown>, fin = true) =>
    p.mutate(el.id, (e) => {
      const arr = Array.isArray(e.shadow) ? [...e.shadow] : e.shadow ? [e.shadow] : []
      arr[i] = { ...arr[i], ...patch }
      e.shadow = Array.isArray(e.shadow) ? arr : arr[0]
    }, fin)
  shadows.forEach((sh, i) => {
    if (shadows.length > 1) {
      const cap = document.createElement('div')
      cap.className = 'ed-shadow-cap'
      cap.textContent = t('Shadow {n}', { n: i + 1 })
      editor.appendChild(cap)
    }
    const grid = document.createElement('div')
    grid.className = 'ed-grid3'
    grid.append(
      mini(t('X'), sh.x ?? 0, (v, fin) => setShadow(i, { x: v }, fin)),
      mini(t('Y'), sh.y ?? 0, (v, fin) => setShadow(i, { y: v }, fin)),
      mini(t('Blur'), sh.blur, (v, fin) => setShadow(i, { blur: Math.max(v, 0) }, fin), ICONS.blur, { min: 0 }),
    )
    editor.appendChild(grid)
    const color = colorAlpha(p, sh.color, (v, fin) => setShadow(i, { color: v }, fin))
    color.classList.add('ed-line')
    editor.appendChild(color)
  })
}

/** Which effect rows have their editor open — kept across rebuilds. */
const openFx = new Set<string>()

/**
 * An effect as Figma lists it: a chip (a preview and its name) that opens
 * the effect's settings under the row, then 👁 and −. Returns the settings
 * box to fill, or null while it is closed.
 */
function effectChip(p: PropsPanel, key: string, label: string, paint: (swatch: HTMLElement) => void, eye: { hidden: boolean; toggle: () => void }, remove: () => void, step?: (by: 1 | -1) => void): HTMLElement | null {
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'ed-btn ed-effect-chip'
  const sw = document.createElement('span')
  sw.className = 'ed-effect-swatch'
  paint(sw)
  const name = document.createElement('span')
  name.className = 'ed-effect-name'
  name.textContent = label
  chip.append(sw, name)
  const open = openFx.has(key)
  chip.setAttribute('aria-expanded', String(open))
  chip.title = t('Edit {what}', { what: label })
  chip.addEventListener('click', () => {
    if (openFx.has(key)) openFx.delete(key)
    else openFx.add(key)
    p.rebuild(true)
  })
  if (step) chip.dataset.arrows = '' // controls.ts ownsArrows
  if (step) chip.addEventListener('keydown', (e) => {
    const back = getComputedStyle(chip).direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft'
    const by = e.key === back || e.key === 'ArrowUp' ? -1 : e.key.startsWith('Arrow') ? 1 : 0
    if (!by) return
    e.preventDefault()
    e.stopPropagation() // the step rebuilds the panel: the chip is gone before the editor's guard could see it
    step(by)
  })
  paintRow(p, chip, eye, remove)
  if (!open) return null
  const box = document.createElement('div')
  box.className = 'ed-effect-editor'
  p.host.appendChild(box)
  return box
}

/** Blur on the element and the frosted glass behind it — one optional layer. */
export function buildBlur(p: PropsPanel, el: SlideElement) {
  const on = !!(el.blur || el.backdropFilter)
  section(p, t('Blur'), on ? undefined
    : { add: true, hint: t('Add blur'), run: () => { openFx.add(`${el.id}:blur`); p.mutate(el.id, (e) => { e.blur = 4; delete e.blurHidden }, true) } },
  (anchor) => tokenPicker(p, el, 'blur', ['number'])(anchor))
  if (!on) return
  const label = [el.blur ? `${t('Layer blur')} · ${el.blur}` : '', el.backdropFilter ? `${t('Blur behind')} · ${el.backdropFilter}` : ''].filter(Boolean).join(' · ')
  const editor = effectChip(p, `${el.id}:blur`, label, (sw) => { sw.innerHTML = ICONS.blur },
    { hidden: !!el.blurHidden, toggle: () => p.mutate(el.id, (e) => { if (e.blurHidden) delete e.blurHidden; else e.blurHidden = true }, true) },
    () => p.mutate(el.id, (e) => { delete e.blur; delete e.backdropFilter; delete e.blurHidden }, true))
  if (!editor) return
  const grid = document.createElement('div')
  grid.className = 'ed-grid2'
  grid.append(
    mini(t('Blur'), el.blur ?? 0, (v, fin) => p.mutate(el.id, (e) => {
      if (v > 0) e.blur = v
      else delete e.blur
    }, fin), undefined, { min: 0 }),
    mini(t('Behind'), el.backdropFilter ?? 0, (v, fin) => p.mutate(el.id, (e) => {
      if (v > 0) e.backdropFilter = v
      else delete e.backdropFilter
    }, fin), undefined, { min: 0 }),
  )
  grid.lastElementChild!.setAttribute('title', t('Blur behind'))
  editor.appendChild(grid)
}
