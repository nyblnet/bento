// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The formula dialog's reference: the sheet's columns and every function with
// its signature, searchable, narrowing to the word being typed.
//
// It replaced one run-on paragraph ("Columns: … Functions: ABS AND AVERAGE …")
// that listed the first 24 names of 103, with no arguments, in a block nobody
// could scan. Sheets and Excel answer the same question with an autocomplete
// that shows the signature; this is that, sized for a dialog:
//
//   · typing in the formula box narrows the list to the word at the caret, so
//     `SU` shows SUBSTITUTE, SUBTOTAL, SUM, SUMIF… with their arguments;
//   · the search field filters it on purpose, for "what was the lookup one?";
//   · clicking (or Enter on) a function writes `NAME(` at the caret, replacing
//     the half-typed word; a column chip writes the column's name, bracketed
//     when it has a space in it, which is the one spelling the parser accepts.
//
// ↓ from the formula box moves into the list, ↑/↓ walk it, and every item is
// a real button — so the keyboard reaches all of it with nothing hidden behind
// hover.

import { t } from './i18n.ts'
import { FN_SIGNATURE, matchFunctions, wordAtCaret } from './fnsig.ts'

export interface FunctionPicker {
  el: HTMLElement
  /** The dialog's key handler asks first; true means "handled, stop there". */
  onKey: (e: KeyboardEvent) => boolean
}

const colRef = (name: string): string => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `[${name}]`)

export function functionPicker(
  input: HTMLInputElement, columns: readonly string[], names: readonly string[], changed: () => void,
): FunctionPicker {
  const el = document.createElement('div')
  el.className = 'dx-fn'

  // --- columns ---------------------------------------------------------------
  if (columns.length) {
    const h = document.createElement('div')
    h.className = 'dx-fn-h'
    h.textContent = t('Columns')
    const chips = document.createElement('div')
    chips.className = 'dx-fn-cols'
    for (const c of columns) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'dx-fn-col'
      b.textContent = c
      b.title = t('Insert “{name}” into the formula', { name: c })
      b.addEventListener('click', () => insert(colRef(c), false))
      chips.append(b)
    }
    el.append(h, chips)
  }

  // --- functions -------------------------------------------------------------
  const head = document.createElement('div')
  head.className = 'dx-fn-h'
  const label = document.createElement('span')
  head.append(label)
  const search = document.createElement('input')
  search.className = 'dx-fn-search'
  search.type = 'search'
  search.placeholder = t('Search functions')
  search.setAttribute('aria-label', t('Search functions'))
  search.spellcheck = false
  const list = document.createElement('div')
  list.className = 'dx-fn-list'
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', t('Functions'))
  el.append(head, search, list)

  /** The word the caret is completing, when it is not a column's name. */
  const typing = (): ReturnType<typeof wordAtCaret> => {
    const w = wordAtCaret(input.value, input.selectionStart ?? input.value.length)
    if (!w || columns.includes(w.word)) return null
    return w
  }

  let shown: string[] = []
  const draw = (): void => {
    const q = search.value.trim() || typing()?.word || ''
    shown = matchFunctions(names, q)
    label.textContent = q
      ? t('Functions matching “{q}” ({n})', { q, n: shown.length })
      : t('Functions ({n})', { n: shown.length })
    list.replaceChildren(...shown.map((name) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'dx-fn-item'
      b.setAttribute('role', 'option')
      b.dataset.fn = name
      const code = document.createElement('code')
      code.textContent = FN_SIGNATURE[name] ?? `${name}()`
      b.append(code)
      b.addEventListener('click', () => insert(`${name}(`, true))
      return b
    }))
    if (!shown.length) {
      const none = document.createElement('div')
      none.className = 'dx-fn-none'
      none.textContent = t('No function matches “{q}”.', { q })
      list.append(none)
    }
  }

  /** Write `text` at the caret; a function replaces the word being typed. */
  const insert = (text: string, replaceWord: boolean): void => {
    const v = input.value
    let from = input.selectionStart ?? v.length
    let to = input.selectionEnd ?? from
    const w = replaceWord ? wordAtCaret(v, from) : null
    if (w) { from = w.from; to = w.to }
    input.value = v.slice(0, from) + text + v.slice(to)
    const at = from + text.length
    input.focus()
    input.setSelectionRange(at, at)
    search.value = ''
    draw()
    changed()
  }

  input.addEventListener('input', draw)
  input.addEventListener('click', draw)
  input.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') draw() })
  search.addEventListener('input', draw)
  draw()

  const items = (): HTMLButtonElement[] => [...list.querySelectorAll<HTMLButtonElement>('.dx-fn-item')]
  const onKey = (e: KeyboardEvent): boolean => {
    const tgt = e.target as HTMLElement
    if ((tgt === input || tgt === search) && e.key === 'ArrowDown' && shown.length) {
      e.preventDefault(); items()[0]?.focus(); return true
    }
    if (tgt === search && e.key === 'Enter' && shown.length) {
      e.preventDefault(); insert(`${shown[0]}(`, true); return true
    }
    if (tgt.classList.contains('dx-fn-item')) {
      const all = items()
      const i = all.indexOf(tgt as HTMLButtonElement)
      if (e.key === 'ArrowDown') { e.preventDefault(); all[Math.min(all.length - 1, i + 1)]?.focus(); return true }
      if (e.key === 'ArrowUp') { e.preventDefault(); (i <= 0 ? input : all[i - 1]).focus(); return true }
    }
    return false
  }
  return { el, onKey }
}
