// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The token picker: one popover for binding any field to a token, the way
// Figma's variables picker and Penpot's tokens panel do it — a search box,
// the deck's theme colours first (for colour fields), then the deck's own
// tokens grouped by the dotted prefix of their names (color.brand.primary
// sits under "color.brand"), each row its preview, name and value, the bound
// one checked; the actions (make a token from this value, select everything
// using it, detach) are a list at the foot. Keyboard: type to filter, ↑ ↓ to
// move, Enter to pick, Esc to close; focus returns to the field.
import type { BentoDoc, TokenType } from '../../model'
import { PALETTE_SLOTS, paletteOf, slotIsSet, type PaletteSlot } from '../../palette'
import { activeMode, tokenValue } from '../../tokens'
import { cssColor } from '../../render'
import { slotLabel } from './controls'
import { t } from '../../i18n'

/** One thing a field can follow: a theme colour (palette slot) or a token. */
export interface Choice { kind: 'slot' | 'token'; key: string; label: string; group: string; type: TokenType; value: unknown }

/** What a field of these types can follow, theme colours first. */
export function choices(doc: BentoDoc, types: TokenType[]): Choice[] {
  const out: Choice[] = []
  if (types.includes('color')) {
    const palette = paletteOf(doc)
    for (const slot of PALETTE_SLOTS) {
      if (!palette[slot] || !slotIsSet(doc, slot)) continue
      out.push({ kind: 'slot', key: slot, label: slotLabel(slot), group: t('Theme'), type: 'color', value: palette[slot] })
    }
  }
  const set = doc.theme.tokens?.set ?? {}
  const names = Object.keys(set).filter((n) => types.includes(set[n].type)).sort()
  for (const name of names) {
    const dot = name.lastIndexOf('.')
    out.push({ kind: 'token', key: name, label: dot > 0 ? name.slice(dot + 1) : name, group: dot > 0 ? name.slice(0, dot) : t('Tokens'), type: set[name].type, value: tokenValue(doc, name) })
  }
  return out
}

/** A token's value as a picker or the Tokens view shows it. */
export function shownValue(type: TokenType, v: unknown): string {
  if (type === 'opacity' && typeof v === 'number') return `${Math.round(v * 100)}%`
  if (v && typeof v === 'object') { const s = v as { x?: number; y?: number; blur: number }; return `${s.x ?? 0} ${s.y ?? 0} ${s.blur}` }
  if (type === 'color' && typeof v === 'string') return v.replace(/^#/, '').toLowerCase()
  return String(v ?? '')
}

/** A small preview of a value: a swatch, "Aa" in a font or size, a faded or shadowed tile. */
export function preview(type: TokenType, v: unknown): HTMLElement {
  const s = document.createElement('span')
  s.className = `ed-tokpick-prev ed-tokpick-${type}`
  if (type === 'color') s.style.background = cssColor(String(v ?? ''), 'transparent')
  else if (type === 'fontFamily') { s.textContent = 'Aa'; s.style.fontFamily = String(v ?? '') }
  else if (type === 'fontSize') s.textContent = 'Aa'
  else if (type === 'opacity') s.style.opacity = String(v ?? 1)
  else if (type === 'shadow' && v && typeof v === 'object') { const sh = v as { x?: number; y?: number; blur: number; color: string }; s.style.boxShadow = `${sh.x ?? 0}px ${sh.y ?? 0}px ${sh.blur}px ${sh.color}` }
  else s.textContent = '#'
  return s
}

export interface PickerOpts {
  title: string
  choices: Choice[]
  /** the key the field follows now (a slot or a token name), checked */
  bound?: string
  pick: (c: Choice) => void
  actions: Array<{ label: string; run: () => void }>
}

/** Open the picker under `anchor`. */
export function openTokenPicker(anchor: HTMLElement, o: PickerOpts) {
  document.querySelector('.ed-tokpick')?.remove()
  const box = document.createElement('div')
  box.className = 'ed-morph-pick ed-tokpick'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-label', o.title)
  const filter = document.createElement('input')
  filter.type = 'search'
  filter.placeholder = t('Search tokens')
  filter.setAttribute('aria-label', t('Search tokens'))
  const list = document.createElement('div')
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', o.title)
  box.append(filter, list)

  const close = (refocus = true) => {
    box.remove()
    document.removeEventListener('pointerdown', outside, true)
    if (refocus && anchor.isConnected) anchor.focus()
  }
  const outside = (ev: PointerEvent) => { if (!box.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) close(false) }

  let group = ''
  for (const c of o.choices) {
    if (c.group !== group) {
      group = c.group
      const h = document.createElement('div')
      h.className = 'ed-morph-pick-h'
      h.textContent = group
      list.append(h)
    }
    const row = document.createElement('div')
    row.setAttribute('role', 'option')
    row.tabIndex = -1
    row.className = 'ed-morph-opt ed-tokpick-opt'
    row.dataset.key = c.key
    const on = c.key === o.bound
    row.setAttribute('aria-selected', String(on))
    const name = document.createElement('span')
    name.className = 'ed-tokpick-name'
    name.textContent = c.label
    name.title = c.kind === 'token' ? c.key : c.label
    const val = document.createElement('span')
    val.className = 'ed-tokpick-val'
    val.textContent = shownValue(c.type, c.value)
    const check = document.createElement('span')
    check.className = 'ed-tokpick-check'
    check.textContent = on ? '✓' : ''
    row.append(preview(c.type, c.value), name, val, check)
    row.addEventListener('click', () => { close(); o.pick(c) })
    list.append(row)
  }
  const none = document.createElement('div')
  none.className = 'ed-hint ed-tokpick-none'
  none.textContent = o.choices.length ? t('No tokens match') : t('No tokens yet — make one from this value below, or in the Tokens view')
  none.hidden = !!o.choices.length
  list.append(none)

  if (o.actions.length) {
    const foot = document.createElement('div')
    foot.className = 'ed-tokpick-foot'
    for (const a of o.actions) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ed-tokpick-act'
      b.textContent = a.label
      b.addEventListener('click', () => { close(); a.run() })
      foot.append(b)
    }
    box.append(foot)
  }

  const options = () => [...list.querySelectorAll<HTMLElement>('[role=option]')].filter((r) => !r.hidden)
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase()
    for (const r of list.querySelectorAll<HTMLElement>('[role=option]')) r.hidden = !!q && !`${r.dataset.key} ${r.textContent}`.toLowerCase().includes(q)
    // a group heading with nothing left under it goes too
    for (const h of list.querySelectorAll<HTMLElement>('.ed-morph-pick-h')) {
      let n = h.nextElementSibling, any = false
      while (n && !n.classList.contains('ed-morph-pick-h')) { if (n.getAttribute('role') === 'option' && !(n as HTMLElement).hidden) any = true; n = n.nextElementSibling }
      h.hidden = !any
    }
    none.hidden = options().length > 0
  })
  box.addEventListener('keydown', (ev) => {
    ev.stopPropagation() // the editor's own keys stay out of the picker
    if (ev.isComposing || ev.keyCode === 229) return
    const all = options()
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (ev.key === 'Escape') { ev.preventDefault(); close() }
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      const j = ev.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(i + 1, all.length - 1)) : (i <= 0 ? -1 : i - 1)
      ;(j < 0 ? filter : all[j])?.focus()
    } else if (ev.key === 'Enter') {
      ev.preventDefault()
      ;(i >= 0 ? all[i] : all[0])?.click()
    }
  })

  document.body.appendChild(box)
  const r = anchor.getBoundingClientRect()
  const w = box.offsetWidth, h = box.offsetHeight
  box.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`
  box.style.top = `${r.bottom + 6 + h < innerHeight ? r.bottom + 6 : Math.max(8, r.top - 6 - h)}px`
  document.addEventListener('pointerdown', outside, true)
  filter.focus()
  // open on the bound one, so the user sees where the field stands
  list.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
}

/** The palette slot a field follows, from its ref ('accent2', 'accent2 lighten 20'…). */
export const slotOf = (ref: string | undefined): PaletteSlot | undefined =>
  ref && !ref.startsWith('$') ? ref.split(' ')[0] as PaletteSlot : undefined
export { activeMode }
