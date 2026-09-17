// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
/**
 * Typed bullets become real lists when the edit ends (discussion #502).
 *
 * Typing "- " puts a bullet GLYPH in the text ("•" + NBSP; "◦" for an
 * indented sub-bullet) — markdown.ts explains why it is a glyph and not a
 * list item while you type: converting the line under the caret moves the
 * caret and captures Enter. But a glyph is inline text, so a long bullet
 * wraps back to the box's left edge, under the bullet. A real `<li>` hangs
 * its wrapped lines under the text (styles.css: list-style-position outside,
 * padding-inline-start), which is what a reader expects.
 *
 * So the conversion happens at COMMIT, on the sanitized html of the whole
 * box, and it is a pure string function: a run of consecutive lines that
 * begin with the glyph becomes one `<ul>`, an indented "◦" line nests one
 * level under the item before it. Lines are what `<br>` separates (and what
 * contentEditable's `<div>` blocks separate — those are folded to `<br>`
 * first, ONLY when there is a glyph line to convert, so a box without typed
 * bullets is returned byte-identical). Everything else — text between runs,
 * lists the formatting bar already made, a glyph in the middle of a line —
 * is left exactly as it was. Converting the result again changes nothing.
 *
 * Table cells are NOT converted: a cell has no list styling and its bullets
 * are usually single lines.
 */

// The glyph's NBSP survives typing as an NBSP, an &nbsp; entity, or — once
// a character follows it — a plain space Chrome normalised it to; all three
// are the same bullet. The indent before a sub-bullet is the same mix.
const NB = '(?:\u00a0|&nbsp;| )'
const TOP = new RegExp(`^\u2022${NB}`)
const SUB = new RegExp(`^${NB}{2,}\u25e6${NB}`)

// A line that carries list markup of its own is already inside a list the
// formatting bar made (a glyph typed inside an <li>); it is not converted.
const LIST_TAG = /<\/?(?:li|ul|ol)\b/i
const isBullet = (l: string) => (TOP.test(l) || SUB.test(l)) && !LIST_TAG.test(l)

/** Does this html contain a line that starts with a typed bullet? */
export function hasTypedBullets(html: string): boolean {
  return splitLines(html).some(isBullet)
}

/** `<br>` and contentEditable's `<div>…</div>` blocks both end a line. */
function splitLines(html: string): string[] {
  // a closing div followed by another div, or by the end, breaks nothing by
  // itself (the next opener or the end does); one followed by inline content
  // starts a new line; an opener starts a new line unless it opens the box
  const folded = html
    .replace(/<\/div>(?=\s*(?:<div>|$))/gi, '')
    .replace(/<\/div>/gi, '<br>')
    .replace(/<div>/gi, (_m, off: number) => (off === 0 ? '' : '<br>'))
  return folded.split(/<br\s*\/?>/i)
}

/** Glyph lines → real lists; anything else untouched. Idempotent. */
export function bulletsToLists(html: string): string {
  if (!hasTypedBullets(html)) return html
  const lines = splitLines(html)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!isBullet(line)) { out.push(line); i++; continue }
    // a run of bullet lines → one list; a sub-bullet nests under the item
    // before it (a run that opens with a sub-bullet gets an empty parent item)
    let list = '<ul>'
    let openSub = false
    let openItem = false
    while (i < lines.length && isBullet(lines[i])) {
      const l = lines[i]
      if (SUB.test(l)) {
        if (!openItem) { list += '<li>'; openItem = true }
        if (!openSub) { list += '<ul>'; openSub = true }
        list += `<li>${l.replace(SUB, '')}</li>`
      } else {
        if (openSub) { list += '</ul>'; openSub = false }
        if (openItem) { list += '</li>'; openItem = false }
        list += `<li>${l.replace(TOP, '')}`
        openItem = true
      }
      i++
    }
    if (openSub) list += '</ul>'
    if (openItem) list += '</li>'
    list += '</ul>'
    out.push(list)
  }
  // a list is a block: no <br> needed around it
  return out.reduce((acc, piece, k) => {
    if (k === 0) return piece
    const prevBlock = /<\/ul>$/.test(acc)
    const thisBlock = /^<ul>/.test(piece)
    return acc + (prevBlock || thisBlock ? '' : '<br>') + piece
  }, '')
}
