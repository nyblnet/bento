// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// FOOTNOTES: a mark in the prose, the note at the foot of the page.
//
// The whole of this file is PURE — no DOM, no import that touches one — so
// scripts/test-spaces-model.ts imports it directly and asserts the parts that
// actually break: the numbering under an insert, the markdown round trip, an
// orphaned note and a dangling reference.
//
// ---------------------------------------------------------------------------
// THE SHAPE
// ---------------------------------------------------------------------------
//
//   doc.footnotes: { "<label>": "<inline html>" }        the notes, doc-level
//   block.html:    "…as measured[^1] last week…"          the references
//
// The doc-level, id-keyed map is bento/type's (type/src/model.ts): a note has
// to be able to outlive the paragraph that points at it, and keying it by id
// means moving a paragraph between pages carries nothing but the reference.
//
// ---------------------------------------------------------------------------
// THE ANCHOR, WHICH IS THE ONE THING THAT DOES NOT CARRY OVER FROM type
// ---------------------------------------------------------------------------
//
// type anchors a reference by CHARACTER OFFSET into a block's `text` runs
// (`NoteRef { id, at }`). It can: a run list has stable offsets, and type
// rewrites every offset when the text changes, in one place.
//
// A spaces block carries `html`, not runs, and an offset into html is not a
// position — it is a position in one particular SERIALIZATION of a position.
// Three things move it without changing a word of the prose:
//
//   · `canonicalize()` runs at every typing-run close. It reorders nesting
//     (`<i><b>x</b></i>` → `<b><i>x</i></b>`), coalesces adjacent runs and
//     drops empty ones. Byte offsets after the first mark are different
//     afterwards; the text is identical.
//   · `sanitizeInline()` runs on EVERY read of untrusted html, including at
//     render time. It unwraps `<p>`, strips an href that fell out of the
//     allowlist, filters class tokens. Every one of those changes the length
//     of the string before the offset.
//   · The CRDT holds `html` as one register and merges concurrent edits at the
//     token level; an offset stored in a SECOND register cannot merge with it.
//
// So the reference is not stored beside the html. It is stored IN it, as text:
//
//     [^label]
//
// A LITERAL TEXT TOKEN, and the reasons it wins are the reasons calc.ts gives
// for storing `budget * 0.3 =` rather than the answer:
//
//  · IT MOVES WITH THE PROSE FOR FREE. Typing before it, bolding around it,
//    merging two blocks, splitting one, a sanitize pass, a canonicalize pass,
//    a CRDT merge — the token is characters, so every one of those carries it
//    exactly the way it carries the word next to it. There is no offset to
//    keep in step because there is no offset.
//  · IT NEEDS NOTHING FROM sanitize.ts. No new tag, no new attribute, no new
//    href scheme. That is not tidiness: an inline construct that needs a new
//    allowlist entry is a ONE-WAY DATA HAZARD, spelled out in sanitize.ts's own
//    comment on HREF_OK — a reference written by this build would be STRIPPED,
//    silently, by every build shipped before it, on the first edit that touched
//    the block. A text token is round-tripped byte-for-byte by every build that
//    has ever existed, including the ones already on people's disks.
//  · AN OLDER BUILD READS IT. `[^1]` in prose is the markdown/pandoc source
//    form; a shell that has never heard of footnotes shows the sentence with
//    `[^1]` in it, which is exactly what the author would have typed in any
//    other editor. Degraded, not lost.
//  · MARKDOWN IS THE IDENTITY FUNCTION on the reference half. `[^1]` in,
//    `[^1]` out, no conversion, nothing to get wrong.
//  · IT IS GREPPABLE. ⌘F, the search index and `textOf()` all see it, because
//    it is text.
//
// The cost, stated plainly: while you are EDITING a block you see `[^1]`, not
// a superscript 1. That is deliberate and it is the same trade render.ts makes
// for magic notes — the model holds what you wrote and the DERIVED form is
// drawn where it cannot be typed into. Injecting the marker markup into the
// contenteditable host would put it one keystroke away from being committed
// into `html` (`host.innerHTML` is written to the model on every `input`), at
// which point the note is a literal "1" and the reference is gone. That is a
// data-loss-shaped bug and no amount of care on the read-back path makes it
// not one.
//
// ---------------------------------------------------------------------------
// THE NUMBER IS DERIVED, NEVER STORED
// ---------------------------------------------------------------------------
//
// Footnotes are numbered by ORDER OF APPEARANCE, so inserting one renumbers
// everything after it. calc.ts and slides' dynamic fields settle this: store
// the token, derive the output. A stored number is wrong the moment a sentence
// moves, and nothing tells the author it went wrong.
//
// The LABEL is therefore an identifier and not a number, exactly as it is in
// pandoc and Obsidian. `[^1]` moved to the end of the page still says `[^1]`
// in the file and renders as "3". Which is also why the markdown round trip is
// lossless: the label is the thing markdown stores too.
//
// Numbering is PER PAGE. A page is the unit that prints, the unit that is read
// and the unit a note sits at the foot of; numbering the whole space would
// give the third page of a wiki footnote 47.

import type { Block, Page, SpacesDoc } from './model.ts'

/**
 * What a label may be: the character set every markdown implementation agrees
 * on for `[^…]`, and short enough that a runaway `[^` in prose cannot make the
 * scanner walk a paragraph.
 *
 * Deliberately NOT the full pandoc set (which allows almost anything but
 * whitespace): a narrow class keeps the token safe to interpolate into an
 * `id=` and an `href="#…"` without escaping games, and it is the set an author
 * actually types.
 */
export const LABEL_OK = /^[A-Za-z0-9_-]{1,32}$/

/**
 * A fresh scanner every time.
 *
 * A module-level `/g` regex carries `lastIndex` between calls, so the second
 * caller starts halfway through its own string and finds nothing. That has
 * shipped as a bug in this repo's neighbourhood before; a factory cannot.
 */
const refRe = (): RegExp => /\[\^([A-Za-z0-9_-]{1,32})\]/g

/** A definition line as markdown writes it: `[^1]: the note.` */
const DEF_RE = /^\[\^([A-Za-z0-9_-]{1,32})\]:[ \t]?(.*)$/

/**
 * The note behind a label, or undefined.
 *
 * `Object.hasOwn`, never `in` and never truthiness. `doc.footnotes` is DATA OUT
 * OF A FILE and a bare index reaches the prototype chain: `footnotes.toString`
 * is a FUNCTION, which is truthy, so a `?? ''` never fires and the stringified
 * source of `Object.prototype.toString` is what gets rendered into the page.
 * That exact bug has shipped twice in this app (the icon lookup, the asset
 * lookup) and both times it was a bare lookup on author-supplied data.
 */
export function noteOf(doc: SpacesDoc, label: string): string | undefined {
  const table = (doc as { footnotes?: unknown }).footnotes
  if (!table || typeof table !== 'object' || Array.isArray(table)) return undefined
  if (!Object.hasOwn(table as object, label)) return undefined
  const v = (table as Record<string, unknown>)[label]
  return typeof v === 'string' ? v : undefined
}

/** Every note in the document, by label — defensive about the shape, because
 *  `"footnotes": "yes"` must be ignored rather than iterated. */
export function allNotes(doc: SpacesDoc): Array<[string, string]> {
  const table = (doc as { footnotes?: unknown }).footnotes
  if (!table || typeof table !== 'object' || Array.isArray(table)) return []
  return Object.entries(table as Record<string, unknown>)
    .filter(([k, v]) => LABEL_OK.test(k) && typeof v === 'string') as Array<[string, string]>
}

/**
 * The strings of a block that hold prose, in reading order.
 *
 * A table keeps its content in `rows` and MIRRORS it into `html` as the
 * additivity fallback (model.ts writeTable). Scanning both would count every
 * reference in a cell twice; scanning `html` alone would number a reference
 * that the table renderer — which draws from `rows` — never marks up. So a
 * table is its cells and everything else is its html, which is the same
 * either/or buildIndex makes about links, decided from the same fact.
 *
 * A `code` block is EXCLUDED. Its html is escaped literal text; `[^1]` in a
 * shell snippet is a shell snippet.
 */
export function proseOf(b: Block): string[] {
  if (b.type === 'code') return []
  if (b.type === 'table' && Array.isArray(b.rows)) {
    const out: string[] = []
    for (const row of b.rows as unknown[]) {
      if (!Array.isArray(row)) continue
      for (const cell of row) if (typeof cell === 'string') out.push(cell)
    }
    return out
  }
  return typeof b.html === 'string' && b.html ? [b.html] : []
}

/** The labels referenced in one string, in order, duplicates included. */
export function refsIn(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(refRe())) out.push(m[1])
  return out
}

/** What a page's footnotes come to, all derived. */
export interface PageNotes {
  /** labels in first-appearance order — INCLUDING ones with no note behind
   *  them, because a reference the author has not written the note for yet is
   *  the normal state one second after typing it */
  order: string[]
  /** label → the number it renders as, 1-based */
  num: Map<string, number>
  /** referenced here, no note in doc.footnotes — reported by validate() and
   *  shown as an empty slot in the editor rather than silently swallowed */
  dangling: string[]
}

/**
 * Number a page's footnotes: first appearance wins, repeats reuse the number.
 *
 * PURE and READ-TIME, the same choice `effectiveParents` and `tableOf` make
 * for the same reason — two readers of one file agree without exchanging an
 * op, and merely opening a space rewrites nothing.
 */
export function notesOnPage(doc: SpacesDoc, page: Page): PageNotes {
  const order: string[] = []
  const num = new Map<string, number>()
  const dangling: string[] = []
  for (const b of Array.isArray(page.blocks) ? page.blocks : []) {
    for (const src of proseOf(b)) {
      for (const label of refsIn(src)) {
        if (num.has(label)) continue
        num.set(label, order.length + 1)
        order.push(label)
        if (noteOf(doc, label) === undefined) dangling.push(label)
      }
    }
  }
  return { order, num, dangling }
}

/** Every label referenced anywhere in the document. */
export function referencedLabels(doc: SpacesDoc): Set<string> {
  const out = new Set<string>()
  for (const p of Array.isArray(doc.pages) ? doc.pages : []) {
    for (const b of Array.isArray(p.blocks) ? p.blocks : []) {
      for (const src of proseOf(b)) for (const l of refsIn(src)) out.add(l)
    }
  }
  return out
}

/**
 * Notes nothing points at any more — the author deleted the sentence and kept
 * the note.
 *
 * NOT repaired and NOT deleted. The note is somebody's writing; dropping it
 * because the marker went would be the same silent loss the reference design
 * exists to avoid. validate() says so out loud instead.
 */
export function orphanNotes(doc: SpacesDoc): string[] {
  const used = referencedLabels(doc)
  return allNotes(doc).map(([k]) => k).filter((k) => !used.has(k)).sort()
}

/** Every dangling reference in the document, with where it is. */
export function danglingRefs(doc: SpacesDoc): Array<{ pageId: string; blockId: string; label: string }> {
  const out: Array<{ pageId: string; blockId: string; label: string }> = []
  const seen = new Set<string>()
  for (const p of Array.isArray(doc.pages) ? doc.pages : []) {
    for (const b of Array.isArray(p.blocks) ? p.blocks : []) {
      for (const src of proseOf(b)) {
        for (const label of refsIn(src)) {
          if (noteOf(doc, label) !== undefined) continue
          const key = `${b.id}${label}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push({ pageId: p.id, blockId: b.id, label })
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// rendering — the STRING half, so it is testable without a browser
// ---------------------------------------------------------------------------

/** DOM ids are document-global and PRINT draws every page at once, so a
 *  label's ids are scoped by page or two pages using `[^1]` collide. */
export const refId = (scope: string, label: string): string => `spfnr-${scope}-${label}`
export const noteId = (scope: string, label: string): string => `spfn-${scope}-${label}`

const attr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Replace every KNOWN reference token in a piece of already-sanitized inline
 * html with its superscript marker.
 *
 * RUNS AFTER sanitizeInline, never before — the markup this emits is OURS, and
 * feeding it back through the allowlist would strip the class and the
 * fragment href. That ordering is the reason no sanitizer change was needed
 * for this feature at all.
 *
 * SUBSTITUTION IS TEXT-CHUNK ONLY. The html is split into tags and text, and
 * only the text is touched: a `[^1]` that somehow ended up inside an
 * attribute value stays an attribute value. A token whose brackets an author
 * has split across a mark boundary (`[^<b>1</b>]`) is not contiguous text and
 * is left alone — it reads as literal, which is honest, rather than being
 * half-matched.
 *
 * A DANGLING REFERENCE IS STILL NUMBERED. `notesOnPage` puts a label with no
 * note behind it on the list anyway, so it gets a marker and an EMPTY row in
 * the section: that is the authoring gesture (type `[^1]`, get a slot to write
 * the note into) and it is the honest reading — what is missing is the note,
 * not the reference. Leaving it as raw `[^1]` in the reading view was the other
 * candidate and shows a reader syntax they never typed.
 *
 * A token this page's numbering does not know at all — a half-typed `[^`, a
 * cell carried in from somewhere else — is left as the literal text the author
 * typed. Nothing is ever removed from the prose here.
 */
export function markRefs(html: string, notes: PageNotes, scope: string): string {
  if (!html || !notes.num.size) return html
  return html.replace(/<[^>]*>|[^<]+/g, (chunk) => {
    if (chunk.startsWith('<')) return chunk
    return chunk.replace(refRe(), (whole, label: string) => {
      const n = notes.num.get(label)
      if (n === undefined) return whole
      return `<sup class="sp-fnref" id="${attr(refId(scope, label))}">`
        + `<a href="#${attr(noteId(scope, label))}">${n}</a></sup>`
    })
  })
}

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------

/**
 * Take the `[^1]: …` definitions out of a markdown file.
 *
 * Returns the remaining lines and the notes, so the caller's parser never sees
 * a definition line and cannot turn it into a paragraph. That downgrade — a
 * construct silently arriving as something duller — is exactly the import loss
 * the transclusion work found with `![[embed]]`, and it is the whole reason
 * this runs before the block parser rather than after it.
 *
 * A CONTINUATION LINE (indented under the definition, as pandoc allows) is
 * folded into the note with a space. A blank line ends the note.
 */
export function takeDefinitions(lines: string[]): { rest: string[]; notes: Record<string, string> } {
  const rest: string[] = []
  const notes: Record<string, string> = {}
  let open: string | null = null
  for (const line of lines) {
    const m = DEF_RE.exec(line)
    if (m) {
      open = m[1]
      // FIRST DEFINITION WINS, so a file that defines `[^1]` twice does not
      // depend on which half of it the reader remembers.
      if (!Object.hasOwn(notes, open)) notes[open] = m[2].trim()
      continue
    }
    if (open !== null) {
      if (/^[ \t]+\S/.test(line)) { notes[open] = `${notes[open]} ${line.trim()}`.trim(); continue }
      if (!line.trim()) { open = null; continue }
      open = null
    }
    rest.push(line)
  }
  return { rest, notes }
}

/**
 * The definition lines for one page's notes, in rendered order.
 *
 * Emitted per page because that is where they are numbered and where a reader
 * looks for them, and because markdown scopes a definition to its file — the
 * export writes one file, and a `[^1]` on page nine must not be answered by
 * page one's note. The label is written out unchanged, so re-importing the
 * export gives back the same labels and therefore the same notes.
 */
export function definitionLines(doc: SpacesDoc, page: Page, toMd: (html: string) => string): string[] {
  const notes = notesOnPage(doc, page)
  const out: string[] = []
  for (const label of notes.order) {
    const body = noteOf(doc, label)
    if (body === undefined) continue
    // ONE LINE each: a note is inline content, and a newline inside it would
    // need the four-space continuation to survive — the flattening is what the
    // `<br>` was worth, and it is the same flattening htmlToMd already does
    // everywhere else.
    out.push(`[^${label}]: ${toMd(body).replace(/\n+/g, ' ').trim()}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/** A label nothing in this document is using yet. */
export function freshLabel(doc: SpacesDoc, used: Set<string> = referencedLabels(doc)): string {
  const taken = new Set([...used, ...allNotes(doc).map(([k]) => k)])
  for (let n = 1; ; n++) if (!taken.has(String(n))) return String(n)
}

/**
 * Merge an incoming set of notes into a document's, renaming any label that
 * would land on a DIFFERENT note.
 *
 * Two vaults both number their footnotes from 1, so an import of more than one
 * file collides by construction; without this, the second file's `[^1]` would
 * silently answer with the first file's note. Returns the renames so the
 * caller can rewrite the references in that file's blocks.
 *
 * An IDENTICAL note under the same label is not a collision — re-importing the
 * same file must not fork the note.
 */
export function mergeNotes(
  into: Record<string, string>,
  incoming: Record<string, string>,
  used: Set<string>,
): Map<string, string> {
  const renames = new Map<string, string>()
  for (const [label, body] of Object.entries(incoming)) {
    if (!LABEL_OK.test(label)) continue
    if (!Object.hasOwn(into, label)) { into[label] = body; used.add(label); continue }
    if (into[label] === body) { used.add(label); continue }
    let n = 2
    let next = `${label}-${n}`
    while (Object.hasOwn(into, next) || used.has(next)) next = `${label}-${++n}`
    into[next] = body
    used.add(next)
    renames.set(label, next)
  }
  return renames
}

/** Rewrite reference tokens after a merge renamed their labels. */
export function renameRefs(html: string, renames: Map<string, string>): string {
  if (!renames.size) return html
  return html.replace(refRe(), (whole, label: string) => {
    const next = renames.get(label)
    return next ? `[^${next}]` : whole
  })
}
