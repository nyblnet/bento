// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Inline `#tag` — the parser, the derived index, and the chip.
//
// THE TAG IS THE `#tag` IN THE PROSE. There is no `Page.tags` array and there
// must never be one. A stored list is a second copy of a fact the text already
// states, and the two disagree the first time anything writes `html` without
// knowing tags exist — an agent calling `updateBlock`, a Markdown import, a
// remote collaborator's op, a hand-edited `#bento-doc`. The backlink index in
// model.ts settled this for links (`buildIndex` reads `html` and stores
// nothing); tags follow it exactly, for the same reason and with the same
// consequence: the index is STALE the moment the document changes, so it is
// rebuilt from the document rather than maintained alongside it.
//
// That also makes format additivity FREE rather than argued: a tagged
// paragraph is a paragraph whose text contains a `#`. A build from before this
// file existed renders it as ordinary prose, because that is all it is. Nothing
// new is written to the file, so there is nothing for an older reader to drop.
//
// TWO READERS OF THE SAME TEXT, and they must agree:
//
//   · `parseTags(html)` — a pure string function, no DOM. This one is the
//     TRUTH: the index, the filters, the search and the graph all come from it,
//     and it is the one a node rig can run.
//   · `decorateTags(host)` — a DOM pass that turns the same spans of text into
//     chips at render time. Cosmetic. Where the two could ever disagree the
//     index wins and the chip is simply not drawn.
//
// They are kept aligned by construction: both refuse to look inside `<a>` and
// `<code>`, and both treat any other inline tag as a word BREAK — the DOM
// walker because `#re<b>cipe</b>` is two text nodes, the string reader because
// it replaces a stripped tag with a space rather than closing the gap.

import type { SpacesDoc, Page } from './model.ts'

/**
 * WHAT COUNTS AS A TAG. Every clause here exists because of a `#` that is not
 * one, and each is covered by its own case in scripts/test-spaces-tags.ts.
 *
 * `(^|[^\p{L}\p{N}_#/\\])` — THE CHARACTER BEFORE.
 *   A tag's `#` opens a word. Requiring a non-word character before it is what
 *   keeps `C#`, `a#b` and — the one that matters — a URL fragment out:
 *   `https://example.com/page#section` is preceded by `e`, and
 *   `https://example.com/#top` by `/`. `#` itself is excluded so `##` (a
 *   Markdown h2 that somehow reached inline html) opens nothing, and `\` so an
 *   escape can be added later without changing what already parses.
 *
 * `#([\p{L}\p{N}_][\p{L}\p{N}_-]*…)` — NO SPACE AFTER THE HASH.
 *   This is the whole answer to `# Title`. A Markdown ATX heading is `#` + a
 *   space, and markdown.ts's own reader requires that space (`/^(#{1,6})\s+/`),
 *   so the two agree about what a heading is. A bare `#` before punctuation
 *   (`#!`, `#.`) is likewise nothing.
 *
 * Unicode classes, not `[a-z]`: `#рецепт` and `#レシピ` are tags in the
 * languages this app already ships eight catalogs for.
 *
 * `(?:\/…)*` — NESTED TAGS. See NESTING below.
 *
 * `#p/<id>` — the app's own page-link href — is handled STRUCTURALLY rather
 * than by a special case here: a real page link is an `<a href="#p/…">` whose
 * href is an ATTRIBUTE, not text, and whose link text is a title. Neither
 * reader looks at attributes and neither descends into `<a>`, so no page link
 * can become a tag. A `#p/abc` somebody typed as literal prose IS read as the
 * nested tag `p/abc`, which is correct — it is a hash-word in a sentence, and
 * pretending otherwise would mean reserving a namespace inside the user's own
 * vocabulary.
 */
const TAG_SCAN = /(^|[^\p{L}\p{N}_#/\\])#([\p{L}\p{N}_][\p{L}\p{N}_-]*(?:\/[\p{L}\p{N}_][\p{L}\p{N}_-]*)*)/gu

/**
 * NESTING: `#project/bento` is ONE tag whose key is `project/bento`, and it
 * counts as being under `project` for anything that asks.
 *
 * Decided now rather than later, and that timing is the argument. `/` is
 * either part of the tag character set or it is not; if this build read
 * `#project/bento` as the flat tag `project` followed by the text `/bento`,
 * then adding nesting afterwards would silently CHANGE THE MEANING of text
 * already sitting in files on other people's disks — the same one-way hazard
 * sanitize.ts records for the href allowlist. There is no migration available
 * to a format with no server, so the permissive reading has to be the first
 * one.
 *
 * A parent is not itself an occurrence. `#project` has an entry only if
 * somebody wrote `#project`; what nesting buys is that `pagesWithTag('project')`
 * includes the pages that only carry `#project/bento`.
 */
export const SEP = '/'

/** Longest key we will index. A pathological line cannot grow the index. */
const KEY_MAX = 100

/**
 * The key a tag is COUNTED under: lower-cased, in the document's own casing
 * rules rather than the reader's locale.
 *
 * `toLowerCase()` and NOT `toLocaleLowerCase()`. The index is part of the
 * document's meaning — two people with different `navigator.language` opening
 * the same file must see the same tags — and Turkish locale folding maps `I`
 * to `ı`, so `#Idea` and `#idea` would be one tag in Istanbul and two
 * everywhere else.
 */
export const tagKey = (label: string): string => label.toLowerCase()

/** `project/bento` → `['project']`. Empty for a flat tag. */
export function ancestorsOf(key: string): string[] {
  const parts = key.split(SEP)
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join(SEP))
  return out
}

/**
 * Is this token a `#` that means something else?
 *
 * ALL DIGITS — `#42`, `#404`, `#1`. Prose is full of these ("closes #42",
 * "a #404 page") and essentially none of them are tags. The cost is that a
 * numeric tag has to be written with a letter in it; the alternative is that
 * every issue number in every note becomes an index entry.
 *
 * A CSS HEX COLOUR — `#fff`, `#1e2a3a`, `#ff8800cc`. Three, four, six or eight
 * hex digits and no separator. `#fff` survives the all-digits test (it has
 * letters) and would otherwise be the most common false tag in a document that
 * talks about design at all.
 */
function isNotATag(label: string): boolean {
  if (!/[^\p{Nd}]/u.test(label)) return true
  return !label.includes(SEP) && /^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(label)
}

/** A tag as it was written, and where in the string it sits. */
export interface TagHit {
  /** the index key — lower-cased */
  key: string
  /** the casing this occurrence used */
  label: string
  /** offset of the `#` in the string that was scanned */
  at: number
}

/**
 * Every tag in one run of plain text.
 *
 * The shared core: `parseTags` feeds it text recovered from html, and
 * `decorateTags` feeds it one DOM text node. One regex, one rejection list, so
 * the index and the chip cannot drift apart on what a tag is.
 */
export function scanText(text: string): TagHit[] {
  const out: TagHit[] = []
  TAG_SCAN.lastIndex = 0
  for (const m of text.matchAll(TAG_SCAN)) {
    // a trailing `-` belongs to the sentence, not the tag: "#work-" and
    // "#a—b" both end the word there
    const label = m[2].replace(/-+$/, '')
    if (!label || label.length > KEY_MAX) continue
    if (isNotATag(label)) continue
    out.push({ key: tagKey(label), label, at: m.index + m[1].length })
  }
  return out
}

/**
 * The plain text a tag may be found in, from a block's inline html.
 *
 * NOT `sanitize.ts textOf`. That one wants every word, and it needs a DOM. This
 * one has to run in a node rig with no DOM at all, and it has to make the two
 * exclusions structural:
 *
 *   · `<a>…</a>` goes entirely — link TEXT is a page title or a url someone
 *     pasted, not prose, and dropping it is what makes `#p/` page links
 *     impossible to misread;
 *   · `<code>…</code>` goes entirely — a `#` in inline code is code. (A `code`
 *     BLOCK never reaches here: its model value is escaped text, and render.ts
 *     paints it through `paintCode`, which this file never touches.)
 *
 * Each removal leaves a SPACE. That is not tidiness: the DOM walker sees
 * `#re<b>cipe</b>` as two separate text nodes and reads `re`, so this reader
 * has to break the word in the same place or the two would disagree.
 *
 * Entities are decoded AFTER tags are stripped — decoding first would let
 * `&lt;b&gt;` become markup that then gets stripped, which is the standard way
 * a two-pass text extractor becomes a parser differential.
 */
export function tagText(html: string): string {
  return html
    .replace(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi, ' ')
    .replace(/<code\b[^>]*>[\s\S]*?<\/code\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

/** Every tag in a block's inline html. */
export const parseTags = (html: string | undefined): TagHit[] =>
  html ? scanText(tagText(html)) : []

// ---- the derived index -----------------------------------------------------

export interface TagRef {
  pageId: string
  blockId: string
}

export interface TagEntry {
  key: string
  /** the casing of the FIRST occurrence in document order — deterministic, so
   *  two readers of one file label the tag identically */
  label: string
  /** every occurrence, in document order; a block tagged twice appears twice */
  refs: TagRef[]
  /** the pages carrying it directly, in document order, no duplicates */
  pages: string[]
}

export interface TagIndex {
  /** key → entry, DIRECT occurrences only (see NESTING) */
  tags: Map<string, TagEntry>
  /** page id → the tag keys written on it, first-seen order */
  byPage: Map<string, string[]>
}

/**
 * A table's cells as one string, for scanning only — the same shape and the
 * same reason as model.ts's private `tableCellsText`.
 *
 * Duplicated deliberately rather than exported from model.ts: nine branches
 * are open against this app at once and a one-word export is still a line in
 * a file four of them are editing. Six lines that can only ever be read are
 * the cheaper collision.
 */
function cellsText(rows: unknown[]): string {
  let out = ''
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    for (const cell of row) if (typeof cell === 'string') out += cell + '\n'
  }
  return out
}

/**
 * Build the tag index.
 *
 * WHERE A TAG MAY LIVE mirrors `buildIndex` exactly, including its `rows`
 * fallback and including why: a table the editor wrote mirrors its cells into
 * `html`, so scanning both would count every cell tag twice; a table that
 * arrived any other way has `rows` and no `html`, and a tag in one of its
 * cells must not vanish.
 *
 * Archived pages ARE indexed. An archive is "out of the way", not "deleted" —
 * the sidebar still lists them and ⌘K still finds them — so a tag index that
 * dropped them would answer "nothing carries #recipe" about a document that
 * does. What excludes them is `viewRows`, at the point where a view asks.
 */
export function buildTagIndex(doc: SpacesDoc): TagIndex {
  const tags = new Map<string, TagEntry>()
  const byPage = new Map<string, string[]>()
  const pages = Array.isArray(doc.pages) ? doc.pages : []

  for (const p of pages) {
    if (!p || !Array.isArray(p.blocks)) continue
    const mine: string[] = []
    const seenHere = new Set<string>()
    for (const b of p.blocks) {
      if (!b) continue
      const src = b.html || (Array.isArray(b.rows) ? cellsText(b.rows) : '')
      if (!src) continue
      for (const hit of parseTags(src)) {
        let entry = tags.get(hit.key)
        if (!entry) {
          entry = { key: hit.key, label: hit.label, refs: [], pages: [] }
          tags.set(hit.key, entry)
        }
        entry.refs.push({ pageId: p.id, blockId: b.id })
        if (entry.pages[entry.pages.length - 1] !== p.id && !entry.pages.includes(p.id)) {
          entry.pages.push(p.id)
        }
        if (!seenHere.has(hit.key)) { seenHere.add(hit.key); mine.push(hit.key) }
      }
    }
    if (mine.length) byPage.set(p.id, mine)
  }
  return { tags, byPage }
}

/** An empty index, for the load path before a document exists. */
export const emptyTagIndex = (): TagIndex => ({ tags: new Map(), byPage: new Map() })

/** `key` itself plus every tag nested under it. Keys only — some may be absent. */
export function keysUnder(index: TagIndex, key: string): string[] {
  const want = tagKey(key)
  const out: string[] = []
  for (const k of index.tags.keys()) {
    if (k === want || k.startsWith(want + SEP)) out.push(k)
  }
  return out.sort()
}

/**
 * Every page carrying this tag OR anything nested under it, in document order.
 *
 * Document order, not index order: two calls with the same document must list
 * the same pages the same way, and `Map` iteration order is insertion order —
 * which is scan order, which is nearly but not exactly page order once a tag
 * appears on a later page first.
 */
export function pagesWithTag(doc: SpacesDoc, index: TagIndex, key: string): Page[] {
  const keys = new Set(keysUnder(index, key))
  if (!keys.size) return []
  const want = new Set<string>()
  for (const k of keys) for (const id of index.tags.get(k)?.pages ?? []) want.add(id)
  return (Array.isArray(doc.pages) ? doc.pages : []).filter((p) => p && want.has(p.id))
}

/** Does this page carry the tag, or anything under it? */
export function pageHasTag(index: TagIndex, pageId: string, key: string): boolean {
  const want = tagKey(key)
  for (const k of index.byPage.get(pageId) ?? []) {
    if (k === want || k.startsWith(want + SEP)) return true
  }
  return false
}

/**
 * Every tag, most-used first, then alphabetical.
 *
 * Count is PAGES, not occurrences: a tag written nine times on one page is one
 * page's worth of "what carries this", and sorting by occurrences would put a
 * repetitive note above a tag that actually spans the space.
 */
export function tagList(index: TagIndex): TagEntry[] {
  return [...index.tags.values()].sort((a, b) =>
    b.pages.length - a.pages.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** Tags whose key contains `q` (already lower-cased by the caller). */
export const matchTags = (index: TagIndex, q: string): TagEntry[] =>
  tagList(index).filter((e) => e.key.includes(q))

// ---- the chip --------------------------------------------------------------

/** Class on a rendered chip. Also the marker `readInline` strips. */
export const TAG_CLASS = 'sp-tag'

/**
 * Elements a chip is never drawn inside — the DOM half of the two exclusions
 * `tagText` makes structurally.
 */
const NO_DESCEND = new Set(['A', 'CODE', 'SCRIPT', 'STYLE', 'TEXTAREA'])

/**
 * Turn every `#tag` in already-sanitized content into a chip, in place.
 *
 * NO MARKUP IS EVER BUILT AS A STRING. The chip's text comes from
 * `createTextNode` and its key from `dataset`, so the most a hostile `#tag`
 * out of a mailed file can do is name itself something long — the same
 * discipline `paintCode` uses, and for the same reason: this runs on content
 * somebody sent you.
 *
 * THE CHIP CARRIES NO `href`, and that is deliberate twice over. sanitize.ts
 * records why a NEW fragment form is a one-way data hazard (a `#t/` href
 * written under this build would be STRIPPED by a stricter one on the next
 * edit that touched the block), so no such href is invented. And an `<a>` with
 * no href is exactly what `sanitizeInline` UNWRAPS — so if a chip ever does
 * leak into `Block.html`, the canonicalizer that already runs on blur removes
 * it and leaves the text. The feature fails back to plain prose rather than
 * into the format.
 *
 * Idempotent: a chip is inside an `A`, which the walk refuses to descend into.
 */
export function decorateTags(host: HTMLElement): void {
  if (typeof document === 'undefined') return
  const walk = (node: Node): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        if (!NO_DESCEND.has((child as HTMLElement).tagName)) walk(child)
        continue
      }
      if (child.nodeType !== Node.TEXT_NODE) continue
      const text = child.nodeValue ?? ''
      const hits = scanText(text)
      if (!hits.length) continue
      const frag = document.createDocumentFragment()
      let cut = 0
      for (const hit of hits) {
        const end = hit.at + 1 + hit.label.length
        if (hit.at > cut) frag.appendChild(document.createTextNode(text.slice(cut, hit.at)))
        const chip = document.createElement('a')
        chip.className = TAG_CLASS
        chip.dataset.tag = hit.key
        chip.textContent = text.slice(hit.at, end)
        frag.appendChild(chip)
        cut = end
      }
      if (cut < text.length) frag.appendChild(document.createTextNode(text.slice(cut)))
      child.parentNode?.replaceChild(frag, child)
    }
  }
  walk(host)
}

/**
 * Strip the chips and draw them again.
 *
 * WHY THIS EXISTS, measured in a browser rather than reasoned: a caret at the
 * end of a chip is a caret INSIDE the `<a>`, so typing there appends to the
 * chip. The model stays right — `readInline` unwraps before committing — but
 * the chip on screen grows to read `#project/bento X`, and `decorateTags`
 * alone cannot repair it because it refuses to descend into an `<a>` (which is
 * exactly what makes it idempotent).
 *
 * So the settle is: take every chip apart, then re-read the text. Called on
 * BLUR only. Doing it per keystroke would be correct and unusable — it
 * replaces the nodes the caret is standing in.
 */
export function redecorateTags(host: HTMLElement): void {
  if (typeof document === 'undefined') return
  for (const chip of [...host.querySelectorAll('.' + TAG_CLASS)]) {
    while (chip.firstChild) chip.parentNode!.insertBefore(chip.firstChild, chip)
    chip.remove()
  }
  host.normalize()
  decorateTags(host)
}

/**
 * An editable host's html WITH THE CHIPS TAKEN BACK OUT — what the model gets.
 *
 * The editor commits `host.innerHTML` on every keystroke, so without this the
 * chips a render just drew would be written straight into `Block.html` and the
 * tag would be stored twice: once as the text, once as the markup around it.
 * This is the same move `wireCode` makes for syntax colour (it commits
 * `textContent`, never `innerHTML`) and for the same reason — the decoration
 * is a rendering, and the model never learns it happened.
 *
 * The fast path matters: this runs per keystroke, and a block with no tag in it
 * must cost one `querySelector`.
 */
export function readInline(host: HTMLElement): string {
  if (!host.querySelector('.' + TAG_CLASS)) return host.innerHTML
  const copy = host.cloneNode(true) as HTMLElement
  for (const chip of [...copy.querySelectorAll('.' + TAG_CLASS)]) {
    while (chip.firstChild) chip.parentNode!.insertBefore(chip.firstChild, chip)
    chip.remove()
  }
  return copy.innerHTML
}
