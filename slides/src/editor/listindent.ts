// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Indent and outdent bullets (discussion #368): Tab / Shift+Tab while editing
 * a text box, and the Indent / Outdent buttons in the Typography panel.
 *
 * No new format. A sub-bullet is already a list nested in the item before it
 * (`<li>…<ul><li>…</li></ul></li>`) — what bulletsToLists makes of a typed
 * "◦" line and what the formatting bar's lists hold — so this only moves items
 * between those levels, and a deck that never used it renders identically.
 *
 *  - A real list item (`<li>`, any depth): indent moves it into a list nested
 *    at the end of the item before it; outdent moves it back out, after the
 *    item it was nested in, taking the items that followed it along as its
 *    own children (the rule every word processor uses). The first item of a
 *    list cannot indent and a top-level item cannot outdent: both are no-ops.
 *  - A typed bullet glyph not yet committed ("• " / indented "◦ " — see
 *    markdown.ts and bullets.ts): indent turns "•" into the indented "◦" form,
 *    outdent turns it back. Glyphs have the two levels bulletsToLists knows.
 *
 * Every item the selection touches moves (several lines at once), and the
 * caret stays where it was. ⌘Z straight after restores the box (undoIndent),
 * the same one-shot as undoAutoformat, because a DOM move is not in the
 * browser's own undo stack; once the edit ends it is one undo step like any
 * other edit.
 */

const NBSP = ' '
const TOP_GLYPH = /^•[  ]/
const SUB_GLYPH = /^[  ]{2,}◦[  ]/

/** The `<li>`s the selection touches, innermost and in document order. */
function itemsIn(root: HTMLElement, range: Range): HTMLLIElement[] {
  const out = new Set<HTMLLIElement>()
  const own = (n: Node | null) => {
    const li = (n instanceof Element ? n : n?.parentElement)?.closest('li')
    if (li && root.contains(li)) out.add(li as HTMLLIElement)
  }
  if (range.collapsed) { own(range.startContainer); return [...out] }
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (range.intersectsNode(n)) own(n)
  if (!out.size) own(range.startContainer)
  return [...root.querySelectorAll('li')].filter((li) => out.has(li as HTMLLIElement)) as HTMLLIElement[]
}

/** Typed glyph lines the selection touches: a text node that starts a line
 *  (first in its block, or right after a <br>) with "• " or an indented "◦ ". */
function glyphsIn(root: HTMLElement, range: Range): Text[] {
  const lineStart = (t: Text) => !t.previousSibling || t.previousSibling.nodeName === 'BR'
  const isGlyph = (t: Text) => lineStart(t) && (TOP_GLYPH.test(t.data) || SUB_GLYPH.test(t.data)) && !t.parentElement?.closest('li')
  const out: Text[] = []
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    if (!isGlyph(n)) continue
    if (range.intersectsNode(n) || n === range.startContainer) out.push(n)
  }
  return out
}

function indentItem(li: HTMLLIElement): boolean {
  const prev = li.previousElementSibling
  if (!prev || prev.tagName !== 'LI') return false
  let sub = prev.lastElementChild
  if (!sub || (sub.tagName !== 'UL' && sub.tagName !== 'OL')) {
    sub = document.createElement(li.parentElement!.tagName.toLowerCase())
    prev.appendChild(sub)
  }
  sub.appendChild(li)
  return true
}

function outdentItem(li: HTMLLIElement): boolean {
  const list = li.parentElement!
  const parentItem = list.parentElement
  if (!parentItem || parentItem.tagName !== 'LI') return false
  // the items after it become its children, so the order on screen holds
  const after: Element[] = []
  for (let s = li.nextElementSibling; s; s = s.nextElementSibling) after.push(s)
  if (after.length) {
    let sub = li.lastElementChild
    if (!sub || (sub.tagName !== 'UL' && sub.tagName !== 'OL')) {
      sub = document.createElement(list.tagName.toLowerCase())
      li.appendChild(sub)
    }
    for (const s of after) sub.appendChild(s)
  }
  parentItem.after(li)
  if (!list.children.length) list.remove()
  return true
}

/** Text offset of a boundary point from the start of root (for restoring a caret). */
export function offsetOf(root: HTMLElement, node: Node, off: number): number {
  const r = document.createRange()
  r.selectNodeContents(root)
  r.setEnd(node, off)
  return r.toString().length
}

export function placeAt(root: HTMLElement, at: number) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let left = at
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    if (left <= n.data.length) {
      const sel = document.getSelection()
      const r = document.createRange()
      r.setStart(n, left); r.collapse(true)
      sel?.removeAllRanges(); sel?.addRange(r)
      return
    }
    left -= n.data.length
  }
}

/** Is the selection in a bullet at all? Tab there is ALWAYS the list's — even
 *  when the step is impossible (first item, top level), it must not fall
 *  through to the browser's Tab and throw focus out of the box mid-list. */
export function inList(root: HTMLElement, range: Range): boolean {
  return itemsIn(root, range).length > 0 || glyphsIn(root, range).length > 0
}

let last: { root: HTMLElement; before: string; after: string; caret: number } | null = null

/**
 * Indent (+1) or outdent (−1) what `range` touches inside `root`. Returns
 * whether anything moved. With `keepCaret` the live selection is restored
 * afterwards and ⌘Z can take the step back (undoIndent).
 */
export function shiftList(root: HTMLElement, range: Range, dir: 1 | -1, keepCaret = false): boolean {
  const items = itemsIn(root, range)
  const glyphs = items.length ? [] : glyphsIn(root, range)
  if (!items.length && !glyphs.length) return false
  const before = root.innerHTML
  const sel = document.getSelection()
  const a = sel && sel.rangeCount ? { node: sel.anchorNode!, off: sel.anchorOffset, focus: sel.focusNode!, foff: sel.focusOffset } : null
  const caret = a && root.contains(a.node) ? offsetOf(root, a.node, a.off) : 0
  let moved = false
  if (items.length) {
    // indent in document order (each joins the list its predecessor opened);
    // outdent in reverse (so a later item never becomes an earlier one's child)
    for (const li of dir > 0 ? items : [...items].reverse()) moved = (dir > 0 ? indentItem(li) : outdentItem(li)) || moved
  } else {
    for (const t of glyphs) {
      const shift = (from: RegExp, to: string, delta: number) => {
        if (!from.test(t.data)) return
        const m = t.data.match(from)![0]
        t.replaceData(0, m.length, to)
        moved = true
        if (a && a.node === t) a.off = Math.max(0, a.off + delta)
        if (a && a.focus === t) a.foff = Math.max(0, a.foff + delta)
      }
      if (dir > 0) shift(TOP_GLYPH, `${NBSP}${NBSP}◦${NBSP}`, 2)
      else shift(SUB_GLYPH, `•${NBSP}`, -(t.data.match(SUB_GLYPH)?.[0].length ?? 2) + 2)
    }
  }
  if (!moved) return false
  if (keepCaret && a && sel) {
    // the moved text nodes are the same nodes, only re-parented
    try { sel.setBaseAndExtent(a.node, a.off, a.focus, a.foff) } catch { placeAt(root, caret) }
    last = { root, before, after: root.innerHTML, caret }
  }
  return true
}

/** ⌘Z straight after an indent/outdent: put the box back. One-shot — it only
 *  applies while the box is exactly as the step left it. */
export function undoIndent(root: HTMLElement): boolean {
  if (!last || last.root !== root || root.innerHTML !== last.after) return false
  root.innerHTML = last.before
  placeAt(root, last.caret)
  last = null
  return true
}

/** The whole box at once (the panel buttons with nothing open for editing —
 *  the same as Tab after double-clicking in, which selects everything). */
export function shiftListHtml(html: string, dir: 1 | -1): string | null {
  const root = document.createElement('div')
  root.innerHTML = html
  const r = document.createRange()
  r.selectNodeContents(root)
  return shiftList(root, r, dir) ? root.innerHTML : null
}
