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
import { TOKEN_TYPES, activeMode, deleteToken, freeTokenName, modesOf, renameToken, tokenUses, tokenName, protoName, tokenNameError, tokenTargets } from '../tokens'
import { components, instanceOf } from '../components'
import { PALETTE_SLOTS, eachRef, paletteOf, slotIsSet } from '../palette'
import { parseColor, slotLabel } from './inspector/controls'
import { openColorPopover } from './inspector/colorpopover'
import { colorGroups } from './inspector/color'
import { preview, shownValue } from './inspector/tokenpicker'
import { openCtxMenu } from './ctxmenu'
import { cssColor } from '../render'
import { t } from '../i18n'
import { ICONS } from '../icons'
import { lsJson, lsSet } from '../../../kernel/src/storage.ts'

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

/**
 * Text that edits in place: a click (or Enter / F2 on it) turns it into a
 * field; Enter or leaving commits and it is text again, Esc puts it back. A
 * value `check` refuses keeps the field open and says why under it. `commit`
 * runs after the field is gone, so the rebuild it causes is not held off by a
 * focused input.
 */
function editing(text: string, label: string, check: (v: string) => string | null, commit: (v: string) => void, onCancel?: () => void, cls = 'ed-token-name', mono = false, placeholder = false): HTMLButtonElement {
  const shown = button(`ed-edit ${cls}${mono ? ' ed-mono' : ''}${placeholder ? ' ed-edit-placeholder' : ''}`, text, `${label}: ${text} — ${t('click to edit')}`)
  const start = () => {
    const i = document.createElement('input')
    i.className = `ed-edit-field ${cls}`
    i.value = placeholder ? '' : text
    i.placeholder = placeholder ? text : ''
    i.setAttribute('aria-label', label)
    let done = false
    const finish = (accept: boolean) => {
      if (done) return
      const v = i.value.trim()
      if (accept && v !== (placeholder ? '' : text)) {
        const why = check(v)
        if (why) { sayInvalid(i, why); i.select(); return }
      } else accept = false
      done = true
      sayInvalid(i, '')
      if (accept) shown.textContent = v || text
      i.replaceWith(shown)
      if (accept) commit(v)
      else onCancel?.()
    }
    i.addEventListener('input', () => sayInvalid(i, ''))
    i.addEventListener('keydown', (e) => {
      e.stopPropagation() // the editor's own keys stay out of a field
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter') { e.preventDefault(); finish(true); shown.focus() }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); shown.focus() }
    })
    // leaving commits; leaving a refused value puts the old one back
    i.addEventListener('blur', () => { if (i.hasAttribute('aria-invalid')) { i.value = placeholder ? '' : text; finish(false) } else finish(true) })
    shown.replaceWith(i)
    i.focus()
    i.select()
  }
  shown.addEventListener('click', start)
  shown.addEventListener('keydown', (e) => { if (e.key === 'F2') { e.preventDefault(); start() } })
  return shown
}

export interface TokensPaneHost {
  /** a short confirmation where the editor shows its toasts */
  toast(message: string): void
}

export class TokensPane {
  private host: HTMLElement | null = null
  /** per token (or theme slot), where its uses button last stepped to */
  private cursor = new Map<string, number>()
  /** a colour pick is previewing live: the deck already shows it, and a
   *  rebuild would pull the swatch out from under the open popover */
  private live = false
  constructor(private store: Store, private ui: TokensPaneHost = { toast: () => {} }) {}

  mount(into: HTMLElement) {
    this.host = into
    this.refresh()
  }

  /** Rebuild, unless someone is typing in it (their `change` blurs, then rebuilds). */
  refresh() {
    const host = this.host
    if (!host || this.live || host.querySelector('input:focus, .ed-token-name[aria-invalid]')) return
    host.replaceChildren(this.tokensSection(), this.componentsSection())
  }

  /** Focus a token row's first control (after it was created or renamed). */
  focusRow(name: string, what: 'value' | 'name' = 'value') {
    const row = this.host?.querySelector<HTMLElement>(`[data-token="${CSS.escape(name)}"]`)
    const target = what === 'name' ? row?.querySelector<HTMLElement>('.ed-token-name') : row?.querySelector<HTMLElement>('.ed-token-swatch, .ed-token-value')
    target?.focus()
  }

  /** Open the "new token" row of a type (⌘K's New color token / New number token). */
  newToken(type: TokenType) {
    const plus = this.host?.querySelector<HTMLButtonElement>(`.ed-tokens-group[data-type="${type}"] .ed-sec-act`)
    if (plus) plus.click()
    else { this.adding = type; this.refresh() }
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
    if (!used) count.classList.add('ed-token-unused') // no "0" on every row
    count.addEventListener('click', () => this.step(key, targets()))
    return count
  }

  private tokensSection(): HTMLElement {
    const doc = this.store.doc
    const tk = doc.theme.tokens
    const sec = div('ed-tokens')
    // the panel's title once, the modes beside it
    const head = div('ed-tokens-head')
    const h = document.createElement('h3')
    h.textContent = t('Tokens')
    head.append(h, this.modeChips())
    sec.appendChild(head)

    const uses = tokenUses(doc)
    for (const type of TOKEN_TYPES) {
      const names = Object.keys(tk?.set ?? {}).filter((n) => tk!.set[n].type === type).sort()
      // every type is a section of its own — chevron, count, + — the way the
      // inspector lists Fill, Stroke, Shadow; an empty one is just its header
      const group = div('ed-tokens-group')
      group.dataset.type = type
      const count = type === 'color' ? names.length + PALETTE_SLOTS.filter((s) => slotIsSet(doc, s)).length : names.length
      const body = div('ed-tokens-body')
      const head = this.groupHead(t(TYPE_LABEL[type][0]), count, t(TYPE_LABEL[type][1]), () => this.startNew(type, body, type === 'color' ? body.querySelector('.ed-tokens-sub-own') : null), body)
      group.append(head, body)
      // colours: the deck's theme colours first — the built-in tokens every
      // deck has — then the deck's own; one home for every colour
      if (type === 'color') {
        body.append(this.themeCap(), ...this.themeRows())
        if (names.length) {
          const own = div('ed-tokens-sub ed-tokens-sub-own')
          own.textContent = t('Yours')
          body.appendChild(own)
        }
      }
      for (const name of names) body.appendChild(this.tokenRow(name, uses.get(name) ?? 0))
      sec.appendChild(group)
      if (this.adding === type) queueMicrotask(() => this.startNew(type, body, null))
    }
    return sec
  }

  /** The type that was just asked for from the "Add a token" row: its group
   *  shows, already naming the new token. */
  private adding: TokenType | null = null

  /** A group's header, the inspector's section header: chevron fold, title,
   *  a count, and + on the right. Folded state is remembered per title. */
  private groupHead(title: string, count: number, addLabel: string, add: () => void, body: HTMLElement): HTMLElement {
    const h = document.createElement('h3')
    h.className = 'ed-section ed-sec-toggle'
    h.dataset.key = title
    h.tabIndex = 0
    h.setAttribute('role', 'button')
    const label = document.createElement('span')
    label.className = 'ed-tokens-sec-title'
    label.textContent = title
    label.title = title
    const n = document.createElement('span')
    n.className = 'ed-sec-count'
    n.textContent = String(count)
    const plus = document.createElement('button')
    plus.type = 'button'
    plus.className = 'ed-sec-act'
    plus.innerHTML = ICONS.plus
    plus.title = addLabel
    plus.setAttribute('aria-label', addLabel)
    plus.addEventListener('click', (e) => { e.stopPropagation(); setOpen(true); add() })
    h.append(label, n, plus)
    const open = lsJson<Record<string, boolean>>('bento-tokens-open', {})[title] ?? true
    const setOpen = (o: boolean) => {
      h.classList.toggle('closed', !o)
      h.setAttribute('aria-expanded', String(o))
      body.hidden = !o
      const st = lsJson<Record<string, boolean>>('bento-tokens-open', {})
      st[title] = o
      lsSet('bento-tokens-open', JSON.stringify(st))
    }
    h.classList.toggle('closed', !open)
    h.setAttribute('aria-expanded', String(open))
    body.hidden = !open
    h.addEventListener('click', () => setOpen(h.classList.contains('closed')))
    h.addEventListener('keydown', (e) => { if (e.target === h && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); h.click() } })
    return h
  }

  /** A new token of `type`: a row that takes its name; Enter creates it. */
  private startNew(type: TokenType, body: HTMLElement, after: Element | null) {
    this.adding = null
    if (body.querySelector('.ed-token-new')) return (body.querySelector('.ed-token-new') as HTMLInputElement).focus()
    const doc = this.store.doc
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
    if (after) after.after(row)
    else body.prepend(row)
    field.focus()
  }

  /** The modes as chips: a click shows that mode, a double-click (or F2 /
   *  Enter on the shown one) renames it in place, + adds one. */
  private modeChips(): HTMLElement {
    const tk = this.store.doc.theme.tokens
    const modes = modesOf(tk)
    const on = activeMode(tk)
    const bar = div('ed-tokens-modes')
    bar.setAttribute('role', 'group')
    bar.setAttribute('aria-label', t('Mode'))
    const rename = (from: string, chip: HTMLElement) => {
      chip.replaceWith(editing(chip.textContent ?? '', t('Mode name'), (to) => {
        if (to === '+' || protoName(to)) return t('Pick another name')
        if (to !== from && modes.includes(to)) return t('That mode already exists')
        return null
      }, (to) => this.edit((x) => {
        x.modes = modesOf(x).map((m) => (m === from ? to : m))
        for (const v of Object.values(x.set)) if (Object.hasOwn(v.values, from)) { v.values[to] = v.values[from]; delete v.values[from] }
        if (activeMode(x) === from || !x.mode) x.mode = to
      }), () => this.refresh()))
    }
    for (const m of modes) {
      const chip = button('ed-tokens-mode', m === 'default' ? t('Default') : m, t('Show the {mode} values — double-click to rename', { mode: m === 'default' ? t('Default') : m }))
      chip.setAttribute('aria-pressed', String(m === on))
      chip.addEventListener('click', () => { if (m !== on) this.switchMode(m) })
      chip.addEventListener('dblclick', () => rename(m, chip))
      chip.addEventListener('keydown', (e) => { if (e.key === 'F2' || (e.key === 'Enter' && m === on)) { e.preventDefault(); rename(m, chip) } })
      bar.appendChild(chip)
    }
    const add = button('ed-tokens-subadd ed-tokens-addmode', '+', t('＋ Add mode…').replace(/^＋\s*/, ''))
    add.addEventListener('click', () => {
      const field = inlineName(t('Mode name, e.g. Dark'), t('Name of the new mode (e.g. Dark)'), (name) => {
        if (name === '+' || protoName(name)) return t('Pick another name')
        if (modes.includes(name)) return t('That mode already exists')
        this.edit((x) => {
          const from = activeMode(x)
          x.modes = [...modesOf(x), name]
          // a new mode starts as a copy of the active one, and becomes active
          for (const v of Object.values(x.set)) v.values[name] = v.values[from] ?? Object.values(v.values)[0]
          x.mode = name
        })
        return null
      }, () => this.refresh())
      add.replaceWith(field)
      field.focus()
    })
    bar.appendChild(add)
    return bar
  }

  /** "Theme", with a + that adds one of the palette slots the deck lacks. */
  private themeCap(): HTMLElement {
    const sub = div('ed-tokens-sub')
    const cap = document.createElement('span')
    cap.textContent = t('Theme')
    sub.appendChild(cap)
    sub.title = t('The deck’s theme colors: every deck has them; anything that follows one changes when you edit it here')
    const missing = PALETTE_SLOTS.filter((s) => !slotIsSet(this.store.doc, s))
    if (missing.length) {
      const add = button('ed-tokens-subadd', '+', t('Add a theme color'))
      add.addEventListener('click', () => {
        const r = add.getBoundingClientRect()
        const palette = paletteOf(this.store.doc)
        openCtxMenu(r.left, r.bottom + 4, missing.map((slot) => ({
          label: slotLabel(slot),
          run: () => this.store.commit(() => { (this.store.doc.theme.palette ??= {})[slot as 'accent2'] = palette[slot] ?? this.store.doc.theme.accent }),
        })))
      })
      sub.appendChild(add)
    }
    return sub
  }

  /**
   * The deck's theme colours as built-in colour tokens: a swatch that opens the
   * colour popover, the slot's name (fixed), its value (typed or picked), its
   * uses, and − on the optional slots. They write the palette — the format's
   * palette contract is unchanged.
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
      const write = (v: string) => {
        const th = this.store.doc.theme
        if (slot === 'bg1') th.background = v
        else if (slot === 'tx1') th.color = v
        else if (slot === 'accent1') th.accent = v
        else (th.palette ??= {})[slot as 'accent2'] = v
      }
      const set = (v: string) => this.store.commit(() => write(v))
      const name = document.createElement('span')
      name.className = 'ed-token-name'
      name.textContent = slotLabel(slot)
      name.title = slotLabel(slot)
      const label = slotLabel(slot)
      const optional = !(slot === 'bg1' || slot === 'tx1' || slot === 'accent1')
      const more = this.acts(label, optional ? () => this.store.commit(() => {
        const th = this.store.doc.theme
        delete th.palette?.[slot as 'accent2']
        if (th.palette && !Object.keys(th.palette).length) delete th.palette
      }) : null, [])
      row.append(this.swatch(palette[slot]!, t('Value of {name}', { name: label }), set, write), name,
        this.colorValue(palette[slot]!, label, set),
        this.usesButton(`slot:${slot}`, n.get(slot)?.length ?? 0, () => n.get(slot) ?? [], label), more)
      return row
    })
  }

  /** A colour's value as text (hex): a click types a new one. */
  private colorValue(value: string, label: string, set: (v: string) => void): HTMLElement {
    const { hex, a } = parseColor(value)
    const text = `${hex.replace(/^#/, '').toLowerCase()}${a < 1 ? ` · ${Math.round(a * 100)}%` : ''}`
    return editing(text, t('Value of {name}', { name: label }), (v) => (parseColor(v.trim().startsWith('#') || /^[0-9a-f]{3,8}$/i.test(v.trim()) ? `#${v.trim().replace(/^#/, '')}` : v).hex ? null : t('Type a color like ff9e8a')), (v) => {
      const raw = v.trim()
      set(/^#?[0-9a-f]{3,8}$/i.test(raw) ? `#${raw.replace(/^#/, '')}` : raw)
    }, undefined, 'ed-token-value', true)
  }

  /** A row's actions — − removes, ⋯ the rest — laid over the row's end and
   *  shown on hover or focus (Figma's list): at rest the value reaches the
   *  edge instead of a column of buttons standing empty. */
  private acts(label: string, remove: (() => void) | null, items: Array<{ label: string; run: () => void }>): HTMLElement {
    const box = div('ed-token-acts')
    if (remove) {
      const minus = button('ed-btn ed-tool ed-token-remove', '', t('Remove {name}', { name: label }))
      minus.innerHTML = ICONS.minus
      minus.addEventListener('click', remove)
      box.appendChild(minus)
    }
    if (items.length) box.appendChild(this.moreButton(label, items))
    return box
  }

  /** ⋯: the row's other actions, as a menu. */
  private moreButton(label: string, items: Array<{ label: string; run: () => void }>): HTMLElement {
    const b = button('ed-btn ed-tool ed-token-more', '⋯', t('More for {name}', { name: label }))
    b.setAttribute('aria-haspopup', 'menu')
    b.addEventListener('click', () => { const r = b.getBoundingClientRect(); openCtxMenu(r.left, r.bottom + 4, items) })
    return b
  }

  /**
   * A colour value: a swatch that opens the app's colour popover (not the
   * browser's picker). The pick applies LIVE — every bound literal in the deck
   * follows while the colour is dragged or typed (the PropsPanel burst: one
   * checkpoint at the first preview, in-place writes after it). Enter, Esc and
   * a click outside all keep it; the pick is one undo step.
   */
  private swatch(value: string, label: string, set: (v: string) => void, write?: (v: string) => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'ed-token-swatch'
    b.setAttribute('aria-label', label)
    b.title = label
    b.style.background = cssColor(value, 'transparent')
    const { hex, a } = parseColor(value)
    const literal = (h: string, al: number) => (al < 1 ? `${h}${Math.round(al * 255).toString(16).padStart(2, '0')}` : h)
    b.addEventListener('click', () => openColorPopover(b, {
      hex,
      alpha: a,
      // the deck's colours to start from, as every colour picker offers them
      groups: colorGroups(this.store.doc, (c) => set(String(c.value))),
      preview: (h, al) => {
        b.style.background = cssColor(literal(h, al), 'transparent')
        if (!write) return
        if (!this.live) { this.store.checkpoint(); this.live = true }
        write(literal(h, al))
        this.store.touch()
      },
      commit: (h, al) => {
        if (!this.live) return set(literal(h, al))
        write!(literal(h, al))
        this.live = false
        this.store.touch()
      },
      cancel: () => {
        b.style.background = cssColor(value, 'transparent')
        if (!this.live) return
        this.live = false
        this.store.undo()
      },
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
    // one line, Penpot's: preview · name · value · uses · ⋯ — names and values
    // are text until clicked, then a field that commits on Enter or leaving
    const write = (v: string | number | ShadowSpec) => { tk.set[name].values[m] = v }
    const set = (v: string | number | ShadowSpec) => this.edit(() => write(v))
    const num = (v: number, label: string, onSet: (n: number) => void, unit = '') =>
      editing(`${v}${unit}`, label, (s) => (Number.isFinite(parseFloat(s)) ? null : t('Type a number')), (s) => onSet(parseFloat(s)), undefined, 'ed-token-value')
    const valueLabel = t('Value of {name}', { name })
    let lead: HTMLElement = preview(tok.type, value)
    lead.classList.add('ed-token-preview')
    let val: HTMLElement
    if (tok.type === 'color') {
      lead = this.swatch(String(value), valueLabel, set, write)
      val = this.colorValue(String(value), name, set)
    } else if (tok.type === 'shadow') {
      const sh = (typeof value === 'object' ? value : { blur: 0, color: '#000' }) as ShadowSpec
      // the lead tile shows the shadow itself; a click edits its colour
      lead = this.swatch(sh.color, t('Shadow color'), (c) => set({ ...sh, color: c }), (c) => write({ ...sh, color: c }))
      lead.classList.add('ed-token-preview')
      lead.style.background = 'var(--surface)'
      lead.style.boxShadow = `${sh.x ?? 0}px ${sh.y ?? 0}px ${sh.blur}px ${sh.color}`
      val = editing(shownValue('shadow', sh), valueLabel, (s) => (s.trim().split(/\s+/).map(Number).every(Number.isFinite) ? null : t('Type x y blur, like 0 4 12')), (s) => {
        const [x = 0, y = 0, blur = 0] = s.trim().split(/\s+/).map(Number)
        set({ ...sh, x, y, blur: Math.max(blur, 0) })
      }, undefined, 'ed-token-value')
    } else if (tok.type === 'fontFamily') {
      val = editing(String(value), valueLabel, (s) => (s.trim() ? null : t('Type a font')), (s) => set(s.trim()), undefined, 'ed-token-value')
    } else if (tok.type === 'opacity') {
      val = num(Math.round(Number(value) * 100), `${valueLabel} (%)`, (n) => set(Math.min(Math.max(n, 0), 100) / 100), '%')
    } else {
      val = num(Number(value), valueLabel, set)
    }
    const label = editing(name, t('Token name'), (to) => (to === name ? null : tokenNameError(this.store.doc, to, name)), (to) => {
      if (to === name) return
      this.store.commit(() => renameToken(this.store.doc, name, to))
    }, undefined, 'ed-token-name')
    const more = this.acts(name, () => this.store.commit(() => deleteToken(this.store.doc, name)), [
      { label: t('Rename'), run: () => label.click() },
      { label: t('Duplicate'), run: () => this.edit((x) => { x.set[freeTokenName(this.store.doc, `${name}-copy`)] = structuredClone(x.set[name]) }) },
      { label: t('Delete token'), run: () => this.store.commit(() => deleteToken(this.store.doc, name)) },
    ])
    row.append(lead, label, val, this.usesButton(name, used, () => tokenTargets(this.store.doc, name), name), more)
    return row
  }

  private componentsSection(): HTMLElement {
    const sec = div('ed-tokens ed-components')
    const list = components(this.store.doc)
    const h = document.createElement('h3')
    h.className = 'ed-section'
    h.dataset.key = 'Components'
    const label = document.createElement('span')
    label.textContent = t('Components')
    const n = document.createElement('span')
    n.className = 'ed-sec-count'
    n.textContent = String(list.length)
    h.append(label, n)
    sec.appendChild(h)
    if (!list.length) {
      const empty = document.createElement('p')
      empty.className = 'ed-hint'
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
      const shown = c.name || t('Component {n}', { n: i + 1 })
      const name = editing(shown, t('Component name'), () => null, (to) => this.store.commit(() => {
        for (const m of components(this.store.doc).find((x) => x.id === c.id)?.main ?? []) {
          if (to) m.groupName = to
          else delete m.groupName
        }
      }), undefined, 'ed-token-name', false, !c.name)
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
