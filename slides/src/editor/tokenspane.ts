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

/**
 * A name typed in place, where a prompt() used to ask: Enter submits, Esc or
 * leaving the field cancels. `submit` returns false to refuse the name (taken,
 * or not a token name); the field stays open and says so.
 */
function inlineName(placeholder: string, label: string, submit: (v: string) => boolean, cancel: () => void): HTMLInputElement {
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
      if (!submit(v)) { done = false; i.setAttribute('aria-invalid', 'true'); i.select() }
      return
    }
    done = true
    cancel()
  }
  i.addEventListener('input', () => i.removeAttribute('aria-invalid'))
  i.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) }
    e.stopPropagation() // the editor's own keys (Delete, arrows, letters) stay out of a name
  })
  i.addEventListener('blur', () => finish(false))
  return i
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
      // the new mode's name is typed where the switch was
      const field = inlineName(t('Mode name, e.g. Dark'), t('Name of the new mode (e.g. Dark)'), (name) => {
        if (name === '+' || modes.includes(name)) return false
        this.edit((x) => {
          const from = activeMode(x)
          x.modes = [...modesOf(x), name]
          // a new mode starts as a copy of the active one, and becomes active
          for (const v of Object.values(x.set)) {
            v.values[name] = v.values[from] ?? Object.values(v.values)[0]
          }
          x.mode = name
        })
        return true
      }, () => this.refresh())
      mode.replaceWith(field)
      field.focus()
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
        // a new row under the caption takes the name; Enter creates the token
        if (group.querySelector('.ed-token-new')) return (group.querySelector('.ed-token-new') as HTMLInputElement).focus()
        const row = div('ed-token-row ed-token-adding')
        const field = inlineName(type === 'color' ? 'color.brand' : 'space.md', t('Token name (e.g. color.brand or space.md)'), (name) => {
          if (!tokenName(`$${name}`) || this.store.doc.theme.tokens?.set[name]) return false
          this.edit((x) => {
            const v = type === 'color' ? doc.theme.accent : 16
            x.set[name] = { type, values: Object.fromEntries(modesOf(x).map((m) => [m, v])) }
          })
          return true
        }, () => { row.remove(); this.refresh() })
        row.appendChild(field)
        cap.after(row)
        field.focus()
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
      // the name is the main's group name, renamed in place
      const mark = document.createElement('span')
      mark.className = 'ed-layer-comp'
      mark.textContent = '◆'
      const name = document.createElement('input')
      name.className = 'ed-token-name'
      name.value = c.name
      name.placeholder = t('Component {n}', { n: i + 1 })
      name.setAttribute('aria-label', t('Component name'))
      name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur() })
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
      ins.addEventListener('click', () => {
        const here = this.store.slide.id === c.slideId
        const els = instanceOf(c, () => uid('c'), here ? 24 : 0, here ? 24 : 0)
        this.store.commit(() => { this.store.slide.elements.push(...els) })
        this.store.select(els.map((e) => e.id))
      })
      row.append(mark, name, ins)
      sec.appendChild(row)
    })
    return sec
  }
}
