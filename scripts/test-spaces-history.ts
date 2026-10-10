#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/spaces in-file version history (spaces/src/history.ts).
//
//   node scripts/test-spaces.mjs history     # bundled, like restore-gate
//
// (Bundled: store.ts imports './model' extensionless. Run from the repo root;
// the source rows read spaces/src.)
//
// WHAT THIS PROVES.
//   1. Every entry is the KERNEL's Revision envelope ({id, at, label?, body}),
//      the patch under `body`, no app-minted label; entries read from a file
//      are validated, and a foreign or invalid list is never written over.
//   2. What a revision covers is READ FROM THE FIELD MAP: every field
//      SPACES_FIELDS classes 'content', minus the asset pool, `modified` and
//      the encoding tags. Footnotes, templates, journalTemplate, design,
//      designs, policy and fonts are covered; a restore brings last week's
//      footnotes and design back WITH last week's pages, through the real
//      restore gate and Store, and ⌘Z undoes it.
//   3. restore(N) is byte-identical to the content recorded at N — for a
//      scripted sequence and 200 randomised ones — and survives every fold.
//   4. The budget is the kernel fold module's defaults and tiers, not fails.
//   5. History is a LOG: recording does not move the recovery key, undo does
//      not un-record a save, and a whole-document replace keeps the live list.
//   6. A crafted revision cannot smuggle identity, capability or script.
//
// Mutation controls (by hand, listed in the PR): hand-list contentOf's fields
// without `footnotes` → rows in 2 red; class `revisions` as content → rows in
// 2 red (and copytiers); move recordOnSave out of the queue's prepare → the
// save-revisions rig's pins red.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../spaces/src/store.ts'
import { parseDoc, docContentKey, FORMAT, type SpacesDoc } from '../spaces/src/model.ts'
import { SPACES_FIELDS, SPACES_NOT_EDIT } from '../spaces/src/docclass.ts'
import { restoreInto } from '../spaces/src/restoregate.ts'
import { extractSpace } from '../spaces/src/portable.ts'
import { starterDoc } from '../spaces/src/starter.ts'
import { validateRevision } from '../kernel/src/docfields.ts'
import {
  HISTORY_FIELDS, HISTORY_BUDGET, HISTORY_MAX, HISTORY_FOLD,
  contentOf, recordRevision, recordOnSave, revisionsOf, historyIsForeign, readable,
  applyRevisions, restoredDoc, pruneRevisions, clearHistory, diffWords, changesAt,
  tooLargeForHistory, historyBytes,
} from '../spaces/src/history.ts'

let checks = 0
let failures = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}
const J = (v: unknown) => JSON.stringify(v)
const B = (v: unknown) => new TextEncoder().encode(J(v)).length
const clone = <T>(v: T): T => JSON.parse(J(v)) as T
type Obj = Record<string, unknown>

const PHOTO = 'data:image/png;base64,' + 'A'.repeat(20_000)

/** A space carrying every covered field, an asset, identity and a live room. */
function mkDoc(): SpacesDoc {
  const r = parseDoc(J({
    format: FORMAT, version: 1, docId: 'd-hist', title: 'Space', home: 'p1',
    theme: { background: '#FFFFFF', color: '#1E2A3A', accent: '#F7A600', fontFamily: 'x', measure: 720 },
    pages: [
      { id: 'p1', title: 'One', icon: 'star', blocks: [
        { id: 'b1', type: 'p', html: 'the quick brown fox [^1]' },
        { id: 'b2', type: 'p', html: 'second line' },
        { id: 'b4', type: 'image', src: 'asset:photo', alt: 'a photo' },
      ] },
      { id: 'p2', title: 'Two', parent: 'p1', blocks: [{ id: 'b3', type: 'p', html: 'other page' }] },
    ],
    assets: { photo: PHOTO },
    footnotes: { 1: 'last week’s note' },
    design: 'almanac',
    designs: { mine: { base: 'riso', label: 'Mine' } },
    templates: [{ id: 't1', title: 'Meeting', blocks: [{ id: 'tb', type: 'p', html: 'Agenda' }] }],
    journalTemplate: 't1',
    collab: { v: 2, room: 'wROOM', key: 'k', on: true },
  }))
  if (!r.ok) throw new Error('fixture does not parse')
  return r.doc
}

// ---------------------------------------------------------------------------
console.log('\n1. the envelope is the kernel\'s\n')
{
  const d = mkDoc()
  recordRevision(d)
  d.pages[0].blocks[0].html = 'edited'
  recordRevision(d)
  const revs = d.revisions as unknown as Obj[]
  ok(revs.length === 2 && revs.every((r) => validateRevision(r)), 'every recorded entry passes the kernel\'s validateRevision')
  ok(revs.every((r) => Object.keys(r).sort().join() === 'at,body,id'),
    `the patch lives UNDER body — the entry carries only id, at, body (${Object.keys(revs[0]).join(',')})`)
  ok(revs.every((r) => !Object.hasOwn(r, 'label')), 'no app-minted label: absent unless a person typed one')
  ok(recordRevision(mkDoc(), 'before the reorg')?.label === 'before the reorg', 'a typed label is kept as typed')
  const body = revs[1].body as Obj
  ok(Object.keys(body).every((k) => ['doc', 'unset', 'order', 'pages'].includes(k)), `the body is the patch: ${Object.keys(body).join(',')}`)

  // a foreign or invalid list is never written over
  const cases: Array<[string, unknown]> = [
    ['not an array', { v: 9, entries: [] }],
    ['an entry with no body (#440\'s flat shape)', [{ id: 'r1', at: 't', doc: { title: 'x' }, pages: [] }]],
    ['an entry whose body.pages is junk', [{ id: 'r1', at: 't', body: { pages: [{ nope: 1 }] } }]],
    ['an entry with a non-string label', [{ id: 'r1', at: 't', label: 7, body: {} }]],
    ['one bad entry after a good one', [...clone(revs), { id: 'r9', at: 't' }]],
  ]
  for (const [label, rv] of cases) {
    const x = mkDoc() as SpacesDoc & Obj
    x.revisions = clone(rv) as never
    const before = J(x.revisions)
    ok(historyIsForeign(x) && revisionsOf(x).length === 0, `${label}: read as foreign, never misread`)
    x.pages[0].blocks[0].html = 'an edit'
    ok(recordRevision(x) === null && J(x.revisions) === before, `${label}: a save never writes over it`)
    ok(!clearHistory(x) && J(x.revisions) === before, `${label}: and Clear history leaves it alone`)
  }
  ok(readable(revs[0]) && !readable({ id: 'a', at: 'b', body: null }), 'readable = the envelope check plus a body check')

  // additivity: unknown fields on an entry and in its body survive a later save
  const a = mkDoc()
  recordRevision(a)
  ;(a.revisions![0] as unknown as Obj).futureField = { note: 'from 2036' }
  ;((a.revisions![0] as unknown as Obj).body as Obj).futureBody = 1
  a.pages[0].blocks[1].html = 'later'
  recordRevision(a)
  ok(J((a.revisions![0] as unknown as Obj).futureField) === J({ note: 'from 2036' }) &&
    ((a.revisions![0] as unknown as Obj).body as Obj).futureBody === 1,
  'unknown fields on an entry and in its body survive a later save untouched')
}

// ---------------------------------------------------------------------------
console.log('\n2. what is covered comes from the field map\n')
{
  const derived = Object.keys(SPACES_FIELDS).filter((k) =>
    (SPACES_FIELDS as Record<string, string>)[k] === 'content' &&
    !['assets', 'format', 'version'].includes(k) && !SPACES_NOT_EDIT.has(k))
  ok(J(HISTORY_FIELDS) === J(derived),
    `HISTORY_FIELDS is the map's content class minus assets, encoding tags and not-edit fields (${HISTORY_FIELDS.join(', ')})`)
  for (const k of ['title', 'home', 'theme', 'pages', 'footnotes', 'templates', 'journalTemplate', 'design', 'designs', 'policy', 'fonts']) {
    ok((HISTORY_FIELDS as readonly string[]).includes(k), `covers \`${k}\``)
  }
  for (const k of ['assets', 'modified', 'format', 'version', 'docId', 'collab', 'readonly', 'template', 'revisions', 'trail']) {
    ok(!(HISTORY_FIELDS as readonly string[]).includes(k), `does not cover \`${k}\``)
  }
  const hsrc = readFileSync(join(process.cwd(), 'spaces/src/history.ts'), 'utf8')
  ok(!/'footnotes'|'journalTemplate'|'designs'/.test(hsrc), 'history.ts names no content field by hand — the list is the map\'s')

  // the content projection never carries asset BYTES
  const d = mkDoc()
  recordRevision(d)
  ok(!J(d.revisions).includes(PHOTO.slice(22, 200)), 'no revision holds the asset pool\'s bytes — only the `asset:` reference')
  ok(historyBytes(d) < B(contentOf(d)) + 2048, `the base revision costs about the content, not the content plus a 20 KB photo (${historyBytes(d)} B)`)

  // LAST WEEK'S footnotes and design come back WITH last week's pages —
  // through the real restore gate and Store, and ⌘Z undoes it.
  const store = new Store(mkDoc())
  recordOnSave(store)                                       // "last week"
  const lastWeek = J(contentOf(store.doc))
  store.commit(() => {
    store.doc.pages[0].blocks[0].html = 'rewritten this week'
    store.doc.pages.push({ id: 'p9', title: 'New', blocks: [{ id: 'b9', type: 'p', html: 'new' }] })
    store.doc.footnotes = { 1: 'this week’s note', 2: 'another' }
    store.doc.design = 'ledger'
    delete store.doc.designs
    store.doc.templates = []
    store.doc.journalTemplate = undefined
    delete store.doc.journalTemplate
  })
  recordOnSave(store)                                       // "this week"
  const thisWeek = J(contentOf(store.doc))
  const next = restoredDoc(store.doc, 0)!
  ok(restoreInto(store, J(next)), 'restoring last week goes through the gate and is accepted')
  const back = store.doc
  ok(J(back.footnotes) === J({ 1: 'last week’s note' }), 'last week\'s FOOTNOTES are back')
  ok(back.design === 'almanac' && J(back.designs) === J({ mine: { base: 'riso', label: 'Mine' } }), 'last week\'s DESIGN and design registry are back')
  ok(J(back.templates) === J(mkDoc().templates) && back.journalTemplate === 't1', 'last week\'s templates and journal template are back')
  ok(back.pages.length === 2 && back.pages[0].blocks[0].html === 'the quick brown fox [^1]', '…WITH last week\'s pages')
  ok(J(contentOf(back)) === lastWeek, 'the whole covered content is byte-identical to what was saved last week')
  ok(back.docId === 'd-hist' && J(back.collab) === J(mkDoc().collab) && back.assets?.photo === PHOTO,
    'identity, the live room and the asset pool are the live document\'s')
  ok(revisionsOf(back).length === 2, 'and the history itself is untouched: restoring is an edit, not a rewind of the file')
  store.undo()
  ok(J(contentOf(store.doc)) === thisWeek && revisionsOf(store.doc).length === 2, '⌘Z undoes the restore, and keeps the history')
}

// ---------------------------------------------------------------------------
console.log('\n3. restore(N) is the content saved at N, on the bytes\n')
{
  const d = mkDoc()
  const stamps: string[] = []
  const save = () => { recordRevision(d); stamps.push(J(contentOf(d))) }
  save()
  d.pages[0].blocks[0].html = 'the quick red fox'
  save()
  d.pages[0].title = 'One (renamed)'
  d.pages.push({ id: 'p3', title: 'Three', blocks: [{ id: 'b9', type: 'p', html: 'new' }] })
  d.footnotes = { 1: 'edited note' }
  save()
  d.pages.splice(1, 1)
  d.theme.accent = '#00AA00'
  delete d.design
  save()
  const revs = revisionsOf(d)
  ok(revs.length === 4, `four saves record four revisions (${revs.length})`)
  let exact = 0
  for (let i = 0; i < revs.length; i++) if (J(contentOf(restoredDoc(d, i)!)) === stamps[i]) exact++
  ok(exact === revs.length, `restore(N) is BYTE-IDENTICAL to the content saved at N, for all ${revs.length}`)
  ok(!('design' in restoredDoc(d, 3)!) && restoredDoc(d, 2)!.design === 'almanac', 'a covered field that became absent is absent again, and comes back with an older version')

  // a save that changed nothing writes nothing; no history = no key
  const one = J(d.revisions)
  ok(recordRevision(d) === null && J(d.revisions) === one, 'a save that changed nothing records nothing')
  ok(!Object.hasOwn(mkDoc(), 'revisions'), 'a never-saved space has no revisions key at all')
  const f = mkDoc()
  recordRevision(f)
  clearHistory(f)
  ok(!Object.hasOwn(f, 'revisions'), 'Clear history removes the key — never `revisions: []`')
}

// ---------------------------------------------------------------------------
console.log('\n4. the budget tiers, with the kernel fold module\'s defaults\n')
{
  ok(HISTORY_BUDGET === 128 * 1024 && HISTORY_MAX === 60 && HISTORY_FOLD === 2,
    `HISTORY_BUDGET ${HISTORY_BUDGET} B, HISTORY_MAX ${HISTORY_MAX}, folding the oldest ${HISTORY_FOLD}`)
  const d = mkDoc()
  for (let i = 0; i < 40; i++) { d.pages[0].blocks[0].html = `revision ${i} of the first paragraph`; recordRevision(d) }
  const full = revisionsOf(d)
  ok(full.length === 40, `40 edits, 40 revisions under the real budget (${full.length})`)
  const wantById = new Map<string, string>()
  for (let i = 0; i < full.length; i++) wantById.set(full[i].id, J(applyRevisions(full, i)))
  const squeezed = pruneRevisions(full, 4 * 1024, 60)
  ok(squeezed.length > 1 && squeezed.length < full.length, `a 4 KB budget folds the oldest: ${full.length} → ${squeezed.length}`)
  let still = 0
  for (let i = 0; i < squeezed.length; i++) if (J(applyRevisions(squeezed, i)) === wantById.get(squeezed[i].id)) still++
  ok(still === squeezed.length, `every surviving revision restores EXACTLY what it did before the fold (${still}/${squeezed.length})`)
  ok(B(squeezed) <= 4 * 1024 && squeezed.every((r) => validateRevision(r)), 'the folded list fits, and its folded entry is still a kernel envelope')
  const capped = pruneRevisions(full, HISTORY_BUDGET, 5)
  ok(capped.length === 5 && J(applyRevisions(capped)) === J(applyRevisions(full)), 'the count ceiling bites on its own; the newest state is untouched')
  ok(pruneRevisions(full, 10, 60).length === 0, 'tier 3: a budget below one whole snapshot keeps none')
  const huge = mkDoc()
  huge.pages[0].blocks[0].html = 'x'.repeat(HISTORY_BUDGET + 10)
  ok(tooLargeForHistory(huge) && recordRevision(huge) === null && !Object.hasOwn(huge, 'revisions'),
    'a space too large for the budget records nothing, carries no key, and the dialog can say why')
}

// ---------------------------------------------------------------------------
console.log('\n5. history is a log: the dot, the recovery key, undo, replace\n')
{
  const store = new Store(mkDoc())
  store.commit(() => { store.doc.pages[0].blocks[0].html = 'edited' })
  store.setDirty(false)
  const key = docContentKey(store.doc)
  const rev = store.revision
  recordOnSave(store)
  ok(revisionsOf(store.doc).length === 1, 'recorded')
  ok(docContentKey(store.doc) === key, 'recording does not change the recovery key — no phantom "unsaved changes" banner')
  ok(store.dirty === false && store.revision === rev, 'recording does not raise the unsaved dot or advance the revision')
  ok(SPACES_NOT_EDIT.has('revisions') && !SPACES_NOT_EDIT.has('trail'), 'revisions is a not-edit field; trail is left to its own feature')

  // undo after a save must not un-record the revision that save wrote
  store.commit(() => { store.doc.pages[0].blocks[0].html = 'edited again' })
  recordOnSave(store)
  const two = J(store.doc.revisions)
  store.undo()
  ok(store.doc.pages[0].blocks[0].html === 'edited' && J(store.doc.revisions) === two, '⌘Z undoes the edit and keeps both revisions')
  store.redo()
  ok(J(store.doc.revisions) === two, '⌘⇧Z too')

  // Replace from JSON with Copy document JSON's output (which drops history)
  const pasted = clone(store.doc) as SpacesDoc & Obj
  delete pasted.revisions
  pasted.title = 'Pasted'
  store.replaceDoc(pasted)
  ok(store.doc.title === 'Pasted' && J(store.doc.revisions) === two, 'a whole-document replace keeps the LIVE history (a paste never deletes it)')
  const forged = clone(store.doc) as SpacesDoc & Obj
  forged.revisions = [{ id: 'forged', at: 't', body: { doc: { title: 'x' } } }] as never
  store.replaceDoc(forged)
  ok(J(store.doc.revisions) === two, '…and never installs the pasted document\'s history either')
}

// ---------------------------------------------------------------------------
console.log('\n6. a crafted revision cannot smuggle identity, capability or script\n')
{
  const store = new Store(mkDoc())
  recordOnSave(store)
  const crafted = clone(store.doc.revisions!) as unknown as Obj[]
  crafted.push({
    id: 'evil', at: '2026-10-10T00:00:00Z',
    body: {
      doc: { docId: 'someone-else', collab: { room: 'attacker', key: 'x', on: true }, readonly: false, template: true, title: 'Owned' },
      pages: [{ id: 'p1', put: [{ id: 'b1', type: 'p', html: 'hi <img src=x onerror="alert(1)"><script>alert(2)</script>' }] }],
    },
  })
  ;(store.doc as SpacesDoc & Obj).revisions = crafted as never
  ok(revisionsOf(store.doc).length === 2, 'the crafted entry is a readable patch (the gate, not the parser, is what stops it)')
  const next = restoredDoc(store.doc, 1)!
  ok(next.docId === 'd-hist' && (next.collab as Obj).room === 'wROOM' && !('template' in next),
    'body.doc only ever applies COVERED fields — docId, collab and the modes are ignored')
  ok(next.title === 'Owned', '…while a covered field in it does apply')
  ok(restoreInto(store, J(next)), 'restored through the gate')
  const html = store.doc.pages[0].blocks[0].html ?? ''
  ok(!/onerror|<script/i.test(html) && /hi/.test(html), `block html is sanitized on the way in (${J(html)})`)
  ok(store.doc.docId === 'd-hist' && (store.doc.collab as Obj).room === 'wROOM', 'identity and the room are the live space\'s')
}

// ---------------------------------------------------------------------------
console.log('\n7. randomised edit sequences\n')
{
  let seed = 12345
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const pick = (n: number) => Math.floor(rnd() * n)
  let good = 0
  const total = 200
  for (let s = 0; s < total; s++) {
    const d = mkDoc()
    const stamps: string[] = []
    for (let step = 0; step < 8; step++) {
      const pages = d.pages
      switch (pick(8)) {
        case 0: if (pages.length) pages[pick(pages.length)].title = `T${step}`; break
        case 1: { const p = pages[pick(pages.length)]; if (p && p.blocks.length) p.blocks[pick(p.blocks.length)].html = `edit ${s}.${step}`; break }
        case 2: pages.push({ id: `np${pick(4)}`, title: `N${step}`, blocks: [{ id: `nb${step}`, type: 'p', html: 'x' }] }); break
        case 3: if (pages.length > 1) pages.splice(pick(pages.length), 1); break
        case 4: if (pages.length > 1) { const [m] = pages.splice(pick(pages.length), 1); pages.splice(pick(pages.length + 1), 0, m) } break
        case 5: if (rnd() < 0.5) d.footnotes = { [step]: `note ${s}.${step}` }; else delete d.footnotes; break
        case 6: if (rnd() < 0.5) d.design = `d${step}`; else delete d.design; break
        default: {
          const p = pages[pick(pages.length)]
          if (!p) break
          if (p.blocks.length > 1) { const [b] = p.blocks.splice(pick(p.blocks.length), 1); p.blocks.unshift(b) }
          else p.blocks.push({ id: `xb${step}`, type: 'p', html: 'added' })
        }
      }
      const seen = new Set<string>()
      d.pages = d.pages.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
      if (recordRevision(d)) stamps.push(J(contentOf(d)))
    }
    const revs = revisionsOf(d)
    let seqOk = revs.length === stamps.length
    for (let i = 0; i < revs.length && seqOk; i++) if (J(contentOf(restoredDoc(d, i)!)) !== stamps[i]) seqOk = false
    if (seqOk) good++
  }
  ok(good === total, `${total} randomised sequences (pages, blocks, footnotes, design; create/delete/reorder/resurrect): every revision restores byte-exactly (${good}/${total})`)
}

// ---------------------------------------------------------------------------
console.log('\n8. the word diff and the derived summary\n')
{
  const parts = diffWords('the quick brown fox', 'the quick red fox')
  ok(parts.filter((p) => p.op === 'del').map((p) => p.text).join('') === 'brown' &&
    parts.filter((p) => p.op === 'ins').map((p) => p.text).join('') === 'red', 'WORD granularity: brown → red')
  const n = diffWords('we grew 30 percent', 'we grew 60 percent')
  ok(n.filter((p) => p.op === 'del').map((p) => p.text).join('') === '30', '"30" → "60" is a whole word, not one glyph')
  const pairs: Array<[string, string]> = [
    ['the quick brown fox', 'the quick red fox'], ['', 'all new'], ['all gone', ''], ['a b c d', 'd c b a'],
    ['one\ntwo\nthree', 'one\ntwo and a half\nthree'], ['same', 'same'], ['  lead  ', ' lead '], ['naïve café', 'naive cafe'],
  ]
  let both = 0
  for (const [a, b] of pairs) {
    const p = diffWords(a, b)
    if (p.filter((x) => x.op !== 'ins').map((x) => x.text).join('') === a && p.filter((x) => x.op !== 'del').map((x) => x.text).join('') === b) both++
  }
  ok(both === pairs.length, `reject-all == old and accept-all == new, for all ${pairs.length} pairs`)

  const d = mkDoc()
  recordRevision(d)
  d.pages[0].blocks[0].html = 'the quick red fox'
  d.pages.splice(1, 1)
  recordRevision(d)
  d.footnotes = { 1: 'only the note changed' }
  recordRevision(d)
  const revs = revisionsOf(d)
  ok(changesAt(revs, 0).first, 'the first revision is reported as the first — there is nothing before it')
  const rep = changesAt(revs, 1)
  ok(rep.pagesChanged === 2 && rep.blocksChanged === 2 && rep.pages.some((p) => p.kind === 'removed' && p.title === 'Two'),
    `the counts behind the summary are derived from the patch (${rep.pagesChanged} pages, ${rep.blocksChanged} blocks)`)
  const r2 = changesAt(revs, 2)
  ok(r2.pagesChanged === 0 && J(r2.fieldsChanged) === J(['footnotes']), `a change outside the pages is reported by field (${r2.fieldsChanged.join(',')})`)
  ok(revs.every((r) => !Object.hasOwn(r, 'label')), 'and nothing language-bearing is stored: the sentence is made at render time')
}

// ---------------------------------------------------------------------------
console.log('\n9. cost on a real space, and what leaves it\n')
{
  const d = starterDoc()
  const contentBytes = B(contentOf(d))
  recordRevision(d)
  const base = B(d.revisions)
  let before = base
  const deltas: number[] = []
  for (let i = 0; i < 20; i++) {
    const p = d.pages[i % d.pages.length]
    if (p.blocks.length) p.blocks[0].html = `${p.blocks[0].html ?? ''} — edited pass ${i}`
    recordRevision(d)
    const now = B(d.revisions)
    deltas.push(now - before)
    before = now
  }
  const avg = Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length)
  console.log(`     starter space: content ${contentBytes} B · base revision ${base} B · 20 saves +${before - base} B (avg ${avg}, worst ${Math.max(...deltas)}) · total ${before} B of ${HISTORY_BUDGET}`)
  ok(avg * 10 < contentBytes, `an ordinary save costs an order of magnitude less than a whole snapshot (${avg} B vs ${contentBytes} B)`)
  ok(before < HISTORY_BUDGET && revisionsOf(d).length === 21, '21 saves of the starter space fit without folding')
  const ex = extractSpace(d, d.pages[0].id, { docId: 'ex-1', subtree: false })
  ok(!Object.hasOwn(ex.doc, 'revisions'), 'a page extract carries no history (the copy table\'s history class, portable.ts)')
}

// ---------------------------------------------------------------------------
console.log('\n10. encrypted spaces: in the envelope, never in IndexedDB (source)\n')
{
  const root = process.cwd()
  const hsrc = readFileSync(join(root, 'spaces/src/history.ts'), 'utf8')
  const main = readFileSync(join(root, 'spaces/src/main.ts'), 'utf8')
  ok(!/autosave|indexedDB|putRecovery|addVersion|localStorage/.test(hsrc.replace(/\/\/.*$/gm, '')),
    'history.ts touches no browser storage — revisions live only in the document')
  const doSave = main.slice(main.indexOf('async function doSave('), main.indexOf('editor.onUpdateInPlace'))
  ok(/recordOnSave\(store\)/.test(doSave) && !/isEncryptionActive\(\)[^\n]*recordOnSave/.test(doSave),
    'the save records unconditionally — an encrypted space keeps history, inside #bento-doc\'s envelope')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
