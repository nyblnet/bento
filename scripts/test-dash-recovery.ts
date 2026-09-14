#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash recovery + drop-open rig — the decisions, not the banner.
//
//   node scripts/test-dash-recovery.ts     (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. Both features are a single yes/no taken at boot or on a
// gesture, and both of them do damage in the SAME direction when the answer is
// wrong: they put a document on screen that is not the one in the file.
//
//   1. THE CONTENT KEY. It decides whether there is unsaved work at all. Too
//      LOOSE (comparing whole JSON, timestamps included) and a banner claiming
//      lost work appears on every open — which trains the reader to dismiss the
//      one that matters. Too TIGHT (a whitelist of known fields) and an edit to
//      a field this build does not know about reads as "nothing changed", which
//      is a silent loss of somebody else's data in an additive format.
//   2. THE REFUSALS. Three of them are safety, not tidiness: an encrypted
//      workbook is never snapshotted, so any snapshot under its docId is
//      pre-encryption PLAINTEXT; a read-only or frozen workbook must not be
//      written; a snapshot this build cannot parse must not be behind a live
//      Restore button.
//   3. THE ROUTING. A dropped file goes to exactly one of three importers, and
//      anything else is refused BY NAME. The dangerous case is the near miss —
//      `.xls` is not `.xlsx` (OLE, not ZIP), so accepting it fails deep inside
//      the reader instead of in a sentence the reader can act on.
//
// The DOM halves — the banner's buttons, the capture-phase drag handlers, the
// FileSystemHandle adoption — need a real browser and a real drag, and are
// called out as unverified in the report rather than faked here.

import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

// recovery.ts imports its own stylesheet (and dropopen.ts reaches it through
// recovery.ts). Vite's job; Node refuses the extension outright. Same stub
// test-dash-about.ts uses.
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { contentKey, decide, VOLATILE_KEYS } = await import('../dash/src/recovery.ts')
const { classifyDrop, refusalFor } = await import('../dash/src/dropopen.ts')
const { FORMAT, FORMAT_VERSION, parseDoc } = await import('../dash/src/model.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc
type Snapshot = import('../kernel/src/autosave.ts').Snapshot

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

// A minimal but REAL workbook: parseDoc has to accept it, because `decide`
// parses the snapshot rather than trusting it.
function workbook(extra: Partial<DashDoc> = {}): DashDoc {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    docId: 'doc-1',
    title: 'Q3',
    sheets: [{
      id: 'sheet-1',
      kind: 'table',
      name: 'Data',
      columns: [{ id: 'region', name: 'Region', type: 'text' },
        { id: 'value', name: 'Value', type: 'number' }],
      rids: [[1, 2]],
      data: {
        region: { enc: 'raw', v: ['North', 'South'] },
        value: { enc: 'raw', v: [10, 20] },
      },
    }],
    ...extra,
  } as DashDoc
}

const snapOf = (doc: DashDoc, at = 1_700_000_000_000): Snapshot =>
  ({ docId: doc.docId, at, title: doc.title, json: JSON.stringify(doc) })

/**
 * The workbook AS THE APP HOLDS IT.
 *
 * Every live document in dash is `parseDoc` output — the boot dispatcher,
 * About's replace-from-JSON, `window.bento.loadDoc`, and drop-open all go
 * through it — and parseDoc NORMALIZES (it fills a missing `steps: []` on every
 * sheet, among other things). Comparing a hand-built object would therefore be
 * testing a state the app never reaches, and would report a difference that
 * exists only in the rig.
 */
function loaded(extra: Partial<DashDoc> = {}): DashDoc {
  const r = parseDoc(JSON.stringify(workbook(extra)))
  if (!r.ok) throw new Error('the rig fixture is not a valid workbook')
  return r.doc
}

// ------------------------------------------------------------- content key
{
  const a = workbook()
  const b = workbook()
  ok(contentKey(a) === contentKey(b), 'two identical workbooks have the same content key')

  ok(contentKey(workbook({ modified: '2026-01-01T00:00:00Z' })) === contentKey(a),
    '`modified` does not count — a save stamps it and nothing else changed')
  ok(contentKey(workbook({ collab: { room: 'w-abc', sync: { v: 2 } } })) === contentKey(a),
    '`collab` does not count — sync state is stamped into the file on save')
  ok(VOLATILE_KEYS.length === 2,
    'exactly two fields are volatile; adding a third is a decision, not an oversight')

  ok(contentKey(workbook({ title: 'Q4' })) !== contentKey(a), 'a retitle counts')

  const edited = workbook()
  ;(edited.sheets[0] as { data: Record<string, { enc: 'raw'; v: unknown[] }> }).data.value.v[1] = 21
  ok(contentKey(edited) !== contentKey(a), 'a single changed CELL counts — the whole point')

  // additivity: the format keeps fields this build cannot name (PLATFORM §3)
  ok(contentKey(workbook({ somethingNewerBuildsWrite: { n: 1 } } as Partial<DashDoc>)) !== contentKey(a),
    'an UNKNOWN top-level field counts — a whitelist would call somebody else’s data "no change"')

  // key order is an artefact of how each object was built, not content
  const reordered = JSON.parse(JSON.stringify(
    { sheets: a.sheets, title: a.title, docId: a.docId, version: a.version, format: a.format },
  )) as DashDoc
  ok(contentKey(reordered) === contentKey(a),
    'key ORDER does not count — otherwise a reparse shows a banner for nothing')

  const undef = workbook({ theme: undefined })
  ok(contentKey(undef) === contentKey(a),
    'an explicitly-undefined field equals an absent one — a JSON round trip erases it anyway')

  // …but the CONTENTS of an array keep their order: row 3 is row 3
  const swapped = workbook()
  ;(swapped.sheets[0] as { data: Record<string, { enc: 'raw'; v: unknown[] }> }).data.region.v = ['South', 'North']
  ok(contentKey(swapped) !== contentKey(a), 'ROW order counts — arrays are data, not a key set')
}

// ---------------------------------------------------------------- decide
{
  const doc = loaded()
  const edited = loaded({ title: 'Q3 (revised)' })
  const base = { doc, encrypted: false, readOnly: false }

  const yes = decide({ ...base, snapshot: snapOf(edited) })
  ok(yes.offer && yes.doc.title === 'Q3 (revised)' && yes.at === 1_700_000_000_000,
    'a snapshot that differs is offered, with its timestamp and its document')

  const same = decide({ ...base, snapshot: snapOf(doc) })
  ok(!same.offer && same.why === 'same',
    'a snapshot matching the file is NOT offered — the file already has these edits')

  const none = decide({ ...base, snapshot: null })
  ok(!none.offer && none.why === 'none', 'no snapshot, no banner')

  const enc = decide({ ...base, snapshot: snapOf(edited), encrypted: true })
  ok(!enc.offer && enc.why === 'encrypted',
    'an ENCRYPTED workbook is never offered a snapshot — it would be pre-encryption plaintext')

  const ro = decide({ ...base, snapshot: snapOf(edited), readOnly: true })
  ok(!ro.offer && ro.why === 'read-only',
    'a read-only or frozen workbook is not offered a restore it cannot perform')

  const junk = decide({ ...base, snapshot: { ...snapOf(edited), json: '{not json' } })
  ok(!junk.offer && junk.why === 'unreadable', 'an unparseable snapshot is not put behind a live button')

  const foreign = decide({ ...base, snapshot: { ...snapOf(edited), json: JSON.stringify({ format: 'bento/slides', slides: [] }) } })
  ok(!foreign.offer && foreign.why === 'unreadable', 'a snapshot that is not a bento/dash workbook is refused')

  const other = decide({ ...base, snapshot: { ...snapOf(edited), docId: 'doc-2' } })
  ok(!other.offer && other.why === 'other-doc',
    'a snapshot filed under another docId is refused even though the store keys by docId')

  // ORDER OF THE GUARDS: encryption is checked before anything is even looked
  // at, so a corrupt snapshot cannot change the answer for a locked workbook.
  const encFirst = decide({ ...base, snapshot: { ...snapOf(edited), json: '{' }, encrypted: true })
  ok(!encFirst.offer && encFirst.why === 'encrypted', 'the encryption refusal comes first')

  // The ordinary case, and the one the user meets on every single open: the
  // file was saved (so it carries `modified`) a moment after the snapshot was
  // written (which did not). Nothing was lost; say nothing.
  const stamped = loaded({ modified: '2026-08-06T09:00:00Z' })
  const quiet = decide({ doc: stamped, encrypted: false, readOnly: false, snapshot: snapOf(loaded()) })
  ok(!quiet.offer && quiet.why === 'same',
    'a saved file and its pre-save snapshot are the same workbook, not unsaved work')

  // A snapshot written by an OLDER build, before some field became part of what
  // parse fills in (`steps: []` is one such field today). Both sides are parsed
  // before they are compared, which is what makes this quiet; comparing the
  // snapshot's raw JSON to the parsed document would show a banner on every
  // open after any such change to parseDoc.
  const older = decide({ ...base, snapshot: snapOf(workbook()) })
  ok(!older.offer && older.why === 'same',
    'a snapshot predating a parse-time normalization is still recognised as the same workbook')
}

// ------------------------------------------------------------- drop routing
{
  ok(classifyDrop('Q3-board.bento.html') === 'workbook', 'a .bento.html is a workbook')
  ok(classifyDrop('export.html') === 'workbook', 'a plain .html is tried as a workbook')
  ok(classifyDrop('SALES.CSV') === 'delimited', 'case does not matter')
  ok(classifyDrop('sales.tsv') === 'delimited', 'a .tsv is delimited')
  ok(classifyDrop('book.xlsx') === 'xlsx', 'an .xlsx is Excel')
  ok(classifyDrop('macro.xlsm') === 'xlsx', 'an .xlsm is the same ZIP container')

  ok(classifyDrop('legacy.xls') === null,
    'a .xls is REFUSED — it is an OLE compound file and the reader takes a ZIP')
  ok(classifyDrop('photo.png') === null, 'an image is refused')
  ok(classifyDrop('notes.txt') === null,
    'a .txt is refused — its delimiter is a guess, and guessing is what import.ts exists not to do')
  ok(classifyDrop('') === null, 'a nameless drop is refused rather than routed')
  ok(classifyDrop('data.csv.bak') === null, 'the LAST extension decides')

  ok(refusalFor('photo.png').includes('photo.png'),
    'the refusal names the file that was dropped — "unsupported" alone is unactionable')
  ok(/\.bento\.html/.test(refusalFor('photo.png')) && /csv/i.test(refusalFor('photo.png')),
    'and it names what WOULD work')
  ok(/xlsx/i.test(refusalFor('legacy.xls')) && refusalFor('legacy.xls') !== refusalFor('photo.png'),
    'a .xls gets its own line: the fix is one Save As, not "this is not supported"')
  ok(refusalFor('sheet.numbers') !== refusalFor('photo.png'), 'so does a Numbers file')
}

// ------------------------------------------- restoring is REVERSIBLE, both ways
//
// TWO PATHS REPLACE A WHOLE WORKBOOK, and they used to disagree about whether
// doing so could be taken back. The recovery banner held the pre-restore
// document and offered "Undo restore". About's version history asked a
// `confirm()` reading "this cannot be undone" — and then made that true, since
// `Store.replaceDoc` empties both undo stacks and the only object that could
// have got you back was never kept.
//
// `confirm()` is the weaker answer even where it is honest: it asks BEFORE,
// when the reader cannot yet see what they would be agreeing to, rather than
// offering a way back AFTER, when they can. So both paths now call one
// function, and this checks the function and then checks that both callers
// reach it.
//
// The DOM here is a shim, not jsdom: `offerUndoRestore` touches six methods and
// a rig that has to install a browser to prove a button calls a function is a
// rig nobody runs. What it cannot prove is layout, and the banner's position is
// already called out as browser-verified above.
console.log('\nrestoring a whole workbook is reversible, from both surfaces')
{
  interface FakeNode {
    tag: string; className: string; textContent: string; title: string; type: string
    children: FakeNode[]; parent: FakeNode | null
    setAttribute(k: string, v: string): void
    addEventListener(ev: string, fn: () => void): void
    append(...n: FakeNode[]): void
    remove(): void
    click(): void
  }
  const all: FakeNode[] = []
  const make = (tag: string): FakeNode => {
    const handlers: Record<string, Array<() => void>> = {}
    const n: FakeNode = {
      tag, className: '', textContent: '', title: '', type: '',
      children: [], parent: null,
      setAttribute() { /* aria only — nothing here reads it back */ },
      addEventListener(ev, fn) { (handlers[ev] ??= []).push(fn) },
      append(...kids) { for (const k of kids) { k.parent = n; n.children.push(k) } },
      remove() {
        if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n)
        n.parent = null
      },
      click() { for (const fn of handlers.click ?? []) fn() },
    }
    all.push(n)
    return n
  }
  const body = make('body')
  const walk = (n: FakeNode, out: FakeNode[] = []): FakeNode[] => {
    for (const c of n.children) { out.push(c); walk(c, out) }
    return out
  }
  ;(globalThis as Record<string, unknown>).document = {
    createElement: make,
    body,
    querySelector: (sel: string) =>
      walk(body).find((n) => n.className.split(' ').includes(sel.replace('.', ''))) ?? null,
  }

  const { offerUndoRestore, swapWorkbook } = await import('../dash/src/recovery.ts')
  const { Store } = await import('../dash/src/store.ts')

  const original = workbook({ title: 'What is on screen' })
  const restored = workbook({ title: 'The old version' })
  const store = new Store(original)
  let showing = 'sheet-1'
  const host = { store, showingSheet: () => showing, showSheet: (id: string) => { showing = id } }

  ok(swapWorkbook(host, restored) && store.doc.title === 'The old version',
    'a restore swaps the workbook in')

  const bars = () => walk(body).filter((n) => n.className.includes('dxr-bar'))
  offerUndoRestore(host, original, 'Restored the version from Aug 3, 14:02.')
  ok(bars().length === 1, 'and puts ONE bar on screen offering the way back')
  ok(walk(body).some((n) => n.textContent === 'Restored the version from Aug 3, 14:02.'),
    'which says what was restored, and when — not merely that something happened')

  // A SECOND OFFER REPLACES THE FIRST. Two restores in a session must not
  // leave two bars stacked, each holding a different "before".
  offerUndoRestore(host, original, 'Restored again.')
  ok(bars().length === 1, 'a second restore replaces the bar rather than stacking one on top')

  const undo = walk(body).find((n) => n.textContent === 'Undo restore')
  ok(!!undo, 'the bar carries an Undo restore button')
  undo!.click()
  ok(store.doc.title === 'What is on screen',
    'and clicking it puts the workbook that was on screen back — which is the whole claim')
  ok(bars().length === 0, 'the bar goes with it: the offer was taken')

  // ✕ IS NOT UNDO. A reader who means "yes, keep this" must have an exit that
  // is not the one that reverts their restore.
  const store2 = new Store(workbook({ title: 'Live' }))
  const host2 = { store: store2, showingSheet: () => 'sheet-1', showSheet: () => {} }
  swapWorkbook(host2, workbook({ title: 'Restored' }))
  offerUndoRestore(host2, workbook({ title: 'Live' }), 'Restored.')
  const x = walk(body).find((n) => n.textContent === '✕')
  x!.click()
  ok(bars().length === 0 && store2.doc.title === 'Restored',
    'dismissing with ✕ keeps the restored workbook — it is not a second Undo')

  delete (globalThis as Record<string, unknown>).document
}

// ------------------------------------ and BOTH callers actually reach it
//
// The function above is only worth anything if both restore paths go through
// it. Checked against the SOURCE, the way test-dash-actions.ts checks main.ts's
// markup, because the alternative is standing up the whole About dialog to
// prove one call site — and the failure being guarded against is somebody
// reintroducing a `confirm()` in a hurry, which a source check catches exactly.
{
  const readSrc = (rel: string): string =>
    readFileSync(new URL(`../dash/src/${rel}`, import.meta.url), 'utf8')
  const about = readSrc('about.ts')
  const recovery = readSrc('recovery.ts')

  ok(about.includes("import { offerUndoRestore } from './recovery.ts'"),
    'about.ts imports the shared offer rather than growing a second one')
  ok(about.includes('offerUndoRestore(hooks, before,'),
    'and its version restore calls it, holding the pre-restore document')
  ok(!/confirm\(t\('Restore this version/.test(about),
    'the "this cannot be undone" confirm() is gone — it asked before, and was not even true afterwards')
  // The NOTE under the version list, not the whole section — the section still
  // explains in a comment what the confirm() used to say, and that prose is
  // the record of why this changed.
  ok(/t\('Versions are kept in this browser only[^']*offers one undo\.'\)/.test(about),
    'and the version-history note no longer tells the reader restoring is irreversible')
  ok(recovery.includes('offerUndoRestore(host, before,'),
    'the recovery banner reaches the same function, so the two cannot drift apart')

  // The replace-from-JSON path KEEPS its confirm, and that is not an
  // inconsistency: it is fed by a paste of arbitrary text with nothing behind
  // it to offer back, and its own comment says so. Pinned here so a later sweep
  // for confirm() does not remove the one that is load-bearing.
  ok(/confirm\(t\('Replace this workbook with the pasted JSON/.test(about),
    'Replace-from-JSON still confirms first — a paste has no earlier state worth naming')
}

// --- a DROPPED workbook is adopted, like a booted one -------------------------
//
// `adoptOpenedDoc` is what applies `readonly` and re-mints a template's
// identity, and it was called from exactly ONE place: main.ts, the boot path.
// `dropopen.ts` called it zero times. So dropping a read-only workbook onto an
// editable one handed you an editable copy of a file whose author had marked it
// read-only — an enforcement gap in one of the three file modes, invisible
// until somebody relied on it — and dropping a template kept the template's own
// docId, which is the key recovery and sync are stored under.
//
// The ORDERING is the part that will rot if nobody pins it, because both wrong
// orders still compile and one of them silently does nothing:
//
//   · the lock must go on AFTER the swap. `swapWorkbook` returns false when
//     `store.readOnly` is already set (a frozen workbook is defended by every
//     caller, since `replaceDoc` is the load path and does not check). Lock
//     first and the document you were protecting never arrives at all.
//   · the fork must happen BEFORE it. Re-mint afterwards and the store has
//     already taken — and can already have autosaved under — the template's
//     own docId.
{
  const { forkTemplate, applyDocLock, adoptOpenedDoc } = await import('../dash/src/saveui.ts')
  const { Store } = await import('../dash/src/store.ts')

  const tmpl = { ...workbook({}), template: true as const, docId: 'doc-template-original' }
  forkTemplate(tmpl)
  ok(!('template' in tmpl), 'forkTemplate drops the flag, so the opened copy is a workbook and not a stencil')
  ok(tmpl.docId !== 'doc-template-original',
    'and mints a fresh docId — every copy sharing one key is what makes recovery restore a stranger\'s work')

  const plain = { ...workbook({}), docId: 'doc-plain' }
  forkTemplate(plain)
  ok(plain.docId === 'doc-plain', 'a workbook that is not a template keeps its identity')

  const locked = new Store({ ...workbook({}), readonly: true as const })
  ok(!locked.readOnly, 'a Store does not read `readonly` off the document by itself…')
  applyDocLock(locked.doc, locked)
  ok(locked.readOnly, '…so applyDocLock is what actually freezes it')

  const open = new Store(workbook({}))
  applyDocLock({ ...workbook({}) }, open)
  ok(!open.readOnly, 'and an ordinary workbook is left editable')

  // Boot must be unchanged: one call, both halves.
  const booted = new Store({ ...workbook({}), readonly: true as const, template: true as const })
  const bootedDoc = booted.doc as Record<string, unknown>
  adoptOpenedDoc(booted.doc, booted)
  ok(booted.readOnly && !('template' in bootedDoc),
    'adoptOpenedDoc still does both, so the boot path did not change shape')

  // The drop path, in source, because the ordering is the defect and a
  // behavioural check here would need the whole drag.
  const drop = readFileSync(new URL('../dash/src/dropopen.ts', import.meta.url), 'utf8')
  const iFork = drop.indexOf('forkTemplate(res.doc)')
  const iSwap = drop.indexOf('swapWorkbook(host, res.doc)')
  const iLock = drop.indexOf('applyDocLock(res.doc')
  ok(iFork >= 0, 'the drop path forks a dropped template')
  ok(iLock >= 0, 'the drop path applies a dropped workbook’s read-only lock')
  ok(iFork >= 0 && iSwap >= 0 && iFork < iSwap,
    'and it forks BEFORE the swap, so the store never holds the template’s docId')
  ok(iLock >= 0 && iSwap >= 0 && iSwap < iLock,
    'and locks AFTER it, because swapWorkbook refuses to load into an already-locked workbook')
}

// --- both import doors report findings the same way -------------------------
//
// Finding 12 of the bounce test, and it is a defect in a DOOR rather than in a
// feature. `showFindings` renders one bullet per finding, and the MENU import
// path passes it the array — so it does. The DROP path could only hand its host
// a single string, so it `.join(' ')`d fifteen findings first, and budget.xlsx
// arrived as a wall of amber text 224px tall — 31% of a 720px window — with no
// bullets, no grouping by sheet and no link to the column concerned.
//
// Two doors into one feature, and the one people actually use is the one that
// destroyed the structure. Checked on the source because the rendering itself
// belongs to main.ts, and what went wrong was upstream of it: the shape of the
// value handed over.
{
  const drop = readFileSync(new URL('../dash/src/dropopen.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  ok(!/\.join\(' '\)/.test(drop),
    'the drop path no longer flattens its findings into one paragraph')
  ok(/notice\(\[/.test(drop),
    'and hands over the ARRAY, so showFindings can put one bullet per finding')
  ok(/ReadonlyArray<\{ message: string \}>/.test(drop),
    'the host contract admits an array at all — the string-only signature was what forced the join')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
