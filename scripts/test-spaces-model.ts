#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/spaces model rig.
//
//   node scripts/test-spaces-model.ts
//
// WHAT THIS PROVES. Three properties, each of which fails silently and each of
// which is unrecoverable once files exist on disks.
//
//   1. THE LOAD CONTRACT. `parseDoc` must never hand back "here is an empty
//      space" for a document it could not read. The scaffold did — it returned
//      null for anything invalid and the caller fell back to the starter — so
//      opening a slides file, or a document with one hand-edited typo, showed
//      an empty space over live data, and the first ⌘S wrote it to disk.
//      The ONLY path to the starter is an absent or empty block.
//
//   2. ADDITIVITY (PLATFORM §3). Unknown top-level fields, unknown per-node
//      fields and unknown block TYPES all survive a round trip. There is no
//      server to migrate anything, so a version that strips what it does not
//      understand destroys documents written by a later one.
//
//   3. DETERMINISTIC ID REPAIR. Two readers of one file must agree on every
//      id, because links, backlinks and future collaboration key on them. A
//      repair derived from Math.random diverges two readers of the same bytes;
//      one derived from docId does too, because `template: true` re-mints
//      docId on every open.

import {
  parseDoc, buildIndex, docContentKey, homePage, FORMAT, isRemote, loadsRemotely, assetValue,
  effectiveParents, descendantsOf,
  tableOf, writeTable, tableFallbackHtml, TABLE_MAX_COLS, TABLE_MAX_ROWS,
  linkCard, linkCardHtml,
  commentsOn, unresolvedOn,
  type SpacesDoc,
} from '../spaces/src/model.ts'
import nodeFs from 'node:fs'
import { countOutsideTags, replaceOutsideTags } from '../spaces/src/findreplace.ts'
import {
  DEFAULT_FIELDS, fieldsOf, fieldByKey, optionOf, propHtml, propBlock,
  valuesOf, isIssue, issuesOf, headerLength, propBlockOf,
  passesFilter, filterCount, unknownFilterKeys, phaseField, isOpenPhase, reorderPages,
  sortRows, unknownSortKeys, sortDirOf, cycleSort, type IssueRow,
  VIEW_LAYOUTS, layoutOf, nextLayout,
} from '../spaces/src/fields.ts'
import { inlineHtml, parseNote, planImport } from '../spaces/src/markdown.ts'
import {
  canonicalMarks, applyMark, clearMarks, markActive, linkAt, linkAttrs, htmlToMd,
  CLASS_OK, keepClasses,
} from '../spaces/src/marks.ts'
import { extractSpace, planGraft, subtreeIds } from '../spaces/src/portable.ts'
import { planUpdatePage } from '../spaces/src/agent.ts'
import { tokenize, normLang, langLabel, CODE_LANGS } from '../spaces/src/highlight.ts'
import { escText, externalHref } from '../spaces/src/sanitize.ts'
import {
  SPECS, SPEC, MENU_SPECS, MD_SPECS, TAG_OF, LIST_OF, CALLOUT_TONES, mdLayout, mediaPlayback,
} from '../spaces/src/blocks.ts'
import {
  canvasRatio, cardPos, cardsOf, freeSlot, slotFor, nextRatio, ratioName, clampPct, round1,
  CANVAS_RATIO, RATIO_MIN, RATIO_MAX,
} from '../spaces/src/canvas.ts'
import type { Block, Page } from '../spaces/src/model.ts'
import {
  buildGraph, layoutGraph, stepLayout, nodeRadius, graphBounds,
} from '../spaces/src/graph.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

const doc = (over: Record<string, unknown> = {}): string => JSON.stringify({
  format: FORMAT, version: 1, docId: 'd1', title: 'T',
  pages: [{ id: 'p1', title: 'One', blocks: [{ id: 'b1', type: 'p', html: 'hi' }] }],
  theme: {},
  ...over,
})

// ---- 1. the load contract --------------------------------------------------
ok(parseDoc('').ok === false && (parseDoc('') as any).err === 'empty',
  'an empty block is the ONLY thing that yields the starter')
ok(parseDoc('   \n ').ok === false && (parseDoc('  ') as any).err === 'empty',
  'whitespace counts as empty')

for (const [label, input, err] of [
  ['a slides document', JSON.stringify({ format: 'bento/slides', slides: [] }), 'format'],
  ['a hand-edited typo', '{"format":"bento/spaces", pages:[]}', 'json'],
  ['a JSON array', '[]', 'shape'],
  ['pages missing', JSON.stringify({ format: FORMAT }), 'shape'],
] as const) {
  const r = parseDoc(input)
  ok(r.ok === false && r.err === err, `${label} REFUSES with err="${err}" (never the starter)`)
}
{
  const r = parseDoc(JSON.stringify({ format: 'bento/slides', slides: [] }))
  ok(r.ok === false && 'found' in r && r.found === 'bento/slides',
    'refusing names the format it actually found, so the message can say so')
}

// ---- 2. additivity ---------------------------------------------------------
{
  const r = parseDoc(doc({
    futureTopLevel: { a: 1 },
    pages: [{
      id: 'p1', title: 'One', futurePageField: 'keep',
      blocks: [
        { id: 'b1', type: 'p', html: 'hi', futureBlockField: 7 },
        { id: 'b2', type: 'kanban', html: 'fallback text', lanes: 3 },
      ],
    }],
  }))
  ok(r.ok, 'a document carrying unknown fields still parses')
  if (r.ok) {
    ok(JSON.stringify((r.doc as any).futureTopLevel) === '{"a":1}', 'an unknown TOP-LEVEL field survives')
    ok((r.doc.pages[0] as any).futurePageField === 'keep', 'an unknown PAGE field survives')
    ok((r.doc.pages[0].blocks[0] as any).futureBlockField === 7, 'an unknown BLOCK field survives')
    const kb = r.doc.pages[0].blocks[1]
    ok(kb.type === 'kanban' && (kb as any).lanes === 3, 'an unknown block TYPE survives with its data')
    ok(kb.html === 'fallback text', 'and keeps html, so an older build can still show something')
  }
}

// ---- frozen: a newer version opens read-only and byte-exact -----------------
{
  const r = parseDoc(doc({ version: 99 }))
  ok(r.ok && r.frozen === 'version', 'a newer format version opens FROZEN rather than being reinterpreted')
  const p = parseDoc(doc({ policy: 'bento-spaces-2' }))
  ok(p.ok && p.frozen === 'policy', 'an unrecognised policy opens FROZEN')
  // frozen means ids are NOT rewritten, even duplicates: we cannot know the
  // rules this file was written under, so we must not touch it
  const dup = parseDoc(doc({
    version: 99,
    pages: [{ id: 'p1', title: 'A', blocks: [{ id: 'x', type: 'p' }, { id: 'x', type: 'p' }] }],
  }))
  ok(dup.ok && dup.doc.pages[0].blocks.every((b) => b.id === 'x'),
    'frozen documents keep even DUPLICATE ids untouched')
  ok(dup.ok && dup.repaired.length === 0, 'and report no repairs')
}

// ---- 3. deterministic id repair --------------------------------------------
{
  const dupes = doc({
    pages: [
      { id: 'p1', title: 'A', blocks: [{ id: 'b1', type: 'p', html: 'one' }, { id: 'b1', type: 'p', html: 'two' }] },
      { id: 'p1', title: 'B', blocks: [{ id: 'b9', type: 'p', html: 'three' }] },
    ],
  })
  const a = parseDoc(dupes)
  const b = parseDoc(dupes)
  ok(a.ok && b.ok, 'a document with duplicate ids still opens')
  if (a.ok && b.ok) {
    ok(JSON.stringify(a.doc.pages) === JSON.stringify(b.doc.pages),
      'TWO READERS OF THE SAME BYTES PRODUCE THE SAME IDS')
    const ids = new Set<string>()
    let dup = false
    for (const p of a.doc.pages) { if (ids.has(p.id)) dup = true; ids.add(p.id); for (const bl of p.blocks) { if (ids.has(bl.id)) dup = true; ids.add(bl.id) } }
    ok(!dup, 'every id in the repaired document is unique across the WHOLE document')
    ok(a.doc.pages[0].id === 'p1', 'first occurrence in pre-order keeps the id')
    ok(a.doc.pages[1].id !== 'p1', 'the later duplicate is the one that moves')
    ok(a.repaired.length === 2, `repairs are REPORTED, never silent (got ${a.repaired.length})`)
  }
}
{
  // repair must not depend on docId: `template: true` re-mints it every open,
  // so a docId-derived id would give two readers of one file different ids
  const body = { pages: [{ id: 'p', title: 'A', blocks: [{ id: 'z', type: 'p' }, { id: 'z', type: 'p' }] }] }
  const one = parseDoc(doc({ ...body, docId: 'aaa' }))
  const two = parseDoc(doc({ ...body, docId: 'bbb' }))
  ok(one.ok && two.ok &&
    JSON.stringify(one.doc.pages[0].blocks.map((b) => b.id)) ===
    JSON.stringify(two.doc.pages[0].blocks.map((b) => b.id)),
    'repair does NOT depend on docId (which template:true re-mints every open)')
}

// ---- dangling references ---------------------------------------------------
{
  const r = parseDoc(doc({
    pages: [{ id: 'p1', title: 'A', parent: 'nope', blocks: [{ id: 'b1', type: 'p', parent: 'gone' }] }],
  }))
  ok(r.ok && r.doc.pages[0].parent === undefined,
    'a page whose parent does not exist becomes a ROOT page rather than vanishing')
  ok(r.ok && r.doc.pages[0].blocks[0].parent === undefined,
    'a block whose owner does not exist is re-homed rather than never rendering')
}

// ---- the index -------------------------------------------------------------
{
  const r = parseDoc(doc({
    pages: [
      { id: 'home', title: 'Home', blocks: [{ id: 'h1', type: 'p', html: 'see <a href="#p/sub">Sub</a>' }] },
      { id: 'sub', title: 'Sub', parent: 'home', blocks: [{ id: 's1', type: 'pagelink', page: 'home' }] },
    ],
  }))
  ok(r.ok, 'the linked document parses')
  if (r.ok) {
    const ix = buildIndex(r.doc)
    ok(ix.backlinks.get('sub')?.length === 1, 'an inline #p/ link produces a backlink')
    ok(ix.backlinks.get('home')?.length === 1, 'a pagelink BLOCK produces a backlink too')
    ok(ix.children.get('home')?.[0].id === 'sub', 'the page tree nests by parent')
    ok(ix.children.get('')?.length === 1, 'and only true roots are at the root')
    ok(ix.block.get('s1')?.pageId === 'sub', 'a block resolves to its owning page')
  }
}

// ---- content key -----------------------------------------------------------
{
  const base = parseDoc(doc())
  const same = parseDoc(doc({ modified: '2026-01-01T00:00:00Z' }))
  ok(base.ok && same.ok && docContentKey(base.doc) === docContentKey(same.doc),
    'docContentKey ignores volatile fields, so autosave does not see a phantom edit')
  const other = parseDoc(doc({ title: 'Different' }))
  ok(base.ok && other.ok && docContentKey(base.doc) !== docContentKey(other.doc),
    'and it DOES see a real one')
}
{
  const r = parseDoc(doc({ home: 'p1' }))
  ok(r.ok && homePage(r.doc)?.id === 'p1', 'home names the landing page')
  const noHome = parseDoc(doc())
  ok(noHome.ok && homePage(noHome.doc)?.id === 'p1', 'and falls back to the first page')
}

// ---- the href allowlist is matched against the ATTRIBUTE, not the property --
// Measured: `a.href` returns the RESOLVED ABSOLUTE url, so from file:// a
// stored "#p/abc" reads back as "file:///…#p/abc" and fails an allowlist that
// passes on a static host — stripping every internal link in exactly the two
// environments this format exists for. A behavioural test needs a DOM; this
// pins the discipline in the source, where the mistake is made.
{
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../spaces/src/sanitize.ts', import.meta.url), 'utf8'))
  ok(src.includes("getAttribute('href')"),
    'sanitize.ts tests the href ATTRIBUTE')
  ok(!/\bel\.href\b|\ba\.href\b/.test(src),
    'sanitize.ts never reads the .href IDL property (it resolves to an absolute URL)')
}

// ---- untrusted html is parsed INERT, never into a live element -------------
// Measured in a browser, 2026-08-03: `document.createElement('div').innerHTML =
// '<img src="404" onerror="…">'` FIRES the handler. The div is detached, but
// its elements belong to the live document, so the resource loads. `DOMParser`,
// `<template>` and `createHTMLDocument` are inert and do not.
//
// That made the SANITIZER its own vector: it must parse hostile markup before
// it can strip it, so the payload ran before the strip — at render time, on
// merely opening a space someone sent you. Two more call sites (textOf, and
// render.ts's code-block text extraction) had the same shape.
//
// Behavioural proof needs a DOM and a network failure; this pins the discipline
// in the source, where the mistake gets made. Any new html-parsing helper must
// go through inertBody().
{
  const fs = await import('node:fs')
  const read = (f: string) => fs.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')

  // EVERY source file, globbed — never a hand-written list. The list version
  // named the five files that existed when the hole was found, so findreplace.ts
  // and blocks.ts (added days later) were never checked, and any new module
  // could reintroduce the live-parse hole with the guard still green. A guard
  // that only covers the code it was written against is a guard that expires.
  const dir = new URL('../spaces/src/', import.meta.url)
  const walk = (d: URL): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(new URL(`${e.name}/`, d)) : e.name.endsWith('.ts') ? [new URL(e.name, d).pathname.slice(dir.pathname.length)] : [])
  const sources = walk(dir)
  ok(sources.length >= 10 && sources.includes('findreplace.ts') && sources.includes('blocks.ts'),
    `the guard globs every source file (${sources.length} found)`)
  for (const f of sources) {
    const src = read(f)
    // an element made with createElement, then fed innerHTML — the live-parse
    // shape. Assignments of ALREADY-SANITIZED html to a render target are fine
    // and read differently (`x.innerHTML = sanitizeInline(…)`), so the check is
    // on the raw-variable form.
    const live = /\.innerHTML\s*=\s*(html|raw|untrusted|b\.html|String\(html\))\b/.exec(src)
    ok(!live, `${f} never parses raw html into a live element (found: ${live?.[0] ?? 'none'})`)
  }

  const san = read('sanitize.ts')
  ok(/export function inertBody/.test(san), 'sanitize.ts exports inertBody()')
  ok(/new DOMParser\(\)\.parseFromString/.test(san), 'inertBody parses into an inert document')
  ok(/el\.ownerDocument\.createTextNode/.test(san),
    'the unwrap gap node comes from the parsed document, not the live one')
  ok(!/const host = document\.createElement/.test(san),
    'sanitizeInline does not host untrusted html in a live element')

  const ren = read('render.ts')
  ok(/inertBody\(/.test(ren), 'render.ts extracts code-block text through inertBody')
}

// ---- a document must not phone home when it is merely OPENED ---------------
// Measured: a space carrying <img src="https://…/pixel.png"> requested it on
// open. That is a tracking pixel in a format whose whole point is that you mail
// it — the recipient's IP and the moment they read your document, handed to
// whoever wrote the file — and it breaks PLATFORM §1 (no network required to
// open). Remote images now wait for the reader to ask.
//
// The predicate is an ALLOWLIST of the two local forms. A blocklist of `http:`
// would miss the cases that actually matter.
{
  for (const local of ['asset:sABC123', 'data:image/webp;base64,AAAA']) {
    ok(!isRemote(local), `${local.slice(0, 24)}… is local`)
  }
  for (const remote of [
    'https://tracker.example/p.png',
    'http://tracker.example/p.png',
    '//tracker.example/p.png',            // protocol-relative
    'photos/holiday.jpg',                 // relative — a real request on a host
    '/abs/path.png',
    'HTTPS://Tracker.Example/p.png',
    'blob:https://x/y',
    'filesystem:https://x/y',
  ]) {
    ok(isRemote(remote), `${remote} is remote`)
  }
  ok(!isRemote(''), 'an empty src is not a remote fetch')

  // ---- and the same question, asked one indirection deeper -----------------
  // isRemote answers about the string an author WROTE. `asset:k` is local by
  // inspection and `doc.assets.k` is whatever the file says it is, so the gate
  // that decides whether to show the consent placeholder was answering the
  // wrong question. Measured on a shipped build before this: a document with
  // `assets: { k: "http://…" }` and an image `src: "asset:k"` issued a real GET
  // on open, with no placeholder — the tracking pixel the paragraph above says
  // is prevented.
  //
  // BEHAVIOUR, not a source grep. Two assertions in this file were shown to
  // pass through live regressions because they matched text rather than
  // running anything, so this one runs the predicate against real documents.
  {
    // assetValue reads doc.assets and nothing else, so the fixture is that.
    const withAssets = (assets: Record<string, string>) => ({ assets }) as never

    const hostile = withAssets({ k: 'http://tracker.example/p.png' })
    ok(loadsRemotely('asset:k', hostile),
      'an asset: key whose VALUE is a URL is a remote load, however local the key looks')
    ok(isRemote(assetValue('asset:k', hostile)),
      '…because the asset table is resolved before the question is asked')

    const protoRel = withAssets({ k: '//tracker.example/p.png' })
    ok(loadsRemotely('asset:k', protoRel), 'protocol-relative in the asset table is remote too')

    const embedded = withAssets({ k: 'data:image/png;base64,AAAA' })
    ok(!loadsRemotely('asset:k', embedded), 'an asset holding embedded bytes is still local')

    const missing = withAssets({})
    ok(!loadsRemotely('asset:nope', missing), 'an asset key that resolves to nothing loads nothing')

    // the prototype-chain reach the resolver already guards, kept honest here
    const proto = withAssets({})
    ok(!loadsRemotely('asset:toString', proto), 'asset:toString does not reach Object.prototype')
    ok(assetValue('asset:toString', proto) === '', '…and resolves to the empty string, not a function')

    // a plainly written URL is unchanged by any of this
    ok(loadsRemotely('http://tracker.example/p.png', missing), 'a written URL is still remote')
    ok(!loadsRemotely('data:image/png;base64,AAAA', missing), 'a written data: URI is still local')
  }

  // and the renderer must actually consult it
  const fs = await import('node:fs')
  const ren = fs.readFileSync(new URL('../spaces/src/render.ts', import.meta.url), 'utf8')
  // EVERY gate asks the resolved question. Counting them is the point: the
  // hole was one call site out of five asking `isRemote` about the written
  // string, and a regex that merely finds "a gate exists" would have passed
  // throughout. If a sixth surface starts loading something, this count is
  // what fails.
  const gates = (ren.match(/loadsRemotely\(/g) ?? []).length
  ok(gates >= 5, `every surface that loads asks the resolved question (${gates} gates)`)
  ok(!/isRemote\(rawSrc\)/.test(ren),
    'no gate asks about the WRITTEN src — that is the hole an asset: key hid in')
  ok(/loadsRemotely\(rawSrc, doc\)\s*&&\s*!opts\.allowRemote/.test(ren),
    'render.ts gates remote images on the reader\'s consent')
  ok(!/allowRemote/.test(fs.readFileSync(new URL('../spaces/src/model.ts', import.meta.url), 'utf8')),
    'consent is NOT a document field — it belongs to the reader, not the file')

  // The link card's thumbnail is the surface with no gate at all: linkCard()
  // takes a BLOCK, so it cannot know what an asset: key resolves to, and it was
  // trusted to have already dropped anything remote.
  ok(/c\.image && !loadsRemotely\(c\.image, doc\)/.test(ren),
    'a link card thumbnail is checked where the document is in scope, not where it is built')
}

// ---- an encrypted space is never written to disk in the clear ---------------
// The recovery snapshot is the document as plain JSON. `putRecovery` does NOT
// guard on encryption — the CALLER must — so an unguarded call site puts in
// IndexedDB precisely what the password exists to keep off the disk, every few
// seconds, for the one author who has demonstrably asked for secrecy.
//
// Measured before the guard: the marker text appeared in the `recovery` store
// within 3 seconds of typing. After: setting a password clears the snapshot
// already written, and later edits write none.
{
  const fs = await import('node:fs')
  const main = fs.readFileSync(new URL('../spaces/src/main.ts', import.meta.url), 'utf8')
  const about = fs.readFileSync(new URL('../spaces/src/about.ts', import.meta.url), 'utf8')

  // the debounce body must stand down when encryption is on
  const guarded = /if \(isEncryptionActive\(\)\) return[\s\S]{0,200}?putRecovery/.test(main)
  ok(guarded, 'main.ts skips the recovery snapshot while a space is encrypted')

  // and turning encryption ON must remove what was written before it
  ok(/clearVersions\(/.test(about) && /clearRecovery\(/.test(about),
    'setting a password clears BOTH the version timeline and the recovery snapshot')

  // THE TIMELINE HAS THE SAME OBLIGATION, and it is easier to get wrong: the
  // recovery guard is an early `return` at the top of the debounce, so anything
  // written further down inherits it — but the SAVE path is a second call site
  // with no such shelter, and that one runs at the exact moment an author who
  // has set a password is writing the file. Both guarded, or the timeline is a
  // plaintext copy of what the encryption was for.
  ok(/addVersion\(/.test(main), 'main.ts writes a version timeline at all')
  const throttled = /Date\.now\(\) - lastVersionAt > VERSION_EVERY_MS[\s\S]{0,120}?addVersion/.test(main)
  ok(throttled, '…on a throttle while editing, so one session cannot spend the cap')
  const saveGuarded = /if \(!isEncryptionActive\(\)\) \{ void addVersion/.test(main)
  ok(saveGuarded, '…and the SAVE path checks encryption itself, having no early return above it')

  // The restore has to go through replaceDoc: it is the one path that
  // checkpoints undo first, which is what makes the note "Restoring is
  // undoable" true rather than reassuring.
  ok(/listVersions\(/.test(about), 'About reads the timeline')
  ok(/store\.replaceDoc\(restored\)/.test(about), '…and restores through replaceDoc, so ⌘Z walks it back')
}

// ---- a popover is as tall as the room it has ------------------------------
// .sp-pop carried `max-height: 44vh`. On a 900px window that is 396px, and the
// share panel wants 543 — measured: 149px clipped, with "Start live session"
// and "Reset access…" both below the fold. The primary action of the sharing
// panel was reachable only by noticing that a box showing no scrollbar scrolls.
// A 13" laptop is worse.
{
  const fs = await import('node:fs')
  const ed = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  const css = fs.readFileSync(new URL('../spaces/src/styles.css', import.meta.url), 'utf8')
  const props = fs.readFileSync(new URL('../spaces/src/props.ts', import.meta.url), 'utf8')

  ok(!/\.sp-pop \{[^}]*max-height: 44vh/.test(css), 'the popover is not capped at a fraction of the window')
  ok(/pop\.style\.maxHeight = /.test(ed), '…place() gives it the room the anchor actually leaves')
  // Both popover builders must route through the helper, or the one that does
  // not will size itself once and stay that size while the window moves.
  const viaHelper = (ed.match(/else this\.placed\(pop, anchor\)/g) ?? []).length
  ok(viaHelper === 2, 'both popover call sites place through the same helper')
  ok(/addEventListener\('resize', reflow\)/.test(ed), '…which re-places on resize')
  ok(/removeEventListener\('resize', reflow\)/.test(ed), '…and takes the listener back off when it closes')

  // THE EXTRACTOR SWEEPS LITERALS. A helper that picks a key —
  // `t(n === 1 ? one : many)` — compiles, runs, and is never translated by
  // anyone, because no catalog ever learns the strings exist. This cost a round
  // trip while the plural was being written, and the model rig is where that
  // lesson is cheap to keep.
  for (const key of ['{n} block', '{n} blocks', '{n} word', '{n} words',
                     '{n} link to this page', '{n} links to this page']) {
    ok(props.includes(`t('${key}'`), `the panel's "${key}" is a literal at its own call site, so it is swept`)
  }
  ok(!/\{blocks\} blocks · \{words\} words/.test(props),
    '…and the old one-string-three-plurals stat is gone (it read "1 blocks · 1 words")')
}

// ---- the shortcut list documents keys that exist --------------------------
// A help screen listing a key the app does not bind is worse than no help
// screen: the reader doubts their keyboard rather than the page, and there is
// no way for them to tell which of the two is wrong. So every ⌘-letter the
// overlay prints is checked against the keydown handler that would have to
// implement it. The prose in the starter space says the same things, but the
// starter is a DOCUMENT — deleting it is the first thing many people do, and
// the reference should not go with it.
{
  const fs = await import('node:fs')
  const ed = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')

  ok(/openHelp\(\): void/.test(ed), 'there is a shortcut list')
  ok(/e\.key === '\?' && !isTyping\(\)/.test(ed),
    "…opened by ? , behind the same isTyping guard as [ and ] (it is a character people type)")
  ok(/label: t\('Keyboard shortcuts'\)/.test(ed),
    '…and reachable from the menu, not only by the key it documents')

  // Pull the ⌘-letters out of the overlay's own table and demand a binding for
  // each. Letters only: the modifiers differ per branch and the point is that
  // the key is handled at all, not how.
  const from = ed.indexOf('const groups: Array<[string, Array<[string, string]>]>')
  const table = ed.slice(from, ed.indexOf("const grid = el('div', 'sp-keys-grid')", from))
  const letters = new Set<string>()
  for (const m of table.matchAll(/'[⌘⇧⌥]*⌘([A-Z])'/g)) letters.add(m[1].toLowerCase())
  ok(letters.size >= 8, `the list actually names shortcuts (${letters.size} found)`)
  for (const c of [...letters].sort()) {
    // Both spellings the file uses: the long `e.key.toLowerCase() === 'x'` of
    // the command branches, and the short `k === 'x'` inside markKey(), which
    // is where ⌘B/I/U/E and ⇧⌘S/H actually live. Matching only the long one
    // reported ⌘U and ⌘H as unbound when they are bound three lines apart.
    const bound = new RegExp(`=== '${c}'`).test(ed)
    ok(bound, `⌘${c.toUpperCase()} in the list is a key something actually binds`)
  }
}

// ---- the page tree says where you are, to everyone -------------------------
// `sp-here` renders the current page at weight 600 against 400. A sighted
// reader gets that for free; a screen reader was told nothing, so the tree read
// as a flat list of links with no indication which one you were on. Weight is
// not an announcement. There are TWO places that set the class — the tree and
// the archived list — and an attribute added to one of them is the kind of
// half-fix that looks done.
{
  const fs = await import('node:fs')
  const ed = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  const setsClass = (ed.match(/sp-here/g) ?? []).length
  const setsAria = (ed.match(/setAttribute\('aria-current', 'page'\)/g) ?? []).length
  ok(setsAria >= 2, `every row that can be current announces it (${setsAria} call sites)`)
  ok(setsAria >= setsClass - 1,
    'no place styles itself as current without saying so — sp-here and aria-current stay paired')
}

// ---- a page can be a record, and the schema grows by being used ------------
// `doc.fields` has been a per-document vocabulary since the tracker shipped and
// NOTHING EVER WROTE IT: the only way to give a page a property was "Make this
// page an issue", which adds four fields or none. So the schema was
// configurable in the format and fixed in the app, and a space could hold a
// backlog but never a reading list.
//
// The trap this pins is `fieldsOf`'s fallback. It returns DEFAULT_FIELDS only
// while `doc.fields` is absent or empty — so a document that has never declared
// a schema and then gains ONE field would, if that field were pushed into an
// empty array, lose Status, Priority, Assignee and Estimate in the same stroke.
// Every issue would keep its `prop` blocks, and the board grouping them by
// status would have no status field to group by.
{
  const fs = await import('node:fs')
  const fields = fs.readFileSync(new URL('../spaces/src/fields.ts', import.meta.url), 'utf8')
  const ed = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  const props = fs.readFileSync(new URL('../spaces/src/props.ts', import.meta.url), 'utf8')

  ok(/export function withField\(/.test(fields), 'there is one way to add a field to the vocabulary')
  // The seeding is the whole point: it must start from fieldsOf(doc), never
  // from doc.fields directly.
  ok(/const current = fieldsOf\(doc\)/.test(fields),
    '…and it seeds from the DEFAULTS, so the first custom field does not erase them')
  ok(/export function freeFieldKey\(/.test(fields),
    'a new field gets a key that is free — keys outlive labels and views group by them')

  ok(/openAddProperty\(pageId: string, anchor: HTMLElement\)/.test(ed), 'a page can be given a property')
  ok(/withField\(s\.doc, spec\)/.test(ed), '…and naming a new one writes it into the document vocabulary')
  ok(/splice\(headerLength\(p\), 0, propBlock\(/.test(ed),
    '…as a prop block in the header strip, where the readable form is written with it')
  ok(/openAddProperty\(page\.id, addProp\)/.test(props), 'the properties panel offers it')
}

// ---- a view is about a set of pages, and can be looked at as a table -------
// A view meant ONE thing: every page carrying a `status`. That made the tracker
// work and everything else impossible — no "the pages with an Author", no "the
// pages under Books", so a space could hold a backlog and never a reading list.
//
// ABSENT MEANS ISSUES. That is the compatibility rule, not a default: every
// view block written before `source` existed carries none and must keep showing
// the backlog forever, and a view set back to Issues must be byte-identical to
// one that never moved — the same rule `filter` already follows.
{
  const fs = await import('node:fs')
  const fields = fs.readFileSync(new URL('../spaces/src/fields.ts', import.meta.url), 'utf8')
  const render = fs.readFileSync(new URL('../spaces/src/render.ts', import.meta.url), 'utf8')
  const ed = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')

  ok(/export function viewRows\(/.test(fields), 'a view selects its rows through one function')
  ok(/if \(!has && !under\) return issuesOf\(doc\)/.test(fields),
    '…and with no source it is still the backlog, so old view blocks are unchanged')
  ok(/viewRows\(doc, \(b as \{ source\?: unknown \}\)\.source\)/.test(render),
    'the renderer asks for the block\'s own source rather than the issues')

  // The table is the shape a base is usually looked at in. Its columns must
  // come from the ROWS, not the vocabulary: a table of books carrying no
  // Estimate should not grow an Estimate column because the schema has one.
  ok(/layout === 'table'/.test(render), 'a view can be a table')
  ok(/rows\.some\(\(r\) => r\.values\.has\(k\)\)/.test(render),
    '…whose columns are the fields the rows actually carry')
  ok(/overflow-x/.test(fs.readFileSync(new URL('../spaces/src/styles.css', import.meta.url), 'utf8')
    .split('.sp-view-tablewrap')[1]?.slice(0, 120) ?? ''),
    '…and scrolls inside itself, so a wide table never scrolls the page sideways')

  // Cycling all the way round must leave the block as it started. The cycle
  // ends at GALLERY now, so it is the last shape that clears the key.
  //
  // Asked of the CYCLE, not of the source. This assertion used to read
  // /gallery: undefined/ against editor.ts, which is a test of how the line is
  // spelled: moving the cycle into fields.ts kept every behaviour and turned it
  // red, and hardening the same lookup against Object.prototype would have left
  // it green. So the shape question goes to nextLayout, and the writer question
  // goes to the writer's own body — not to the whole file, on the `coverFn`
  // precedent below, because `undefined` appears hundreds of times in editor.ts.
  ok(nextLayout('gallery') === 'board', 'the shape after the last one is the board again')
  const toggleFn = ed.slice(ed.indexOf('private toggleViewLayout'),
    ed.indexOf('private openViewGroup'))
  ok(toggleFn.length > 0 && /'layout',\s*to === 'board' \? undefined :/.test(toggleFn),
    '…and the click WRITES that as a deleted key rather than a stored "board"')
}

// ---- a page has a cover, and a view can be a gallery -----------------------
// COVERS ARE THE ONE FIELD THAT WOULD TEMPT SOMEBODY INTO A URL, because that
// is how every hosted notes app stores one — and a URL in a document is a
// network request on open (PLATFORM §1), which `icon` already refuses in the
// same terms. So the refusal is not a comment: `coverSrc` is the ONE place that
// decides, and everything (the page, the gallery card) goes through it.
//
// The other half is that a cover is an asset reference that is NOT on a block,
// and every asset sweep in the app was written as a loop over blocks. Miss one
// and the failure is silent and specific: the readout calls every cover an
// orphan and offers to delete it, or a page grafted into another space arrives
// with a cover pointing at nothing.
{
  const fs = await import('node:fs')
  const { coverSrc, pageAssetKeys } = await import('../spaces/src/model.ts')
  const { orphanAssets } = await import('../spaces/src/assets.ts')

  // 1. ADDITIVITY: a build that predates the field round-trips it untouched,
  //    and this build does not invent one.
  const withCover = parseDoc(doc({
    assets: { k1: 'data:image/png;base64,AAA' },
    pages: [{ id: 'p1', title: 'One', cover: 'asset:k1', blocks: [{ id: 'b1', type: 'p', html: 'hi' }] }],
  }))
  ok(withCover.ok === true, 'a page carrying a cover loads')
  const cd = (withCover as { doc: SpacesDoc }).doc
  ok(cd.pages[0].cover === 'asset:k1', '…and the cover survives the round trip')
  ok((cd.pages[1] ?? {}).cover === undefined && parseDoc(doc()).ok === true
    && ((parseDoc(doc()) as { doc: SpacesDoc }).doc.pages[0] as { cover?: unknown }).cover === undefined,
    '…and a page written before covers existed still has none')

  // 2. NEVER THE NETWORK. The field is KEPT (additivity) and renders nothing.
  ok(coverSrc({ id: 'x', title: '', blocks: [], cover: 'asset:k1' } as unknown as Page) === 'asset:k1',
    'an asset cover renders')
  ok(coverSrc({ id: 'x', title: '', blocks: [], cover: 'data:image/png;base64,AAA' } as unknown as Page)
    === 'data:image/png;base64,AAA', 'an embedded cover renders')
  ok(coverSrc({ id: 'x', title: '', blocks: [], cover: 'https://example.com/a.jpg' } as unknown as Page) === '',
    'a REMOTE cover renders nothing — opening a document never touches the network')
  ok(coverSrc({ id: 'x', title: '', blocks: [], cover: '/cover.jpg' } as unknown as Page) === '',
    '…and a relative path is remote too, because it is a real request on a static host')
  ok(coverSrc({ id: 'x', title: '', blocks: [] } as unknown as Page) === '', 'no cover, no picture')

  // 3. A COVER IS A USE. This is the assertion that catches the block-only loop.
  ok(pageAssetKeys(cd.pages[0]).join(',') === 'k1', 'a page reports the asset its cover holds')
  ok(orphanAssets(cd).length === 0,
    'a cover\'s bytes are not an orphan — nothing else on the page points at them')
  const dropped = JSON.parse(JSON.stringify(cd)) as SpacesDoc
  delete (dropped.pages[0] as { cover?: unknown }).cover
  ok(orphanAssets(dropped).join(',') === 'k1', '…and they ARE one once the cover is removed')

  // 4. A COVER TRAVELS. Extract carries the bytes; graft remaps the key.
  const cut = extractSpace(cd, 'p1', { docId: 'doc-x', now: '2026-08-22T00:00:00.000Z' })
  ok((cut.doc.assets ?? {}).k1 !== undefined, 'a page extracted on its own takes its cover with it')
  const host = (parseDoc(doc({
    assets: { k1: 'data:image/png;base64,ZZZ' },
    pages: [{ id: 'h1', title: 'Host', blocks: [{ id: 'hb1', type: 'image', src: 'asset:k1' }] }],
  })) as { doc: SpacesDoc }).doc
  const plan = planGraft(host, JSON.parse(JSON.stringify(cut.doc)), {})
  const landed = plan.pages.find((p) => p.title === 'One')!
  ok(String(landed.cover).startsWith('asset:') && landed.cover !== 'asset:k1',
    'a grafted cover follows its bytes to their new key — the host already had a DIFFERENT k1')
  ok(plan.assets[String(landed.cover).slice(6)] === 'data:image/png;base64,AAA',
    '…and the bytes it lands on are the ones it arrived with')

  // 5. THE GALLERY. The shape the covers exist for.
  const render = fs.readFileSync(new URL('../spaces/src/render.ts', import.meta.url), 'utf8')
  const ed2 = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  const props2 = fs.readFileSync(new URL('../spaces/src/props.ts', import.meta.url), 'utf8')
  ok(/layout === 'gallery'/.test(render), 'a view can be a gallery')
  ok(nextLayout('table') === 'gallery' && nextLayout('gallery') === 'board',
    '…reachable from the one layout control, which cycles through it')
  ok(/resolveSrc\(coverSrc\(r\.page\), doc\)/.test(render),
    '…and a card asks coverSrc for the picture, so a remote cover is refused there too')
  ok(/sp-gcard-bare/.test(render),
    '…and a page with no cover gets a panel of its own rather than a hole')
  ok(/pickCover\(pageId: string\)/.test(ed2), 'a cover is chosen through the editor')
  // the METHOD's own body, not the file: `prepareImage` appears in four other
  // places, so a check that only proved the file mentions it would pass with a
  // cover picker that read the raw bytes and skipped the budget entirely
  const coverFn = ed2.slice(ed2.indexOf('private async pickCover'),
    ed2.indexOf('private removeCover'))
  ok(/prepareImage\(file\)/.test(coverFn) && /internAsset\(/.test(coverFn)
    && /IMAGE_EMBED_BUDGET/.test(coverFn),
    '…through the IMAGE pipeline: downscaled, content-addressed, and the same budget question')
  ok(/delete p\.cover/.test(ed2), 'removing a cover DELETES the key rather than storing an empty string')
  ok(/pickCover\(page\.id\)/.test(props2), 'the properties panel offers it, beside the icon')
}


// ---- a t() the extractor cannot SEE ----------------------------------------
// scripts/build-spaces-i18n.mjs sweeps t() call sites for LITERAL strings, plus
// one dedicated indirection (it reads `label:`/`hint:` out of blocks.ts, because
// the block menu renders them as `t(item.label)`). Anything else — most of all
// `t(SOME_MAP[key])` — compiles, runs, and reaches no catalog. The coverage
// figure cannot see it either: the packer builds its key list from what it
// swept, so eight locales report 100% while the control reads English.
//
// This class has cost three separate strings, two of them found by this check:
//   · the panel's plural forms (caught before merge)
//   · the view layout button — "Board", "List" and "Show as a list" were WRITTEN
//     in de.ts and ABSENT from packed.ts: translations already done, dropped
//   · FIELD_TYPE_LABEL — five of six property types (Select, Number, Date,
//     Person, Labels) were in NO catalog at all
//
// SCOPE: map and property lookups, which is the shape that bites. A bare
// `t(param)` inside a helper is not flagged — its callers pass literals, which
// the sweep sees at the call site, and the second t() is a harmless miss that
// returns its argument.
{
  const fs = await import('node:fs')
  const srcDir = new URL('../spaces/src/', import.meta.url)
  const offenders: string[] = []
  for (const f of fs.readdirSync(srcDir).filter((n: string) => n.endsWith('.ts'))) {
    // COMMENTS ARE NOT CODE. The first draft of this check flagged its own
    // prose — two doc comments that quote `t(MAP[key])` while explaining why it
    // is wrong. A source scan that cannot tell code from a sentence about code
    // reports the documentation as the bug.
    const text = fs.readFileSync(new URL(f, srcDir), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    // t(NAME[...]) or t(NAME.prop) — a lookup whose result is displayed
    for (const [, expr] of text.matchAll(/\bt\(\s*([A-Za-z_$][\w$]*\s*(?:\[[^\]]*\]|\.[\w$]+))/g)) {
      const e = expr.trim()
      // THE ONE INDIRECTION THE EXTRACTOR IMPLEMENTS. It reads every `label:`
      // and `hint:` literal out of blocks.ts, so `x.label` / `x.hint` is swept
      // whatever the loop variable is called — spec, item, i. The BRACKET form
      // is what stays flagged, because that is the shape that has actually
      // shipped English three times.
      if (/\.(label|hint)$/.test(e)) continue
      offenders.push(`${f}: t(${e.slice(0, 40)})`)
    }
  }
  ok(offenders.length === 0,
    `no t() reads a map the extractor cannot sweep${offenders.length ? ' — ' + offenders.join(' | ') : ''}`)
}

// ---- find & replace: the number shown IS the number changed ----------------
// Replace-all is destructive and lands in one commit, so the count in the
// readout, the count in the confirmation and the count of things that change
// must be one number. They were three: the readout counted matching BLOCKS
// ("2 found"), the dialog quoted that as "2 occurrences", and the sweep then
// changed 4. Counting from `textOf()` would have been wrong in the other
// direction — a needle split across markup reads as one word but cannot be
// replaced, so it would promise a change that never happens.
//
// Both functions now share one traversal, and this pins them together.
{
  const cases: Array<[string, number]> = [
    ['Widget and widget and WIDGET', 3],       // case-insensitive
    ['a <b>widget</b> inside markup', 1],      // inside a tag's content
    ['wid<b>get</b> split across tags', 0],    // NOT replaceable, so not counted
    ['<b>widget</b><i>widget</i>', 2],
    ['nothing here', 0],
    ['widgetwidget', 2],                       // adjacent, no overlap-skipping
    ['<a href="https://widget.example">x</a>', 0],  // an attribute is not text
  ]
  for (const [html, expect] of cases) {
    const n = countOutsideTags(html, 'widget')
    ok(n === expect, `count ${JSON.stringify(html).slice(0, 40)} → ${n} (expected ${expect})`)

    // the property that matters: whatever was counted is what changes
    const after = replaceOutsideTags(html, 'widget', 'gadget')
    const made = (after.match(/gadget/g) ?? []).length
    ok(made === expect, `…and replacing changes exactly ${expect} (changed ${made})`)
  }

  // an empty needle must never "match everything"
  ok(countOutsideTags('anything', '') === 0, 'an empty needle counts nothing')
  ok(replaceOutsideTags('anything', '', 'X') === 'anything', 'an empty needle replaces nothing')
  // markup must survive the sweep untouched
  ok(replaceOutsideTags('a <b class="x">widget</b>!', 'widget', 'gadget') === 'a <b class="x">gadget</b>!',
    'tags and their attributes are preserved verbatim')
}

// ---- every topbar action stays reachable at every width --------------------
// Measured at 375px before the ⋯ menu existed: the bar wanted 678px, so seven
// of eleven controls sat off the right edge — Save among them. The file could
// not be saved on a phone, and nothing said so: the controls were in the DOM,
// laid out, and simply painted past the edge.
//
// ---------------------------------------------------------------------------
// HOW WIDE A PAGE IS.
//
// The renderer already varied this — a page carrying a `view` block jumped to
// 1500px — but it decided for you and offered no way to disagree. Measured at
// a 1600px viewport before the control existed: a 720px column with 631px of
// the page empty beside it, and 0 of the 15 blocks on the starter's Welcome
// page even reaching the limit. The line length was never the problem.
//
// What must not regress: the default is an ABSENT key (so a file written
// before this stays byte-identical), a board with no key keeps its room, and
// an unknown value from a newer build falls back to the measure rather than to
// no width at all.
{
  const fs = await import('node:fs')
  const render = fs.readFileSync(new URL('../spaces/src/render.ts', import.meta.url), 'utf8')
  const editor = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  const model = fs.readFileSync(new URL('../spaces/src/model.ts', import.meta.url), 'utf8')

  ok(/width\?: 'wide' \| 'full'/.test(model), "Page.width is 'wide' | 'full' — absent is the default")
  ok(/\[extra: string\]: unknown/.test(model), '…on a Page that still round-trips unknown fields')

  // the board default survives, and the page overrides it
  ok(/page\.blocks\.some\(\(b\) => b\.type === 'view'\)/.test(render),
    'a board page is still the DEFAULT wide case')
  ok(/page\.width === 'wide' \|\| page\.width === 'full' \? page\.width/.test(render),
    '…and an explicit page width wins over it')
  // These two were written against the FIRST version, where an absent key fell
  // straight through to the board default and the prose case was a flat
  // `theme.measure` in px. Both changed when the reader preference and the
  // growing default landed; the intent they were pinning has not.
  ok(/page\.width === undefined \? \(opts\.readerWidth \?\? auto\)/.test(render),
    '…while an absent key falls through to the reader, and then to the board default')
  ok(/maxWidth = 'none'/.test(render), "'full' removes the cap rather than picking a big number")
  ok(/theme\.measure/.test(render) && /42vw/.test(render),
    'and the prose default is still built from the theme measure, now growing with the viewport')

  // THE DEFAULT IS AN ABSENT KEY. A page set to wide and back must be
  // byte-identical to one never touched — the same rule editView follows.
  ok(/if \(v === 'normal'\) delete pg\.width/.test(editor),
    'choosing the default DELETES the key rather than storing "normal"')
  ok(/t\('Width'\)/.test(editor) && /t\('Column'\)/.test(editor) &&
     /t\('Wide'\)/.test(editor) && /t\('Full width'\)/.test(editor),
    'the page menu offers all three, translated')
  ok(/selected: current === 'normal'/.test(editor),
    '…and marks the one in force, so the menu says what the page already is')
}

// The rule (slides' rule) is: drop text and fold, never scroll. The failure
// mode to guard is not the CSS — it is the SECOND LIST: a ⋯ menu maintained by
// hand as a copy of the desktop row drifts the first time either changes, and
// the drift is invisible until someone opens the app on a phone.
{
  const fs = await import('node:fs')
  const ed = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  const css = fs.readFileSync(new URL('../spaces/src/styles.css', import.meta.url), 'utf8')

  // TWO lists now, and the split is the point. Everything used to be one list
  // rendered BOTH inline and into ⋯ unconditionally, so on a desktop half of ⋯
  // pointed at buttons already on screen. What still must not happen is a ⋯
  // menu maintained BY HAND as a copy of the row — so each list is declared
  // once and ⋯ takes the inline one only when the bar has actually dropped it.
  ok(/const barActions: BarAction\[\]/.test(ed), 'the bar actions are declared as one typed list')
  ok(/const menuActions: BarAction\[\]/.test(ed), '…the ⋯-only actions as another')
  ok(/barActions\.map\(/.test(ed), '…the inline row is built from the bar list')
  ok(/for \(const a of menuActions\)/.test(ed), '…⋯ always carries the menu-only actions')
  ok(/isFolded\(\)\) \{\s*\n\s*for \(const a of barActions\)/.test(ed),
    '…and picks up the bar list ONLY once folded, or ⋯ duplicates the visible row')

  // WHICH TIER a rule lives in is the thing worth pinning — but the tiers are
  // no longer px media queries. They were (820 and 600), and the numbers moved
  // once already (720 -> 820, because at 768 the save caret still ended 27px
  // off the screen). They moved because a px guess cannot answer the question:
  // the same buttons need different room at the same viewport width depending
  // on browser zoom, OS text scaling, and the reader's language. Measured on
  // the shipped shell: the control group is 568px in English and 618px in
  // German — 50px the old threshold was never calibrated for, and eight
  // catalogs ship inside every file.
  //
  // So the tiers are CLASSES now, applied by measuring, and what is worth
  // pinning is that each control is dropped by the right tier.
  const inTier = (tier: string, sel: RegExp): boolean => {
    const re = new RegExp('\\.sp-bar-' + tier + '\\s+' + sel.source)
    return re.test(css)
  }
  ok(inTier('compact', /\.sp-btnlabel \{ display: none/), 'compact drops the button words')
  ok(inTier('compact', /\.sp-primary span\.sp-savelabel \{ display: none/), "…including Save's")
  ok(inTier('tight', /\.sp-mark-word \{ display: none/), 'tight drops the wordmark, keeping the mark')
  ok(inTier('fold', /\.sp-sec \{ display: none/), 'fold moves the secondary row into ⋯')
  // ⋯ is no longer fold-only: it is the home of the once-a-session commands, so
  // gating it on the fold would put New page, the journal, import, print and
  // About out of a desktop user's reach entirely.
  ok(/^\.sp-more \{ display: inline-flex/m.test(css),
    '⋯ is in the bar at EVERY width, being a home and not only an overflow')
  ok(!/\.sp-bar-fold \.sp-more \{ display/.test(css), '…so it is not gated on the fold any more')
  ok(inTier('fold', /\.sp-mark \{ display: none/), '…and the mark goes (About is in ⋯)')
  ok(inTier('fold', /\.sp-group-history \{ display: none/), '…and the history pair')
  ok(inTier('fold', /\.sp-split \.sp-caret \{ display: none/), '…and the save caret')
  ok(/\.sp-bar-fold \.sp-status \{\n\s*position: absolute/.test(css),
    'the status message leaves the flow when folded, so it cannot move Save')

  // NO px query may govern the fold any more. A stray one would re-introduce
  // exactly the disagreement this replaced: CSS folding at one width while the
  // menu decides its contents at another.
  const foldSelectors = [/\.sp-sec \{ display: none/, /\.sp-mark \{ display: none/,
    /\.sp-group-history \{ display: none/, /\.sp-split \.sp-caret \{ display: none/]
  for (const sel of foldSelectors) {
    const i = css.search(sel)
    const opener = i < 0 ? null : [...css.slice(0, i).matchAll(/@media \(max-width: (\d+)px\)/g)].pop()
    const closer = i < 0 ? -1 : css.lastIndexOf('\n}', i)
    const inQuery = !!opener && closer < (opener.index ?? 0)
    ok(!inQuery, `${sel.source.slice(0, 28)} is not inside a width query`)
  }

  // The bar is sized by MEASUREMENT, and the measurement is the overflow of
  // the bar's own box — not a number written down twice.
  ok(/private fitTopbar\(\): void \{/.test(ed), 'fitTopbar exists')
  ok(/bar\.scrollWidth - bar\.clientWidth/.test(ed), '…and it measures overflow rather than matching a width')
  ok(/new ResizeObserver\(\(\) => this\.fitTopbar\(\)\)/.test(ed), 'a ResizeObserver drives it on viewport change')
  ok(/new MutationObserver\(\(\) => this\.fitTopbar\(\)\)/.test(ed),
    '…and a MutationObserver for content that changes width at a fixed viewport')
  ok(/attributeFilter: \['style', 'hidden'\]/.test(ed),
    "…which does NOT watch 'class', or its own tier flips would feed it")
  ok(/this\.barMO\?\.takeRecords\(\)/.test(ed), '…and it drops the records its own mutations queue')

  // THE JS GATE ASKS THE DOM. It used to be matchMedia with the phone number
  // written down a second time, and the comment beside it admitted as much;
  // when the two disagreed the symptom was a menu offering Undo while Undo sat
  // in the bar two centimetres away.
  ok(/isFolded\(\): boolean \{[\s\S]{0,160}?classList\.contains\('sp-bar-fold'\)/.test(ed),
    'isFolded() reads the tier off the bar instead of re-deriving it from a width')
  // Comments STRIPPED before this one: the doc comment above isFolded quotes
  // the expression it replaced, and an assertion that reads prose is an
  // assertion that fails when somebody explains themselves.
  const edCode = ed.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(!/matchMedia\('\(max-width: 600px\)'\)/.test(edCode),
    'no phone breakpoint is duplicated in the editor CODE')
  ok(/if \(this\.isFolded\(\)\)/.test(ed) && /t\('Undo \(⌘Z\)'\)/.test(ed) && /t\('Redo \(⇧⌘Z\)'\)/.test(ed),
    '…and the ⋯ menu picks up undo/redo exactly when the bar has folded them away')

  // the bar must never become a scroller — that hides the same controls, just
  // less honestly, and it is the fix everyone reaches for first
  const barRule = css.slice(css.indexOf('.sp-bar {'), css.indexOf('}', css.indexOf('.sp-bar {')))
  ok(!/overflow-x:\s*(auto|scroll)/.test(barRule), 'the topbar does not scroll horizontally')

  // a menu opened from the right end must open inward
  ok(/\.sp-dd-end \.sp-ddmenu \{ inset-inline-start: auto; inset-inline-end: 0/.test(css),
    'right-end dropdowns open inward')
  ok(/more\.classList\.add\('sp-more', 'sp-dd-end'\)/.test(ed) &&
     /saveMore\.classList\.add\('sp-caret', 'sp-dd-end'\)/.test(ed),
    '…and both right-end menus say so')
}

// ---- one declaration per block type ---------------------------------------
// Adding a type used to mean five edits across four files — the renderer's tag
// map and list map, the / menu, the markdown-autoformat table, and the markdown
// exporter. Four out of five looked finished and exported as a bare paragraph.
//
// It is also the merge-conflict surface: several people adding block types in
// parallel all edited the same four hot files. One registry, and each type is
// an independent entry.
{
  ok(SPECS.length >= 13, `the registry holds every block type (${SPECS.length})`)
  ok(new Set(SPECS.map((s) => s.type)).size === SPECS.length, 'block types are unique')
  for (const sp of SPECS) {
    ok(!!sp.label && !!sp.hint && !!sp.icon, `${sp.type}: has a label, hint and icon`)
    ok(!!sp.tag, `${sp.type}: declares its semantic element`)
  }

  // a list item must actually be an <li>, or it renders outside its <ul>
  for (const sp of SPECS.filter((s) => s.list)) {
    ok(sp.tag === 'li', `${sp.type}: a list block is an <li> (got <${sp.tag}>)`)
  }
  // …and the derived map must keep CUSTOM list types, which is the mistake that
  // would silently lift every to-do out of its list
  ok(TAG_OF.todo === 'li', 'todo keeps its <li> despite rendering custom')
  ok(LIST_OF.todo === 'ul' && LIST_OF.bullet === 'ul' && LIST_OF.number === 'ol',
    'the list map is derived correctly')

  // the autoformat triggers, ALIASES INCLUDED — "- " and "* " both start a
  // bullet, "[] " and "[ ] " both start a to-do. A registry that allowed one
  // pattern per type would have dropped half of these silently.
  const triggers = MD_SPECS.map(([re, type]) => `${re.source}=>${type}`).sort()
  const expected = [
    '^# $=>h1', '^## $=>h2', '^### $=>h3',
    '^- $=>bullet', '^\\* $=>bullet',
    '^1\\. $=>number', '^> $=>quote',
    '^\\[\\] $=>todo', '^\\[ \\] $=>todo',
    '^```(\\w*) $=>code', '^--- $=>divider',
    '^\\[!(note|tip|important|warning|caution)\\] $=>callout',
  ].sort()
  ok(JSON.stringify(triggers) === JSON.stringify(expected),
    `every markdown trigger survives the registry (${triggers.length} of ${expected.length})`)

  // the to-do trigger must still initialise `done`, or the checkbox renders
  // from an absent field
  const todoInit = MD_SPECS.find(([, type]) => type === 'todo')?.[2]
  const probe: Record<string, unknown> = {}
  todoInit?.(probe as never)
  ok(probe.done === false, 'the to-do trigger initialises done:false')

  // Every type is in the / menu UNLESS it is deliberately unlisted — and an
  // unlisted type must have another way in, or it is a block nobody can make.
  // `prop` is unlisted because a field is created from the issue header, where
  // its value can be chosen; "Field" in a block list would insert a value you
  // then have to go elsewhere to set.
  const hidden = SPECS.filter((sp) => sp.unlisted).map((sp) => sp.type)
  ok(MENU_SPECS.length === SPECS.length - hidden.length,
    `the / menu offers every type except the deliberately unlisted (${hidden.join(', ') || 'none'})`)
  {
    const fsm = await import('node:fs')
    const ed2 = fsm.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
    for (const h of hidden) {
      ok(new RegExp(`propBlock|newBlock\\('${h}'\\)`).test(ed2),
        `…and ${h} has another way in`)
    }
  }
  ok(SPEC.get('futuretype') === undefined, 'an unknown type has no spec — and must still render as text')
  ok(SPECS.filter((s) => s.type !== 'p').every((s) => !!s.toMd),
    'every type but plain text says how it exports to markdown')

  // and the consumers must actually derive, rather than keeping a second copy
  const fs = await import('node:fs')
  const read = (f: string) => fs.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')
  const ren = read('render.ts'), ed = read('editor.ts'), ab = read('about.ts')
  ok(/import \{[^}]*\bTAG_OF\b[^}]*\bLIST_OF\b[^}]*\} from '\.\/blocks'/.test(ren) &&
     !/const TAG_OF: Record/.test(ren) && !/const LIST_OF: Record/.test(ren),
    'render.ts derives its tag and list maps rather than repeating them')
  ok(/const SLASH_ITEMS = MENU_SPECS/.test(ed), 'the / menu is the registry')
  ok(/const AUTOFORMAT = MD_SPECS/.test(ed), 'autoformat is the registry')
  ok(/SPEC\.get\(b\.type\)/.test(ab) && !/case 'bullet': out\.push/.test(ab),
    'markdown export is the registry, not a parallel switch')
  // …including the SIXTH place a type used to have to be added by hand
  ok(/SPEC\.get\(type\)\?\.init\?\.\(b\)/.test(ed) && !/type === 'todo' && b\.done === undefined/.test(ed),
    'converting a block seeds its fields from the registry, not from a list in setType')
  // a container's body element is a registry fact, not a name test — the
  // second container type is what turned `b.type === 'toggle'` into a bug
  ok(/SPEC\.get\(b\.type\)\?\.container/.test(ren) && !/if \(b\.type === 'toggle'\) \{/.test(ren),
    'render.ts opens a container body from the registry, not from a hardcoded type name')
}

// ---- the callout block -----------------------------------------------------
// Its TONE is a permanent vocabulary and its markdown is a blockquote, which is
// the fragile part: a GitHub alert ends at the first line that is not "> ", so
// a nested block or a blank line silently exports half a callout as loose prose
// — and nothing about the document, the renderer or the type system notices.
{
  const spec = SPEC.get('callout')!
  ok(!!spec && spec.tag === 'aside' && spec.container === 'always' && spec.text === true,
    'callout is an <aside> that holds text and always shows its children')
  ok(CALLOUT_TONES.map((t) => t.tone).join() === 'note,tip,important,warning,caution',
    'the five tones are GitHub alert names, in escalation order')

  // the tone the trigger NAMED, not a default
  const fired = (typed: string): Block => {
    const b: Block = { id: 'x', type: 'p' }
    const rule = MD_SPECS.find(([re]) => re.test(typed))
    if (!rule) return b   // report a missing trigger, do not crash the rig
    b.type = rule[1]
    rule[2](b, rule[0].exec(typed)!)
    return b
  }
  ok(fired('[!warning] ').type === 'callout' && fired('[!warning] ').tone === 'warning',
    'typing [!warning] makes a callout that is a warning')
  ok(fired('[!CAUTION] ').tone === 'caution', 'the trigger is case-insensitive and stores lower case')
  { const b: Block = { id: 'x', type: 'callout' }; spec.init!(b); ok(b.tone === 'note', 'a callout with no tone named is a note') }
  // init also runs when an EXISTING block is converted, so it must not clobber
  { const b: Block = { id: 'x', type: 'callout', tone: 'caution' }; spec.init!(b); ok(b.tone === 'caution', 'init never overwrites a tone that is already there') }

  const md = (b: Partial<Block>, text = 'x') =>
    spec.toMd!({ id: 'c', type: 'callout', ...b } as Block, text, '',
      { titleOf: () => undefined, rowsOf: () => [] }).join('\n')
  ok(md({ tone: 'warning' }) === '> [!WARNING]\n> x', 'a callout exports as a GitHub alert')
  ok(md({}) === '> [!NOTE]\n> x', 'an absent tone exports as NOTE')
  ok(md({ tone: 'success' }) === '> [!SUCCESS]\n> x',
    'a tone this build does not know exports as the tone it IS — the word is not lost')
  // the tone came out of a file someone mailed you
  ok(md({ tone: 'evil]\n# heading' }).split('\n')[0] === '> [!EVILHEADING]',
    'a newline or bracket in a tone cannot break out of the alert tag')
  ok(md({ tone: 'note' }, 'one\ntwo') === '> [!NOTE]\n> one\n> two',
    'every line of a multi-line callout stays inside the quote')
  ok(md({ tone: 'note' }, '') === '> [!NOTE]\n>', 'an empty callout still closes its own line')

  // …and the LAYOUT around it: markers on the subtree, no blank line inside
  const page: Block[] = [
    { id: 'a', type: 'p' },
    { id: 'c', type: 'callout', tone: 'tip' },
    { id: 'k1', type: 'bullet', parent: 'c' },
    { id: 'k2', type: 'p', parent: 'c' },
    { id: 'z', type: 'p' },
  ]
  const lay = mdLayout(page)
  ok(lay[1].quote === '' && lay[2].quote === '> ' && lay[3].quote === '> ',
    'every block inside a callout carries the blockquote marker')
  ok(lay[1].sep === '>' && lay[2].sep === '>',
    'blocks of one alert are separated by a bare ">" — a blank line would close the box')
  ok(lay[3].sep === '' && lay[0].sep === '',
    'the alert ends with a real blank line, and does not start early')
  ok(lay[2].indent === '' && lay[4].quote === '',
    'a callout child is the alert body, not an indented list item, and the box does not leak')
  const nested = mdLayout([
    { id: 'c', type: 'callout' }, { id: 'd', type: 'callout', parent: 'c' }, { id: 'e', type: 'p', parent: 'd' },
  ])
  ok(nested[1].quote === '> ' && nested[2].quote === '> > ' && nested[0].sep === '>',
    'a callout inside a callout nests its quotes')
  // a hand-edited file can name a parent cycle; the renderer cannot loop but an
  // ancestor walk can, and a hung export is a hung tab
  const cyc = mdLayout([{ id: 'a', type: 'p', parent: 'b' }, { id: 'b', type: 'p', parent: 'a' }])
  ok(cyc.length === 2, 'a parent cycle terminates instead of hanging the export')

  // the tone NAME is localized in render.ts, because the i18n sweep only sees
  // literal strings — a tone with no case there ships as an English word
  const fs = await import('node:fs')
  const ren = fs.readFileSync(new URL('../spaces/src/render.ts', import.meta.url), 'utf8')
  for (const { tone } of CALLOUT_TONES) {
    const cap = tone[0].toUpperCase() + tone.slice(1)
    ok(new RegExp(`case '${tone}': return t\\('${cap}'\\)`).test(ren), `${tone}: its name is translated`)
  }

  // A callout's icon and a page's icon are both "a name from the set, or any
  // other string as text", and both take the name out of a file someone mailed
  // you. ICONS is an object literal, so `'toString' in ICONS` is TRUE and the
  // lookup returns a FUNCTION, which then gets stringified into the page.
  const ed = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  // comments stripped, or the sentence explaining the rule breaks the rule
  const code = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  ok(!/\bin ICONS\b/.test(code(ren)) && !/\bin ICONS\b/.test(code(ed)),
    'an icon NAME from a document is matched with hasOwn, never `in` (which finds Object.prototype)')
}

// ---- the table block -------------------------------------------------------
// A table is CONTENT (working/design/spaces-design.md §2.6) — no formulas, nothing
// that recalculates, and not the database case, which already shipped as the
// tracker. What is pinned here is the part that is PERMANENT: the shape of the
// model, the `html` fallback that is the whole of format additivity for a new
// block type, and the pipe-table round trip.
{
  const spec = SPEC.get('table')!
  ok(!!spec && spec.tag === 'div' && spec.custom === true && spec.text !== true,
    'table is a custom div whose text lives in its cells, not in a block host')
  ok(!MD_SPECS.some(([, type]) => type === 'table'),
    'a table has no markdown autoformat trigger — `|` is punctuation people type')

  // THE SHAPE IS READ, NEVER REPAIRED. Every field is optional in the format
  // and the file may be hand-written, agent-written or written by a build that
  // is not this one, so a ragged table is an ordinary input.
  const t = (b: Partial<Block>) => tableOf({ id: 'x', type: 'table', ...b } as Block)
  ok(t({ rows: [['a', 'b'], ['c']] }).rows[1][1] === '',
    'a ragged row is padded to the widest row, at read time')
  ok(t({ rows: [['a'], ['b', 'c']] }).w === 2, '…and the width is the widest row, not the first')
  ok(t({}).rows.length === 1 && t({}).rows[0].length === 1,
    'a table with no rows at all still has one cell to click in')
  ok(t({ rows: 'nope' as never }).w === 1, 'a `rows` that is not an array does not throw')
  ok(t({ rows: [[1 as never, 'b']] }).rows[0][0] === '', 'a cell that is not a string reads as empty')
  ok(t({ rows: [['a', 'b']] }).cols.length === 2 && t({ rows: [['a', 'b']] }).cols[0] === 1,
    'absent cols means equal columns, one weight per column')
  ok(t({ rows: [['a', 'b', 'c']], cols: [3] }).cols.join() === '3,1,1',
    'a cols of the wrong length is filled out rather than believed')
  ok(t({ rows: [['a']], cols: [0] }).cols[0] === 1 && t({ rows: [['a']], cols: [-4] }).cols[0] === 1,
    'a zero or negative weight would divide the table by zero — it reads as 1')
  ok(t({ rows: [['a', 'b']], colAlign: ['centre', 'right'] }).colAlign.join() === ',right',
    'an alignment this build does not know reads as none, and the known one survives')
  ok(t({}).header === true && t({ header: false }).header === false,
    'ABSENT header means TRUE — a pipe table always has one, so that is the case with no field')
  ok(t({ rows: Array.from({ length: 500 }, () => ['a']) }).h === TABLE_MAX_ROWS,
    'a generated file cannot ask the renderer for an unbounded number of rows')
  ok(t({ rows: [Array.from({ length: 80 }, () => 'a')] }).w === TABLE_MAX_COLS, '…or columns')

  // THE FALLBACK IS THE WHOLE OF ADDITIVITY FOR A NEW BLOCK TYPE. A build that
  // predates this one has no 'table' case, so it renders `html` — and if there
  // is no html it renders nothing, which is a table that VANISHES when the
  // space is opened by the build someone already has.
  {
    const b: Block = { id: 'x', type: 'table' }
    writeTable(b, { rows: [['Name', 'Ships'], ['<b>Slides</b>', 'yes']], cols: [1, 1], colAlign: ['', ''], header: true })
    ok(b.html === 'Name · Ships<br><b>Slides</b> · yes',
      'the fallback html is the cells joined — what a build with no table case shows')
    ok(b.cols === undefined && b.colAlign === undefined && b.header === undefined,
      'defaults are OMITTED, so a minimal hand-written table is byte-identical to one made here')
    ok(tableFallbackHtml([['see <a href="#p/p1">that page</a>']]).includes('#p/p1'),
      'the fallback keeps a cell’s LINKS, so buildIndex still finds the backlink')
    // and it really does: the index reads block.html and knows nothing of rows
    const idx = buildIndex({
      format: FORMAT, version: 1, docId: 'd', title: 'T', theme: {} as never,
      pages: [
        { id: 'p1', title: 'One', blocks: [] },
        { id: 'p2', title: 'Two', blocks: [{ id: 'b1', type: 'table', html: tableFallbackHtml([['<a href="#p/p1">One</a>']]) }] },
      ],
    } as unknown as SpacesDoc)
    ok((idx.backlinks.get('p1') ?? []).length === 1, 'a link typed in a CELL produces a backlink')
  }

  // …and the writer is the ONLY writer, so html can never drift from rows
  {
    const src = fsTable('editor.ts') + fsTable('markdown.ts')
    ok(/writeTable\(/.test(src) && !/\.rows\s*=[^=]/.test(src),
      'nothing assigns a block’s rows directly — every table write goes through writeTable, so the html fallback cannot drift')
  }

  // MARKDOWN. A pipe table is the interchange format for a content table, and
  // this app both writes and reads one.
  const md = (b: Partial<Block>, indent = '') =>
    spec.toMd!({ id: 'x', type: 'table', ...b } as Block, '', indent,
      { titleOf: () => undefined, rowsOf: () => [], inline: (h) => h }).join('\n')
  ok(md({ rows: [['A', 'B'], ['1', '2']] }) === '| A | B |\n| --- | --- |\n| 1 | 2 |',
    'a table exports as a GitHub-flavoured pipe table')
  ok(md({ rows: [['A', 'B']], colAlign: ['center', 'right'] }).split('\n')[1] === '| :---: | ---: |',
    'column alignment exports in the rule row, which is the only place GFM can say it')
  ok(md({ rows: [['A'], ['1']], header: false }).split('\n')[0] === '|   |',
    'a headerless table exports an EMPTY header row — GFM has no other way to say it')
  ok(md({ rows: [['a | b']] }).split('\n')[0] === '| a \\| b |',
    'a pipe inside a cell is escaped, or it becomes a column boundary')
  ok(md({ rows: [['a\nb']] }).split('\n')[0] === '| a<br>b |',
    'a line break inside a cell cannot become a row break')
  ok(md({ rows: [['', 'b']] }).split('\n')[0] === '|   | b |',
    'an empty cell is a space, never `||` — that is a column count nobody meant')
  ok(md({ rows: [['A']] }, '  ').split('\n')[0] === '  | A |', 'a nested table carries its indent')

  // …and back. The importer USED to keep a pipe table verbatim in a code block,
  // under a comment saying it was "mechanically upgradable the day a table
  // block ships".
  {
    const note = parseNote('| Name | Qty |\n| :--- | ---: |\n| Rice | 2 |\n| Salt | 1 |\n', 'F')
    const b = note.blocks[0]
    ok(b.type === 'table', 'a pipe table imports as a table, not as a code block')
    ok(JSON.stringify(b.rows) === JSON.stringify([['Name', 'Qty'], ['Rice', '2'], ['Salt', '1']]),
      '…with its rows')
    ok(JSON.stringify(b.colAlign) === JSON.stringify(['left', 'right']), '…and its column alignment')
    ok(b.html === 'Name · Qty<br>Rice · 2<br>Salt · 1', '…and a fallback for older builds')
    ok(parseNote('Name | Qty\n--- | ---\nRice | 2\n', 'F').blocks[0].rows?.[0].join() === 'Name,Qty',
      'the outer pipes are optional in GFM, so a row without them is still a row')
    ok(parseNote('| a \\| b |\n| --- |\n', 'F').blocks[0].rows?.[0][0] === 'a | b',
      'an escaped pipe is one cell, not two')
    ok(parseNote('| A | B |\n| --- | --- |\n| 1 |\n', 'F').blocks[0].rows?.[1].join() === '1,',
      'a short body row is padded against the header, which is GFM’s own rule')
    ok(parseNote('| **a** |\n| --- |\n', 'F').blocks[0].rows?.[0][0] === '<strong>a</strong>',
      'a cell is INLINE HTML through the same converter every other block uses')
    // the round trip the two halves owe each other
    const round = parseNote(md({ rows: [['A', 'B'], ['1', '2']], colAlign: ['', 'center'] }) + '\n', 'F').blocks[0]
    ok(JSON.stringify(round.rows) === JSON.stringify([['A', 'B'], ['1', '2']]) &&
       JSON.stringify(round.colAlign) === JSON.stringify(['', 'center']),
      'export → import is the identity on rows and alignment')
    const headless = parseNote(md({ rows: [['1', '2']], header: false }) + '\n', 'F').blocks[0]
    ok(headless.header === false && JSON.stringify(headless.rows) === JSON.stringify([['1', '2']]),
      '…including a headerless table, whose empty header row reads back as headerless')
  }

  // A CELL IS NOT A BLOCK HOST. `data-edit` means "this element's html IS the
  // block's html", so a cell carrying it would make the generic input handler
  // write one cell over the whole table.
  {
    const ren = fsTable('render.ts')
    ok(/td\.dataset\.cell = b\.id/.test(ren) && !/td\.dataset\.edit/.test(ren),
      'a table cell is data-cell, never data-edit')
    ok(/createElement\(head \? 'th' : 'td'\)/.test(ren),
      'a header cell is a real <th> — that is what buys row/column announcement and a repeating header in print')
  }
}

function fsTable(f: string): string {
  return nodeFs.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')
}

// ---- four things that were wrong in a shipped file ------------------------
{
  const fs2 = await import('node:fs')
  const rd = (f: string) => fs2.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')
  const main = rd('main.ts'), ed = rd('editor.ts'), mod = rd('model.ts')

  // 1. "Save a copy…" must not become the ⌘S target. saveFile(doc, true)
  //    ASSIGNS the picked handle to the module's in-place handle, so every
  //    later save wrote to the copy while the original stayed frozen at the
  //    moment it was taken. The code even carried a comment claiming the
  //    kernel did the opposite.
  ok(/writeUpdatedFileAs\(html, store\.doc/.test(main),
    'a copy is written through writeUpdatedFileAs (keepHandle defaults false)')
  // EVERY file, not just main.ts. The first version of this check read main.ts
  // alone and passed while about.ts kept its own "Save a copy…" button calling
  // saveFile(doc, true) — the same bug, in the same app, one file over.
  {
    const dir2 = new URL('../spaces/src/', import.meta.url)
    const all = fs2.readdirSync(dir2).filter((f) => f.endsWith('.ts'))
    // Comments stripped first: this file's own prose explains the bug it
    // guards, and a scanner that reads comments flags the explanation. (The
    // i18n sweep has the same trap — an example t('…') inside a comment adds a
    // required key to all eight catalogs.)
    const codeOnly = (src: string) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    const offenders = all.filter((f) => /saveFile\([^)]*,\s*true\)/.test(codeOnly(rd(f))))
    ok(offenders.length === 0,
      `no file saves a copy through saveFile(doc, true), which retargets ⌘S (${offenders.join(', ') || 'none'})`)
  }

  // 2. doc.readonly was declared in the format and read by nothing: a space
  //    saved as a reading copy opened fully editable.
  ok(/if \(frozen \|\| doc\.readonly(?: \|\| .+?)?\) store\.readOnly = true/.test(main),
    'doc.readonly opens the space read-only')
  //    …and so does a LIVE view-only copy, which is a different thing: a
  //    reading copy is sealed and has no session, while `collab.role:'reader'`
  //    keeps receiving and can never send. The editor lock is a courtesy to
  //    whoever holds it; the enforcement is the relay refusing to store or fan
  //    out anything from a socket that presented no signing key.
  ok(/isReaderCopy\(doc\)\) store\.readOnly = true/.test(main),
    'a view-only copy (collab.role: reader) also opens locked')

  // 3. the agent API must not report ids for blocks it did not write —
  //    store.commit early-returns on a read-only document, and the ids came
  //    back anyway.
  // Every write verb goes through ONE gate. It used to be a per-verb `if
  // (store.readOnly) return null`, which is a guard the next verb forgets; the
  // planner checks once, before applying anything, and says WHY rather than
  // returning a bare null an agent cannot distinguish from "nothing matched".
  ok(/function run<T extends object>\(plan: Plan<T>\): [^\n]*\{\s*\n\s*if \(store\.readOnly\)/.test(main),
    'every agent write verb is gated read-only in one place')
  ok(/err: 'readonly'/.test(main), '…and refusing says why, rather than returning a bare null')
  ok(/loadDoc: \(json: string\): boolean => \{\s*\n\s*if \(store\.readOnly\) return false/.test(main),
    'loadDoc refuses too — it replaces the whole document and does not go through the planner')

  // 4. #p/<page>/<block> is ALREADY admissible under sanitize.ts's allowlist,
  //    so it can arrive in a file this build did not write. It used to resolve
  //    to nothing — not even the page — and produced a backlink keyed on a
  //    page id that does not exist.
  ok(/private resolveAnchor\(/.test(ed), 'there is one anchor resolver')
  ok(/const id = this\.resolveAnchor\(href\)/.test(ed), '…and clicks go through it')
  ok(/function linkTarget\(/.test(mod) && /linkTarget\(m\[1\], page\)/.test(mod),
    'backlinks are keyed on the PAGE segment of a link target')
}

// ---- markdown triggers must survive a real keystroke -----------------------
// A trailing space typed at the end of a contentEditable line is inserted as
// U+00A0, not U+0020. So `/^## $/` matched nothing anyone typed and EVERY
// markdown trigger was dead from 0.1.0 — in the feature the starter space
// advertises on its Writing page.
//
// It survived because a test set `host.textContent` directly, with a real
// space. That is not typing, and it is why this assertion is about the FIX
// rather than the behaviour: the behaviour needs a browser and
// execCommand('insertText'), which is the only way to reproduce the NBSP.
{
  const fs2 = await import('node:fs')
  const ed = fs2.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  const fn = ed.slice(ed.indexOf('private autoformat('), ed.indexOf('private autoformat(') + 1600)
  ok(/replace\(\/\\u00a0\/g, ' '\)/.test(fn),
    'autoformat normalises U+00A0 before testing its patterns')
  // …and only for the test: rewriting the author's text would be worse
  ok(!/b\.html = .*replace\(\/\\u00a0/.test(ed),
    '…and never rewrites the stored text to make a pattern match')
}

// ---- syntax highlighting: the tokenizer is TOTAL, and cannot emit text ------
// Highlighting is applied at render time and must never touch the document, so
// the guarantee has to be structural rather than a promise. `tokenize` returns
// {kind, a, b} ranges into the caller's string — it has no way to produce a
// character the input did not contain, let alone markup — and the tokens
// PARTITION the input exactly. Sum the slices and you get the source back,
// byte for byte, for every language, including on input designed to break a
// lexer: an unterminated string, a lone backslash at EOF, a `</script>`, a
// smuggled `<img onerror>`.
//
// The partition is also what makes the renderer's job safe: it walks the ranges
// and builds one text node per token, so a bug here degrades to wrong COLOUR,
// never to wrong text and never to markup.
{
  const LANGS = CODE_LANGS.map((l) => l.id)
  ok(LANGS.length >= 9 && LANGS[0] === '', 'the picker offers plain text first, then the languages')

  const corpus = [
    '',
    'plain words with no syntax at all',
    'const a = 1 // done\n/* block\n   comment */\nfoo("bar", `t${x}`)',
    'def f(x):\n    """doc"""\n    return {\'k\': [1, 2.5e-3, 0xff]}\n@dec\nclass C: pass',
    '#!/bin/sh\nset -eu\necho "${HOME}/x" | grep -c \'a\'  # trailing note\ncurl host/p#frag',
    '{"a": 1, "b": [true, null], "c": {"d": "e"}}',
    'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest   # comment\n    steps: []',
    "SELECT * FROM t WHERE name = 'it''s' -- note\n/* x */ ORDER BY id DESC;",
    '<!doctype html>\n<div class="a" data-x=\'y\'>text &amp; more</div><!-- c -->\n<br/>',
    ':root { --x: 1; }\n.a:hover, #main { color: #1c4fb5; margin: -2.5rem 0 !important }\n@media print { }',
    // hostile / degenerate
    '</script><script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '"never closed',
    "'\\",
    '/* never closed',
    '`multi\nline\ntemplate`',
    '<div attr="never closed',
    '<<<>>>< <',
    '\r\n\t\u0000\u00a0',
    '\\\\\\',
    '𝔘𝔫𝔦 "🎉" — 中文 # x',
    '#',
    '@',
    '$',
    '0x',
    '1e',
    '...',
    '---',
    'a'.repeat(5000),
  ]

  let bad = 0
  let lossy = 0
  let split = 0
  let stringy = 0
  for (const lang of [...LANGS, 'rust', 'NOT-A-LANGUAGE', 'JavaScript', '.py']) {
    for (const text of corpus) {
      const toks = tokenize(text, lang)
      let at = 0
      let joined = ''
      for (const tk of toks) {
        if (tk.a !== at || tk.b <= tk.a || tk.b > text.length) bad++
        // a token carrying a STRING would be a way for markup to appear; the
        // shape is the guarantee, so it is asserted rather than assumed
        if (Object.values(tk).some((v) => typeof v !== 'number' && typeof v !== 'string')) stringy++
        if (typeof (tk as Record<string, unknown>).text === 'string') stringy++
        // never cut a surrogate pair in half — the renderer makes one text node
        // per token, and half a pair renders as U+FFFD
        if (tk.a > 0 && text.charCodeAt(tk.a - 1) >= 0xd800 && text.charCodeAt(tk.a - 1) <= 0xdbff) split++
        joined += text.slice(tk.a, tk.b)
        at = tk.b
      }
      if (at !== text.length) bad++
      if (joined !== text) lossy++
    }
  }
  ok(bad === 0, `tokens PARTITION the input exactly, for every language and every input (${bad} violations)`)
  ok(lossy === 0, `reassembling the tokens reproduces the source byte for byte (${lossy} losses)`)
  ok(stringy === 0, 'a token is offsets only — it carries no text, so it cannot carry markup')
  ok(split === 0, 'no token boundary falls inside a surrogate pair')

  // an unknown or absent language is ONE plain token, deliberately: the
  // fallback has to look like a decision, not like a lexer that gave up midway
  for (const lang of [undefined, '', 'rust', 'brainfuck', 42, null]) {
    const toks = tokenize('let x = "s" // c', lang)
    ok(toks.length === 1 && toks[0].k === '' && toks[0].a === 0 && toks[0].b === 16,
      `lang=${JSON.stringify(lang)} renders as one plain run`)
  }

  // aliases people actually type in a fence
  for (const [raw, want] of [
    ['javascript', 'js'], ['JS', 'js'], ['  tsx ', 'ts'], ['.py', 'py'], ['bash', 'sh'],
    ['yml', 'yaml'], ['psql', 'sql'], ['svg', 'html'], ['rust', ''], ['', ''],
  ] as const) {
    ok(normLang(raw) === want, `normLang(${JSON.stringify(raw)}) = ${JSON.stringify(want)}`)
  }
  ok(langLabel('bash') === 'Shell', 'a known tag shows its language name')
  ok(langLabel('rust') === 'rust', 'an UNKNOWN tag shows itself, so a plain block explains why it is plain')

  /** The kind of the token covering `needle`'s first occurrence. */
  const kindAt = (text: string, lang: string, needle: string, nth = 0): string => {
    let at = -1
    for (let i = 0; i <= nth; i++) at = text.indexOf(needle, at + 1)
    const tk = tokenize(text, lang).find((t) => t.a <= at && t.b >= at + needle.length)
    return tk ? tk.k : '?'
  }

  const cases: Array<[string, string, string, string]> = [
    // language, source, needle, expected kind
    ['js', 'const x = 1 // hi', 'const', 'k'],
    ['js', 'const x = 1 // hi', '// hi', 'c'],
    ['js', 'const x = 1 // hi', '1', 'n'],
    ['js', 'f("a\\"b", 2)', '"a\\"b"', 's'],
    ['js', 'x = `a\nb`', '`a\nb`', 's'],
    ['js', 'JSON.parse(s)', 'JSON', 'l'],
    ['ts', 'let a: string = "x"', 'string', 'l'],
    ['py', 'def f():\n  return None', 'def', 'k'],
    ['py', 'x = """a\nb"""', '"""a\nb"""', 's'],
    ['py', '@cache\ndef f(): pass', '@cache', 'k'],
    ['sh', 'echo "$HOME"', 'echo', 'l'],
    ['sh', 'echo $HOME', '$HOME', 'l'],
    ['sh', 'curl host/p#frag', '#frag', ''],            // NOT a comment
    ['sh', 'ls  # really a comment', '# really a comment', 'c'],
    ['sh', "echo 'C:\\'", "'C:\\'", 's'],               // no backslash escapes
    ['json', '{"a": 1}', '"a"', 'p'],                   // a key, not a value
    ['json', '{"a": "b"}', '"b"', 's'],
    ['json', '{"a": null}', 'null', 'l'],
    ['yaml', 'on: push', 'on', 'p'],                    // key beats the literal
    ['yaml', 'x: on', 'on', 'l'],
    ['yaml', 'runs-on: x', 'runs-on', 'p'],
    ['sql', 'select * from t', 'select', 'k'],
    ['sql', 'SELECT * FROM t', 'SELECT', 'k'],          // case-insensitive
    ['sql', "a = 'it''s'", "'it''s'", 's'],
    ['sql', 'x -- note', '-- note', 'c'],
    ['css', '.a { color: red }', 'color', 'p'],
    ['css', '.a { color: #1c4fb5 }', '#1c4fb5', 'n'],
    ['css', '#main { }', '#main', ''],                  // an id is not a colour
    ['css', '@media print {}', '@media', 'k'],
    ['css', 'a { margin: 10px }', '10px', 'n'],
    ['html', '<div class="a">t</div>', '<div', 'k'],
    ['html', '<div class="a">t</div>', 'class', 'p'],
    ['html', '<div class="a">t</div>', '"a"', 's'],
    ['html', '<div>text</div>', 'text', ''],
    ['html', '<!-- c --><p>', '<!-- c -->', 'c'],
  ]
  for (const [lang, src, needle, want] of cases) {
    const got = kindAt(src, lang, needle)
    ok(got === want, `${lang}: ${JSON.stringify(needle)} in ${JSON.stringify(src).slice(0, 34)} → "${got}" (want "${want}")`)
  }

  // an unterminated string stops at the line, not at end of file: half-written
  // code is the normal state of a code block, and one stray quote must not turn
  // the rest of the block into a string while you are typing
  {
    const src = 'a = "oops\nb = 2\nc = 3'
    ok(kindAt(src, 'js', '"oops') === 's' && kindAt(src, 'js', 'b = ') === '',
      'an unterminated string ends at the newline, not at end of file')
  }
}

// ---- what a code block STORES is plain text, and it round-trips -------------
// Colour is applied at render time; `Block.html` stays what it always was.
// `escText` is what the editor writes back, and it must be the exact inverse of
// the html parser's text decode — otherwise every save of an untouched block
// differs from the one before it, forever, in a format with no server to fix it.
{
  const decode = (s: string): string =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

  const texts = [
    'const a = 1',
    'if (a < b && c > d) {}',
    '</script><script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    'q = "double" and \'single\'',
    'a &amp; b',                 // already-escaped-looking text must survive
    'tab\there\nnewline\n\n',
    '𝔘𝔫𝔦 🎉 中文',
  ]
  let round = 0
  for (const s of texts) if (decode(escText(s)) !== s) round++
  ok(round === 0, 'escText round-trips through an html text decode, exactly')
  ok(!escText('say "hi"').includes('&quot;'),
    'escText leaves quotes alone — escaping them would make every save differ from the last')
  ok(escText('a & b') === 'a &amp; b' && escText('<i>') === '&lt;i&gt;',
    'escText escapes &, < and > — so a code block can never close its own tag')

  // and the whole document round-trips with code blocks in it
  const withCode = doc({
    pages: [{
      id: 'p1', title: 'Code', blocks: [
        { id: 'b1', type: 'code', lang: 'js', html: escText('const a = "<b>" // &') },
        { id: 'b2', type: 'code', lang: 'rust', html: escText('fn main() {}') },
        { id: 'b3', type: 'code', html: escText('no language at all') },
      ],
    }],
  })
  const r = parseDoc(withCode)
  ok(r.ok, 'a document full of code blocks parses')
  if (r.ok) {
    ok(r.doc.pages[0].blocks[0].html === 'const a = "&lt;b&gt;" // &amp;',
      'a code block\'s html survives parse untouched')
    ok(r.doc.pages[0].blocks[1].lang === 'rust',
      'a language this build cannot highlight is PRESERVED, not normalised away')
    const again = parseDoc(JSON.stringify(r.doc))
    ok(again.ok && JSON.stringify(again.doc.pages) === JSON.stringify(r.doc.pages),
      'and a second round trip changes nothing')
  }
}

// ---- highlighting builds NODES, never a string of markup -------------------
// The tokenizer cannot emit text (above), so the only place markup could enter
// is the painter. It must build with createElement/createTextNode and assign
// through textContent/Text.data — never innerHTML, which is how every other
// highlighter on the web does it and why they all need their own escaper.
{
  const fs = await import('node:fs')
  const read = (f: string) => fs.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')

  const hl = read('highlight.ts')
  ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\./.test(hl),
    'highlight.ts touches no DOM at all — it is a pure string→ranges function')

  const ren = read('render.ts')
  const paint = /export function paintCode[\s\S]*?\n}\n/.exec(ren)?.[0] ?? ''
  ok(paint.length > 0, 'render.ts exports paintCode')
  ok(!/innerHTML/.test(paint), 'paintCode never assigns innerHTML')
  ok(/createTextNode/.test(paint) && /createElement/.test(paint),
    'paintCode builds text nodes and elements')
  ok(/text\.slice\(tk\.a, tk\.b\)/.test(paint),
    'every painted string is a SLICE OF THE INPUT, so colouring cannot invent a character')

  // and the editor must read a code host as TEXT. Reading innerHTML there would
  // write the colour spans into the document — a permanent format change for a
  // render-time feature.
  const ed = read('editor.ts')
  const wireCode = /private wireCode[\s\S]*?\n  }\n/.exec(ed)?.[0] ?? ''
  ok(wireCode.length > 0, 'editor.ts has a dedicated code-block host')
  ok(!/innerHTML/.test(wireCode) && /host\.textContent/.test(wireCode),
    'the code host is read as textContent — colour spans never reach the model')
  ok(/escText\(text\)/.test(wireCode), 'and stored through escText')

  // A code block is TEXT: Enter must insert a newline rather than split the
  // block, because the model is now read from textContent and a `<br>` or a
  // wrapping `<div>` (which is what some engines insert) would vanish from it.
  ok(/b\.type === 'code'[\s\S]{0,400}insertText\('\\n'\)/.test(ed),
    'Enter inside a code block inserts a newline instead of splitting the block')

  // THE TRAILING SPACE IS NOT A SPACE. Measured in Chrome on the built shell:
  // after typing "## " into an empty block, `host.textContent` is
  // ['#','#',160] — the engine inserts U+00A0 so the space cannot collapse — so
  // `/^## $/` never matched and EVERY space-completed markdown trigger was
  // dead. The ```lang fence needs the same trailing space, which is how this
  // surfaced. The normalisation is applied to the test text only, never to the
  // model.
  ok(/replace\(\/\\u00a0\/g, ' '\)/.test(ed),
    'autoformat normalises the NBSP a browser inserts for a trailing space')
  ok(!/\u00a0/.test(ed), 'and editor.ts carries no LITERAL invisible NBSP, which would not survive retyping')
}

// ---- one list, everywhere -------------------------------------------------
// Four features merged in a day, built by agents who could not see each other's
// work, and every one of them needed to know something the codebase already
// knew. Each duplicate is a slow bug: the copy is right until the original
// changes, and then it is wrong in a way nothing reports.
{
  const fs3 = await import('node:fs')
  const rd3 = (f: string) => fs3.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  // the known block types come from the registry, not a second const
  ok(!/KNOWN_BLOCK_TYPES = \[/.test(strip(rd3('model.ts'))),
    'model.ts does not keep a second list of block types')
  ok(/SPECS\.map\(\(s\) => s\.type\)/.test(rd3('agent.ts')),
    'validate() derives known block types from the block registry')

  // the unwrap policy comes from the sanitizer, not a lowercased copy
  ok(/export const UNWRAP/.test(rd3('sanitize.ts')), 'the sanitizer exports its unwrap set')
  ok(/\[\.\.\.UNWRAP\]/.test(rd3('agent.ts')),
    'validate() derives the unwrap set from the sanitizer rather than restating it')
}

// ---- five defects an adversarial review reproduced -------------------------
// All five shipped with every gate green, which is the point: each lived in a
// case the author's own spot-check did not reach.
{
  // 1. Display text must escape ONCE. Everything a hold() placeholder protects
  //    is final markup carrying its own escaping; everything else is escaped by
  //    the single esc() at the end. Link text, wikilink aliases, autolink text
  //    and image alt were escaped twice, so `[Q&A](…)` reached the file as
  //    `Q&amp;amp;A` and the reader saw the entity. Bold and italic were never
  //    affected — their text is outside any placeholder — which is exactly why
  //    "inline formatting survived" passed.
  for (const [src, want] of [
    ['[a & b](https://x)', 'a &amp; b'],
    ['[[Note & co]]', 'Note &amp; co'],
    ['![alt & x](https://y/p.png)', 'alt &amp; x'],
    ['**bold & co**', 'bold &amp; co'],
  ] as Array<[string, string]>) {
    const got = inlineHtml(src)
    ok(got.includes(want) && !got.includes('&amp;amp;'),
      `${src} escapes once (${got.slice(0, 52)})`)
  }

  // 2. An image is neither a continuation target nor a parent: it has no html,
  //    so a continuation line wrote the literal string "undefined" into the
  //    document and hid the author's text everywhere except search.
  const capt = parseNote('- ![a picture](pic.png)\n  the caption line\n', 'f').blocks
  ok(!JSON.stringify(capt).includes('undefined'), 'an image caption never writes "undefined" into the document')
  ok(capt.some((b) => b.type === 'p' && b.html === 'the caption line'),
    '…the line survives as its own paragraph')
  ok(!capt.some((b) => b.parent && capt.find((x) => x.id === b.parent)?.type === 'image'),
    '…and is never parented to the image, which is not a container')

  // 3. No page arrives with zero blocks. A zero-block page has no editable
  //    host, no gutter and no / menu — and the importer navigated to one.
  const plan = planImport(
    [{ path: 'V/Home.md', text: '# Home\n\nhi' }, { path: 'V/Sub/A.md', text: '# A\n\nyo' }, { path: 'V/E.md', text: '' }] as never,
    { rootTitle: 'V' } as never,
  )
  ok(plan.pages.every((p: { blocks: unknown[] }) => p.blocks.length > 0),
    'every imported page has at least one block, folders and empty files included')

  // 4. A page cycle already in a file (parseDoc keeps it — it only drops
  //    parents naming no page) made the ancestor walk run forever. Measured:
  //    the call never returned and the tab died with its unsaved edits. The
  //    reachable path is the RECOMMENDED one — validate() reports the cycle,
  //    an agent re-homes a page to fix it, and that call hangs.
  const cyc = parseDoc(JSON.stringify({
    format: FORMAT, version: 1, docId: 'cyc', title: 'x', home: 'A',
    pages: [
      { id: 'A', title: 'A', parent: 'B', blocks: [{ id: 'a', type: 'p', html: 'a' }] },
      { id: 'B', title: 'B', parent: 'A', blocks: [{ id: 'b', type: 'p', html: 'b' }] },
      { id: 'C', title: 'C', blocks: [{ id: 'c', type: 'p', html: 'c' }] },
    ],
  }))
  // Checked in the SOURCE as well as in behaviour: without the visited set the
  // call never returns, so a regression HANGS this rig rather than failing it,
  // and CI would time out with nothing useful to read. The behavioural check
  // below still earns its place — it proves termination rather than the
  // presence of a variable.
  ok(/const seen = new Set<string>\(\)[\s\S]{0,220}!seen\.has\(up\)/.test(
    (await import('node:fs')).readFileSync(new URL('../spaces/src/agent.ts', import.meta.url), 'utf8')),
    'the ancestor walk carries a visited set')

  ok(cyc.ok, 'a document carrying a page cycle still loads')
  if (cyc.ok) {
    const t0 = Date.now()
    planUpdatePage(cyc.doc as never, 'C', { parent: 'A' } as never)
    ok(Date.now() - t0 < 1000, 'updatePage terminates on a page cycle instead of hanging the tab')
  }

  // 5. The markdown quote prefix is applied PER LINE, not per returned element
  //    — a code block's body is one multi-line string, and an unquoted 2nd line
  //    ends the blockquote and unterminates the fence.
  const fsq = await import('node:fs')
  const ab = fsq.readFileSync(new URL('../spaces/src/about.ts', import.meta.url), 'utf8')
  ok(/flatMap\(\(l\) => l\.split\('\\n'\)\)/.test(ab),
    'markdown export quotes each LINE of a multi-line block')
}

// ---- the side panel behaves the way slides' does ---------------------------
// Two apps in one suite should not teach two different panels. The control that
// hides a panel belongs on the panel's own EDGE, and it must be visible without
// hovering — the first version faded in on hover, so the way to hide the panel
// was invisible until you happened to pass over a 5px strip.
{
  const fsp = await import('node:fs')
  const ed = fsp.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  const css = fsp.readFileSync(new URL('../spaces/src/styles.css', import.meta.url), 'utf8')
  const ic = fsp.readFileSync(new URL('../spaces/src/icons.ts', import.meta.url), 'utf8')

  ok(/makeResizer\(\)/.test(ed), 'the page list has a resizer strip')
  ok(/col-resize/.test(css), '…that resizes')
  ok(/dblclick[\s\S]{0,200}PANE_DEFAULT/.test(ed), '…double-click resets it to the default width')
  ok(/PANE_MIN[\s\S]{0,400}PANE_MAX/.test(ed) || /Math\.min\(Editor\.PANE_MAX/.test(ed),
    '…and the width is clamped')
  ok(/localStorage\.setItem\('bento-sp-pane'/.test(ed),
    'the width is the READER\'s — localStorage, never the document')

  ok(/sp-pane-tab/.test(css) && /sp-pane-closed/.test(css), 'the panel collapses from a tab on the strip')
  const tabRule = css.slice(css.indexOf('.sp-pane-tab {'), css.indexOf('}', css.indexOf('.sp-pane-tab {')))
  ok(!/opacity:\s*0\b/.test(tabRule), 'the collapse chevron is visible without hovering')
  ok(/\.sp-side\.sp-pane-closed \+ \.sp-resizer \.sp-pane-tab/.test(css),
    '…and stays reachable when the panel is closed, docked to the edge')

  // the drawer breakpoint keeps its overlay behaviour: a 0px column on a phone
  // would leave nothing to reopen from
  ok(/isDrawer\(\)[\s\S]{0,120}max-width: 820px/.test(ed), 'below 820px the panel is a drawer, not a column')

  // the suite's undo/redo, not a circular arrow that reads as "reload"
  ok(/M9 14 4 9l5-5/.test(ic) && /m15 14 5-5-5-5/.test(ic),
    'undo/redo use the suite\'s glyphs')
}

// ---- a saved space shows its content to readers that run no script --------
// The runtime ships deflated and inflates at boot, so with scripting off
// nothing boots and the splash is never removed: every saved space appeared as
// the bento boot animation to macOS QuickLook, iOS Files, bento/home and any
// preview pane that renders HTML without executing it. Reported from the field.
{
  const fsv = await import('node:fs')
  const rdv = (f: string) => fsv.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')
  const main = rdv('main.ts'), pv = rdv('preview.ts')

  ok(/registerPreview\(/.test(main), 'spaces registers a static first-page preview')
  ok(/buildSpacePreview/.test(pv), '…built by preview.ts')

  // A still has no runtime, so nothing in it may run, load or take input.
  for (const tag of ['script', 'iframe', 'input', 'button', 'form', 'video', 'audio']) {
    ok(new RegExp(`BANNED[^\n]*\\b${tag}\\b`).test(pv), `the preview strips <${tag}>`)
  }
  // …and it must never FETCH. A remote <img> here would phone home from a file
  // manager — the remote-image consent rule, in a place nobody can consent.
  ok(/'href', 'src', 'srcset'/.test(pv), 'the preview drops href and src')
  ok(/startsWith\('data:'\)/.test(pv), '…keeping only images already inside the file')
  ok(/attr\.name\.startsWith\('on'\)/.test(pv), 'and strips every on* handler')

  // nothing to show is not the same as something to hide
  ok(/if \(!doc\?\.pages\?\.length\) return null/.test(pv),
    'a document with no pages produces no preview rather than an empty box')

  // budgeted: a courtesy must never be why a file is large
  ok(/PREVIEW_BUDGET/.test(pv) && /byteLength\(built\) <= PREVIEW_BUDGET/.test(pv),
    'the preview is size-budgeted, with a title card as the fallback')
}

// ---- a block can be moved, duplicated and deleted, on every device --------
// Four actions existed NOWHERE: move up, move down, duplicate, delete.
// Deletion was Backspace-into-the-previous-block; reordering was drag-only —
// and the drag gutter was display:none on touch, so on a phone a block could
// not be reordered or removed at all.
{
  const fsb = await import('node:fs')
  const rdb = (f: string) => fsb.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')
  const ed = rdb('editor.ts'), css = rdb('styles.css')

  ok(/private blockActions\(/.test(ed), 'the block actions are declared as ONE list')
  for (const label of ['Turn into', 'Add below', 'Move up', 'Move down', 'Duplicate', 'Delete']) {
    ok(new RegExp(`t\\('${label}`).test(ed), `…including ${label}`)
  }
  ok(/openBlockMenu\(/.test(ed) && /this\.blockActions\(id\)/.test(ed),
    'and the menu is built from that list rather than a second copy')

  // the gutter must SURVIVE the drawer breakpoint, or none of it is reachable
  const narrow = css.slice(css.indexOf('@media (max-width: 820px)'))
  ok(!/\.sp-gutter \{ display: none/.test(narrow), 'the gutter is not hidden on touch')
  ok(/\.sp-gutter \{ opacity: 1/.test(narrow), '…it is shown rather than hovered')
  // …AND IT DOES NOT TAKE A ROW. The first fix for "no hover on touch" put the
  // gutter in the flow (position: static), which cost 36px of height on EVERY
  // block: measured at 390px, a one-line paragraph was 68.4px tall and half of
  // that was the two affordances. It belongs in the start margin, out of flow.
  ok(!/\.sp-gutter \{[^}]*position: static/.test(narrow),
    '…and it is out of the flow, so a block does not pay a row for it')
  // …reserved on the PAGE, not on the scroller: `.sp-main` follows the
  // interface direction and a block follows the document's (theme.dir), so an
  // rtl document put the padding on one side and the gutter on the other.
  ok(/\.sp-page-inner \{ padding-inline-start: 26px/.test(narrow),
    'the page reserves the margin the gutter sits in, on the side the blocks start')
  ok(!/\.sp-main \{[^}]*padding-inline-start/.test(narrow),
    '…and the scroller does not, so the two cannot disagree under rtl')
  ok(/sp-sheet/.test(css) && /isDrawer\(\)/.test(ed),
    'and the menu becomes a bottom sheet where a 5px anchor would be unusable')

  // a disabled action is shown, not removed — a menu that changes shape is one
  // you have to re-read every time
  ok(/sp-off/.test(css) && /a\.off/.test(ed), 'unavailable actions are disabled, not hidden')

  // THE SUBTREE RULES. Each of these silently loses or orphans work.
  ok(/never drop a block inside its own subtree/.test(ed), 'a block cannot be moved into itself')
  ok(/AFTER the target's whole SUBTREE/.test(ed),
    'a move lands after the target\'s whole subtree, not between a container and its children')
  ok(/if \(c\.parent && remap\.has\(c\.parent\)\) c\.parent = remap\.get\(c\.parent\)/.test(ed),
    'a duplicate rewrites its copies\' parent links, so the copy owns the copies')
  ok(/if \(!page\.blocks\.length\) page\.blocks\.push\(newBlock\('p'\)\)/.test(ed),
    'deleting the last block leaves something to type into')
}

// ---- an issue is a page, and its fields are blocks ------------------------
// The tracker format is PERMANENT. What has to hold forever:
//  · a value is a BLOCK, so search, undo, export and the preview see it
//  · the block carries a readable `html`, so a build that predates all of this
//    shows "Status: In progress" instead of nothing
//  · the SCHEMA is document-level and additive, so an old build ignores it
//  · nothing a newer build writes is DROPPED — not an unknown option, not an
//    unknown field key
{
  const status = fieldByKey({ } as never, 'status') ?? DEFAULT_FIELDS[0]

  // the schema is additive: absent means the defaults, not "no fields"
  ok(fieldsOf({} as never).length === DEFAULT_FIELDS.length,
    'a document with no fields key gets the default schema')
  ok(fieldsOf({ fields: [{ key: 'k', label: 'K', vt: 'text' }] } as never).length === 1,
    '…and a document that declares its own schema keeps it')

  // the readable form is the degradation guarantee
  ok(propHtml(status, 'doing') === 'Status: In progress',
    `a value's readable form names the field and the label (${propHtml(status, 'doing')})`)
  ok(propHtml(status, '') === 'Status: —', 'an empty value still says which field it is')
  const unknownOpt = propHtml(status, 'shipped-to-space')
  ok(unknownOpt.includes('shipped-to-space'),
    `an option this build does not know is shown VERBATIM, never blanked (${unknownOpt})`)
  ok(!/[<>]/.test(propHtml({ key: 'x', label: '<b>L', vt: 'text' }, '<img>')),
    'the readable form is escaped — it is html, and the value is author data')

  // the block itself
  const blk = propBlock(status, 'todo', 'b1') as Record<string, unknown>
  ok(blk.type === 'prop' && blk.key === 'status' && blk.value === 'todo',
    'a field value is a prop BLOCK carrying key and value')
  ok(typeof blk.html === 'string' && (blk.html as string).length > 0,
    '…and always its readable form, in step with the value')

  // an issue is DERIVED, never flagged
  const doc = parseDoc(JSON.stringify({
    format: FORMAT, version: 1, docId: 'tk', title: 'T', home: 'p1',
    pages: [
      { id: 'p1', title: 'Board', blocks: [{ id: 'v', type: 'view', layout: 'board', groupBy: 'status', html: 'All' }] },
      { id: 'p2', title: 'An issue', blocks: [
        { id: 'ps', type: 'prop', key: 'status', value: 'doing', html: 'Status: In progress' },
        { id: 'pa', type: 'prop', key: 'assignee', value: 'sam', html: 'Assignee: sam' },
        { id: 'pb', type: 'p', html: 'the body' },
      ] },
      { id: 'p3', title: 'Just a page', blocks: [{ id: 'x', type: 'p', html: 'prose' }] },
      { id: 'p4', title: 'Archived issue', archived: true, blocks: [
        { id: 'qs', type: 'prop', key: 'status', value: 'todo', html: 'Status: Todo' },
      ] },
    ],
  }))
  ok(doc.ok, 'a tracker document loads')
  if (doc.ok) {
    const [board, issue, plain] = doc.doc.pages
    ok(isIssue(issue) && !isIssue(plain) && !isIssue(board),
      'an issue is a page WITH A STATUS — not a page type, not a flag')
    ok(valuesOf(issue).get('assignee') === 'sam', 'a page reports its field values by key')
    ok(headerLength(issue) === 2, 'leading prop blocks are the header strip, by POSITION')
    ok(headerLength(plain) === 0, '…and a page with no fields has no header')

    const rows = issuesOf(doc.doc)
    ok(rows.length === 1, `issuesOf lists issues only (${rows.length})`)
    ok(!rows.some((r) => r.page.archived), 'and never an archived one')

    // format additivity, both directions
    const round = JSON.parse(JSON.stringify(doc.doc))
    const kept = round.pages[1].blocks[0]
    ok(kept.key === 'status' && kept.value === 'doing' && kept.html === 'Status: In progress',
      'a prop block round-trips whole')
    ok(round.pages[0].blocks[0].layout === 'board',
      'a view block keeps the query a newer build wrote')
  }

  // an unknown FIELD KEY must not throw or vanish — it renders its own html
  ok(fieldByKey({} as never, 'no-such-field') === undefined,
    'an unknown field key resolves to no spec')
  ok(optionOf(undefined, 'x') === undefined, '…and asking for its options is not an error')
}

// ---- a view can be NARROWED, and a card can be MOVED ----------------------
// A filter is stored on the view block, so it is as permanent as the board is,
// and everything here is a thing that fails SILENTLY: a filter shows too few
// issues and looks like an empty tracker; a filter this build cannot read shows
// too many and looks like it worked; a drag that lands where it started writes
// an undo step you have to press ⌘Z past for nothing.
{
  const doc = {
    format: FORMAT, version: 1, docId: 'tk', title: 'T',
    pages: [], theme: {},
  } as unknown as SpacesDoc
  const vals = (o: Record<string, unknown>) => new Map(Object.entries(o))

  // ABSENT MEANS EVERYTHING — the rule that keeps every view block written
  // before filters existed working unchanged
  ok(passesFilter(doc, vals({ status: 'done' }), undefined), 'no filter shows everything')
  ok(passesFilter(doc, vals({ status: 'done' }), {}), '…and neither does an empty one')
  ok(passesFilter(doc, vals({ status: 'done' }), { is: { status: [] } }),
    '…nor a field whose value list is empty, which is no constraint rather than "nothing passes"')

  // filter by a value
  ok(passesFilter(doc, vals({ status: 'todo' }), { is: { status: ['todo', 'doing'] } }),
    'a value in the list passes')
  ok(!passesFilter(doc, vals({ status: 'done' }), { is: { status: ['todo', 'doing'] } }),
    '…and one that is not does not')
  ok(passesFilter(doc, vals({ labels: ['bug', 'ui'] }), { is: { labels: ['ui'] } }),
    'a list-valued field passes on any member')
  ok(!passesFilter(doc, vals({}), { is: { status: ['todo'] } }),
    'an issue with no value for a filtered field does not pass')

  // A VALUE THIS BUILD DOES NOT KNOW is compared literally — a filter written
  // by a newer build still selects the issues it meant
  ok(passesFilter(doc, vals({ status: 'shipped-to-space' }), { is: { status: ['shipped-to-space'] } }),
    'an unknown value is filtered ON, not dropped')

  // OPEN ONLY, from FieldOption.group
  ok(phaseField(doc)?.key === 'status',
    'the phase field is derived from the schema — the first whose options declare a group')
  ok(phaseField({ fields: [{ key: 'k', label: 'K', vt: 'text' }] } as never) === undefined,
    '…and a schema that declares no phases has none')
  ok(passesFilter(doc, vals({ status: 'doing' }), { open: true }), 'a started issue is open')
  ok(passesFilter(doc, vals({ status: 'backlog' }), { open: true }), 'an unstarted one is open')
  ok(!passesFilter(doc, vals({ status: 'done' }), { open: true }), 'a done one is not')
  ok(!passesFilter(doc, vals({ status: 'cancelled' }), { open: true }), 'nor is a cancelled one')
  ok(isOpenPhase(phaseField(doc), 'shipped-to-space'),
    'a status this build cannot read counts as OPEN — hiding work is the loss, showing one issue too many is not')
  ok(passesFilter({ fields: [{ key: 'k', label: 'K', vt: 'text' }] } as never, vals({}), { open: true }),
    'and "open" over a schema with no phases passes everything rather than emptying the board')

  // a rule from a NEWER BUILD: kept, not applied, and SAID OUT LOUD
  const future = { open: true, since: '2026-01-01' }
  ok(unknownFilterKeys(future).join() === 'since',
    'a filter key this build cannot evaluate is reported')
  ok(unknownFilterKeys({ is: {}, open: true }).length === 0, '…and a known one is not')
  ok(passesFilter(doc, vals({ status: 'doing' }), future),
    'the rules this build DOES know are still applied alongside it')
  ok(JSON.parse(JSON.stringify({ type: 'view', filter: future })).filter.since === '2026-01-01',
    'and the rule itself round-trips verbatim')

  ok(filterCount(undefined) === 0 && filterCount({ open: true, is: { status: ['a'], p: [] } }) === 2,
    'the Filter button counts what actually narrows — an empty value list narrows nothing')

  // ---- dropping a card ----------------------------------------------------
  // THE BOARD'S ORDER IS THE PAGE ORDER. No per-view order field exists, so the
  // arithmetic here is the whole mechanism, and its null return is what keeps a
  // drag that went nowhere out of the undo stack.
  const ps = (...ids: string[]): Page[] => ids.map((id) => ({ id, title: id, blocks: [] }))
  const ids = (list: Page[] | null): string => (list ?? []).map((p) => p.id).join('')

  ok(ids(reorderPages(ps('a', 'b', 'c'), 'c', { before: 'a' })) === 'cab', 'a card moves before another')
  ok(ids(reorderPages(ps('a', 'b', 'c'), 'a', { after: 'c' })) === 'bca', '…or after the last one')
  ok(reorderPages(ps('a', 'b', 'c'), 'a', { before: 'b' }) === null,
    'dropping a card exactly where it already is records NOTHING')
  ok(reorderPages(ps('a', 'b', 'c'), 'b', { after: 'a' }) === null, '…from either side of the gap')
  ok(reorderPages(ps('a', 'b', 'c'), 'b', { before: 'b' }) === null, '…and dropping it on itself is not a move')
  ok(reorderPages(ps('a', 'b', 'c'), 'b', {}) === null,
    'a drop into an EMPTY column is a status change only, never a reorder')
  ok(reorderPages(ps('a', 'b'), 'zz', { before: 'a' }) === null, 'a page that is not there does not move')
  ok(reorderPages(ps('a', 'b'), 'a', { before: 'zz' }) === null, '…and neither does one aimed at a card that is not')
  // the anchor is an ID because the index moves under the splice
  ok(ids(reorderPages(ps('a', 'b', 'c', 'd'), 'a', { before: 'd' })) === 'bcad',
    'moving forwards lands before the anchor, not one short of it')
  ok(ids(reorderPages(ps('a', 'b', 'c', 'd'), 'd', { after: 'a' })) === 'adbc',
    'and moving backwards lands after it')

  // the value block a card's status button and a drop both write through
  const page: Page = { id: 'p', title: 'x', blocks: [
    { id: 'b1', type: 'prop', key: 'status', value: 'todo', html: 'Status: Todo' },
    { id: 'b2', type: 'p', html: '' },
  ] }
  ok(propBlockOf(page, 'status')?.id === 'b1', 'a page reports the BLOCK holding a field, not just its value')
  ok(propBlockOf(page, 'priority') === undefined,
    'and a field it does not carry has none — the drop creates one through propBlock')
}

// ---- the board's writes go through the ONE writer -------------------------
// `value` and `html` must move together on EVERY path, or a status set from the
// board is invisible to an older build, a thumbnailer, a grep and the markdown
// export. There are three ways to set one now (the header chip, the card
// button, a drag) and they must not become three writers.
{
  const fs = await import('node:fs')
  const ed = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  const ren = fs.readFileSync(new URL('../spaces/src/render.ts', import.meta.url), 'utf8')

  ok((ed.match(/propHtml\(/g) ?? []).length === 1,
    'editor.ts calls propHtml in exactly ONE place — applyField, the single writer')
  ok(/private applyField\([^)]*\)[^{]*\{\s*;?\(b as Record<string, unknown>\)\.value = value\s*b\.html = propHtml\(f, value\)/.test(ed),
    '…and that writer sets value and html together, in adjacent statements')
  ok(!/\.value = optId/.test(ed),
    'the drop handler does not assign a value of its own')

  // undo scope: a page entry snapshots the page IN VIEW (store.ts), so a value
  // changed from a board — which is on another page — must take a doc entry
  ok(/at\.pageId === s\.pageId \? 'page' : 'doc'/.test(ed),
    'a field set on another page takes a DOCUMENT undo entry, not a page one')

  // one drag = one undo step, and a drag that changed nothing = none
  ok(/if \(!setting && !order\) return/.test(ed),
    'a drop that changes neither value nor order commits nothing')
  ok((ed.match(/s\.commit\(\(\) => \{[\s\S]*?if \(order\) s\.doc\.pages = order/g) ?? []).length === 1,
    'the value change and the move are ONE commit — one drag, one undo step')

  // read-only and reading view: no board machinery at all. The guard is on the
  // wiring ITSELF, not only on its call site — the callout chip loop shipped
  // wired in reading view for exactly one round because the guard lived
  // somewhere a later edit could step outside of.
  ok(/private wireBoard\([^)]*\)[^{]*\{\s*const s = this\.store\s*if \(s\.readOnly \|\| this\.reading\) return/.test(ed),
    'the board refuses to wire itself in a locked space or in reading view')
  ok(/const own = opts\.editable && field && propBlockOf/.test(ren),
    'the renderer emits a card status BUTTON only for an editable document')
  // …and EVERY view control likewise. Pinned as "each control name appears
  // between the editable guard and the head being mounted", rather than to one
  // line of the block — this assertion used to name the first statement inside
  // the guard, so adding a control above it broke the test without breaking
  // anything, and adding one BELOW the guard would have broken the app without
  // breaking the test.
  const guarded = ren.slice(ren.indexOf('if (opts.editable) {'), ren.indexOf('host.appendChild(head)'))
  const controls = ['viewLayout', 'viewGroup', 'viewSort', 'viewOpen', 'viewFilter']
  ok(guarded.length > 0 && controls.every((c) => guarded.includes(c)),
    `…and the view controls likewise, so a reader and a printout get neither (${
      controls.filter((c) => !guarded.includes(c)).join(', ') || 'all inside the guard'})`)
  // the whole point of the guard is that it is the ONLY place they are made
  ok(controls.every((c) => (ren.split(c).length - 1) === (guarded.split(c).length - 1)),
    'no view control is created outside that guard')
}

// ---- a view's ORDER --------------------------------------------------------
// The properties that go wrong silently: a sort that reorders a board somebody
// arranged by hand, a blank promoted to the top when the direction flips, and a
// select sorted into alphabetical order, which throws away the one thing a
// status list was telling you.
{
  const doc = { fields: DEFAULT_FIELDS } as unknown as SpacesDoc
  const row = (id: string, v: Record<string, unknown>): IssueRow =>
    ({ page: { id, title: id, blocks: [] } as Page, values: new Map(Object.entries(v)) })

  const rows = [
    row('a', { status: 'done', estimate: 3 }),
    row('b', { status: 'backlog', estimate: 1 }),
    row('c', { status: 'doing' }),
    row('d', { status: 'todo', estimate: 2 }),
  ]
  const ids = (rs: IssueRow[]) => rs.map((r) => r.page.id).join('')

  ok(sortRows(doc, rows, undefined) === rows,
    'no sort returns the SAME array — a view nobody sorted keeps the page order it had')
  ok(sortRows(doc, rows, []) === rows, 'and so does an empty one')
  ok(ids(sortRows(doc, rows, [{ key: 'status' }])) === 'bdca',
    'a select sorts by its DECLARED order (backlog, todo, doing, done), never alphabetically')
  ok(ids(sortRows(doc, rows, [{ key: 'status', dir: 'desc' }])) === 'acdb',
    '…and reverses on request')
  ok(ids(sortRows(doc, rows, [{ key: 'estimate' }])) === 'bdac',
    'a number sorts numerically, with the one that has none at the end')

  // the one that bites: absence is not a small value
  const asc = sortRows(doc, rows, [{ key: 'estimate' }])
  const desc = sortRows(doc, rows, [{ key: 'estimate', dir: 'desc' }])
  ok(asc[asc.length - 1].page.id === 'c' && desc[desc.length - 1].page.id === 'c',
    'an UNSET value sorts last in BOTH directions — a blank estimate is not the cheapest issue')

  // ties keep the page order, so a hand-arranged board still reads that way
  // inside each band
  const tied = [row('x', { status: 'todo' }), row('y', { status: 'todo' }), row('z', { status: 'todo' })]
  ok(ids(sortRows(doc, tied, [{ key: 'status' }])) === 'xyz', 'ties are stable — page order survives')

  // additivity: a key from a newer build is skipped and SAID SO, never guessed
  ok(sortRows(doc, rows, [{ key: 'sprint' }]) === rows,
    'a sort key this build has no field for changes nothing')
  ok(unknownSortKeys(doc, [{ key: 'sprint' }, { key: 'status' }]).join() === 'sprint',
    '…and is reported, so the view can say the order is not the one its author asked for')
  ok(unknownSortKeys(doc, undefined).length === 0 && unknownSortKeys(doc, 'nonsense').length === 0,
    'a malformed sort reports nothing rather than throwing — it came out of a file someone sent you')

  // a value a newer build wrote has no declared seat: it goes last, not first
  const newer = [row('m', { status: 'todo' }), row('n', { status: 'blocked' })]
  ok(ids(sortRows(doc, newer, [{ key: 'status' }])) === 'mn',
    'a status from a newer build sorts after every one this build knows')
}

// ---- SORTING BY A TABLE COLUMN HEADER --------------------------------------
// A header is the second control that writes `sort`, and the one a reader will
// actually reach for. Two properties, both of which fail silently:
//
//   · THE THIRD STATE IS "NONE". A header that only flips between ascending and
//     descending can never give a hand-arranged board its order back, and
//     "manual order" is not a sort called manual — it is the ABSENCE of the key.
//     Storing `sort: []` would satisfy every screen and would still leave a
//     view somebody sorted and unsorted permanently different from one nobody
//     touched, in a file on somebody else's disk.
//
//   · THE ARROW AND THE ORDER READ THE SAME FACT. A header that computed its
//     own direction beside the one sortRows applies is a display that can
//     disagree with the rows underneath it.
{
  const doc = { fields: DEFAULT_FIELDS } as unknown as SpacesDoc
  const j = (v: unknown) => JSON.stringify(v)

  ok(j(cycleSort(undefined, 'status')) === j([{ key: 'status' }]),
    'the first click on a column sorts by it, ascending')
  ok(!Object.prototype.hasOwnProperty.call((cycleSort(undefined, 'status') ?? [])[0] ?? {}, 'dir'),
    "…and writes NO `dir`, because absent is what ascending has always meant")
  ok(j(cycleSort([{ key: 'status' }], 'status')) === j([{ key: 'status', dir: 'desc' }]),
    'the second click reverses it')
  ok(cycleSort([{ key: 'status', dir: 'desc' }], 'status') === undefined,
    'the third click returns to NO SORT — and says so with undefined, never an empty array')
  ok(j(cycleSort([{ key: 'status', dir: 'desc' }], 'priority')) === j([{ key: 'priority' }]),
    'clicking a DIFFERENT column starts that column fresh, ascending')

  // the byte-identity rule the whole format follows, proved on the block itself
  const block: Record<string, unknown> = { id: 'v', type: 'view', html: 'Issues' }
  const pristine = j(block)
  const write = (k: string) => {
    const next = cycleSort(block.sort, k)
    if (next === undefined) delete block.sort
    else block.sort = next
  }
  write('status'); write('status'); write('status')
  ok(j(block) === pristine,
    'a view sorted and unsorted from its header is BYTE-IDENTICAL to one nobody ever touched')

  // the arrow is the order, not a second opinion about it
  ok(sortDirOf(undefined, 'status') === undefined && sortDirOf('nonsense', 'status') === undefined,
    'a malformed sort points no arrow rather than throwing — it came out of a file someone sent you')
  ok(sortDirOf([{ key: 'status' }], 'status') === 'asc',
    'an entry with no direction reads as ascending, the way sortRows applies it')
  ok(sortDirOf([{ key: 'status' }], 'priority') === undefined,
    'and a column that is not the sort key carries no arrow')
  const rows2: IssueRow[] = [
    { page: { id: 'a', title: 'a', blocks: [] } as Page, values: new Map([['status', 'done']]) },
    { page: { id: 'b', title: 'b', blocks: [] } as Page, values: new Map([['status', 'backlog']]) },
  ]
  const desc = cycleSort(cycleSort(undefined, 'status'), 'status')
  ok(sortDirOf(desc, 'status') === 'desc'
    && sortRows(doc, rows2, desc).map((r) => r.page.id).join('') === 'ab',
    'the arrow the header shows and the order sortRows produces come from the one key')
}

// ---- the table's HEADERS and CELLS are controls, and only where there is an
// ---- editor ----------------------------------------------------------------
// Both are emitted by the ONE renderer, which also paints the reading view, a
// printout and a locked space. A control that escapes the editable guard is a
// button a reader can press and a shape on paper that means nothing.
{
  const fs = nodeFs
  const ren = fs.readFileSync(new URL('../spaces/src/render.ts', import.meta.url), 'utf8')
  const ed = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  const tbl = ren.slice(ren.indexOf("if (layout === 'table') {"), ren.indexOf("if (layout === 'list') {"))

  ok(/if \(opts\.editable\) \{[\s\S]{0,900}?sortB\.dataset\.sortCol/.test(tbl),
    'the sortable header is a control ONLY where there is an editor')
  ok(/if \(opts\.editable && f\) \{[\s\S]{0,600}?cell\.dataset\.cellPage/.test(tbl),
    '…and so is the editable cell')
  ok((tbl.match(/sortCol/g) ?? []).length === 1 && (tbl.match(/cellPage/g) ?? []).length === 1,
    'neither is created anywhere else in the table, where no guard would cover it')
  ok(/th\.setAttribute\('aria-sort'/.test(tbl),
    'the sort state reaches a screen reader as aria-sort, not only as an arrow glyph')

  // the page column: no sort control, because a view's sort names a FIELD and
  // sortRows cannot express a title. Pinned so nobody quietly invents a second
  // ordering mechanism to fill the gap.
  const first = tbl.slice(tbl.indexOf('const th0'), tbl.indexOf('hr.appendChild(th0)'))
    .replace(/^\s*\/\/[^\n]*$/gm, '')
  ok(!first.includes('sortCol') && !first.includes('button'),
    'the page-title column carries no sort control — a sort key is a field, and a title is not one')

  // a header click writes through the SAME editView every other view control
  // uses, so "no sort" deletes the key rather than storing an empty array
  ok(/data-sort-col[\s\S]{0,700}?cycleSort\([\s\S]{0,80}?\.sort, h\.dataset\.sortCol!\)/.test(ed)
    && /data-sort-col[\s\S]{0,700}?this\.editView\(/.test(ed),
    'a header click writes the view’s own sort through editView, which deletes rather than stores empty')

  // a cell writes through the one writer, so `value` and the readable `html`
  // can never fall out of step — and a page that lacks the field GAINS it, the
  // way a board drop already does
  ok(/private putField\(page: Page, f: FieldSpec, value: unknown\): void \{\s*const own = propBlockOf\(page, f\.key\)\s*if \(own\) this\.applyField\(own, f, value\)\s*else page\.blocks\.splice\(headerLength\(page\), 0, propBlock\(/.test(ed),
    'a cell edit on a page WITHOUT that field adds the prop block, with its readable html written by propBlock')
  ok(/private setCell\([\s\S]{0,900}?s\.commit\(\(\) => this\.putField\(page, f, value\)/.test(ed),
    'and every cell write goes through it, inside one commit')
  ok(/private setCell\([\s\S]{0,900}?if \(own && \(own as \{ value\?: unknown \}\)\.value === value\) return/.test(ed),
    'choosing the value a cell already holds commits NOTHING — not a step you press ⌘Z past')
  ok(/private setCell\([\s\S]{0,900}?const scope = pageId === s\.pageId \? 'page' : 'doc'/.test(ed),
    'a cell on ANOTHER page takes a document undo entry, or undo would restore the view and leave the value')

  // ONE picker. A cell that opened a picker of its own would be a second place
  // for the choosing to drift from the header strip's.
  ok((ed.match(/private fieldPicker\(/g) ?? []).length === 1
    && /this\.fieldPicker\(f, \(b as \{ value\?: unknown \}\)\.value, anchor, \(v\) => this\.setField\(blockId, v\)\)/.test(ed),
    'the header strip’s picker and the cell’s are the same picker over different writers')
  ok(/private openCellPicker\([\s\S]{0,800}?this\.fieldPicker\(f, own \? \(own as \{ value\?: unknown \}\)\.value : undefined, anchor/.test(ed),
    '…and a cell standing for a value that does not exist yet opens it with nothing selected')
}

// ---- what a board and a field EXPORT ---------------------------------------
// The readable `html` on a prop block is the whole reason the format degrades
// instead of vanishing. The exporter is its most important consumer and was the
// one place ignoring it.
{
  const propSpec = SPEC.get('prop')!
  const ctx = { titleOf: () => undefined, rowsOf: () => [] }
  const line = propSpec.toMd!(
    { id: 'b', type: 'prop', key: 'status', value: 'doing', html: 'Status: In progress' } as Block,
    'Status: In progress', '', ctx)[0]
  ok(line === '**Status:** In progress',
    `a field exports the words a reader can use, not the option id (got ${line})`)
  ok(!line.includes('doing'), '…and the raw value does not appear at all')

  // a schema whose label holds a colon, and a prop whose html is not the
  // expected shape: emitted whole rather than split at a guess
  const odd = propSpec.toMd!({ id: 'b', type: 'prop', key: 'k', value: 'v', html: 'plain' } as Block,
    'plain', '', ctx)[0]
  ok(odd === '**plain**', `an unexpected readable form is exported whole (got ${odd})`)

  const viewSpec = SPEC.get('view')!
  const md = viewSpec.toMd!({ id: 'v', type: 'view' } as Block, 'Issues', '', {
    titleOf: () => undefined,
    rowsOf: () => [
      { id: 'p1', title: 'First', group: 'Todo', fields: 'High' },
      { id: 'p2', title: 'Second', group: 'Todo', fields: '' },
      { id: 'p3', title: 'Third', group: 'Done', fields: '' },
    ],
  }).join('\n')
  ok(md.includes('[First](#p/p1)') && md.includes('[Third](#p/p3)'),
    'a board exports its ISSUES, each one a link back to its page')
  ok(md.includes('**Todo**') && md.includes('**Done**'), '…grouped as the board groups them')
  ok(md.indexOf('**Todo**') < md.indexOf('**Done**'), '…in the board\'s column order')
  ok(md.includes('[First](#p/p1) — High'), '…carrying the same chips the card shows')
  ok(viewSpec.toMd!({ id: 'v', type: 'view' } as Block, 'Issues', '', ctx).join('\n').includes('_No issues._'),
    'an empty board says so rather than exporting a bare heading')
}

// ---- ONE answer to "what is this nested under" ------------------------------
// The rule (DECISIONS 2026-08-03): a block's effective parent is `b.parent` iff
// that block is in the SAME page and appears STRICTLY EARLIER. It was
// implemented four times, differently — positional in render.ts, a hop-capped
// graph walk in blocks.ts, a fixed-point sweep in agent.ts, an id lookup in
// editor.indent — and they agreed only because the editor keeps the array in
// pre-order. Collaboration is precisely what breaks that: measured on the merge
// rig, 52.4% of merged documents violate it.
{
  const page = (blocks: unknown[]) => ({ id: 'p1', title: 'P', blocks } as Page)

  // the ordinary case
  const ok1 = page([{ id: 'a', type: 'p', html: '' }, { id: 'b', type: 'p', html: '', parent: 'a' }])
  ok(effectiveParents(ok1).get('b') === 'a', 'a child after its parent is nested under it')

  // the shapes a merge produces, and each resolves to the ROOT rather than
  // to something a renderer cannot draw
  const later = page([{ id: 'b', type: 'p', html: '', parent: 'a' }, { id: 'a', type: 'p', html: '' }])
  ok(effectiveParents(later).get('b') === undefined,
    'a parent that appears LATER is not a parent — this is the merge case')
  const absent = page([{ id: 'b', type: 'p', html: '', parent: 'gone' }])
  ok(effectiveParents(absent).get('b') === undefined, 'a parent that is absent is not a parent')
  const self = page([{ id: 'b', type: 'p', html: '', parent: 'b' }])
  ok(effectiveParents(self).get('b') === undefined, 'a block is not its own parent')

  // ACYCLIC BY CONSTRUCTION: a parent must be earlier, so no input can loop.
  // The two-cycle below is what two concurrent indents converge on.
  const cycle = page([
    { id: 'x', type: 'p', html: '', parent: 'y' },
    { id: 'y', type: 'p', html: '', parent: 'x' },
  ])
  const eff = effectiveParents(cycle)
  ok(eff.get('x') === undefined && eff.get('y') === 'x',
    'a merged cycle resolves to a tree, with no visited set and no hop cap')

  // descendantsOf must never return the node itself, which is what the old
  // fixed-point sweep did on a cycle — and planRemoveBlocks deletes what it
  // returns
  ok(!descendantsOf(cycle, 'x').has('x'), 'a subtree never contains its own root')
  ok(!descendantsOf(cycle, 'y').has('y'), '…from either end of the cycle')

  const deep = page([
    { id: 'a', type: 'p', html: '' },
    { id: 'b', type: 'p', html: '', parent: 'a' },
    { id: 'c', type: 'p', html: '', parent: 'b' },
    { id: 'd', type: 'p', html: '' },
  ])
  ok([...descendantsOf(deep, 'a')].sort().join(',') === 'b,c', 'a subtree reaches grandchildren')
  ok(descendantsOf(deep, 'd').size === 0, 'and stops at a leaf')

  // THE CONSUMERS AGREE, checked as source: four implementations was the bug
  const fs2 = await import('node:fs')
  const src = (f: string) => fs2.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')
  ok(/descendantsOf\(page, id\)/.test(src('agent.ts')),
    'agent.ts delegates rather than sweeping the graph itself')
  // scoped to the BLOCK sweep: planRemovePage still sweeps the PAGE graph, and
  // that one is out of this change's scope (it terminates, and cascading a
  // cyclic pair is what the caller asked for). Named so the next reader knows
  // the remaining sweep is deliberate rather than missed.
  ok(!/for \(const b of page\.blocks\)[\s\S]{0,200}grew = true/.test(src('agent.ts')),
    '…and its block-level fixed-point sweep is gone')
  ok(/effectiveParents/.test(src('blocks.ts')) && !/chain\.length < 32/.test(src('blocks.ts')),
    'blocks.ts walks the effective chain, and its hop cap is gone with the cycles')
  ok(/effectiveParents\(page\)/.test(src('editor.ts')),
    'editor.indent outdents through the effective parent')
  ok(/seen: Set<string>/.test(src('store.ts')),
    'Store.tree carries a visited set')
}


// ---- video and audio: the model, and the rule about autoplay ---------------
//
// The MEDIA block is one type with a `kind`, and the one thing about it that
// can never be got wrong is that nothing in this app starts playing by itself.
// A space has no surface that owns playback — an editor, a reading view, a
// printout and a file-manager still, and a clip that starts itself is wrong in
// all four. That rule is a pure function (blocks.ts mediaPlayback) precisely so
// it can be pinned here rather than asserted about one renderer that the next
// surface would have to rediscover.
{
  const spec = SPEC.get('media')
  ok(!!spec, 'there is a media block spec')
  ok(spec?.custom === true, 'media renders through its own case, not tag + inline host')
  ok(MENU_SPECS.some((s) => s.type === 'media'), 'and it is reachable from the / menu')
  ok(TAG_OF.media === 'div' && !LIST_OF.media, 'a clip is a block, not a list item')

  // init sets the kind that degrades usefully, and never clobbers one that is
  // already there — the same rule every other init follows (a bullet turned
  // into a to-do keeps a `done` someone ticked)
  const fresh: Block = { id: 'm1', type: 'media' }
  spec?.init?.(fresh)
  ok(fresh.kind === 'video', 'a fresh media block is a video until a file says otherwise')
  const already: Block = { id: 'm2', type: 'media', kind: 'audio' }
  spec?.init?.(already)
  ok(already.kind === 'audio', '…and init never overwrites a kind that is already set')

  // THE AUTOPLAY RULE. Stated three ways, because a file someone mailed you can
  // say anything and a future build may legitimately write this field.
  ok(mediaPlayback({ id: 'x', type: 'media' }).autoplay === false,
    'playback never autoplays by default')
  ok(mediaPlayback({ id: 'x', type: 'media', autoplay: true }).autoplay === false,
    'a block that ASKS to autoplay still does not — the field round-trips, it is not obeyed')
  ok(mediaPlayback({ id: 'x', type: 'media', autoplay: true, kind: 'audio', loop: true }).autoplay === false,
    '…and no combination of the other flags unlocks it')

  // the flags that ARE honoured, and their defaults
  ok(mediaPlayback({ id: 'x', type: 'media' }).controls === true,
    'controls are shown unless the document says otherwise — a player with none is a rectangle')
  ok(mediaPlayback({ id: 'x', type: 'media', controls: false }).controls === false,
    'and controls: false is honoured')
  const flags = mediaPlayback({ id: 'x', type: 'media', loop: true, muted: true })
  ok(flags.loop === true && flags.muted === true, 'loop and muted are plain author choices')
  ok(mediaPlayback({ id: 'x', type: 'media', kind: 'audio' }).kind === 'audio', 'kind audio is audio')
  ok(mediaPlayback({ id: 'x', type: 'media', kind: 'holo-tape' }).kind === 'video',
    'a kind from a newer build degrades to video, which plays an audio file anyway')

  // MARKDOWN HAS NO VIDEO. A link is the one form correct in every renderer;
  // `![](clip.mp4)` is image syntax and draws a broken-image glyph everywhere.
  const md = (b: Block): string =>
    (SPEC.get('media')!.toMd!(b, '', '', { titleOf: () => undefined, rowsOf: () => [] })).join('\n')
  ok(md({ id: 'x', type: 'media', src: 'asset:k1' }) === '[Video](asset:k1)',
    'a clip exports as a markdown LINK, not as an image')
  ok(md({ id: 'x', type: 'media', kind: 'audio', src: 'https://h/x.mp3' }) === '[Audio](https://h/x.mp3)',
    '…named for what it is')
  ok(md({ id: 'x', type: 'media', src: 'asset:k1', alt: 'The demo' }) === '[The demo](asset:k1)',
    '…using alt as the label when there is one, exactly as the image exporter does')
  ok(md({ id: 'x', type: 'media' }) === '_Video_',
    'and a block with no source yet exports as a word, never as an empty link')

  // ADDITIVITY: every playback field survives a round trip untouched, including
  // the one this build refuses to obey. There is no server to migrate a file.
  const round = parseDoc(JSON.stringify({
    format: FORMAT, version: 1, docId: 'd1', title: 'T',
    pages: [{ id: 'p1', title: 'One', blocks: [{
      id: 'b1', type: 'media', kind: 'audio', src: 'asset:k',
      autoplay: true, loop: true, muted: true, controls: false,
      poster: 'asset:p', captions: 'asset:vtt',
    }] }],
  }))
  const back = round.ok ? round.doc.pages[0].blocks[0] : undefined
  ok(back?.autoplay === true, 'autoplay survives the round trip even though nothing reads it')
  ok(back?.poster === 'asset:p' && (back as Record<string, unknown>)?.captions === 'asset:vtt',
    '…as does a field this build has never heard of')
}

// ---- the surfaces obey the rule, checked as SOURCE -------------------------
//
// mediaPlayback cannot return autoplay:true, but a renderer could still set the
// attribute by hand, and the whole point of the field being in the format is
// that someone later will be tempted to. These are the two files that draw a
// clip; a node rig cannot run them (they need a DOM), so they are read.
{
  const fs3 = await import('node:fs')
  const src = (f: string) => fs3.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')
  const render = src('render.ts')
  ok(/mediaPlayback/.test(render), 'render.ts asks the registry what it may apply')
  ok(!/\.autoplay\s*=/.test(render) && !/autoplay\s*=\s*['"]/.test(render),
    'render.ts never sets autoplay — on any element, by any spelling')
  ok(/opts\.printing[\s\S]{0,400}mediaStill/.test(render),
    'paper and thumbnails get a still, and the branch is BEFORE any player is built')
  ok(/preload\s*=\s*'metadata'/.test(render),
    'a clip fetches metadata, never the whole file, for a page nobody pressed play on')
  // the remote gate is the image gate, and a clip needs it MORE: a <video> asks
  // its host for byte ranges the moment it is parsed
  ok(/loadsRemotely\(rawSrc, doc\)[\s\S]{0,200}remotePlaceholder/.test(render),
    'a linked clip is not loaded until the reader agrees, naming the host')

  const preview = src('preview.ts')
  ok(/video,audio/.test(preview),
    'the file-manager still bans player tags outright, as defence in depth')

  // `src` is not inline html, so it never passes through sanitize.ts — the URL
  // box is the only gate between a typed `javascript:` and an element attribute
  const editor = src('editor.ts')
  ok(/\^https\?:/.test(editor),
    'the clip URL box allowlists http(s) rather than blocklisting javascript:')
}

// ---- HOW WIDE A PAGE IS, and whose business that is ------------------------
// The per-page control answered "this page needs the room". It did not answer
// "I have a wide screen", and making somebody set a width on every page in a
// space to say so is the wrong shape of work. MEASURED at a 2560px viewport
// before this: a 720px column using 31% of the area, 1,591px of it empty.
//
// So there are two settings, and the split is the point: the PAGE says what it
// needs (document data, travels with the file), the READER says what their
// screen is (viewer data, localStorage, never written to the file) — the same
// rule locale and reduced motion already follow.
{
  const render = nodeFs.readFileSync(new URL('../spaces/src/render.ts', import.meta.url), 'utf8')
  const editor = nodeFs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')

  ok(/readerWidth\?: 'wide' \| 'full'/.test(render), 'the renderer takes a reader width')
  ok(/page\.width === undefined \? \(opts\.readerWidth \?\? auto\)/.test(render),
    'the PAGE wins over the reader, and the reader wins over the board default')
  // The cap moved from PIXELS to CHARACTERS, and that is the assertion worth
  // having: a px cap does not hold a line length. Capped at measure x 1.25 =
  // 900px, a 5120px screen rendered 110 characters — past the range this very
  // comment claimed to enforce. In `ch` it is ~94 at every width, because `ch`
  // scales with the reading size and the reading size is what grows.
  ok(/min\(75ch, max\(\$\{m\}px, 42vw\)\)/.test(render),
    'the column is capped in CHARACTERS, so a wide screen buys bigger type rather than a longer line')
  const cssSrc = (await import('node:fs')).readFileSync(
    new URL('../spaces/src/styles.css', import.meta.url), 'utf8')
  ok(/--sp-read: clamp\(16px,/.test(cssSrc),
    'and the reading size grows with the viewport from a PX floor')
  ok(/@media print[\s\S]{0,400}--sp-read: 16px/.test(cssSrc),
    '…but paper is pinned: a document must not set larger because the window was wide')

  ok(/localStorage\.getItem\('bento-sp-width'\)/.test(editor),
    "the reader's width is viewer state, in localStorage beside the language")
  ok(!/theme\.width|doc\.width|\.width = readerWidth/.test(editor),
    '…and is NEVER written into the document')

  // PRINT MUST NOT INHERIT IT. Paper has a fixed width; the size of the
  // monitor somebody happens to be sitting at is not a fact about the page
  // they are printing.
  const printCall = editor.slice(editor.indexOf('printing: true'))
  ok(!/readerWidth/.test(printCall.slice(0, 400)),
    'the print path does not take the reader width')
}

// ---- LINK CARDS point outward, and never reach outward ----------------------
// A link card in Notion or Slack is a server fetching a url for its OpenGraph
// tags. bento/spaces has no server and must not phone home (PLATFORM §1;
// DECISIONS 2026-08-03), so every field is stored and the card is resolved from
// the file alone. The three things that can fail SILENTLY here — a hostile url
// becoming clickable, a remote thumbnail becoming a request on open, and an
// empty card becoming an empty box — are each pinned below.
{
  const card = (over: Record<string, unknown>): Block => ({ id: 'l1', type: 'link', ...over })

  // --- the url allowlist, on the raw string --------------------------------
  ok(externalHref('https://example.com/a') === 'https://example.com/a', 'an https url is a link')
  ok(externalHref('http://example.com') === 'http://example.com', '…so is http')
  ok(externalHref('MAILTO:a@b.c') === 'MAILTO:a@b.c', '…and mailto, whatever its case')
  ok(externalHref('  https://example.com  ') === 'https://example.com', 'surrounding space is trimmed, not rejected')
  for (const hostile of [
    'javascript:alert(1)',
    ' javascript:alert(1)',
    '\tjavascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'ja\tvascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'blob:https://example.com/x',
    '//evil.example/x',
    '/relative/path',
    '#p/p1',
  ]) {
    ok(externalHref(hostile) === '', `"${hostile.slice(0, 22)}" never becomes a clickable link`)
  }
  ok(externalHref(undefined) === '' && externalHref(42) === '', 'a non-string url is not a link either')

  // --- graceful degradation: an empty field is never an empty box ----------
  const bare = linkCard(card({ url: 'https://example.com/docs' }))
  ok(bare.title === 'https://example.com/docs', 'a card with no title falls back to its url')
  ok(bare.site === 'example.com', '…and derives its site from the host, with no lookup')
  ok(linkCard(card({ url: 'https://www.example.com/x' })).site === 'example.com', 'a www. prefix is dropped')
  ok(linkCard(card({ url: 'https://a.b/x', site: ' Acme ' })).site === 'Acme', 'a stored site name wins over the host')
  const empty = linkCard(card({}))
  ok(empty.url === '' && empty.title === '' && empty.site === '',
    'a card with nothing in it resolves to nothing — the renderer draws a dead card, not an <a> to nowhere')
  const hostileCard = linkCard(card({ url: 'javascript:alert(1)', title: 'Click me' }))
  ok(hostileCard.url === '' && hostileCard.title === 'Click me',
    'a hostile url loses its link and KEEPS its title — the card degrades, it does not vanish')
  ok(linkCard(card({ icon: '🙂'.repeat(40) })).icon.length <= 8,
    'a 400-character "emoji" out of a mailed file cannot blow out the card')

  // --- NO NETWORK AT RENDER: the thumbnail ---------------------------------
  // The gate is here, in a pure function, rather than in the renderer, because
  // a check that lives in one of four rendering surfaces is a check that will
  // be missed in the fifth.
  for (const remote of [
    'https://tracker.example/pixel.png',
    'http://tracker.example/pixel.png',
    '//tracker.example/pixel.png',
    '/attachments/local.png',
    'blob:https://example.com/abc',
    'filesystem:https://example.com/x',
  ]) {
    ok(linkCard(card({ url: 'https://a.b', image: remote })).image === '',
      `a card's remote image (${remote.slice(0, 26)}) is DROPPED, so rendering it makes no request`)
  }
  ok(linkCard(card({ image: 'asset:k1' })).image === 'asset:k1', 'an interned asset thumbnail is kept')
  ok(linkCard(card({ image: 'data:image/webp;base64,AA' })).image.startsWith('data:'), '…and so are embedded bytes')

  // --- the html fallback an older build renders ----------------------------
  const html = linkCardHtml(linkCard(card({ url: 'https://a.b/x', title: 'Docs', desc: 'The manual' })))
  ok(html === '<a href="https://a.b/x">Docs</a> — The manual',
    'the readable form is a plain inline link, so a build predating this type still shows one')
  // The fallback link has to SURVIVE the inline sanitizer, which is what
  // re-reads it on the next edit. sanitize.ts's own comment names the hazard: an
  // href written under a permissive build gets stripped by a stricter later one,
  // silently. So the two allowlists are cross-checked against each other rather
  // than trusted to stay in step by eye. (sanitizeInline itself needs a DOM and
  // is exercised in the browser, not here.)
  const fs3 = await import('node:fs')
  const ssrc = fs3.readFileSync(new URL('../spaces/src/sanitize.ts', import.meta.url), 'utf8')
  const inlineOk = new RegExp(/const HREF_OK = (\/.+\/)i/.exec(ssrc)![1].slice(1, -1), 'i')
  for (const u of ['https://a.b/x', 'http://a.b/x', 'mailto:a@b.c', 'MAILTO:A@B.C']) {
    ok(externalHref(u) !== '' && inlineOk.test(u),
      `"${u}" is accepted by BOTH allowlists, so the html fallback keeps its link`)
  }
  ok(!linkCardHtml(linkCard(card({ url: 'javascript:alert(1)', title: 'x' }))).includes('javascript'),
    'a hostile url never reaches the html fallback either')
  ok(linkCardHtml(linkCard(card({ title: '<b>hi</b>' }))) === '&lt;b&gt;hi&lt;/b&gt;',
    'a title is escaped, not interpreted — these fields are untrusted input')

  // --- markdown: a link card is a link -------------------------------------
  const linkSpec = SPEC.get('link')!
  const md = (b: Block) => linkSpec.toMd!(b, '', '', { titleOf: () => undefined, rowsOf: () => [] }).join('\n')
  ok(md(card({ url: 'https://a.b/x', title: 'Docs' })) === '[Docs](https://a.b/x)',
    'a link card exports as a markdown link')
  ok(md(card({ url: 'https://a.b/x', title: 'Docs', desc: 'The manual' })) === '[Docs](https://a.b/x) — The manual',
    '…with its description alongside')
  ok(md(card({ url: 'https://a.b/x' })) === '[https://a.b/x](https://a.b/x)',
    'an untitled card exports the url as its own label, never an empty link text')
  ok(md(card({ url: 'https://a.b/x', title: 'A [thing]' })) === '[A \\[thing\\]](https://a.b/x)',
    'brackets in a title are escaped, or they end the link early')
  ok(md(card({ url: 'https://a.b/a (1)', title: 'T' })) === '[T](<https://a.b/a (1)>)',
    'a url holding a space or a bracket takes the angle form')
  ok(md(card({ title: 'Just words', desc: 'no url' })) === 'Just words — no url',
    'a card that is not clickable does not export as something a reader will click')

  // --- and the renderer really is on that path ------------------------------
  const rsrc = fs3.readFileSync(new URL('../spaces/src/render.ts', import.meta.url), 'utf8')
  ok(!/\bfetch\s*\(|XMLHttpRequest|new Image\s*\(|navigator\.sendBeacon/.test(rsrc),
    'render.ts contains no fetch, no XHR and no image preloader — the render path cannot reach the network')
  const linkCase = rsrc.slice(rsrc.indexOf("case 'link':"), rsrc.indexOf("case 'todo':"))
  ok(linkCase.length > 200, 'the link case was found in render.ts')
  ok(/img\.src = resolveSrc\(c\.image, doc\)/.test(linkCase),
    "…and its only img src comes from linkCard's already-filtered image, never from the raw block")
  ok(!/b\.image|b\.url/.test(linkCase),
    '…so the renderer never reads a card field around the gate')
}

// ---- 8. review comments ----------------------------------------------------
// Two properties, and both of them fail silently. A thread is DOCUMENT DATA
// that no build before this one has heard of, so it has to survive a build
// that does not understand it; and it is EDITOR-ONLY, so it must never reach
// the reading view or a printed handbook — a private remark on somebody's
// draft, printed into the copy they hand a customer, is not a cosmetic bug.
{
  const withComments = doc({
    pages: [{
      id: 'p1', title: 'One',
      comments: [{ id: 'c0', author: 'Ada', at: '2026-08-20T09:00:00Z', text: 'about the page' }],
      blocks: [{
        id: 'b1', type: 'p', html: 'hi',
        comments: [
          { id: 'c1', author: 'Ada', at: '2026-08-20T10:00:00Z', text: 'open one', mood: 'from a later build' },
          { id: 'c2', author: 'Bo', at: '2026-08-20T11:00:00Z', text: 'settled', resolved: true },
        ],
      }],
    }],
  })
  const r = parseDoc(withComments)
  ok(r.ok === true, 'a document carrying comments parses')
  const page = (r as { doc: SpacesDoc }).doc.pages[0]
  ok(JSON.stringify(page.comments) === JSON.stringify(JSON.parse(withComments).pages[0].comments),
    'a page thread round-trips byte-for-byte')
  ok((page.blocks[0].comments as Array<{ mood?: string }>)[0].mood === 'from a later build',
    'and an unknown field INSIDE a comment survives too (PLATFORM §3)')

  const at = commentsOn(page)
  ok(at.length === 3, 'commentsOn reads both anchors')
  ok(at[0].blockId === undefined && at[0].comment.id === 'c0',
    'the page thread comes first, with no block id — that IS the anchor')
  ok(at[1].blockId === 'b1' && at[2].blockId === 'b1', 'block threads carry the block they are on')
  ok(unresolvedOn(page) === 2, 'the badge counts what is still open, not what has been settled')

  // this data arrives in a file somebody mailed you
  const hostile = { id: 'h', title: 'H', comments: 'yes', blocks: [
    { id: 'hb', type: 'p', html: '', comments: [null, { noId: 1 }, { id: 'k', author: 'A', at: '', text: 'x' }] },
  ] } as unknown as Page
  ok(commentsOn(hostile).length === 1 && commentsOn(hostile)[0].comment.id === 'k',
    'a comments field that is not an array, and entries with no id, are ignored rather than iterated')
  ok(unresolvedOn(hostile) === 1, 'and the count agrees with the list')

  // EDITOR-ONLY, as source. The behaviour needs a DOM and a print dialog; the
  // mistake is made in the source, which is where the model rig checks the
  // other four properties of this shape.
  const fs3 = await import('node:fs')
  const spSrc = (f: string) => fs3.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')
  // `comments` as a PROPERTY or a class, not the word — render.ts's own prose
  // discusses html comments, and a gate that trips on its documentation gets
  // deleted rather than fixed.
  ok(!/\.comments\b|\bsp-cm-/.test(spSrc('render.ts')),
    'render.ts — the ONE renderer behind the editor, the reading view and print — never reads a thread')
  ok(/if \(!this\.reading\) this\.comments\?\.refresh\(\)/.test(spSrc('editor.ts')),
    'the editor paints markers only when it is not in the reading view')
  ok(/@media print \{ \.sp-cm-mark, \.sp-cm-row \{ display: none/.test(spSrc('styles.css')),
    'and the print sheet drops them even if a future path paints them anyway')
  // PLAIN TEXT, and the sanitizer discipline that follows from it: there is
  // nothing to sanitize because nothing is ever parsed as html.
  ok(!/innerHTML/.test(spSrc('comments.ts')),
    'no comment text ever reaches innerHTML — it is written with textContent')
}

// ---- 12. the portability round trip ----------------------------------------
//
// A page LEAVES as its own space, and a space ARRIVES inside another one. Both
// directions move ids, links and images between documents, and every way they
// can go wrong is silent: an id that collides makes two pages one node, a link
// that is not repointed either dies or — worse — lands on a STRANGER page that
// happens to hold that id, and a credential that rides along in an extract
// hands over the whole space it came from.
//
// So this is a real round trip: extract a subtree out of one space, import it
// into a DIFFERENT space that deliberately collides with it on every id and on
// an asset key, and assert on what came out. (The remaining property — that
// the import is ONE undo step — needs the real Store, which imports './model'
// extensionless; it is asserted in scripts/test-spaces-undo.ts, which is
// bundled.)
{
  const IMG_A = 'data:image/png;base64,AAAA'
  const IMG_B = 'data:image/png;base64,BBBB'
  const source: SpacesDoc = JSON.parse(JSON.stringify({
    format: FORMAT, version: 1, docId: 'doc-source', title: 'Whole space',
    home: 'p-root', theme: {},
    // a future build's field, at the top level and on a page: additivity is
    // not suspended because a document is being cut in half
    futureThing: { keep: 'me' },
    assets: { imgA: IMG_A, imgB: IMG_B },
    collab: {
      room: 'w-room', key: 'read-cap', on: true,
      writerPub: 'WP', writerPriv: 'WS', owner: 'OP', ownerPriv: 'OS',
      invite: { pub: 'IP', priv: 'IS', role: 'writer', sig: 'SIG' },
      sync: { v: 2 },
    },
    pages: [
      { id: 'p-root', title: 'Handbook', futurePageField: 7, blocks: [
        { id: 'b-1', type: 'p', html: 'see <a href="#p/p-kid">the kid</a> and <a href="#p/p-away">Elsewhere</a>' },
      ] },
      { id: 'p-kid', title: 'Kid', parent: 'p-root', blocks: [
        { id: 'b-2', type: 'image', src: 'asset:imgA', alt: 'a picture' },
        { id: 'b-3', type: 'pagelink', page: 'p-away' },
        { id: 'b-4', type: 'kanban', html: 'a type this build has never heard of' },
      ] },
      { id: 'p-away', title: 'Elsewhere', blocks: [
        { id: 'b-5', type: 'image', src: 'asset:imgB' },
      ] },
    ],
  }))

  ok(subtreeIds(source, 'p-root').join(',') === 'p-root,p-kid',
    'a subtree is the page and its descendants, in document order')
  ok(subtreeIds(source, 'p-root', false).join(',') === 'p-root',
    '…and just the page when the subtree is not asked for')

  const cut = extractSpace(source, 'p-root', { docId: 'doc-extract', now: '2026-08-22T00:00:00.000Z' })
  const out = cut.doc

  // IDENTITY. A fork joins the room it forked from; an extract must not.
  ok(out.docId === 'doc-extract' && out.docId !== source.docId,
    'the extract carries a FRESH docId, so it is a new document and not a fork')
  ok(out.collab === undefined,
    'and no collaboration credentials at all — the room, the read key and every private key')
  ok(!JSON.stringify(out).includes('WS') && !JSON.stringify(out).includes('OS') &&
     !JSON.stringify(out).includes('read-cap'),
    'no writer, owner or invite secret survives anywhere in the bytes')

  // WHAT TRAVELLED.
  ok(out.pages.map((p) => p.id).join(',') === 'p-root,p-kid', 'the subtree travelled, and nothing else')
  ok(out.home === 'p-root' && out.pages.some((p) => p.id === out.home),
    'doc.home names a page that exists in the new file')
  ok(out.pages[0].parent === undefined, 'the root of the extract is a root page')
  ok(out.title === 'Handbook', 'the new space is named after the page it was cut from')

  // LINKS. Out of the set is not left dangling and not silently unlinked.
  const rootHtml = out.pages[0].blocks[0].html ?? ''
  ok(rootHtml.includes('href="#p/p-kid"'), 'a link INSIDE the extract still resolves')
  ok(!rootHtml.includes('#p/p-away') && rootHtml.includes('[[Elsewhere]]'),
    'a link OUT of it becomes the literal [[Elsewhere]] — text that still says what it meant')
  const kid = out.pages[1]
  ok(kid.blocks[1].type === 'p' && !('page' in kid.blocks[1]) &&
     (kid.blocks[1].html ?? '').includes('[[Elsewhere]]'),
    'a pagelink whose target stayed behind becomes the same honest text')
  ok(cut.stats.unlinked === 2, 'and both are counted for the report')

  // ASSETS. An extract that carries the whole document is a copy.
  ok(Object.keys(out.assets ?? {}).join(',') === 'imgA',
    'only the images the extracted pages reference travel')

  // ADDITIVITY, in both halves.
  ok((out as Record<string, unknown>).futureThing !== undefined &&
     (out.pages[0] as Record<string, unknown>).futurePageField === 7,
    'unknown top-level and per-page fields survive the extract untouched')
  ok(kid.blocks[2].type === 'kanban', 'an unknown block type travels as itself')

  // The extract must be a document this app can OPEN — the load contract, not
  // an approximation of it.
  const reread = parseDoc(JSON.stringify(out))
  ok(reread.ok === true, 'the extracted document parses as a bento/spaces file')
  ok(reread.ok === true && reread.repaired.length === 0,
    '…with no ids to repair: the extract is internally consistent')

  // ---- and back IN, to a space that collides on everything ----------------
  const hostDoc: SpacesDoc = JSON.parse(JSON.stringify({
    format: FORMAT, version: 1, docId: 'doc-host', title: 'Somewhere else',
    home: 'p-root', theme: {},
    // the SAME key holding DIFFERENT bytes: a content-addressed store cannot
    // produce this, a hand-written file can, and trusting the key would replace
    // the host's picture with the visitor's
    assets: { imgA: 'data:image/png;base64,ZZZZ' },
    pages: [
      { id: 'p-root', title: 'Host root', blocks: [{ id: 'b-1', type: 'p', html: 'mine' }] },
      { id: 'p-target', title: 'Put it here', blocks: [{ id: 'b-9', type: 'p', html: '' }] },
    ],
  }))

  const plan = planGraft(hostDoc, out, { under: 'p-target' })

  // IDS. Unique across the WHOLE merged document, and never reused.
  const merged = [...hostDoc.pages, ...plan.pages]
  const allIds = merged.flatMap((p) => [p.id, ...p.blocks.map((b) => b.id)])
  ok(new Set(allIds).size === allIds.length, 'NO ID COLLISION: every id in the merged document is unique')
  ok(plan.stats.renamed === 2, 'the two ids this space already used were renamed, and only those')
  ok(plan.pages[1].id === 'p-kid' && plan.pages[1].blocks[0].id === 'b-2',
    'ids that did NOT collide are kept, so links and node keys outside the collision survive')

  // …and deterministically, from the bytes: two readers of one file agree.
  const again = planGraft(hostDoc, JSON.parse(JSON.stringify(out)), { under: 'p-target' })
  ok(JSON.stringify(again.pages) === JSON.stringify(plan.pages),
    'the same import planned twice produces the same ids (derived from the bytes, never Math.random)')

  // LINKS. Nothing arrives pre-broken, and nothing points at a stranger.
  const pageIds = new Set(merged.map((p) => p.id))
  const dangling: string[] = []
  for (const p of plan.pages) {
    for (const b of p.blocks) {
      for (const m of (b.html ?? '').matchAll(/href="#p\/([^"]+)"/g)) {
        if (!pageIds.has(m[1])) dangling.push(m[1])
      }
    }
  }
  ok(dangling.length === 0, `NO DANGLING LINK: every #p/ target in the import resolves (${dangling.join(',') || 'none'})`)
  const grafted = plan.pages[0].blocks[0].html ?? ''
  ok(grafted.includes(`href="#p/${plan.pages[1].id}"`),
    'the internal link followed the rename rather than pointing at the HOST page that took its id')
  ok(!grafted.includes('href="#p/p-root"'),
    '…and specifically does not point at the host page it collided with')
  ok((plan.pages[1].blocks[1].html ?? '').includes('[[Elsewhere]]'),
    'text left by the extract stays text — an import invents no links')

  // WHERE IT LANDED.
  ok(plan.pages[0].parent === 'p-target', 'the import nests under the page that was chosen')
  ok(plan.pages[1].parent === plan.pages[0].id, 'and its own tree is preserved inside that')

  // ASSETS. Merged without collision, and without duplicating what is shared.
  ok(plan.assets['imgA'] === undefined && plan.assets['imgA~1'] === IMG_A,
    'a key clash with DIFFERENT bytes mints a variant rather than overwriting the host image')
  ok((plan.pages[1].blocks[0].src) === 'asset:imgA~1',
    '…and the block that referenced it now points at the variant')
  ok(hostDoc.assets!['imgA'] === 'data:image/png;base64,ZZZZ',
    'the host keeps its own bytes: planGraft mutates nothing it was handed')

  const shared: SpacesDoc = JSON.parse(JSON.stringify(hostDoc))
  shared.assets = { imgA: IMG_A }
  const dedupe = planGraft(shared, out, {})
  ok(Object.keys(dedupe.assets).length === 0 && dedupe.pages[1].blocks[0].src === 'asset:imgA',
    'the SAME image already in the host is reused, not stored twice — content addressing does the work')

  // ADDITIVITY survives the second leg too.
  ok((plan.pages[0] as Record<string, unknown>).futurePageField === 7 &&
     plan.pages[1].blocks[2].type === 'kanban',
    'unknown fields and unknown block types survive the import as well')

  // The merged document is one this app can open.
  const mergedDoc = { ...hostDoc, pages: merged, assets: { ...hostDoc.assets, ...plan.assets } }
  const rr = parseDoc(JSON.stringify(mergedDoc))
  ok(rr.ok === true && rr.repaired.length === 0,
    'the merged document parses with NOTHING to repair — the import needed no rescue')
}
// ---- A BARE-KEY SHORTCUT MUST NOT EAT A CHARACTER ---------------------------
// `[` collapses the page list. It was unguarded, and the text path that would
// have claimed the key first sits ~90 lines BELOW it — so every `[` typed in a
// block was preventDefault()ed into a sidebar toggle. `[[` is how this app
// makes links and is what the starter space tells you to type; it could not be
// typed at all. Shipped since #237, found while building the properties panel.
{
  const fs = await import('node:fs')
  const ed = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')

  ok(/if \(!mod && e\.key === '\[' && !isTyping\(\)\)/.test(ed),
    'the bare `[` shortcut is guarded by whether text is being edited')
  ok(/if \(!mod && e\.key === '\]' && !isTyping\(\)\)/.test(ed),
    "…and so is `]`, which arrived with the properties panel")
  ok(/function isTyping\(\): boolean/.test(ed), 'and that guard exists')
  ok((ed.match(/function isTyping\(\): boolean/g) ?? []).length === 1 &&
     !/editingText/.test(ed.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    'exactly ONE guard, not one per shortcut — two answers to one question drift')
  ok(/a\.isContentEditable/.test(ed) && /a\.tagName === 'SELECT'/.test(ed),
    '…covering contenteditable, inputs, textareas and selects alike')

  // the general rule, so the next bare-key shortcut cannot reintroduce this:
  // every unmodified single-character binding in onKey must ask the guard.
  const onKey = ed.slice(ed.indexOf('private onKey('), ed.indexOf('private onKey(') + 4000)
  // NB the tail is captured up to the line end, not up to the first ')': the
  // guard's own parentheses are inside it, and a lazier pattern silently
  // matched nothing and failed its own assertion.
  const bare = [...onKey.matchAll(/if \(!mod && e\.key === '(.)'(.*)$/gm)]
  for (const m of bare) {
    ok(/isTyping/.test(m[2]),
      `the bare \`${m[1]}\` binding asks isTyping() before it swallows the key`)
  }
  ok(bare.length > 0, 'and there is at least one such binding to check')
}


// ---- THE PROPERTIES PANEL COSTS NOTHING UNTIL IT IS ASKED FOR ---------------
// The wide-page work one commit earlier gave the reading column the window's
// slack. A right-hand panel is the obvious way to undo that: 280px held open on
// every screen, forever, for settings most readers change once a month. So the
// panel's DEFAULT-CLOSED and its zero-cost-while-closed geometry are pinned
// here rather than left to whoever next edits the stylesheet.
//
// This is a SOURCE scan, deliberately. There is no DOM in node, so the honest
// thing to assert is the two rules the browser then follows — what the stored
// preference has to say before the panel opens, and what the closed panel
// contributes to the flex row — rather than a mock that would agree with
// whatever it was written beside.
{
  const props = fsTable('props.ts')
  const editor = fsTable('editor.ts')
  const css = fsTable('styles.css')

  // 1. CLOSED UNLESS THIS READER OPENED IT. The field initialises to true and
  //    only the explicit '0' — written by toggleInsp — opens it, so an absent
  //    key (a fresh file, a new browser, a locked-down origin that threw)
  //    means closed.
  ok(/private inspClosed = true/.test(editor),
    'the properties panel is CLOSED by default')
  ok(/localStorage\.getItem\('bento-sp-insp-closed'\) !== '0'/.test(editor),
    "…and only an explicit '0' opens it, so an absent preference is still closed")
  ok(/localStorage\.setItem\('bento-sp-insp-closed'/.test(editor),
    'the open/closed state PERSISTS, so it is chosen once and not every session')

  // 2. WHILE CLOSED IT TAKES NO WIDTH. `.sp-main` is `flex: 1 1 auto`, so a
  //    closed panel that zeroes its basis, its inline padding and its border is
  //    a panel the reading column cannot feel. Any one of the three left in
  //    place is width off the page on every screen.
  const shut = css.slice(css.indexOf('.sp-insp.sp-pane-closed'))
  const rule = shut.slice(0, shut.indexOf('}') + 1)
  ok(/flex-basis:\s*0/.test(rule), 'a closed properties panel has flex-basis 0')
  ok(/padding-inline:\s*0/.test(rule), '…no inline padding')
  ok(/border-inline-start-width:\s*0/.test(rule), '…and no border')
  ok(/\.sp-main \{\s*\n?\s*flex: 1 1 auto/.test(css),
    'the reading column is flex:1 1 auto, so the width a closed panel gives up goes back to it')

  // 3. THE PANEL IS THE READER'S, NEVER THE DOCUMENT'S — the same rule the page
  //    list's width, the language and the reader width already follow. A panel
  //    state written into the file would arrive open in somebody else's copy.
  ok(!/doc\.(insp|panel)|theme\.(insp|panel)/.test(editor + props),
    'nothing about the panel is written into the document')

  // 4. BELOW THE DRAWER BREAKPOINT IT IS AN OVERLAY, not a third column — the
  //    bargain the page list already makes at the same 820px.
  const phone = css.slice(css.indexOf('@media (max-width: 820px) {\n  .sp-insp-rz'))
  ok(/\.sp-insp \{ display: none; \}/.test(phone.slice(0, 400)),
    'below 820px the panel is absent until asked for')
  ok(/\.sp-insp\.sp-open \{[^}]*position: fixed/.test(phone.slice(0, 800)),
    '…and then it is a fixed overlay, never a column')

  // 5. THE ACCORDION IS SLIDES', including the persisted-per-title open state,
  //    so a section added below is collapsible without anyone remembering.
  ok(/querySelectorAll<HTMLElement>\('\.sp-insp-sec'\)/.test(props) &&
     /localStorage\.setItem\(OPEN_KEY/.test(props),
    'sections collapse and their open state is remembered per title')

  // 6. ONE CHANGE IS ONE UNDO STEP. Every control commits through one helper
  //    that wraps a single `store.commit`, and every text field commits on
  //    `change` rather than on `input` — an undo entry per keystroke is what
  //    `input` would buy.
  ok(/private commit\(id: string, fn: \(b: Block\) => void\): void \{[\s\S]{0,300}?s\.commit\(/.test(props),
    'block edits go through ONE store.commit')
  ok(!/addEventListener\('input'/.test(props),
    'no control commits on every keystroke')

  // 7. IT DOES NOT REPLACE THE SURFACES IT DUPLICATES. The chip on a callout
  //    and the language chip on a code block are still the fast route; a panel
  //    that justified itself by removing them would be a worse editor.
  ok(/sp-callout-chip/.test(editor) && /sp-langchip/.test(editor),
    'the block chips survive the panel')
}

// ---------------------------------------------------------------------------
// INLINE MARKS — the canonical form, and the cases that go wrong quietly.
//
// The mark engine is a pure function over (inline html, plain-text offsets) so
// that it can be pinned HERE rather than only in a browser. The
// partial-selection group is the one that silently produced plausible garbage
// in every naive implementation of this: half a bold run, unbolded, either
// takes the whole run with it or does nothing, and for one character both look
// fine.
{
  // ---- canonical form ----------------------------------------------------
  // ONE nesting order, whatever order the tags arrived in. Two spellings of
  // the same visible text is a conflict in every diff and every CRDT merge.
  ok(canonicalMarks('<b><i>x</i></b>') === '<strong><em>x</em></strong>',
    'b/i fold to strong/em, the spelling the markdown importer already emits')
  ok(canonicalMarks('<i><b>x</b></i>') === canonicalMarks('<b><i>x</i></b>'),
    'the SAME html whichever way round the author nested it')
  ok(canonicalMarks('<code><em><strong>q</strong></em></code>') === '<strong><em><code>q</code></em></strong>',
    'the order is a > mark > strong > em > u > s > sub > sup > code, outermost first')
  ok(canonicalMarks('<b>a</b><b>b</b><b>c</b>') === '<strong>abc</strong>',
    'adjacent identical runs coalesce all the way, not one pass deep')
  ok(canonicalMarks('<b></b>hi<span>there</span>') === 'hithere',
    'empty runs and attribute-less spans are debris, not content')
  ok(canonicalMarks(canonicalMarks('<i><b>x</b></i><b>y</b>')) === canonicalMarks('<i><b>x</b></i><b>y</b>'),
    'IDEMPOTENT — a materialize→DOM→re-serialize round trip must not keep changing it')
  ok(canonicalMarks('a&amp;b&nbsp;c&lt;d') === 'a&amp;b&nbsp;c&lt;d',
    'entities round-trip byte-identically to what innerHTML hands back — NBSP verbatim')
  ok(canonicalMarks('<a href="https://x/">a</a><a href="https://x/">b</a>') === '<a href="https://x/">ab</a>',
    'two links to the same address coalesce; a link is one hover target, not two')

  // ---- apply -------------------------------------------------------------
  ok(applyMark('hello world', 0, 5, 'strong') === '<strong>hello</strong> world',
    'a mark over part of a plain run wraps exactly that part')
  ok(applyMark('<strong>hello</strong> world', 0, 11, 'strong') === '<strong>hello world</strong>',
    'extending a mark over its neighbour leaves ONE run, not two abutting ones')

  // ---- THE PARTIAL-SELECTION CASE ----------------------------------------
  ok(applyMark('<strong>hello world</strong>', 0, 5, 'strong') === 'hello<strong> world</strong>',
    'unbolding the HEAD of a bold run splits it and keeps the tail bold')
  ok(applyMark('<strong>hello world</strong>', 6, 11, 'strong') === '<strong>hello </strong>world',
    'unbolding the TAIL splits the other way')
  ok(applyMark('<strong>hello world</strong>', 2, 5, 'strong') === '<strong>he</strong>llo<strong> world</strong>',
    'unbolding the MIDDLE leaves three runs — the case that needs a real split')
  ok(applyMark('<em>abcdef</em>', 2, 4, 'em') === '<em>ab</em>cd<em>ef</em>',
    '…and it is the TAG that moves: not one character of text changes')
  ok(markActive('<strong>hello</strong> world', 0, 5, 'strong') === true &&
     markActive('<strong>hello</strong> world', 0, 7, 'strong') === false,
    'a mark is ACTIVE only when it covers the whole selection')
  ok(applyMark('<strong>hello</strong> world', 0, 7, 'strong') === '<strong>hello w</strong>orld',
    '…so toggling a half-covered selection EXTENDS the mark rather than removing it')

  // ---- links and clearing -------------------------------------------------
  const linked = applyMark('abc', 1, 2, 'a', { op: 'on', attrs: linkAttrs('https://x/?a=1&b=2') })
  ok(linked === 'a<a href="https://x/?a=1&amp;b=2" rel="noopener noreferrer" target="_blank">b</a>c',
    'a new link is spelled EXACTLY as sanitizeInline would leave it, ampersand and all')
  ok(linkAt(linked, 1, 2) === 'https://x/?a=1&b=2' && linkAt(linked, 0, 3) === '',
    'linkAt reports a link only when it covers the whole selection')
  ok(clearMarks('<a href="https://x/"><strong>hi</strong></a> there', 0, 2) === 'hi there',
    'clear formatting takes the link with it — a link is formatting too')
  ok(applyMark('a<br>b', 0, 3, 'em') === '<em>a<br>b</em>',
    'a <br> is ONE character of offset, so a mark after a line break lands on the right words')

  // ---- markdown, both ways ------------------------------------------------
  // EVERY mark the toolbar can apply must survive an export. A control that
  // produces something the exporter drops is worse than no control, because
  // the loss only shows up in a file somebody has already sent. Four of these
  // WERE dropped before this rig existed.
  const MARK_MD: Array<[string, string]> = [
    ['<strong>x</strong>', '**x**'],
    ['<em>x</em>', '*x*'],
    ['<u>x</u>', '<u>x</u>'],
    ['<s>x</s>', '~~x~~'],
    ['<code>x</code>', '`x`'],
    ['<mark>x</mark>', '==x=='],
    ['<sub>x</sub>', '<sub>x</sub>'],
    ['<sup>x</sup>', '<sup>x</sup>'],
    ['<a href="https://x/">x</a>', '[x](https://x/)'],
  ]
  for (const [html, md] of MARK_MD) {
    ok(htmlToMd(html) === md, `${html} exports as ${md}`)
    ok(canonicalMarks(inlineHtml(md)) === canonicalMarks(html),
      `…and ${md} imports back as the same mark — export→import is the identity`)
  }
  ok(htmlToMd('<a href="https://x/"><strong>x</strong></a>') === '[**x**](https://x/)',
    'the canonical order puts the link outermost, which is the only nesting markdown can spell')
  ok(htmlToMd('a<br>b') === 'a\nb', 'a line break exports as one')
}

// ---------------------------------------------------------------------------
// TEXT AND BACKGROUND COLOUR — the format's SECOND attribute.
//
// The vocabulary is closed (marks.ts PALETTE) and the sanitizer matches a
// PATTERN rather than the nine names, so a colour added in a later build
// survives an older one instead of being deleted by it. That is the property
// worth pinning: everything else about colour is a stylesheet.
{
  const red = ' class="sp-fg-red"'
  ok(applyMark('hello', 0, 5, 'span', { op: 'on', attrs: red }) === '<span class="sp-fg-red">hello</span>',
    'ink colour is a class on a SPAN, never a style attribute')
  ok(applyMark('<span class="sp-fg-red">hello</span>', 0, 5, 'span', { op: 'off' }) === 'hello',
    'and "Default" REMOVES it — a paragraph coloured back to default is byte-identical to one never coloured')
  ok(applyMark('<span class="sp-fg-red">hello</span>', 0, 5, 'span', { op: 'on', attrs: ' class="sp-fg-blue"' })
      === '<span class="sp-fg-blue">hello</span>',
    'a second colour REPLACES the first rather than nesting two spans')
  ok(applyMark('<span class="sp-fg-red">hello</span>', 0, 2, 'span', { op: 'off' })
      === 'he<span class="sp-fg-red">llo</span>',
    'colour splits on a partial selection exactly as bold does')
  ok(canonicalMarks('<span>a</span><span class="sp-fg-red">b</span>') === 'a<span class="sp-fg-red">b</span>',
    'a span with NO palette class is contentEditable debris and is dropped; one with a class is content')
  ok(canonicalMarks('<span class="sp-fg-red">a</span><span class="sp-fg-red">b</span>')
      === '<span class="sp-fg-red">ab</span>',
    'two runs of the same colour coalesce; two different ones cannot')
  ok(canonicalMarks('<strong><span class="sp-fg-red">x</span></strong>')
      === '<span class="sp-fg-red"><strong>x</strong></span>',
    'colour sits outside the emphasis marks in the canonical order, whichever way it was written')
  ok(canonicalMarks('<mark class="sp-bg-green">x</mark>') === '<mark class="sp-bg-green">x</mark>' &&
     canonicalMarks('<mark>x</mark>') === '<mark>x</mark>',
    'a background is a class on MARK, and a plain highlight stays exactly what it was')

  // THE ADDITIVITY PROPERTY, which is the reason CLASS_OK is a pattern.
  ok(CLASS_OK.test('sp-fg-teal') && CLASS_OK.test('sp-bg-teal'),
    'a colour this build has never heard of still MATCHES — an old build must not delete a new palette')
  ok(canonicalMarks('<span class="sp-fg-teal">x</span>') === '<span class="sp-fg-teal">x</span>',
    '…and round-trips byte-for-byte through a build with no rule for it: unstyled, not lost')
  ok(!CLASS_OK.test('sp-fg-') && !CLASS_OK.test('sp-xx-red') && !CLASS_OK.test('anything-else') &&
     !CLASS_OK.test('sp-fg-0123456789abcdefg'),
    'and the pattern is still bounded: two roles, a short name, nothing else')
  ok(keepClasses('sp-fg-red not-ours sp-bg-blue') === 'sp-fg-red sp-bg-blue',
    'a class list is filtered per TOKEN — one bad name must not cost the colour beside it')

  // MARKDOWN. Colour has no syntax at all, so it exports as the raw inline
  // html GFM permits, and the importer keeps the class — otherwise "export,
  // edit the .md, import" would be a colour-stripping round trip.
  const COLOUR_MD: Array<[string, string]> = [
    ['<span class="sp-fg-red">x</span>', '<span class="sp-fg-red">x</span>'],
    ['<mark class="sp-bg-green">x</mark>', '<mark class="sp-bg-green">x</mark>'],
  ]
  for (const [html, md] of COLOUR_MD) {
    ok(htmlToMd(html) === md, `${html} exports as itself`)
    ok(canonicalMarks(inlineHtml(md)) === canonicalMarks(html),
      `…and imports back with the class intact — export→import is the identity`)
  }
  ok(htmlToMd('<mark>x</mark>') === '==x==',
    'the PLAIN highlight keeps ==x==, which Obsidian and Pandoc both read')
}

// ---- the theme gate --------------------------------------------------------
//
// EVERY FAILURE HERE IS INVISIBLE IN THE LIGHT THEME, which is the one the
// author is looking at while they write the rule. A surface pinned to `#fff`
// keeps its white background when the chrome goes dark and puts light text on
// it; slides measured that at 1.21:1 against WCAG AA's 4.5 floor before its own
// gate existed, and it looked perfect the whole time.
//
// Three properties, and the third is the one that is not about contrast at all:
// a theme is a VIEWER preference (PLATFORM §8), so it must never reach the
// document — not through doc.theme, and not through the pristine clone every
// save re-serializes.
{
  const fs = await import('node:fs')
  const src = (f: string) =>
    fs.readFileSync(new URL(`../spaces/src/${f}`, import.meta.url), 'utf8')
  const css = src('styles.css')

  // Strip comments first: prose about `#fff` is not a rule painting `#fff`,
  // and a failure that names a comment sends the reader to the wrong line.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')

  // ---- 1. both dark blocks exist, and they are the same block --------------
  // Three states: a reader chose light, chose dark, or chose nothing. The
  // choice stamps data-theme; the default follows the OS. So dark has to be
  // stated under the MEDIA QUERY (guarded, so an explicit light still wins)
  // AND under the ATTRIBUTE, or the picker only works in one direction.
  const body = (sel: string): string | null => {
    const i = bare.indexOf(sel)
    if (i < 0) return null
    const open = bare.indexOf('{', i)
    return bare.slice(open + 1, bare.indexOf('}', open))
  }
  const roles = (b: string) =>
    new Map([...b.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)]
      .map((m) => [m[1], m[2].trim().toLowerCase()] as [string, string]))

  const light = body(':root, :root[data-theme="light"]')
  const media = body(':root:not([data-theme="light"])')
  const attr = body(':root[data-theme="dark"]')
  ok(!!light && !!media && !!attr,
    'dark is defined BOTH under prefers-color-scheme and under [data-theme="dark"]')
  ok(/@media screen and \(prefers-color-scheme: dark\)/.test(css),
    '…and the media block is a screen block, which is what keeps paper light')
  if (light && media && attr) {
    const L = roles(light), M = roles(media), A = roles(attr)
    // byte-identical, or the picker and the OS default drift apart silently
    const drift = [...M].filter(([k, v]) => A.get(k) !== v).map(([k]) => k)
    ok(drift.length === 0 && M.size === A.size,
      `the two dark blocks are identical${drift.length ? ` — ${drift.join(', ')}` : ''}`)
    // --sp-read and --radius are GEOMETRY. They live in the light block
    // because that is where the tokens are, but a reading size and a corner
    // radius are the same in the dark; only colour has two answers.
    const METRIC = /^--(sp-read|radius)$/
    const missing = [...L.keys()].filter((r) => !M.has(r) && !METRIC.test(r))
    ok(missing.length === 0,
      `dark defines every role light does${missing.length ? ` — missing ${missing.join(', ')}` : ''}`)
    const extra = [...M.keys()].filter((r) => !L.has(r))
    ok(extra.length === 0,
      `dark invents no role light lacks${extra.length ? ` — extra ${extra.join(', ')}` : ''}`)
    // A token defined twice and referenced nowhere is not harmless: it is a
    // wire that was never connected, and the literal it was meant to replace
    // is still in the sheet painting a light value in dark.
    const unused = [...L.keys()].filter((r) => !new RegExp(`var\\(${r}[,)]`).test(css))
    ok(unused.length === 0,
      `every themed role is referenced by a rule${unused.length ? ` — unused: ${unused.join(', ')}` : ''}`)
    // and the light palette has not forked from slides and type
    const SUITE: Record<string, string> = {
      '--ink': '#1e2a3a', '--ink-2': '#31445c', '--chrome': '#f5f7fa',
      '--chrome-2': '#eceff4', '--line': '#e3e8ef', '--muted': '#5b6472',
      '--accent': '#f7a600', '--accent-ink': '#7a5200', '--blue': '#5b8def',
    }
    const wrong = Object.entries(SUITE)
      .filter(([k, v]) => L.get(k) !== v)
      .map(([k, v]) => `${k} is ${L.get(k) ?? 'missing'}, suite says ${v}`)
    ok(wrong.length === 0,
      `the light palette still matches the suite${wrong.length ? `\n        ${wrong.join('\n        ')}` : ''}`)
  }

  // ---- 2. no literal colour survives outside the tokens and the paper -----
  // The token blocks are where a colour is allowed to be written down; the
  // print sheet is the other place, because paper is white for reasons that
  // have nothing to do with anybody's preference. Everywhere else a literal is
  // a value that will not move when the theme does.
  //
  // The listed exceptions are surfaces that deliberately do not follow the
  // chrome, each named rather than silently tolerated:
  //   .sp-b-image img   a picture gets a white ground of its own in BOTH
  //                     themes — a transparent-background diagram exported
  //                     against white vanishes on a dark one
  //   .sp-b-media video the letterbox behind a clip, black in both
  //   .sp-dot           the fill is a generated hue set inline by collabui, so
  //                     the initial on it is white on either ground
  const HEX = /#[0-9a-fA-F]{3,8}\b/
  const EXEMPT = /^(\.sp-b-image img|\.sp-b-media video|\.sp-dot)\b/
  // everything up to the first token block, then everything after the last —
  // simpler and more honest than trying to parse nesting: cut the three token
  // blocks and both @media print blocks out, and audit what is left
  let audit = bare
  for (const cut of [/:root, :root\[data-theme="light"\][\s\S]*?\n}\n/,
                     /@media screen and \(prefers-color-scheme: dark\)[\s\S]*?\n}\n/,
                     /@media screen \{\s*\n  :root\[data-theme="dark"\][\s\S]*?\n}\n/]) {
    const m = audit.match(cut)
    ok(!!m, `the theme gate can find its token block (${String(cut).slice(0, 46)}…)`)
    if (m) audit = audit.replace(cut, '\n')
  }
  audit = audit.replace(/@media print \{[\s\S]*?\n}\n/g, '\n')
  const stray: string[] = []
  for (const [, sel, decls] of audit.matchAll(/(^|\n)([^@{}\n][^{}]*)\{([^}]*)\}/g)) {
    if (!HEX.test(decls)) continue
    const s0 = sel.trim().split(',')[0].trim()
    if (EXEMPT.test(s0)) continue
    stray.push(`${s0} → ${decls.trim().replace(/\s+/g, ' ').slice(0, 60)}`)
  }
  ok(stray.length === 0,
    `no literal colour outside the token blocks and the print sheet${stray.length ? `\n        ${stray.join('\n        ')}` : ''}`)

  // ---- 3. the preference never reaches the document ----------------------
  // startTheme() writes data-theme + color-scheme onto <html>. capturePristine
  // clones the LIVE document and every save re-serializes that clone, so the
  // call has to come AFTER it — otherwise a reader's theme ships inside every
  // file they save and lands on whoever they send it to. Same ordering
  // applyDirection already depends on for dir/lang.
  const main = src('main.ts')
  ok(main.indexOf('startTheme()') > main.indexOf('capturePristine()'),
    'startTheme() runs after capturePristine(), so no theme reaches a saved file')
  // and nothing writes it into the model
  const app = src('appearance.ts')
  ok(!/store|doc\.|commit/.test(app.replace(/\/\/[^\n]*/g, '')),
    'the Appearance control never touches the store or the document')
  ok(!/theme/i.test(src('model.ts').match(/export interface Theme[\s\S]*?\n}/)?.[0]
       .replace(/^export interface Theme/, '') ?? '') ||
     !/data-theme|bento-theme|prefers-color-scheme/.test(src('model.ts')),
    'the FORMAT knows nothing about the interface theme')
  // the still preview renders the AUTHOR's colours, in both themes
  // the prose above it says exactly this, so audit the CODE, not the comment
  const previewCode = src('preview.ts').replace(/^\s*\/\/[^\n]*$/gm, '')
  ok(!/prefers-color-scheme|data-theme/.test(previewCode),
    'the static file-manager preview has no theme of its own — it is the author’s document')
}

// ---- THE `/` MENU IS NOT ENGLISH-ONLY ---------------------------------------
// Block specs carry `label`/`hint` in a data table and the editor renders them
// with `t(item.label)`. The i18n sweep anchors on a LITERAL `t('…')`, so it
// never saw them: the slash menu, the Insert dropdown and ⌘K's block results
// were English in all eight languages, for every block type, from the day the
// table was written.
//
// The second half is the part worth pinning. Adding the strings to the
// catalogs did NOT fix it — the packer builds PACKED from the swept key list,
// so a catalog entry for a key the sweep misses is dropped on the way into the
// shell. The catalogs read 504/504 complete while the shell shipped none of
// them. Only teaching the SWEEP about them works.
{
  const fs = await import('node:fs')
  const sweep = fs.readFileSync(new URL('../scripts/build-spaces-i18n.mjs', import.meta.url), 'utf8')
  const packed = fs.readFileSync(new URL('../spaces/src/i18n/packed.ts', import.meta.url), 'utf8')

  ok(/blocks\.ts'\)/.test(sweep) && /label\|hint/.test(sweep),
    'the key sweep reads block spec labels and hints, not only literal t() calls')
  for (const label of ['Bulleted list', 'Callout', 'Board or list', 'Video or audio']) {
    ok(packed.includes(JSON.stringify(label)),
      `"${label}" reaches the packed table, so the menu can be translated`)
  }
  // SYNTAX IS NOT LANGUAGE: a markdown trigger is what you literally type.
  // Demanding eight translations of "-" would be noise in every catalog.
  for (const syntax of ['"-"', '"1."', '"---"', '"[]"']) {
    ok(!new RegExp('^\\s*' + syntax.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':', 'm').test(packed),
      `${syntax} is a markdown trigger and stays out of the catalogs`)
  }
}


// ---- A LINK IN A TABLE CELL IS A LINK --------------------------------------
// A table keeps its content in `rows` and mirrors it into `html`; writeTable is
// the one writer that keeps the two in step. So a table the EDITOR produced
// back-links from its cells, and a table that arrives any other way — hand
// written, an agent calling updateBlock, an import — does not: the link works
// when clicked and appears in no "Linked from". Silent, and exactly the one
// failure a backlink index can have.
//
// `rows` is read ONLY when `html` is absent. Extending this to always scan
// `rows` was tried during the starter work and reverted, because with both
// fields present every cell link is counted twice.
{
  const cell = '<a href="#p/b">B</a>'
  const docWith = (blk: Record<string, unknown>) => ({
    format: FORMAT, version: 1, docId: 'd', title: 't', home: 'a',
    theme: {}, pages: [
      { id: 'a', title: 'A', blocks: [blk] },
      { id: 'b', title: 'B', blocks: [] },
    ],
  }) as unknown as SpacesDoc
  const backlinksToB = (blk: Record<string, unknown>) =>
    (buildIndex(docWith(blk)).backlinks?.get('b') ?? []).length

  ok(backlinksToB({ id: 'k', type: 'table', rows: [['x', cell]] }) === 1,
    'a hand-authored table cell back-links, with no html fallback present')

  const written: Record<string, unknown> = { id: 'k', type: 'table' }
  writeTable(written as never, tableOf({ ...written, rows: [['x', cell]] } as never))
  ok(backlinksToB(written) === 1, 'a table written by the editor back-links exactly once')

  ok(backlinksToB({ id: 'k', type: 'table', rows: [[cell]], html: cell }) === 1,
    '…and with BOTH fields present the same link is not counted twice')

  // buildIndex runs on documents nobody has validated yet
  let threw = false
  try { backlinksToB({ id: 'k', type: 'table', rows: ['not-a-row', [null, 7, cell]] }) }
  catch { threw = true }
  ok(!threw, 'a malformed rows array does not take the index down')
}


// ————— THE CANVAS BLOCK ——————————————————————————————————————————————————
//
// A spatial surface is the one block type whose layout has NOWHERE ELSE to
// live: a board's order is `doc.pages`, a list's order is the block array, and
// a canvas's coordinates are only on the canvas. So they ship into files on
// other people's disks the moment the type exists, and every property below is
// one that cannot be corrected afterwards.
{
  const cv = (over: Record<string, unknown> = {}): Block =>
    ({ id: 'cv', type: 'canvas', ...over }) as Block

  // THE SHAPE IS READ, NEVER REPAIRED. Same rule as tableOf: two readers of one
  // file agree without exchanging an op, and opening a space rewrites nothing.
  ok(canvasRatio(cv()) === CANVAS_RATIO, 'a canvas with no ratio is the default shape')
  ok(canvasRatio(cv({ ratio: 1 })) === 1, 'a stated ratio is honoured')
  ok(canvasRatio(cv({ ratio: 0 })) === RATIO_MIN, 'a ratio of 0 is clamped, not a surface with no height')
  ok(canvasRatio(cv({ ratio: -3 })) === RATIO_MIN, 'a negative ratio is clamped')
  ok(canvasRatio(cv({ ratio: 900 })) === RATIO_MAX, 'an absurd ratio is clamped')
  ok(canvasRatio(cv({ ratio: 'wide' })) === CANVAS_RATIO, 'a ratio that is not a number is the default')
  ok(canvasRatio(cv({ ratio: NaN })) === CANVAS_RATIO, 'NaN is the default, not NaN')

  // THE SHAPE BUTTON CYCLES AND COMES HOME. Three shapes, and the third click
  // returns the exact default — which is what lets the editor store it as an
  // ABSENT key, so a canvas somebody cycled and cycled back is byte-identical
  // to one nobody touched.
  ok(nextRatio(nextRatio(nextRatio(CANVAS_RATIO))) === CANVAS_RATIO,
    'three clicks of the shape button return the default ratio exactly')
  ok(ratioName(1.6) === 'Wide' && ratioName(1) === 'Square' && ratioName(0.7) === 'Tall',
    'each of the three shapes knows its own name')
  ok(ratioName(1.55) === 'Wide',
    'a hand-written ratio near a named shape says that name rather than nothing')

  // AN UNPLACED CARD IS NOT AN ERROR, and two readers must place it the same.
  // `{type:'canvas'}` with three bare paragraphs under it is a hand-writable
  // canvas, and every card added with Enter arrives without coordinates.
  const bare: Block = { id: 'c', type: 'p', parent: 'cv' }
  ok(JSON.stringify(cardPos(bare, 0)) === JSON.stringify(cardPos(bare, 0)),
    'an unplaced card lands in the same slot on every read')
  ok(cardPos(bare, 0).x !== cardPos(bare, 1).x || cardPos(bare, 0).y !== cardPos(bare, 1).y,
    'two unplaced cards do not land on top of each other')
  ok([...Array(12)].every((_, i) => {
    const p = slotFor(i)
    return p.x >= 0 && p.x <= 100 - 22 && p.y >= 0 && p.y <= 100
  }), 'every slot in the first lap leaves the whole card on the surface')
  const seen = new Set([...Array(12)].map((_, i) => JSON.stringify(slotFor(i))))
  ok(seen.size === 12, 'the twelve slots of one lap are twelve different places')

  // A STATED POSITION WINS over the slot, which is the whole point of dragging.
  ok(cardPos({ id: 'c', type: 'p', x: 40, y: 70 } as Block, 0).x === 40,
    'a card that has been placed sits where it says')
  ok(cardPos({ id: 'c', type: 'p', x: 40, y: 70 } as Block, 5).y === 70,
    '…whatever its index among its siblings')

  // COORDINATES OUT OF A FILE. A generator, a hand edit or a build with a
  // different surface can write anything; none of it may put a card where no
  // reader can reach it, and none of it may take a page of prose down.
  ok(cardPos({ id: 'c', type: 'p', x: -50, y: 400 } as Block, 0).x === 0,
    'a negative coordinate is brought back onto the surface')
  ok(cardPos({ id: 'c', type: 'p', x: -50, y: 400 } as Block, 0).y === 100,
    '…and one past the far edge is too')
  ok(cardPos({ id: 'c', type: 'p', x: 'left', y: {} } as unknown as Block, 3).x === slotFor(3).x,
    'a coordinate that is not a number falls back to the slot')

  // ONE DECIMAL PLACE. Positions are rewritten on every drag and read in every
  // diff; float noise makes a card that slid 4% look like a rewritten block.
  ok(round1(59.34567) === 59.3, 'a position is stored to one decimal place')
  ok(String(clampPct((1 / 3) * 100)) === '33.3', '…and is short enough to read in a diff')

  // A NEW CARD NEVER LANDS ON AN OLD ONE. Not "the next index": cards get
  // deleted, so index 3 can be free while index 5 is taken.
  const occupied: Block[] = [
    { id: 'a', type: 'p', ...slotFor(0) } as Block,
    { id: 'b', type: 'p', ...slotFor(1) } as Block,
  ]
  const next = freeSlot(occupied)
  ok(occupied.every((c) => c.x !== next.x || c.y !== next.y),
    'a new card takes a slot no card is already sitting on')
  const holed: Block[] = [{ id: 'a', type: 'p', ...slotFor(3) } as Block]
  ok(JSON.stringify(freeSlot(holed)) === JSON.stringify(slotFor(0)),
    '…and it fills the first hole rather than counting cards')

  // THE CARDS OF A CANVAS ARE ITS CHILDREN, which is the whole format decision:
  // no second list to keep in step with the block array.
  const cvPage = {
    id: 'p', title: 'T', blocks: [
      { id: 'cv', type: 'canvas', html: 'Board' },
      { id: 'c1', type: 'p', parent: 'cv', html: 'one' },
      { id: 'other', type: 'p', html: 'not a card' },
      { id: 'c2', type: 'pagelink', parent: 'cv', page: 'p2' },
    ],
  } as unknown as Page
  ok(cardsOf(cvPage, 'cv').map((b) => b.id).join(',') === 'c1,c2',
    'a canvas holds the blocks that name it as parent, and nothing else')

  // DEGRADATION, and it is the reason cards are blocks. renderBlocks resolves a
  // child against the OPEN CONTAINER STACK and an unknown type opens no
  // container — so on a build with no `canvas`, every card falls out to the top
  // level and renders as the paragraph or page card it already is. Nothing is
  // hidden, and the canvas's own html must therefore NOT repeat the cards.
  const cvSpec = SPEC.get('canvas')
  ok(cvSpec?.container === 'always', 'a canvas owns the blocks whose parent is its id')
  ok(cvSpec?.text === true, "a canvas's own html is its name, so it degrades to a readable line")
  ok(cvSpec?.custom === true, 'a canvas draws itself')
  ok(TAG_OF.canvas === 'div', 'a canvas is a div, like every other surface block')
  ok(!LIST_OF.canvas, 'a canvas is not a list item')

  // ITS MARKDOWN IS ITS NAME. The cards follow as their own indented lines,
  // because they are their own blocks — so `toMd` must NOT print them again.
  const cvMd = cvSpec!.toMd!({ id: 'cv', type: 'canvas' } as Block, 'Launch plan', '', {} as never)
  ok(cvMd.join('\n') === '**Launch plan**', 'a canvas exports as its name')
  ok(cvSpec!.toMd!({ id: 'cv', type: 'canvas' } as Block, '', '', {} as never)[0] === '**Canvas**',
    'an unnamed canvas still says what it is rather than exporting a blank line')

  // A CARD'S OWN WORDS TRAVEL, AS THEIR OWN LINE. mdLayout decides the two
  // decorations a block cannot decide for itself, and the one that matters here
  // is `quote`: a container marked `mdQuoteChildren` sweeps its whole subtree
  // into a blockquote, and a canvas marked that way by accident would turn a
  // storyboard into one grey box of run-on prose. (`indent` is set for any
  // container's child; the exporter spends it on the types whose toMd takes it,
  // which a plain text card's does not — so the assertion is on the quote.)
  const cvLay = mdLayout(cvPage.blocks)
  ok(cvLay[1].quote === '', 'a card is not swept into its canvas as a blockquote')
  ok(cvLay[1].indent === '  ', "…and mdLayout reads it as its container's child")
}


// ---- 8. the graph view -----------------------------------------------------
// The picture is drawn from `buildIndex().backlinks` and nothing else — there
// is no second link index (spaces/src/graph.ts). What is asserted here is the
// part a screenshot cannot show: that two references between the same pair are
// one edge and not two, that the layout is REPRODUCIBLE (the reveal animation
// interpolates toward a settled answer, so a layout that moved between runs
// would make the same space a different picture every time it is opened), and
// that the springs actually pull linked pages together rather than merely
// running without error.
{
  const link = (to: string) => `<a href="#p/${to}">x</a>`
  const space = (pages: Array<Partial<Page> & { id: string }>): SpacesDoc => ({
    format: FORMAT, version: 1, docId: 'g', title: 'g', theme: {},
    pages: pages.map((p) => ({ title: p.id, blocks: [], ...p })),
  }) as unknown as SpacesDoc
  const graphOf = (d: SpacesDoc) => buildGraph(d, buildIndex(d))

  {
    const d = space([
      { id: 'a', blocks: [{ id: 'b1', type: 'p', html: link('b') } as Block] },
      { id: 'b' },
      { id: 'z', archived: true, blocks: [{ id: 'b2', type: 'p', html: link('b') } as Block] },
    ])
    const g = graphOf(d)
    ok(g.nodes.length === 2 && !g.at.has('z'),
      'graph: an archived page is not drawn — it is out of the way in the sidebar too')
    ok(g.edges.length === 1 && g.edges[0].links === 1,
      'graph: one link between two pages is one edge')
    ok(g.nodes.every((n) => n.deg === 1),
      'graph: …and both ends of it count as connected')
  }
  {
    // two references, one relationship — the defect this guards is an edge list
    // that grows with every mention and a hub that looks twice as busy as it is
    const d = space([
      { id: 'a', blocks: [
        { id: 'b1', type: 'p', html: link('b') } as Block,
        { id: 'b2', type: 'p', html: link('b') } as Block,
      ] },
      { id: 'b', blocks: [{ id: 'b3', type: 'p', html: link('a') } as Block] },
    ])
    const g = graphOf(d)
    ok(g.edges.length === 1, 'graph: three references between one pair are ONE undirected edge')
    ok(g.edges[0].links === 3, '…carrying the weight of all three')
    ok(g.nodes[0].deg === 1, '…and counting once toward how connected the page is')
  }
  {
    const d = space([{ id: 'a', blocks: [{ id: 'b1', type: 'p', html: link('a') } as Block] }])
    ok(graphOf(d).edges.length === 0, 'graph: a page that links to itself draws no edge')
  }
  {
    // the tree is a relationship too: a space where nobody has written a
    // wikilink yet must not draw as unconnected dust
    const d = space([{ id: 'a' }, { id: 'b', parent: 'a' }])
    const g = graphOf(d)
    ok(g.edges.length === 1 && g.edges[0].tree && g.edges[0].links === 0,
      'graph: a child page is joined to its parent')
    const d2 = space([
      { id: 'a', blocks: [{ id: 'b1', type: 'p', html: link('b') } as Block] },
      { id: 'b', parent: 'a' },
    ])
    const g2 = graphOf(d2)
    ok(g2.edges.length === 1 && g2.edges[0].tree && g2.edges[0].links === 1,
      'graph: a child that is ALSO linked is still one edge, not two on top of each other')
  }
  ok(nodeRadius(0) < nodeRadius(3) && nodeRadius(3) < nodeRadius(30) && nodeRadius(1e6) <= 20,
    'graph: a better-connected page draws bigger, and no page draws unboundedly big')

  {
    // REPRODUCIBILITY. Seeds are a golden-angle spiral, not Math.random, and
    // every force is a pure function of the positions.
    const pages: Array<Partial<Page> & { id: string }> = []
    for (let i = 0; i < 40; i++) {
      pages.push({ id: `p${i}`, blocks: [
        { id: `x${i}`, type: 'p', html: link(`p${(i * 7 + 3) % 40}`) } as Block,
      ] })
    }
    const d = space(pages)
    const one = layoutGraph(graphOf(d))
    const two = layoutGraph(graphOf(d))
    const same = one.nodes.every((n, i) => n.x === two.nodes[i].x && n.y === two.nodes[i].y)
    ok(same, 'graph: the same space lays out identically twice — the picture is stable')

    // the RADIUS, not just the centre: the camera frames this box, so a box
    // that only contains the centres crops half of every node on the rim.
    // Checked with `x0 + 5` in the mutation pass and the centres-only version
    // of this assertion did not notice.
    const bounds = graphBounds(one)
    ok(one.nodes.every((n) => n.x - n.r >= bounds.x0 && n.x + n.r <= bounds.x1
      && n.y - n.r >= bounds.y0 && n.y + n.r <= bounds.y1),
      'graph: the frame the camera is fitted to contains every node, edge to edge')
    ok(one.nodes.some((n) => Math.abs((n.x - n.r) - bounds.x0) < 1e-9),
      '…and is no larger than it has to be')

    const cx = one.nodes.reduce((s, n) => s + n.x, 0) / one.nodes.length
    ok(Math.abs(cx) < 1e-6, 'graph: the settled layout is centred, so the camera can frame it')

    // THE SPRINGS DO SOMETHING. Without this the layout could be a pure
    // repulsion cloud — evenly spread, reproducible, centred, and telling you
    // nothing about which pages are related.
    const dist = (i: number, j: number) =>
      Math.hypot(one.nodes[i].x - one.nodes[j].x, one.nodes[i].y - one.nodes[j].y)
    let linked = 0
    for (const e of one.edges) linked += dist(e.a, e.b)
    linked /= one.edges.length
    let all = 0
    let pairs = 0
    for (let i = 0; i < one.nodes.length; i++) {
      for (let j = i + 1; j < one.nodes.length; j++) { all += dist(i, j); pairs++ }
    }
    all /= pairs
    ok(linked < all * 0.6,
      'graph: linked pages end up markedly closer than unlinked ones')

    // and the cloud has to GROW with the space, or a big space is a dot: see
    // gravityFor. 400 pages must not settle into the same disc as 40.
    const big: Array<Partial<Page> & { id: string }> = []
    for (let i = 0; i < 400; i++) {
      big.push({ id: `q${i}`, blocks: [
        { id: `y${i}`, type: 'p', html: link(`q${(i * 7 + 3) % 400}`) } as Block,
      ] })
    }
    const bg = layoutGraph(graphOf(space(big)))
    const radius = (g: ReturnType<typeof graphOf>) => {
      const b = graphBounds(g)
      return Math.max(b.x1 - b.x0, b.y1 - b.y0) / 2
    }
    // MEASURED, not guessed: ten times the pages settles 3.01x wider with
    // gravityFor and only 2.29x wider with a constant gravity (the radius goes
    // as n^(1/3) instead of sqrt(n)). 2.6 sits between the two — a threshold of
    // 2.2, tried first, passed on BOTH and proved nothing.
    ok(radius(bg) > radius(one) * 2.6,
      'graph: ten times the pages is a bigger picture, not a denser one')
  }
  {
    // stepLayout must SETTLE, not oscillate: a layout that is still moving when
    // it is handed over is a layout the camera was fitted to by accident
    const pages: Array<Partial<Page> & { id: string }> = []
    for (let i = 0; i < 30; i++) {
      pages.push({ id: `s${i}`, blocks: [
        { id: `z${i}`, type: 'p', html: link(`s${(i + 1) % 30}`) } as Block,
      ] })
    }
    const g = graphOf(space(pages))
    layoutGraph(g)
    const before = g.nodes.map((n) => ({ x: n.x, y: n.y }))
    stepLayout(g, 0.01)
    const moved = Math.max(...g.nodes.map((n, i) =>
      Math.hypot(n.x - before[i].x, n.y - before[i].y)))
    ok(moved < 0.5, 'graph: one more tick on a settled layout barely moves anything')
  }
}


// ---- A LAYOUT KEY OUT OF A FILE IS NOT A PROPERTY NAME ----------------------
// A view block is plain JSON in a document someone mailed you, and `layout` is
// a free string in it. The renderer picked the button's word out of an object
// literal by that string, guarded by TRUTHINESS — and `WORD['toString']` is a
// native function, which is truthy. So `layout:"toString"` rendered the layout
// button's label as `function toString() { [native code] }` and wrote the same
// text into data-next.
//
// The reason it survived a review: the cycle was written TWICE, once in
// editor.ts for what a click STORES and once in render.ts for what the button
// SAYS. The hardening went into the editor's copy, and the editor's comment
// then asserted the label was safe — while the label was still coming from the
// other, unguarded copy. One function now, called by both, and checked here by
// CALLING it rather than by grepping the source for the guard.
{
  for (const evil of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const shapes = VIEW_LAYOUTS as readonly string[]
    ok(shapes.includes(layoutOf(evil)),
      `layout:${JSON.stringify(evil)} resolves to a real shape (${layoutOf(evil)}), never a native function`)
    ok(shapes.includes(nextLayout(evil)),
      `…and what follows it is a shape too (${nextLayout(evil)}), so data-next is never a function body`)
  }

  // The honest shapes still work, or the guard above would be a way to break
  // the feature and call it secure.
  ok(VIEW_LAYOUTS.every((l) => layoutOf(l) === l), 'every real layout resolves to itself')
  ok(layoutOf(undefined) === 'board' && layoutOf('') === 'board' && layoutOf('mosaic') === 'board',
    'absent, empty, and a key from a NEWER build all land on the board')

  // THE CYCLE CLOSES. As many steps as there are shapes returns where it
  // started — which is what makes "cycled all the way round is byte-identical
  // to untouched" true rather than aspirational.
  for (const start of VIEW_LAYOUTS) {
    let at: string = start
    for (let i = 0; i < VIEW_LAYOUTS.length; i++) at = nextLayout(at)
    ok(at === start, `${VIEW_LAYOUTS.length} steps from ${start} comes back to ${start}`)
  }
  ok(new Set(VIEW_LAYOUTS.map((l) => nextLayout(l))).size === VIEW_LAYOUTS.length,
    'the cycle reaches every shape — none is stranded off it')
}


console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
