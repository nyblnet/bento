#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 The Bento authors
// THE CLIENT HALF OF READ-ONLY — a real OnlineTransport, driven through a fake
// socket, in both transports that speak to the relay.
//
//   slides/node_modules/.bin/esbuild scripts/test-sync-vouch.ts --bundle --platform=node --format=esm \
//     --outfile="$TMPDIR/test-sync-vouch.mjs" && node "$TMPDIR/test-sync-vouch.mjs"
//
// Bundled, not run directly: kernel/src/sync/online.ts uses constructor
// parameter properties, which node's strip-only loader rejects — the reason
// dash's twin avoids that syntax, and the reason no rig had ever driven the
// kernel transport before this one. Same pattern as test-sanitize.ts.
//
// WHAT THIS PROVES, and why it exists as its own rig. The relay stamps a
// fanned-out frame with exactly what it verified (scripts/test-relay-auth.ts
// proves that half). But every copy of a file holds the room key, so a
// read-only copy can encrypt a well-formed op batch and the blind relay — which
// cannot tell that ciphertext from a presence beat's — fans it out unstamped.
// The ONLY thing between that frame and every live editor applying it is the
// client's `vouched()` check. Before this rig, setting `vouched` to
// `return true` left every rig in the tree green: the relay rig cannot see a
// client decision, and the session rigs never drive the online transport.
// Security found that by mutation, which is the correct way to find it, and
// this file is the answer: each check below must go red under that mutation.
//
// The same check lives in TWO transports — kernel/src/sync/online.ts and
// dash's deliberate twin — so this drives both, with the same frames.

import { webcrypto } from 'node:crypto'

// --- the world the transport expects ---------------------------------------
// A WebSocket constructor the kernel's net chokepoint will `new`. Each instance
// records what the client sent and lets the rig deliver frames as the relay.
type Listener = (ev: unknown) => void
class FakeSocket {
  static last: FakeSocket | null = null
  readyState = 0
  sent: string[] = []
  private ls = new Map<string, Listener[]>()
  onopen: Listener | null = null
  onmessage: Listener | null = null
  onclose: Listener | null = null
  onerror: Listener | null = null
  url: string
  constructor(url: string) { this.url = url; FakeSocket.last = this }
  addEventListener(t: string, fn: Listener) { this.ls.set(t, [...(this.ls.get(t) ?? []), fn]) }
  removeEventListener(t: string, fn: Listener) { this.ls.set(t, (this.ls.get(t) ?? []).filter((f) => f !== fn)) }
  send(s: string) { this.sent.push(s) }
  close() { this.readyState = 3; this.fire('close', {}) }
  fire(t: string, ev: Record<string, unknown>) {
    const h = (this as unknown as Record<string, Listener | null>)[`on${t}`]
    if (h) h(ev)
    for (const fn of this.ls.get(t) ?? []) fn(ev)
  }
  open() { this.readyState = 1; this.fire('open', {}) }
  /** the relay speaks: deliver one envelope */
  deliver(env: Record<string, unknown>) { this.fire('message', { data: JSON.stringify(env) }) }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket

const { OnlineTransport: KernelTransport } = await import('../kernel/src/sync/online.ts')
const { OnlineTransport: DashTransport } = await import('../dash/src/sync/online.ts')

// --- key material -------------------------------------------------------------
const b64u = {
  enc(bytes: Uint8Array): string {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
}
const rawKey = new Uint8Array(32)
webcrypto.getRandomValues(rawKey)
const keyB64 = b64u.enc(rawKey)
const aes = await webcrypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt'])

/** Encrypt a frame the way a peer holding the room key would — which is the
 *  whole point: a READER holds this key too. */
async function seal(frame: unknown): Promise<{ i: string; d: string }> {
  const iv = new Uint8Array(12)
  webcrypto.getRandomValues(iv)
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify(frame)))
  return { i: b64u.enc(iv), d: b64u.enc(new Uint8Array(ct)) }
}

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string): void {
  checks++
  if (!cond) { failures++; console.error(`  ✗ ${msg}`) }
}

const OPS = { t: 'ops', a: 'reader', ops: [{ a: 'reader', s: 1, k: 'set', n: 'x', v: 1 }] }
const SNAP = { t: 'snap', a: 'fork', doc: { docId: 'd' }, state: { v: 2 } }
const PRESENCE = { t: 'p', a: 'reader', p: { name: 'r' } }

/** Build a transport in `room`, open its socket, replay nothing, and return the
 *  socket plus what the transport applied. */
async function boot(
  Transport: typeof KernelTransport | typeof DashTransport,
  room: string,
) {
  const applied: string[] = []
  let snaps = 0
  FakeSocket.last = null
  const tr = new (Transport as typeof KernelTransport)(
    room, keyB64, 'doc-1',
    (f) => { applied.push((f as { t: string }).t) },
    {
      onSnap: () => { snaps++ },
      getSnapshot: () => ({ doc: { docId: 'doc-1' }, state: { v: 2 } as never }),
      onOpen: () => {},
      onReady: () => false,
    },
    // no auth: a READER transport. vouched() is about what we ACCEPT, and a
    // reader is the copy most likely to be on the receiving end.
    undefined,
  )
  // init() is async (key import, URL parse) and only then constructs the socket
  for (let i = 0; i < 50 && !FakeSocket.last; i++) await new Promise((r) => setTimeout(r, 2))
  const ws = FakeSocket.last!
  ok(!!ws, `${Transport.name}: the transport opened a socket`)
  ws.open()
  ws.deliver({ ctl: 'ready', q: 0 })
  await new Promise((r) => setTimeout(r, 5))
  return { tr, ws, applied, snaps: () => snaps }
}

const tick = () => new Promise((r) => setTimeout(r, 10))

for (const [name, Transport] of [['kernel', KernelTransport], ['dash', DashTransport]] as const) {
  console.log(`${name} transport — a signed room accepts only what the relay vouched for…`)
  const W_ROOM = 'wss://relay.test/d/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const { ws, applied, snaps } = await boot(Transport, W_ROOM)

  // 1. an unstamped op batch — exactly what a reader can send and a blind
  //    relay will fan out — must NOT be applied
  ws.deliver({ ...(await seal(OPS)) })
  await tick()
  ok(!applied.includes('ops'), `${name}: an UNSTAMPED op batch is refused`)

  // 2. the same batch, carrying the relay's persisted-frame stamp, is applied
  ws.deliver({ q: 1, ...(await seal(OPS)) })
  await tick()
  ok(applied.filter((t) => t === 'ops').length === 1, `${name}: a q-stamped op batch is applied`)

  // 3. a fork snapshot (ephemeral t:'snap') with the relay's echoed signature
  //    is applied; without it, refused. `g` is opaque to the client — it is
  //    the relay's mark that it verified the sender, not something the
  //    client re-checks.
  ws.deliver({ ...(await seal(SNAP)) })
  await tick()
  ok(!applied.includes('snap'), `${name}: an UNSTAMPED fork snapshot is refused`)
  ws.deliver({ g: 'cmVsYXktdmVyaWZpZWQ', ...(await seal(SNAP)) })
  await tick()
  ok(applied.includes('snap'), `${name}: a g-stamped fork snapshot is applied`)

  // 4. a persisted snapshot frame ({snap:1}) follows the same rule
  const before = snaps()
  ws.deliver({ snap: 1, ...(await seal({ doc: { docId: 'doc-1' }, state: { v: 2 } })) })
  await tick()
  ok(snaps() === before, `${name}: an unstamped {snap:1} is refused`)
  ws.deliver({ snap: 1, q: 5, ...(await seal({ doc: { docId: 'doc-1' }, state: { v: 2 } })) })
  await tick()
  ok(snaps() === before + 1, `${name}: a q-stamped {snap:1} is applied`)

  // 5. presence is not content and must keep flowing unstamped — otherwise
  //    every reader vanishes from the People panel
  ws.deliver({ ...(await seal(PRESENCE)) })
  await tick()
  ok(applied.includes('p'), `${name}: an unstamped PRESENCE frame still flows`)

  // 6. a legacy r-room has no signatures to check and stays permissive
  console.log(`${name} transport — a legacy r-room stays on the older model…`)
  const R_ROOM = 'wss://relay.test/d/rLEGACYROOM'
  const r = await boot(Transport, R_ROOM)
  r.ws.deliver({ ...(await seal(OPS)) })
  r.ws.deliver({ ...(await seal(SNAP)) })
  await tick()
  ok(r.applied.includes('ops') && r.applied.includes('snap'), `${name}: an r-room applies unstamped ops and snapshots`)
}

console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURES of ${checks} checks`)
process.exit(failures ? 1 : 0)
