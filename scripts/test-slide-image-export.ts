#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Slide image export — the PURE half: selection, naming, sizing, time.
//
//   slides/node_modules/.bin/esbuild scripts/test-slide-image-export.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-slide-image-export.mjs" \
//     && node "$TMPDIR/test-slide-image-export.mjs"
//
// (Bundled, not run directly: image-export.ts reaches render.ts, which imports
// './model' extensionless — the same reason scripts/test-sanitize.ts is
// bundled.)
//
// WHAT THIS PROVES. Everything an image export decides BEFORE a pixel exists,
// where the decisions are cheap to get wrong and expensive to notice:
//
//   * WHICH slides. "Current" means the slide the author is looking at, even
//     when it is hidden or an interactive state — those are exactly the slides
//     someone exports one at a time. "All" means the linear flow and nothing
//     else, because a carousel is the linear flow.
//   * WHAT they are called. Archive entries are contiguous ordinals, never
//     titles: a deck whose slides are all called "Untitled" must still unzip
//     into a readable sequence, and an uploader that sorts by name must get
//     the author's order back.
//   * HOW BIG. A raster is allocated from numbers that came out of a document,
//     and a document is untrusted input. Every one of them is checked before
//     anything is allocated.
//   * WHEN. One timestamp for the whole batch, so {{date}}/{{time}} cannot
//     drift across a 40-slide export and land two dates in one carousel.
//
// Page numbers are the subtle one and they get their own section: {{page}} is
// the AUDIENCE's number (paginates(), honouring doc.present.numberHidden), and
// it must not quietly become the ZIP ordinal just because both are integers
// that count slides.

import {
  EXPORT_BUDGETS,
  EXPORT_LIMITS,
  MAX_FILENAME_BYTES,
  SlideImageExportError,
  assertAuthorInputBudget,
  assertResourceBudgets,
  assertSlideImagePixelBudget,
  buildSlideImageExportPlan,
  cssAtKeywords,
  cssUrlTargets,
  exportBaseName,
  fieldContextForExport,
  imageIntrinsicSize,
  rasterSize,
  srcsetCandidates,
  stripCursorDecls,
  type ExportBudgets,
  type SlideImageExportOptions,
} from '../slides/src/image-export.ts'
import { crc32, writeStoreZip, type StoreZipEntry } from '../slides/src/image-export-zip.ts'
import { newDoc, type BentoDoc, type Slide } from '../slides/src/model.ts'
import { execFileSync, spawnSync } from 'node:child_process'
import fsNode from 'node:fs'
import osNode from 'node:os'
import pathNode from 'node:path'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) {
    failures++
    console.error(`  ✗ ${msg}`)
  } else {
    console.log(`  ✓ ${msg}`)
  }
}

/** Run `fn`, returning the SlideImageExportError it threw (or null). */
function thrown(fn: () => unknown): SlideImageExportError | null {
  try { fn() } catch (err) {
    return err instanceof SlideImageExportError ? err : null
  }
  return null
}

// --- the fixture ------------------------------------------------------------
//
// Three main slides, one state, one hidden, in an order that makes "document
// position" and "export ordinal" DIFFERENT numbers — otherwise every off-by-one
// passes.

const slideAt = (id: string, extra: Partial<Slide> = {}): Slide => ({
  id, background: '#FFFFFF', transition: 'none', elements: [], notes: '', ...extra,
})

function fixture(): BentoDoc {
  const doc = newDoc()
  doc.title = 'Deck'
  doc.size = { width: 1080, height: 1080 }
  doc.slides = [
    slideAt('m1'),                          // doc pos 1, export 1
    slideAt('s1', { stateOf: 'm1' }),       // doc pos 2, state — never in "all"
    slideAt('m2'),                          // doc pos 3, export 2
    slideAt('h1', { hidden: true }),        // doc pos 4, hidden — never in "all"
    slideAt('m3'),                          // doc pos 5, export 3
  ]
  return doc
}

const OPTS = (over: Partial<SlideImageExportOptions> = {}): SlideImageExportOptions =>
  ({ scope: 'all-main', format: 'png', scale: 1, ...over })

const AT = new Date(Date.UTC(2026, 7, 15, 9, 30, 0))

// --- 1. selection -----------------------------------------------------------

console.log('\nselection')

{
  const doc = fixture()
  const plan = buildSlideImageExportPlan(doc, 'm1', OPTS(), AT)
  ok(plan.slides.map((p) => p.slide.id).join(',') === 'm1,m2,m3',
    'all-main takes only inLinearFlow slides, in document order')
  ok(plan.slides.map((p) => p.documentIndex).join(',') === '0,2,4',
    'and each one remembers where it sat in doc.slides')
  ok(plan.slides.map((p) => p.slideNumber).join(',') === '1,3,5',
    'slideNumber is the ONE-BASED document position, not the export ordinal')
  ok(plan.slides.map((p) => p.exportIndex).join(',') === '1,2,3',
    'exportIndex is the contiguous ordinal within the selected set')
}

for (const id of ['s1', 'h1']) {
  const doc = fixture()
  const plan = buildSlideImageExportPlan(doc, id, OPTS({ scope: 'current' }), AT)
  ok(plan.slides.length === 1 && plan.slides[0].slide.id === id,
    `current exports the EXACT selected slide, including ${id === 's1' ? 'an interactive state' : 'a hidden slide'}`)
}

{
  const doc = fixture()
  const plan = buildSlideImageExportPlan(doc, 'm2', OPTS({ scope: 'current' }), AT)
  ok(plan.slides[0].slideNumber === 3 && plan.slides[0].exportIndex === 1,
    'a current export keeps the source document position while being the only exported item')
}

console.log('\nselection failures are typed, not silent')

{
  const doc = fixture()
  const err = thrown(() => buildSlideImageExportPlan(doc, 'nope', OPTS({ scope: 'current' }), AT))
  ok(!!err && err.code === 'missing-current', 'an unknown current slide id is a typed missing-current failure')
}
{
  const doc = fixture()
  doc.slides = [slideAt('s1', { stateOf: 'x' }), slideAt('h1', { hidden: true })]
  const err = thrown(() => buildSlideImageExportPlan(doc, 's1', OPTS(), AT))
  ok(!!err && err.code === 'no-slides', 'a deck with no linear slides is a typed no-slides failure')
}
{
  const doc = fixture()
  doc.slides = []
  const err = thrown(() => buildSlideImageExportPlan(doc, 'm1', OPTS({ scope: 'current' }), AT))
  ok(!!err && err.code === 'missing-current', 'an empty deck cannot produce a current export either')
}

// --- 2. naming --------------------------------------------------------------

console.log('\nentry names')

{
  const doc = fixture()
  const plan = buildSlideImageExportPlan(doc, 'm1', OPTS(), AT)
  ok(plan.slides.map((p) => p.entryName).join(',') === 'slide-01.png,slide-02.png,slide-03.png',
    'archive entries are contiguous exported ordinals, zero-padded to at least two digits')
  ok(plan.slides.every((p) => !p.entryName.includes(doc.title)),
    'and never derived from the deck or slide title')
}
{
  const doc = fixture()
  doc.slides = Array.from({ length: 120 }, (_v, i) => slideAt('m' + i))
  const plan = buildSlideImageExportPlan(doc, 'm0', OPTS(), AT)
  ok(plan.slides[0].entryName === 'slide-001.png' && plan.slides[119].entryName === 'slide-120.png',
    'padding widens with the count so 120 slides still sort as text')
}
{
  const doc = fixture()
  const plan = buildSlideImageExportPlan(doc, 'm3', OPTS({ scope: 'current' }), AT)
  ok(plan.slides[0].entryName === 'slide-05.png',
    'a current export is named for its SOURCE document position (m3 is document slide 5)')
  ok(plan.artifactName.endsWith('-slide-05.png'),
    'and the downloaded artifact carries that same suffix')
}
{
  // A CURRENT export pads from the whole deck's length, not from the one slide
  // being exported: slide 7 of 120 is "slide-007", so a folder of single
  // exports from one deck still sorts.
  const doc = fixture()
  doc.slides = Array.from({ length: 120 }, (_v, i) => slideAt('m' + i))
  const plan = buildSlideImageExportPlan(doc, 'm6', OPTS({ scope: 'current' }), AT)
  ok(plan.slides[0].entryName === 'slide-007.png',
    'in a 120-slide deck, exporting the seventh slide is slide-007.png')
  ok(plan.artifactName === 'Deck-slide-007.png',
    'and the downloaded file is named for the deck and that position')
  const last = buildSlideImageExportPlan(doc, 'm119', OPTS({ scope: 'current' }), AT)
  ok(last.artifactName === 'Deck-slide-120.png', 'and the last slide is slide-120.png')
}

console.log('\nformat, extension and mime agree')

for (const [format, ext, mime] of [['png', 'png', 'image/png'], ['jpeg', 'jpg', 'image/jpeg']] as const) {
  const doc = fixture()
  const plan = buildSlideImageExportPlan(doc, 'm1', OPTS({ format }), AT)
  ok(plan.extension === ext && plan.mime === mime && plan.slides[0].entryName.endsWith('.' + ext),
    `${format} exports as .${ext} with ${mime}, everywhere at once`)
}
{
  const doc = fixture()
  ok(buildSlideImageExportPlan(doc, 'm1', OPTS(), AT).artifactName.endsWith('.zip'),
    'an all-main export downloads as one archive')
}

console.log('\nexportBaseName — a title is untrusted text, a filename is not')

const NASTY = '  Q3 // Ergebnis: "Bilanz" <2026>\u0007   \u007F決算 Ünïcøde   ... '
{
  const base = exportBaseName(NASTY)
  ok(!/[/\\]/.test(base), 'path separators cannot survive — a title is not a directory')
  ok(!/[<>:"|?*]/.test(base), 'nor can the characters Windows refuses in a filename')
  // eslint-disable-next-line no-control-regex
  ok(!(new RegExp('[\\u0000-\\u001F\\u007F]')).test(base), 'control characters are removed rather than escaped')
  ok(!/\s{2,}/.test(base) && base === base.trim(), 'repeated whitespace collapses and the ends are trimmed')
  ok(!/[. ]$/.test(base), 'a trailing dot or space is stripped — Windows silently drops them')
  ok(base.includes('決算') && base.includes('Ünïcøde'),
    'Unicode SURVIVES: a deck called 決算報告 must not download as "Untitled"')
}
for (const away of ['', '   ', '...', '///', ' . . . ', '\\\\']) {
  ok(exportBaseName(away) === 'Untitled',
    `a title that sanitizes away (${JSON.stringify(away)}) becomes exactly "Untitled"`)
}
ok(!/^\./.test(exportBaseName('.hidden')), 'a leading dot cannot make the download a hidden file')
// Windows reserves these names WITH AN EXTENSION TOO: CON.txt is as unusable
// as CON, which is the half a bare-name check misses.
for (const device of ['CON', 'nul', 'CON.txt', 'aux.png', 'COM1.tar.gz', 'lpt9.']) {
  const base = exportBaseName(device)
  const stem = base.split('.')[0].toUpperCase()
  ok(!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem),
    `the Windows device name ${JSON.stringify(device)} is defused, extension and all (got ${JSON.stringify(base)})`)
}
ok(exportBaseName('CONTOUR') === 'CONTOUR' && exportBaseName('nullify.png') === 'nullify.png',
  'while a name that merely STARTS with a device name is left alone')
ok(exportBaseName('Q3 Review') === 'Q3 Review',
  'and an ordinary title is left exactly alone')

console.log('\ntruncation is measured in UTF-8 bytes and cuts only whole code points')

/** A name is only usable if it survives a round trip through UTF-8. A lone
 *  surrogate does not: it encodes to U+FFFD and never comes back. */
const encodesCleanly = (s: string) =>
  !s.includes('\uFFFD') && new TextDecoder().decode(new TextEncoder().encode(s)) === s
const bytesOf = (s: string) => new TextEncoder().encode(s).length

{
  ok(bytesOf(exportBaseName('x'.repeat(400))) <= MAX_FILENAME_BYTES,
    'an absurd ASCII title is capped before it meets a filesystem')

  // 3 bytes per character: a character budget would let this through at more
  // than double the byte limit.
  const cjk = exportBaseName('決算報告書'.repeat(80))
  ok(bytesOf(cjk) <= MAX_FILENAME_BYTES && cjk.length * 3 >= bytesOf(cjk),
    'a long CJK title is capped by BYTES, which is what the filesystem counts')
  ok(encodesCleanly(cjk) && cjk.startsWith('決算報告書'), 'and it is still readable Japanese')

  // 4 bytes per emoji, and TWO UTF-16 units — the case a slice() would break.
  const emoji = exportBaseName('🎉'.repeat(200))
  ok(bytesOf(emoji) <= MAX_FILENAME_BYTES, 'a long emoji title is capped by bytes too')
  ok(encodesCleanly(emoji), 'and it contains NO lone surrogate — code points are cut whole')
  ok(bytesOf(emoji) % 4 === 0, 'the cut landed on an emoji boundary, not inside one')

  // the exact boundary: one 4-byte code point that cannot fit must be dropped
  // whole rather than half-written
  const edge = exportBaseName('a'.repeat(MAX_FILENAME_BYTES - 3) + '🎉', MAX_FILENAME_BYTES)
  ok(bytesOf(edge) === MAX_FILENAME_BYTES - 3 && encodesCleanly(edge),
    'a code point that would straddle the budget is dropped entirely')

  ok(bytesOf(exportBaseName('決'.repeat(100), 10)) <= 10,
    'the budget is honoured whatever the caller passes')
}

console.log('\nthe whole downloaded filename fits the budget, suffix included')

for (const [label, title] of [
  ['CJK', '決算報告書'.repeat(80)],
  ['emoji', '🎉'.repeat(200)],
  ['ASCII', 'x'.repeat(400)],
] as const) {
  const doc = fixture()
  doc.title = title
  for (const scope of ['current', 'all-main'] as const) {
    const plan = buildSlideImageExportPlan(doc, 'm1', OPTS({ scope }), AT)
    ok(bytesOf(plan.artifactName) <= MAX_FILENAME_BYTES,
      `a ${label} title exports as a ${scope} artifact within ${MAX_FILENAME_BYTES} UTF-8 bytes ` +
      `(got ${bytesOf(plan.artifactName)})`)
    ok(encodesCleanly(plan.artifactName), `and the ${label} ${scope} filename round-trips through UTF-8`)
    ok(plan.artifactName.endsWith(scope === 'current' ? '-slide-01.png' : '-slides.zip'),
      `and the ${label} ${scope} suffix survived truncation intact`)
  }
}

// --- 3. sizing --------------------------------------------------------------

console.log('\nrasterSize — every number came out of an untrusted document')

const LIMITS = { maxDimension: 4000, maxPixels: 4000 * 4000 }

{
  const one = rasterSize({ width: 1080, height: 1080 }, 1, LIMITS)
  ok(one.width === 1080 && one.height === 1080 && one.pixels === 1080 * 1080,
    '1080x1080 at 1x is 1080x1080')
  const two = rasterSize({ width: 1080, height: 1080 }, 2, LIMITS)
  ok(two.width === 2160 && two.height === 2160 && two.pixels === 2160 * 2160,
    '1080x1080 at 2x is 2160x2160')
  const wide = rasterSize({ width: 1280, height: 720 }, 2, LIMITS)
  ok(wide.width === 2560 && wide.height === 1440, 'a 16:9 deck scales on both axes')
}

for (const [label, size] of [
  ['fractional', { width: 1080.5, height: 1080 }],
  ['zero', { width: 0, height: 1080 }],
  ['negative', { width: -1080, height: 1080 }],
  ['non-finite', { width: Number.POSITIVE_INFINITY, height: 1080 }],
  ['NaN', { width: Number.NaN, height: 1080 }],
] as const) {
  const err = thrown(() => rasterSize(size, 1, LIMITS))
  ok(!!err && err.code === 'size', `a ${label} document size fails before anything is allocated`)
}
{
  const err = thrown(() => rasterSize({ width: 4001, height: 100 }, 1, LIMITS))
  ok(!!err && err.code === 'size', 'a dimension over the limit is refused')
  const scaled = thrown(() => rasterSize({ width: 2001, height: 100 }, 2, LIMITS))
  ok(!!scaled && scaled.code === 'size', 'and the limit is applied AFTER the scale, which is what allocates')
  const area = thrown(() => rasterSize({ width: 3999, height: 3999 }, 1, { maxDimension: 4000, maxPixels: 1000 }))
  ok(!!area && area.code === 'size', 'a total pixel budget is enforced separately from either dimension')
}
{
  const edge = rasterSize({ width: 2000, height: 2000 }, 2, LIMITS)
  ok(edge.width === 4000 && edge.height === 4000, 'the boundary itself is allowed — limits are inclusive')
}

// The scale is typed 1 | 2, and a type is a promise the compiler keeps only
// about code it compiled. This value arrives from a dialog, so the runtime
// check is the one that matters.
for (const [label, scale] of [
  ['3', 3], ['0', 0], ['-1', -1], ['1.5', 1.5], ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY], ['"2" (a string)', '2'],
  ['undefined', undefined], ['null', null], ['{} (an object)', {}],
] as const) {
  const err = thrown(() => rasterSize({ width: 1080, height: 1080 }, scale as never, LIMITS))
  ok(!!err && err.code === 'size', `a scale of ${label} is refused at runtime, not trusted from the type`)
}

// --- 4. time ----------------------------------------------------------------

console.log('\none timestamp for the whole batch')

{
  const doc = fixture()
  const plan = buildSlideImageExportPlan(doc, 'm1', OPTS(), AT)
  ok(plan.capturedAt === AT, 'the plan carries the exact Date it was given')
  const dates = plan.slides.map((p) => fieldContextForExport(doc, p.slide, plan.capturedAt).date)
  ok(dates.every((d) => d === AT),
    'and every slide resolves {{date}}/{{time}} against that same Date OBJECT, not a fresh one')
}

// --- 5. page numbers stay the audience's numbers ----------------------------

console.log('\n{{page}} is the audience number, not the export ordinal')

{
  const doc = fixture()
  const plan = buildSlideImageExportPlan(doc, 'm1', OPTS(), AT)
  const pages = plan.slides.map((p) => fieldContextForExport(doc, p.slide, AT).page)
  ok(pages.join(',') === '1,2,3', 'by default hidden and state slides are uncounted, so main slides read 1..N')
  const total = fieldContextForExport(doc, doc.slides[0], AT).pages
  ok(total === 3, 'and {{pages}} agrees')
}
{
  const doc = fixture()
  doc.present = { numberHidden: true }
  const ctx = fieldContextForExport(doc, doc.slides[4], AT)
  ok(ctx.pages === 4 && ctx.page === 4,
    'doc.present.numberHidden still counts the hidden slide — export does not reinterpret paginates()')
  const plan = buildSlideImageExportPlan(doc, 'm1', OPTS(), AT)
  ok(plan.slides[2].exportIndex === 3 && fieldContextForExport(doc, plan.slides[2].slide, AT).page === 4,
    'so the third exported image is page 4 — the ZIP ordinal and the page number are allowed to disagree')
}
{
  const doc = fixture()
  const ctx = fieldContextForExport(doc, doc.slides[1], AT)
  ok(typeof ctx.page === 'number' && ctx.title === 'Deck',
    'a state slide still resolves a field context (it is exportable as the current slide)')
}

// --- 6. the plan does not touch the document --------------------------------

console.log('\nthe plan is a read of the document, never a write')

{
  const doc = fixture()
  const before = JSON.stringify(doc)
  buildSlideImageExportPlan(doc, 'm1', OPTS(), AT)
  buildSlideImageExportPlan(doc, 'h1', OPTS({ scope: 'current', format: 'jpeg', scale: 2 }), AT)
  ok(JSON.stringify(doc) === before, 'planning an export leaves the document byte-identical')
}

// --- 6b. the SHIPPED budget -------------------------------------------------
//
// EXPORT_LIMITS is a conservative PRODUCT POLICY, not a browser capability:
// only Chrome has been measured for this feature, and the budget sits far below
// even that. These checks pin the CONSEQUENCES of the policy — which decks
// export and which are refused — so the day someone edits the numbers they find
// out here which promises they just changed, rather than in a bug report.
//
// Nothing here asserts what any particular engine can do. That would be a claim
// this repository has not earned.

console.log('\nthe shipped raster budget')

const fits = (w: number, h: number, scale: 1 | 2) => !thrown(() => rasterSize({ width: w, height: h }, scale, EXPORT_LIMITS))

ok(fits(2160, 2160, 1), 'the acceptance floor, 2160x2160, is inside the shipped budget')
ok(fits(1080, 1080, 2), 'and so is the carousel case: a 1080 square deck at 2x')
ok(fits(1280, 720, 2) && fits(1600, 900, 2), 'and 16:9 decks at 2x')
ok(fits(4000, 4000, 1), 'and a 4000x4000 deck at 1x')
ok(!fits(4000, 4000, 2),
  'a 4000x4000 deck at 2x is REFUSED — a real product limit, surfaced rather than downscaled')
{
  const err = thrown(() => rasterSize({ width: 4000, height: 4000 }, 2, EXPORT_LIMITS))
  ok(!!err && err.code === 'size' && err.message.includes('8000'),
    'and the refusal names the size it refused, so the message is actionable')
  // The message is user-facing copy, and it must not tell the user something
  // about their browser that this repository has never measured.
  ok(!!err && !/this browser|reliably render|supports|cannot handle/i.test(err.message),
    'and it describes OUR limit, not a capability of the reader\'s browser')
}
ok(EXPORT_LIMITS.maxPixels <= 4096 * 4096 && EXPORT_LIMITS.maxDimension <= 8192,
  'the budget stays at or under the conservative policy ceiling (4096² pixels, 8192 per side) — ' +
  'raising it needs measurements from the engines it would be promising')

// --- 6b-i. the CSS audit, against a hostile stylesheet ----------------------
//
// The audit that decides "would this fetch" reads CSS, and CSS is a token
// grammar, not a string. A `url(` written as `u\72l(` is the SAME FUNCTION to
// every browser and a different string to every regex — which is exactly the
// class of bypass scripts/test-sanitize.ts already measured FETCHING for
// `@\69mport`. So this scans with the grammar's own rules.

console.log('\nthe css audit reads tokens, not strings')

const found = (css: string) => cssUrlTargets(css).join(',')

ok(found('a{background:url(http://x.invalid/p.png)}') === 'http://x.invalid/p.png',
  'a plain url() target is found')
ok(found("a{background:url('http://x.invalid/p.png')}") === 'http://x.invalid/p.png',
  'and a quoted one')
ok(found('a{background:URL(http://x.invalid/p.png)}') === 'http://x.invalid/p.png',
  'and an upper-case one — CSS idents are case-insensitive')
ok(found('a{background:u\\72l(http://x.invalid/escaped.png)}') === 'http://x.invalid/escaped.png',
  'and u\\72l(…), which is url() written with a hex escape — the P0 bypass')
ok(found('a{background:u\\00072l(http://x.invalid/e6.png)}') === 'http://x.invalid/e6.png',
  'and the six-digit form of the same escape')
ok(found('a{background:\\75rl(http://x.invalid/e1.png)}') === 'http://x.invalid/e1.png',
  'and an escape on the FIRST character')
ok(found('a{background:u\\r\\l(http://x.invalid/eid.png)}') === 'http://x.invalid/eid.png',
  'and identity escapes, where the backslash means only "take the next character"')
ok(found('a{background:url( \t http://x.invalid/pad.png )}') === 'http://x.invalid/pad.png',
  'padding inside the parentheses does not hide the target')
ok(found('a{/* url(http://x.invalid/incomment.png) */background:red}') === '',
  'a url() inside a COMMENT is not a fetch, and must not be reported as one')
ok(found('a{background:url(http://x.invalid/c1.png)}/*c*/b{background:url(http://x.invalid/c2.png)}')
  === 'http://x.invalid/c1.png,http://x.invalid/c2.png',
  'and a comment between two rules hides neither of them')
ok(found('a::after{content:"url(http://x.invalid/instring.png)"}') === '',
  'a url() inside a STRING is content, not a fetch')
ok(found('a{background-image:image-set(url(http://x.invalid/is.png) 1x)}')
  .includes('http://x.invalid/is.png'), 'image-set() is a fetch too')
ok(found('a{fill:url(#grad)}') === '#grad', 'and the local fragment idiom is still reported, to be allowed')
ok(found('a{background:none;color:burlywood}') === '',
  'a value that merely CONTAINS "url" is not a url() — burlywood is a colour')

console.log('\nand the string-candidate functions, which fetch without any url()')

// image-set() takes a bare <string> as an image candidate. There is no url()
// anywhere in `image-set("http://…" 1x)` and it fetches exactly the same.
ok(found('a{background:image-set("http://x.invalid/s.png" 1x)}') === 'http://x.invalid/s.png',
  'image-set("…") is a fetch even though the value contains no url()')
ok(found("a{background:-webkit-image-set('http://x.invalid/w.png' 1x)}") === 'http://x.invalid/w.png',
  'and so is the -webkit- prefixed spelling still shipping in the wild')
ok(found('a{background:image-set("http://x.invalid/a.png" 1x, url(http://x.invalid/b.png) 2x)}')
  === 'http://x.invalid/a.png,http://x.invalid/b.png',
  'a candidate list mixing a string and a url() reports both')
ok(found('a{background:im\\61ge-set("http://x.invalid/e.png" 1x)}') === 'http://x.invalid/e.png',
  'and the function name takes escapes too')
// Deliberately NOT asserted here: cross-fade(), image(), and the other
// image-valued functions that MIGHT accept a bare string. image-set() and
// -webkit-image-set() are the surface a Chrome positive control actually
// proved fetches; the rest would be a policy claim with no measurement behind
// it, and this file does not make those.
//
// The other half of the contract: a string is only a candidate INSIDE an image
// function. Everywhere else it is text, and reporting it would refuse decks
// over their own content.
ok(found('a::after{content:"http://x.invalid/text.png"}') === '',
  'a string in an ordinary declaration is content, not a candidate')
ok(found('a{font-family:"http://x.invalid/not-a-font"}') === '',
  'nor is a quoted font family')
ok(found('a{background:image-set(/* "http://x.invalid/c.png" */ url(http://x.invalid/real.png) 1x)}')
  === 'http://x.invalid/real.png',
  'and a candidate commented out inside image-set() is not one')

console.log('\nhostile escapes cannot crash the audit')

// String.fromCodePoint throws RangeError above 0x10FFFF, and a CSS escape may
// name any six hex digits. An audit that throws is an audit that does not run.
const HOSTILE_ESCAPES = [
  'a{background:\\FFFFFFurl(http://x.invalid/of.png)}',
  'a{background:u\\110000rl(http://x.invalid/of2.png)}',
  'a{background:\\0url(http://x.invalid/nul.png)}',
  'a{background:\\D800url(http://x.invalid/sur.png)}',
  'a{background:u\\rl(http://x.invalid/trunc.png)',
  'a{background:url(',
  'a{background:\\',
]
for (const hostile of HOSTILE_ESCAPES) {
  let threw: unknown = null
  try { cssUrlTargets(hostile); cssAtKeywords(hostile) } catch (err) { threw = err }
  ok(threw === null, `an out-of-range or truncated escape does not throw: ${JSON.stringify(hostile.slice(0, 44))}`)
}

console.log('\nand they normalize the way CSS says, not into a working url()')

// CSS Syntax §4.3.7: an escape naming zero, a surrogate, or a value above the
// maximum code point becomes U+FFFD. So none of these spell "url", and none of
// them may produce a target — the conservative outcome AND the specified one.
for (const [label, css, absent] of [
  ['\\FFFFFF (above the maximum code point)',
    'a{background:\\FFFFFFurl(http://x.invalid/of.png)}', 'http://x.invalid/of.png'],
  ['u\\110000rl (above the maximum, mid-ident)',
    'a{background:u\\110000rl(http://x.invalid/of2.png)}', 'http://x.invalid/of2.png'],
  ['\\0 (zero)',
    'a{background:\\0url(http://x.invalid/nul.png)}', 'http://x.invalid/nul.png'],
  ['\\D800 (a lone surrogate)',
    'a{background:\\D800url(http://x.invalid/sur.png)}', 'http://x.invalid/sur.png'],
] as const) {
  const targets = cssUrlTargets(css)
  ok(!targets.includes(absent),
    `${label} normalizes to U+FFFD, so it does not synthesize url() and ${absent} is absent`)
  ok(targets.length === 0, `and ${label} yields no target at all`)
}
// The control that keeps the four checks above from being vacuous: a VALID
// escape of the same shape does resolve, and does produce a target.
ok(cssUrlTargets('a{background:\\75rl(http://x.invalid/valid.png)}')
  .includes('http://x.invalid/valid.png'),
  'while \\75rl (a valid escape for "u") still resolves to a real url() target')

console.log('\nsrcset is a LIST, and every candidate in it is a fetch')

// `srcset="a.png 1x, http://evil/b.png 2x"` is two URLs in one attribute value.
// Treating the value as a single reference checks the first candidate and lets
// the second through — and the browser picks whichever it likes.
ok(srcsetCandidates('a.png 1x, http://x.invalid/b.png 2x').join(',') === 'a.png,http://x.invalid/b.png',
  'both candidates come out of a two-entry srcset')
ok(srcsetCandidates('#local 1x, http://x.invalid/second.png 2x')[1] === 'http://x.invalid/second.png',
  'including when the FIRST candidate is local and only the second is remote')
ok(srcsetCandidates('only.png').join(',') === 'only.png', 'a single candidate needs no descriptor')
ok(srcsetCandidates('  a.png   1x ,   b.png   2x  ').join(',') === 'a.png,b.png',
  'padding around candidates and descriptors is not part of the url')
ok(srcsetCandidates('a.png 100w, b.png 200w, c.png 300w').length === 3, 'width descriptors too')
ok(srcsetCandidates('').length === 0 && srcsetCandidates('   ').length === 0,
  'and an empty srcset has no candidates')
// A data: URI can legally contain a comma, which is exactly the separator.
ok(srcsetCandidates('data:image/png;base64,iVBORw0KGgo= 1x').join(',') ===
  'data:image/png;base64,iVBORw0KGgo=',
  'a data: URI is one candidate, even though it contains the comma that separates them')

console.log('\nauthor markup and css are bounded BEFORE they are parsed')

ok(EXPORT_BUDGETS.maxAuthorMarkupChars > 0 && EXPORT_BUDGETS.maxAuthorCssChars > 0,
  'both raw-input budgets exist')
ok(EXPORT_BUDGETS.maxAuthorMarkupChars <= EXPORT_BUDGETS.maxSerializedBytes,
  'one drawing cannot be allowed to be larger than the whole serialized slide')
{
  const budgets: ExportBudgets = { ...EXPORT_BUDGETS, maxAuthorCssChars: 10 }
  const err = thrown(() => assertAuthorInputBudget('css', 'a'.repeat(50), 1, budgets))
  ok(!!err && err.code === 'size',
    'an oversized stylesheet is refused before a scanner ever walks it')
  ok(!!err && err.slideNumber === 1, 'and the refusal names the slide')
  ok(!thrown(() => assertAuthorInputBudget('css', 'a'.repeat(10), 1, budgets)),
    'while the boundary itself is allowed')
}

console.log('\ncursor is stripped however the property name is spelled')

for (const [label, css] of [
  ['plain', '.a{cursor:url(http://x.invalid/c1.png),pointer;color:red}'],
  ['escaped property', '.a{cur\\73or:url(http://x.invalid/c2.png),pointer;color:red}'],
  ['escape on the first character', '.a{\\63ursor:url(http://x.invalid/c3.png),pointer;color:red}'],
  ['comment before the colon', '.a{cursor/**/:url(http://x.invalid/c4.png),pointer;color:red}'],
  ['upper case', '.a{CURSOR:url(http://x.invalid/c5.png),pointer;color:red}'],
] as const) {
  const stripped = stripCursorDecls(css)
  ok(cssUrlTargets(stripped).length === 0,
    `a cursor written ${label} is REMOVED, so it is never weighed as a resource`)
  ok(stripped.includes('color:red'), `and the ${label} rule keeps its other declarations`)
}
ok(stripCursorDecls('.a{background:url(http://x.invalid/keep.png)}').includes('keep.png'),
  'while a declaration that is not a cursor is left completely alone')

// The strip walks a value grammar, so the hazards are the places a naive scan
// mistakes for the end of a declaration: a `;` or `}` inside a string, and a
// comment in the middle of one. None of them may take neighbouring CSS with it.
{
  const tricky = '.a{cursor:url("http://x.invalid/semi;brace}.png"),pointer;color:red}.b{color:blue}'
  const stripped = stripCursorDecls(tricky)
  ok(cssUrlTargets(stripped).length === 0, 'a cursor whose url contains ; and } is still removed whole')
  ok(stripped.includes('color:red') && stripped.includes('.b{color:blue}'),
    'and neither the rest of its rule nor the NEXT rule is damaged')

  const commented = '.a{cursor:/*x*/url(http://x.invalid/cc.png),pointer;color:red}.b{color:blue}'
  const strippedC = stripCursorDecls(commented)
  ok(cssUrlTargets(strippedC).length === 0, 'a comment inside the cursor VALUE does not hide it')
  ok(strippedC.includes('color:red') && strippedC.includes('.b{color:blue}'),
    'and the surrounding css survives that too')

  const notCursor = '.a{background-image:url(http://x.invalid/bg.png);--cursor-ish:1;color:red}'
  ok(stripCursorDecls(notCursor) === notCursor,
    'a property that merely CONTAINS "cursor" is untouched, byte for byte')
  const custom = '.a{--cursor:url(http://x.invalid/custom.png);color:red}'
  ok(stripCursorDecls(custom) === custom,
    'and so is a custom property called --cursor, which is not the cursor property')
}

console.log('\nand at-keywords the same way')

ok(cssAtKeywords('@import "x";').includes('import'), '@import is found')
ok(cssAtKeywords('@\\69mport "x";').includes('import'), 'and @\\69mport, which fetched once')
ok(cssAtKeywords('@im\\port url(x);').includes('import'), 'and @im\\port')
ok(cssAtKeywords('/* @import "x"; */ a{color:red}').includes('import') === false,
  'an @import inside a comment is not an at-rule')
ok(cssAtKeywords('a::after{content:"@import"}').includes('import') === false,
  'nor is one inside a string')
ok(cssAtKeywords('@media screen{a{color:red}}').includes('media'), 'ordinary at-rules are still seen')

console.log('\ncursor declarations are REMOVED, never a reason to refuse')

{
  const cursor = '.a{cursor:url("data:image/png;base64,iVBORw0KGgo=") 4 4, pointer;color:red}'
  const stripped = stripCursorDecls(cursor)
  ok(!/cursor/i.test(stripped), 'a cursor carrying an embedded image is stripped')
  ok(stripped.includes('color:red'), 'and the rest of the rule survives')
  ok(cssUrlTargets(stripped).length === 0,
    'so a perfectly VALID embedded cursor is omitted from the export, not refused as a resource')
  const escaped = stripCursorDecls('.a{cursor:u\\72l(http://x.invalid/c.png), pointer}')
  ok(cssUrlTargets(escaped).length === 0, 'and the escaped-url spelling of a cursor goes too')
}

// --- 6b-ii. intrinsic image size, read from the HEADER ----------------------
//
// A 40-byte header can declare 60000x60000. Handing that to the DOM is a
// 14 GB decode request, and the file that asked for it fits in a tweet. So the
// dimensions are read from the bytes and refused BEFORE any image element
// exists — which is also why every fixture here is a few dozen bytes.

console.log('\nintrinsic image size comes from the header, before any decode')

const u8 = (...v: number[]) => new Uint8Array(v)
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >>> 8) & 255]

const pngHeader = (w: number, h: number) => u8(
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0)
const gifHeader = (w: number, h: number) => u8(
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le16(w), ...le16(h), 0, 0, 0)
const jpegHeader = (w: number, h: number) => u8(
  0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xFF, 0xC0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1)
const webpVp8x = (w: number, h: number) => {
  const cw = w - 1, ch = h - 1
  return u8(0x52, 0x49, 0x46, 0x46, 30, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0,
    cw & 255, (cw >> 8) & 255, (cw >> 16) & 255, ch & 255, (ch >> 8) & 255, (ch >> 16) & 255)
}

for (const [label, bytes, w, h] of [
  ['png', pngHeader(1234, 567), 1234, 567],
  ['gif', gifHeader(640, 480), 640, 480],
  ['jpeg', jpegHeader(800, 600), 800, 600],
  ['webp (VP8X)', webpVp8x(4000, 3000), 4000, 3000],
] as const) {
  const size = imageIntrinsicSize(bytes as Uint8Array)
  ok(!!size && size.width === w && size.height === h,
    `${label}: ${w}x${h} is read from a ${(bytes as Uint8Array).length}-byte header`)
}
ok(imageIntrinsicSize(u8(1, 2, 3, 4, 5, 6, 7, 8)) === null,
  'and something that is not an image has no intrinsic size')

// JPEG markers may be preceded by ANY number of 0xFF fill bytes — that is
// legal, and a walk that reads the marker at at+1 unconditionally reads 0xFF
// as the marker, then reads a length from the wrong offset and wanders.
{
  const withFill = u8(
    0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    // four legal fill bytes before SOF0
    0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xC0, 0, 17, 8, (600 >> 8) & 255, 600 & 255, (800 >> 8) & 255, 800 & 255,
    3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1)
  const size = imageIntrinsicSize(withFill)
  ok(!!size && size.width === 800 && size.height === 600,
    'a JPEG whose SOF0 is preceded by legal 0xFF fill bytes still reports 800x600')
}
{
  const huge = imageIntrinsicSize(pngHeader(60000, 60000))
  ok(!!huge && huge.width * huge.height > EXPORT_BUDGETS.maxImagePixels,
    'a 33-byte png header can declare 3.6 GIGApixels — which is why this is read, not decoded')

  // THE LONG-THIN BOMB. 1 x 16,000,000 is only 16 megapixels, so a pixel-count
  // guard alone waves it straight through — and then something has to allocate
  // a sixteen-million-row bitmap. A per-SIDE bound is the half that catches it.
  const thin = imageIntrinsicSize(pngHeader(1, 16_000_000))
  ok(!!thin && thin.width * thin.height <= EXPORT_BUDGETS.maxImagePixels,
    'a 1 x 16,000,000 image is UNDER the pixel budget, so pixels alone cannot refuse it')
  ok(!!thin && thin.height > EXPORT_BUDGETS.maxImageDimension,
    'but it is over the per-side bound, which is why both bounds exist')
  const wide = imageIntrinsicSize(pngHeader(16_000_000, 1))
  ok(!!wide && wide.width > EXPORT_BUDGETS.maxImageDimension,
    'and the same is true rotated ninety degrees')
}
for (const [w, h] of [[0, 100], [100, 0], [0, 0]] as const) {
  const size = imageIntrinsicSize(pngHeader(w, h))
  ok(!!size && (size.width <= 0 || size.height <= 0),
    `a header declaring ${w}x${h} reports a non-positive side, for the caller to refuse`)
}

// --- 6b-iii. the budgets, exercised with small injected limits --------------
//
// Every one of these guards exists to prevent an allocation, so testing them by
// performing the allocation would be self-defeating. They are pure functions
// over LENGTHS, and the limits are injected small.

console.log('\nresource budgets, deduplicated and injected small')

// The units are URI CHARACTERS, not decoded bytes, and the names say so. This
// guard runs BEFORE any decode — that is the whole point of it — so it cannot
// know a byte count, and a field called "bytes" holding characters is how a
// budget silently becomes 33% wrong.
const TINY: ExportBudgets = {
  ...EXPORT_BUDGETS,
  maxResourceUriChars: 100,
  maxTotalResourceUriChars: 250,
}
/** A DISTINCT uri of exactly `n` characters — `tag` keeps them from folding. */
const uri = (n: number, tag = 'A') =>
  `data:image/png;base64,${tag.repeat(Math.max(0, n - 22))}`

{
  const one = thrown(() => assertResourceBudgets([uri(101)], TINY))
  ok(!!one && one.code === 'size', 'a single resource over the per-resource budget is refused')
  ok(!thrown(() => assertResourceBudgets([uri(100)], TINY)), 'and the boundary itself is allowed')

  const many = thrown(() => assertResourceBudgets([uri(90, 'A'), uri(90, 'B'), uri(90, 'C')], TINY))
  ok(!!many && many.code === 'size',
    'three DIFFERENT resources that each fit but TOGETHER do not are refused — the aggregate is the real cost')

  // The same picture used on twelve slides is ONE payload in the export, so
  // charging for it twelve times would refuse a deck that is perfectly fine.
  const same = uri(90)
  ok(!thrown(() => assertResourceBudgets([same, same, same, same], TINY)),
    'and the aggregate is DEDUPLICATED: one image reused on four slides is charged once')

  const total = assertResourceBudgets([uri(90, 'A'), uri(90, 'B')], TINY)
  ok(total.distinct === 2 && total.uriChars === 180,
    'the helper reports what it counted, in the unit it counted (uri characters)')
  const folded = assertResourceBudgets([same, same, same], TINY)
  ok(folded.distinct === 1 && folded.uriChars === 90,
    'and a repeated resource is counted exactly once')
}

console.log('\nper-slide compressed-image pressure, which no single limit catches')

// Twelve DISTINCT 4000x4000 photographs are each perfectly legal and each
// compress to a few hundred KB. Decoded together on one slide they are ~750 MB.
// Neither the per-resource bound nor the URI-character total sees that coming,
// because neither is a question about decoded pixels on one surface.
{
  const PIXELS: ExportBudgets = { ...EXPORT_BUDGETS, maxSlideImagePixels: 50 }
  const entry = (slideNumber: number, uri: string, pixels: number) => ({ slideNumber, uri, pixels })

  ok(!thrown(() => assertSlideImagePixelBudget([entry(1, 'a', 40)], PIXELS)),
    'one image inside the per-slide pixel budget is fine')
  const over = thrown(() => assertSlideImagePixelBudget(
    [entry(1, 'a', 30), entry(1, 'b', 30)], PIXELS))
  ok(!!over && over.code === 'size',
    'two images that each fit but together do not are refused')
  ok(!!over && over.slideNumber === 1, 'and the refusal names the slide they are on')

  ok(!thrown(() => assertSlideImagePixelBudget(
    [entry(1, 'a', 30), entry(1, 'a', 30)], PIXELS)),
    'the SAME image twice on one slide is one decode, so it is charged once')

  ok(!thrown(() => assertSlideImagePixelBudget(
    [entry(1, 'a', 40), entry(2, 'b', 40)], PIXELS)),
    'and the budget is PER SLIDE — two slides do not pool their pixels')

  const second = thrown(() => assertSlideImagePixelBudget(
    [entry(1, 'a', 40), entry(2, 'b', 30), entry(2, 'c', 30)], PIXELS))
  ok(!!second && second.slideNumber === 2, 'the slide that actually overflows is the one reported')
}

console.log('\nevery budget is injectable, so a guard can be hit without allocating')

// A guard that can only be reached by allocating what it exists to refuse is a
// guard nothing tests. Each of these is driven with a budget set to a handful
// of bytes instead.
{
  const tiny = (over: Partial<ExportBudgets>): ExportBudgets => ({ ...EXPORT_BUDGETS, ...over })
  const cases: Array<[string, () => unknown]> = [
    ['per-resource URI characters',
      () => assertResourceBudgets([uri(50)], tiny({ maxResourceUriChars: 10 }))],
    ['total URI characters',
      () => assertResourceBudgets([uri(50, 'A'), uri(50, 'B')],
        tiny({ maxResourceUriChars: 100, maxTotalResourceUriChars: 60 }))],
    ['per-slide intrinsic pixels',
      () => assertSlideImagePixelBudget([{ slideNumber: 1, uri: 'a', pixels: 11 }],
        tiny({ maxSlideImagePixels: 10 }))],
  ]
  for (const [label, run] of cases) {
    const err = thrown(run)
    ok(!!err && err.code === 'size', `the ${label} guard fires from an injected budget of a few bytes`)
  }
}

console.log('\nthe shipped budgets are internally consistent')

ok(EXPORT_BUDGETS.maxResourceUriChars <= EXPORT_BUDGETS.maxTotalResourceUriChars,
  'one resource cannot be allowed to exceed the total budget')
ok(EXPORT_BUDGETS.maxImageDimension > 0 && EXPORT_BUDGETS.maxImagePixels > 0,
  'both intrinsic bounds exist — pixels alone cannot catch a 1 x 16,000,000 image')
ok(EXPORT_BUDGETS.maxImageDimension ** 2 >= EXPORT_BUDGETS.maxImagePixels,
  'and the per-side bound is not so tight that it makes the pixel bound unreachable')
ok(EXPORT_BUDGETS.maxSlideImagePixels >= EXPORT_BUDGETS.maxImagePixels,
  'one legal image must always fit on one slide, or the two bounds contradict each other')
ok(EXPORT_BUDGETS.maxSlideImagePixels <= 8 * EXPORT_BUDGETS.maxImagePixels,
  'while the per-slide pool stays conservative — this is the compressed-image pressure bound')
ok(EXPORT_BUDGETS.maxDataUriChars >= EXPORT_BUDGETS.maxSerializedBytes,
  'the percent-encoded data URI is larger than the SVG it wraps, so its cap is not smaller')
// A ZIP is built by holding the encoded images, then a buffer of the same size,
// then a Blob copy: roughly three times the accumulated bytes at the peak.
ok(EXPORT_BUDGETS.maxEncodedBatchBytes * 3 <= 1024 * 1024 * 1024,
  'the batch cap keeps the archive peak (entries + zip buffer + blob) under 1 GiB')

// --- 6c. what this module is allowed to depend on ---------------------------
//
// An image export is a DERIVATIVE. It must not be able to reach the machinery
// that writes the user's actual document, because the worst outcome here is not
// a bad picture — it is a deck that got saved, re-keyed or marked dirty by
// something the user thought was an export.

console.log('\nthe exporter cannot reach the document-writing machinery')

{
  const src = fsNode.readFileSync(pathNode.resolve('slides/src/image-export.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const imports = Array.from(code.matchAll(/from\s+['"]([^'"]+)['"]/g)).map((m) => m[1])
  ok(imports.length > 0 && code.length < src.length,
    '(the import scan found imports and the comment strip removed something)')

  const forbidden = ['save', 'autosave', 'update', 'store', 'session', 'online', 'crdt', 'sync', 'kernel', 'preview']
  const offenders = imports.filter((i) => forbidden.some((f) => i.includes(f)))
  ok(offenders.length === 0,
    `the exporter imports no serializer, autosave, updater, store or sync module (found: ${offenders.join(', ') || 'none'})`)
  ok(imports.every((i) => i.startsWith('./')),
    'and nothing from outside this app zone at all — no cross-app or kernel reach')

  // The download seam is the one place a file leaves the tab, and it must be
  // the browser's own machinery rather than ours.
  ok(/URL\.createObjectURL/.test(code) && /revokeObjectURL/.test(code),
    'the download uses an object URL and revokes it')
  ok(!/showSaveFilePicker|createWritable|fileHandle/i.test(code),
    'and never touches a File System Access handle — an export cannot overwrite the deck')
}

// The two modules must not import each other. A cycle happens to work under
// this bundler today; it is still a load-order hazard nobody should have to
// reason about, and the shared piece is one small error type.
{
  const readCode = (p: string) => fsNode.readFileSync(pathNode.resolve(p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const importsOf = (p: string) =>
    Array.from(readCode(p).matchAll(/from\s+['"]([^'"]+)['"]/g)).map((m) => m[1])

  const exportImports = importsOf('slides/src/image-export.ts')
  const zipImports = importsOf('slides/src/image-export-zip.ts')
  ok(!zipImports.some((i) => i.endsWith('/image-export') || i === './image-export'),
    'the zip writer does not import the exporter')
  ok(!exportImports.some((i) => i.endsWith('/image-export-zip')) ||
    !zipImports.some((i) => i.endsWith('/image-export')),
    'so there is no runtime cycle between them')
  ok([...exportImports, ...zipImports].some((i) => i.includes('image-export-errors')),
    'they share one small neutral error module instead')
}

// instanceof has to keep working across that split, because every caller and
// every test narrows on it.
{
  const err = thrown(() => rasterSize({ width: 0, height: 0 }, 1, EXPORT_LIMITS))
  ok(err instanceof SlideImageExportError && err instanceof Error,
    'SlideImageExportError imported from image-export.ts is still the real class')
  ok(SlideImageExportError.name === 'SlideImageExportError', 'and keeps its name')
}

// --- 7. the archive ---------------------------------------------------------
//
// One deliberately small STORE-only writer. It exists because "one save dialog
// instead of 20" is the whole feature request, and because a PNG is already
// DEFLATE-compressed — re-compressing it costs CPU to make the file bigger.
//
// The bar is not "it looks like a zip". A user's archive is opened by Finder,
// Explorer, unzip, and whatever the platform they upload to runs, so the proof
// is INDEPENDENT readers accepting the bytes, not our own parser agreeing with
// our own writer.

console.log('\ncrc-32')

const utf8 = (s: string) => new TextEncoder().encode(s)

ok(crc32(utf8('123456789')) === 0xcbf43926,
  'the check value from the CRC-32 standard: "123456789" is 0xcbf43926')
ok(crc32(new Uint8Array(0)) === 0, 'and an empty input is 0')
ok(crc32(utf8('a')) === crc32(utf8('a')), 'the same bytes always give the same value')
ok(crc32(utf8('a')) !== crc32(utf8('b')), 'different bytes do not')
ok(crc32(utf8('決算')) >>> 0 === crc32(utf8('決算')), 'multi-byte input is treated as bytes, not characters')

console.log('\nthe store zip')

const AT_ZIP = new Date(Date.UTC(2026, 7, 15, 10, 20, 30))
const u32 = (b: Uint8Array, at: number) =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8)

const ENTRIES: StoreZipEntry[] = [
  { name: 'slide-01.png', data: utf8('first') },
  { name: 'slide-02.png', data: utf8('second entry, longer') },
  { name: 'slide-03.png', data: new Uint8Array(0) },
]

{
  const empty = writeStoreZip([], AT_ZIP)
  ok(u32(empty, 0) === 0x06054b50 && empty.length === 22,
    'an empty archive is exactly one End Of Central Directory record')
  ok(u16(empty, 8) === 0 && u16(empty, 10) === 0, 'declaring zero entries')
}

{
  const zip = writeStoreZip(ENTRIES, AT_ZIP)
  ok(u32(zip, 0) === 0x04034b50, 'the archive opens with a local file header')
  ok(u16(zip, 8) === 0, 'method is STORE (0) — a png is already deflated')
  ok((u16(zip, 6) & 0x0800) !== 0, 'the UTF-8 name flag is set')
  ok(u32(zip, 14) === crc32(ENTRIES[0].data), "the local header carries the entry's crc")
  ok(u32(zip, 18) === 5 && u32(zip, 22) === 5,
    'compressed and uncompressed sizes agree, because nothing was compressed')
  ok(u16(zip, 26) === utf8('slide-01.png').length && u16(zip, 28) === 0,
    'the name length is a BYTE length and there is no extra field')

  // EOCD, found from the end the way a real reader finds it
  let eocd = -1
  for (let i = zip.length - 22; i >= 0; i--) if (u32(zip, i) === 0x06054b50) { eocd = i; break }
  ok(eocd >= 0, 'an End Of Central Directory record is present')
  ok(u16(zip, eocd + 8) === 3 && u16(zip, eocd + 10) === 3, 'and it counts three entries')
  const cdOffset = u32(zip, eocd + 16)
  const cdSize = u32(zip, eocd + 12)
  ok(cdOffset + cdSize === eocd, 'the central directory ends exactly where the EOCD begins')

  // walk the central directory and check order + offsets
  const names: string[] = []
  let p = cdOffset
  for (let i = 0; i < 3; i++) {
    ok(u32(zip, p) === 0x02014b50, `central directory entry ${i + 1} has its own signature`)
    const nameLen = u16(zip, p + 28)
    const localAt = u32(zip, p + 42)
    names.push(new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen)))
    ok(u32(zip, localAt) === 0x04034b50,
      `entry ${i + 1}'s recorded offset points at a real local header (byte offsets, not string lengths)`)
    ok(u32(zip, localAt + 14) === u32(zip, p + 16), `entry ${i + 1}'s crc matches in both directories`)
    p += 46 + nameLen + u16(zip, p + 30) + u16(zip, p + 32)
  }
  ok(names.join(',') === 'slide-01.png,slide-02.png,slide-03.png',
    'entry order is exactly input order — an unzipped folder is read as a sequence')
}

{
  const a = writeStoreZip(ENTRIES, AT_ZIP)
  const b = writeStoreZip(ENTRIES.map((e) => ({ ...e })), AT_ZIP)
  ok(a.length === b.length && a.every((v, i) => v === b[i]),
    'identical ordered input and one timestamp produce byte-identical archives')
  const c = writeStoreZip(ENTRIES, new Date(Date.UTC(2020, 0, 2, 3, 4, 5)))
  ok(c.length === a.length && !c.every((v, i) => v === a[i]),
    'and a different timestamp changes the bytes, so the timestamp is really used')
}

{
  const nonAscii = writeStoreZip([{ name: '決算-01.png', data: utf8('x') }], AT_ZIP)
  ok(u16(nonAscii, 26) === utf8('決算-01.png').length && u16(nonAscii, 26) > '決算-01.png'.length,
    'a non-ASCII entry name records its BYTE length, which is longer than its character length')
}

console.log('\nthe archive refuses what it cannot represent')

const archiveErr = (fn: () => unknown) => {
  const e = thrown(fn)
  return !!e && e.code === 'archive'
}

ok(archiveErr(() => writeStoreZip([ENTRIES[0], ENTRIES[0]], AT_ZIP)),
  'a duplicate entry name is refused — two files cannot share one name')
for (const bad of ['/abs.png', '../up.png', 'a/../../up.png', 'C:\\win.png', 'back\\slash.png', '', '.', '..']) {
  ok(archiveErr(() => writeStoreZip([{ name: bad, data: utf8('x') }], AT_ZIP)),
    `an unsafe entry name (${JSON.stringify(bad)}) is refused`)
}
ok(archiveErr(() => writeStoreZip([{ name: 'nul\u0000.png', data: utf8('x') }], AT_ZIP)),
  'a NUL inside an entry name is refused')
ok(archiveErr(() => writeStoreZip(
  Array.from({ length: 65536 }, (_v, i) => ({ name: `s-${i}.png`, data: new Uint8Array(0) })), AT_ZIP)),
  'more entries than the EOCD count field can hold is refused, not truncated')

// A bounds check is defined on LENGTHS, so it is tested with a length-claiming
// stub. Allocating 4 GiB to prove a guard runs before allocation is not a test,
// it is an out-of-memory.
const huge = (length: number): StoreZipEntry =>
  ({ name: `big-${length}.png`, data: { length } as unknown as Uint8Array })

ok(archiveErr(() => writeStoreZip([huge(0x100000000)], AT_ZIP)),
  'a single entry over 32 bits is refused BEFORE any field is truncated')
ok(archiveErr(() => writeStoreZip(
  Array.from({ length: 5 }, (_v, i) => ({ ...huge(0xF0000000), name: `b-${i}.png` })), AT_ZIP)),
  'entries that together overflow 32 bits are refused — offsets must stay representable')

console.log('\nno compression machinery at all')

{
  // Comments STRIPPED first: this file explains at length why a PNG is already
  // deflated, and a scan that reads prose as code fails on its own rationale.
  const src = fsNode.readFileSync(pathNode.resolve('slides/src/image-export-zip.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(!/CompressionStream|DecompressionStream|deflate|zlib|pako/i.test(code),
    'the writer names no compression API — STORE needs none, and pulling one in would cost shell bytes')
  ok(/\/\/|\/\*/.test(src) && code.length < src.length,
    '(and the strip really removed something, so the check above is not vacuous)')
  ok(!/class\s+\w*Zip\w*Reader|function\s+readZip/i.test(code),
    'and there is no reader: nothing in this app opens a zip')
  ok(!/import[^\n]*from\s+['"](?!\.\/image-export-errors['"])/.test(code),
    'the writer depends on nothing but the neutral error module')
}

console.log('\nindependent readers accept the bytes')

{
  const dir = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), 'bento-zip-'))
  const file = pathNode.join(dir, 'slides.zip')
  fsNode.writeFileSync(file, writeStoreZip(ENTRIES, AT_ZIP))
  let readers = 0

  const unzip = spawnSync('unzip', ['-t', file], { encoding: 'utf8' })
  if (unzip.error) {
    console.log('  ⚠ unzip is not installed here — that check did NOT run (a skip is not a pass)')
  } else {
    readers++
    ok(unzip.status === 0 && /No errors detected/i.test(unzip.stdout),
      'unzip -t accepts the archive')
    const out = pathNode.join(dir, 'out')
    execFileSync('unzip', ['-q', '-o', file, '-d', out])
    ok(fsNode.readFileSync(pathNode.join(out, 'slide-01.png'), 'utf8') === 'first' &&
      fsNode.readFileSync(pathNode.join(out, 'slide-02.png'), 'utf8') === 'second entry, longer' &&
      fsNode.readFileSync(pathNode.join(out, 'slide-03.png')).length === 0,
      'and the bytes it recovers are the bytes that went in')
  }

  const py = spawnSync('python3', ['-c',
    'import sys,zipfile\n' +
    'z=zipfile.ZipFile(sys.argv[1])\n' +
    'assert z.testzip() is None\n' +
    'print(",".join(z.namelist()))\n' +
    'print(z.read("slide-02.png").decode())\n',
    file], { encoding: 'utf8' })
  if (py.error || py.status !== 0) {
    if (py.error) console.log('  ⚠ python3 is not installed here — that check did NOT run (a skip is not a pass)')
    else ok(false, `python zipfile rejected the archive: ${py.stderr.trim()}`)
  } else {
    readers++
    const [namelist, body] = py.stdout.trim().split('\n')
    ok(namelist === 'slide-01.png,slide-02.png,slide-03.png',
      'python zipfile.testzip() passes and namelist() is in order')
    ok(body === 'second entry, longer', 'and it reads an entry back intact')
  }

  ok(readers > 0, 'at least one INDEPENDENT zip reader actually ran (CI must provide one)')
  fsNode.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
