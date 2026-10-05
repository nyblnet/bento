#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// bento/home launch handle — home/bridge.js hands the page the file it was
// opened with, through `launchQueue`, without breaking documents that never ask.
//
//   node scripts/test-home-launch.mjs            (or BRIDGE=<path> to test a variant)
//
// WHY. A page in a native host held no handle until its first ⌘S, and autosave
// writes the file only with one, so an edit made and left never reached disk
// (iOS submission pack, B6). The kernel now consumes launchQueue at boot; this
// checks the bridge half.
//
// The bridge runs for real, in a vm, against a fake host that applies the
// hosts' actual rule — the FIRST begin is the open document, every later one is
// an export — because that rule is what makes laziness load-bearing: a bridge
// that asked eagerly at load would spend the first begin, and every old
// document's first ⌘S would become a Save-As prompt. Case 1 fails against
// exactly that variant.

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = readFileSync(process.env.BRIDGE || join(root, 'home/bridge.js'), 'utf8')
const OPEN = 'Q3 board.bento.html'

let failures = 0, checks = 0
const ok = (c, m) => { checks++; if (!c) failures++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`) }
const tick = () => new Promise((r) => setTimeout(r, 0))

// One page in one host. `refuseFirst` makes the host decline the first begin.
function page({ transport = true, refuseFirst = false, nativeLaunchQueue = false, readOnly = false } = {}) {
  const sent = [], begins = []
  let vended = false, refused = !refuseFirst, n = 0
  const writes = []
  const win = { File, Blob, TextDecoder, ArrayBuffer, Promise, setTimeout }
  if (transport) {
    win.webkit = { messageHandlers: { bentoFile: { postMessage(m) {
      sent.push(m.op)
      if (m.op === 'begin') begins.push(m)
      setTimeout(() => {
        // The hosts' rule: the first begin that CAN be the open document is;
        // a launch request that cannot be is refused, never exported.
        if (m.op === 'begin') {
          if (!refused) { refused = true; return win.__bentoNativeReply(m.id, false, 'no') }
          if (!vended && !readOnly) { vended = true; return win.__bentoNativeReply(m.id, true, OPEN) }
          if (m.launch) return win.__bentoNativeReply(m.id, false, 'already handed out')
          return win.__bentoNativeReply(m.id, true, `export-${++n}.bento.html`)
        }
        if (m.op === 'write') { writes.push(m.name); return win.__bentoNativeReply(m.id, true, null) }
        win.__bentoNativeReply(m.id, true, '')
      }, 0)
    } } } }
  }
  // A WebView's own launchQueue, as an accessor that ignores assignment.
  if (nativeLaunchQueue) Object.defineProperty(win, 'launchQueue',
    { configurable: true, get: () => ({ setConsumer() {} }), set() {} })
  win.window = win
  vm.runInNewContext(SRC, win)
  return { win, sent, writes, begins }
}
const launch = (win) => new Promise((r) => win.launchQueue.setConsumer((p) => r(p)))

{ // 1. an old runtime never asks — nothing changes for it
  const { win, sent } = page()
  await tick(); await tick()
  ok(sent.length === 0, 'a page that never calls setConsumer sends nothing at load')
  const h = await win.showSaveFilePicker({ suggestedName: 'Deck' })
  ok(h.name === OPEN, "an old runtime's first ⌘S still gets the open document, no prompt")
}
{ // 2. a new runtime gets the open document at boot, and saves go there
  const { win, sent, writes } = page()
  const p = await launch(win)
  ok(p.files.length === 1 && p.files[0].kind === 'file' && p.files[0].name === OPEN,
     'setConsumer delivers one file handle: the open document')
  const w = await p.files[0].createWritable(); await w.write('<html>edited'); await w.close()
  ok(writes[0] === OPEN, 'writing through the launch handle writes the open document')
  const e = await win.showSaveFilePicker({ suggestedName: 'copy' })
  ok(e.name !== OPEN, 'a later picker call is an export, never the open document')
  ok(sent.filter((o) => o === 'begin').length === 2, 'one begin for the launch, one for the export')
}
{ // 3. a ⌘S that came first is not asked for twice
  const { win, sent } = page()
  const h = await win.showSaveFilePicker({ suggestedName: 'Deck' })
  const p = await launch(win)
  ok(h.name === OPEN && p.files[0].name === OPEN, 'launch after a ⌘S delivers the same open document')
  ok(sent.filter((o) => o === 'begin').length === 1, 'and does not spend a second begin on it')
}
{ // 4. a refused first begin does not poison the next
  const { win } = page({ refuseFirst: true })
  let got = null
  win.launchQueue.setConsumer((p) => { got = p })
  await tick(); await tick()
  ok(got === null, 'a refused launch delivers nothing (the page keeps the ⌘S path)')
  const h = await win.showSaveFilePicker({ suggestedName: 'Deck' })
  ok(h.name === OPEN, 'the next begin may still claim the open document')
}
{ // 5. outside a host the bridge stays out of the way
  const { win } = page({ transport: false })
  ok(win.launchQueue === undefined && win.showSaveFilePicker === undefined,
     'in a plain browser no launchQueue or picker is defined')
}
{ // 6. a WebView's own launchQueue does not shadow the bridge's
  const { win } = page({ nativeLaunchQueue: true })
  const p = await Promise.race([launch(win), new Promise((r) => setTimeout(() => r(null), 50))])
  ok(p && p.files[0].name === OPEN, "the bridge's launchQueue replaces a native one that would never deliver")
}
{ // 7. a document the host cannot write in place (Android read-only grant)
  const { win, begins } = page({ readOnly: true })
  let got = null
  win.launchQueue.setConsumer((p) => { got = p })
  await tick(); await tick()
  ok(begins[0] && begins[0].launch === true, 'the launch request is marked launch:true')
  ok(got === null, 'a read-only document gets no launch handle, so no export handle posing as its file')
  const h = await win.showSaveFilePicker({ suggestedName: 'Deck' })
  ok(h.name !== OPEN, 'its ⌘S still goes the export route, as before')
}
{ // 8. junk consumers are ignored rather than thrown on
  const { win, sent } = page()
  let threw = false
  try { win.launchQueue.setConsumer(null) } catch { threw = true }
  await tick()
  ok(!threw && sent.length === 0, 'setConsumer(non-function) is a no-op and asks nothing')
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
