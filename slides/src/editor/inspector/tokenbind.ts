// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Binding a numeric field to a design token: a small dot at the field's end
// lists the deck's tokens of the field's types; a bound field shows the token's name as a
// pill, and clicking the pill unbinds (the value stays). See tokens.ts.
import type { PropsPanel } from '../panels'
import type { SlideElement, TokenType } from '../../model'
import { bindToken, tokenName, tokenValue, unbindToken } from '../../tokens'
import { openCtxMenu } from '../ctxmenu'
import { t } from '../../i18n'

/** Give a field a token binding for `path` on `el`, offering tokens of `types`. Returns the field. */
export function tokenBind(p: PropsPanel, field: HTMLElement, el: SlideElement, path: string, types: TokenType[] = ['number']): HTMLElement {
  const tokens = p.store.doc.theme.tokens?.set ?? {}
  const names = Object.keys(tokens).filter((n) => types.includes(tokens[n].type))
  const bound = tokenName(el.themeRefs?.[path])
  if (!bound && !names.length) return field
  const b = document.createElement('button')
  b.type = 'button'
  if (bound) {
    b.className = 'ed-token-pill'
    b.textContent = bound
    b.title = t('Follows the token “{name}”. Click to detach.', { name: bound })
    b.setAttribute('aria-label', b.title)
    b.addEventListener('click', (ev) => {
      ev.preventDefault()
      p.mutate(el.id, (e) => unbindToken(e as never, path), true)
    })
  } else {
    b.className = 'ed-token-dot'
    b.title = t('Bind to a token')
    b.setAttribute('aria-label', b.title)
    b.addEventListener('click', (ev) => {
      ev.preventDefault()
      const r = b.getBoundingClientRect()
      openCtxMenu(r.left, r.bottom + 4, names.map((n) => ({
        label: `${n} · ${shown(tokens[n].type, tokenValue(p.store.doc, n))}`,
        run: () => p.mutate(el.id, (e) => bindToken(p.store.doc, e as never, path, n), true),
      })))
    })
  }
  field.classList.add('ed-has-token')
  field.appendChild(b)
  return field
}

/** A control that cannot hold the dot itself (a select, a row of tiles), boxed so it can. */
export function tokenWrap(p: PropsPanel, control: HTMLElement, el: SlideElement, path: string, types: TokenType[]): HTMLElement {
  const box = document.createElement('div')
  box.className = 'ed-token-wrap'
  box.appendChild(control)
  return tokenBind(p, box, el, path, types)
}

/** A token value as the picker lists it. */
function shown(type: TokenType, v: unknown): string {
  if (type === 'opacity' && typeof v === 'number') return `${Math.round(v * 100)}%`
  if (v && typeof v === 'object') { const s = v as { x?: number; y?: number; blur: number }; return `${s.x ?? 0} ${s.y ?? 0} ${s.blur}` }
  return String(v)
}
