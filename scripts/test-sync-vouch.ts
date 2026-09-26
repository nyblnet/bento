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
import { execFileSync } from 'node:child_process'

// ——— SANDBOXED EMBED: the transport must not reconnect-flap (own process) ———
// A sandboxed embed (Teams/SharePoint preview) refuses every socket at the net
// chokepoint (kernel/src/net.ts sandboxed()). connect() must treat that
// SandboxedError as TERMINAL — no retry — exactly as drop() treats close codes
// 4001/1008. net.ts memoises the sandboxed() decision ONCE per process, so this
// case cannot share a process with the connect-normally cases below: the rig
// RE-SPAWNS ITSELF under sandboxed globals and reports what the transport did.
if (process.env.BENTO_SYNC_SANDBOXED === '1') {
  const g = globalThis as unknown as Record<string, unknown>
  g.self = globalThis; g.top = {}                          // self !== top → framed
  g.location = { origin: 'null' }                          // opaque origin
  Object.defineProperty(globalThis, 'localStorage', {      // a storage read throws
    configurable: true,
    get() { const e = new Error('blocked') as Error & { name: string }; e.name = 'SecurityError'; throw e },
  })
  let built = 0
  g.WebSocket = class { constructor() { built++ } close() {} addEventListener() {} removeEventListener() {} send() {} }
  const { OnlineTransport } = await import('../kernel/src/sync/online.ts')
  const raw = webcrypto.getRandomValues(new Uint8Array(32))
  const kb = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  let connecting = 0
  const tr = new OnlineTransport(
    'wss://relay.test/d/rSANDBOXSANDBOXSANDBOXSANDBOXSANDBOXSANDBO', kb, 'doc-sbx',
    () => {},
    { onSnap() {}, getSnapshot: () => ({ doc: { docId: 'doc-sbx' }, state: { v: 2 } as never }), onOpen() {}, onReady: () => false },
    undefined,
  )
  ;(tr as unknown as { onStatus: (s: string) => void }).onStatus = (s) => { if (s === 'connecting') connecting++ }
  await new Promise((r) => setTimeout(r, 2600))  // past the 800ms + 1440ms backoff steps
  console.log(JSON.stringify({ connecting, built }))
  process.exit(0)  // a buggy retry timer would otherwise keep this child alive
}

// --- the world the transport expects ---------------------------------------
// A WebSocket constructor the kernel's net chokepoint will `new`. Each instance
// records what the client sent and lets the rig deliver frames as the relay.
type Listener = (ev: unknown) => void
class FakeSocket {
  static last: FakeSocket | null = null
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
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
  serverClose(code: number) { this.readyState = 3; this.fire('close', { code }) }
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

// ————— the audience transport: receive-only, and close codes mean things —————
//
// An audience socket connects on the chain with role 'audience'. It must put NO
// protocol frame on the wire (the relay drops them, but not sending is the
// guarantee), decrypt s:'aud' frames under its own key (which IS the show key),
// and act on the relay's deliberate close codes: 4001/1008 are terminal (do not
// reconnect into a wall), 4002/4003 are transient (reconnect — that is the
// "waiting for the presenter" state).
{
  console.log('the audience transport is receive-only and reads close codes…')
  const kp = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const priv = b64u.enc(new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', kp.privateKey)))
  const pub = b64u.enc(new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey)))

  const showOps: unknown[][] = []
  let closedCode: number | null = null
  FakeSocket.last = null
  const tr = new KernelTransport(
    'wss://relay.test/d/wAUDIENCEROOMwAUDIENCEROOMwAUDIENCEROOMwAUD', keyB64, 'doc-1',
    () => {},
    {
      onSnap: () => {}, getSnapshot: () => ({ doc: { docId: 'doc-1' }, state: { v: 2 } as never }),
      onOpen: () => {}, onReady: () => false,
      onShowOps: (ops) => { showOps.push(ops) },
      onShowClosed: (code) => { closedCode = code },
    },
    { kind: 'chain', owner: pub, invite: { pub, priv, role: 'audience', sig: 'x' }, docId: 'doc-1' },
  )
  for (let i = 0; i < 50 && !FakeSocket.last; i++) await new Promise((r) => setTimeout(r, 2))
  const ws = FakeSocket.last!
  ok(!!ws, 'the audience transport opened a socket')
  ok(ws.url.includes('ivr=audience'), 'it connected on the audience path (ivr=audience)')
  ok(!ws.url.includes('bt=1'), 'and did not ask for a write ticket (it never proves)')
  ws.open()
  ws.deliver({ ctl: 'ready', bc: 1, v: 2 })
  await tick()

  // receive-only, as a CONTRAST against a normal reader: the same send() on a
  // non-audience transport reaches the wire, on the audience it does not — so
  // the assertion isolates the gate, not write()'s buffering.
  {
    FakeSocket.last = null
    const reader = new KernelTransport(
      'wss://relay.test/d/wREADERREADERREADERREADERREADERREADERREADE', keyB64, 'doc-1',
      () => {}, { onSnap: () => {}, getSnapshot: () => ({ doc: { docId: 'doc-1' }, state: { v: 2 } as never }), onOpen: () => {}, onReady: () => false }, undefined,
    )
    for (let i = 0; i < 50 && !FakeSocket.last; i++) await new Promise((r) => setTimeout(r, 2))
    const rws = FakeSocket.last!
    rws.open()
    const rBefore = rws.sent.length
    reader.send({ t: 'p', a: 'x', p: { name: 'x' } } as never)
    await tick()
    ok(rws.sent.length > rBefore, 'a normal reader transport DOES put a sent frame on the wire (the gate is observable)')
    reader.close()
  }
  const before = ws.sent.length
  tr.send({ t: 'p', a: 'x', p: { name: 'x' } } as never)
  tr.send({ t: 'ops', a: 'x', ops: [] } as never)
  await tick()
  ok(ws.sent.length === before, 'but nothing the session sends leaves an AUDIENCE socket')

  // the SHOW senders are guarded too, not just send(). Security probed exactly
  // this: on an audience transport, setShowKey + the three senders put five
  // frames (live/nav/laser/aud/audsnap) on the wire. Unreachable from the
  // shipped boot and the relay drops them, but "not sending is the guarantee"
  // must hold for all four senders, not one of four.
  ok(tr.audience === true, 'the transport reports itself as an audience socket')
  await tr.setShowKey(keyB64)
  const b2 = ws.sent.length
  await tr.sendVerb('live')
  await tr.sendVerb('nav', { id: 's1' })
  await tr.sendVerb('laser', { x: 1, y: 2 })
  await tr.sendAud([{ a: 'p', s: 1, l: 1, op: 'set', sl: 's1', el: 's1x', k: 'x', v: 1 } as never])
  await tr.sendAudSnap({ docId: 'd' } as never, { v: 2 } as never)
  await tick()
  ok(ws.sent.length === b2, 'an audience transport puts NO show frame on the wire either (all four senders guarded)')

  // an aud op frame (sealed under the show key = this.key) applies via onShowOps
  ws.deliver({ s: 'aud', ...(await seal({ t: 'ops', a: 'pres', ops: [{ a: 'pres', s: 1, l: 1, op: 'set', sl: 's1', el: 's1x', k: 'x', v: 1 }] })) })
  await tick()
  ok(showOps.length === 1, 'an s:aud op frame is delivered to onShowOps')

  // 4002 not-live: transient — surface the code AND reconnect
  const sock1 = FakeSocket.last
  ws.serverClose(4002)
  ok(closedCode === 4002, 'a 4002 close surfaces its code')
  await new Promise((r) => setTimeout(r, 950))
  ok(FakeSocket.last !== sock1, '4002 reconnects (waiting for the presenter)')

  // 4001 end: terminal — surface the code and do NOT reconnect
  const ws2 = FakeSocket.last!
  ws2.open()
  closedCode = null
  const sock2 = FakeSocket.last
  ws2.serverClose(4001)
  ok(closedCode === 4001, 'a 4001 close surfaces its code')
  await new Promise((r) => setTimeout(r, 950))
  ok(FakeSocket.last === sock2, '4001 does NOT reconnect (the show is over)')
  tr.close()
}

// ——— a sandboxed embed opens no socket and does not reconnect-flap ———
// Runs in its own process (the guard at the top of this file) because
// net.ts memoises sandboxed() once per process. Without the terminal handling
// in connect(), the bare catch retries and `connecting` climbs past 1.
{
  console.log('a sandboxed embed opens no socket and does not reconnect-flap…')
  let out = ''
  try {
    out = execFileSync(process.execPath, [process.argv[1]], {
      env: { ...process.env, BENTO_SYNC_SANDBOXED: '1' }, encoding: 'utf8', timeout: 15000,
    })
  } catch (e) { out = String((e as { stdout?: string }).stdout ?? '') }
  const line = out.trim().split('\n').filter(Boolean).pop() ?? '{}'
  const r = JSON.parse(line) as { connecting: number; built: number }
  ok(r.built === 0, `no socket is constructed in a sandboxed embed — netWebSocket refuses first (built=${r.built})`)
  ok(r.connecting === 1, `connect() runs once then stops — SandboxedError is terminal, no retry flap (connecting=${r.connecting}; a retry loop climbs past 1)`)
}

console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURES of ${checks} checks`)
process.exit(failures ? 1 : 0)
