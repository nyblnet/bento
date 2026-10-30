// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Binding a field to a design token: a small dot at the field's end opens the
// token picker (tokenpicker.ts — the same popover colour fields use) with the
// deck's tokens of the field's types; a bound field shows the token's name as
// a pill that reopens the picker, with a detach icon that lets go and keeps
// the value. See tokens.ts.
import type { PropsPanel } from '../panels'
import type { SlideElement, TokenType } from '../../model'
import { bindToken, freeTokenName, modesOf, tokenName, unbindToken } from '../../tokens'
import { ICONS } from '../../icons'
import { choices, openTokenPicker } from './tokenpicker'
import { t } from '../../i18n'

/** A new token's name stem, by type. */
const STEM: Record<TokenType, string> = { color: 'color.brand', number: 'space', fontSize: 'type.size', opacity: 'opacity', fontFamily: 'font', shadow: 'shadow' }

/** Give a field a token binding for `path` on `el`, offering tokens of `types`. Returns the field. */
/** The token picker for one property — the field's dot, a pill, or the
 *  section's ⠿ opens it. */
export function tokenPicker(p: PropsPanel, el: SlideElement, path: string, types: TokenType[]): (anchor: HTMLElement) => void {
  const bound = tokenName(el.themeRefs?.[path])
  return (anchor: HTMLElement) => openTokenPicker(anchor, {
    title: t('Bind to a token'),
    choices: choices(p.store.doc, types),
    bound: bound ?? undefined,
    pick: (c) => p.mutate(el.id, (e) => bindToken(p.store.doc, e as never, path, c.key), true),
    actions: (bound
      ? [{ icon: ICONS.minus, label: t('Detach from token'), run: () => p.mutate(el.id, (e) => unbindToken(e as never, path), true) }]
      : [{ icon: ICONS.tokenNew, label: t('Make a token from this value'), run: () => {
        const value = readAt(p.store.element(el.id), path)
        if (value === undefined) return
        const name = freeTokenName(p.store.doc, STEM[types[0]])
        p.edit(() => {
          const tk = p.store.doc.theme.tokens ??= { set: {} }
          tk.set[name] = { type: types[0], values: Object.fromEntries(modesOf(tk).map((m) => [m, structuredClone(value) as never])) }
          const e = p.store.element(el.id)
          if (e) bindToken(p.store.doc, e as never, path, name)
        }, true)
        p.toast(t('Made {name} — {n} uses follow it', { name, n: 1 }))
      } }]).concat([{ icon: ICONS.settings, label: t('Manage tokens'), run: () => document.querySelector<HTMLElement>('.ed-side-tabs [data-view="tokens"]')?.click() }]),
  })
}

export function tokenBind(p: PropsPanel, field: HTMLElement, el: SlideElement, path: string, types: TokenType[] = ['number']): HTMLElement {
  const bound = tokenName(el.themeRefs?.[path])
  const pick = tokenPicker(p, el, path, types)
  if (bound) {
    const pill = document.createElement('span')
    pill.className = 'ed-token-pill'
    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'ed-token-pill-name'
    name.textContent = bound
    name.title = t('Follows the token “{name}”. Click to change.', { name: bound })
    name.addEventListener('click', (ev) => { ev.preventDefault(); pick(name) })
    const off = document.createElement('button')
    off.type = 'button'
    off.className = 'ed-color-detach'
    off.innerHTML = ICONS.unlink
    off.title = t('Detach from token')
    off.setAttribute('aria-label', off.title)
    off.addEventListener('click', (ev) => { ev.preventDefault(); p.mutate(el.id, (e) => unbindToken(e as never, path), true) })
    pill.append(name, off)
    field.classList.add('ed-has-token')
    field.appendChild(pill)
    return field
  }
  const dot = document.createElement('button')
  dot.type = 'button'
  dot.className = 'ed-token-dot'
  dot.title = t('Bind to a token')
  dot.setAttribute('aria-label', dot.title)
  dot.setAttribute('aria-haspopup', 'dialog')
  dot.addEventListener('click', (ev) => { ev.preventDefault(); pick(dot) })
  field.classList.add('ed-has-token')
  field.appendChild(dot)
  return field
}

/** A control that cannot hold the dot itself (a select, a row of tiles), boxed so it can. */
export function tokenWrap(p: PropsPanel, control: HTMLElement, el: SlideElement, path: string, types: TokenType[]): HTMLElement {
  const box = document.createElement('div')
  box.className = 'ed-token-wrap'
  box.appendChild(control)
  return tokenBind(p, box, el, path, types)
}

/** The value at a dotted path ('layout.pad.0', 'shadow'). */
function readAt(obj: unknown, path: string): unknown {
  let o = obj as Record<string, unknown> | undefined
  for (const k of path.split('.')) { if (o == null || typeof o !== 'object') return undefined; o = o[k] as Record<string, unknown> | undefined }
  return o
}
