#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// kernel/src/savequeue.ts + documentvalue.ts — the revision-acknowledged save.
//
//   node scripts/test-savequeue.ts
//
// WHAT THIS PROVES. Every app cleared its dirty flag AFTER an async file write,
// so an edit made WHILE the write was in flight was marked saved and lost. The
// SaveQueue serializes writes against one handle, snapshots the document the
// instant before each write, and exposes isCurrent() the caller checks at
// acknowledgement time — so "saved" is only claimed for a document nothing has
// changed since. These checks pin that contract, and copy()'s detachment +
// prototype safety underneath it.

import { copy } from '../kernel/src/documentvalue.ts'
import { SaveQueue } from '../kernel/src/savequeue.ts'

let failures = 0, checks = 0
function ok(what: string, cond: unknown): void {
  checks++
  if (cond) return
  failures++
  console.error(`  FAIL  ${what}`)
}
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))
// deno-lint-ignore no-explicit-any
type Doc = { docId: string } & Record<string, any>
const host = (get: () => Doc, rev: () => number) => ({ getDocument: get, getRevision: rev })

// ————— copy(): containers cloned, leaves shared, no prototype pollution —————
{
  const src = { a: 1, s: 'x', nest: { list: [{ id: 'e', t: 'v' }] } }
  const c = copy(src)
  ok('copy is a different object', c !== src && c.nest !== src.nest && c.nest.list !== src.nest.list)
  c.nest.list[0].t = 'changed'
  ok('mutating the copy does not touch the source', src.nest.list[0].t === 'v')
  ok('a primitive leaf is shared by value', copy('shared') === 'shared')
  // A hostile __proto__ (as JSON.parse produces it — an own key) must copy as an
  // ORDINARY key via Object.fromEntries, never onto Object.prototype.
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"ok":1}')
  copy(hostile)
  ok('copy() does not pollute Object.prototype', ({} as Record<string, unknown>).polluted === undefined)
}

// ————— writes are serialized against one queue —————
{
  const doc: Doc = { docId: 'd', title: 'x' }
  const q = new SaveQueue(host(() => doc, () => 0))
  const order: string[] = []
  const p1 = q.run(() => {}, async () => { order.push('w1-start'); await tick(20); order.push('w1-end'); return 1 })
  const p2 = q.run(() => {}, async () => { order.push('w2-start'); return 2 })
  await Promise.all([p1, p2])
  ok('the second write waits for the first to finish', order.join(',') === 'w1-start,w1-end,w2-start')
}

// ————— the write sees a DETACHED snapshot, not the live doc —————
{
  const doc: Doc = { docId: 'd', title: 'orig' }
  const q = new SaveQueue(host(() => doc, () => 0))
  let seen = ''
  await q.run(() => {}, async (snap) => { doc.title = 'edited during the write'; await tick(5); seen = snap.title; return 0 })
  ok('the snapshot handed to write is detached from later live edits', seen === 'orig')
}

// ————— isCurrent(): true when unchanged, false after any later edit —————
{
  let doc: Doc = { docId: 'd', title: 'a' }; let rev = 0
  const q = new SaveQueue(host(() => doc, () => rev))
  const saved = await q.run(() => {}, async () => true)
  ok('isCurrent() is true right after a clean save', saved!.isCurrent())
  rev++
  ok('a later revision bump makes it stale', !saved!.isCurrent())
  // a same-id REPLACEMENT of the document object also invalidates it (identity,
  // not just docId — a replaceDoc keeps the id but is a new tree)
  const saved2 = await q.run(() => {}, async () => true)
  ok('current again after re-saving', saved2!.isCurrent())
  doc = { ...doc }
  ok('a same-id replacement object invalidates acknowledgement', !saved2!.isCurrent())
}

// ————— a write queued for a document that is swapped out is discarded —————
{
  let doc: Doc = { docId: 'd', title: 'a' }
  const q = new SaveQueue(host(() => doc, () => 0))
  const slow = q.run(() => {}, async () => { await tick(20); return 'slow' })
  let wrote2 = false
  const second = q.run(() => {}, async () => { wrote2 = true; return 'x' })
  doc = { docId: 'other', title: 'a' } // identity changes before `second` runs
  const res2 = await second
  ok('a queued write whose document was swapped returns undefined', res2 === undefined)
  ok('…and its write never ran', !wrote2)
  await slow
}

// ————— prepare() may stamp state but must not switch documents —————
{
  let doc: Doc = { docId: 'd', title: 'a' }
  const q = new SaveQueue(host(() => doc, () => 0))
  let wrote = false
  const res = await q.run(() => { doc = { docId: 'switched', title: 'a' } }, async () => { wrote = true; return 'x' })
  ok('a prepare that switches documents discards the write', res === undefined)
  ok('…and the write never ran', !wrote)
}

// ————— a rejected write (or prepare) never poisons the queue —————
{
  const doc: Doc = { docId: 'd', title: 'a' }
  const q = new SaveQueue(host(() => doc, () => 0))
  let threwWrite = false
  try { await q.run(() => {}, async () => { throw new Error('write boom') }) } catch { threwWrite = true }
  ok('a failed write rejects to its caller', threwWrite)
  const after = await q.run(() => {}, async () => 'ok')
  ok('the queue still works after a failed write', after!.value === 'ok')
  let threwPrep = false
  try { await q.run(() => { throw new Error('prep boom') }, async () => 'x') } catch { threwPrep = true }
  ok('a failed prepare rejects to its caller', threwPrep)
  const after2 = await q.run(() => {}, async () => 'ok2')
  ok('the queue still works after a failed prepare', after2!.value === 'ok2')
}

console.log(failures ? `\ntest-savequeue: ${failures} FAILED of ${checks}` : `test-savequeue: ${checks} checks OK`)
process.exit(failures ? 1 : 0)
