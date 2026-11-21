// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Figma's paint row: the field, then 👁 and − in a trailing column — one
// click hides a fill, stroke, shadow or blur (kept, not deleted), one click
// removes it. And the section's ⠿ catalog, the row's theme colours and tokens.
import type { PropsPanel } from '../panels'
import { ICONS } from '../../icons'
import { t } from '../../i18n'
import { colorPickers } from './color'

/** A paint row appended to the panel: [content] · 👁 · −. A missing eye or −
 *  leaves its cell empty, so the column lines up down every section. */
export function paintRow(p: PropsPanel, content: HTMLElement, eye?: { hidden: boolean; toggle: () => void }, remove?: () => void): HTMLElement {
  const row = document.createElement('div')
  row.className = 'ed-paintrow' + (eye?.hidden ? ' off' : '')
  row.append(content, eye ? eyeButton(eye.hidden, eye.toggle) : cell(), remove ? removeButton(remove) : cell())
  p.host.appendChild(row)
  return row
}

export function eyeButton(hidden: boolean, toggle: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-btn ed-btn-icon ed-paint-eye'
  b.innerHTML = hidden ? ICONS.eyeOff : ICONS.eye
  b.title = hidden ? t('Show') : t('Hide')
  b.setAttribute('aria-label', b.title)
  b.setAttribute('aria-pressed', String(hidden))
  b.addEventListener('click', toggle)
  return b
}

export function removeButton(run: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'ed-btn ed-btn-icon ed-paint-remove'
  b.innerHTML = ICONS.minus
  b.title = t('Remove')
  b.setAttribute('aria-label', b.title)
  b.addEventListener('click', run)
  return b
}

const cell = () => { const s = document.createElement('span'); s.className = 'ed-paint-cell'; return s }

/** A colour section's ⠿: the picker of the row that has focus, else the
 *  top row's. With no row yet (no fill), `add` makes one and the picker opens
 *  on it once the panel has rebuilt. */
export function colorCatalog(p: PropsPanel, add?: () => void) {
  const catalog = (anchor: HTMLElement, head: HTMLElement) => {
    const open = (h: HTMLElement) => {
      const body = h.nextElementSibling as HTMLElement | null
      const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.ed-colorref')
      const target = focused && body?.contains(focused) ? focused : body?.querySelector<HTMLElement>('.ed-colorref')
      const pick = target && colorPickers.get(target)
      if (pick) { pick(anchor.isConnected ? anchor : h.querySelector<HTMLElement>('.ed-sec-cat') ?? h); return true }
      return false
    }
    if (open(head) || !add) return
    const key = head.dataset.key
    add()
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const h = [...p.host.querySelectorAll<HTMLElement>('.ed-section')].find((x) => x.dataset.key === key)
      if (h) open(h)
    }))
  }
  // Tokens bind one colour per layer (fills.N.color). A gradient's paint is no
  // one colour, so a section of gradients alone has nothing here to bind: the
  // ⠿ says so instead of opening onto nothing. Its swatch's Tokens tab is the
  // way, turning the layer solid in the token's colour.
  catalog.unavailable = (head: HTMLElement) =>
    !add && !head.nextElementSibling?.querySelector('.ed-colorref')
      ? t('A gradient has no single colour to bind — its swatch’s Tokens tab makes it solid in a token’s colour')
      : null
  return catalog
}
