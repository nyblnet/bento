// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The side column's Tokens view: the deck's design tokens (tokens.ts) and its
// components (components.ts), beside Slides | Layers.
//
// Tokens: grouped by type, each with its value in the active mode, how many
// properties follow it (a button that walks them), rename in place, delete
// (bound literals stay). The deck's theme colours lead the Colors group as
// built-in tokens: the same gesture edits them, they cannot be deleted, and
// they write the palette (palette.ts), not `theme.tokens`. A mode switch picks
// which column of values the deck shows and says what it changed. Components:
// one row per main, Insert drops a copy on the current slide. Every change is
// one store.commit — one undo step — and the editor's derivations do the rest.
import type { Store } from '../store'
import type { DesignTokens, ShadowSpec, TokenType } from '../model'
import { uid } from '../model'
import { TOKEN_TYPES, activeMode, deleteToken, modesOf, renameToken, tokenUses, tokenName, protoName, tokenNameError, tokenTargets } from '../tokens'
import { components, instanceOf } from '../components'
import { PALETTE_SLOTS, eachRef, paletteOf, slotIsSet } from '../palette'
import { parseColor, slotLabel } from './inspector/controls'
import { openColorPopover } from './inspector/colorpopover'
import { cssColor } from '../render'
import { t } from '../i18n'

const div = (cls: string) => Object.assign(document.createElement('div'), { className: cls })
const button = (cls: string, text: string, title = text) => {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = cls
  b.textContent = text
  b.title = title
  b.setAttribute('aria-label', title)
  return b
}
let errSeq = 0

/** Say why a name was refused, under its field (aria-invalid + aria-describedby); '' clears it. */
function sayInvalid(i: HTMLInputElement, why: string) {
  let note = i.id ? document.getElementById(`${i.id}-why`) : null
  if (!why) {
    i.removeAttribute('aria-invalid')
    i.removeAttribute('aria-describedby')
    note?.remove()
    return
  }
  i.id ||= `ed-token-name-${++errSeq}`
  if (!note) {
    note = div('ed-token-why')
    note.id = `${i.id}-why`
    note.setAttribute('role', 'alert')
    i.after(note)
  }
  note.textContent = t(why)
  i.setAttribute('aria-invalid', 'true')
  i.setAttribute('aria-describedby', note.id)
}

/**
 * A name typed in place, where a prompt() used to ask: Enter submits, Esc or
 * leaving the field cancels. `submit` returns why the name is refused (taken,
 * or not a token name), or null to accept; a refused field stays open and says why.
 */
function inlineName(placeholder: string, label: string, submit: (v: string) => string | null, cancel: () => void): HTMLInputElement {
  const i = document.createElement('input')
  i.className = 'ed-token-name ed-token-new'
  i.placeholder = placeholder
  i.setAttribute('aria-label', label)
  let done = false
  const finish = (accept: boolean) => {
    if (done) return
    const v = i.value.trim()
    if (accept && v) {
      done = true // submit() blurs the field on its way to the commit: that blur is not a cancel
      const why = submit(v)
      if (why) { done = false; sayInvalid(i, why); i.select() }
      return
    }
    done = true
    cancel()
  }
  i.addEventListener('input', () => sayInvalid(i, ''))
  i.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) { e.stopPropagation(); return } // an IME's Enter ends its composition
    if (e.key === 'Enter') { e.preventDefault(); finish(true) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
    e.stopPropagation() // the editor's own keys (Delete, arrows, letters) stay out of a name
  })
  // a refused name keeps the field open: leaving it then cancels, as Esc does
  i.addEventListener('blur', () => { if (!i.hasAttribute('aria-invalid')) finish(false) })
  return i
}

export interface TokensPaneHost {
  /** a short confirmation where the editor shows its toasts */
  toast(message: string): void
}

export class TokensPane {
  private host: HTMLElement | null = null
  /** per token (or theme slot), where its uses button last stepped to */
  private cursor = new Map<string, number>()
  constructor(private store: Store, private ui: TokensPaneHost = { toast: () => {} }) {}

  mount(into: HTMLElement) {
    this.host = into
    this.refresh()
  }

  /** Rebuild, unless someone is typing in it (their `change` blurs, then rebuilds). */
  refresh() {
    const host = this.host
    if (!host || host.querySelector('input:focus, .ed-token-name[aria-invalid]')) return
    host.replaceChildren(this.tokensSection(), this.componentsSection())
  }

  /** Focus a token row's first control (after it was created or renamed). */
  focusRow(name: string, what: 'value' | 'name' = 'value') {
    const row = this.host?.querySelector<HTMLElement>(`[data-token="${CSS.escape(name)}"]`)
    const target = what === 'name' ? row?.querySelector<HTMLElement>('.ed-token-name') : row?.querySelector<HTMLElement>('.ed-token-val button, .ed-token-val input')
    target?.focus()
  }

  /** Open the "new token" row of a type (⌘K's New color token / New number token). */
  newToken(type: TokenType) {
    this.host?.querySelector<HTMLButtonElement>(`.ed-tokens-group[data-type="${type}"] .ed-tokens-add`)?.click()
  }

  /** Switch the active mode (⌘K's Switch mode → X): one undo step, and a toast saying what it changed. */
  switchMode(to: string) {
    const doc = this.store.doc
    const tk = doc.theme.tokens
    const from = activeMode(tk)
    if (!tk || to === from || !modesOf(tk).includes(to)) return
    // what follows: every bound property whose token differs between the two modes
    const differs = (n: string) => JSON.stringify(tk.set[n]?.values[from]) !== JSON.stringify(tk.set[n]?.values[to])
    let changed = 0
    const touched = new Set<string>()
    eachRef(doc, ({ slide, token }) => {
      const n = tokenName(token)
      if (n && Object.hasOwn(tk.set, n) && differs(n)) { changed++; touched.add(slide.id) }
    })
    // what does not: colours on those slides that are literals, so a mode cannot reach them
    let stuck = 0
    for (const s of doc.slides) {
      if (!touched.has(s.id)) continue
      for (const el of s.elements as unknown as Array<Record<string, unknown> & { themeRefs?: Record<string, string> }>) {
        if (['fill', 'stroke', 'color'].some((k) => typeof el[k] === 'string' && !/^(transparent|none)$/.test(el[k] as string) && parseColor(el[k] as string).a > 0 && !el.themeRefs?.[k])) stuck++
      }
    }
    this.edit((x) => { x.mode = to })
    this.ui.toast(stuck
      ? t('{n} properties changed · {m} hard-coded colors on these slides didn’t follow', { n: changed, m: stuck })
      : t('{n} properties changed', { n: changed }))
  }

  private edit(fn: (tk: DesignTokens) => void) {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    this.store.commit(() => fn(this.store.doc.theme.tokens ??= { set: {} }))
  }

  /** Select the next place `key` is used (a token or a theme slot), across slides. */
  private step(key: string, targets: Array<{ slideId: string; elementId?: string }>) {
    if (!targets.length) return
    const i = ((this.cursor.get(key) ?? -1) + 1) % targets.length
    this.cursor.set(key, i)
    const { slideId, elementId } = targets[i]
    const at = this.store.doc.slides.findIndex((s) => s.id === slideId)
    if (at >= 0 && at !== this.store.currentIndex) this.store.goTo(at)
    this.store.select(elementId ? [elementId] : [])
  }

  /** The uses count as a button that walks them. */
  private usesButton(key: string, used: number, targets: () => Array<{ slideId: string; elementId?: string }>, label: string) {
    const count = button('ed-token-uses', String(used), used
      ? t('{n} properties follow {name} — click to select the next', { n: used, name: label })
      : t('Nothing follows {name} yet', { name: label }))
    count.disabled = !used
    count.addEventListener('click', () => this.step(key, targets()))
    return count
  }

  private tokensSection(): HTMLElement {
    const doc = this.store.doc
    const tk = doc.theme.tokens
    const sec = div('ed-tokens')
    const head = div('ed-tokens-head')
    const h = document.createElement('h3')
    h.textContent = t('Tokens')
    head.appendChild(h)

    // mode switch: the active mode, and a way to add one
    const modes = modesOf(tk)
    const mode = document.createElement('select')
    mode.className = 'ed-tokens-mode'
    mode.title = t('Mode')
    mode.setAttribute('aria-label', t('Mode'))
    for (const m of modes) mode.appendChild(new Option(m === 'default' ? t('Default') : m, m, false, m === activeMode(tk)))
    mode.appendChild(new Option(t('＋ Add mode…'), '+'))
    mode.addEventListener('change', () => {
      if (mode.value !== '+') return this.switchMode(mode.value)
      // the new mode's name is typed where the switch was
      const field = inlineName(t('Mode name, e.g. Dark'), t('Name of the new mode (e.g. Dark)'), (name) => {
        if (name === '+' || protoName(name)) return 'Pick another name'
        if (modes.includes(name)) return 'That mode already exists'
        this.edit((x) => {
          const from = activeMode(x)
          x.modes = [...modesOf(x), name]
          // a new mode starts as a copy of the active one, and becomes active
          for (const v of Object.values(x.set)) {
            v.values[name] = v.values[from] ?? Object.values(v.values)[0]
          }
          x.mode = name
        })
        return null
      }, () => this.refresh())
      mode.replaceWith(field)
      field.focus()
    })
    head.appendChild(mode)
    sec.appendChild(head)

    const uses = tokenUses(doc)
    for (const type of TOKEN_TYPES) {
      const names = Object.keys(tk?.set ?? {}).filter((n) => tk!.set[n].type === type)
      const group = div('ed-tokens-group')
      group.dataset.type = type
      const cap = div('ed-tokens-cap')
      cap.textContent = t(TYPE_LABEL[type][0])
      const add = button('ed-btn ed-tool ed-tokens-add', '+', t(TYPE_LABEL[type][1]))
      add.addEventListener('click', () => {
        // a new row under the caption takes the name; Enter creates the token
        if (group.querySelector('.ed-token-new')) return (group.querySelector('.ed-token-new') as HTMLInputElement).focus()
        const row = div('ed-token-row ed-token-adding')
        const field = inlineName(TYPE_LABEL[type][2], t('Token name (e.g. color.brand or space.md)'), (name) => {
          const why = tokenNameError(this.store.doc, name)
          if (why) return why
          this.edit((x) => {
            const v = type === 'color' ? doc.theme.accent : type === 'fontFamily' ? doc.theme.fontFamily
              : type === 'shadow' ? { x: 0, y: 4, blur: 12, color: 'rgba(0, 0, 0, 0.25)' } : DEFAULT_NUM[type]
            x.set[name] = { type, values: Object.fromEntries(modesOf(x).map((m) => [m, v])) }
          })
          this.focusRow(name)
          return null
        }, () => { row.remove(); this.refresh() })
        row.appendChild(field)
        cap.after(row)
        field.focus()
      })
      cap.appendChild(add)
      group.appendChild(cap)
      if (type === 'color') for (const row of this.themeRows()) group.appendChild(row)
      for (const name of names) group.appendChild(this.tokenRow(name, uses.get(name) ?? 0))
      sec.appendChild(group)
    }
    return sec
  }

  /**
   * The deck's theme colours as built-in colour tokens: a swatch that opens the
   * colour popover, the slot's name, its uses. They write the palette — the
   * format's palette contract is unchanged — and cannot be renamed or deleted.
   * ponytail: one value in every mode; per-mode theme colours need a format addition.
   */
  private themeRows(): HTMLElement[] {
    const doc = this.store.doc
    const palette = paletteOf(doc)
    const n = new Map<string, Array<{ slideId: string; elementId?: string }>>()
    eachRef(doc, ({ slide, element, token }) => {
      if (tokenName(token)) return
      const slot = token.split(' ')[0]
      n.set(slot, [...(n.get(slot) ?? []), { slideId: slide.id, elementId: element?.id }])
    })
    return PALETTE_SLOTS.filter((s) => palette[s] && slotIsSet(doc, s)).map((slot) => {
      const row = div('ed-token-row ed-token-builtin')
      row.dataset.slot = slot
      const top = div('ed-token-top')
      const name = document.createElement('span')
      name.className = 'ed-token-name'
      name.textContent = slotLabel(slot)
      name.title = t('Theme color — every deck has it; it can’t be renamed or deleted')
      const badge = document.createElement('span')
      badge.className = 'ed-token-badge'
      badge.textContent = t('Theme')
      top.append(name, badge)
      const val = div('ed-token-val')
      val.append(this.swatch(palette[slot]!, t('Value of {name}', { name: slotLabel(slot) }), (v) => this.store.commit(() => {
        const th = this.store.doc.theme
        if (slot === 'bg1') th.background = v
        else if (slot === 'tx1') th.color = v
        else if (slot === 'accent1') th.accent = v
        else (th.palette ??= {})[slot as 'accent2'] = v
      })), this.usesButton(`slot:${slot}`, n.get(slot)?.length ?? 0, () => n.get(slot) ?? [], slotLabel(slot)))
      row.append(top, val)
      return row
    })
  }

  /** A colour value: a swatch that opens the app's colour popover (not the browser's picker). */
  private swatch(value: string, label: string, set: (v: string) => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-token-swatch'
    b.setAttribute('aria-label', label)
    b.title = label
    b.style.background = cssColor(value, 'transparent')
    const { hex, a } = parseColor(value)
    b.addEventListener('click', () => openColorPopover(b, {
      hex,
      alpha: a,
      groups: [],
      preview: (h, al) => { b.style.background = cssColor(al < 1 ? `${h}${Math.round(al * 255).toString(16).padStart(2, '0')}` : h, 'transparent') },
      commit: (h, al) => set(al < 1 ? `${h}${Math.round(al * 255).toString(16).padStart(2, '0')}` : h),
      cancel: () => { b.style.background = cssColor(value, 'transparent') },
    }))
    return b
  }

  private tokenRow(name: string, used: number): HTMLElement {
    const tk = this.store.doc.theme.tokens!
    const tok = tk.set[name]
    const m = activeMode(tk)
    const value = tok.values[m] ?? ''
    const row = div('ed-token-row')
    row.dataset.token = name
    // two lines: the name alone (always readable, even in the 188px default
    // column), then the value with its uses and delete
    const top = div('ed-token-top')
    const val = div('ed-token-val')
    const set = (v: string | number | ShadowSpec) => this.edit((x) => { x.set[name].values[m] = v })
    const num = (v: number, onSet: (n: number) => void, label: string) => {
      const i = document.createElement('input')
      i.type = 'number'
      i.value = String(v)
      i.setAttribute('aria-label', label)
      i.addEventListener('keydown', (e) => e.stopPropagation())
      i.addEventListener('change', () => { const n = parseFloat(i.value); if (Number.isFinite(n)) onSet(n) })
      return i
    }
    const valueLabel = t('Value of {name}', { name })
    // a preview of what the token does, then its editor
    const preview = div('ed-token-preview')
    if (tok.type === 'color') {
      val.appendChild(this.swatch(String(value), valueLabel, set))
    } else if (tok.type === 'shadow') {
      const sh = (typeof value === 'object' ? value : { blur: 0, color: '#000' }) as ShadowSpec
      preview.style.boxShadow = `${sh.x ?? 0}px ${sh.y ?? 0}px ${sh.blur}px ${sh.color}`
      val.append(preview, this.swatch(sh.color, t('Shadow color'), (c) => set({ ...sh, color: c })),
        num(sh.x ?? 0, (n) => set({ ...sh, x: n }), 'X'), num(sh.y ?? 0, (n) => set({ ...sh, y: n }), 'Y'),
        num(sh.blur, (n) => set({ ...sh, blur: Math.max(n, 0) }), t('Blur')))
    } else if (tok.type === 'fontFamily') {
      preview.textContent = 'Aa'
      preview.style.fontFamily = String(value)
      const input = document.createElement('input')
      input.className = 'ed-token-font'
      input.value = String(value)
      input.setAttribute('aria-label', valueLabel)
      input.addEventListener('keydown', (e) => e.stopPropagation())
      input.addEventListener('change', () => { if (input.value.trim()) set(input.value.trim()) })
      val.append(preview, input)
    } else if (tok.type === 'opacity') {
      preview.style.opacity = String(value)
      val.append(preview, num(Math.round(Number(value) * 100), (n) => set(Math.min(Math.max(n, 0), 100) / 100), `${valueLabel} (%)`))
    } else {
      if (tok.type === 'fontSize') { preview.textContent = 'Aa'; preview.style.fontSize = `${Math.min(Number(value), 22)}px` }
      val.append(...(tok.type === 'fontSize' ? [preview] : []), num(Number(value), set, valueLabel))
    }
    const label = document.createElement('input')
    label.className = 'ed-token-name'
    label.value = name
    label.title = name
    label.setAttribute('aria-label', t('Token name'))
    label.addEventListener('input', () => sayInvalid(label, ''))
    label.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); label.dispatchEvent(new Event('change')) }
      else if (e.key === 'Escape') { label.value = name; sayInvalid(label, ''); label.blur() }
    })
    label.addEventListener('change', () => {
      const to = label.value.trim()
      if (!to || to === name) { label.value = name; sayInvalid(label, ''); return }
      const why = tokenNameError(this.store.doc, to, name)
      if (why) { sayInvalid(label, why); label.select(); return } // refused: stay open and say why
      sayInvalid(label, '')
      label.blur()
      this.store.commit(() => renameToken(this.store.doc, name, to))
      this.focusRow(to, 'name')
    })
    label.addEventListener('blur', () => { if (label.hasAttribute('aria-invalid')) { label.value = name; sayInvalid(label, ''); this.refresh() } })
    const del = button('ed-btn ed-tool ed-token-del', '−', t('Delete token'))
    del.addEventListener('click', () => this.store.commit(() => deleteToken(this.store.doc, name)))
    top.append(label)
    val.append(this.usesButton(name, used, () => tokenTargets(this.store.doc, name), name), del)
    row.append(top, val)
    return row
  }

  private componentsSection(): HTMLElement {
    const sec = div('ed-tokens ed-components')
    const head = div('ed-tokens-head')
    const h = document.createElement('h3')
    h.textContent = t('Components')
    head.appendChild(h)
    sec.appendChild(head)
    const list = components(this.store.doc)
    if (!list.length) {
      const empty = div('ed-tokens-empty')
      empty.textContent = t('Select elements and choose Create component (⌘⌥K) to reuse them.')
      sec.appendChild(empty)
    }
    list.forEach((c, i) => {
      const row = div('ed-token-row ed-component-row')
      row.dataset.component = c.id
      // the name is the main's group name, renamed in place
      const mark = document.createElement('span')
      mark.className = 'ed-layer-comp'
      mark.textContent = '◆'
      const name = document.createElement('input')
      name.className = 'ed-token-name'
      name.value = c.name
      name.placeholder = t('Component {n}', { n: i + 1 })
      name.setAttribute('aria-label', t('Component name'))
      name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) name.blur() })
      name.addEventListener('change', () => {
        const to = name.value.trim()
        this.store.commit(() => {
          for (const m of components(this.store.doc).find((x) => x.id === c.id)?.main ?? []) {
            if (to) m.groupName = to
            else delete m.groupName
          }
        })
      })
      const ins = button('ed-btn', t('Insert'), t('Insert a copy on this slide'))
      ins.addEventListener('click', () => this.insertCopy(c.id))
      row.append(mark, name, ins)
      sec.appendChild(row)
    })
    return sec
  }

  /** Point at a component's row (after ⌥⌘K made it): it flashes, its name a
   *  click away. Not focused — a focused field would keep ⌘Z from undoing the make. */
  showComponent(id: string) {
    const row = this.host?.querySelector<HTMLElement>(`[data-component="${CSS.escape(id)}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'nearest' })
    row.classList.remove('ed-flash'); void row.offsetWidth; row.classList.add('ed-flash')
  }

  /**
   * A copy of a component on the current slide: centred on the slide, then
   * nudged down-right until it covers nothing already there, and selected.
   * ponytail: the slide's centre, not the scrolled viewport's — the canvas fits
   * the slide by default; a zoomed-in view may still put it off-screen.
   */
  private insertCopy(id: string) {
    const c = components(this.store.doc).find((x) => x.id === id)
    if (!c) return
    const box = bounds(c.main as unknown as Box[])
    const { width, height } = this.store.doc.size
    const others = this.store.slide.elements as unknown as Box[]
    let x = Math.round((width - box.w) / 2), y = Math.round((height - box.h) / 2)
    for (let i = 0; i < 24 && others.some((o) => hits({ x, y, w: box.w, h: box.h }, o)); i++) { x += 32; y += 32 }
    if (x + box.w > width || y + box.h > height) { x = Math.round((width - box.w) / 2); y = Math.round((height - box.h) / 2) }
    const els = instanceOf(c, () => uid('c'), x - box.x, y - box.y)
    this.store.commit(() => { this.store.slide.elements.push(...els) })
    this.store.select(els.map((e) => e.id))
  }
}

interface Box { x: number; y: number; w: number; h: number }
const bounds = (els: Box[]): Box => {
  const x = Math.min(...els.map((e) => e.x)), y = Math.min(...els.map((e) => e.y))
  return { x, y, w: Math.max(...els.map((e) => e.x + e.w)) - x, h: Math.max(...els.map((e) => e.y + e.h)) - y }
}
const hits = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Per type: caption, the + button's label, a placeholder name. */
const TYPE_LABEL: Record<TokenType, [string, string, string]> = {
  color: ['Colors', 'New color token', 'color.brand'],
  number: ['Numbers', 'New number token', 'space.md'],
  fontSize: ['Font sizes', 'New font size token', 'type.body'],
  opacity: ['Opacity', 'New opacity token', 'opacity.muted'],
  fontFamily: ['Fonts', 'New font token', 'font.body'],
  shadow: ['Shadows', 'New shadow token', 'shadow.card'],
}
const DEFAULT_NUM: Record<string, number> = { number: 16, fontSize: 24, opacity: 0.6 }
