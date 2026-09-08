// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The formatting bar that follows a text selection.
//
// It exists because the formatting a box already SUPPORTS had no handle on it:
// bold/italic/underline were reachable only by ⌘B/⌘I/⌘U or by typing markdown,
// which is knowledge the interface never offers, and lists and headings could
// not be made at all. Selecting words and being shown what can be done to them
// is how every editor answers that.
//
// Commands go through `document.execCommand`. It is deprecated and it is also
// the only API that edits a contenteditable's DOM *and* the browser's own undo
// stack together — the editor already relies on that for ⌘B/⌘I/⌘U, and a
// hand-rolled Range implementation that did not feed native undo would be a
// worse answer, not a more modern one.

import { t } from '../i18n'

/**
 * Make execCommand emit TAGS (`<b>`, `<i>`, `<u>`) instead of styled spans.
 *
 * This is not a preference, it is a correctness requirement: the sanitizer
 * strips every attribute, so a `<span style="font-weight:bold">` reaches the
 * document as a bare `<span>` and the formatting is silently gone. Browsers
 * pick the CSS form on their own — Chrome did it here the moment the box's own
 * font-weight made "bold" a toggle-OFF — so the mode has to be set explicitly
 * before every command rather than assumed.
 *
 * Both the bar and the ⌘B/⌘I/⌘U handler go through here, so neither can drift.
 */
export function execFormat(name: string, value?: string) {
  try {
    document.execCommand('styleWithCSS', false, 'false')
  } catch {
    /* older engines: the default is already the tag form */
  }
  document.execCommand(name, false, value)
}

/** Which commands the bar exposes, in the order they are shown. */
type Cmd =
  | { kind: 'exec'; name: string; label: string; title: string; glyph: string }
  | { kind: 'block'; tag: 'H1' | 'H2' | 'P'; label: string; title: string; glyph: string }
  | { kind: 'code'; label: string; title: string; glyph: string }
  | { kind: 'clear'; label: string; title: string; glyph: string }
  | 'sep'

let bar: HTMLElement | null = null
let host: HTMLElement | null = null
let detach: (() => void) | null = null

/** Is the bar currently up? */
export function formatBarOpen() {
  return !!bar
}

export function hideFormatBar() {
  detach?.()
  detach = null
  bar?.remove()
  bar = null
  host = null
}

/**
 * Show (or re-place) the bar for a selection inside `editable`. Called on every
 * selection change while a text box is open; hides itself when the selection
 * collapses to a caret, because a bar over a caret has nothing to act on and
 * would just cover the words being typed.
 */
export function syncFormatBar(editable: HTMLElement) {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return hideFormatBar()
  const range = sel.getRangeAt(0)
  if (!editable.contains(range.commonAncestorContainer)) return hideFormatBar()
  const rect = range.getBoundingClientRect()
  if (!rect.width && !rect.height) return hideFormatBar()

  if (!bar || host !== editable) {
    hideFormatBar()
    bar = build(editable)
    host = editable
    document.body.appendChild(bar)
    // A press inside the bar must not move the caret out of the text, or the
    // command would run against a collapsed selection somewhere else.
    const keep = (ev: Event) => ev.preventDefault()
    bar.addEventListener('pointerdown', keep)
    bar.addEventListener('mousedown', keep)
    detach = () => {
      bar?.removeEventListener('pointerdown', keep)
      bar?.removeEventListener('mousedown', keep)
    }
  }
  place(bar, rect)
  refresh(bar)
}

// A keyboard symbol is not prose, so the shortcut is appended rather than
// baked into a second catalog key for every button that has one.
const withKey = (label: string, key?: string) => (key ? `${label} (${key})` : label)

const COMMANDS = (): Cmd[] => {
  // `Title` on its own is already the DECK's title in the About dialog, and one
  // English word with two meanings is one key too few (docs/DECISIONS.md — "One
  // English word, two meanings = two keys"), so the text style is qualified.
  const item = (
    kind: 'exec' | 'block' | 'code' | 'clear',
    glyph: string, label: string, extra: Record<string, string> = {}, key?: string,
  ) => ({ kind, glyph, label, title: withKey(label, key), ...extra }) as Cmd
  return [
    item('exec', 'B', t('Bold'), { name: 'bold' }, '⌘B'),
    item('exec', 'I', t('Italic'), { name: 'italic' }, '⌘I'),
    item('exec', 'U', t('Underline'), { name: 'underline' }, '⌘U'),
    item('exec', 'S', t('Strikethrough'), { name: 'strikeThrough' }),
    item('code', '&lt;/&gt;', t('Code')),
    'sep',
    item('block', 'H1', t('Title text'), { tag: 'H1' }),
    item('block', 'H2', t('Heading'), { tag: 'H2' }),
    item('block', '¶', t('Body text'), { tag: 'P' }),
    'sep',
    item('exec', '•—', t('Bulleted list'), { name: 'insertUnorderedList' }),
    item('exec', '1.', t('Numbered list'), { name: 'insertOrderedList' }),
    'sep',
    item('clear', '⌫', t('Clear formatting')),
  ]
}

function build(editable: HTMLElement): HTMLElement {
  const el = document.createElement('div')
  el.className = 'ed-fmtbar'
  el.setAttribute('role', 'toolbar')
  for (const cmd of COMMANDS()) {
    if (cmd === 'sep') {
      const s = document.createElement('span')
      s.className = 'ed-fmtbar-sep'
      el.appendChild(s)
      continue
    }
    const b = document.createElement('button')
    b.className = 'ed-fmtbar-btn'
    b.innerHTML = cmd.glyph
    b.title = cmd.title
    b.setAttribute('aria-label', cmd.label)
    if (cmd.kind === 'exec') b.dataset.cmd = cmd.name
    if (cmd.kind === 'block') b.dataset.block = cmd.tag
    if (cmd.kind === 'code') b.dataset.code = '1'
    b.addEventListener('click', (ev) => {
      ev.preventDefault()
      editable.focus()
      run(cmd, editable)
      // The DOM moved under the selection, so both the bar's position and its
      // pressed states are stale until the next frame.
      requestAnimationFrame(() => syncFormatBar(editable))
    })
    el.appendChild(b)
  }
  return el
}

function run(cmd: Exclude<Cmd, 'sep'>, editable: HTMLElement) {
  if (cmd.kind === 'exec') {
    execFormat(cmd.name)
    return
  }
  if (cmd.kind === 'clear') {
    execFormat('removeFormat')
    // removeFormat is inline-only by definition; a list or heading is a block
    // and survives it, which reads as "the button did nothing".
    execFormat('formatBlock', 'div')
    return
  }
  if (cmd.kind === 'block') {
    // Toggle: pressing Title on something already a Title returns it to body,
    // so the same button both applies and removes.
    const current = blockTag(editable)
    execFormat('formatBlock', current === cmd.tag ? 'div' : cmd.tag.toLowerCase())
    return
  }
  // `code` has no execCommand. Wrapping the range is enough for the common
  // case (a run inside one text node); anything more tangled falls back to
  // re-inserting the selection's own markup wrapped, which execCommand records
  // on the undo stack for us.
  if (inCode()) {
    unwrapCode(editable)
    return
  }
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
  const range = sel.getRangeAt(0)
  const code = document.createElement('code')
  try {
    range.surroundContents(code)
    sel.removeAllRanges()
    const r = document.createRange()
    r.selectNodeContents(code)
    sel.addRange(r)
  } catch {
    const frag = range.cloneContents()
    const box = document.createElement('div')
    box.appendChild(frag)
    execFormat('insertHTML', `<code>${box.innerHTML}</code>`)
  }
}

/** The nearest block tag the selection sits in, uppercased. */
function blockTag(editable: HTMLElement): string {
  const node = document.getSelection()?.anchorNode
  const el = node instanceof Element ? node : node?.parentElement
  const block = el?.closest('h1,h2,p,div,li')
  if (!block || !editable.contains(block) || block === editable) return 'DIV'
  return block.tagName
}

function inCode(): boolean {
  const node = document.getSelection()?.anchorNode
  const el = node instanceof Element ? node : node?.parentElement
  return !!el?.closest('code')
}

function unwrapCode(editable: HTMLElement) {
  const node = document.getSelection()?.anchorNode
  const el = node instanceof Element ? node : node?.parentElement
  const code = el?.closest('code')
  if (!code || !editable.contains(code)) return
  const parent = code.parentNode
  if (!parent) return
  const first = code.firstChild
  while (code.firstChild) parent.insertBefore(code.firstChild, code)
  code.remove()
  if (first) {
    const sel = document.getSelection()
    const r = document.createRange()
    r.selectNodeContents(parent)
    sel?.removeAllRanges()
    sel?.addRange(r)
  }
}

/**
 * Bold cannot be turned OFF inside a box whose own `fontWeight` is already
 * bold. Every tag in the allowlist is attribute-free, so there is no markup for
 * "lighter than the box" — the browser can only express it as
 * `<span style="font-weight:normal">`, and the sanitizer strips the attribute
 * and leaves an empty span. Removing a `<b>` the selection sits inside IS
 * representable, so that case stays enabled.
 *
 * Disabling it says so, instead of offering a button that quietly does nothing.
 */
function boldWouldVanish(editable: HTMLElement): boolean {
  const base = parseInt(getComputedStyle(editable).fontWeight, 10) || 400
  if (base < 600) return false
  const node = document.getSelection()?.anchorNode
  const el = node instanceof Element ? node : node?.parentElement
  return !el?.closest('b,strong')
}

/** Light up whatever the caret is currently inside. */
function refresh(el: HTMLElement) {
  const editable = host ?? el
  for (const b of Array.from(el.querySelectorAll<HTMLElement>('.ed-fmtbar-btn'))) {
    let on = false
    if (b.dataset.cmd) {
      try {
        on = document.queryCommandState(b.dataset.cmd)
      } catch {
        on = false
      }
    } else if (b.dataset.block) {
      on = blockTag(editable) === b.dataset.block
    } else if (b.dataset.code) {
      on = inCode()
    }
    b.classList.toggle('is-on', on)
    if (b.dataset.cmd === 'bold') {
      const dead = boldWouldVanish(editable)
      b.toggleAttribute('disabled', dead)
      b.title = dead ? t('This text box is already bold') : withKey(t('Bold'), '⌘B')
    }
  }
}

/**
 * Sit above the selection, or below it when there is no room — and never off
 * the side. Measured from the live rect each time, because the selection moves
 * as the user drags through the text.
 */
function place(el: HTMLElement, rect: DOMRect) {
  const pad = 8
  const gap = 10
  // width is only known once it is in the DOM and laid out
  const w = el.offsetWidth || 300
  const h = el.offsetHeight || 38
  let left = rect.left + rect.width / 2 - w / 2
  left = Math.max(pad, Math.min(left, window.innerWidth - w - pad))
  let top = rect.top - h - gap
  if (top < pad) top = Math.min(window.innerHeight - h - pad, rect.bottom + gap)
  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(Math.max(pad, top))}px`
}
