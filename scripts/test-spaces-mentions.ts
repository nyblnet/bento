#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
//
// bento/spaces — aliases and unlinked mentions.
//
//   node scripts/test-spaces-mentions.ts
//
// THE ASSERTIONS THAT MATTER HERE ARE THE NEGATIVES. A mention engine that
// finds things is easy; one that does not find a title inside a code block, an
// existing link, a URL or the middle of a longer word is the whole feature.
// Each of those is checked, and each was sabotage-verified — the guard was
// removed, this rig went red, the guard was restored.
//
// It also MEASURES. "Every page's title against every page's text" is the
// quadratic shape this feature has to avoid, so the cost of both the per-page
// path (what the reader's panel calls) and the all-pairs path is timed on a
// synthetic space and printed. A number nobody prints is a number nobody
// checks.

import {
  aliasesOf, namesOf, nameIndex, nameKey, scannable, escapeRe,
  scanRuns, compileNames, mentionsOf, mentionIndex, linkMention,
} from '../spaces/src/mentions.ts'
import { buildIndex, type SpacesDoc, type Page, type Block } from '../spaces/src/model.ts'

let failed = 0
let ran = 0
const ok = (cond: unknown, what: string) => {
  ran++
  if (cond) return
  failed++
  console.error(`  FAIL  ${what}`)
}
const eq = (a: unknown, b: unknown, what: string) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${what}\n        got ${JSON.stringify(a)}\n        want ${JSON.stringify(b)}`)

const blk = (html: string, extra: Partial<Block> = {}): Block =>
  ({ id: `b${Math.random().toString(36).slice(2, 9)}`, type: 'p', html, ...extra })

const pg = (id: string, title: string, blocks: Block[] = [], extra: Partial<Page> = {}): Page =>
  ({ id, title, blocks, ...extra })

const doc = (pages: Page[]): SpacesDoc => ({
  format: 'bento/spaces' as SpacesDoc['format'], version: 1, docId: 'd1',
  title: 'T', pages, theme: { background: '#fff', color: '#000', accent: '#07f', fontFamily: 'x' },
})

const mentions = (pages: Page[], target: string) => {
  const d = doc(pages)
  return mentionsOf(d, buildIndex(d), target)
}

// ---------------------------------------------------------------------------
console.log('names and aliases')
// ---------------------------------------------------------------------------
{
  eq(aliasesOf(pg('p1', 'X')), [], 'no aliases key = no aliases')
  eq(aliasesOf(pg('p1', 'X', [], { aliases: 'NYC' as unknown as string[] })), [],
    'aliases: a bare string is not an array and yields none')
  eq(aliasesOf(pg('p1', 'X', [], { aliases: ['NYC', '', '  ', 42 as unknown as string, 'nyc', 'New York'] })),
    ['NYC', 'New York'], 'aliases: blanks, non-strings and case-dupes dropped')
  eq(namesOf(pg('p1', 'New York', [], { aliases: ['NYC', 'new york'] })), ['New York', 'NYC'],
    'namesOf: title first, an alias equal to the title is not repeated')

  ok(!scannable('It'), '"It" is under the Latin minimum')
  ok(scannable('API'), '"API" is exactly the Latin minimum')
  ok(scannable('東京'), 'two Han characters are scannable')
  ok(!scannable('都'), 'one Han character is not')
  ok(!scannable('  '), 'whitespace is not a name')

  eq(nameKey('  NYC '), 'nyc', 'nameKey trims and folds case')
}

// ---------------------------------------------------------------------------
console.log('nameIndex — resolution and collisions')
// ---------------------------------------------------------------------------
{
  const ix = nameIndex(doc([
    pg('p1', 'New York', [], { aliases: ['NYC', 'The Big Apple'] }),
    pg('p2', 'Projects'),
    pg('p3', 'Archive', [], { aliases: ['Projects'] }),
  ]))
  eq(ix.byName.get('nyc'), 'p1', 'an alias resolves to its page')
  eq(ix.byName.get('new york'), 'p1', 'so does the title')
  eq(ix.byName.get('projects'), 'p2',
    'a TITLE beats an alias claiming the same name, whatever the page order')
  eq([...(ix.collisions.get('projects') ?? [])].sort(), ['p2', 'p3'],
    'the clash is reported, not hidden')
  ok(!ix.collisions.has('nyc'), 'an uncontested alias is not a collision')

  // pages before them in the array must not change the answer
  const flipped = nameIndex(doc([
    pg('p3', 'Archive', [], { aliases: ['Projects'] }),
    pg('p2', 'Projects'),
  ]))
  eq(flipped.byName.get('projects'), 'p2', 'title-before-alias holds when the alias page comes first')
}

// ---------------------------------------------------------------------------
console.log('eligible text — the NEGATIVES')
// ---------------------------------------------------------------------------
{
  const target = pg('t', 'Roadmap')

  const has = (html: string) => mentions([target, pg('s', 'Source', [blk(html)])], 't')

  eq(has('We should read the Roadmap today').length, 1, 'plain prose IS a mention')
  eq(has('We should read the Roadmap today')[0].matched, 'Roadmap', 'the matched text is reported')

  // --- NEGATIVE: inside a code span
  eq(has('run <code>Roadmap --now</code> please').length, 0,
    'NEGATIVE: a title inside a code span is not a mention')
  // --- NEGATIVE: a code BLOCK
  eq(mentions([target, pg('s', 'Source', [blk('Roadmap', { type: 'code' })])], 't').length, 0,
    'NEGATIVE: a title inside a code block is not a mention')
  // --- NEGATIVE: inside an existing link
  eq(has('see <a href="https://x.example/">Roadmap</a>').length, 0,
    'NEGATIVE: a title inside an existing link is not a mention')
  // --- NEGATIVE: inside a URL
  eq(has('see https://example.com/Roadmap/2026 for more').length, 0,
    'NEGATIVE: a title inside a bare URL is not a mention')
  eq(has('mail Roadmap@example.com about it').length, 0,
    'NEGATIVE: a title inside a mail address is not a mention')
  // --- NEGATIVE: a substring of a longer word
  eq(has('the Roadmaps are ready').length, 0,
    'NEGATIVE: a title that is a prefix of a longer word is not a mention')
  eq(has('the preRoadmap plan').length, 0,
    'NEGATIVE: a title that is a suffix of a longer word is not a mention')
  eq(has('the pre-Roadmap plan').length, 1,
    'a hyphen IS a boundary — "pre-Roadmap" mentions Roadmap')
  // --- NEGATIVE: the page's own text
  eq(mentions([pg('t', 'Roadmap', [blk('Roadmap is this page')])], 't').length, 0,
    "NEGATIVE: a page never mentions itself")
  // --- NEGATIVE: a block that already links there
  eq(has('the <a href="#p/t">Roadmap</a> and the Roadmap again').length, 0,
    'NEGATIVE: a block that already links to the target offers no mention')
  // --- NEGATIVE: a skipped region cannot be spliced into a name
  eq(mentions([pg('t', 'New York'), pg('s', 'S', [blk('New<a href="#p/z">x</a>York')])], 't').length, 0,
    'NEGATIVE: a name cannot be assembled across a skipped region')

  // --- attack: regex metacharacters in a title
  const nasty = pg('t2', 'C++ (v2) [beta] .*')
  let threw = false
  let found = -1
  try {
    found = mentions([nasty, pg('s', 'S', [blk('we shipped C++ (v2) [beta] .* last week')])], 't2').length
  } catch { threw = true }
  ok(!threw, 'a title full of regex metacharacters does not throw')
  eq(found, 1, 'and it matches LITERALLY, not as a pattern')
  eq(mentions([nasty, pg('s', 'S', [blk('we shipped Cxx v2 beta zzz last week')])], 't2').length, 0,
    'a metacharacter title does not match what its pattern would have')
  eq(escapeRe('a(b'), 'a\\(b', 'escapeRe escapes')

  // --- case
  eq(has('read the roadmap').length, 1, 'matching is case-insensitive')
  eq(has('read the ROADMAP').length, 1, 'in both directions')

  // --- aliases are mentioned too
  const aliased = pg('t3', 'New York', [], { aliases: ['NYC'] })
  const viaAlias = mentions([aliased, pg('s', 'S', [blk('I moved to NYC last year')])], 't3')
  eq(viaAlias.length, 1, 'an ALIAS is mentioned as well as the title')
  eq(viaAlias[0].matched, 'NYC', 'and the alias is what is reported as matched')

  // --- longest first
  const two = mentions([pg('t4', 'New York City'), pg('o', 'New York')], 't4')
  void two
  const both = doc([
    pg('a', 'New'), pg('b', 'New York'),
    pg('s', 'S', [blk('I live in New York now')]),
  ])
  const ix = mentionIndex(both)
  eq((ix.get('b') ?? []).length, 1, 'the LONGER name wins the overlap')
  eq((ix.get('a') ?? []).length, 0, 'the shorter one does not steal it')
}

// ---------------------------------------------------------------------------
console.log('CJK')
// ---------------------------------------------------------------------------
{
  const tokyo = pg('t', '東京')
  const m = mentions([tokyo, pg('s', 'S', [blk('私は東京に住んでいます。')])], 't')
  eq(m.length, 1, 'ja: a name surrounded by kana IS a mention (a \\b rule finds ZERO here)')
  eq(m[0].matched, '東京', 'ja: the matched text is the name')

  const hans = pg('t2', '北京')
  eq(mentions([hans, pg('s', 'S', [blk('他去了北京开会')])], 't2').length, 1,
    'zh-Hans: a name inside unspaced Han text is a mention')

  const hant = pg('t3', '臺灣')
  eq(mentions([hant, pg('s', 'S', [blk('這是臺灣的資料')])], 't3').length, 1,
    'zh-Hant: likewise')

  // the KNOWN cost of the substring rule, asserted so nobody thinks it a bug
  eq(mentions([pg('t4', '京都'), pg('s', 'S', [blk('東京都に行く')])], 't4').length, 1,
    'documented cost: a Han name matches inside a longer Han compound')

  // mixed script: a Latin edge still gets its boundary
  eq(mentions([pg('t5', 'Bento日本'), pg('s', 'S', [blk('これはBento日本です')])], 't5').length, 1,
    'a mixed name whose edges are Han/Latin matches where each edge allows')

  // CJK inside a code span is still skipped
  eq(mentions([tokyo, pg('s', 'S', [blk('<code>東京</code>')])], 't').length, 0,
    'NEGATIVE: the code-span rule holds for CJK too')
}

// ---------------------------------------------------------------------------
console.log('offsets and linkMention')
// ---------------------------------------------------------------------------
{
  const target = pg('t', 'Roadmap')
  const html = 'read the <b>Roadmap</b> and the Roadmap again'
  const found = mentions([target, pg('s', 'S', [blk(html)])], 't')
  eq(found.length, 2, 'both occurrences are found')
  eq(html.slice(found[0].htmlStart, found[0].htmlEnd), 'Roadmap', 'first offset lands on the html')
  eq(html.slice(found[1].htmlStart, found[1].htmlEnd), 'Roadmap', 'second offset lands on the SECOND one')
  eq(linkMention(html, found[1], 't'),
    'read the <b>Roadmap</b> and the <a href="#p/t">Roadmap</a> again',
    'linkMention wraps exactly the occurrence that matched')

  // entities do not shift the offsets
  const ent = 'the R&amp;D Team met'
  const rd = mentions([pg('t2', 'R&D Team'), pg('s', 'S', [blk(ent)])], 't2')
  eq(rd.length, 1, 'a name spanning an entity is found')
  eq(linkMention(ent, rd[0], 't2'), 'the <a href="#p/t2">R&amp;D Team</a> met',
    'and linking it keeps the entity intact')

  // a stale offset writes nothing
  ok(linkMention('completely different text', found[0], 't') === null,
    'linkMention refuses offsets that no longer describe the html')
  ok(linkMention(html, found[0], '../evil') === null || !String(linkMention(html, found[0], '../evil')).includes('../'),
    'a target id is scrubbed before it becomes an href')

  eq(scanRuns('a<code>b</code>c').text.replace(/ /g, '|'), 'a|c', 'scanRuns drops skipped regions')
  eq(compileNames(['It', 'a']).length, 0, 'nothing scannable compiles to no regex at all')
}

// ---------------------------------------------------------------------------
console.log('cost')
// ---------------------------------------------------------------------------
{
  // A synthetic space in the shape the header claims to survive: many pages,
  // each with real prose, some of which genuinely mentions others.
  const WORDS = ('the quick brown fox jumps over a lazy dog while the roadmap ' +
    'and the design review wait for nobody in particular today').split(' ')
  const build = (n: number): SpacesDoc => {
    const pages: Page[] = []
    for (let i = 0; i < n; i++) {
      const blocks: Block[] = []
      for (let j = 0; j < 12; j++) {
        const words: string[] = []
        for (let k = 0; k < 40; k++) words.push(WORDS[(i * 7 + j * 3 + k) % WORDS.length])
        // one in six paragraphs names another page outright
        if ((i + j) % 6 === 0) words.splice(10, 0, `Page ${(i * 13 + j) % n}`)
        blocks.push(blk(words.join(' ')))
      }
      pages.push(pg(`p${i}`, `Page ${i}`, blocks, i % 5 === 0 ? { aliases: [`Alias ${i}`] } : {}))
    }
    return doc(pages)
  }

  for (const n of [100, 500, 1000]) {
    const d = build(n)
    const ix = buildIndex(d)
    const chars = d.pages.reduce((s, p) => s + p.blocks.reduce((t, b) => t + (b.html ?? '').length, 0), 0)

    const t0 = performance.now()
    for (const p of d.pages.slice(0, 20)) mentionsOf(d, ix, p.id)
    const perPage = (performance.now() - t0) / 20

    const t1 = performance.now()
    const all = mentionIndex(d)
    const allPairs = performance.now() - t1

    const t2 = performance.now()
    buildIndex(d)
    const bi = performance.now() - t2

    let total = 0
    for (const list of all.values()) total += list.length
    console.log(`  ${String(n).padStart(4)} pages, ${(chars / 1024).toFixed(0)}KB text` +
      ` · buildIndex ${bi.toFixed(1)}ms` +
      ` · one page's mentions ${perPage.toFixed(2)}ms` +
      ` · all pairs ${allPairs.toFixed(0)}ms (${total} mentions)`)

    ok(perPage < 200, `per-page mentions on ${n} pages stays under 200ms (was ${perPage.toFixed(1)})`)
  }
}

console.log(failed ? `\n${failed} of ${ran} FAILED` : `\nall ${ran} assertions pass`)
process.exit(failed ? 1 : 0)
