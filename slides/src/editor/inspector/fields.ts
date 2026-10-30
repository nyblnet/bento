// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The inspector's row and field builders: every control is made here, so every control looks and behaves alike.
import { PropsPanel } from '../panels'
import { ICONS } from '../../icons'
import { lsJson, lsSet } from '../../../../kernel/src/storage.ts'
import { t } from '../../i18n'
import { ROW_TIPS, scrub, bound, SCRUB, optLabel, SEG_ICONS, roving, numeric } from './controls'

/** Native <select> with distinct value/label pairs (for model-word values). */
export function labeledSelect(pairs: Array<[string, string]>, value: string, onChange: (v: string) => void): HTMLSelectElement {
  const sel = document.createElement('select')
  for (const [v, label] of pairs) {
    const o = document.createElement('option')
    o.value = v; o.textContent = label
    if (v === value) o.selected = true
    sel.appendChild(o)
  }
  sel.addEventListener('change', () => onChange(sel.value))
  return sel
}

/** A section header. `action` puts Penpot's + or − on the header line: an
 *  optional property (stroke, shadow, blur) is added from its header and
 *  removed from it, instead of a 'none' in a dropdown. */
export function section(p: PropsPanel, title: string, action?: { add: boolean; hint: string; run: () => void }) {
  const h = document.createElement('h3')
  h.className = 'ed-section'
  h.dataset.key = title
  h.textContent = title
  if (action) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-sec-act'
    b.innerHTML = action.add ? ICONS.plus : ICONS.minus
    b.title = action.hint
    b.setAttribute('aria-label', action.hint)
    b.addEventListener('click', (ev) => {
      ev.stopPropagation()
      // what was just added is shown: open the section in the store applyAccordion reads
      if (action.add) {
        const state = lsJson<Record<string, boolean>>('bento-panel-open', {})
        state[title] = true
        lsSet('bento-panel-open', JSON.stringify(state))
      }
      action.run()
    })
    h.appendChild(b)
    if (action.add) h.classList.add('ed-sec-empty')
  }
  p.host.appendChild(h)
}

/** A control with no caption of its own — its section's title says what it is. */
export function field(p: PropsPanel, ...controls: HTMLElement[]): HTMLElement {
  const line = document.createElement('div')
  line.className = 'ed-line'
  line.append(...controls)
  p.host.appendChild(line)
  return line
}

export function row(p: PropsPanel, label: string, input: HTMLElement): HTMLElement {
  // A segmented control is a group of buttons, and a <label> hands a click on
  // its caption to the first of them: clicking the word "Align" would align
  // left. A colour field's first control is the native picker: a click on
  // "Background" would open it. Those rows are a div, named by aria instead.
  const plain = input.classList.contains('ed-seg') || !!input.querySelector('input[type=color]')
  const row = document.createElement(plain ? 'div' : 'label')
  row.className = 'ed-row'
  const span = document.createElement('span')
  span.textContent = t(label)
  if (plain) {
    span.id = `ed-row-${++PropsPanel.rowIds}`
    if (input.getAttribute('role') === 'radiogroup') input.setAttribute('aria-labelledby', span.id)
    else { row.setAttribute('role', 'group'); row.setAttribute('aria-labelledby', span.id) }
  }
  // real help on hover (label + control): looked up by the RAW English label;
  // rows without an entry get no tooltip — never a useless label echo
  const tip = ROW_TIPS[label]
  if (tip && !input.title) row.title = t(tip)
  if (input instanceof HTMLInputElement && input.classList.contains('ed-num')) scrub(span, input)
  row.append(span, input)
  p.host.appendChild(row)
  return row
}

/** A numeric field with its label inside it, Penpot's way. `icon` draws an
 *  icon there instead and makes the label the hint. */
export function mini(label: string, value: number, onChange: (v: number, final: boolean) => void, icon?: string, range?: { min?: number; max?: number; unit?: string }): HTMLElement {
  const wrap = document.createElement('label')
  wrap.className = 'ed-mini'
  const span = document.createElement('span')
  if (icon) {
    span.innerHTML = icon
    span.className = 'ed-mini-icon'
    wrap.title = label
    span.setAttribute('aria-label', label)
    wrap.style.setProperty('--lab', '13px')
  } else {
    span.textContent = label
    // the label sits inside the field (styles.css .ed-mini): pad the value past it
    const m = (PropsPanel.measure ??= document.createElement('canvas').getContext('2d')!)
    m.font = '11px system-ui, sans-serif'
    wrap.style.setProperty('--lab', `${Math.ceil(m.measureText(label).width)}px`)
  }
  const input = document.createElement('input')
  input.setAttribute('aria-label', label) // the label/hint; a unit-labelled caller names it properly
  // NaN = the selection disagrees: the field shows Mixed until it is given a value
  if (Number.isNaN(value)) input.placeholder = t('Mixed')
  else input.value = String(Math.round(value * 10) / 10)
  if (range?.min !== undefined) input.min = String(range.min)
  if (range?.max !== undefined) input.max = String(range.max)
  if (range?.unit) wrap.dataset.unit = range.unit
  numeric(input, range?.unit)
  input.addEventListener('change', () => {
    const v = parseFloat(input.value)
    if (Number.isNaN(v)) return
    const held = bound(input, v) // a typed value past the limits is held to them, and shows so
    if (held !== v) input.value = String(held)
    onChange(held, true)
  })
  input.addEventListener(SCRUB, () => onChange(parseFloat(input.value), false))
  scrub(span, input)
  wrap.append(span, input)
  return wrap
}

export function number(value: number, step: number, onEdit: (v: number, final: boolean) => void, range?: { min?: number; max?: number }): HTMLElement {
  const input = document.createElement('input')
  input.step = String(step)
  input.value = String(value)
  if (range?.min !== undefined) input.min = String(range.min)
  if (range?.max !== undefined) input.max = String(range.max)
  numeric(input)
  const send = (final: boolean) => {
    const v = parseFloat(input.value)
    if (Number.isNaN(v)) return
    const held = bound(input, v)
    if (final && held !== v) input.value = String(held)
    onEdit(held, final)
  }
  input.addEventListener('change', () => send(true))
  input.addEventListener(SCRUB, () => send(false))
  return input
}

export function select(options: string[], value: string, onChange: (v: string) => void): HTMLElement {
  const sel = document.createElement('select')
  for (const opt of options) {
    const o = document.createElement('option')
    o.value = opt
    o.textContent = optLabel(opt)
    if (opt === value) o.selected = true
    sel.appendChild(o)
  }
  sel.addEventListener('change', () => onChange(sel.value))
  return sel
}

/** A choice among a few options, every one visible, one click — where a
 *  <select> hid them behind two. Same call shape as select(). Options with a
 *  SEG_ICONS entry show the icon, with the word as its tooltip; otherwise the
 *  words show and the control takes the row's full width. */
/** A one-of-N picker. Options that read better as a glyph show one —
 *  `glyphs` (per call, keyed by option) or the shared SEG_ICONS — with the
 *  word as tooltip and accessible name; otherwise the words themselves. */
export function segmented(options: string[], value: string, onChange: (v: string) => void, labels?: Record<string, string>, glyphs?: Record<string, string>): HTMLElement {
  const say = (o: string) => labels?.[o] ?? optLabel(o)
  const wrap = document.createElement('div')
  wrap.className = 'ed-seg'
  wrap.setAttribute('role', 'radiogroup')
  const glyph = (o: string) => glyphs ? glyphs[o] : labels ? undefined : SEG_ICONS[o]
  const icons = options.every((o) => glyph(o))
  if (!icons) wrap.classList.add('ed-seg-text')
  for (const opt of options) {
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', String(opt === value))
    b.dataset.value = opt
    if (icons) {
      b.innerHTML = glyph(opt)!
      b.title = say(opt)
      b.setAttribute('aria-label', say(opt))
    } else b.textContent = say(opt)
    b.addEventListener('click', () => {
      if (opt === value) return
      value = opt // a picker that is not rebuilt (a dialog) still shows the choice
      for (const x of wrap.children) x.setAttribute('aria-checked', String(x === b))
      onChange(opt)
    })
    wrap.appendChild(b)
  }
  roving(wrap, 'radio')
  return wrap
}

export function toggle(value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.className = 'ed-toggle'
  cb.checked = value
  cb.addEventListener('change', () => onChange(cb.checked))
  return cb
}

export function opBtn(icon: string, title: string, onClick: () => void): HTMLElement {
  const btn = document.createElement('button')
  btn.className = 'ed-btn ed-btn-icon'
  btn.title = title
  btn.setAttribute('aria-label', title) // a glyph button is named, not only tooltipped
  btn.innerHTML = icon
  btn.addEventListener('click', onClick)
  return btn
}
