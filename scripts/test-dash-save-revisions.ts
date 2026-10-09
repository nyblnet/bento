#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/dash SAVE-RACE rig — every write to the open file goes through one
// queue, and the unsaved dot goes out only for the revision that was written.
//
//   node scripts/test-dash-save-revisions.ts
//
// WHY THIS EXISTS. Every dash save path cleared the dot when its write
// RESOLVED. A write awaits (handle reconnect, serializer, disk), so an edit
// made inside that window was missing from the file and the dot said it was
// saved. Worse, a dropped file adopted its handle while an automatic write was
// mid-serialize, and that write — which reads the held handle after its await —
// put the OLD workbook into the NEW file. This rig drives dash/src/saving.ts
// with a real Store and writes held open on a gate, so each window can be
// entered on purpose rather than hoped for.

import { registerHooks } from 'node:module'
registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css')) return { format: 'module', source: 'export {}', shortCircuit: true }
    return next(url, context)
  },
})

const { parseDoc } = await import('../dash/src/model.ts')
const { Store } = await import('../dash/src/store.ts')
const { savingFor, saveRevision, afterPendingWrites } = await import('../dash/src/saving.ts')
const { FileWriteBack } = await import('../dash/src/writeback.ts')
type DashDoc = import('../dash/src/model.ts').DashDoc

let checks = 0, failures = 0
const ok = (c: boolean, m: string) => { checks++; if (!c) { failures++; console.log(`  FAIL  ${m}`) } else console.log(`  ok    ${m}`) }

const fresh = (docId = 'd'): DashDoc => {
  const r = parseDoc(JSON.stringify({
    format: 'bento/dash', version: 1, policy: 'bento-dash-1', docId, title: 'Book',
    sheets: [{
      id: 'sh', kind: 'table', name: 'Data', rids: [[1, 2]], nextRid: 3,
      columns: [{ id: 'v', name: 'Value', type: 'number' }],
      data: { v: { enc: 'raw', v: [1, 2] } }, steps: [],
    }],
  }))
  if (!r.ok) throw new Error('fixture')
  return r.doc
}
const valueOf = (d: DashDoc, i: number) => ((d.sheets[0] as { data: { v: { v: unknown[] } } }).data.v.v[i])
const edit = (s: InstanceType<typeof Store>, v: number) =>
  s.commit({ op: 'setCells', sheet: 'sh', col: 'v', rids: [1], v: [v] })

/** A write that does not finish until the test says so. */
function gated<T>(value: T) {
  let open!: () => void
  const gate = new Promise<void>((r) => { open = r })
  let saw: DashDoc | null = null
  let started = false
  const write = async (snap: DashDoc): Promise<T> => { started = true; saw = snap; await gate; return value }
  return { write, open, get saw() { return saw }, get started() { return started } }
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const ackSpy = () => {
  const a = { cleaned: 0, adopted: [] as DashDoc[] }
  return { a, ack: { clean: () => { a.cleaned++ }, adopt: (d: DashDoc) => { a.adopted.push(d) } } }
}
const landsInFile = () => 'open-file' as const

console.log('one queue per workbook')
{
  const s = new Store(fresh())
  ok(savingFor(s) === savingFor(s), 'every path asks for the same queue — ⌘S, menu, write-back, update, drop')
  ok(savingFor(s) !== savingFor(new Store(fresh())), 'and another store gets its own')
}

console.log('\nan edit made WHILE the write is in flight keeps the dot on')
{
  const s = new Store(fresh())
  const w = gated('saved'), { a, ack } = ackSpy()
  const p = saveRevision(s, w.write, landsInFile, ack)
  await tick()
  ok(w.started, 'the write started')
  edit(s, 99)
  w.open()
  const out = await p
  ok(out.kind === 'done' && !out.current, 'the result says the file is behind the screen')
  ok(a.cleaned === 0, 'the dot is NOT cleared — this is the race')
  ok(a.adopted.length === 1 && valueOf(a.adopted[0], 0) === 1,
    'what is adopted as "on disk" is the snapshot (1), not the live workbook (99) — write-back will still write 99')
  ok(valueOf(w.saw!, 0) === 1 && w.saw !== s.doc, 'and the write was handed a DETACHED snapshot')
}

console.log('\nno edit in the window: the dot goes out')
{
  const s = new Store(fresh())
  const w = gated('saved'), { a, ack } = ackSpy()
  const p = saveRevision(s, w.write, landsInFile, ack)
  await tick(); w.open()
  const out = await p
  ok(out.kind === 'done' && out.current && a.cleaned === 1, 'current, and cleaned once')
}

console.log('\nevery kind of change counts, not only a committed one')
for (const [what, change] of [
  ['a keystroke inside a typing run', (s: InstanceType<typeof Store>) => s.runEdit('v:1', { op: 'setCells', sheet: 'sh', col: 'v', rids: [1], v: [7] })],
  ['a collaborator\'s edit', (s: InstanceType<typeof Store>) => s.changedRemotely()],
  ['a write straight onto the doc that calls touch() (document properties, sharing credentials)', (s: InstanceType<typeof Store>) => { (s.doc as { meta?: object }).meta = { author: 'x' }; s.touch() }],
  ['undo', (s: InstanceType<typeof Store>) => s.undo()],
] as const) {
  const s = new Store(fresh())
  edit(s, 5)
  const w = gated('saved'), { a, ack } = ackSpy()
  const p = saveRevision(s, w.write, landsInFile, ack)
  await tick()
  change(s)
  w.open()
  const out = await p
  ok(out.kind === 'done' && !out.current && a.cleaned === 0, `${what} during the write keeps the dot on`)
}

console.log('\na typing run is closed before the snapshot is taken')
{
  const s = new Store(fresh())
  s.runEdit('v:1', { op: 'setCells', sheet: 'sh', col: 'v', rids: [1], v: [42] })
  const undoBefore = s.canUndo
  const w = gated('saved'), { ack } = ackSpy()
  const p = saveRevision(s, w.write, landsInFile, ack)
  await tick()
  ok(!undoBefore && s.canUndo, 'the open run became an undo step when the save began')
  ok(valueOf(w.saw!, 0) === 42, 'and the snapshot has what was typed')
  w.open(); await p
}

console.log('\nwrites are serialized: the second starts only after the first lands')
{
  const s = new Store(fresh())
  const log: string[] = []
  const w1 = gated('saved'), w2 = gated('saved'), { ack } = ackSpy()
  const p1 = saveRevision(s, async (d) => { log.push('1 start'); const r = await w1.write(d); log.push('1 end'); return r }, landsInFile, ack)
  const p2 = saveRevision(s, async (d) => { log.push('2 start'); const r = await w2.write(d); log.push('2 end'); return r }, landsInFile, ack)
  await tick(); await tick()
  ok(log.join() === '1 start', `only the first is writing — ${log.join(' | ')}`)
  w1.open(); await p1; await tick()
  ok(log.join() === '1 start,1 end,2 start', `then the second — ${log.join(' | ')}`)
  w2.open(); await p2
}

console.log('\na failed write is a failure, and does not poison the queue')
{
  const s = new Store(fresh())
  const { a, ack } = ackSpy()
  const out = await saveRevision(s, async () => { throw new Error('disk full') }, landsInFile, ack)
  ok(out.kind === 'failed' && (out.error as Error).message === 'disk full' && a.cleaned === 0, 'reported as failed, dot untouched')
  const after = await saveRevision(s, async () => 'saved', landsInFile, ack)
  ok(after.kind === 'done' && a.cleaned === 1, 'and the next save runs normally')
}

console.log('\nwhere the bytes went decides what is acknowledged')
for (const [landed, clean, adopt] of [['open-file', 1, 1], ['download', 1, 0], ['elsewhere', 0, 0], ['nowhere', 0, 0]] as const) {
  const s = new Store(fresh())
  const { a, ack } = ackSpy()
  await saveRevision(s, async () => 'x', () => landed, ack)
  ok(a.cleaned === clean && a.adopted.length === adopt,
    `${landed}: dot ${clean ? 'clears' : 'stays'}, ${adopt ? 'adopted' : 'not adopted'} as the file's content`)
}

console.log('\na write for a workbook that has been replaced is never made')
{
  const s = new Store(fresh())
  const w1 = gated('saved'), { ack } = ackSpy()
  const p1 = saveRevision(s, w1.write, landsInFile, ack)
  let ran = false
  const p2 = saveRevision(s, async () => { ran = true; return 'saved' }, landsInFile, ack)
  await tick()
  s.replaceDoc(fresh('other'))
  w1.open()
  const [o1, o2] = await Promise.all([p1, p2])
  ok(o1.kind === 'done' && !o1.current, 'the write in flight finishes, and is not current')
  ok(o2.kind === 'discarded' && !ran, 'the one queued behind it is discarded without writing')
}

console.log('\nTHE DROP RACE: a handle swap waits for the write in flight')
// The kernel's write reads its handle AFTER the serializer awaits. Model that
// exactly: `held` is the kernel's module handle, read after the gate.
for (const viaQueue of [true, false]) {
  const s = new Store(fresh('A'))
  let held = 'file-A'
  const wrote: Array<[string, unknown]> = []
  let open!: () => void
  const gate = new Promise<void>((r) => { open = r })
  const { ack } = ackSpy()
  const inflight = saveRevision(s, async (snap) => { await gate; wrote.push([held, snap.docId]); return 'saved' }, landsInFile, ack)
  await tick()
  const swap = () => { s.replaceDoc(fresh('B')); held = 'file-B' }
  let swapped: Promise<void>
  if (viaQueue) swapped = afterPendingWrites(s, swap)
  else { swap(); swapped = Promise.resolve() }
  open()
  await Promise.all([inflight, swapped])
  // a write asked for after the drop, for the new workbook
  await saveRevision(s, async (snap) => { wrote.push([held, snap.docId]); return 'saved' }, landsInFile, ack)
  const into = (f: string) => wrote.filter(([h]) => h === f).map(([, id]) => id).join(',')
  if (viaQueue) {
    ok(into('file-A') === 'A', `file A received only workbook A — ${JSON.stringify(wrote)}`)
    ok(into('file-B') === 'B', `file B received only workbook B — ${JSON.stringify(wrote)}`)
  } else {
    // the CONTROL: what happens without the queue. If this ever stops writing
    // A into B, the model above no longer reproduces the bug and proves nothing.
    ok(into('file-B').includes('A'), `CONTROL — swapping without waiting writes workbook A into file B — ${JSON.stringify(wrote)}`)
  }
}

console.log('\nthe swap runs before a write queued behind the drain can start')
{
  const s = new Store(fresh('A'))
  const log: string[] = []
  const w = gated('saved'), { ack } = ackSpy()
  const p1 = saveRevision(s, w.write, landsInFile, ack)
  const swapped = afterPendingWrites(s, () => { log.push('swap'); s.replaceDoc(fresh('A2')) })
  // queued for workbook A, behind the drain — must be discarded, not written
  const p3 = saveRevision(s, async () => { log.push('stale write'); return 'saved' }, landsInFile, ack)
  await tick(); w.open()
  const [, , o3] = await Promise.all([p1, swapped, p3])
  ok(log.join() === 'swap' && o3.kind === 'discarded', `the swap ran, the stale write never did — ${log.join(' | ')}`)
}

console.log('\nan in-place update ends this session\'s writing')
{
  const s = new Store(fresh())
  const saving = savingFor(s)
  const upd = gated(true), { ack } = ackSpy()
  // the update, exactly as settings.ts drives it: superseded is set INSIDE
  // the queued write. Setting it once the save resolves is one tick too late
  // — the next queued write has already started by then.
  const u = saveRevision(s, async (snap) => { const r = await upd.write(snap); if (r) saving.superseded = true; return r },
    (ok) => ok ? 'open-file' : 'nowhere', ack)
  await tick()
  // an automatic save asked for while the update is writing — it passed every
  // check made when it was ASKED for
  let wroteOld = false
  const wb = saveRevision(s, async () => { wroteOld = true; return 'saved' }, landsInFile, ack)
  upd.open()
  const [, w] = await Promise.all([u, wb])
  ok(saving.superseded, 'the update succeeded and marked the session superseded')
  ok(w.kind === 'superseded' && !wroteOld, 'the write queued behind it did NOT put the old shell back')
}

console.log('\nCONTROL: marking superseded after the update resolves is too late')
{
  const s = new Store(fresh())
  const saving = savingFor(s)
  const upd = gated(true), { ack } = ackSpy()
  const u = saveRevision(s, upd.write, (ok) => ok ? 'open-file' : 'nowhere', ack)
    .then((out) => { if (out.kind === 'done' && out.value) saving.superseded = true })
  await tick()
  let wroteOld = false
  const wb = saveRevision(s, async () => { wroteOld = true; return 'saved' }, landsInFile, ack)
  upd.open()
  await Promise.all([u, wb])
  ok(wroteOld, 'CONTROL — the queued write slipped in; if this stops happening the check above proves nothing')
}

console.log('\nthe automatic write-back, driven through the queue the way main.ts drives it')
{
  const s = new Store(fresh())
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const disk: string[] = []
  const wb = new FileWriteBack({
    hasHandle: () => true,
    serialize: async (d) => { await gate; return JSON.stringify(valueOf(d, 0)) },
    write: async (html) => { disk.push(html) },
  })
  const { a, ack } = ackSpy()
  const run = () => saveRevision(s, (snap) => wb.run(snap, false),
    (r) => r.outcome.kind === 'wrote' ? 'open-file' : 'nowhere', { adopt: () => {}, clean: ack.clean })
  edit(s, 10)
  const p = run()
  await tick()
  edit(s, 11)          // typed while the cycle was serializing
  release()
  await p
  ok(disk.join() === '10' && a.cleaned === 0, `the cycle wrote 10 and left the dot on for 11 — disk ${disk.join()}`)
  await run()
  ok(disk.join() === '10,11' && a.cleaned === 1, `the next cycle writes 11 and only then clears it — disk ${disk.join()}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
