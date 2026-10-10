// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The block format row — bullet, number, to-do, quote, headings, indent.
//
// WHY IT IS NOT IN THE FORMAT BAR, which is where it was first asked for.
//
// `formatbar.ts` appears on a SELECTION and everything in it is inline: bold,
// italic, colour, link. "Make this a bullet" is not a thing you do to selected
// words — you do it with a caret sitting in a block and nothing selected,
// which is precisely the state in which that bar does not exist. Putting block
// controls there would mean the only way to reach them is to select text you
// did not want to change, and on a phone the bar shares its 40 pixels with
// iOS's own Copy / Look Up callout, which is why it is a bottom dock there
// already. There is no room and no trigger.
//
// WHERE THEY LIVE INSTEAD: the block menu — the one the gutter grip opens, and
// the one that is already a bottom SHEET on a phone. It is per-block by
// construction, so it works with a caret and no selection; the grip is the one
// gutter control a phone keeps (styles.css hides the add-ghost below 700px and
// leaves the grip), so it works on touch; and it was already the home of every
// other whole-block action — move, duplicate, comment, delete. One surface for
// "things you do to this block" rather than two.
//
// WHAT WAS MISSING BEFORE: the menu's only route to a list was "Turn into…",
// which opens the slash menu — two steps, behind a label that does not say the
// word "list". The row puts the eight types a writer reaches for on one tap,
// and adds the two controls that existed on NO surface at all, at any width:
// indent and outdent. Tab and Shift+Tab were their only gesture, and a phone
// keyboard has neither.
//
// THE KEYBOARD ROUTE IS NOT OPTIONAL. The gutter is hover-revealed, so a
// keyboard cannot reach the grip by tabbing to it from inside a block (Tab in
// a block is indent). ⌘/ opens this menu on the focused block — the same key
// Notion spends on the same question — and it is in the help overlay.
//
// The disabled indent button carries the REASON as its title and its
// aria-label rather than merely greying out; that is the same refusal
// nesting.ts documents, said before the key is pressed instead of after.

import { t } from './i18n'
import { ICONS, type IconName } from './icons'

/** What the row needs from the editor around it. */
export interface BlockBarHost {
  /** the block's current type, so the active control can be shown as pressed */
  type: string
  /** false when this block is the first at its level — see nesting.ts */
  canIndent: boolean
  canOutdent: boolean
  /** why indent is refused, already localized — shown on the disabled control */
  indentRefusal: string
  setType(type: string): void
  indent(deeper: boolean): void
}

/**
 * The row, as one element.
 *
 * Labels are `t()` calls on LITERALS at this call site. A table of keys fed
 * through `t(MAP[k])` compiles, runs, reaches no catalog and still reports
 * 100% packed — so the strings are written out, and they are written out in
 * the same words the slash menu uses for the same types.
 */
export function blockFormatRow(h: BlockBarHost): HTMLElement {
  const row = document.createElement('div')
  row.className = 'sp-blockbar'
  row.setAttribute('role', 'group')
  row.setAttribute('aria-label', t('Block format'))

  const types: Array<[IconName, string, string]> = [
    ['text', 'p', t('Text')],
    ['h1', 'h1', t('Heading 1')],
    ['h2', 'h2', t('Heading 2')],
    ['h3', 'h3', t('Heading 3')],
    ['bullet', 'bullet', t('Bulleted list')],
    ['number', 'number', t('Numbered list')],
    ['todo', 'todo', t('To-do')],
    ['quote', 'quote', t('Quote')],
  ]

  for (const [icon, type, label] of types) {
    const b = button(icon, label)
    const on = h.type === type
    b.setAttribute('aria-pressed', on ? 'true' : 'false')
    if (on) b.classList.add('sp-sel')
    b.addEventListener('click', () => h.setType(type))
    row.append(b)
  }

  row.append(el('span', 'sp-blockbar-gap'))

  const out = button('outdent', t('Move back out'))
  out.addEventListener('click', () => h.indent(false))
  disable(out, !h.canOutdent, t('This block is not nested'))
  row.append(out)

  const inn = button('indent', t('Indent'))
  inn.addEventListener('click', () => h.indent(true))
  disable(inn, !h.canIndent, h.indentRefusal)
  row.append(inn)

  return row
}

function button(icon: IconName, label: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = 'sp-blockbtn'
  b.type = 'button'
  b.innerHTML = ICONS[icon]
  b.title = label
  b.setAttribute('aria-label', label)
  return b
}

/**
 * Off, and SAYING WHY.
 *
 * `aria-disabled` rather than `disabled`: a disabled button is removed from
 * the tab order, so the one control whose whole job is to explain itself would
 * be the one a keyboard could not reach to read the explanation off. It stays
 * focusable, announces itself as unavailable, and carries the reason.
 */
function disable(b: HTMLButtonElement, off: boolean, why: string): void {
  if (!off) return
  b.classList.add('sp-off')
  b.setAttribute('aria-disabled', 'true')
  b.title = `${b.title} — ${why}`
  b.setAttribute('aria-label', b.title)
}

function el(tag: string, cls: string): HTMLElement {
  const n = document.createElement(tag)
  n.className = cls
  return n
}
