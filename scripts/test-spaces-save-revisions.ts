// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { Store: SpacesStore } = await import('../spaces/src/store.ts')
const { parseDoc: parseSpace } = await import('../spaces/src/model.ts')
import { SaveQueue } from '../kernel/src/savequeue.ts'
const space = parseSpace(JSON.stringify({ format: 'bento/spaces', version: 1, docId: 's', title: 'Space', pages: [{ id: 'p', title: 'Page', blocks: [{ id: 'b', type: 'p', html: 'before' }] }] }))
assert(space.ok)
const s = new SpacesStore(space.doc)
const q = new SaveQueue({ getDocument: () => s.doc, getRevision: () => s.revision })
s.runEdit('b', () => { s.doc.pages[0].blocks[0].html = 'first' })
let release!: () => void
const first = q.run(() => s.endRun(), async doc => { await new Promise<void>(r => { release = r }); return doc.pages[0].blocks[0].html })
await Promise.resolve()
// Two inputs while already dirty; the second does not emit a doc notification.
s.runEdit('b', () => { s.doc.pages[0].blocks[0].html = 'second' })
const revision = s.revision
s.runEdit('b', () => { s.doc.pages[0].blocks[0].html = 'third' })
assert(s.revision > revision)
release()
const saved = await first
assert.equal(saved!.value, 'first')
assert.equal(saved!.isCurrent(), false)
s.endRun()
const remote = await q.run(() => {}, async () => true)
s.doc.pages[0].blocks[0].html = 'remote'
s.setDirty(true)
assert.equal(remote!.isCurrent(), false, 'remote change invalidates a save even while already dirty')

console.log('spaces save revisions: grouped typing and already-dirty remote changes passed')

// ---- the race, through the code ⌘S runs (spaces/src/saving.ts) --------------
//
// Every case below drives saveRevision — the function main.ts's doSave calls —
// against a gated fake write, so each one can hold a write open, edit under it,
// then let it land. The write records the bytes it was handed, which is what a
// file on disk would hold.
const { saveRevision } = await import('../spaces/src/saving.ts')

let failures = 0
function check(cond: boolean, what: string): void {
  if (cond) console.log(`  ok  ${what}`)
  else { failures++; console.error(`  FAIL ${what}`) }
}

type Gate = { bytes: string; release: () => void; fail: (e: Error) => void }
function harness() {
  const p = parseSpace(JSON.stringify({ format: 'bento/spaces', version: 1, docId: 'race', title: 'Race', pages: [{ id: 'p', title: 'Page', blocks: [{ id: 'b', type: 'p', html: 'one' }] }] }))
  assert(p.ok)
  const store = new SpacesStore(p.doc)
  const queue = new SaveQueue({ getDocument: () => store.doc, getRevision: () => store.revision })
  const gates: Gate[] = []
  let open = 0, maxOpen = 0
  const write = (snapshot: any) => new Promise<'saved'>((resolve, reject) => {
    open++; maxOpen = Math.max(maxOpen, open)
    // the bytes are taken when the write starts, as saveFile's serializer does
    gates.push({
      bytes: snapshot.pages[0].blocks[0].html,
      release: () => { open--; resolve('saved') },
      fail: (e) => { open--; reject(e) },
    })
  })
  const save = () => saveRevision(store, queue, write)
  const html = () => store.doc.pages[0].blocks[0].html
  const edit = (v: string) => store.commit(() => { store.doc.pages[0].blocks[0].html = v })
  const type = (v: string) => store.runEdit('b', () => { store.doc.pages[0].blocks[0].html = v })
  const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
  return { store, gates, save, html, edit, type, tick, maxOpen: () => maxOpen }
}

console.log('\nan edit committed while the write is in flight')
{
  const h = harness()
  h.edit('two')
  const first = h.save()
  await h.tick()
  check(h.gates.length === 1, 'the write started')
  h.edit('three')                         // lands after the bytes were taken
  h.gates[0].release()
  const out = await first
  check(out.kind === 'written' && !out.current, 'the write is acknowledged as STALE')
  check(h.gates[0].bytes === 'two', 'it wrote the revision it captured ("two")')
  check(h.store.dirty === true, 'the document is STILL DIRTY after the older write resolved')
  const second = h.save()
  await h.tick()
  check(h.gates[1]?.bytes === 'three', 'the edit reaches the next write')
  h.gates[1]?.release()
  const out2 = await second
  check(out2.kind === 'written' && out2.current, 'the next write is current')
  check(h.store.dirty === false, 'and only then does the dot go out')
}

console.log('\na keystroke inside a typing run while the write is in flight')
{
  const h = harness()
  h.type('ty')
  const first = h.save()                  // closes the run, then snapshots
  await h.tick()
  h.type('typ')                           // a NEW run, mid-write
  h.gates[0].release()
  await first
  check(h.gates[0].bytes === 'ty', 'the write holds the text as it was at ⌘S')
  check(h.store.dirty === true, 'the keystroke typed during the write keeps the dot on')
}

console.log('\na failed write')
{
  const h = harness()
  h.edit('two')
  const first = h.save()
  await h.tick()
  h.gates[0].fail(new Error('disk full'))
  const out = await first
  check(out.kind === 'failed' && (out as any).error?.message === 'disk full', 'the failure is reported, not swallowed or thrown')
  check(h.store.dirty === true, 'a failed write leaves the document dirty')
  const again = h.save()
  await h.tick()
  check(h.gates.length === 2 && h.gates[1].bytes === 'two', 'the queue is not poisoned: the next save writes')
  h.gates[1]?.release()
  const out2 = await again
  check(out2.kind === 'written' && out2.current && h.store.dirty === false, 'and that one clears the dot')
}

console.log('\nback-to-back saves')
{
  const h = harness()
  h.edit('two')
  const a = h.save()
  const b = h.save()                      // pressed again before the first landed
  await h.tick()
  check(h.gates.length === 1, 'the second write waits for the first (no overlap on one handle)')
  h.edit('three')
  h.gates[0].release()
  const outA = await a
  await h.tick()
  check(outA.kind === 'written' && !outA.current && h.store.dirty === true, 'the first is stale and the dot stays on')
  check(h.gates.length === 2 && h.gates[1].bytes === 'three', 'the second captured its revision only when it STARTED')
  h.gates[1]?.release()
  const outB = await b
  check(outB.kind === 'written' && outB.current && h.store.dirty === false, 'the second is current and clears the dot')
  check(h.maxOpen() === 1, 'never more than one write open at once')
}

console.log('\na remote change while the write is in flight')
{
  const h = harness()
  h.edit('two')
  const first = h.save()
  await h.tick()
  // what the kernel session does: mutate doc directly, then setDirty(true)
  h.store.doc.pages[0].blocks[0].html = 'remote'
  h.store.setDirty(true)
  h.gates[0].release()
  const out = await first
  check(out.kind === 'written' && !out.current && h.store.dirty === true, 'a colleague’s edit mid-write keeps the dot on')
}

console.log('\nan undo while the write is in flight')
{
  const h = harness()
  h.edit('two')
  const first = h.save()
  await h.tick()
  h.store.undo()
  h.gates[0].release()
  const out = await first
  check(out.kind === 'written' && !out.current && h.store.dirty === true, 'an undo mid-write keeps the dot on')
  check(h.html() === 'one', 'and the undo held')
}

// ---- collab.sync is stamped in the queue's prepare (#594 × the save queue) ---
// The stamp must describe exactly the bytes written: taken after any write
// ahead of this one, immediately before the snapshot is copied. `started` is
// that prepare step, so a stamp made there must be IN the snapshot the write
// receives, and a save queued behind another stamps at its own start.
console.log('\ncollab.sync is stamped in prepare, inside the snapshot')
{
  const p = parseSpace(JSON.stringify({ format: 'bento/spaces', version: 1, docId: 'stamp', title: 'Stamp', pages: [{ id: 'p', title: 'Page', blocks: [{ id: 'b', type: 'p', html: 'one' }] }] }))
  assert(p.ok)
  const store = new SpacesStore(p.doc)
  const queue = new SaveQueue({ getDocument: () => store.doc, getRevision: () => store.revision })
  let n = 0
  const stamp = () => { (store.doc as any).collab = { sync: { mark: ++n } } }
  const written: number[] = []
  const gates: Array<() => void> = []
  const write = (snapshot: any) => new Promise<'saved'>((resolve) => {
    written.push(snapshot.collab?.sync?.mark ?? 0)
    gates.push(() => resolve('saved'))
  })
  const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
  store.commit(() => { store.doc.pages[0].blocks[0].html = 'two' })
  const a = saveRevision(store, queue, write, stamp)
  const b = saveRevision(store, queue, write, stamp)
  await tick()
  check(written.length === 1 && written[0] === 1, 'the first write carries the stamp made in its own prepare')
  gates[0]()
  await a
  await tick()
  check(written.length === 2 && written[1] === 2, 'a save queued behind it stamps again at its own start, not when it was asked for')
  gates[1]()
  const out = await b
  check(out.kind === 'written' && out.current, 'stamping in prepare does not make the write stale')
}

// The wiring: the code ⌘S and "Update this file" run passes the stamp into
// the queue's prepare. Removing it fails no behavioural rig on its own (#594's
// proof of this path was a browser probe), so the call sites are pinned here.
console.log('\nmain.ts stamps inside the queue for both writes of this file')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../spaces/src/main.ts', import.meta.url), 'utf8')
  const doSave = src.match(/saveRevision\(store, saves,[\s\S]*?\)\)/)?.[0] ?? ''
  check(/stampSync\(store, session\)/.test(doSave), '⌘S passes stampSync as the prepare step of saveRevision')
  const inPlace = src.match(/editor\.onUpdateInPlace = async[\s\S]*?saves\.run\(([\s\S]*?)applyUpdateInPlace/)?.[1] ?? ''
  check(/stampSync\(store, session\)/.test(inPlace), '"Update this file" stamps in the queue\'s prepare too')
}

// ---- the in-file revision is recorded in prepare, inside the snapshot ------
// history.ts recordOnSave runs in the same prepare step as the stamp, so the
// revision describes exactly the bytes written and those bytes contain it.
// Recording writes doc.revisions directly — never through commit — so it must
// not advance the store's revision (the write is not stale), not raise the
// unsaved dot, and not change the recovery key (docclass.ts SPACES_NOT_EDIT).
console.log('\nthe in-file revision is recorded in prepare, inside the snapshot')
{
  const { recordOnSave, revisionsOf, applyRevisions, contentOf } = await import('../spaces/src/history.ts')
  const { docContentKey } = await import('../spaces/src/model.ts')
  const p = parseSpace(JSON.stringify({ format: 'bento/spaces', version: 1, docId: 'hist', title: 'Hist', pages: [{ id: 'p', title: 'Page', blocks: [{ id: 'b', type: 'p', html: 'one' }] }] }))
  assert(p.ok)
  const store = new SpacesStore(p.doc)
  const queue = new SaveQueue({ getDocument: () => store.doc, getRevision: () => store.revision })
  const written: any[] = []
  const gates: Array<() => void> = []
  const write = (snapshot: any) => new Promise<'saved'>((resolve) => {
    written.push(JSON.parse(JSON.stringify(snapshot)))
    gates.push(() => resolve('saved'))
  })
  const prepare = () => { recordOnSave(store) }
  const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

  store.commit(() => { store.doc.pages[0].blocks[0].html = 'two' })
  const keyBefore = docContentKey(store.doc)
  const revBefore = store.revision
  const a = saveRevision(store, queue, write, prepare)
  // queued behind `a`, asked for NOW — and an edit lands before it starts
  const b = saveRevision(store, queue, write, prepare)
  await tick()
  check(written.length === 1 && revisionsOf(written[0]).length === 1,
    'the snapshot the write receives contains the revision recorded in its prepare')
  check(JSON.stringify(applyRevisions(revisionsOf(written[0]))) === JSON.stringify(contentOf(written[0])),
    'and that revision restores exactly the content of the bytes written')
  check(store.revision === revBefore && docContentKey(store.doc) === keyBefore,
    'recording advanced no store revision and left the recovery key unchanged')
  store.commit(() => { store.doc.pages[0].blocks[0].html = 'three' })   // lands while `a` is in flight
  gates[0]()
  const outA = await a
  await tick()
  check(outA.kind === 'written' && !outA.current, 'the first write is stale (an edit landed after its snapshot)')
  check(written.length === 2 && revisionsOf(written[1]).length === 2,
    'the save queued behind it recorded at its OWN start: its snapshot carries a second revision')
  check(written[1] && JSON.stringify(applyRevisions(revisionsOf(written[1]))) === JSON.stringify(contentOf(written[1]))
    && written[1].pages[0].blocks[0].html === 'three',
    'and that revision describes the content as it was when the second write began ("three"), not when it was asked for')
  gates[1]()
  const outB = await b
  check(outB.kind === 'written' && outB.current, 'recording in prepare does not make the write stale')
  check(store.dirty === false, 'the dot goes out: recording a revision did not raise it')

  // a save that changed nothing records nothing, and a read-only store never records
  const c = saveRevision(store, queue, write, prepare)
  await tick(); gates[2]?.()
  await c
  check(revisionsOf(store.doc).length === 2, 'a save with no change since the last revision records none')
  store.readOnly = true
  store.doc.pages[0].blocks[0].html = 'frozen edit'
  check(recordOnSave(store) === null && revisionsOf(store.doc).length === 2, 'a read-only store never records (a frozen file round-trips byte-exact)')
}

// The wiring: ⌘S and "Update this file" record in the queue's prepare, beside
// the stamp. Pinned like #594's rows — moving the call outside the queue (back
// to before saveRevision, where #440 had it) fails here.
console.log('\nmain.ts records the revision inside the queue for both writes of this file')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../spaces/src/main.ts', import.meta.url), 'utf8')
  const doSave = src.match(/saveRevision\(store, saves,[\s\S]*?\)\)/)?.[0] ?? ''
  check(/stampSync\(store, session\); recordOnSave\(store\)/.test(doSave), '⌘S records in the prepare step of saveRevision, beside stampSync')
  const inPlace = src.match(/editor\.onUpdateInPlace = async[\s\S]*?saves\.run\(([\s\S]*?)applyUpdateInPlace/)?.[1] ?? ''
  check(/stampSync\(store, session\); recordOnSave\(store\)/.test(inPlace), '"Update this file" records in the queue\'s prepare too')
  check((src.match(/recordOnSave\(|recordRevision\(/g) ?? []).length === 2, 'and nowhere else in main.ts (no second, out-of-queue call)')
}

if (failures) { console.error(`\n${failures} save-race check(s) FAILED`); process.exit(1) }
console.log('\nspaces save race: an edit made during a write stays unsaved until a write that holds it lands')
