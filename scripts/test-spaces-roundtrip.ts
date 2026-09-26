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
// WHAT IT DOES NOT CHECK, deliberately: block TYPES. Markdown has no toggle,
// no media embed, no board: a toggle leaves as a bullet, a link card as
// `[title](url)`. Type-for-type is test-spaces-md-strict.ts's bar, per block,
// with the types Markdown cannot carry pinned there by name.
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
import { parseNote, planImport } from '../spaces/src/markdown.ts'
import { adoptDesign } from '../spaces/src/designs.ts'
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

const doc = starterDoc() as unknown as { pages: Array<{ id: string; title: string; parent?: string; blocks: unknown[] }> }
const md = toMarkdown(new Store(doc as never) as never)

ok(md.length > 5000, `the starter space exports something substantial (${md.length} B)`)
ok(/^# /m.test(md), 'every page arrives under its own heading')

// The export is one document; a note is one page. Split it the way a reader
// would, and read each page back through the importer.
//
// A PAGE'S HEADING FOLLOWS ITS DEPTH — a root page leaves as `# Title`, a page
// nested one down as `## Title`, and so on (about.ts walk) — so the split is at
// each page's OWN marker, built from the tree, rather than at every `# `. The
// first draft split at `# ` alone, which was the same thing while every page
// in the starter was a root; the moment the tour nested under Welcome it read
// four pages back and reported the other twelve as fine by never looking. And
// a nested page's marker is the same string as a section heading inside its
// parent (`## Writing` the page, `## Try it` the section), which is why the
// split is at the page TITLES specifically and not at any `## `.
const depthOf = (p: { parent?: string }): number => {
  let d = 0
  const seen = new Set<string>()
  for (let cur = p.parent; cur && !seen.has(cur); cur = doc.pages.find((q) => q.id === cur)?.parent) { seen.add(cur); d++ }
  return d
}
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const markers = doc.pages.map((p) => `${'#'.repeat(Math.min(depthOf(p) + 1, 6))} ${esc(p.title)}`)
const sections = md.split(new RegExp(`\\n(?=(?:${markers.join('|')})\\n)`))
let pagesChecked = 0
const lostBy: Array<[string, string[]]> = []

for (const sec of sections) {
  const title = (sec.match(/^#{1,6} (.+)$/m) ?? [])[1]
  if (!title) continue
  const orig = doc.pages.find((p) => p.title === title)
  if (!orig) continue
  const parsed = parseNote(sec.replace(/^#{1,6} .+\n/, ''), title) as { blocks?: unknown[] }
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

ok(pagesChecked >= 8 && pagesChecked === doc.pages.length,
  `read every page of the starter space back (${pagesChecked} of ${doc.pages.length})`)

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

// #TAG, IN AND OUT. A tag lives in the prose and nowhere else, so it costs the
// exporter nothing — which is precisely the claim that has to be measured
// rather than assumed. Two things could break it and both are silent: an
// exporter that escaped the hash for Markdown's sake (`\#recipe`), and a
// parser that read a line beginning `#recipe` as an ATX heading and ate the
// word. Either one loses the classification of every note in the space.
{
  const st = new Store(starterDoc())
  const page = st.doc.pages[0]
  page.blocks.push(
    { id: 'tg1', type: 'p', html: 'a note about #recipe and #project/bento' } as never,
    { id: 'tg2', type: 'p', html: '#leading tag at the start of a line' } as never,
  )
  st.reindex()
  ok(st.tags.tags.get('recipe')?.pages.includes(page.id) === true,
    'the tag index finds a tag written into a page')

  const out = toMarkdown(st as never)
  ok(out.includes('#recipe') && out.includes('#project/bento'),
    'Markdown export emits the hash unescaped — `#recipe`, not `\\#recipe`')

  const back = parseNote(out.slice(out.indexOf('#leading')), 'x')
  ok(back.blocks[0]?.type === 'p',
    'a line that BEGINS with a tag reads back as a paragraph, never a heading')
  ok(String(back.blocks[0]?.html ?? '').includes('#leading'),
    '…with the tag still in it')
}

// ---- the design rides in the front matter ---------------------------------
// "Selectable in the page Markdown": `design:` names it, and a design the
// space carries itself travels as one `designs:` line. A space with no design
// exports exactly as before — no front matter at all.
{
  ok(md.startsWith('# '), 'a space with no design exports with no front matter')

  const withDesign = starterDoc() as unknown as Record<string, unknown>
  withDesign.design = 'almanac'
  const mdA = toMarkdown(new Store(withDesign as never) as never)
  ok(mdA.startsWith('---\ndesign: almanac\n---\n'), 'a built-in design leads the export as `design: almanac` front matter')
  const noteA = parseNote(mdA, 'x')
  ok(noteA.design === 'almanac', 'the importer reads `design` back out of the front matter')
  ok(noteA.frontmatter === undefined, 'front matter holding only the design is consumed, not kept as a folded yaml block')

  const custom = starterDoc() as unknown as Record<string, unknown>
  const harbour = { label: 'Harbour', base: 'almanac', light: { accent: '#0f6e63' }, props: { callout: 'fill' } }
  custom.designs = { harbour, unused: { base: 'riso' } }
  custom.design = 'harbour'
  const mdC = toMarkdown(new Store(custom as never) as never)
  const noteC = parseNote(mdC, 'x')
  ok(noteC.design === 'harbour' && JSON.stringify(noteC.designs) === JSON.stringify({ harbour }),
    'a design the space carries round-trips through Markdown value for value (and only the one in use travels)')
  const plan = planImport([{ path: 'space.md', text: mdC }], { rootTitle: 'Imported' })
  const into = starterDoc() as unknown as Record<string, unknown>
  // the editor's call since per-page designs: registry only, never the space's
  const adopted = adoptDesign(into as never, undefined, plan.designs)
  ok(adopted === null && into.design === undefined && JSON.stringify((into.designs as Record<string, unknown>).harbour) === JSON.stringify(harbour),
    'importing that Markdown adds the design it carried to the registry, and leaves the space\'s own design alone')
  ok(plan.pages.length === 1 && plan.pages[0].design === 'harbour',
    'the note\'s `design:` lands on the page the note became, so it looks as it left')
  const already = starterDoc() as unknown as Record<string, unknown>
  already.design = 'ledger'
  ok(adoptDesign(already as never, plan.design, plan.designs) === null && already.design === 'ledger',
    'an import never restyles a space that already has a design')

  const odd = starterDoc() as unknown as Record<string, unknown>
  odd.design = 'from: a newer build'
  const noteO = parseNote(toMarkdown(new Store(odd as never) as never), 'x')
  ok(noteO.design === 'from: a newer build', 'a design name this build does not know still round-trips through the front matter')
  const obsidian = parseNote('---\ntags: [a]\ndesign: ledger\n---\n# Note\n\nbody', 'x')
  ok(obsidian.design === 'ledger' && obsidian.frontmatter === 'tags: [a]\ndesign: ledger', 'front matter with other keys is still kept verbatim')
}

// ---- per-page designs through Markdown -------------------------------------
// The export is one file today ("Every page, as one .md file"), and it imports
// as ONE note: its headings come back as blocks, not pages. So the round trip
// that carries PER-PAGE designs is the note-per-page one — "Export page as
// Markdown…", and a folder of notes on import — and the whole-space file is
// held to carrying the space's design and the registry every page draws on.
{
  type P = { id: string; parent?: string; title: string; design?: string }
  const space = starterDoc() as unknown as { design?: string; designs?: Record<string, unknown>; pages: P[] }
  space.design = 'almanac'
  const tide = { label: 'Tide', base: 'studio', light: { accent: '#0f6e63' } }
  space.designs = { tide, spare: { base: 'riso' } }
  const [home, sec] = [space.pages[0], space.pages.find((p) => p.parent === space.pages[0].id) ?? space.pages[1]]
  const kid: P = { id: 'p-kid-rt', title: 'Kid note', parent: sec.id, blocks: [{ id: 'b-kid-rt', type: 'p', html: 'kid' }] } as never
  space.pages.push(kid)
  sec.design = 'ledger'
  const st = new Store(space as never)
  const one = (id: string) => toMarkdown(st as never, { page: id })

  const mdSec = one(sec.id)
  ok(mdSec.startsWith('---\ndesign: ledger\n---\n\n# '),'a page that sets its own design exports `design:` in its note\'s front matter')
  const mdKid = one(kid.id)
  ok(mdKid.startsWith('# ') && !/^design:/m.test(mdKid), 'a page that only INHERITS its design (here, its section\'s ledger) writes no front matter')
  const mdHome = one(home.id)
  ok(mdHome.startsWith('# '), 'a page wearing the space\'s design writes none either — the space\'s design is the space file\'s to say')
  kid.design = 'tide'
  const mdTide = one(kid.id)
  ok(mdTide.startsWith('---\ndesign: tide\ndesigns: {"tide":') && !mdTide.includes('spare'),
    'a page on a custom design carries that one registry entry, and only it')

  // import each note as its own page, as a folder of notes
  const plan = planImport([
    { path: 'notes/Section.md', text: mdSec },
    { path: 'notes/Kid note.md', text: mdTide },
    { path: 'notes/Home.md', text: mdHome },
  ], { rootTitle: 'Imported' })
  const byTitle = (t: string) => plan.pages.find((p) => p.title === t)
  ok(byTitle(sec.title)?.design === 'ledger' && byTitle('Kid note')?.design === 'tide' && byTitle(home.title)?.design === undefined,
    'import reads each note\'s `design:` back onto ITS page, and a note without one stays inheriting')
  ok(!plan.pages.some((p) => (p.blocks ?? []).some((b) => (b as { frontmatter?: unknown }).frontmatter)),
    'design-only front matter is consumed on every note, never kept as a folded yaml block')
  const target = starterDoc() as unknown as Record<string, unknown>
  adoptDesign(target as never, undefined, plan.designs)
  ok(target.design === undefined && JSON.stringify((target.designs as Record<string, unknown>).tide) === JSON.stringify(tide),
    'the custom design a page carried joins the target space\'s registry, and the space\'s own design is untouched')

  // unknown names survive per page
  kid.design = 'from-a-newer-build'
  const planU = planImport([{ path: 'k.md', text: one(kid.id) }], { rootTitle: 'x' })
  ok(planU.pages[0].design === 'from-a-newer-build', 'a page design this build does not know round-trips through its note')

  // the whole-space file: the space's design + every custom one a page names
  kid.design = 'tide'
  const whole = toMarkdown(st as never)
  ok(whole.startsWith('---\ndesign: almanac\ndesigns: {"tide":') && !whole.includes('"spare"'),
    'the whole-space export names the space\'s design and carries every custom design a page uses (not unused ones)')
  const planW = planImport([{ path: 'space.md', text: whole }], { rootTitle: 'x' })
  ok(planW.pages.length === 1 && planW.pages[0].design === 'almanac' && JSON.stringify(planW.designs?.tide) === JSON.stringify(tide),
    'importing the whole-space file gives ONE page (as before) wearing the space\'s design, and brings the registry')

  // one undo step, and inherit deletes the key — through the real store
  const s2 = new Store(starterDoc() as never)
  const p2 = (s2 as unknown as { doc: { pages: P[] } }).doc.pages[1]
  const key0 = JSON.stringify((s2 as unknown as { doc: unknown }).doc)
  s2.commit(() => { p2.design = 'riso' }, { structure: false })
  s2.commit(() => { delete p2.design }, { structure: false })
  ok(JSON.stringify((s2 as unknown as { doc: unknown }).doc) === key0, 'set then "Same as parent" leaves the document byte-identical')
  s2.undo()
  ok(((s2 as unknown as { doc: { pages: P[] } }).doc.pages[1]).design === 'riso', 'each design choice is exactly ONE undo step')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
