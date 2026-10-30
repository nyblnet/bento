// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Speaker notes, in a pane under the canvas — where PowerPoint, Keynote and
// Google Slides keep them. They used to be a section of the slide's own panel,
// which only shows when NOTHING is selected: while you worked on an element,
// the notes for the slide you were looking at were nowhere on screen.
//
// The pane follows the current slide, and folds to its header (remembered).
// Editing matches the field it replaced: typing is one undo burst, closed by
// `change`; the slide is the one that was current when typing began, so a
// slide switch mid-edit cannot write the text onto the next slide.
import { ICONS } from '../icons'
import type { Store } from '../store'
import { t } from '../i18n'
import { lsGet, lsSet } from '../../../kernel/src/storage.ts'
import { isMacOS } from '../screens'

export function mountNotesPane(store: Store, into: HTMLElement, signal: AbortSignal) {
  const pane = document.createElement('section')
  pane.className = 'ed-notespane'
  const head = document.createElement('button')
  head.type = 'button'
  head.className = 'ed-section ed-sec-toggle ed-notespane-head' // the inspector's own section header
  head.textContent = t('Speaker notes')
  const area = document.createElement('textarea')
  area.className = 'ed-notespane-text'
  area.placeholder = t('Notes for the speaker view (press S while presenting)…')
  area.title = t('Shown in the speaker view (Slideshow menu, or S while presenting).') +
    (isMacOS() ? ' ' + t('On macOS, open the speaker view before going fullscreen.') : '')
  // The PANE resizes, from its top edge, as the side panels do from theirs;
  // the text fills it. (A resize corner on the text box itself resized the
  // box inside a pane that stayed the same size.)
  const grip = document.createElement('div')
  grip.className = 'ed-notes-grip'
  grip.title = t('Drag to resize · double-click to reset')
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'ed-panel-toggle ed-notes-toggle'
  toggle.setAttribute('aria-label', t('Speaker notes'))
  grip.appendChild(toggle)
  const DEFAULT_H = 84
  const setH = (h: number) => area.style.setProperty('height', `${Math.round(Math.min(Math.max(h, 40), window.innerHeight * 0.5))}px`)
  setH(Number(lsGet('bento-notes-h')) || DEFAULT_H)
  grip.addEventListener('pointerdown', (down) => {
    if (pane.classList.contains('closed')) return
    down.preventDefault()
    grip.setPointerCapture(down.pointerId)
    const startY = down.clientY
    const startH = area.getBoundingClientRect().height
    document.body.classList.add('ed-row-resizing')
    const move = (ev: PointerEvent) => setH(startH + startY - ev.clientY)
    const up = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
      document.body.classList.remove('ed-row-resizing')
      lsSet('bento-notes-h', String(Math.round(area.getBoundingClientRect().height)))
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  })
  grip.addEventListener('dblclick', () => { setH(DEFAULT_H); lsSet('bento-notes-h', String(DEFAULT_H)) })
  // the cap is half the window, so a window made shorter must not leave the
  // canvas squeezed to nothing under a pane sized for a taller one
  window.addEventListener('resize', () => setH(Number(lsGet('bento-notes-h')) || DEFAULT_H), { signal })
  pane.append(grip, head, area)
  into.appendChild(pane)

  const setOpen = (open: boolean) => {
    pane.classList.toggle('closed', !open)
    head.classList.toggle('closed', !open)
    head.setAttribute('aria-expanded', String(open))
    if (!toggle.firstElementChild) toggle.innerHTML = ICONS.chevron
    toggle.dataset.dir = open ? 'down' : 'up' // down folds, up opens
    toggle.title = open ? t('Hide speaker notes') : t('Show speaker notes')
  }
  // Open by default where there is room; on a phone or a short window the
  // canvas comes first (the 700px drawer breakpoint), until the author opens it.
  const saved = lsGet('bento-notes-open')
  setOpen(saved ? saved !== '0' : window.innerWidth > 700 && window.innerHeight > 600)
  const flip = () => {
    const open = pane.classList.contains('closed')
    setOpen(open)
    lsSet('bento-notes-open', open ? '1' : '0')
  }
  head.addEventListener('click', flip)
  // the side panels' chevron, laid on its side: one click folds the pane
  toggle.addEventListener('click', (ev) => { ev.stopPropagation(); flip() })
  toggle.addEventListener('pointerdown', (ev) => ev.stopPropagation()) // a click, not a drag

  // the slide being typed into, fixed for the length of one burst
  let editing: string | null = null
  const write = (final: boolean) => {
    if (store.readOnly) return
    if (!editing) { editing = store.slide.id; store.checkpoint() }
    const slide = store.slideById(editing)
    if (slide) { slide.notes = area.value; store.touch() }
    if (final) editing = null
  }
  area.addEventListener('input', () => write(false))
  area.addEventListener('change', () => write(true))

  // Follow the slide, and remote edits — but never under a caret.
  const sync = () => {
    area.readOnly = store.readOnly
    if (document.activeElement === area) return
    const v = store.slide?.notes ?? ''
    if (area.value !== v) area.value = v
  }
  area.addEventListener('blur', sync) // a slide may have changed while it held the caret
  area.addEventListener('focus', () => { area.readOnly = store.readOnly }) // reader mode may have begun after mount
  const offs = [store.on('current', sync), store.on('doc', sync)]
  signal.addEventListener('abort', () => offs.forEach((off) => off()), { once: true })
  sync()
}
