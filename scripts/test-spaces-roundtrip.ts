#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/spaces: a space survives being exported to Markdown and read back.
//
//   node scripts/test-spaces.mjs roundtrip
//
// (Bundled, not run directly: the app's imports are extensionless. See the
// runner.)
//
// WHAT THIS DEFENDS. The About dialog tells the reader, in eight languages,
// that "a space is never a dead end: the whole document is plain JSON in this
// file, and every page exports as Markdown." Import is the migration path IN,
// and this is the path OUT — the sentence people are asked to trust when they
// decide whether to keep a year of notes in one HTML file.
//
// WHAT IT DOES NOT CHECK, deliberately: block TYPES. Markdown has no callout,
// no toggle, no media embed, no board. A callout leaves as a blockquote, a
// toggle as a bullet, a link card as `[title](url)`, an image as `![alt](ref)`.
// Asserting type-for-type round-tripping would be asserting that Markdown is
// something it is not, and would fail on every honest export.
//
// WHAT IT DOES CHECK is the thing that would actually hurt: WORDS. If a
// paragraph, a table cell or a list item goes into the exporter and does not
// come back out of the parser, someone's writing was dropped by a feature sold
// as the escape hatch — and they would find out long after the original file
// was gone.
//
// TWO MEASURES, because each alone was shown to miss something real:
//   · page VOLUME (10% tolerance) catches a section going missing. On its own
//     it cannot see one small block on a page of prose.
//   · per-block OWN WORDS — those in no other block on the page — catch a
//     single block vanishing. On its own it was fooled by a set-based first
//     draft, because prose repeats its vocabulary.
//
// WHAT IT STILL WILL NOT CATCH, stated so nobody reads more into a green run
// than is there: the partial TRUNCATION of a single block. A quote cut to its
// first three words passes both measures — too little volume to breach the
// tolerance, and its surviving words keep the block present. Catching that
// needs an exact-sequence comparison, and that was tried: it fires on the
// honest export, because Markdown legitimately reflows (a table becomes a
// table row, a wikilink resolves to its target's title, a computed note
// renders its result). A rig that cries wolf on every honest export is worth
// less than one with a stated blind spot.
import { starterDoc } from '../spaces/src/starter.ts'
import { toMarkdown } from '../spaces/src/about.ts'
import { parseNote } from '../spaces/src/markdown.ts'
import { Store } from '../spaces/src/store.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const strip = (h: unknown): string =>
  String(h ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
/** Words worth tracking: short ones are punctuation noise and markdown syntax. */
const words = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3)

const doc = starterDoc() as unknown as { pages: Array<{ title: string; blocks: unknown[] }> }
const md = toMarkdown(new Store(doc as never) as never)

ok(md.length > 5000, `the starter space exports something substantial (${md.length} B)`)
ok(/^# /m.test(md), 'every page arrives under its own heading')

// The export is one document; a note is one page. Split it the way a reader
// would, and read each page back through the importer.
const sections = md.split(/\n(?=# )/)
let pagesChecked = 0
const lostBy: Array<[string, string[]]> = []

for (const sec of sections) {
  const title = (sec.match(/^# (.+)$/m) ?? [])[1]
  if (!title) continue
  const orig = doc.pages.find((p) => p.title === title)
  if (!orig) continue
  const parsed = parseNote(sec.replace(/^# .+\n/, ''), title) as { blocks?: unknown[] }
  const backText = (parsed.blocks ?? []).map((b) => strip((b as { html?: unknown }).html)).join(' ')

    // VOLUME, not sequence, and not a set.
  //
  // A set of distinct words is too weak: a sabotage dropping every fifth block
  // sailed through it, because prose repeats its vocabulary and the lost words
  // were all still on the page somewhere.
  //
  // An exact word SEQUENCE per block is too strong: it fired on the honest
  // export. Markdown legitimately reflows — a table becomes a table row, a
  // wikilink resolves to its target's title, a computed note renders its
  // result — so the same text comes back differently arranged.
  //
  // What survives both is HOW MUCH text there is. Reflow preserves it; a
  // dropped paragraph does not. The 10% tolerance is the room reflow needs,
  // measured on the starter space, where the honest round trip lands within 3%.
  const origWords = words(orig.blocks.map((b) => strip((b as { html?: unknown }).html)).join(' ')).length
  const backWords = words(backText).length
  pagesChecked++
  if (origWords >= 20 && backWords < origWords * 0.9) {
    lostBy.push([title, [`${origWords} words in, ${backWords} back (${Math.round(100 * backWords / origWords)}%)`]])
  }

  // Page volume catches a whole section going missing, but a 10% tolerance
  // cannot see ONE truncated block on a page of prose — measured: a quote cut
  // to three words passed. So each block is also judged on the words that are
  // ITS OWN: those appearing in no other block on the page. Reflow moves such a
  // word around; it does not delete it. Three is the floor at which their all
  // vanishing together means the block did, rather than a rewording.
  const perBlock = orig.blocks.map((b) => words(strip((b as { html?: unknown }).html)))
  const seen = new Map<string, number>()
  for (const w of perBlock.flat()) seen.set(w, (seen.get(w) ?? 0) + 1)
  const backSet = new Set(words(backText))
  for (const [i, w] of perBlock.entries()) {
    const own = [...new Set(w)].filter((x) => seen.get(x) === 1)
    if (own.length < 3) continue
    if (own.every((x) => !backSet.has(x))) {
      lostBy.push([title, [`block ${i + 1} is gone — none of its own words came back (${own.slice(0, 5).join(' ')})`]])
    }
  }
}

ok(pagesChecked >= 8, `read every page of the starter space back (${pagesChecked})`)

if (lostBy.length) {
  for (const [title, missing] of lostBy) {
    console.log(`  FAIL  "${title}" lost text: ${missing.join(' | ')}`)
  }
  failures += lostBy.length
  checks += lostBy.length
} else {
  ok(true, 'every page comes back with the text it went in with')
}

// The two things Markdown CAN carry, and therefore must: an address and an
// image's alt text. A link card that leaves without its URL is a dead end of
// exactly the kind the sentence promises against.
ok(/\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(md), 'a link card exports with its address intact')
ok(/!\[[^\]]+\]\([^)]+\)/.test(md), 'an image exports with its alt text and reference')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
