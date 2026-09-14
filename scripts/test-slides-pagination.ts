#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Pagination rig for bento/slides: which slides take a number, which are in
// the walk, and what the page field shows on each.
//
//   node scripts/test-slides-pagination.ts
//
// WHAT THIS PROVES. Two predicates in model.ts answer two different questions
// and every surface asks the same one — page fields, the presenter's counter,
// the sidebar ask `paginates`; navigation, PDF and the thumbnail ask
// `inLinearFlow` — so no two of them can disagree about which slide is "4".
// There are three ways a slide can decline a number and they are NOT the same:
//
//   stateOf     a variant reached by link   → out of the walk, no number
//   hidden      out of the show             → out of the walk, no number
//                                             (unless present.numberHidden)
//   unnumbered  a continuation / interstitial → IN the walk, no number
//
// The third (discussion #282) is the one that must stay in the walk, and the
// one whose page field must read as the PREVIOUS slide's number: a build of
// three morph steps shows "18" three times, not 18, 19, 20. The page-field
// rule is reproduced here from render.ts fieldContext (which needs a DOM to
// import) and pinned by shape against that file.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { paginates, inLinearFlow } from '../slides/src/model.ts'
import type { BentoDoc, Slide } from '../slides/src/model.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const slide = (o: Partial<Slide> & { id: string }): Slide =>
  ({ background: '#fff', transition: 'fade', elements: [], notes: '', ...o } as Slide)
const deck = (slides: Slide[], numberHidden = false): BentoDoc =>
  ({ format: 'bento/slides', version: 1, docId: 'd', title: 't', slides,
    ...(numberHidden ? { present: { numberHidden: true } } : {}) } as unknown as BentoDoc)

// the page-field rule, as render.ts fieldContext computes it
const pageOf = (doc: BentoDoc, i: number) => doc.slides.slice(0, i + 1).filter((s) => paginates(s, doc)).length
const pagesOf = (doc: BentoDoc) => doc.slides.filter((s) => paginates(s, doc)).length

console.log('the three ways to decline a number\n')
const d = deck([
  slide({ id: 'a' }),                       // 1
  slide({ id: 'b' }),                       // 2
  slide({ id: 'b1', stateOf: 'b' }),        // state: no number, not in walk
  slide({ id: 'c' }),                       // 3
  slide({ id: 'c2', unnumbered: true }),    // continuation: no number, IN walk, page reads 3
  slide({ id: 'c3', unnumbered: true }),    // continuation: page reads 3
  slide({ id: 'h', hidden: true }),         // hidden: no number, not in walk
  slide({ id: 'd' }),                       // 4
])
const idx = (id: string) => d.slides.findIndex((s) => s.id === id)

ok(paginates(d.slides[idx('a')], d) && inLinearFlow(d.slides[idx('a')]), 'an ordinary slide counts and is in the walk')
ok(!paginates(d.slides[idx('b1')], d) && !inLinearFlow(d.slides[idx('b1')]), 'a state: no number, out of the walk')
ok(!paginates(d.slides[idx('h')], d) && !inLinearFlow(d.slides[idx('h')]), 'a hidden slide: no number, out of the walk')
ok(!paginates(d.slides[idx('c2')], d) && inLinearFlow(d.slides[idx('c2')]), 'an UNNUMBERED slide: no number, but IN the walk — the property #282 needs')

console.log('\nthe page field, slide by slide\n')
ok(pagesOf(d) === 4, `pages = 4 (${pagesOf(d)}): a, b, c, d`)
ok(pageOf(d, idx('c')) === 3, 'c reads 3')
ok(pageOf(d, idx('c2')) === 3 && pageOf(d, idx('c3')) === 3, 'both continuations read 3 — "18, 18, 18", not "18, 19, 20"')
ok(pageOf(d, idx('d')) === 4, 'the slide after the build reads 4 — the build consumed one number')
ok(pageOf(d, idx('h')) === 3, 'a hidden slide between them would also read 3 (it is never shown, but the rule is one rule)')

console.log('\ninteractions\n')
const dh = deck(d.slides.map((s) => ({ ...s })), true)
ok(paginates(dh.slides[idx('h')], dh) && !inLinearFlow(dh.slides[idx('h')]), 'numberHidden: a hidden slide counts again but stays out of the walk')
ok(!paginates(dh.slides[idx('c2')], dh), 'numberHidden does NOT make an unnumbered slide count — the option is about hidden slides only')
ok(pagesOf(dh) === 5 && pageOf(dh, idx('d')) === 5, 'with numberHidden: pages = 5 and d reads 5')
const both = deck([slide({ id: 'x' }), slide({ id: 'y', hidden: true, unnumbered: true }), slide({ id: 'z' })])
ok(!inLinearFlow(both.slides[1]) && !paginates(both.slides[1], both), 'hidden + unnumbered: hidden wins for the walk, neither gives a number')
const first = deck([slide({ id: 'u', unnumbered: true }), slide({ id: 'v' })])
ok(pageOf(first, 0) === 0 && pageOf(first, 1) === 1, 'an unnumbered FIRST slide reads 0 (nothing to continue) and the next is 1')

console.log('\nevery surface asks the same predicate\n')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f: string) => readFileSync(join(root, f), 'utf8')
ok(/page: upto\.filter\(\(s\) => paginates\(s, doc\)\)\.length/.test(read('slides/src/render.ts')), 'render.ts fieldContext: page counts by paginates (the rule reproduced above)')
ok(/visibleIndex = \(i: number\) => doc\.slides\.slice\(0, i \+ 1\)\.filter\(\(s\) => paginates\(s, doc\)\)/.test(read('slides/src/present.ts')), 'present.ts: the presenter counter counts by paginates')
ok(/filter\(\(s\) => paginates\(s, this\.store\.doc\)\)/.test(read('slides/src/editor/editor.ts')), 'editor.ts: the sidebar number counts by paginates')
ok(/private slideLabel\([\s\S]{0,400}paginates\(x, doc\)/.test(read('slides/src/editor/panels.ts')) && !/slideLabel\([\s\S]{0,400}!x\.stateOf\)\.length/.test(read('slides/src/editor/panels.ts')),
  'panels.ts: the link/state pickers label slides by paginates too — "slide 4" in the picker is "4" in the sidebar (found by the lead: it counted by position)')
ok(/const isState = \(i: number\) => \{[^}]*!inLinearFlow\(sl\)/.test(read('slides/src/present.ts')), 'present.ts: navigation skips by inLinearFlow, not by paginates')
ok(/unnumbered: bool/.test(read('slides/src/untrusted.ts')), 'untrusted.ts: the shape gate knows the key (a pasted unnumbered slide keeps it)')
ok(/"unnumbered"/.test(read('slides/src/modelkeys.generated.ts')), 'modelkeys: the key is in the generated slide table')

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
