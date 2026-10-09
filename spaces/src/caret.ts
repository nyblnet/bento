// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Caret navigation ACROSS blocks.
//
// Every block in a space is its own contenteditable host — that is what keeps
// Selection block-scoped so a split or a merge can never re-mint an id
// (editor.ts says why). The price is that the browser's own caret movement
// stops dead at a block boundary: ↑ and ↓ walk the visual lines INSIDE one
// host and then do nothing, and ← at the start of a block does nothing either.
// Until this file there was no arrow handling in the editor at all, so a
// keyboard could enter a block and could not leave it except by clicking.
//
// FOUR THINGS THIS FILE IS CAREFUL ABOUT.
//
// (1) WITHIN THE BLOCK FIRST. A wrapped paragraph is several visual lines and
//     ↓ from its first line means "the second line", not "the next block". So
//     the question is never "which block am I in" but "is the caret on the
//     EDGE line of its host" — and that is a geometry question, answered by
//     comparing the caret's own rect against the host's line boxes. Counting
//     characters cannot answer it: where a line wraps depends on the font, the
//     width, the language and the marks.
//
// (2) A GOAL COLUMN, because every editor has one. Going down from the middle
//     of a long line onto a short one and down again must come back out near
//     the original x. The column is remembered by the caller across
//     consecutive vertical presses and dropped the moment anything else
//     happens — including a step the BROWSER handles, since inside one host
//     the browser keeps its own goal and ours would fight it.
//
// (3) SEATS, NOT BLOCKS. The things a caret can sit in are `[data-edit]`
//     hosts, `[data-cell]` table cells and the page title — three different
//     names for the same idea, and nesting (a callout, a toggle, a canvas
//     card) is already expressed by document order. So the walk is over a flat
//     list of seats in document order, which crosses every container for free.
//     A seat with no box (a shut toggle's children) is not a seat.
//
// (4) THE GEOMETRY IS MEASURED, NEVER WRITTEN BACK. `lineBoxes` asks a Range
//     for its client rects; `caretBox` asks the collapsed selection for its
//     own. Both can legitimately answer nothing (an empty host has no text to
//     measure), and every caller has to survive that — which is why the pure
//     predicates below take boxes as data and are testable without a DOM.

/** A rectangle, as much of one as anything here needs. */
export interface Box { left: number; top: number; right: number; bottom: number }

/** The three things a caret can sit in. Document order is the walk order. */
export const SEAT_SEL = '[data-edit],[data-cell],[data-page-title]'

/**
 * Is the caret on the FIRST (dir -1) or LAST (dir +1) visual line of its host?
 *
 * Pure, and the one decision that makes ↑/↓ feel native — answer it wrong and
 * a wrapped paragraph either traps the caret or is skipped over entirely.
 *
 * The test is vertical CONTAINMENT of the caret's midpoint in the edge line's
 * box, not equality of tops: a caret sitting next to a taller inline (a code
 * span, an image, a bigger font) has a shorter rect than the line it is on, so
 * `caret.top === line.top` is false on a line the caret is plainly inside.
 *
 * With no line boxes at all — an empty block, a block whose only content is a
 * widget — every direction is an edge, which is the behaviour that lets ↑ and
 * ↓ cross an empty paragraph rather than stalling on it.
 */
export function onEdgeLine(caret: Box, lines: Box[], dir: -1 | 1): boolean {
  if (!lines.length) return true
  const mid = (caret.top + caret.bottom) / 2
  const edge = dir < 0 ? lines[0] : lines[lines.length - 1]
  // half a pixel of slack: sub-pixel line heights are normal at browser zoom
  return dir < 0 ? mid < edge.bottom - 0.5 : mid > edge.top + 0.5
}

/**
 * The index of the seat a vertical or horizontal step lands in, or -1.
 *
 * Document order, deliberately: a callout's children, a toggle's children and
 * a canvas card's text are all rendered inside their container, so "the next
 * thing in the document" is already "the next thing on the screen" for every
 * container this app has. The ONE exception is a table, whose cells are
 * row-major in the DOM and column-major on the screen — tables are stepped by
 * `tableStep` below and never by this.
 */
export function stepSeat(count: number, from: number, dir: -1 | 1): number {
  const next = from + dir
  return next >= 0 && next < count ? next : -1
}

/**
 * The cell a vertical step inside a table lands in, or null to leave the table.
 *
 * Pure grid arithmetic, so the table's Tab handler (editor.ts `tableKey`) and
 * this never have to agree about anything but the numbers.
 */
export function tableStep(
  at: { r: number; c: number }, size: { w: number; h: number }, dir: -1 | 1,
): { r: number; c: number } | null {
  const r = at.r + dir
  return r >= 0 && r < size.h ? { r, c: at.c } : null
}

/**
 * Which of a row of boxes is nearest a goal column.
 *
 * Used when a step ENTERS a table from outside: the seat that happens to be
 * next in document order is the first cell of the first row, which is the
 * wrong column whenever the caret was not at the left margin. Distance is to
 * the box, not to its centre — a wide first column should not win a caret that
 * is sitting over the narrow third one.
 */
export function nearestByX(boxes: Box[], x: number): number {
  let best = -1
  let bestD = Infinity
  boxes.forEach((b, i) => {
    const d = x < b.left ? b.left - x : x > b.right ? x - b.right : 0
    if (d < bestD) { bestD = d; best = i }
  })
  return best
}

// ---- the DOM half -----------------------------------------------------------

/** Every seat that is actually on screen, in document order. */
export function seatsIn(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SEAT_SEL))
    // a shut toggle's children, a hidden column: no box, not a seat. `offsetParent`
    // is null for `display:none` and for nothing else that matters here.
    .filter((s) => s.offsetParent !== null || s === document.activeElement)
}

/**
 * Merge a Range's client rects into ONE BOX PER VISUAL LINE.
 *
 * `Range.getClientRects()` returns a rect per inline BOX, not per line: a
 * sentence containing `<strong>` or a link comes back as three or four rects
 * that all share the same line. Measured on the starter space's first
 * paragraph: two visual lines, FIVE rects.
 *
 * Both callers are wrong without this merge, in different ways. `onEdgeLine`
 * reads `lines[0]` as "the first line", which is only the first FRAGMENT of
 * it. `placeCaretAtX` clamps the goal column into the edge line's box — into
 * the first fragment's 555–983, so a column at x=1150 would land at 983 and
 * the rest of the line would be unreachable.
 *
 * Pure over rects, so the grouping is testable without a browser.
 */
export function mergeLines(rects: readonly Box[]): Box[] {
  const out: Box[] = []
  for (const r of rects) {
    const mid = (r.top + r.bottom) / 2
    // by the fragment's MIDPOINT inside an existing band, not by equal tops: a
    // taller inline on the same line has a taller box
    const g = out.find((o) => mid > o.top && mid < o.bottom)
    if (g) {
      g.left = Math.min(g.left, r.left); g.right = Math.max(g.right, r.right)
      g.top = Math.min(g.top, r.top); g.bottom = Math.max(g.bottom, r.bottom)
    } else out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom })
  }
  return out.sort((a, b) => a.top - b.top)
}

/** The visual lines of a host's contents, one box each, in order. */
export function lineBoxes(host: HTMLElement): Box[] {
  const r = document.createRange()
  r.selectNodeContents(host)
  return mergeLines(Array.from(r.getClientRects()).filter((b) => b.width > 0 || b.height > 0))
}

/**
 * The caret's own rectangle.
 *
 * A collapsed Range has zero width and — at a position between two nodes —
 * sometimes no client rects at all, which is why `getBoundingClientRect` is
 * the fallback and an all-zero result is discarded rather than believed: a
 * rectangle at the top-left corner of the window would put the caret above
 * every block on the page.
 *
 * THE LAST FALLBACK IS THE HOST'S OWN BOX, and it is not defensive padding —
 * it is the EMPTY BLOCK. An empty paragraph has no text to measure, so the
 * range has no rects and the contents have no line boxes; returning null there
 * made ↑ and ↓ stop dead on it, which is worse than the bug this file fixes
 * because an empty paragraph is exactly where a caret waits. Measured in the
 * built shell: without this, ↓ out of an empty block did nothing at all.
 */
export function caretBox(host: HTMLElement): Box | null {
  const sel = getSelection()
  if (!sel || !sel.rangeCount) return null
  const r = sel.getRangeAt(0)
  if (!host.contains(r.startContainer)) return null
  const rects = r.getClientRects()
  const b = rects.length ? rects[rects.length - 1] : r.getBoundingClientRect()
  if (b && (b.width || b.height || b.top || b.left)) return b
  // NOTHING. Measured in the built shell at the end of the starter space's
  // first paragraph: a range collapsed at an ELEMENT boundary (container = the
  // host, offset = its child count) reports no rects and an all-zero bounding
  // box. Falling back to a line box here picked the FIRST line, so ↓ at the end
  // of a two-line paragraph decided it was still on line one and never left
  // the block — the exact bug this file exists to fix, reintroduced.
  //
  // So widen by one unit and read the edge of what that covers: the character
  // (or node) before the caret gives its right edge, the one after gives its
  // left. Both are zero-width boxes on the caret's own line.
  const back = edgeOf(r, -1)
  if (back) return back
  const fwd = edgeOf(r, 1)
  if (fwd) return fwd
  // an empty block: nothing to measure at all, and the host's box is the line
  return host.getBoundingClientRect()
}

/**
 * Widen a collapsed range by one unit and return the zero-width box at the
 * caret's side of it — the right edge going back, the left edge going forward.
 * Null when there is nothing in that direction to measure.
 */
function edgeOf(r: Range, dir: -1 | 1): Box | null {
  const p = r.cloneRange()
  const node = dir < 0 ? p.startContainer : p.endContainer
  const off = dir < 0 ? p.startOffset : p.endOffset
  const limit = node.nodeType === 3 ? (node.textContent ?? '').length : node.childNodes.length
  if (dir < 0 ? off <= 0 : off >= limit) return null
  try { if (dir < 0) p.setStart(node, off - 1); else p.setEnd(node, off + 1) } catch { return null }
  const rects = Array.from(p.getClientRects()).filter((b) => b.width > 0 || b.height > 0)
  if (!rects.length) return null
  const b = dir < 0 ? rects[rects.length - 1] : rects[0]
  const x = dir < 0 ? b.right : b.left
  return { left: x, right: x, top: b.top, bottom: b.bottom }
}

/** Is the caret collapsed at the very end of `host`? (the mirror of atStart) */
export function atEndOf(host: HTMLElement): boolean {
  const sel = getSelection()
  if (!sel || !sel.rangeCount) return false
  const r = sel.getRangeAt(0)
  if (!r.collapsed) return false
  const probe = r.cloneRange()
  probe.selectNodeContents(host)
  probe.setStart(r.endContainer, r.endOffset)
  return probe.toString().length === 0
}

/** Put the caret at the very start of `host`. */
export function caretToStart(host: HTMLElement): void {
  const r = document.createRange()
  r.selectNodeContents(host)
  r.collapse(true)
  const sel = getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}

/** Put the caret at the very end of `host`. */
export function caretToEndOf(host: HTMLElement): void {
  const r = document.createRange()
  r.selectNodeContents(host)
  r.collapse(false)
  const sel = getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}

/**
 * Put the caret in `host`, on its first or last visual line, as near column
 * `x` as that line reaches.
 *
 * `caretPositionFromPoint` is the honest instrument here — it asks the engine
 * that did the layout where a pixel is in the text, so it is right through
 * bidi text, ligatures, inline images and marks, none of which a character
 * count survives. It can still answer with a node OUTSIDE the host (the point
 * grazed a gutter button, a list marker, a checkbox), so the answer is checked
 * before it is used and the end of the line is the fallback.
 */
export function placeCaretAtX(host: HTMLElement, x: number, line: 'first' | 'last'): void {
  host.focus()
  const boxes = lineBoxes(host)
  const box = line === 'first' ? boxes[0] : boxes[boxes.length - 1]
  if (!box) { caretToEndOf(host); return }
  const y = (box.top + box.bottom) / 2
  const cx = Math.min(Math.max(x, box.left + 0.5), Math.max(box.left + 0.5, box.right - 0.5))
  const hit = caretAt(cx, y)
  if (hit && host.contains(hit.node)) {
    const r = document.createRange()
    try {
      r.setStart(hit.node, hit.offset)
      r.collapse(true)
      const sel = getSelection()
      sel?.removeAllRanges()
      sel?.addRange(r)
      return
    } catch { /* an offset the node cannot take — fall through */ }
  }
  if (line === 'first') caretToStart(host); else caretToEndOf(host)
}

/** `caretPositionFromPoint`, with the WebKit spelling as the fallback. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const pos = d.caretPositionFromPoint?.(x, y)
  if (pos) return { node: pos.offsetNode, offset: pos.offset }
  const range = d.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}
