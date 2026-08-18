#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// Offline-mode rig.
//
//   node scripts/test-offline.ts
//
// WHAT THIS PROVES. Offline mode is a promise made in the product's own
// words — "nothing leaves this computer" — and it was broken in five separate
// ways at once (GHSA-5c3x-xqp6-g94r, reported 2026-08-09). What makes that
// worth a permanent rig is HOW it stayed hidden: the reporter asked an agent
// to audit the feature, and the agent read the docs and said secure, then read
// the CODE and still said secure. It only came out when something watched real
// traffic. Reading a call site cannot tell you about the call site nobody
// wrote yet.
//
// So this rig does not check that the current call sites are correct. It
// checks the two things that survive the next contributor:
//
//   1. THE POLICY. No file outside kernel/src/net.ts may touch a network
//      primitive. A new feature cannot forget the switch, because the only
//      way to reach the network is through something that already consults
//      it. This is the reporter's own suggestion, and it is the right shape:
//      mechanically checkable, by a person or an agent, in one grep.
//   2. THE CHOKEPOINT'S BEHAVIOUR. That netFetch/netWebSocket actually
//      refuse; that flipping the switch cuts what is ALREADY running rather
//      than only what starts next; that another tab's flip is honoured; that
//      a src a browser would load is classified as network even though no
//      fetch is involved; and that a switch which cannot be persisted still
//      holds for the session instead of quietly doing nothing.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
let checks = 0
const ok = (cond: boolean, msg: string) => {
  checks++
  if (!cond) { failures++; console.log(`  FAIL  ${msg}`) } else console.log(`  ok    ${msg}`)
}

// ---------------------------------------------------------------- 1. policy
// The primitives that reach the network. Anything here, outside net.ts, is a
// path that can ignore the switch.
const PRIMITIVES: Array<[RegExp, string]> = [
  [/(?<![.\w])fetch\s*\(/, 'fetch('],
  [/\.fetch\s*\(/, '.fetch('],
  [/new\s+WebSocket\s*\(/, 'new WebSocket('],
  [/new\s+XMLHttpRequest\s*\(/, 'new XMLHttpRequest('],
  [/sendBeacon\s*\(/, 'sendBeacon('],
  [/new\s+EventSource\s*\(/, 'new EventSource('],
]

/** The one file allowed to touch them, and the test files that stub them. */
const CHOKEPOINT = 'kernel/src/net.ts'

/** Strip comments and string literals — a primitive NAMED in prose is fine. */
function code(src: string): string {
  let out = ''
  let i = 0
  let state: 'code' | 'line' | 'block' | 's' | 'd' | 't' = 'code'
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue }
      if (c === "'") { state = 's'; i++; continue }
      if (c === '"') { state = 'd'; i++; continue }
      if (c === '`') { state = 't'; i++; continue }
      out += c; i++; continue
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += '\n' } ; i++; continue }
    if (state === 'block') { if (c === '*' && n === '/') { state = 'code'; i += 2 } else i++; continue }
    if (c === '\\') { i += 2; continue }
    if ((state === 's' && c === "'") || (state === 'd' && c === '"') || (state === 't' && c === '`')) state = 'code'
    i++
  }
  return out
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (e === 'node_modules' || e === 'dist' || e === 'dist-single' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.ts$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p)
  }
  return out
}

/**
 * Every app, DISCOVERED rather than listed. A hand-written list is the same
 * hazard as a hand-written call-site audit, one level up: the app that is
 * missing from it is exempt from the policy, and nothing says so. bento/type
 * was about to arrive as a fourth app with a model, an editor and a sync
 * binding, and it would have been silently outside this scan — which matters
 * most for exactly that app, because fetching a font or a remote image is an
 * obvious feature for a word processor and neither reads as "networking" when
 * you write it.
 *
 * So: any top-level directory with a src/ is in scope, and a new app joins the
 * policy by existing.
 */
const APP_DIRS = readdirSync(root)
  .filter((d) => !d.startsWith('.') && d !== 'node_modules')
  .filter((d) => { try { return statSync(join(root, d, 'src')).isDirectory() } catch { return false } })
  .sort()

const sources = APP_DIRS
  .flatMap((d) => walk(join(root, d, 'src')))
  .map((p) => relative(root, p))
  .filter((p) => p !== CHOKEPOINT)

ok(sources.length > 50, `the policy scan actually found sources to scan (${sources.length} files in ${APP_DIRS.length} apps: ${APP_DIRS.join(', ')})`)
// Discovery that silently finds nothing is the failure this rig exists to
// prevent, one level up — a green run over an empty list looks identical to a
// green run over the whole repo.
for (const known of ['kernel', 'slides']) {
  ok(APP_DIRS.includes(known), `discovery found the ${known} sources — it has not silently stopped matching`)
}
ok(!APP_DIRS.includes('docs') && !APP_DIRS.includes('scripts'),
  'discovery does not sweep in directories that are not apps')

const offenders: string[] = []
for (const rel of sources) {
  const body = code(readFileSync(join(root, rel), 'utf8'))
  for (const [re, name] of PRIMITIVES) {
    if (re.test(body)) offenders.push(`${rel} uses ${name}`)
  }
}
ok(offenders.length === 0,
  `no file outside ${CHOKEPOINT} touches a network primitive${offenders.length ? `\n        ${offenders.join('\n        ')}` : ''}`)

// A gate nobody has seen fail is not a gate: prove the scanner can see one.
{
  const planted = code(`const r = await fetch('https://example.com')`)
  ok(PRIMITIVES.some(([re]) => re.test(planted)), 'the scanner detects a planted fetch( — it can fail')
  const prose = code(`// we used to call fetch( here\nconst x = 1`)
  ok(!PRIMITIVES.some(([re]) => re.test(prose)), 'a primitive named in a COMMENT is not an offence')
  const str = code(`const msg = 'call fetch( to reach it'`)
  ok(!PRIMITIVES.some(([re]) => re.test(str)), 'a primitive named in a STRING is not an offence')
  ok(!PRIMITIVES.some(([re]) => re.test(code('await netFetch(url)'))), 'netFetch( is not mistaken for fetch(')
}

// ------------------------------------------------------- 2. the chokepoint
// Stub the platform BEFORE importing, since net.ts reads these globals.
const store = new Map<string, string>()
let storageWorks = true
;(globalThis as any).localStorage = {
  getItem: (k: string) => (storageWorks ? store.get(k) ?? null : (() => { throw new Error('blocked') })()),
  setItem: (k: string, v: string) => { if (!storageWorks) throw new Error('blocked'); store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
}

let fetchCalls: string[] = []
let lastSignal: AbortSignal | null = null
;(globalThis as any).fetch = (url: any, init: any = {}) => {
  fetchCalls.push(String(url))
  lastSignal = init.signal ?? null
  // '/slow' hangs until aborted, so the in-flight abort path can be observed;
  // everything else answers at once, like a reachable server.
  if (!String(url).includes('/slow')) return Promise.resolve({ ok: true, status: 200 })
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal.reason))
  })
}

let socketsOpened: string[] = []
const closed: string[] = []
class FakeWS {
  url: string
  listeners: Record<string, Array<() => void>> = {}
  constructor(url: string) { this.url = url; socketsOpened.push(url) }
  addEventListener(t: string, fn: () => void) { (this.listeners[t] ??= []).push(fn) }
  close() { closed.push(this.url); for (const fn of this.listeners.close ?? []) fn() }
}
;(globalThis as any).WebSocket = FakeWS

const storageHandlers: Array<(e: any) => void> = []
;(globalThis as any).document = { baseURI: 'https://deck.example/talk.bento.html' }
;(globalThis as any).addEventListener = (t: string, fn: (e: any) => void) => {
  if (t === 'storage') storageHandlers.push(fn)
}

const net = await import('../kernel/src/net.ts')

// --- refusal
net.setOffline(false)
fetchCalls = []
await net.netFetch('https://example.com/a').catch(() => {})
ok(fetchCalls.length === 1, 'with the switch OFF, netFetch reaches the network')

net.setOffline(true)
fetchCalls = []
let threw: unknown = null
await net.netFetch('https://example.com/b').catch((e) => { threw = e })
ok(fetchCalls.length === 0, 'with the switch ON, netFetch makes NO request')
ok((threw as any)?.name === 'OfflineError', 'and it rejects with OfflineError rather than failing silently')

socketsOpened = []
let wsThrew: unknown = null
try { net.netWebSocket('wss://relay.example/room') } catch (e) { wsThrew = e }
ok(socketsOpened.length === 0, 'with the switch ON, netWebSocket opens NO socket')
ok((wsThrew as any)?.name === 'OfflineError', 'and it throws OfflineError')

// --- cutting what is ALREADY running (claims 4 and 5)
net.setOffline(false)
fetchCalls = []
const pending = net.netFetch('https://example.com/slow').catch((e) => e)
const live = net.netWebSocket('wss://relay.example/live')
ok(fetchCalls.length === 1 && socketsOpened.includes('wss://relay.example/live'),
  'a request and a socket are running before the switch flips')
net.setOffline(true)
const aborted = await pending
ok(lastSignal?.aborted === true, 'flipping the switch ABORTS the request already in flight')
ok((aborted as any)?.name === 'OfflineError', 'the in-flight request rejects with OfflineError')
ok(closed.includes('wss://relay.example/live'), 'flipping the switch CLOSES the socket already open')

// --- another tab flipping it (claim 5's missing half)
net.setOffline(false)
net.startNetGuard()
ok(storageHandlers.length === 1, 'startNetGuard subscribes to storage events')
const other = net.netWebSocket('wss://relay.example/othertab')
store.set('bento-offline', 'on')
for (const fn of storageHandlers) fn({ key: 'bento-offline', newValue: 'on' })
ok(closed.includes('wss://relay.example/othertab'),
  "a DIFFERENT tab turning the switch on closes this tab's open socket")
ok(net.offlineEnabled() === true, "and this tab now agrees it is offline, so new requests are refused too")
void other

// --- a src the browser loads (claim 3) — no fetch involved
ok(net.isRemoteUrl('https://cdn.example/clip.mp4'), 'an https src counts as reaching the network')
ok(net.isRemoteUrl('//cdn.example/clip.mp4'), 'a protocol-relative src counts too')
ok(!net.isRemoteUrl('data:video/mp4;base64,AAAA'), 'a data: URI does not')
ok(!net.isRemoteUrl('asset:clip'), 'an asset: reference does not')
ok(!net.isRemoteUrl(''), 'an empty src does not')
ok(net.isRemoteUrl('clip.mp4'),
  'a RELATIVE src on a web-served deck counts — it still reaches that server')
net.setOffline(true)
ok(net.remoteSrcBlocked('https://cdn.example/clip.mp4'), 'offline blocks a remote src')
ok(!net.remoteSrcBlocked('data:video/mp4;base64,AAAA'), 'offline does not block an embedded one')
net.setOffline(false)
ok(!net.remoteSrcBlocked('https://cdn.example/clip.mp4'), 'online allows a remote src')

// --- a switch that cannot be stored (claim 6)
storageWorks = false
const stuck = net.setOffline(true)
ok(stuck === false, 'setOffline REPORTS that it could not persist, instead of swallowing it')
ok(net.offlineEnabled() === true,
  'and the switch still holds for this session — it does not silently do nothing')
fetchCalls = []
await net.netFetch('https://example.com/c').catch(() => {})
ok(fetchCalls.length === 0, 'so no request goes out even though the preference was never saved')
storageWorks = true

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
