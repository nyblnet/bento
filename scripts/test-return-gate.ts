#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Return-gate rig.
//
//   node scripts/test-return-gate.ts
//
// WHAT THIS PROVES. The gate exists to stop a returning visitor thinking they
// lost work. Every way it can go wrong is a way of being WORSE than the silent
// blank starter it replaces:
//
//   1. Firing over a real document. The gate says "this page always starts
//      fresh" — over someone's actual deck that is false, and alarming.
//   2. Offering a host that does not exist. Hardcoding "install the extension"
//      tells an Android user to install a Chrome extension. The mobile rows
//      must degrade to "keep the file" until those hosts ship, and this rig is
//      what keeps that true as HOST_AVAILABLE flips.
//   3. Nagging where nothing is wrong. A reader whose host already writes the
//      file in place must hear nothing at all.
//   4. Selling an extension to a browser no extension can help. Safari and
//      Firefox on the desktop have no File System Access; the honest answer is
//      a different browser, not a pitch.
//   5. Recording it in the DOCUMENT. It is a fact about this browser. A deck
//      carrying it would tell everyone you send it to that you once saved.

let failures = 0
let checks = 0
const ok = (cond: boolean, msg: string) => {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

const store = new Map<string, string>()
let storageWorks = true
;(globalThis as any).localStorage = {
  getItem: (k: string) => { if (!storageWorks) throw new Error('blocked'); return store.get(k) ?? null },
  setItem: (k: string, v: string) => { if (!storageWorks) throw new Error('blocked'); store.set(k, v) },
  removeItem: (k: string) => { if (!storageWorks) throw new Error('blocked'); store.delete(k) },
}
;(globalThis as any).location = { protocol: 'https:' }

const g = await import('../kernel/src/returngate.ts')

// ---- 1. remembering -------------------------------------------------------
ok(g.savedHere() === null, 'a browser that has never saved from here remembers nothing')
g.noteSavedHere('Q3 review.bento.html')
ok(g.savedHere() === 'Q3 review.bento.html', 'a save is remembered, with the name to open')
g.clearSavedHere()
ok(g.savedHere() === null, '"start a new deck anyway" clears it, so the gate does not re-nag')
ok(typeof (g as any).stampIntoDoc === 'undefined',
  'there is no way to write this into a document — viewer-scoped by construction')

storageWorks = false
let threw = false
try { g.noteSavedHere('x.bento.html'); void g.savedHere(); g.clearSavedHere() } catch { threw = true }
ok(!threw, 'blocked site data degrades to no gate rather than throwing')
storageWorks = true
store.clear()

// ---- 2. where it applies --------------------------------------------------
ok(g.isWebOrigin() === true, 'https is a web origin')
;(globalThis as any).location = { protocol: 'file:' }
ok(g.isWebOrigin() === false, 'file:// is not — there the reader IS looking at their saved deck')
;(globalThis as any).location = { protocol: 'https:' }

// ---- 3. the gate fires only where it is true ------------------------------
const gate = (webOrigin: boolean, savedName: string | null, docIsFresh: boolean) =>
  g.shouldGateOnReturn({ webOrigin, savedName, docIsFresh })
ok(gate(true, 'deck.bento.html', true), 'returning visitor on the web with a fresh starter: gate')
ok(!gate(true, 'deck.bento.html', false),
  'NOT over a real document — "this page always starts fresh" would be false and alarming')
ok(!gate(true, null, true), 'not for a first-time visitor who has saved nothing')
ok(!gate(false, 'deck.bento.html', true), 'not on file://, where the file is already open')

// ---- 4. the offer matrix --------------------------------------------------
const offer = (fsAccess: boolean, canWrite: boolean, platform: any) =>
  g.offerFor({ fsAccess, canWrite, platform })
ok(offer(true, true, 'desktop').kind === 'silent',
  'a host already writing in place is told NOTHING — that is the destination, not a problem')
ok(offer(true, false, 'desktop').kind === 'extension',
  'Chrome/Edge desktop with no host: the extension is the missing piece')
ok(offer(false, false, 'desktop').kind === 'use-chromium',
  'Safari/Firefox desktop: no extension can help, so it does not pretend one can')

ok(g.HOST_AVAILABLE.ios === false && g.HOST_AVAILABLE.android === false,
  'the mobile hosts are still marked unreleased (flip these when they ship)')
const ios = offer(false, false, 'ios')
const android = offer(false, false, 'android')
ok(ios.kind === 'keep-file' && (ios as any).platform === 'ios',
  'iOS is told to keep the file, NOT to install an app that has no release')
ok(android.kind === 'keep-file' && (android as any).platform === 'android',
  'Android likewise — and never "install the extension", which is a Chrome extension')

{
  const AVAIL = g.HOST_AVAILABLE as any
  const restore = AVAIL.ios
  AVAIL.ios = true
  const shipped = offer(false, false, 'ios')
  ok(shipped.kind === 'app' && (shipped as any).platform === 'ios',
    'and it becomes a real offer the day that host ships — the flag is wired, not decorative')
  AVAIL.ios = restore
  ok(offer(false, false, 'ios').kind === 'keep-file', 'and reverts when the flag goes back')
}

ok(offer(true, false, 'unknown').kind === 'extension',
  'an unrecognised platform that CAN write in place is still offered the extension')
ok(offer(false, false, 'unknown').kind === 'keep-file',
  'an unrecognised platform that cannot is given the answer that is true everywhere')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
