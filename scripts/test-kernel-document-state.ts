// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
import assert from 'node:assert/strict'
import { changes, reverse } from '../kernel/src/history.ts'
import { copy, equal } from '../kernel/src/documentvalue.ts'
import { SaveQueue } from '../kernel/src/savequeue.ts'

// Different content shapes exercise the shared engine, without adopting a new
// undo policy in those apps. Cell arrays without string ids are atomic values.
const fixtures = [
  { docId: 'deck', title: 'Deck', slides: [{ id: 's', elements: [{ id: 'e', text: 'before', x: 12 }] }] },
  { docId: 'notes', title: 'Notes', pages: [{ id: 'p', blocks: [{ id: 'b', html: '<p>before</p>' }] }] },
  { docId: 'book', title: 'Book', sheets: [{ id: 'sheet', cells: { A1: { value: 4 }, B1: { formula: '=A1*2' } }, rows: [[1, 2], [3, 4]] }] },
]
for (const fixture of fixtures) {
  const before: any = copy(fixture), after: any = copy(before)
  after.title = 'edited'
  if (after.slides) after.slides[0].elements[0].text = 'after'
  if (after.pages) after.pages[0].blocks.push({ id: 'b2', html: 'new' })
  if (after.sheets) { after.sheets[0].cells.A1.value = 7; after.sheets[0].rows[0][0] = 8 }
  const delta = changes(before, after), live = copy(after)
  live.remote = 'colleague'
  const redo = reverse(live, delta)
  assert.deepEqual(live, { ...before, remote: 'colleague' })
  reverse(live, redo)
  assert.deepEqual(live, { ...after, remote: 'colleague' })
  live.title = 'newer remote title'
  reverse(live, delta)
  assert.equal(live.title, 'newer remote title')
}
assert.equal(changes({ modified: 1 }, { modified: 2 }).length, 1, 'kernel has no implicit metadata exclusions')
assert.equal(changes({ modified: 1 }, { modified: 2 }, { ignoreRootKeys: ['modified'] }).length, 0)
assert.equal(changes({ child: { modified: 1 } }, { child: { modified: 2 } }, { ignoreRootKeys: ['modified'] }).length, 1)
const delta = changes({ parent: { child: 1 } }, { parent: { child: 2 } })
const scalar = { parent: 'new remote value' }
assert.deepEqual(reverse(scalar, delta, true), [])
assert.equal(scalar.parent, 'new remote value')
const arrayDelta = changes({ nodes: [{ id: 'a' }, { id: 'b' }] }, { nodes: [{ id: 'b' }, { id: 'a' }] })
const remoteArray = { nodes: [null, 42] }
assert.deepEqual(reverse(remoteArray, arrayDelta), [])
const hostile = JSON.parse('{"__proto__":{"safe":1},"constructor":{"prototype":{"safe":2}}}')
const hostileAfter = copy(hostile); hostileAfter.__proto__.safe = 3
reverse(hostileAfter, changes(hostile, hostileAfter))
assert(equal(hostileAfter, hostile)); assert.equal(({} as any).safe, undefined)

for (const fixture of fixtures) {
  let doc: any = copy(fixture), revision = 0
  const q = new SaveQueue({ getDocument: () => doc, getRevision: () => revision })
  let release!: () => void
  const writes: string[] = []
  const first = q.run(() => {}, async snapshot => {
    writes.push(snapshot.title)
    await new Promise<void>(r => { release = r })
    assert.equal(snapshot.title, fixture.title, 'in-flight snapshot is detached')
    return 'saved'
  })
  await Promise.resolve()
  doc.title = 'typed while saving'; revision++
  const second = q.run(() => { doc.stamp = 'prepared'; revision++ }, async snapshot => {
    assert.equal(snapshot.stamp, 'prepared'); writes.push(snapshot.title); return 'saved'
  })
  assert.equal(writes.length, 1)
  release()
  const previous = await first
  assert.equal(previous!.isCurrent(), false)
  const latest = await second
  assert.deepEqual(writes, [fixture.title, 'typed while saving'])
  assert(latest!.isCurrent())
  doc.title = 'remote edit'; revision++
  assert.equal(latest!.isCurrent(), false, 'ack checks revision when consumed')
  await assert.rejects(q.run(() => { throw Error('prepare failed') }, async () => 'unreachable'))
  await assert.rejects(q.run(() => {}, async () => { throw Error('write failed') }))
  assert.equal((await q.run(() => {}, async () => true))!.value, true)
  const replaced = q.run(() => {}, async () => { throw Error('must not write') })
  doc = { ...doc, docId: 'replacement' }; revision++
  assert.equal(await replaced, undefined)
  const preparedReplacement = await q.run(() => { doc = { ...doc, docId: 'other' } }, async () => { throw Error('must not write') })
  assert.equal(preparedReplacement, undefined)
  const current = await q.run(() => {}, async () => true)
  doc = copy(doc)
  assert.equal(current!.isCurrent(), false, 'replacement object with same id invalidates acknowledgement')
}
console.log('kernel document state: cross-shape reversal, conflict preservation, metadata policy, prototype safety, immutable saves, ordering, stale acknowledgement, failures and replacement passed')
