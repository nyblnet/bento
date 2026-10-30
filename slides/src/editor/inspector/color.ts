// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Colour fields: the swatch + hex + opacity row, palette links, gradients.
import { segmented, mini, field } from './fields'
import { fillStyles, parseColor, unitHandle, slotLabel, combineColor, alphaOf, SCRUB, numeric } from './controls'
import { t } from '../../i18n'
import type { PropsPanel } from '../panels'
import { ICONS } from '../../icons'
import type { Slide } from '../../model'
import { setColor, paletteOf, refAt, PALETTE_SLOTS, slotIsSet } from '../../palette'
import { cssColor } from '../../render'
import { bindToken, tokenName, tokenValue } from '../../tokens'
import { openColorPopover } from './colorpopover'

/** Solid | Gradient, one click. */
export function fillKind(value: 'solid' | 'gradient', onChange: (v: string) => void): HTMLElement {
  const seg = segmented(['solid', 'gradient'], value, onChange, Object.fromEntries(fillStyles()))
  seg.setAttribute('aria-label', t('Fill style'))
  return seg
}

/** A gradient's angle and stops, shared by text and shapes. `edit` hands
 *  the live gradient to change. */
export function gradientRows(p: PropsPanel, grad: { angle: number; stops: Array<{ at: number; color: string }> }, edit: (fn: (g: typeof grad) => void, final: boolean) => void) {
  const angle = mini(t('Gradient angle'), grad.angle, (v, fin) => edit((g) => { g.angle = v }, fin), ICONS.rotate, { unit: '°' })
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'ed-btn ed-tool'
  add.innerHTML = ICONS.plus
  add.title = t('＋ Add stop').replace(/^＋\s*/, '')
  add.setAttribute('aria-label', add.title)
  add.addEventListener('click', () => edit((g) => {
    const mid = g.stops[Math.floor(g.stops.length / 2)]
    g.stops.push({ at: 0.5, color: mid?.color ?? '#808080' })
    g.stops.sort((a, b) => a.at - b.at)
  }, true))
  field(p, angle, add)
  grad.stops.forEach((stop, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'ed-gradstop'
    const at = mini('%', Math.round(stop.at * 100), (v, fin) =>
      edit((g) => { if (g.stops[i]) g.stops[i].at = Math.min(Math.max(v / 100, 0), 1) }, fin), undefined, { min: 0, max: 100 })
    at.title = t('Stop {n}', { n: i + 1 }) + ' · ' + t('Position %')
    at.querySelector('input')!.setAttribute('aria-label', at.title) // not '%'
    at.classList.add('ed-gradstop-at')
    const color = colorAlpha(p, stop.color, (v, fin) => edit((g) => { if (g.stops[i]) g.stops[i].color = v }, fin))
    wrap.append(at, color)
    if (grad.stops.length > 2) {
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'ed-btn ed-tool'
      del.innerHTML = ICONS.minus
      del.title = t('Remove stop')
      del.setAttribute('aria-label', t('Remove stop'))
      del.addEventListener('click', () => edit((g) => { if (g.stops.length > 2) g.stops.splice(i, 1) }, true))
      wrap.appendChild(del)
    }
    p.host.appendChild(wrap)
  })
}

  export function color(p: PropsPanel, value: string, onEdit: (v: string, final: boolean) => void, ref?: { id: string | null; path: string; slide?: Slide }): HTMLElement {
  const input = document.createElement('input')
  input.type = 'color'
  input.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : parseColor(value).hex
  input.addEventListener('input', () => onEdit(input.value, false))
  // A colour chosen by hand must CLEAR any palette reference on this path.
  // Without that, the next theme edit silently overwrites a colour somebody
  // picked deliberately — which reads as the app changing their work.
  // setRef writes the colour AND clears the reference in one edit: one undo step.
  input.addEventListener('change', () => {
    if (ref) setRef(p, ref, input.value, null)
    else onEdit(input.value, true)
  })
  const field = colorField(input)
  popoverOn(p, input)
  return ref ? themeLink(p, ref, input, field) : field
}

/**
 * The colour field as Penpot draws it: the swatch (the native picker), the
 * hex value to read and to type, and — when the colour has one — its
 * opacity, with '%' inside the field and scrubbable. Each part keeps THE
 * FIELD's own box (#729). A typed hex goes through the picker's own
 * 'change', so everything a picked colour does — the edit, clearing a
 * palette reference — a typed one does too.
 */
export function colorField(col: HTMLInputElement, alpha?: HTMLInputElement): HTMLElement {
  const box = document.createElement('div')
  box.className = 'ed-color'
  const hex = document.createElement('input')
  hex.type = 'text'
  hex.className = 'ed-color-hex'
  hex.spellcheck = false
  hex.maxLength = 7
  hex.setAttribute('aria-label', `${t('Color')} (hex)`)
  const show = () => { hex.value = col.value.slice(1) }
  show()
  col.addEventListener('input', show)
  hex.addEventListener('change', () => {
    const v = hex.value.trim().replace(/^#/, '')
    const full = /^[0-9a-f]{3}$/i.test(v) ? [...v].map((c) => c + c).join('') : v
    if (/^[0-9a-f]{6}$/i.test(full) && '#' + full.toLowerCase() !== col.value) {
      col.value = '#' + full.toLowerCase()
      col.dispatchEvent(new Event('input'))
      col.dispatchEvent(new Event('change'))
    }
    show()
  })
  box.append(col, hex)
  if (alpha) {
    const a = document.createElement('label')
    a.className = 'ed-mini ed-color-alpha'
    a.style.setProperty('--lab', '9px')
    a.append(unitHandle('%', alpha), alpha)
    box.append(a)
  }
  return box
}

/** Write a colour and its palette reference together, as one undoable edit. */
export function setRef(p: PropsPanel, ref: { id: string | null; path: string; slide?: Slide }, literal: string, token: string | null) {
  p.edit(() => {
    const holder = ref.id ? p.store.element(ref.id) : (ref.slide ?? p.store.slide)
    if (holder) setColor(holder as never, ref.path, literal, token)
  }, true)
}

/**
 * The deck's theme colours, Penpot's library way. A palette button at the
 * end of the colour field opens them, each swatch with its name; a colour
 * taken from there shows the NAME in the field instead of a hex (it follows
 * the theme now), with a button to detach it back to a plain colour.
 *
 * Choosing one records WHERE the colour came from, so editing the theme later
 * re-derives it — that is the whole difference between a deck that can be
 * re-branded and one that has 400 hex literals in it.
 */
export function themeLink(p: PropsPanel, ref: { id: string | null; path: string; slide?: Slide }, input: HTMLInputElement, field: HTMLElement): HTMLElement {
  const palette = paletteOf(p.store.doc)
  const holder = (ref.id ? p.store.element(ref.id) : (ref.slide ?? p.store.slide)) as never
  const rawRef = holder ? refAt(holder, ref.path) : undefined
  const tok = tokenName(rawRef)
  const linked = tok ? undefined : rawRef?.split(' ')[0] as (typeof PALETTE_SLOTS)[number] | undefined
  const linkedLabel = tok ?? (linked && slotLabel(linked))
  const outer = document.createElement('div')
  outer.className = 'ed-colorref'
  const list = document.createElement('div')
  list.className = 'ed-palette'
  list.hidden = true
  const cap = document.createElement('div')
  cap.className = 'ed-palette-cap'
  cap.textContent = t('Theme colors')
  list.appendChild(cap)
  for (const slot of PALETTE_SLOTS) {
    const base = palette[slot]
    if (!base) continue // hlink/folHlink are usually unset — don't show empties
    if (!slotIsSet(p.store.doc, slot)) continue // accent 2–6 unset: a copy of accent 1, not a choice
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-palette-item'
    const chip = document.createElement('span')
    chip.className = 'ed-swatch'
    chip.style.background = cssColor(base, 'transparent') // a document colour: gated
    const name = document.createElement('span')
    name.textContent = slotLabel(slot) // the slot's name, not its id (bg1, tx1…)
    b.append(chip, name)
    if (slot === linked) b.classList.add('is-on')
    b.addEventListener('click', () => {
      input.value = /^#[0-9a-fA-F]{6}$/.test(base) ? base : parseColor(base).hex
      // a theme colour names the hue; the field keeps its own opacity
      const a = field.querySelector<HTMLInputElement>('.ed-color-alpha input')
      setRef(p, ref, a ? combineColor(input.value, alphaOf(a)) : base, slot)
    })
    list.appendChild(b)
  }
  // the deck's colour tokens, under the theme slots: same gesture, a `$name` ref
  const colorTokens = Object.entries(p.store.doc.theme.tokens?.set ?? {}).filter(([, v]) => v.type === 'color')
  if (colorTokens.length) {
    const tcap = document.createElement('div')
    tcap.className = 'ed-palette-cap'
    tcap.textContent = t('Tokens')
    list.appendChild(tcap)
  }
  for (const [name] of colorTokens) {
    const value = String(tokenValue(p.store.doc, name) ?? '')
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-palette-item'
    const chip = document.createElement('span')
    chip.className = 'ed-swatch'
    chip.style.background = cssColor(value, 'transparent')
    const label = document.createElement('span')
    label.textContent = name
    b.append(chip, label)
    if (name === tok) b.classList.add('is-on')
    b.addEventListener('click', () => p.edit(() => {
      const h = ref.id ? p.store.element(ref.id) : (ref.slide ?? p.store.slide)
      if (h) bindToken(p.store.doc, h as never, ref.path, name)
    }, true))
    list.appendChild(b)
  }
  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'ed-btn ed-tool'
  open.innerHTML = ICONS.palette
  open.title = t('Theme colors')
  open.setAttribute('aria-label', t('Theme colors'))
  open.setAttribute('aria-expanded', 'false')
  open.addEventListener('click', () => {
    list.hidden = !list.hidden
    open.setAttribute('aria-expanded', String(!list.hidden))
  })
  if (linkedLabel) {
    const hex = field.querySelector<HTMLElement>('.ed-color-hex')
    const token = document.createElement('span')
    token.className = 'ed-color-token'
    token.textContent = linkedLabel
    token.title = tok
      ? t('Follows the token “{name}”. Click to detach.', { name: tok })
      : t('Follows the theme color “{name}”: change it under Theme and this changes with it.', { name: linkedLabel })
    const detach = document.createElement('button')
    detach.type = 'button'
    detach.className = 'ed-color-detach'
    detach.innerHTML = ICONS.unlink
    detach.title = t('Detach from the theme')
    detach.setAttribute('aria-label', t('Detach from the theme'))
    detach.addEventListener('click', () => {
      const a = field.querySelector<HTMLInputElement>('.ed-color-alpha input')
      setRef(p, ref, a ? combineColor(input.value, alphaOf(a)) : input.value, null)
    })
    token.appendChild(detach)
    hex?.replaceWith(token)
  }
  field.appendChild(open)
  outer.append(field, list)
  return outer
}

/** Color swatch + opacity %. Native color inputs have no alpha channel, so
 *  the pair round-trips rgba()/#rrggbbaa strings losslessly. */
export function colorAlpha(p: PropsPanel, value: string, onEdit: (v: string, final: boolean) => void, ref?: { id: string | null; path: string; slide?: Slide }): HTMLElement {
  const parsed = parseColor(value)
  const col = document.createElement('input')
  col.type = 'color'
  col.value = parsed.hex
  const alpha = document.createElement('input')
  alpha.min = '0'
  alpha.max = '100'
  alpha.step = '1'
  alpha.value = String(Math.round(parsed.a * 100))
  numeric(alpha, '%')
  alpha.title = t('Opacity %')
  alpha.setAttribute('aria-label', alpha.title) // the wrapping label's '%' would name it otherwise
  const emit = (final: boolean) => onEdit(combineColor(col.value, alphaOf(alpha)), final)
  col.addEventListener('input', () => emit(false))
  // picking by hand clears the palette reference — see color() for why — in
  // the same edit as the colour. The opacity % keeps the reference: a
  // reference names the hue, and the theme re-derives it with this alpha kept.
  col.addEventListener('change', () => {
    if (ref) setRef(p, ref, combineColor(col.value, alphaOf(alpha)), null)
    else emit(true)
  })
  alpha.addEventListener('change', () => emit(true))
  alpha.addEventListener(SCRUB, () => emit(false))
  const wrap = colorField(col, alpha)
  popoverOn(p, col, alpha)
  return ref ? themeLink(p, ref, col, wrap) : wrap
}

/**
 * The swatch opens the colour popover instead of the browser's picker. The
 * popover drives the same <input type=color> (and % field) the inline row
 * does, so it takes every path a typed hex takes: live preview, the palette
 * reference cleared by a hand-picked colour, one undo step. Esc undoes the
 * preview burst, so a cancelled pick leaves no step and no change.
 */
function popoverOn(p: PropsPanel, col: HTMLInputElement, alpha?: HTMLInputElement) {
  const swatch = () => {
    const a = alpha ? alphaOf(alpha) : 1
    col.classList.toggle('ed-see-through', a < 1)
    col.style.setProperty('--see', combineColor(col.value, a))
  }
  swatch()
  col.addEventListener('input', swatch)
  alpha?.addEventListener('change', swatch)
  alpha?.addEventListener(SCRUB, swatch)
  col.addEventListener('click', (e) => {
    e.preventDefault() // never the native picker
    const set = (hex: string, a: number) => {
      col.value = hex
      if (alpha) alpha.value = String(Math.round(a * 100))
      col.dispatchEvent(new Event('input'))
    }
    const theme = [...col.closest('.ed-colorref')?.querySelectorAll<HTMLButtonElement>('.ed-palette-item') ?? []]
    openColorPopover(col, {
      hex: col.value,
      alpha: alpha ? alphaOf(alpha) : undefined,
      groups: [
        { title: t('Theme colors'), swatches: theme.map((b) => ({ label: b.textContent ?? '', color: b.querySelector<HTMLElement>('.ed-swatch')?.style.background ?? '', pick: () => b.click() })) },
        { title: t('On this slide'), swatches: slideColors(p).map((c) => ({ label: c, color: cssColor(c, 'transparent'), pick: () => { const v = parseColor(c); set(v.hex, v.a); col.dispatchEvent(new Event('change')) } })) },
      ],
      preview: set,
      commit: () => col.dispatchEvent(new Event('change')),
      cancel: () => { if (p.burst) { p.burst = false; p.store.undo() } },
    })
  })
}

/** The distinct colours the current slide already uses, for one-click reuse. */
function slideColors(p: PropsPanel): string[] {
  const out = new Map<string, string>()
  const add = (v: unknown) => {
    if (typeof v !== 'string' || !v || v === 'none' || v === 'transparent' || v.includes('gradient')) return
    const c = parseColor(v)
    if (c.a > 0) out.set(combineColor(c.hex, c.a), combineColor(c.hex, c.a))
  }
  const slide = p.store.slide
  add(slide.background)
  for (const el of slide.elements) for (const k of ['fill', 'color', 'stroke'] as const) add((el as unknown as Record<string, unknown>)[k])
  return [...out.values()].slice(0, 16)
}
