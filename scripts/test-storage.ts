#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Guarded preference-storage rig.
//
//   node scripts/test-storage.ts        (Node ≥ 23.6 strips types natively)
//
// WHAT THIS PROVES. `localStorage` is not always available, and the way it is
// absent is hostile: reading the PROPERTY throws, before any method is called.
// So `if (localStorage)` and `typeof localStorage` are themselves the crash,
// and a single bare read at module scope takes the whole file down before it
// paints. Measured: in a sandboxed iframe without `allow-same-origin`, a deck
// showed "This file could not start: Failed to read the 'localStorage'
// property from 'Window'" — the shell caught it and gave up, because
// `resolve()` in i18n.ts reads `bento-lang` on import.
//
// The contexts are ordinary: an opaque origin, a browser set to block site
// data, an embedded webview with storage partitioned off, Safari private
// browsing. In all of them a Bento file must still OPEN. Preferences are
// preferences; losing the document because a language code was unreadable is
// the wrong trade.
//
// So the rig simulates each way storage fails and asserts the accessors stay
// quiet — including the case that actually broke, which is importing a module
// that reads storage while merely being loaded.

import { lsGet, lsSet, lsDel, lsJson, lsSetJson, storageAvailable } from '../kernel/src/storage.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) }
  else console.log(`  ok    ${msg}`)
}

/** Replace globalThis.localStorage for one scenario. */
function withStorage(descriptor: PropertyDescriptor, fn: () => void) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, ...descriptor })
  try { fn() } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else delete (globalThis as Record<string, unknown>).localStorage
  }
}

/** A minimal in-memory Storage, optionally refusing writes (quota). */
function fakeStorage(opts: { writable?: boolean } = {}) {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.writable === false) throw new Error('QuotaExceededError')
      map.set(k, v)
    },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
  } as unknown as Storage
}

// ---- 1. the property itself throws (an opaque origin) -----------------------
// This is the case that took the app down. `backing()` must swallow it.
withStorage({ get() { throw new Error('SecurityError: The document is sandboxed and lacks the allow-same-origin flag') } }, () => {
  ok(lsGet('bento-lang') === null, 'a throwing localStorage property reads as null, not an exception')
  ok(lsSet('bento-lang', 'ja') === false, 'a write reports false rather than throwing')
  ok(lsJson('bento-panel-open', { a: 1 }).a === 1, 'lsJson falls back when the property throws')
  ok(storageAvailable() === false, 'storageAvailable is false')
  let threw = false
  try { lsDel('bento-lang') } catch { threw = true }
  ok(!threw, 'lsDel is a no-op rather than an exception')
})

// ---- 2. no localStorage at all (node, some workers) -------------------------
{
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  delete (globalThis as Record<string, unknown>).localStorage
  ok(lsGet('x') === null, 'an absent localStorage reads as null')
  ok(lsSet('x', '1') === false, 'an absent localStorage refuses writes cleanly')
  ok(storageAvailable() === false, 'storageAvailable is false when absent')
  if (had) Object.defineProperty(globalThis, 'localStorage', had)
}

// ---- 3. a working store round-trips ----------------------------------------
withStorage({ value: fakeStorage() }, () => {
  ok(lsSet('bento-author', 'Ada') === true, 'a write to a working store reports true')
  ok(lsGet('bento-author') === 'Ada', 'and reads back')
  ok(storageAvailable() === true, 'storageAvailable is true')
  lsDel('bento-author')
  ok(lsGet('bento-author') === null, 'lsDel removes it')
  ok(lsSetJson('bento-ed-panels', { left: 260 }) === true, 'lsSetJson stores')
  ok(lsJson<{ left: number }>('bento-ed-panels', { left: 0 }).left === 260, 'lsJson reads it back')
})

// ---- 4. reads work, writes throw (quota, Safari private) --------------------
withStorage({ value: fakeStorage({ writable: false }) }, () => {
  ok(lsSet('k', 'v') === false, 'a quota failure reports false rather than throwing')
  ok(lsGet('anything') === null, 'reads still work alongside a refusing write')
})

// ---- 5. corrupt JSON is somebody else's data, not a crash -------------------
withStorage({ value: fakeStorage() }, () => {
  lsSet('bento-panel-open', '{not json')
  ok(lsJson('bento-panel-open', { safe: true }).safe === true, 'unparseable JSON falls back')
  lsSet('bento-panel-open', 'null')
  ok(lsJson('bento-panel-open', { safe: true }).safe === true, 'a stored null falls back rather than returning null')
})

// ---- 6. THE REGRESSION: importing a module that reads storage on load -------
// i18n.ts calls resolve() at module scope, which reads `bento-lang`. Under a
// throwing localStorage that import used to blow up the whole boot. Nothing
// else in this rig would catch that, because it is not about the accessor's
// return value — it is about whether the file can be loaded at all.
await (async () => {
  let error: unknown = null
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: sandboxed, lacks allow-same-origin') },
  })
  try {
    const mod = await import('../kernel/src/i18n.ts')
    ok(typeof mod.t === 'function', 'i18n imports under a throwing localStorage and exports t()')
    ok(mod.t('Present') === 'Present', 'and t() falls back to English with no stored locale')
  } catch (e) {
    error = e
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else delete (globalThis as Record<string, unknown>).localStorage
  }
  ok(error === null, `importing i18n must not throw when storage does (${error ? String(error).slice(0, 90) : 'ok'})`)
})()

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
