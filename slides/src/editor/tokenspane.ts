// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The side column's Tokens view: the deck's design tokens (tokens.ts) and its
// components (components.ts), beside Slides | Layers.
//
// Tokens: grouped by type, each with its value in the active mode, how many
// properties follow it, rename in place, delete (bound literals stay). A mode
// switch picks which column of values the deck shows. Components: one row per
// main, Insert drops a copy on the current slide. Every change is one
// store.commit — one undo step — and the editor's derivations do the rest.
import type { Store } from '../store'
import type { DesignTokens } from '../model'
import { uid } from '../model'
import { activeMode, deleteToken, modesOf, renameToken, tokenUses, tokenName } from '../tokens'
import { components, instanceOf } from '../components'
import { parseColor } from './inspector/controls'
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

export class TokensPane {
  private host: HTMLElement | null = null
  constructor(private store: Store) {}

  mount(into: HTMLElement) {
    this.host = into
    this.refresh()
  }

  /** Rebuild, unless someone is typing in it (their `change` blurs, then rebuilds). */
  refresh() {
    const host = this.host
    if (!host || host.querySelector('input:focus')) return
    host.replaceChildren(this.tokensSection(), this.componentsSection())
  }

  private edit(fn: (tk: DesignTokens) => void) {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    this.store.commit(() => fn(this.store.doc.theme.tokens ??= { set: {} }))
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
      if (mode.value !== '+') return this.edit((x) => { x.mode = mode.value })
      const name = prompt(t('Name of the new mode (e.g. Dark)'))?.trim()
      if (!name || modes.includes(name)) return this.refresh()
      this.edit((x) => {
        const from = activeMode(x)
        x.modes = [...modesOf(x), name]
        // a new mode starts as a copy of the active one, and becomes active
        for (const v of Object.values(x.set)) {
          v.values[name] = v.values[from] ?? Object.values(v.values)[0]
        }
        x.mode = name
      })
    })
    head.appendChild(mode)
    sec.appendChild(head)

    const uses = tokenUses(doc)
    for (const type of ['color', 'number'] as const) {
      const names = Object.keys(tk?.set ?? {}).filter((n) => tk!.set[n].type === type)
      const group = div('ed-tokens-group')
      const cap = div('ed-tokens-cap')
      cap.textContent = type === 'color' ? t('Colors') : t('Numbers')
      const add = button('ed-btn ed-tool ed-tokens-add', '+', type === 'color' ? t('New color token') : t('New number token'))
      add.addEventListener('click', () => {
        const name = prompt(t('Token name (e.g. color.brand or space.md)'))?.trim()
        if (!name || !tokenName(`$${name}`) || tk?.set[name]) return
        this.edit((x) => {
          const v = type === 'color' ? doc.theme.accent : 16
          x.set[name] = { type, values: Object.fromEntries(modesOf(x).map((m) => [m, v])) }
        })
      })
      cap.appendChild(add)
      group.appendChild(cap)
      for (const name of names) group.appendChild(this.tokenRow(name, uses.get(name) ?? 0))
      sec.appendChild(group)
    }
    return sec
  }

  private tokenRow(name: string, used: number): HTMLElement {
    const tk = this.store.doc.theme.tokens!
    const tok = tk.set[name]
    const m = activeMode(tk)
    const value = tok.values[m] ?? ''
    const row = div('ed-token-row')
    row.dataset.token = name
    let input: HTMLInputElement
    if (tok.type === 'color') {
      input = document.createElement('input')
      input.type = 'color'
      input.value = parseColor(String(value)).hex
      input.addEventListener('change', () => this.edit((x) => { x.set[name].values[m] = input.value }))
      row.appendChild(input)
    } else {
      input = document.createElement('input')
      input.type = 'number'
      input.value = String(value)
      input.addEventListener('change', () => {
        const v = parseFloat(input.value)
        if (Number.isFinite(v)) this.edit((x) => { x.set[name].values[m] = v })
      })
      row.appendChild(input)
    }
    input.setAttribute('aria-label', t('Value of {name}', { name }))
    const label = document.createElement('input')
    label.className = 'ed-token-name'
    label.value = name
    label.setAttribute('aria-label', t('Token name'))
    label.addEventListener('change', () => {
      const to = label.value.trim()
      label.blur()
      if (to && to !== name && tokenName(`$${to}`) && !tk.set[to]) this.store.commit(() => renameToken(this.store.doc, name, to))
      else label.value = name
    })
    const count = document.createElement('span')
    count.className = 'ed-token-uses'
    count.textContent = String(used)
    count.title = t('{n} properties follow this token', { n: used })
    const del = button('ed-btn ed-tool ed-token-del', '−', t('Delete token'))
    del.addEventListener('click', () => this.store.commit(() => deleteToken(this.store.doc, name)))
    row.append(label, count, del)
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
      const name = document.createElement('span')
      name.className = 'ed-token-name'
      name.textContent = `◆ ${c.name || t('Component {n}', { n: i + 1 })}`
      const ins = button('ed-btn', t('Insert'), t('Insert a copy on this slide'))
      ins.addEventListener('click', () => {
        const here = this.store.slide.id === c.slideId
        const els = instanceOf(c, () => uid('c'), here ? 24 : 0, here ? 24 : 0)
        this.store.commit(() => { this.store.slide.elements.push(...els) })
        this.store.select(els.map((e) => e.id))
      })
      row.append(name, ins)
      sec.appendChild(row)
    })
    return sec
  }
}
