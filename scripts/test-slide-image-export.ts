#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Slide image export — pure contracts and byte-level archive checks.
//
//   slides/node_modules/.bin/esbuild scripts/test-slide-image-export.ts --bundle \
//     --platform=node --format=esm --outfile="$TMPDIR/test-slide-image-export.mjs" \
//     && node "$TMPDIR/test-slide-image-export.mjs"
//
// Bundling is required because the production module reaches extensionless
// imports. Browser pixels, UI wiring, and network isolation have separate rigs.

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
  ok(!/[/\\<>:"|?*]/.test(base), 'path separators and invalid filename characters are removed')
  // eslint-disable-next-line no-control-regex
  ok(!(new RegExp('[\\u0000-\\u001F\\u007F]')).test(base), 'control characters are removed')
  ok(!/\s{2,}/.test(base) && base === base.trim() && !/[. ]$/.test(base),
    'whitespace collapses and unsafe trailing characters are stripped')
  ok(base.includes('決算') && base.includes('Ünïcøde'), 'Unicode survives sanitization')
}
for (const away of ['', '...', '///']) {
  ok(exportBaseName(away) === 'Untitled',
    `a title that sanitizes away (${JSON.stringify(away)}) becomes exactly "Untitled"`)
}
ok(!/^\./.test(exportBaseName('.hidden')), 'a leading dot cannot make the download a hidden file')
for (const device of ['CON', 'nul', 'aux.png', 'COM1.tar.gz', 'lpt9.']) {
  const base = exportBaseName(device)
  const stem = base.split('.')[0].toUpperCase()
  ok(!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem),
    `the Windows device name ${JSON.stringify(device)} is defused`)
}
ok(exportBaseName('CONTOUR') === 'CONTOUR' && exportBaseName('nullify.png') === 'nullify.png',
  'names that only start like devices remain unchanged')
ok(exportBaseName('Q3 Review') === 'Q3 Review', 'an ordinary title is unchanged')

console.log('\ntruncation is measured in UTF-8 bytes and cuts only whole code points')

const encodesCleanly = (s: string) =>
  !s.includes('\uFFFD') && new TextDecoder().decode(new TextEncoder().encode(s)) === s
const bytesOf = (s: string) => new TextEncoder().encode(s).length

{
  for (const [label, title] of [
    ['ASCII', 'x'.repeat(400)], ['CJK', '決算報告書'.repeat(80)], ['emoji', '🎉'.repeat(200)],
  ] as const) {
    const base = exportBaseName(title)
    ok(bytesOf(base) <= MAX_FILENAME_BYTES && encodesCleanly(base),
      `${label} truncation stays within the UTF-8 budget and preserves code points`)
  }
  const edge = exportBaseName('a'.repeat(MAX_FILENAME_BYTES - 3) + '🎉', MAX_FILENAME_BYTES)
  ok(bytesOf(edge) === MAX_FILENAME_BYTES - 3 && encodesCleanly(edge),
    'a code point that would straddle the budget is dropped entirely')
}

console.log('\nthe whole downloaded filename fits the budget, suffix included')

for (const [label, title] of [['CJK', '決算報告書'.repeat(80)], ['emoji', '🎉'.repeat(200)]] as const) {
  const doc = fixture()
  doc.title = title
  for (const scope of ['current', 'all-main'] as const) {
    const plan = buildSlideImageExportPlan(doc, 'm1', OPTS({ scope }), AT)
    const suffix = scope === 'current' ? '-slide-01.png' : '-slides.zip'
    ok(bytesOf(plan.artifactName) <= MAX_FILENAME_BYTES && encodesCleanly(plan.artifactName) &&
      plan.artifactName.endsWith(suffix), `${label} ${scope} filename keeps its suffix within the byte budget`)
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

for (const [label, css, expected] of [
  ['plain', 'a{background:url(http://x.invalid/p.png)}', 'http://x.invalid/p.png'],
  ['quoted and upper-case', "a{background:URL('http://x.invalid/q.png')}", 'http://x.invalid/q.png'],
  ['escaped function', 'a{background:u\\72l(http://x.invalid/e.png)}', 'http://x.invalid/e.png'],
  ['escaped first character', 'a{background:\\75rl(http://x.invalid/f.png)}', 'http://x.invalid/f.png'],
  ['local fragment', 'a{fill:url(#grad)}', '#grad'],
] as const) {
  ok(found(css) === expected, `${label} url() is tokenized`)
}
for (const [label, css] of [
  ['comment', 'a{/* url(http://x.invalid/comment.png) */color:red}'],
  ['string', 'a::after{content:"url(http://x.invalid/string.png)"}'],
  ['identifier text', 'a{color:burlywood}'],
] as const) {
  ok(found(css) === '', `${label} content is not mistaken for a fetch`)
}

console.log('\nand the string-candidate functions, which fetch without any url()')

for (const [label, css, expected] of [
  ['string candidate', 'a{background:image-set("http://x.invalid/s.png" 1x)}', 'http://x.invalid/s.png'],
  ['webkit spelling', "a{background:-webkit-image-set('http://x.invalid/w.png' 1x)}", 'http://x.invalid/w.png'],
  ['escaped function', 'a{background:im\\61ge-set("http://x.invalid/e.png" 1x)}', 'http://x.invalid/e.png'],
  ['mixed candidates', 'a{background:image-set("http://x.invalid/a.png" 1x,url(http://x.invalid/b.png) 2x)}',
    'http://x.invalid/a.png,http://x.invalid/b.png'],
] as const) {
  ok(found(css) === expected, `image-set ${label} is tokenized`)
}
ok(found('a::after{content:"http://x.invalid/text.png"}') === '',
  'an ordinary string is not an image candidate')

console.log('\nhostile escapes cannot crash the audit')

const HOSTILE_ESCAPES = [
  'a{background:\\FFFFFFurl(http://x.invalid/of.png)}',
  'a{background:\\0url(http://x.invalid/nul.png)}',
  'a{background:\\D800url(http://x.invalid/sur.png)}',
  'a{background:url(',
  'a{background:\\',
]
for (const hostile of HOSTILE_ESCAPES) {
  let threw: unknown = null
  try { cssUrlTargets(hostile); cssAtKeywords(hostile) } catch (err) { threw = err }
  ok(threw === null, `hostile CSS does not crash the audit: ${JSON.stringify(hostile.slice(0, 32))}`)
}

console.log('\nand they normalize the way CSS says, not into a working url()')

for (const [label, css] of [
  ['above-range', 'a{background:\\FFFFFFurl(http://x.invalid/of.png)}'],
  ['zero', 'a{background:\\0url(http://x.invalid/nul.png)}'],
  ['surrogate', 'a{background:\\D800url(http://x.invalid/sur.png)}'],
] as const) {
  ok(cssUrlTargets(css).length === 0, `${label} escape does not synthesize url()`)
}
ok(cssUrlTargets('a{background:\\75rl(http://x.invalid/valid.png)}')
  .includes('http://x.invalid/valid.png'),
  'a valid escape still resolves to url()')

console.log('\nsrcset is a LIST, and every candidate in it is a fetch')

ok(srcsetCandidates('a.png 1x, http://x.invalid/b.png 2x').join(',') === 'a.png,http://x.invalid/b.png',
  'both candidates come out of a two-entry srcset')
ok(srcsetCandidates('only.png').join(',') === 'only.png', 'a single candidate needs no descriptor')
ok(srcsetCandidates('').length === 0 && srcsetCandidates('   ').length === 0,
  'and an empty srcset has no candidates')
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
  ['comment before the colon', '.a{cursor/**/:url(http://x.invalid/c4.png),pointer;color:red}'],
] as const) {
  const stripped = stripCursorDecls(css)
  ok(cssUrlTargets(stripped).length === 0 && stripped.includes('color:red'),
    `${label} cursor is removed without damaging its rule`)
}
ok(stripCursorDecls('.a{background:url(http://x.invalid/keep.png)}').includes('keep.png'),
  'a non-cursor declaration is retained')

{
  const tricky = '.a{cursor:url("http://x.invalid/semi;brace}.png"),pointer;color:red}.b{color:blue}'
  const stripped = stripCursorDecls(tricky)
  ok(cssUrlTargets(stripped).length === 0 && stripped.includes('color:red') && stripped.includes('.b{color:blue}'),
    'delimiter-like characters inside a cursor value do not damage neighbouring CSS')
  const custom = '.a{--cursor:url(http://x.invalid/custom.png);color:red}'
  ok(stripCursorDecls(custom) === custom, 'a custom property named --cursor is untouched')
}

console.log('\nand at-keywords the same way')

ok(cssAtKeywords('@import "x";').includes('import'), '@import is found')
ok(cssAtKeywords('@\\69mport "x";').includes('import'), 'and @\\69mport, which fetched once')
ok(cssAtKeywords('/* @import "x"; */ a{color:red}').includes('import') === false,
  'an @import inside a comment is not an at-rule')

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
