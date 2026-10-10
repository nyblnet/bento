// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Find and replace over inline html.
//
// Its own module, with NO DOM dependency, for one reason: the number the
// interface shows and the number of things that change must be the same
// number, and that is a property worth testing directly rather than by
// clicking. Both functions are built on one traversal, so they cannot drift.

/**
 * Walk the TEXT of an inline-html string, tag by tag, mapping each text chunk.
 *
 * THE single definition of "where a match can be", shared by counting and
 * replacing so the two can never disagree. A count derived any other way — from
 * `textOf()`, say — would promise replacements that cannot happen: `wid<b>get
 * </b>` reads as one word but is two chunks, so it counts once and replaces
 * never. Telling someone "3 found" and changing 2 is the bug this shape exists
 * to make impossible.
 */
function mapTextChunks(html: string, fn: (chunk: string) => string): string {
  const out: string[] = []
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    const chunk = lt < 0 ? html.slice(i) : html.slice(i, lt)
    out.push(fn(chunk))
    if (lt < 0) break
    const gt = html.indexOf('>', lt)
    if (gt < 0) { out.push(html.slice(lt)); break }
    out.push(html.slice(lt, gt + 1))   // the tag itself, untouched
    i = gt + 1
  }
  return out.join('')
}

/** How many times `needle` would actually be replaced in this block. */
export function countOutsideTags(html: string | undefined, needle: string): number {
  if (!html || !needle) return 0
  const lowerNeedle = needle.toLowerCase()
  let n = 0
  mapTextChunks(html, (chunk) => {
    const lower = chunk.toLowerCase()
    for (let from = 0; ;) {
      const at = lower.indexOf(lowerNeedle, from)
      if (at < 0) return chunk
      n++
      from = at + needle.length
    }
  })
  return n
}

export function replaceOutsideTags(html: string, needle: string, withText: string): string {
  if (!needle) return html
  // CASE-INSENSITIVE, to match the search that produced the count. A
  // case-sensitive replace behind a case-insensitive find is the worst kind of
  // mismatch: it reports "14 found" and quietly changes nine of them.
  const lowerNeedle = needle.toLowerCase()
  return mapTextChunks(html, (chunk) => {
    const lower = chunk.toLowerCase()
    let out = ''
    let from = 0
    for (;;) {
      const at = lower.indexOf(lowerNeedle, from)
      if (at < 0) { out += chunk.slice(from); return out }
      out += chunk.slice(from, at) + withText
      from = at + needle.length
    }
  })
}
