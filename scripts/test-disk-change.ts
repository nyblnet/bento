#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Outside-edit guard rig (kernel/src/save.ts, "outside edits").
//
//   node scripts/test-disk-change.ts
//
// WHAT THIS PROVES. Other programs edit `.bento.html` files in place. A document
// open with a held File System Access handle rewrites its file on every
// auto-save, ⌘S and in-place update, and used to replace the other program's
// edit silently. Now every write through the held handle first compares the
// file's `lastModified` + `size` with the stamp read back after our last write
// (or at open). The rig drives the real save.ts against a fake handle whose
// file system ROUNDS mtime to 2 s (as FAT does), and checks:
//
//   · an outside edit → the write is refused, the file keeps the outside
//     content, the event fires once, and later writes stay refused;
//   · our own consecutive (and concurrent) writes → never a false alarm, even
//     when the rounded mtime does not move or does not match the clock;
//   · keep-mine → exactly one deliberate overwrite, then tracking resumes;
//   · load-from-disk → the disk text, writes refused until accept();
//   · a same-mtime size change, a deleted file, and checkFileOnDisk();
//   · a handle that reports no stamp is written as before (unchanged path).
//
// MUTANTS. The suite is re-run against copies of save.ts with one piece of the
// guard removed; each must turn the suite red, or the rig is not testing it.
// A positive control (the unmutated copy, loaded the same way) must stay green.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const kernelSrc = join(root, 'kernel', 'src')

// --- a file system that rounds mtime ----------------------------------------
let clock = 1_700_000_000_000
const advance = (ms: number) => { clock += ms }
const fsMtime = () => Math.floor(clock / 2000) * 2000 // FAT-style 2 s granularity

interface Disk { text: string; lastModified: number; writes: number; gone: boolean; holdRead: { after: number; gate: Promise<void> } | null }
function fakeHandle(name: string, text: string, opts: { noStamp?: boolean } = {}) {
  const disk: Disk = { text, lastModified: fsMtime(), writes: 0, gone: false, holdRead: null }
  const handle = {
    name,
    async getFile() {
      if (disk.gone) { const e = new Error('gone'); e.name = 'NotFoundError'; throw e }
      const snapshot = disk.text
      // A slow read, once: the first read after the given write count waits on
      // the gate — so the rig can hold one read-back open across another write.
      const hold = disk.holdRead
      if (hold && disk.writes > hold.after) { disk.holdRead = null; await hold.gate }
      const file = { text: async () => snapshot }
      return opts.noStamp ? file : Object.assign(file, { lastModified: disk.lastModified, size: Buffer.byteLength(snapshot) })
    },
    async createWritable() {
      let pending = ''
      return {
        async write(b: Blob) { pending = await b.text() },
        async close() { disk.text = pending; disk.lastModified = fsMtime(); disk.writes++; disk.gone = false },
      }
    },
  }
  /** Another program rewrites the file. */
  const outside = (t: string, mtime = fsMtime()) => { disk.text = t; disk.lastModified = mtime }
  return { handle, disk, outside }
}

type SaveMod = typeof import('../kernel/src/save.ts')
const settle = () => new Promise((r) => setTimeout(r, 5))

async function suite(m: SaveMod, log: boolean): Promise<{ checks: number; failures: number }> {
  let checks = 0, failures = 0
  const ok = (cond: unknown, msg: string) => {
    checks++
    if (!cond) failures++
    if (log) console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`)
  }
  // A throw is a FAIL, never a crash a mutant runner could read as "survived".
  const attempt = async (html: string): Promise<'written' | 'refused' | 'error'> => {
    try { await m.writeUpdatedFile(html); return 'written' }
    catch (e) { return (e as Error)?.name === 'FileChangedOnDiskError' ? 'refused' : 'error' }
  }
  const events: string[] = []
  const off = m.onFileChangedOnDisk(({ name }) => events.push(name))

  try {
    // 1. Our own writes never raise the alarm.
    const a = fakeHandle('A.bento.html', '<html>v0')
    m.adoptFileHandle(a.handle as never)
    await settle()
    ok(await attempt('<html>mine-1') === 'written', 'own write 1 lands')
    ok(await attempt('<html>mine-2') === 'written', 'own write 2, same rounded mtime, lands')
    advance(1500)
    ok(await attempt('<html>mine-3!') === 'written', 'own write 3, mtime rounded off the clock, lands')
    advance(700)
    const burst = await Promise.all([attempt('<html>c1'), attempt('<html>c22'), attempt('<html>c333')])
    ok(burst.every((r) => r === 'written'), 'three concurrent own writes all land (serialized, no false alarm)')
    ok(a.disk.writes === 6 && a.disk.text === '<html>c333', 'disk holds the last of our writes')
    ok(events.length === 0 && !m.fileChangedOnDisk(), 'no event, no conflict after our own writes')
    // The interleaving a queue must prevent: write 2 checks the disk while
    // write 1's bytes have landed but its read-back has not returned yet.
    advance(700)
    const before = a.disk.writes
    let release!: () => void
    a.disk.holdRead = { after: before, gate: new Promise<void>((r) => { release = r }) } // write 1's read-back
    const first = attempt('<html>slow-1')
    for (let i = 0; i < 200 && a.disk.writes === before; i++) await new Promise((r) => setTimeout(r, 1))
    const second = attempt('<html>slow-second')
    await new Promise((r) => setTimeout(r, 10))
    release()
    const pair = await Promise.all([first, second])
    ok(pair[0] === 'written' && pair[1] === 'written' && events.length === 0, 'a write never mistakes the previous write, still reading back, for an outside edit')

    // 2. An outside edit is never overwritten.
    advance(5000)
    const written = a.disk.writes
    a.outside('<html>edited by another program')
    advance(3000)
    ok(await attempt('<html>autosave') === 'refused', 'write after an outside edit is refused')
    ok(a.disk.text === '<html>edited by another program' && a.disk.writes === written, 'the outside edit is still on disk')
    ok(events.length === 1 && events[0] === 'A.bento.html', 'the event fired once, naming the file')
    ok(m.fileChangedOnDisk(), 'fileChangedOnDisk() is true')
    ok(await attempt('<html>autosave again') === 'refused' && a.disk.writes === written, 'auto-save stays stopped')
    ok(events.length === 1, 'and the event does not repeat')

    // 3. Keep mine: one deliberate overwrite, then tracking resumes.
    await m.keepMineOverDisk()
    ok(!m.fileChangedOnDisk(), 'keep-mine clears the conflict')
    ok(await attempt('<html>mine wins') === 'written' && a.disk.text === '<html>mine wins', 'keep-mine: the next write overwrites')
    ok(await attempt('<html>mine again') === 'written', 'and our following write is no false alarm')
    advance(4000)
    a.outside('<html>second outside edit')
    ok(await attempt('<html>clobber?') === 'refused' && a.disk.text === '<html>second outside edit', 'tracking resumed: a second outside edit is caught')
    ok(events.length === 2, 'event fired for the second edit')

    // 4. Load the version on disk.
    const disk = await m.readDiskVersion()
    ok(disk.html === '<html>second outside edit', 'readDiskVersion returns the disk text')
    ok(await attempt('<html>before accept') === 'refused', 'writes stay refused until accept()')
    disk.accept()
    ok(!m.fileChangedOnDisk() && await attempt('<html>after load') === 'written', 'after accept() writes resume')

    // 5. Same rounded mtime, different size: still an outside edit.
    a.outside('<html>same second, longer text', a.disk.lastModified)
    ok(await attempt('<html>x') === 'refused', 'a same-mtime size change is caught')
    await m.keepMineOverDisk()
    ok(await attempt('<html>y') === 'written', 'keep-mine after it')

    // 6. checkFileOnDisk refuses without writing; a deleted file counts as changed.
    advance(4000)
    a.outside('<html>z')
    let checked = 'passed'
    try { await m.checkFileOnDisk() } catch (e) { checked = (e as Error).name }
    ok(checked === 'FileChangedOnDiskError' && a.disk.text === '<html>z', 'checkFileOnDisk throws and writes nothing')
    await m.keepMineOverDisk()
    ok(await attempt('<html>w') === 'written', 'resumes after keep-mine')
    a.disk.gone = true
    ok(await attempt('<html>v') === 'refused', 'a file that vanished is not silently recreated')
    await m.keepMineOverDisk()
    ok(await attempt('<html>u') === 'written' && !a.disk.gone, 'keep-mine recreates it deliberately')

    // 7. A new handle starts clean; a handle reporting no stamp writes as before.
    const b = fakeHandle('B.bento.html', '<html>b0', { noStamp: true })
    m.adoptFileHandle(b.handle as never)
    await settle()
    ok(!m.fileChangedOnDisk(), 'adopting another handle clears the old conflict state')
    b.outside('<html>b-outside')
    ok(await attempt('<html>b-mine') === 'written', 'a stampless handle is written unchecked (unchanged behaviour)')

    // 8. The stamp at OPEN is the baseline: an edit between open and first write.
    const c = fakeHandle('C.bento.html', '<html>c0')
    m.adoptFileHandle(c.handle as never)
    await settle()
    advance(4000)
    c.outside('<html>c-outside')
    ok(await attempt('<html>c-mine') === 'refused' && c.disk.text === '<html>c-outside', 'an edit after open, before our first write, is caught')
  } catch (e) {
    checks++; failures++
    if (log) console.log(`  FAIL  threw: ${(e as Error)?.stack ?? e}`)
  } finally {
    off()
  }
  return { checks, failures }
}

// --- source pin: the update path checks before its backup -------------------
const update = readFileSync(join(kernelSrc, 'update.ts'), 'utf8')
const inPlace = update.slice(update.indexOf('export async function applyUpdateInPlace'))
const pinUpdate = inPlace.includes('await checkFileOnDisk()')
  && inPlace.indexOf('await checkFileOnDisk()') < inPlace.indexOf('writeBackupBeside(')

// --- run: real module, then mutants -----------------------------------------
console.log('outside-edit guard (kernel/src/save.ts)')
const real = await suite(await import('../kernel/src/save.ts'), true)
console.log(`  ${pinUpdate ? 'ok  ' : 'FAIL'}  applyUpdateInPlace checks the disk before writing its backup`)

const source = readFileSync(join(kernelSrc, 'save.ts'), 'utf8')
const MUTANTS: Array<[string, string, string]> = [
  ['control: unmutated copy', '', ''],
  ['no check before write', '    await verifyUnchanged(handle)\n    await writeHandle(handle, html)', '    await writeHandle(handle, html)'],
  ['stamp from the clock, not read back', '    await writeHandle(handle, html)\n    const s = await readStamp(handle).catch(() => null)\n    if (fileHandle === handle) diskStamp = s\n', '    await writeHandle(handle, html)\n    if (fileHandle === handle) diskStamp = { lastModified: Date.now(), size: new Blob([html]).size }\n'],
  ['no restamp after our write', '    await writeHandle(handle, html)\n    const s = await readStamp(handle).catch(() => null)\n    if (fileHandle === handle) diskStamp = s\n', '    await writeHandle(handle, html)\n'],
  ['mtime only, size ignored', 'now.lastModified === diskStamp.lastModified && now.size === diskStamp.size', 'now.lastModified === diskStamp.lastModified'],
  ['conflict not sticky', '  if (diskConflict) throw new FileChangedOnDiskError(handle.name)\n', ''],
  ['keep-mine keeps the conflict', '    diskStamp = s\n    diskConflict = false\n', '    diskStamp = s\n'],
  ['no baseline at adopt', '  if (handle) void stampHeld()\n', ''],
  ['unreadable file passes', '  if (now && now.lastModified', '  if (!now || now.lastModified'],
  ['writes not serialized', 'function heldTask<T>(fn: () => Promise<T>): Promise<T> {\n  const task = heldChain.then(fn)', 'function heldTask<T>(fn: () => Promise<T>): Promise<T> {\n  const task = Promise.resolve().then(fn)'],
]
const dir = mkdtempSync(join(tmpdir(), 'bento-disk-change-'))
let mutantProblems = 0
try {
  const absolute = source.replace(/from '\.\/([^']+)'/g, (_, p) => `from '${pathToFileURL(join(kernelSrc, p)).href}'`)
  for (const [i, [label, from, to]] of MUTANTS.entries()) {
    let text = absolute
    if (from) {
      const n = text.split(from).length - 1
      if (n !== 1) { console.log(`  FAIL  mutant "${label}": target found ${n} times, expected 1`); mutantProblems++; continue }
      text = text.replace(from, to)
    }
    const file = join(dir, `save-mutant-${i}.ts`)
    writeFileSync(file, text)
    const r = await suite(await import(pathToFileURL(file).href), false)
    const control = !from
    const good = control ? r.failures === 0 && r.checks === real.checks : r.failures > 0
    if (!good) mutantProblems++
    console.log(`  ${good ? 'ok  ' : 'FAIL'}  ${control ? '' : 'mutant '}${label}: ${r.failures}/${r.checks} failing${control ? ' (must be 0)' : ' (must be >0)'}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

const failed = real.failures + (pinUpdate ? 0 : 1) + mutantProblems
console.log(`\n${real.checks + 1} checks, ${MUTANTS.length - 1} mutants + control: ${failed ? `${failed} FAILED` : 'all passed'}`)
process.exit(failed ? 1 : 0)
