// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// TRANSCLUSION: a block that shows a LIVE view of another page.
//
// The whole of this file is PURE — no DOM, no imports that touch one — so
// scripts/test-spaces-model.ts can import it directly and assert the parts that
// actually break: the cycle guard, a dangling target, the section slice and the
// markdown round trip. The DOM is 40 lines in render.ts and nothing else.
//
// WHAT AN EMBED IS, in the format:
//
//   { id, type: 'embed', page: '<pageId>', anchor?: '<heading>', html: '<a…>' }
//
// `page` is the SAME field a pagelink carries and means the same thing — the
// target page id — so every sweep that already understands "this block is a
// reference to a page" (backlinks, extract, graft, validate) extends by one
// name in one condition rather than growing a second concept. That is what
// `isPageRef` below is for.
//
// THE SOURCE IS THE TRUTH. An embed stores a reference and never a copy: there
// is no cached content on the block, nothing to invalidate, and editing the
// source page changes every embed of it on the next paint. The one thing the
// block DOES carry is `html` — a plain link to the target — and that is not a
// copy either, it is the ADDITIVITY fallback: a build that has never heard of
// `embed` renders an unknown type's `html` (render.ts default case), so an
// older shell opening this file shows a link to the source page instead of a
// blank. Absent key = old behaviour; a default is never stored.

import type { Block, Page, SpacesDoc } from './model.ts'

/**
 * How many pages deep an embed chain is followed.
 *
 * A CAP AS WELL AS the cycle check below, not instead of it. The cycle check
 * catches A→B→A exactly; the cap catches the shape it cannot see — a hundred
 * distinct pages each embedding the next, which is not a cycle and would still
 * render a hundred pages into one. Three is the number at which an embed is
 * still recognisably a quotation rather than a merge.
 */
export const EMBED_MAX_DEPTH = 3

/**
 * Does this block REFERENCE a page by id?
 *
 * The one predicate for both types, because the alternative is what the
 * codebase had before an embed existed: `b.type === 'pagelink' && typeof
 * b.page === 'string'` written out in five files, four of which would have
 * gone on quietly ignoring embeds. A grafted page whose embed pointed at
 * nothing is exactly the failure that would not have been noticed until
 * someone opened the export.
 */
export function isPageRef(b: Block): boolean {
  return (b.type === 'pagelink' || b.type === 'embed') && typeof b.page === 'string'
}

/** The heading an embed narrows to, or undefined for the whole page. Trimmed,
 *  and an empty string is ABSENT — a default is never stored (PLATFORM §3). */
export function anchorOf(b: Block): string | undefined {
  const raw = typeof b.anchor === 'string' ? b.anchor.trim() : ''
  return raw || undefined
}

/**
 * Inline html → comparable plain text, with no DOM.
 *
 * render.ts parses INERT for this and is right to: it is handling markup that
 * will be displayed. Nothing here is displayed — the output is compared to a
 * heading name and thrown away — so a tag strip plus the five entities `esc`
 * writes is exactly the job, and it keeps this module importable by node.
 */
function plain(html: unknown): string {
  // A TAG CONTRIBUTES NOTHING, not a space — `## Roll<b>out</b>` is the
  // heading "Rollout", which is what `textContent` says and what the author
  // typed as `## Roll**out**`. Substituting a space instead would make a
  // heading with any inline markup in it unmatchable by the name it exports as.
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** The five entities `esc` writes, back again. `&amp;` LAST, or `&amp;lt;`
 *  would decode twice and turn stored text into a tag. */
const decodeEntities = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/** Heading names match the way a wikilink target does: case- and
 *  whitespace-insensitive. `## Getting started` is `[[Page#getting started]]`. */
const headingKey = (s: unknown): string => plain(s).toLowerCase()

const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3 }

/**
 * A block's heading rank, or 0 for anything that is not a heading.
 *
 * `Object.hasOwn`, not `in`: `b.type` comes out of a file someone mailed you,
 * `HEADINGS` is an object literal, and `'toString' in HEADINGS` is TRUE — the
 * lookup would hand back a native function. This app has shipped that exact
 * bug twice.
 *
 * ONE copy, read by `sectionOf` and by `headingsOf`, because a guard written
 * twice is a guard that gets fixed once. It is also the only shape in which a
 * test can prove the guard: through `sectionOf` alone a native function fails
 * `> 0` and the miss looks identical either way, so the second reader is where
 * the sabotage is visible.
 */
const rankOf = (b: Block): number => (Object.hasOwn(HEADINGS, b.type) ? HEADINGS[b.type] : 0)

/**
 * The blocks under one heading, INCLUDING the heading itself.
 *
 * The section ends at the next heading of the SAME OR HIGHER rank, which is
 * what a reader means by "that section": an h2 takes its h3s with it and stops
 * at the next h2 or at an h1. Returns null when no heading matches — never the
 * whole page, because silently showing four pages where one section was asked
 * for is worse than saying the section is gone.
 *
 * `HEADINGS` is a plain object keyed on `b.type`, which comes out of a file
 * someone mailed you, so the lookup is `Object.hasOwn`: `'toString' in
 * HEADINGS` is true and would hand back a native function, and this app has
 * shipped that exact bug twice.
 */
export function sectionOf(page: Page, anchor: string): Block[] | null {
  const want = headingKey(anchor)
  if (!want) return null
  const at = page.blocks.findIndex((b) => rankOf(b) > 0 && headingKey(b.html) === want)
  if (at < 0) return null
  const level = rankOf(page.blocks[at])
  const out: Block[] = [page.blocks[at]]
  for (let i = at + 1; i < page.blocks.length; i++) {
    const r = rankOf(page.blocks[i])
    if (r > 0 && r <= level) break
    out.push(page.blocks[i])
  }
  return out
}

/**
 * The headings an embed can be narrowed to, in page order.
 *
 * THE PICKER AND THE RESOLVER READ THE SAME LIST. The editor offers these
 * names and `sectionOf` matches against them by the same `headingKey`, so a
 * section you can choose is a section that resolves — the alternative is a
 * picker that can offer a name the resolver then reports as missing, which is
 * a bug nobody would find until someone used a heading with a `&` in it.
 */
export function headingsOf(page: Page): Array<{ id: string; level: number; text: string }> {
  const out: Array<{ id: string; level: number; text: string }> = []
  for (const b of page.blocks) {
    const level = rankOf(b)
    if (!level) continue
    const text = plain(b.html)
    if (text) out.push({ id: b.id, level, text })
  }
  return out
}

/** Why an embed has nothing to show. Each one RENDERS as a named placeholder —
 *  a blank box tells the reader nothing and looks like a bug in the app. */
export type EmbedProblem = 'no-target' | 'missing' | 'cycle' | 'depth' | 'no-section'

export type EmbedView =
  | { ok: true; page: Page; blocks: Block[]; anchor?: string }
  | { ok: false; why: EmbedProblem; target: string; anchor?: string; page?: Page }

/**
 * What one embed block shows, given where the renderer already is.
 *
 * `chain` is the pages currently open above this block, host page first. It is
 * the cycle guard and the depth guard at once, and it is a PARAMETER rather
 * than module state because two surfaces render at the same time (the editor
 * canvas and the still preview) and a shared counter between them would be a
 * race that only shows up in a saved thumbnail.
 */
export function viewEmbed(b: Block, doc: SpacesDoc, chain: readonly string[] = []): EmbedView {
  const target = typeof b.page === 'string' ? b.page : ''
  const anchor = anchorOf(b)
  if (!target) return { ok: false, why: 'no-target', target: '', ...(anchor ? { anchor } : {}) }
  // A LINEAR SCAN over an array, deliberately, not a lookup in an object keyed
  // by page id: `target` is document data and an object would answer
  // `__proto__` and `toString` with something that is not a page.
  const page = doc.pages.find((p) => p.id === target)
  if (!page) return { ok: false, why: 'missing', target, ...(anchor ? { anchor } : {}) }
  if (chain.includes(target)) return { ok: false, why: 'cycle', target, page, ...(anchor ? { anchor } : {}) }
  if (chain.length > EMBED_MAX_DEPTH) return { ok: false, why: 'depth', target, page, ...(anchor ? { anchor } : {}) }
  if (anchor) {
    const cut = sectionOf(page, anchor)
    if (!cut) return { ok: false, why: 'no-section', target, anchor, page }
    return { ok: true, page, blocks: cut, anchor }
  }
  return { ok: true, page, blocks: page.blocks }
}

/**
 * Can `from` be reached from `to` by following embeds? — the validator's
 * question, which the renderer's chain cannot answer because the renderer only
 * ever sees one path at a time.
 *
 * Breadth-first over a visited set, so it terminates on a document that
 * already cycles. That matters: this runs on files people hand-edit, and a
 * "does this cycle" check that hangs on a cycling document is worse than none.
 */
export function embedReaches(doc: SpacesDoc, from: string, to: string): boolean {
  const byId = new Map(doc.pages.map((p) => [p.id, p]))
  const seen = new Set<string>()
  const queue: string[] = [to]
  while (queue.length) {
    const at = queue.shift()!
    if (at === from) return true
    if (seen.has(at)) continue
    seen.add(at)
    for (const b of byId.get(at)?.blocks ?? []) {
      if (b.type === 'embed' && typeof b.page === 'string' && !seen.has(b.page)) queue.push(b.page)
    }
  }
  return false
}

// ---- markdown --------------------------------------------------------------

/**
 * `![[Page]]` / `![[Page#Section]]` on a line of its OWN.
 *
 * Obsidian's embed syntax, and the reason this feature exists: markdown.ts
 * parsed it already and downgraded every one to a plain link, so importing a
 * vault lost every embed with no warning.
 *
 * INLINE `![[x]]` IS STILL A LINK and that is not a compromise — a block
 * cannot live inside a sentence, and markdown.ts's inline pass is where a
 * sentence is built. Only a whole line becomes a block.
 *
 * An `![[picture.png]]` line is an IMAGE, and this function does not know
 * that: markdown.ts tests `imageOf` first, which is the one place that already
 * owns the image-extension list. Adding a second copy of that list here is how
 * the two would come to disagree.
 */
export function parseEmbedLine(line: string): { target: string; anchor?: string } | null {
  const m = /^!\[\[([^\]]+)\]\]$/.exec(line.trim())
  if (!m) return null
  // `|alias` is Obsidian's display text. An embed shows the page, so there is
  // nothing for an alias to be the text OF; it is dropped, not stored.
  const bar = m[1].indexOf('|')
  const whole = (bar < 0 ? m[1] : m[1].slice(0, bar)).trim()
  const hash = whole.indexOf('#')
  const target = (hash < 0 ? whole : whole.slice(0, hash)).trim()
  // `^block-id` is Obsidian's block anchor. This model has no block anchors, so
  // the embed lands on the page — the same rule linkKey already applies to
  // links, rather than a second, quieter one.
  const anchor = hash < 0 ? '' : whole.slice(hash + 1).replace(/^\^.*$/, '').trim()
  if (!target) return null
  return { target, ...(anchor ? { anchor } : {}) }
}

/** An embed as the markdown it was imported from. The exporter's half of the
 *  round trip: `![[Title]]`, or `![[Title#Section]]`. */
export function embedToMd(title: string | undefined, anchor: string | undefined): string {
  const name = (title ?? '?').trim() || '?'
  return `![[${name}${anchor ? `#${anchor}` : ''}]]`
}

/**
 * Turn the importer's resolved links into real embed targets.
 *
 * The parser cannot set `page`: at parse time a wikilink names a FILE and the
 * pages do not exist yet. So an embed block arrives carrying only its `html` —
 * the `#w/` placeholder link every other block carries — and planImport's
 * existing sweep resolves that html to `#p/<id>` exactly as it resolves a link
 * in a paragraph. This reads the answer back off the html.
 *
 * A TARGET THAT WAS NOT IN THE IMPORT BECOMES A PARAGRAPH, and this is the
 * deliberate half: `resolveWikilinks` has already rewritten the html to the
 * literal `[[Name]]` the author typed, which is a true statement about a note
 * that is not here. An embed with no target would be a permanent error card in
 * a document that never had one — the vault said "show me that note", the note
 * did not come, and the honest result is the text saying so.
 */
export function linkEmbeds(pages: Page[]): { linked: number; dropped: number } {
  let linked = 0
  let dropped = 0
  for (const p of pages) {
    for (const b of p.blocks) {
      if (b.type !== 'embed') continue
      const m = /href="#p\/([^"]+)"/.exec(String(b.html ?? ''))
      if (m) { b.page = decodeEntities(m[1]); linked++; continue }
      dropped++
      b.type = 'p'
      delete b.page
      delete b.anchor
    }
  }
  return { linked, dropped }
}
