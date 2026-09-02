// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The modal chrome the app's two settings-shaped surfaces share.
//
// WHY THIS FILE EXISTS. There used to be ONE dialog behind the ⓘ button and it
// held eight sections: what this file is, its properties, updates, language,
// appearance, password, version history and the JSON round trip. Measured in
// the running app it was 1361px tall in a 429px viewport — three and a bit
// screens — and the reader who came to find out what language the interface is
// in scrolled past their own password to get there.
//
// So it is two surfaces now (see about.ts for the seam), and the moment there
// were two, every part of the chrome became a thing that could be got subtly
// different in one of them: the Escape key, the backdrop click, and above all
// the two DOCUMENT-LEVEL handlers main.ts owns, which a dialog sits inside:
//
//   · a keydown that routes any bare printable key into the selected cell —
//     its guard is `INPUT || isContentEditable`, so a TEXTAREA is NOT covered:
//     typing JSON in a dialog typed into the grid as well.
//   · a paste sniffer that treats any clipboard text with a comma or a tab as
//     a CSV import, and calls preventDefault — so pasting a workbook, or an
//     author name with a comma in it, imported a junk sheet instead.
//
// Both are stopped at the backdrop, which contains everything in the dialog.
// ⌘S is stopped with them, deliberately: saving from behind a modal that may be
// mid-edit is not a gesture worth preserving. A second dialog that forgot any
// one of these would not look broken — it would look like the grid had gone
// mad — so there is one implementation and both surfaces call it.
//
// The stylesheet stays about.css and the class names stay `.dx-about-*`: this
// is one visual surface with two contents, and a second stylesheet declaring
// the same box would be one more thing to keep in step.

import './about.css'

export interface Dialog {
  /** the backdrop; removing it closes everything */
  back: HTMLElement
  /** the card content goes here */
  card: HTMLElement
  close: () => void
  /** a section heading */
  h: (label: string) => HTMLElement
  /** small print under a section — the app explains itself rather than not */
  note: (text: string) => HTMLElement
  /** a monospaced value (a file name, an id, a size) */
  value: (text: string) => HTMLElement
  /** label · control */
  row: (label: string, node: HTMLElement) => HTMLElement
  button: (label: string, fn: () => void) => HTMLButtonElement
  actions: (...nodes: HTMLElement[]) => HTMLElement
  /** a checkbox whose LABEL is part of the hit target */
  check: (label: string, on: boolean, onChange: (v: boolean) => void) => HTMLElement
  /** put it on screen and take focus. Call once, after the card is filled. */
  mount: () => void
}

/**
 * Open a modal. ONE AT A TIME, by construction: an existing backdrop is
 * removed first, which is also what makes "Settings…" inside About a
 * navigation rather than a stack of two modals nobody can get out of.
 */
export function openDialog(label: string): Dialog {
  document.querySelector('.dx-about-back')?.remove()

  const back = document.createElement('div')
  back.className = 'dx-about-back'
  const card = document.createElement('div')
  card.className = 'dx-about'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-label', label)
  const close = () => back.remove()

  const h = (text: string) => {
    const n = document.createElement('h2')
    n.textContent = text
    return n
  }
  const note = (text: string) => {
    const n = document.createElement('p')
    n.className = 'dx-about-note'
    n.textContent = text
    return n
  }
  const value = (text: string) => {
    const n = document.createElement('span')
    n.className = 'dx-about-val'
    n.textContent = text
    return n
  }
  const row = (rowLabel: string, node: HTMLElement) => {
    const r = document.createElement('div')
    r.className = 'dx-about-row'
    const s = document.createElement('span')
    s.textContent = rowLabel
    r.append(s, node)
    return r
  }
  const button = (text: string, fn: () => void) => {
    const b = document.createElement('button')
    b.className = 'dx-btn'
    b.textContent = text
    b.addEventListener('click', fn)
    return b
  }
  const actions = (...nodes: HTMLElement[]) => {
    const wrap = document.createElement('div')
    wrap.className = 'dx-about-actions'
    wrap.append(...nodes)
    return wrap
  }
  const check = (text: string, on: boolean, onChange: (v: boolean) => void) => {
    const l = document.createElement('label')
    l.className = 'dx-about-check'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = on
    box.addEventListener('change', () => onChange(box.checked))
    l.append(box, document.createTextNode(' ' + text))
    return l
  }

  // The two document-level handlers, stopped at the backdrop. See the note at
  // the top of this file for what each of them would otherwise do.
  back.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close()
    e.stopPropagation()
  })
  back.addEventListener('paste', (e) => e.stopPropagation())
  back.addEventListener('mousedown', (e) => { if (e.target === back) close() })

  const mount = () => {
    back.append(card)
    document.body.append(back)
    card.querySelector('button')?.focus()
  }

  return { back, card, close, h, note, value, row, button, actions, check, mount }
}
