// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Typing "- " or "* " at the start of a line starts a REAL list at once
 * (discussion #711). It used to type a bullet glyph that only became a list
 * when the box lost focus, so Enter could not continue it. The browser's own
 * list editing now does the rest: Enter in an item starts the next one at the
 * same level, Enter in an empty item ends the list (or outdents a nested
 * one), and Tab / Shift+Tab are listindent.ts as before.
 *
 * Two spaces or more before the marker open a nested list. Typed inside an
 * item that already exists, the marker is not a second bullet (that painted
 * the item's own bullet AND a glyph, #711): it is dropped, and an indented
 * one nests the item. Table cells, inline wrappers and code boxes return
 * null and keep the glyph path in markdown.ts, which commit still converts
 * (bullets.ts), as it does pasted text and decks saved before this.
 */
import { offsetOf, placeAt, shiftList } from './listindent.ts'

const BLOCK = new Set(['DIV', 'P', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'PRE', 'TABLE'])
const isZw = (n: Node) => n.nodeType === Node.TEXT_NODE && /^[​]*$/.test((n as Text).data)

/** What ⌘Z needs to take the conversion back. */
export interface ListUndo { root: HTMLElement; before: string; after: string; caret: number }

export function typedListAtCaret(node: Text, off: number): ListUndo | null {
  const m = node.data.slice(0, off).match(/^([  ]{2,})?[-*][  ]$/)
  if (!m) return null
  const root = node.parentElement?.closest<HTMLElement>('.bento-text-inner')
  if (!root || root.classList.contains('bento-code') || root.contentEditable !== 'true') return null
  const parent = node.parentNode as HTMLElement
  const inItem = parent.tagName === 'LI'
  if (!(parent === root || (parent.tagName === 'DIV' && parent.parentNode === root) || inItem)) return null
  // the marker must open its line: nothing but caret spacers before it
  let first: Node = node
  while (first.previousSibling && isZw(first.previousSibling)) first = first.previousSibling
  const prev = first.previousSibling
  if (prev && !(prev.nodeName === 'BR' || BLOCK.has(prev.nodeName))) return null

  const before = root.innerHTML
  const caret = offsetOf(root, node, off)
  const indented = !!m[1]
  node.data = node.data.slice(off)
  for (let n = first; n !== node;) { const next = n.nextSibling!; n.parentNode!.removeChild(n); n = next }

  if (inItem) {
    const r = document.createRange()
    r.setStart(parent, 0); r.collapse(true)
    if (indented) shiftList(root, r, 1)
    keepOpen(parent)
    land(parent)
    return { root, before, after: root.innerHTML, caret }
  }

  // the line: this node and what follows it up to the next <br> or block
  const line: Node[] = []
  for (let n: Node | null = node; n && n.nodeName !== 'BR' && !(n instanceof HTMLElement && BLOCK.has(n.tagName)); n = n.nextSibling) line.push(n)
  const li = document.createElement('li')
  const wholeDiv = parent !== root && line.length === parent.childNodes.length
  const anchor: Node = wholeDiv ? parent : line[0]
  const after = anchor === parent ? parent.nextSibling : line[line.length - 1].nextSibling
  // a <br> either side ends a line the list now makes redundant (bullets.ts
  // drops the same ones at commit, so the live box matches what is saved)
  if (after?.nodeName === 'BR') after.remove()
  if (anchor.previousSibling?.nodeName === 'BR') anchor.previousSibling.remove()
  const host = anchor.parentNode!
  const mark = document.createComment('')
  host.insertBefore(mark, anchor)
  li.append(...line)
  if (wholeDiv) parent.remove()

  const tail = mark.previousSibling
  let list: HTMLElement | null = tail instanceof HTMLElement && tail.tagName === 'UL' ? tail : null
  if (!indented) {
    if (!list) { list = document.createElement('ul'); host.insertBefore(list, mark) }
    list.append(li)
  } else {
    if (!list) {
      list = document.createElement('ul')
      list.append(document.createElement('li'))
      host.insertBefore(list, mark)
    }
    const owner = list.lastElementChild as HTMLElement
    let sub = owner.lastElementChild as HTMLElement | null
    if (!sub || sub.tagName !== 'UL') { sub = document.createElement('ul'); owner.append(sub) }
    sub.append(li)
  }
  mark.remove()
  keepOpen(li)
  land(li)
  return { root, before, after: root.innerHTML, caret }
}

/** An item with nothing in it needs a <br> or it has no line to hold a caret. */
function keepOpen(li: HTMLElement) {
  for (const c of [...li.childNodes]) if (c.nodeType === Node.TEXT_NODE && !(c as Text).data) c.remove()
  if (![...li.childNodes].some((c) => c.nodeName !== 'UL' && c.nodeName !== 'OL' && !isZw(c))) li.prepend(document.createElement('br'))
}

function land(li: HTMLElement) {
  const r = document.createRange()
  const t = li.firstChild
  if (t instanceof Text) r.setStart(t, 0); else r.setStart(li, 0)
  r.collapse(true)
  const sel = document.getSelection()
  sel?.removeAllRanges(); sel?.addRange(r)
}

/** ⌘Z straight after the conversion: the typed marker comes back. Only while
 *  the box is exactly as the conversion left it. */
export function undoTypedList(u: ListUndo): boolean {
  if (!u.root.isConnected || u.root.innerHTML !== u.after) return false
  u.root.innerHTML = u.before
  placeAt(u.root, u.caret)
  return true
}

/** Enter in an EMPTY nested item outdents it one level. The browser's own
 *  version lifts the item out of its list and strands the rest as a bare
 *  list inside a list, so this does it with the same move Shift+Tab makes.
 *  An empty top-level item is left to the browser, which ends the list. */
export function enterInEmptyNested(root: HTMLElement): boolean {
  const sel = document.getSelection()
  if (!sel?.isCollapsed || !sel.anchorNode || !root.contains(sel.anchorNode)) return false
  const li = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement)?.closest('li')
  if (!li || !root.contains(li) || li.parentElement?.parentElement?.tagName !== 'LI') return false
  if ((li.textContent ?? '').replace(/\u200b/g, '') || li.querySelector('ul,ol')) return false
  const r = document.createRange()
  r.selectNodeContents(li); r.collapse(true)
  return shiftList(root, r, -1, true)
}
