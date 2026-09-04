#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// home/webext page-bridge rig.
//
//   node scripts/test-webext-bridge.ts
//
// WHAT THIS PROVES. The bridge decides, per save, whether to write in place or
// hand back to the browser's own picker. Getting that wrong in the permissive
// direction overwrites the open document with no dialog — it already happened
// once. The decision is pure logic over an options bag, so it does not need a
// browser, and anything that does not need a browser should not require one:
// the previous round trip cost a manual reload to discover a ReferenceError
// that only fired at CALL time, which `node --check` cannot see and this can.
//
// Everything here runs the REAL page-bridge.js in a stubbed window, so the file
// under test is the file that ships.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(join(root, 'home/webext/src/page-bridge.js'), 'utf8')

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** A window just real enough to load the bridge into. */
function load(opts: { version?: string; pathname?: string } = {}) {
  const nativeCalls: any[] = []
  const posted: any[] = []
  const win: any = {
    location: { pathname: opts.pathname ?? '/Users/x/Decks/Q3.bento.html' },
    addEventListener() {},
    postMessage(msg: any) { posted.push(msg) },
    showSaveFilePicker(o: any) { nativeCalls.push(o); return Promise.resolve({ __native: true }) },
    bento: opts.version ? { updates: { version: opts.version } } : undefined,
  }
  const ctx: any = createContext({
    // A REAL Blob. It was a bare `class {}`, which was enough for the
    // `instanceof` branch but has no `.text()` — so every close() rejected and
    // the half of the bridge that actually sends bytes was never exercised.
    window: win, setTimeout, clearTimeout, Date, Math, JSON, Promise, Blob,
    DOMException: class extends Error { constructor(m: string, n: string) { super(m); this.name = n } },
    FileSystemHandle: class {},
    crypto: { randomUUID: () => 'x' },
  })
  ctx.globalThis = ctx
  runInContext(SRC, ctx)
  return { win, nativeCalls, posted }
}

// ---- the bug that shipped: a call-time ReferenceError ----------------------
// `node --check` parses; it cannot see an identifier that resolves only when
// the function runs. This does.
{
  const { win, nativeCalls } = load({ version: '1.0.15' })
  let threw: any = null
  await win.showSaveFilePicker({ id: 'bento-copy', suggestedName: 'Q3.bento.html' }).catch((e: any) => { threw = e })
  ok(threw === null, `declining does not throw (${threw ? threw.name + ': ' + threw.message : 'clean'})`)
  ok(nativeCalls.length === 1, 'and it reaches the native picker')
}

// ---- the three purposes ----------------------------------------------------
for (const [id, shouldDefer] of [
  ['bento-copy', true],
  ['bento-share', true],
  ['bento-doc', false],
  ['bento-backup', false],
] as const) {
  const { win, nativeCalls, posted } = load({ version: '1.0.15' })
  const p = win.showSaveFilePicker({ id, suggestedName: 'Q3.bento.html' })
  await new Promise((r) => setTimeout(r, 0))
  const deferred = nativeCalls.length === 1
  ok(deferred === shouldDefer,
    `${id} ${shouldDefer ? 'defers to the native picker' : 'is claimed by the host'}`)
  if (id === 'bento-doc') {
    ok(posted.some((m) => m.op === 'claim'), 'bento-doc asks the extension to claim the file')
  }
  if (id === 'bento-backup') {
    // Nothing to claim: the backup does not exist yet, so resolution happens at
    // the write. What matters is that it never reaches the native picker —
    // falling through would prompt for a file the author never asked to save,
    // which is the interruption this whole path exists to remove.
    ok(!posted.some((m) => m.op === 'claim'), 'a backup does not claim — there is no file yet to resolve')
  }
  p.catch(() => {})
}

// ---- the runtime version can come from EITHER source ------------------------
// It used to come only from `window.bento.updates.version`, which every app
// assembles by hand — and bento/dash never included `updates`, so every Cmd-S
// in Dash fell through to a destination prompt with a folder granted and
// nothing saying why. The kernel now announces `__bentoRuntime` from
// configureApp, which every app calls. Both must work: the announcement for
// everything built from now on, the hand-made object for every document already
// shipped.
{
  const { win, nativeCalls } = load({})
  ;(win as any).__bentoRuntime = '1.0.17' // kernel-announced, no window.bento at all
  win.showSaveFilePicker({ id: 'bento-doc', suggestedName: 'Q3.bento.html' }).catch(() => {})
  await new Promise((r) => setTimeout(r, 0))
  ok(nativeCalls.length === 0,
    'a document announcing __bentoRuntime saves in place even with no window.bento — the Dash case')
}
{
  const { win, nativeCalls } = load({ version: '1.0.17' }) // shipped shape, no announcement
  win.showSaveFilePicker({ id: 'bento-doc', suggestedName: 'Q3.bento.html' }).catch(() => {})
  await new Promise((r) => setTimeout(r, 0))
  ok(nativeCalls.length === 0,
    'and an already-shipped document with only window.bento.updates.version still saves in place')
}
{
  const { win, nativeCalls } = load({})
  ;(win as any).__bentoRuntime = '1.0.14' // announced, but too old to trust the id
  win.showSaveFilePicker({ id: 'bento-doc', suggestedName: 'Q3.bento.html' }).catch(() => {})
  await new Promise((r) => setTimeout(r, 0))
  ok(nativeCalls.length === 1,
    'the announcement is still gated on 1.0.15 — a pre-#213 runtime cannot be trusted to mean bento-doc')
}

// ---- the version gate: a deck older than #213 sends bento-doc for EVERYTHING
for (const [version, trusted] of [
  [undefined, false],
  ['1.0.11', false],
  ['1.0.14', false],
  ['1.0.15', true],
  ['1.1.0', true],
  ['2.0.0', true],
] as const) {
  const { win, nativeCalls } = load({ version })
  win.showSaveFilePicker({ id: 'bento-doc', suggestedName: 'Q3.bento.html' }).catch(() => {})
  await new Promise((r) => setTimeout(r, 0))
  const claimed = nativeCalls.length === 0
  ok(claimed === trusted,
    `runtime ${version ?? '(absent)'} is ${trusted ? 'trusted' : 'NOT trusted'} to mean what bento-doc says`)
}

// ---- a polyfilled handle must never reach the native picker ----------------
// This is what killed the exports: save.ts keeps our handle and passes it back
// as `startIn`, where a real FileSystemHandle is required.
{
  const { win, nativeCalls } = load({ version: '1.0.15' })
  const fake = { name: 'Q3.bento.html', kind: 'file', createWritable() {} }
  await win.showSaveFilePicker({ id: 'bento-share', suggestedName: 'x-viewonly.bento.html', startIn: fake })
    .catch(() => {})
  ok(nativeCalls.length === 1, 'a share export reaches the native picker')
  ok(!('startIn' in nativeCalls[0]), 'and a non-FileSystemHandle startIn is stripped before it gets there')
}
{
  const { win, nativeCalls } = load({ version: '1.0.15' })
  class RealHandle {}
  const real = Object.create((global as any).FileSystemHandle?.prototype ?? RealHandle.prototype)
  await win.showSaveFilePicker({ id: 'bento-copy', suggestedName: 'copy.bento.html', startIn: real })
    .catch(() => {})
  ok(nativeCalls.length === 1, 'a copy reaches the native picker')
}

// ---- the host announces what it can do -------------------------------------
// `showSaveFilePicker` existing proves nothing — Chrome has it anyway, and a
// host that declines looks exactly like one that is absent, since both end at
// the native dialog. So the kernel reads `__bentoHost.ops` before taking a path
// it can only take with help. Presence alone would be the wrong test: a host
// that announced itself but did not know `bento-backup` would pass the request
// through to the native picker and produce the very dialog this removes.
{
  const { win } = load({ version: '1.0.15' })
  const host = (win as any).__bentoHost
  ok(!!host && Array.isArray(host.ops), 'the host announces itself with a capability list')
  ok(host.ops.includes('backup'), 'and names the backup op the kernel gates on')
  ok(host.ops.includes('write'), 'and the write op the update path gates on')
  // A document is untrusted content sharing this realm; it must not be able to
  // fake a capability the extension does not have, nor hide one it does.
  try { (win as any).__bentoHost = { ops: ['everything'] } } catch { /* strict mode */ }
  ok((win as any).__bentoHost.ops.includes('backup') && !(win as any).__bentoHost.ops.includes('everything'),
    'and a page cannot overwrite the announcement')
}

// ---- a backup writes through the host, never the picker --------------------
{
  const { win, nativeCalls, posted } = load({ version: '1.0.15' })
  const h = await win.showSaveFilePicker({ id: 'bento-backup', suggestedName: 'Q3.v1.0.16-backup.bento.html' })
  ok(nativeCalls.length === 0, 'a backup never reaches the native picker')
  ok(h?.name === 'Q3.v1.0.16-backup.bento.html', 'and yields a handle named for the backup')
  const w = await h.createWritable()
  await w.write('old bytes')
  // close() serialises the chunks through Blob.text(), which is async — one
  // tick is not enough, and a rig that checks too early reports the bridge
  // broken when it is merely mid-flight.
  const closing = w.close().catch(() => {})
  await new Promise((r) => setTimeout(r, 20))
  const req = posted.find((m: any) => m.op === 'backup')
  ok(!!req, 'closing the writable sends a backup op')
  ok(req?.payload?.name === 'Q3.v1.0.16-backup.bento.html',
    'carrying the proposed name, which the extension validates against the sender\'s own file')
  ok(req?.payload?.text === 'old bytes', 'and the bytes to write')
  closing.catch(() => {})
}

// ---- an old runtime never sends bento-backup, so it never sees this path ----
{
  const { win, nativeCalls } = load({ version: '1.0.11' })
  // The id did not exist before the runtime that sends it, so unlike bento-doc
  // there is no ambiguous legacy meaning to guard against — but a deck that
  // does not send it must still behave exactly as it does today.
  win.showSaveFilePicker({ id: 'bento-doc', suggestedName: 'Q3.bento.html' }).catch(() => {})
  await new Promise((r) => setTimeout(r, 0))
  ok(nativeCalls.length === 1, 'a pre-1.0.15 deck still gets the browser picker, unchanged')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
