// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Shadow and blur.
import type { PropsPanel } from '../panels'
import type { SlideElement } from '../../model'
import { SHADOW_PRESETS, optLabel, roving } from './controls'
import { section, mini, field } from './fields'
import { t } from '../../i18n'
import { ICONS } from '../../icons'
import { colorAlpha } from './color'

/** Shadow — added and removed from its header; a preset to start from,
 *  then the concrete values (per layer when stacked). */
export function buildShadow(p: PropsPanel, el: SlideElement) {
  const first = Object.keys(SHADOW_PRESETS)[0]
  section(p, t('Shadow'), el.shadow
    ? { add: false, hint: t('Remove shadow'), run: () => p.mutate(el.id, (e) => { delete e.shadow }, true) }
    : { add: true, hint: t('Add shadow'), run: () => p.mutate(el.id, (e) => { e.shadow = { ...SHADOW_PRESETS[first] } }, true) })
  if (!el.shadow) return
  // The presets as tiles: each one SHOWS its shadow, its name under it —
  // one click, all visible, where a dropdown of words hid what they meant.
  const current = Object.entries(SHADOW_PRESETS).find(([, p]) => JSON.stringify(p) === JSON.stringify(el.shadow))?.[0] ?? 'custom'
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
    b.addEventListener('click', () => { if (key !== current) p.mutate(el.id, (e) => { e.shadow = { ...SHADOW_PRESETS[key] } }, true) })
    tiles.appendChild(b)
  }
  roving(tiles, 'radio')
  p.host.appendChild(tiles)
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
      p.host.appendChild(cap)
    }
    const grid = document.createElement('div')
    grid.className = 'ed-grid3'
    grid.append(
      mini(t('X'), sh.x ?? 0, (v, fin) => setShadow(i, { x: v }, fin)),
      mini(t('Y'), sh.y ?? 0, (v, fin) => setShadow(i, { y: v }, fin)),
      mini(t('Blur'), sh.blur, (v, fin) => setShadow(i, { blur: Math.max(v, 0) }, fin), ICONS.blur, { min: 0 }),
    )
    p.host.appendChild(grid)
    field(p, colorAlpha(p, sh.color, (v, fin) => setShadow(i, { color: v }, fin)))
  })
}

/** Blur on the element and the frosted glass behind it — one optional layer. */
export function buildBlur(p: PropsPanel, el: SlideElement) {
  const on = !!(el.blur || el.backdropFilter)
  section(p, t('Blur'), on
    ? { add: false, hint: t('Remove blur'), run: () => p.mutate(el.id, (e) => { delete e.blur; delete e.backdropFilter }, true) }
    : { add: true, hint: t('Add blur'), run: () => p.mutate(el.id, (e) => { e.blur = 4 }, true) })
  if (!on) return
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
  p.host.appendChild(grid)
}
