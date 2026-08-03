#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// tray/webext page-bridge rig.
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
const SRC = readFileSync(join(root, 'tray/webext/src/page-bridge.js'), 'utf8')

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
    window: win, setTimeout, clearTimeout, Date, Math, JSON, Promise, Blob: class {},
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
] as const) {
  const { win, nativeCalls, posted } = load({ version: '1.0.15' })
  const p = win.showSaveFilePicker({ id, suggestedName: 'Q3.bento.html' })
  await new Promise((r) => setTimeout(r, 0))
  const deferred = nativeCalls.length === 1
  ok(deferred === shouldDefer,
    `${id} ${shouldDefer ? 'defers to the native picker' : 'is claimed by the host'}`)
  if (!shouldDefer) {
    ok(posted.some((m) => m.op === 'claim'), 'bento-doc asks the extension to claim the file')
  }
  p.catch(() => {})
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

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
