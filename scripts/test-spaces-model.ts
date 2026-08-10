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
  parseDoc, buildIndex, docContentKey, homePage, FORMAT, isRemote,
  effectiveParents, descendantsOf,
  type SpacesDoc,
} from '../spaces/src/model.ts'
import { countOutsideTags, replaceOutsideTags } from '../spaces/src/findreplace.ts'
import {
  DEFAULT_FIELDS, fieldsOf, fieldByKey, optionOf, propHtml, propBlock,
  valuesOf, isIssue, issuesOf, headerLength, propBlockOf,
  passesFilter, filterCount, unknownFilterKeys, phaseField, isOpenPhase, reorderPages,
} from '../spaces/src/fields.ts'
import { inlineHtml, parseNote, planImport } from '../spaces/src/markdown.ts'
import { planUpdatePage } from '../spaces/src/agent.ts'
import { tokenize, normLang, langLabel, CODE_LANGS } from '../spaces/src/highlight.ts'
import { escText } from '../spaces/src/sanitize.ts'
import {
  SPECS, SPEC, MENU_SPECS, MD_SPECS, TAG_OF, LIST_OF, CALLOUT_TONES, mdLayout,
} from '../spaces/src/blocks.ts'
import type { Block, Page } from '../spaces/src/model.ts'

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

  // and the renderer must actually consult it
  const fs = await import('node:fs')
  const ren = fs.readFileSync(new URL('../spaces/src/render.ts', import.meta.url), 'utf8')
  ok(/isRemote\(rawSrc\)\s*&&\s*!opts\.allowRemote/.test(ren),
    'render.ts gates remote images on the reader\'s consent')
  ok(!/allowRemote/.test(fs.readFileSync(new URL('../spaces/src/model.ts', import.meta.url), 'utf8')),
    'consent is NOT a document field — it belongs to the reader, not the file')
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
// The rule (slides' rule) is: drop text and fold, never scroll. The failure
// mode to guard is not the CSS — it is the SECOND LIST: a ⋯ menu maintained by
// hand as a copy of the desktop row drifts the first time either changes, and
// the drift is invisible until someone opens the app on a phone.
{
  const fs = await import('node:fs')
  const ed = fs.readFileSync(new URL('../spaces/src/editor.ts', import.meta.url), 'utf8')
  const css = fs.readFileSync(new URL('../spaces/src/styles.css', import.meta.url), 'utf8')

  ok(/const secondary: Array<\{/.test(ed), 'the secondary topbar actions are declared as ONE list')
  ok(/secondary\.map\(/.test(ed), '…the inline row is built from that list')
  ok(/for \(const a of secondary\)/.test(ed), '…and the ⋯ menu is built from the SAME list')

  ok(/@media \(max-width: 720px\)/.test(css), 'there is a narrow-width breakpoint')
  const narrow = css.slice(css.indexOf('@media (max-width: 720px)'))
  ok(/\.sp-sec \{ display: none/.test(narrow), 'narrow hides the inline secondary row')
  ok(/\.sp-more \{ display: inline-flex/.test(narrow), 'narrow reveals the ⋯ menu')

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
    spec.toMd!({ id: 'c', type: 'callout', ...b } as Block, text, '', () => undefined).join('\n')
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
  ok(/if \(frozen \|\| doc\.readonly\) store\.readOnly = true/.test(main),
    'doc.readonly opens the space read-only')

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
// the bento boot animation to macOS QuickLook, iOS Files, Bento Tray and any
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
  ok(/if \(opts\.editable\) \{\s*const on = /.test(ren),
    '…and the view controls likewise, so a reader and a printout get neither')
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

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
