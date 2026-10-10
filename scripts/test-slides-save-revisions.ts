// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// The unsaved dot goes out only for the revision that was actually written.
//
//   node scripts/test-slides-save-revisions.ts
//
// WHAT THIS PROVES. Slides cleared its dirty flag after every awaited write —
// auto-save's write-back, ⌘S and Update this file — so an edit made WHILE the
// bytes were on their way was marked saved and never reached disk. Slides now
// writes through the kernel's SaveQueue (slides/src/saving.ts), as spaces and
// dash do. Every case below drives saveRevision — the function the editor
// calls — against a gated fake write, so it can hold a write open, change the
// deck under it, then let it land. The write records the bytes it was handed,
// which is what the file on disk would hold.
//
// The last section checks the wiring: all three of the editor's writes to the
// open file go through the queue, and no path clears the dot unconditionally.

import { readFileSync } from 'node:fs'
import { register } from 'node:module'
register('./lib/ts-resolve-hooks.mjs', import.meta.url)
const { Store } = await import('../slides/src/store.ts')
const { newDoc } = await import('../slides/src/model.ts')
const { createSaveQueue, saveRevision } = await import('../slides/src/saving.ts')

let failures = 0
let checks = 0
function check(cond: boolean, what: string): void {
  checks++
  if (cond) console.log(`  ok    ${what}`)
  else { failures++; console.log(`  FAIL  ${what}`) }
}

type Gate = { title: string; stamp: unknown; release: () => void; fail: (e: Error) => void }
function harness() {
  const doc = newDoc()
  doc.title = 'one'
  const store = new Store(doc)
  const queue = createSaveQueue(store)
  const gates: Gate[] = []
  let open = 0, maxOpen = 0
  const write = (snapshot: any) => new Promise<'saved'>((resolve, reject) => {
    open++; maxOpen = Math.max(maxOpen, open)
    // the bytes are taken when the write starts, as the serializer does
    gates.push({
      title: snapshot.title, stamp: snapshot.collab?.sync,
      release: () => { open--; resolve('saved') },
      fail: (e) => { open--; reject(e) },
    })
  })
  let stamps = 0
  const save = (stamp = false) => saveRevision(store, queue, write,
    stamp ? () => { (store.doc as any).collab = { ...(store.doc as any).collab, sync: `stamp-${++stamps}` } } : undefined)
  const edit = (v: string) => store.commit(() => { store.doc.title = v })
  const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  return { store, gates, save, edit, tick, maxOpen: () => maxOpen }
}

console.log('\nan edit committed while the write is in flight')
{
  const h = harness()
  h.edit('two')
  const first = h.save()
  await h.tick()
  check(h.gates.length === 1 && h.gates[0].title === 'two', 'the write took the deck as it was when it started')
  h.edit('three')                          // lands after the bytes were taken
  h.gates[0].release()
  const out = await first
  check(out.kind === 'written' && out.current === false, 'the write reports it is no longer the deck on screen')
  check(h.store.dirty, 'the deck stays dirty — "three" is not on disk')
  const second = h.save()
  await h.tick()
  check(h.gates[1]?.title === 'three', 'the next save writes the edit')
  h.gates[1].release()
  const out2 = await second
  check(out2.kind === 'written' && out2.current && !h.store.dirty, 'and only then does the dot go out')
}

console.log('\nan edit with no new undo entry (a panel keystroke while already dirty)')
{
  const h = harness()
  h.edit('two')
  const p = h.save()
  await h.tick()
  h.store.doc.title = 'typed'
  h.store.touch()                         // what PropsPanel.edit does mid-burst
  h.gates[0].release()
  await p
  check(h.store.dirty, 'still dirty — touch() advances the revision even when already dirty')
}

console.log('\na remote edit while the write is in flight')
{
  const h = harness()
  h.edit('two')
  const p = h.save()
  await h.tick()
  h.store.doc.title = 'from a collaborator'
  h.store.setDirty(true)                  // what the sync session does, already dirty
  h.gates[0].release()
  await p
  check(h.store.dirty, 'still dirty — a remote op counts as a change')
}

console.log('\nundo while the write is in flight')
{
  const h = harness()
  h.edit('two')
  const p = h.save()
  await h.tick()
  h.store.undo()                          // replaces the document object
  h.gates[0].release()
  const out = await p
  check(out.kind === 'written' && !out.current && h.store.dirty, 'still dirty — the deck on screen is not the one written')
}

console.log('\na write that fails')
{
  const h = harness()
  h.edit('two')
  const p = h.save()
  await h.tick()
  h.gates[0].fail(new Error('disk full'))
  const out = await p
  check(out.kind === 'failed' && h.store.dirty, 'reported as failed, and the deck stays dirty')
  const next = h.save()
  await h.tick()
  check(h.gates.length === 2, 'the queue is not poisoned — the next save still runs')
  h.gates[1].release()
  await next
  check(!h.store.dirty, 'and it clears the dot')
}

console.log('\nback-to-back saves (⌘S while auto-save writes)')
{
  const h = harness()
  h.edit('two')
  const a = h.save()
  h.edit('three')
  const b = h.save()
  await h.tick()
  check(h.gates.length === 1, 'the second write waits for the first')
  h.gates[0].release()
  await a
  await h.tick()
  check(h.gates[1]?.title === 'three', 'and takes its own snapshot when it starts')
  h.gates[1].release()
  await b
  check(h.maxOpen() === 1 && !h.store.dirty, 'never two writes at once; clean at the end')
}

console.log('\nthe live-session stamp is taken when each write starts')
{
  const h = harness()
  h.edit('two')
  const a = h.save(true)
  const b = h.save(true)
  await h.tick()
  check(h.gates[0].stamp === 'stamp-1', 'the first write carries its own stamp')
  h.gates[0].release()
  await a
  await h.tick()
  check(h.gates[1]?.stamp === 'stamp-2', 'a write queued behind it stamps at its own start, not at the click')
  h.gates[1].release()
  await b
}

console.log('\na save with nothing changed under it')
{
  const h = harness()
  h.edit('two')
  const p = h.save()
  await h.tick()
  h.gates[0].release()
  const out = await p
  check(out.kind === 'written' && out.current && !h.store.dirty, 'clears the dot')
}

console.log('\nthe editor writes through the queue')
{
  const src = readFileSync(new URL('../slides/src/editor/editor.ts', import.meta.url), 'utf8')
  const body = (sig: string, len = 2400) => { const i = src.indexOf(sig); return i < 0 ? '' : src.slice(i, i + len) }
  const auto = body('private async runAutosave()')
  const manual = body('async save(forcePicker: boolean)')
  const update = body("inPlaceB.addEventListener('click', async () => {", 1200)
  check(/saveRevision\(this\.store, this\.saveQueue,[\s\S]*writeUpdatedFile\(await serializeAuto\(snapshot\)\)/.test(auto), 'auto-save writes the queue\'s snapshot')
  check(/saveRevision\(this\.store, this\.saveQueue,[\s\S]*saveFile\(snapshot, forcePicker\)/.test(manual), '⌘S and Save a copy write the queue\'s snapshot')
  check(/saveRevision\(this\.store, this\.saveQueue,[\s\S]*applyUpdateInPlace\(release, snapshot\)/.test(update), 'Update this file writes the queue\'s snapshot')
  const clears = [...src.matchAll(/^.*setDirty\(false\).*$/gm)].map((m) => m[0].trim()).filter((l) => !l.startsWith('//'))
  check(clears.length === 1 && /if \(outcome\.current\)/.test(clears[0]), `no unconditional clear left (${clears.join(' | ') || 'none'})`)
  check(/\(\) => this\.session\?\.stampInto\(this\.store\.doc\)\)/.test(auto) && /\(\) => this\.session\?\.stampInto\(this\.store\.doc\)\)/.test(manual),
    'the CRDT stamp happens in the queue\'s prepare step, for auto-save and ⌘S')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
